import fs from 'node:fs';

/**
 * 在 Lark 群里用指令发起讨论：
 *   /讨论 <议题>          方案讨论
 *   /讨论 3轮 <议题>      指定总轮数
 *   /讨论 仓库:a,b@分支 <议题>   先由调研员读这些仓库的代码
 *   /脑洞 <题目>          脑洞风暴
 * 指令可以换行写长议题。只响应 allowFrom 里的人。
 */
export const DEFAULT_TRIGGERS = { '/讨论': 'decision', '/脑洞': 'brainstorm', '/追问': 'followup' };

const SEPARATOR = /^[\s,，:：、;；.。]/;
const SEPARATOR_RUN = /^[\s,，:：、;；.。]+/;

/** 解析一条消息；不是指令返回 null，是指令但缺内容返回 { error }。 */
export function parseTrigger(text, triggers = DEFAULT_TRIGGERS) {
  const s = String(text ?? '').trim();
  for (const [prefix, mode] of Object.entries(triggers)) {
    if (!s.startsWith(prefix)) continue;
    const rest = s.slice(prefix.length);
    // 指令后面要空白或标点隔开（「/追问，问题」「/讨论：议题」也算）；「/讨论区」之类不算
    if (rest && !SEPARATOR.test(rest)) continue;
    let body = rest.replace(SEPARATOR_RUN, '').trim();
    if (mode === 'followup') {
      // /追问 [#12] <问题>：不写编号就是最近一场
      const t = /^#(\d+)[\s,，:：、;；.。]*/.exec(body);
      const target = t ? Number(t[1]) : undefined;
      if (t) body = body.slice(t[0].length).trim();
      if (!body) return { mode, error: '缺少问题' };
      return { mode, target, topic: body };
    }
    let rounds;
    let repos;
    // 轮数与仓库写在议题前面，顺序不限：「3轮 仓库:fission,pricing@develop 议题」
    for (;;) {
      const r = /^(\d+)\s*轮(?:\s+|$)/.exec(body);
      if (r && rounds === undefined) {
        rounds = Number(r[1]);
        body = body.slice(r[0].length).trim();
        continue;
      }
      const c = /^(?:仓库|repos?)\s*[:：]\s*(无|不读|none|[\w.\-@/]+(?:\s*[,，]\s*[\w.\-@/]+)*)(?:\s+|$)/i.exec(body);
      if (c && repos === undefined) {
        repos = /^(?:无|不读|none)$/i.test(c[1]) ? [] : c[1].split(/\s*[,，]\s*/).filter(Boolean);
        body = body.slice(c[0].length).trim();
        continue;
      }
      break;
    }
    if (!body) return { mode, error: `缺少${mode === 'brainstorm' ? '题目' : '议题'}` };
    return { mode, rounds, ...(repos ? { repos } : {}), topic: body };
  }
  return null;
}

export const isTrigger = (text, triggers) => parseTrigger(text, triggers) !== null;

export function helpText(triggers = DEFAULT_TRIGGERS, { repos = [], groups = [] } = {}) {
  const [d, b] = Object.keys(triggers);
  return [
    '**用法**',
    `- \`${d} <议题>\`：方案讨论`,
    `- \`${d} 3轮 <议题>\`：固定总轮数（含第 1 轮）；不写时评审都没有新意见就结束，最多 20 轮`,
    `- \`${d} 仓库:fission,pricing@develop <议题>\`：指定读哪些仓库，@ 后面是分支；不写仓库时调研员按议题自己定位，\`仓库:无\` 不读代码`,
    b ? `- \`${b} <题目>\`：脑洞风暴` : '',
    `- \`/追问 <问题>\`：追问最近一场讨论（\`/追问 #12 <问题>\` 追问指定的一场），主席判断直接回答还是重新讨论`,
    '- 议题可以换行写长一些；讨论进行中直接发消息就是插话。',
    groups.length ? `- 可用的仓库组：${groups.join('、')}` : '',
    repos.length ? `- 可用的仓库：${repos.join('、')}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * 轮询群消息，遇到指令就依次开讨论。讨论期间不轮询（讨论自己的插话读取会读群），
 * 讨论结束后从上次的位置继续，期间收到的指令按顺序排队执行。
 */
export async function watchLoop({ reader, runOne, notify, log = () => {}, intervalMs = 30000, triggers = DEFAULT_TRIGGERS, sleep = defaultSleep, shouldStop = () => false, onState = () => {}, help = {} }) {
  let failures = 0;
  const state = (s) => {
    try {
      onState(s);
    } catch {
      // 状态文件写失败不影响监听
    }
  };
  while (!shouldStop()) {
    let messages = [];
    try {
      messages = await reader.poll();
      failures = 0;
      state({ phase: 'idle', lastPollAt: new Date().toISOString(), lastError: null });
    } catch (err) {
      if (err.rateLimited) {
        // 共用配额的短暂限流：不算故障，不加长等待，下个间隔照常读
        log(`群消息接口限流，${Math.round(intervalMs / 1000)}s 后再读`);
        state({ phase: 'idle', lastError: '群消息接口限流，稍后自动重试', rateLimitedAt: new Date().toISOString() });
        await sleep(intervalMs);
        continue;
      }
      failures += 1;
      const wait = Math.min(intervalMs * 2 ** failures, 5 * 60000);
      log(`⚠️ 读取群消息失败（第 ${failures} 次），${Math.round(wait / 1000)}s 后重试：${err.message}`);
      state({ phase: 'idle', lastError: err.message.slice(0, 300), failures });
      await sleep(wait);
      continue;
    }

    const queue = [];
    for (const m of messages) {
      const t = parseTrigger(m.text, triggers);
      if (!t) continue;
      if (t.error) {
        log(`收到不完整的指令：${m.text.slice(0, 40)}`);
        await safe(() => notify({ title: `无法开始：${t.error}`, body: helpText(triggers, help) }), log);
        continue;
      }
      queue.push({ ...t, from: m.sender, messageId: m.id });
    }
    if (queue.length > 1) {
      await safe(() => notify({ title: `收到 ${queue.length} 个议题，将依次讨论`, body: queue.map((q, i) => `${i + 1}. ${q.topic.split('\n')[0]}`).join('\n') }), log);
    }
    for (const job of queue) {
      if (shouldStop()) break;
      log(`开始：${job.mode === 'followup' ? `追问${job.target ? ` #${job.target}` : ''}` : job.mode === 'brainstorm' ? '脑洞' : '讨论'}${job.rounds ? ` ${job.rounds} 轮` : ''}${job.repos ? ` 仓库 ${job.repos.join(',') || '无'}` : ''}「${job.topic.split('\n')[0].slice(0, 40)}」（${job.from}）`);
      state({ phase: 'running', current: { mode: job.mode, rounds: job.rounds ?? null, repos: job.repos ?? null, topic: job.topic.split('\n')[0].slice(0, 120), from: job.from, startedAt: new Date().toISOString() }, queued: queue.length - queue.indexOf(job) - 1 });
      try {
        await runOne(job);
        state({ phase: 'idle', current: null, lastJob: { topic: job.topic.split('\n')[0].slice(0, 120), ok: true, endedAt: new Date().toISOString() } });
      } catch (err) {
        log(`⚠️ 讨论失败：${err.message}`);
        state({ phase: 'idle', current: null, lastJob: { topic: job.topic.split('\n')[0].slice(0, 120), ok: false, error: err.message.slice(0, 300), endedAt: new Date().toISOString() } });
        await safe(() => notify({ title: '讨论中断', body: `「${job.topic.split('\n')[0].slice(0, 60)}」没有完成：${err.message}` }), log);
      }
    }
    state({ queued: 0 });
    if (!shouldStop()) await sleep(intervalMs);
  }
}

async function safe(fn, log) {
  try {
    await fn();
  } catch (err) {
    log(`⚠️ 群通知发送失败：${err.message}`);
  }
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 单实例锁：同一台机器只跑一个 watch，避免同一条指令被处理两次。 */
export function acquireLock(file) {
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (pid && pid !== process.pid && alive(pid)) {
      throw new Error(`已经有一个 watch 在运行（pid ${pid}）。先停掉它，或删除 ${file}`);
    }
  }
  fs.writeFileSync(file, String(process.pid));
  return () => {
    try {
      if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
    } catch {
      // 已被清理
    }
  };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
