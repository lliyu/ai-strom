/**
 * 网页插话：写进记录库的 interjections 表，挂在正在进行的那次运行上。
 * 跑这场讨论的进程（Lark 监听、网页或命令行）每轮开始时读新增的。
 * 这样网页也能给群里发起的讨论插话，不用管讨论在哪个进程里跑。
 */
export function appendInbox(store, execId, { sender, text }) {
  const item = { at: new Date().toISOString(), time: new Date().toTimeString().slice(0, 5), sender, text, source: 'web' };
  store.addInterjection(execId, item);
  return item;
}

export function createStoreInbox(store, execId, { seen: from = 0 } = {}) {
  let seen = from;
  return {
    /** 读到哪一条了（存断点用：续跑时从这里接着读，之前已经交给模型的不再重复）。 */
    position: () => seen,
    async poll() {
      const rows = store.interjections(execId, seen);
      if (rows.length) seen = rows.at(-1).id;
      return rows.filter((m) => m.text).map((m) => ({
        sender: m.sender ?? '网页',
        text: m.text,
        time: new Date(m.at).toTimeString().slice(0, 5),
        source: 'web',
      }));
    },
  };
}

/** 合并几个插话来源。某个来源失败时其他来源照常；全部没拿到且有失败时抛出第一个错误（由调用方记日志）。 */
export function combineInterjections(sources) {
  const list = sources.filter(Boolean);
  if (list.length <= 1) return list[0];
  return {
    position: () => list.map((s) => s.position?.()).find((v) => v !== undefined),
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
