/**
 * 接口不返回费用时，按配置的价格估算一次调用的费用。
 *
 * 配置写在 provider 上，按模型区分：
 *   "pricing": {
 *     "deepseek-v4.1-flash-1017": {
 *       "currency": "CNY", "usdRate": 6.7,                 // 1 美元 = 6.7 元，用来折成美元汇总
 *       "inputPerM": 2, "outputPerM": 8,                   // 每百万 tokens 单价
 *       "cacheReadRatio": 0.1,                             // 缓存命中按输入单价的 10%
 *       "offPeak": { "from": "22:00", "to": "08:00", "timezone": "Asia/Shanghai", "inputPerM": 1, "outputPerM": 4 }
 *     }
 *   }
 *
 * 长上下文分档：一次调用的完整输入（含缓存）超过 aboveTokens 时，整次调用按 longContext 里的单价算，
 * 没写的项沿用基础价，缓存读写仍按 cacheReadRatio / cacheWriteRatio（也可以在 longContext 里覆盖）：
 *   "longContext": { "aboveTokens": 272000, "inputPerM": 0.48, "outputPerM": 1.8 }
 */

/** 某个时刻在指定时区是不是落在 [from, to) 里；跨零点的区间（22:00–08:00）也支持。 */
export function inWindow(at, { from, to, timezone = 'Asia/Shanghai' }) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const hh = Number(parts.find((p) => p.type === 'hour').value);
  const mm = Number(parts.find((p) => p.type === 'minute').value);
  const now = hh * 60 + mm;
  const toMin = (s) => {
    const [h, m] = String(s).split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const a = toMin(from);
  const b = toMin(to);
  return a <= b ? now >= a && now < b : now >= a || now < b;
}

/**
 * usage: { inputTokens（含缓存）, outputTokens, cacheReadTokens, cacheWriteTokens }
 * 返回 { amount, currency, costUsd, offPeak, longContext }；没有价格时返回 null。
 */
export function estimateCost(base, usage, at = new Date()) {
  if (!base || !usage) return null;
  const long = Boolean(base.longContext) && (usage.inputTokens ?? 0) > (base.longContext.aboveTokens ?? Infinity);
  const price = long ? { ...base, ...base.longContext, offPeak: undefined } : base;
  const off = price.offPeak && inWindow(at, price.offPeak);
  const inputPerM = (off ? price.offPeak.inputPerM : undefined) ?? price.inputPerM ?? 0;
  const outputPerM = (off ? price.offPeak.outputPerM : undefined) ?? price.outputPerM ?? 0;
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const plain = Math.max(0, (usage.inputTokens ?? 0) - read - write);
  const amount = (
    plain * inputPerM
    + read * inputPerM * (price.cacheReadRatio ?? 1)
    + write * inputPerM * (price.cacheWriteRatio ?? 1)
    + (usage.outputTokens ?? 0) * outputPerM
  ) / 1e6;
  const currency = price.currency ?? 'USD';
  const costUsd = currency === 'USD' ? amount : price.usdRate ? amount / price.usdRate : null;
  return { amount: round(amount), currency, costUsd: costUsd == null ? null : round(costUsd), offPeak: Boolean(off), longContext: long };
}

/** 在配置里找某个发言者实际用到的模型的价格。 */
export function priceFor(cfg, speaker, model) {
  const table = cfg.providers?.[speaker.provider]?.pricing;
  if (!table) return null;
  return table[model] ?? table[speaker.model] ?? null;
}

const round = (n) => Math.round(n * 1e6) / 1e6;
