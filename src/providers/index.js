import { resolveProviderSpec } from '../config.js';
import { createClaudeCliProvider } from './claude-cli.js';
import { createOpenAICompatibleProvider } from './openai-compatible.js';
import { createAnthropicCompatibleProvider } from './anthropic-compatible.js';

/**
 * 模型提供方的统一接口：
 *   complete({ model, system, prompt, effort?, temperature?, session? })
 *     session = { id, turns: [{ prompt, reply }] }：同一位发言者整场讨论的会话，provider 负责把历史带上
 *     -> { text, model, durationMs, usage: { inputTokens, outputTokens }, costUsd? }
 * 新增厂商时实现同样的 complete，并在下面的 FACTORIES 里登记类型名。
 */
const FACTORIES = {
  'claude-cli': createClaudeCliProvider,
  'openai-compatible': createOpenAICompatibleProvider,
  'anthropic-compatible': createAnthropicCompatibleProvider,
  mock: createMockProvider,
};

export function createProviderRegistry(cfg, { forceMock = false, deps = {} } = {}) {
  const cache = new Map();
  return {
    get(name) {
      const key = forceMock ? 'mock' : name;
      if (cache.has(key)) return cache.get(key);
      const spec = forceMock ? { type: 'mock', name: 'mock' } : resolveProviderSpec(cfg, name);
      if (!spec) throw new Error(`未知 provider：${name}`);
      const factory = FACTORIES[spec.type];
      if (!factory) throw new Error(`provider ${name} 的 type ${spec.type} 不受支持，可用：${Object.keys(FACTORIES).join(', ')}`);
      const provider = factory(spec, deps[spec.type] ?? {});
      cache.set(key, provider);
      return provider;
    },
  };
}

/** 不调用任何模型，按提示词生成可预测的文本；用于测试和 --mock 演练。 */
export function createMockProvider(spec = {}) {
  return {
    name: spec.name ?? 'mock',
    async complete({ model, system, prompt }) {
      const who = /你是「([^」]+)」/.exec(`${system ?? ''}\n${prompt ?? ''}`)?.[1] ?? 'mock';
      const stage = /【阶段：([^】]+)】/.exec(prompt ?? '')?.[1] ?? '回答';
      if (stage === '修订版') return { text: mockRevision(prompt), model: model ?? 'mock', durationMs: 1, usage: { inputTokens: prompt?.length ?? 0, outputTokens: 20 } };
      return {
        text: `**${who}** 的${stage}（mock）\n\n- 要点一\n- 要点二\n\n提示词长度 ${prompt?.length ?? 0} 字。`,
        model: model ?? 'mock',
        durationMs: 1,
        usage: { inputTokens: prompt?.length ?? 0, outputTokens: 20 },
      };
    },
  };
}

/** mock 的修订版：按提示词里的 JSON Schema，把第一个文字字段改一下，其余字段由解析时用原值补齐。 */
function mockRevision(prompt) {
  let key = null;
  try {
    const schema = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(prompt ?? '')?.[1] ?? '{}');
    key = Object.entries(schema.properties ?? {}).find(([, v]) => v.type === 'string')?.[0] ?? null;
  } catch {
    // 没有 schema 就不改
  }
  return `\`\`\`json\n${JSON.stringify(key ? { [key]: `（mock 修订版）这里是改过的${key}` } : {})}\n\`\`\``;
}
