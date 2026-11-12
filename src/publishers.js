import { buildCardWithinLimit } from './lark/card.js';
import { sendCard } from './lark/webhook.js';
import { resolveWebhook } from './config.js';

/**
 * 发布者接口：post({ speaker, title, subtitle, brief, body, plan, footer }) -> Promise
 * brief 是开头的要点（可能没有），body 是其余给人看的内容，plan 是主笔的完整方案（只有修订轮有，群里折叠显示）。
 * 讨论里每条发言都交给所有发布者：Lark、终端、本地记录。
 */

/** 每个发言者用自己的自定义机器人发卡片；全部消息排成一个队列，保证顺序并控制频率。 */
export function createLarkPublisher(cfg, { env = process.env, fetchImpl, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), recordHint } = {}) {
  const hooks = new Map();
  // 调研员默认借用主席的机器人（research.webhook 默认等于 chair.webhook）
  for (const s of [...cfg.participants, cfg.chair, ...(cfg.research ? [cfg.research] : [])]) {
    const hook = resolveWebhook(s, env);
    if (hook) hooks.set(s.id, hook);
  }
  let chain = Promise.resolve();
  let last = 0;
  const hint = recordHint ? `（内容过长已截断，完整内容见${recordHint}）` : undefined;

  return {
    name: 'lark',
    missing: [...cfg.participants, cfg.chair].filter((s) => !hooks.has(s.id)).map((s) => s.id),
    post(msg) {
      const hook = hooks.get(msg.speaker.id);
      if (!hook) return Promise.reject(new Error(`发言者 ${msg.speaker.id} 没有配置 webhook`));
      const { card } = buildCardWithinLimit({ ...msg, color: msg.speaker.color, expanded: msg.meta?.stage === 'summary' }, { maxBytes: cfg.lark.maxCardBytes, ...(hint ? { truncatedHint: hint } : {}) });
      const task = chain.then(async () => {
        const wait = last + cfg.lark.minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        return sendCard(hook, card, { fetchImpl, sleep });
      });
      chain = task.catch(() => {});
      return task;
    },
  };
}

/** 终端输出：--dry-run 时代替 Lark，也用于观察进度。 */
export function createConsolePublisher({ write = (s) => process.stdout.write(s), full = true } = {}) {
  return {
    name: 'console',
    async post(msg) {
      const bar = '─'.repeat(60);
      const text = [msg.brief ? `【要点】\n${msg.brief}` : '', msg.body].filter(Boolean).join('\n\n');
      const body = full ? text : `${text.slice(0, 300)}${text.length > 300 ? '…' : ''}`;
      write(`\n${bar}\n[${msg.speaker.color}] ${msg.title}${msg.subtitle ? `  ·  ${msg.subtitle}` : ''}\n${bar}\n${body}\n${msg.footer ? `\n(${msg.footer})\n` : ''}`);
    },
  };
}

/** 本地记录：每条发言写进记录库的 posts 表，挂在这次运行上。 */
export function createStorePublisher(store, execId) {
  return {
    name: 'record',
    async post(msg) {
      store.addPost(execId, msg);
    },
  };
}

/** 收集到内存，测试用。 */
export function createMemoryPublisher() {
  const posts = [];
  return { name: 'memory', posts, async post(msg) { posts.push(msg); } };
}

/** 把多个发布者合成一个；Lark 发送失败不会中断讨论，只记录告警。 */
export function combinePublishers(list, { onError = (p, err) => process.stderr.write(`⚠️ ${p.name} 发送失败：${err.message}\n`) } = {}) {
  return {
    async post(msg) {
      await Promise.all(list.map((p) => Promise.resolve().then(() => p.post(msg)).catch((err) => onError(p, err))));
    },
  };
}
