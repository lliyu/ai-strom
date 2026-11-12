/**
 * OpenAI 兼容的 /chat/completions 接口：LiteLLM 网关、DeepSeek、Kimi、Qwen、OpenRouter 等。
 * key 从环境变量读取，不写进配置文件。
 *
 * 用量：缓存命中读 usage.prompt_tokens_details.cached_tokens（OpenAI / LiteLLM）或 prompt_cache_hit_tokens（DeepSeek）；
 * LiteLLM 网关在响应头 x-litellm-response-cost 里给出这次调用的费用。
 * 上下文窗口：配置里没写 contextWindow 时，查一次 {baseUrl}/models 里的 max_input_tokens / context_length。
 */
export function createOpenAICompatibleProvider(spec, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (!spec.baseUrl) throw new Error(`provider ${spec.name}：缺少 baseUrl`);
  const timeoutMs = spec.timeoutMs ?? 600000;
  const base = spec.baseUrl.replace(/\/$/, '');
  let modelsPromise = null; // 每个 provider 只查一次模型列表

  async function lookupWindow(model, apiKey) {
    if (spec.contextWindow || spec.discoverContextWindow === false) return spec.contextWindow;
    modelsPromise ??= (async () => {
      try {
        const res = await fetchImpl(`${base}/models`, {
          headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...(spec.headers ?? {}) },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data?.data) ? data.data : [];
      } catch {
        return []; // 查不到就显示「窗口未知」，不影响发言
      }
    })();
    const m = (await modelsPromise).find((x) => x?.id === model);
    const w = Number(m?.max_input_tokens ?? m?.context_length ?? m?.context_window ?? m?.max_model_len);
    return Number.isFinite(w) && w > 0 ? w : undefined;
  }

  return {
    name: spec.name,
    async complete({ model, system, prompt, temperature, session }) {
      const apiKey = spec.apiKeyEnv ? env[spec.apiKeyEnv] : undefined;
      if (spec.apiKeyEnv && !apiKey) throw new Error(`provider ${spec.name}：环境变量 ${spec.apiKeyEnv} 未设置`);
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      // 会话：接口本身无状态，把之前每一轮的提问和回答按顺序带上
      for (const t of session?.turns ?? []) messages.push({ role: 'user', content: t.prompt }, { role: 'assistant', content: t.reply });
      messages.push({ role: 'user', content: prompt });
      const body = { model: model ?? spec.model, messages };
      const temp = temperature ?? spec.temperature;
      if (temp !== undefined) body.temperature = temp;

      const contextWindow = await lookupWindow(body.model, apiKey);
      const started = Date.now();
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(spec.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      }).catch((err) => {
        throw networkError(spec.name, err);
      });
      const text = await res.text();
      if (!res.ok) throw httpError(spec.name, res.status, text);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`provider ${spec.name} 返回的不是 JSON：${text.slice(0, 200)}`);
      }
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error(`provider ${spec.name} 响应里没有 choices[0].message.content`);
      const usage = data.usage ?? {};
      const cost = Number(res.headers?.get?.('x-litellm-response-cost'));
      return {
        text: content.trim(),
        model: data.model ?? body.model,
        durationMs: Date.now() - started,
        usage: {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
          cacheWriteTokens: usage.prompt_tokens_details?.cache_creation_tokens ?? 0,
        },
        contextWindow,
        truncated: data.choices?.[0]?.finish_reason === 'length', // 输出到了 max_tokens 被截断
        ...(Number.isFinite(cost) && cost >= 0 && res.headers.get('x-litellm-response-cost') !== null ? { costUsd: cost } : {}),
      };
    },
  };
}

/** HTTP 错误：5xx 标记为可重试（网关或上游临时故障），4xx 不重试。 */
export function httpError(name, status, body) {
  const err = new Error(`provider ${name} HTTP ${status}：${String(body ?? '').slice(0, 500)}`);
  err.status = status;
  if (status >= 500) err.retryable = true;
  return err;
}

/**
 * 连不上接口时 Node 的 fetch 只说「fetch failed」，真正原因（ETIMEDOUT、ENOTFOUND、证书错误……）在 err.cause 里，
 * 多地址建连失败时还是一个 AggregateError。把这些拼进错误信息，记录里才看得出是哪种故障。
 * 超时和主动中止原样抛出。
 */
export function networkError(name, err) {
  if (!err || err.name === 'TimeoutError' || err.name === 'AbortError' || !err.cause) return err;
  const c = err.cause;
  const one = (e) => [e.code, e.address && `${e.address}${e.port ? `:${e.port}` : ''}`].filter(Boolean).join(' ') || e.message;
  const detail = Array.isArray(c.errors) && c.errors.length ? `${c.code ?? c.name}：${c.errors.map(one).join(', ')}` : one(c);
  const wrapped = new Error(`provider ${name} ${err.message}（${detail}）`, { cause: c });
  if (c.code) wrapped.code = c.code;
  return wrapped;
}
