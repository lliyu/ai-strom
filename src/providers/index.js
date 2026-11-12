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
      if (stage === '核对主文档') return { text: '没有问题', model: model ?? 'mock', durationMs: 1, usage: { inputTokens: prompt?.length ?? 0, outputTokens: 4 } };
      if (stage === '改稿') return { text: `**要点**：改了开头（mock）\n\n- 开头更快进入冲突\n\n【完整方案】\n${mockRedraft(`${system ?? ''}\n${prompt ?? ''}`)}`, model: model ?? 'mock', durationMs: 1, usage: { inputTokens: prompt?.length ?? 0, outputTokens: 40 } };
      if (stage.includes('主文档') || stage === '快问定稿' || stage === '改稿定稿') return { text: mockDoc(stage, prompt), model: model ?? 'mock', durationMs: 1, usage: { inputTokens: prompt?.length ?? 0, outputTokens: 40 } };
      const itemized = mockItems(stage, prompt ?? '');
      if (itemized) return { text: itemized, model: model ?? 'mock', durationMs: 1, usage: { inputTokens: prompt?.length ?? 0, outputTokens: 30 } };
      return {
        text: `**${who}** 的${stage}（mock）\n\n- 要点一\n- 要点二\n\n提示词长度 ${prompt?.length ?? 0} 字。`,
        model: model ?? 'mock',
        durationMs: 1,
        usage: { inputTokens: prompt?.length ?? 0, outputTokens: 20 },
      };
    },
  };
}

/**
 * 条目化发言开着时（提示词里有条目格式）：评审、修订、挑刺、代码核实按条目写。
 * 评审第 2 轮提一条阻断并要求继续，之后只剩建议、没有意见了，mock 讨论两三轮就收敛。
 */
function mockItems(stage, prompt) {
  if (!/｜改法：… ｜依据：…|｜依据：仓库别名|【改】原来… → 现在…/.test(prompt)) return null;
  const round = Number(/第 (\d+) 轮/.exec(stage)?.[1] ?? 0);
  const verdict = /评审结论：继续讨论/.test(prompt);
  if (stage.includes('评审意见')) {
    const blocking = round <= 2;
    return [
      blocking ? '**要点**：方案 A 还有 1 条阻断，预算会超扣（mock）' : '**要点**：没有阻断了，只剩一条建议（mock）',
      '**方案 A**',
      blocking ? '- 【阻断】并发扣减时预算会超扣（mock） ｜改法：扣减时加行锁 ｜依据：推断 ｜影响：活动亏钱' : '',
      '- 【建议】补一个超扣告警（mock） ｜改法：扣减后比对余额',
      verdict ? `评审结论：${blocking ? '继续讨论' : '没有意见了'}` : '',
    ].filter(Boolean).join('\n');
  }
  if (stage.includes('互评与修订')) {
    return [
      '**要点**：采纳阻断，扣减改成加锁（mock）',
      '**改了什么**',
      '- 【改】不加锁 → 扣减时加行锁 ｜依据：推断',
      /对评审意见的回应/.test(prompt) ? '**对评审意见的回应**\n- 【采纳】评审 1 的「并发扣减时预算会超扣」 ｜改法：扣减时加行锁' : '',
      '**立场变化**：小幅，加了锁（mock）',
      '',
      '【完整方案】',
      'mock 完整方案：扣减时加行锁。',
    ].filter((l) => l !== '').join('\n');
  }
  if (stage === '挑刺') {
    return ['**要点**：有一个要紧的前提没说（mock）', '**问题**', '- 【阻断】回答默认了预算充足（mock） ｜改法：先问清预算 ｜依据：推断 ｜影响：建议可能做不到'].join('\n');
  }
  if (stage.includes('核实')) return '1. 【确认】mock 核实的结论 ｜依据：mock:src/a.js:1';
  return null;
}

/** mock 的主文档：初稿或更新后的完整版本，版本号从提示词里取。 */
function mockDoc(stage, prompt) {
  const version = Number(/现在的主文档（第 (\d+) 版）/.exec(prompt ?? '')?.[1] ?? 0) + 1;
  if (/## 修改说明（按重要程度/.test(prompt ?? '')) {
    const draft = /## 你的修改稿\n([\s\S]*?)\n\n## /.exec(prompt ?? '')?.[1] ?? mockRedraft(prompt);
    return [
      '【说明】',
      stage.startsWith('更新') ? `追问后改到第 ${version} 版（mock）。` : '**一句话结论**：开头更快进入冲突（mock）。',
      '【主文档】',
      '# mock 改稿',
      '**一句话结论**：开头更快进入冲突（mock）。',
      '## 修改说明',
      '- 第一段：删掉铺垫，直接进冲突（mock）',
      '## 没采纳的意见',
      '无',
      '## 可存入知识库的结论',
      '- 主角说话简短，不用感叹号（mock）',
      '【附录：修改稿】',
      draft,
    ].join('\n');
  }
  if (/## 回答（直接回答问题/.test(prompt ?? '')) {
    return [
      '【说明】',
      stage.startsWith('更新') ? `追问的结论（mock）：快问文档改到第 ${version} 版。` : '**一句话结论**：mock 快问的结论。',
      '【主文档】',
      '# mock 快问',
      '**一句话结论**：mock 快问的结论。',
      '## 回答',
      `第 ${version} 版的回答（mock）。`,
      '## 你可能没考虑到的',
      '- 盲点一（mock）',
      '## 需要你补充的',
      '- 预算是多少（mock）',
      '## 下一步',
      '1. 先试一下（mock）',
      '## 可存入知识库的结论',
      '- 可以复用的结论（mock）',
    ].join('\n');
  }
  return [
    '【说明】',
    stage.startsWith('更新') ? `追问的结论（mock）：主文档改到第 ${version} 版。` : '**一句话结论**：mock 讨论的结论。',
    '【主文档】',
    '# mock 主文档',
    '**一句话结论**：mock 讨论的结论。',
    '## 要点',
    '- 要点一',
    '- 要点二',
    '## 要拍板的事',
    '- 【先定】要不要做（mock）',
    '## 问题',
    '议题背景（mock）。',
    '## 方案',
    `第 ${version} 版的方案（mock）。`,
    '## 下一步',
    '1. 下一步（mock）',
  ].join('\n');
}

/** mock 的改稿：把章节原文第一段换掉，其余照抄。 */
function mockRedraft(prompt) {
  const original = /## 章节原文\n([\s\S]*?)(?:\n\n## |$)/.exec(prompt ?? '')?.[1] ?? '';
  const paras = original.split('\n').filter((l) => l.trim());
  return ['（mock 改过的第一段）他推门进来，屋里的人都不说话了。', ...paras.slice(1)].join('\n');
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
