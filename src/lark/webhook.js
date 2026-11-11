import crypto from 'node:crypto';

/**
 * Lark / 飞书群自定义机器人的签名：
 *   以 `${timestamp}\n${secret}` 为 HMAC-SHA256 的密钥，对空串签名，再做 Base64。
 * timestamp 是秒级时间戳字符串，和 sign 一起放进请求体。
 */
export function signWebhook(secret, timestamp) {
  const key = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', key).update('').digest('base64');
}

const RETRYABLE_CODES = new Set([11232]); // 11232：频率限制

/**
 * 发送一张卡片到某个自定义机器人。
 * 自定义机器人限频：单个机器人 5 次/秒、100 次/分钟；遇到限流按指数退避重试。
 */
export async function sendCard(hook, card, { fetchImpl = globalThis.fetch, now = () => Date.now(), retries = 3, sleep = defaultSleep } = {}) {
  let attempt = 0;
  for (;;) {
    const body = { msg_type: 'interactive', card };
    if (hook.secret) {
      const timestamp = String(Math.floor(now() / 1000));
      body.timestamp = timestamp;
      body.sign = signWebhook(hook.secret, timestamp);
    }
    const res = await fetchImpl(hook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { code: res.status, msg: text.slice(0, 200) };
    }
    const code = data.code ?? data.StatusCode ?? (res.ok ? 0 : res.status);
    if (res.ok && code === 0) return data;

    const retryable = res.status === 429 || RETRYABLE_CODES.has(code);
    if (retryable && attempt < retries) {
      attempt += 1;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    throw new WebhookError(code, data.msg ?? text.slice(0, 200));
  }
}

export class WebhookError extends Error {
  constructor(code, msg) {
    super(`Lark webhook 返回 ${code}：${msg}${hintFor(code)}`);
    this.code = code;
  }
}

function hintFor(code) {
  switch (code) {
    case 19021: return '（签名校验失败：检查 secret 是否对应这个机器人，以及本机时间是否准确）';
    case 19022: return '（IP 不在机器人的白名单里）';
    case 19024: return '（消息里没有机器人设置的自定义关键词）';
    case 9499: return '（请求体格式错误或超过 20 KB）';
    case 11232: return '（触发频率限制）';
    default: return '';
  }
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
