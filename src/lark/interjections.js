import { execFile } from 'node:child_process';

/**
 * 用本机 lark-cli 的「用户身份」只读讨论群里的新消息：讨论中作为插话，watch 时用来识别指令。
 * 只读这一个群、只读 since 之后的消息、只收人类发的文本消息（可再用 allowFrom 限定发送人）。
 *
 * 群消息的时间只精确到分钟，所以每次往回多读 overlapMs，靠 message_id 去重；
 * 游标随轮询前进，不会因为消息多于一页而漏读新消息，也不会早于 since。
 *
 * lark-cli 的应用是全公司共用的，配额紧张时会短暂返回限流（99991400）。限流通常几秒就过去，
 * 所以同一次读取里隔几秒重试几次；仍然限流就抛出 rateLimited 错误，由调用方按正常间隔再读。
 */
export function createInterjectionReader({
  chatId,
  allowFrom = [],
  since,
  ignore = () => false,
  bin = process.env.LARK_CLI_BIN || 'lark-cli',
  execImpl = execFileJson,
  overlapMs = 120000,
  now = () => Date.now(),
  retryDelaysMs = [3000, 6000, 10000],
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
}) {
  const floor = (since instanceof Date ? since : new Date(since ?? now())).getTime();
  let cursor = floor;
  const seen = new Set();
  const order = [];

  function remember(id) {
    seen.add(id);
    order.push(id);
    if (order.length > 2000) seen.delete(order.shift());
  }

  return {
    /** 返回自上次读取以来的新消息：[{ id, sender, senderId, text, time }] */
    async poll() {
      const pollStarted = now();
      const args = [
        'im', '+chat-messages-list',
        '--as', 'user',
        '--chat-id', chatId,
        '--start', new Date(cursor).toISOString(),
        '--order', 'asc',
        '--page-size', '50',
        '--page-all', '--page-limit', '5',
        '--no-reactions',
        '--format', 'json',
      ];
      let messages;
      for (let attempt = 0; ; attempt += 1) {
        try {
          messages = extractMessages(await execImpl(bin, args));
          break;
        } catch (err) {
          if (!isRateLimit(err) || attempt >= retryDelaysMs.length) throw err;
          await sleep(retryDelaysMs[attempt] + Math.round(random() * 1000));
        }
      }
      const out = [];
      for (const m of messages) {
        if (!m?.message_id || seen.has(m.message_id)) continue;
        remember(m.message_id);
        const item = toInterjection(m, allowFrom);
        if (!item || ignore(item.text)) continue;
        out.push(item);
      }
      cursor = Math.max(floor, pollStarted - overlapMs);
      return out;
    },
  };
}

export function extractMessages(data) {
  if (data?.ok === false) throw larkError(data.error);
  const candidates = [data?.data?.messages, data?.messages, data?.data?.items, data?.items];
  return candidates.find(Array.isArray) ?? [];
}

export function toInterjection(m, allowFrom = []) {
  if (!m || m.deleted) return null;
  const sender = m.sender ?? {};
  // 只收人：机器人（各模型的发言）是 app，系统消息的 sender_type 为空
  if ((sender.sender_type ?? sender.type) !== 'user') return null;
  const senderId = sender.id ?? sender.open_id;
  if (allowFrom.length && !allowFrom.includes(senderId)) return null;
  if (!['text', 'post'].includes(m.msg_type)) return null;
  const text = contentText(m.content).trim();
  if (!text) return null;
  return {
    id: m.message_id,
    sender: sender.name ?? senderId ?? '用户',
    senderId,
    text,
    time: formatTime(m.create_time),
  };
}

function contentText(content) {
  if (typeof content === 'string') {
    const s = content.trim();
    if (s.startsWith('{')) {
      try {
        return contentText(JSON.parse(s));
      } catch {
        return content;
      }
    }
    return content;
  }
  if (!content || typeof content !== 'object') return '';
  if (typeof content.text === 'string') return content.text;
  // post 富文本：{ title, content: [[{tag:'text', text}]] } 或带语言层
  const post = content.content ? content : Object.values(content).find((v) => v?.content);
  if (post?.content) {
    return [post.title, ...post.content.map((line) => line.map((n) => n.text ?? '').join(''))].filter(Boolean).join('\n');
  }
  return '';
}

function formatTime(t) {
  if (!t) return '';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(t))) return String(t).slice(11, 16);
  const n = Number(t);
  const d = Number.isFinite(n) ? new Date(n > 1e12 ? n : n * 1000) : new Date(t);
  if (Number.isNaN(d.getTime())) return String(t);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** lark-cli 的错误结构：{ type, subtype, code, message, retryable } */
function larkError(e = {}) {
  const rateLimited = e.subtype === 'rate_limit' || e.code === 99991400;
  const err = new Error(rateLimited
    ? '群消息接口限流（lark-cli 共用应用的配额紧张）'
    : `lark-cli 读取群消息失败：${e.message ?? JSON.stringify(e).slice(0, 300)}`);
  err.rateLimited = rateLimited;
  err.code = e.code;
  return err;
}

export const isRateLimit = (err) => Boolean(err?.rateLimited);

function execFileJson(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 10 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
      const text = String(stdout ?? '').trim();
      if (text) {
        try {
          return resolve(JSON.parse(text));
        } catch {
          // 落到下面的错误处理
        }
      }
      // 失败时 lark-cli 把 { ok: false, error } 写到 stderr
      try {
        const parsed = JSON.parse(String(stderr ?? '').trim());
        if (parsed?.ok === false) return reject(larkError(parsed.error));
      } catch {
        // 不是 JSON，按原文报错
      }
      if (err) return reject(new Error(`lark-cli 执行失败：${(stderr || err.message).toString().slice(0, 300)}`));
      reject(new Error(`lark-cli 输出不是 JSON：${text.slice(0, 200)}`));
    });
  });
}
