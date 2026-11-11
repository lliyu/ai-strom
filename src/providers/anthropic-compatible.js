/**
 * Anthropic Messages 兼容接口（POST {baseUrl}/v1/messages）：
 * 阿里百炼的 /apps/anthropic、其他提供 Anthropic 兼容层的网关，以及 Anthropic 官方 API。
 * 返回里的 thinking 等非正文块会被忽略，只取 text 块。
 */
export function createAnthropicCompatibleProvider(spec, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (!spec.baseUrl) throw new Error(`provider ${spec.name}：缺少 baseUrl`);
  const timeoutMs = spec.timeoutMs ?? 600000;
  const authHeader = spec.authHeader ?? 'x-api-key'; // 或 'bearer'

  return {
    name: spec.name,
    async complete({ model, system, prompt, temperature, session }) {
      const apiKey = spec.apiKeyEnv ? env[spec.apiKeyEnv] : undefined;
      if (spec.apiKeyEnv && !apiKey) throw new Error(`provider ${spec.name}：环境变量 ${spec.apiKeyEnv} 未设置`);
      const body = {
        model: model ?? spec.model,
        max_tokens: spec.maxTokens ?? 8192,
        // 会话：接口本身无状态，把之前每一轮的提问和回答按顺序带上
        messages: [
          ...(session?.turns ?? []).flatMap((t) => [{ role: 'user', content: t.prompt }, { role: 'assistant', content: t.reply }]),
          { role: 'user', content: prompt },
        ],
      };
      if (system) body.system = system;
      const temp = temperature ?? spec.temperature;
      if (temp !== undefined) body.temperature = temp;

      const headers = {
        'Content-Type': 'application/json',
        'anthropic-version': spec.anthropicVersion ?? '2023-06-01',
        ...(spec.headers ?? {}),
      };
      if (apiKey) {
        if (authHeader === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
        else headers['x-api-key'] = apiKey;
      }

      const started = Date.now();
      const res = await fetchImpl(`${spec.baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`provider ${spec.name} HTTP ${res.status}：${text.slice(0, 500)}`);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`provider ${spec.name} 返回的不是 JSON：${text.slice(0, 200)}`);
      }
      const blocks = Array.isArray(data.content) ? data.content : [];
      const answer = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
      if (!answer) throw new Error(`provider ${spec.name} 响应里没有正文（stop_reason=${data.stop_reason ?? '未知'}）`);
      const usage = data.usage ?? {};
      return {
        text: answer,
        model: data.model ?? body.model,
        durationMs: Date.now() - started,
        usage: {
          inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        },
        contextWindow: spec.contextWindow,
        truncated: data.stop_reason === 'max_tokens',
      };
    },
  };
}
