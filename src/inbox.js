import fs from 'node:fs';
import path from 'node:path';

/**
 * 文件插话箱：runs/<讨论>/inbox.jsonl，一行一条插话。
 * 网页往正在进行的讨论目录里追加，跑这场讨论的进程（Lark 监听或网页）每轮开始时读新增的行。
 * 这样网页也能给群里发起的讨论插话，不用管讨论在哪个进程里跑。
 */
export const INBOX = 'inbox.jsonl';

export function appendInbox(dir, { sender, text }) {
  const item = { at: new Date().toISOString(), time: new Date().toTimeString().slice(0, 5), sender, text, source: 'web' };
  fs.appendFileSync(path.join(dir, INBOX), `${JSON.stringify(item)}\n`);
  return item;
}

export function createFileInbox(dir) {
  const file = path.join(dir, INBOX);
  let seen = 0;
  return {
    async poll() {
      if (!fs.existsSync(file)) return [];
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const fresh = lines.slice(seen);
      seen = lines.length;
      return fresh.flatMap((l) => {
        try {
          const m = JSON.parse(l);
          return m.text ? [{ sender: m.sender ?? '网页', text: m.text, time: m.time, source: 'web' }] : [];
        } catch {
          return [];
        }
      });
    },
  };
}

/** 合并几个插话来源。某个来源失败时其他来源照常；全部没拿到且有失败时抛出第一个错误（由调用方记日志）。 */
export function combineInterjections(sources) {
  const list = sources.filter(Boolean);
  if (list.length <= 1) return list[0];
  return {
    async poll() {
      const out = [];
      let error = null;
      for (const s of list) {
        try {
          out.push(...await s.poll());
        } catch (err) {
          error ??= err;
        }
      }
      if (!out.length && error) throw error;
      return out;
    },
  };
}
