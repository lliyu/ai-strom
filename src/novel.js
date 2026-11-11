/**
 * 墨稿（novel-idea）的接口：列出脑洞 / 梗概 / 总纲，取一项给模型看，作者确认后写回。
 * 墨稿只接受本机请求，接口在 novel-idea 的 src/app/api/console/storm/。
 */
export function createNovelClient({ baseUrl = 'http://127.0.0.1:3000', timeoutMs = 60000, fetchImpl = fetch } = {}) {
  const base = baseUrl.replace(/\/+$/, '');

  async function call(pathname, init = {}) {
    let res;
    try {
      res = await fetchImpl(`${base}${pathname}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const why = err.name === 'TimeoutError' ? `${Math.round(timeoutMs / 1000)}s 没有响应` : err.cause?.code === 'ECONNREFUSED' ? '没有在运行' : err.message;
      throw new NovelError(`连不上墨稿（${base}）：${why}。先启动墨稿（Work Console 的墨稿模块，或在 novel-idea 里 npm run dev）`, 502);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new NovelError(body.error ?? `墨稿返回 HTTP ${res.status}`, res.status);
    return body;
  }

  return {
    baseUrl: base,
    list: () => call('/api/console/storm/items').then((b) => b.items),
    get: (type, id) => call(`/api/console/storm/item?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`),
    apply: ({ type, id, version, fields, note }) => call('/api/console/storm/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, id, version, fields, note }),
    }),
  };
}

export class NovelError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
