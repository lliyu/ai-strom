import { normalizeConfig, ConfigError, resolveProviderSpec } from './config.js';

/**
 * 网页上每场讨论自己选阵容：用哪几个模型、各自当主笔还是评审、扮演什么角色，主席用哪个模型。
 * Lark 群里的讨论（watch）和命令行不走这里，仍然用 config.json 里固定的 participants / chair。
 *
 * 可选的模型（模型清单）：config.json 里每位参与者就是一个模型（id 不变），再加上 models 里只给网页用的模型；
 * 主席用的模型不在其中时也加进来。阵容选好后存进这场讨论的状态（lineup），追问时照原样用，
 * 不受之后改配置的影响。
 */

export const MAX_SEATS = 8;

/** 常用角色模板。config.json 的 roleTemplates 可以追加，同名的覆盖这里的。modes 为空表示所有模式都适用。 */
export const DEFAULT_ROLE_TEMPLATES = [
  { name: '架构视角', modes: ['decision', 'brainstorm'], persona: '你关注系统边界、数据一致性、扩展性和长期维护成本。' },
  { name: '质疑视角', modes: ['decision', 'brainstorm'], persona: '你专门挑战方案：找漏洞、质疑默认假设、指出被忽视的替代方案和反例。可以同意，但必须先认真找过反对理由。' },
  { name: '落地视角', modes: ['decision', 'brainstorm'], persona: '你关注实施成本、工作量、团队现有能力和分阶段落地路径。' },
  { name: '风险视角', modes: ['decision', 'brainstorm'], persona: '你关注上线风险、故障场景、回滚方案、数据错误的影响面和可观测性。' },
  { name: '性能与成本', modes: ['decision'], persona: '你关注容量和性能：高峰流量下的瓶颈、缓存与数据库压力、延迟预算，以及机器和第三方调用的费用。尽量给出量级估算。' },
  { name: '业务与用户', modes: ['decision', 'brainstorm'], persona: '你站在业务方和最终用户一边：方案解决的是不是真问题，对用户体验、运营流程和对账有什么影响，有没有更简单的业务解法。' },
  { name: '反常识视角', modes: ['brainstorm'], persona: '你专门往反方向和偏门方向想：把常见做法反过来、借用别的行业的做法、把约束当成卖点。宁可离谱，不要平庸。' },
  { name: '结构与人物', modes: ['refine'], persona: '你是资深网文编辑，关注故事结构、主线和人物：核心创意能不能撑起长篇，人物的动机和成长立不立得住，卷与卷之间有没有递进。' },
  { name: '读者视角', modes: ['refine'], persona: '你站在挑剔的网文读者一边：前三章能不能留住人，爽点和情绪是否具体，哪里会让人觉得套路、憋屈而弃书。可以认可，但必须先认真找过弃书的理由。' },
  { name: '市场与差异', modes: ['refine'], persona: '你熟悉番茄、起点等平台的热门作品和读者口味，关注同质化风险、卖点能不能一句话说清、和同类热门书的差异站不站得住。' },
  { name: '逻辑与可持续', modes: ['refine'], persona: '你专门找设定和逻辑漏洞：金手指的边界是否自洽，世界规则有没有被剧情打破，按这个设计写到一两百万字会不会崩、会不会没东西可写。' },
];

const MODEL_ONLY = ['provider', 'model', 'effort', 'contextWindow', 'maxBudgetUsd'];
const MODEL_FIELDS = [...MODEL_ONLY, 'color'];
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

/** 角色模板：内置的加上 config.roleTemplates（同名覆盖）。 */
export function roleTemplates(cfg) {
  const all = new Map(DEFAULT_ROLE_TEMPLATES.map((t) => [t.name, t]));
  for (const t of cfg.roleTemplates ?? []) {
    if (t?.name) all.set(t.name, { name: t.name, persona: t.persona ?? '', modes: t.modes ?? [] });
  }
  return [...all.values()].map((t) => ({ name: t.name, persona: t.persona ?? '', modes: t.modes ?? [] }));
}

/** 能读代码（当核实员）的模型：只有 claude-cli 能带只读工具。 */
export const readsCode = (cfg, m) => ['claude-cli', 'mock'].includes(resolveProviderSpec(cfg, m.provider)?.type);

/** 核实员：读代码写核实初稿，由调研员审查后才发给参与者。 */
function factCheckerOf(m) {
  return { id: 'factchecker', name: '核实员', role: `代码核实 · ${m.name}`, color: 'grey', ...pick(m, MODEL_ONLY) };
}

/** 模型清单：[{ id, name, provider, model, effort, color, ... }]。 */
export function modelPool(cfg) {
  const pool = [];
  const ids = new Set();
  const add = (id, name, src) => {
    if (!id || ids.has(id) || !src?.provider) return;
    ids.add(id);
    pool.push({ id, name: name ?? id, ...pick(src, MODEL_FIELDS) });
  };
  for (const p of cfg.participants ?? []) add(p.id, p.basePersona?.name ?? p.name, p);
  for (const m of cfg.models ?? []) add(m.id, m.name, m);
  const chair = cfg.chair;
  if (chair && !chairModelId(cfg, pool)) add(ids.has('chair') ? 'chair-model' : 'chair', chair.model ?? chair.provider, chair);
  return pool;
}

/** 主席现在用的是清单里的哪个模型。 */
function chairModelId(cfg, pool) {
  const c = cfg.chair;
  return pool.find((m) => m.provider === c?.provider && (m.model ?? null) === (c?.model ?? null) && (m.effort ?? null) === (c?.effort ?? null))?.id
    ?? pool.find((m) => m.provider === c?.provider && (m.model ?? null) === (c?.model ?? null))?.id
    ?? null;
}

/** 某个模式下的默认阵容（页面上「恢复默认」用）：就是 config.json 里配好的参与者和主席。 */
export function defaultLineup(cfg, mode) {
  const c = normalizeConfig(cfg, { mode });
  const pool = modelPool(cfg);
  return {
    participants: c.participants.map((p) => ({ model: p.id, part: p.part === 'reviewer' ? 'reviewer' : 'lead', role: p.role ?? '', persona: p.persona ?? '' })),
    chair: chairModelId(c, pool) ?? pool[0]?.id ?? null,
    factChecker: null, // 不选：调研员直接核实
  };
}

/**
 * 按页面上选的阵容生成这场讨论的配置。lineup = { participants: [{ model, part, role, persona }], chair: 模型 id }。
 * 同一个模型可以出现多次（比如两个 Opus 扮演不同角色），id 和名字后面加序号区分。
 * 不合法时抛 ConfigError。
 */
export function lineupConfig(cfg, { mode, rounds, lineup }) {
  const overrides = { mode, ...(rounds !== undefined ? { rounds } : {}) };
  const base = normalizeConfig(cfg, overrides);
  if (!lineup) return base;
  const seats = lineup.participants;
  if (!Array.isArray(seats) || seats.length < 2) throw new ConfigError('至少选 2 位参与者');
  if (seats.length > MAX_SEATS) throw new ConfigError(`最多 ${MAX_SEATS} 位参与者`);
  const pool = new Map(modelPool(cfg).map((m) => [m.id, m]));
  const used = new Set(['chair']);
  const count = new Map();
  const participants = seats.map((s, i) => {
    const m = pool.get(s?.model);
    if (!m) throw new ConfigError(`第 ${i + 1} 位：没有「${s?.model ?? ''}」这个模型`);
    const role = String(s.role ?? '').trim().slice(0, 40);
    if (!role) throw new ConfigError(`第 ${i + 1} 位（${m.name}）：角色不能为空`);
    const n = (count.get(m.id) ?? 0) + 1;
    count.set(m.id, n);
    let id = n > 1 ? `${m.id}-${n}` : m.id;
    for (let k = n + 1; used.has(id); k += 1) id = `${m.id}-${k}`;
    used.add(id);
    return {
      ...pick(m, MODEL_FIELDS),
      id,
      name: n > 1 ? `${m.name}（${n}）` : m.name,
      role,
      persona: String(s.persona ?? '').trim().slice(0, 2000),
      part: s.part === 'reviewer' ? 'reviewer' : 'lead',
    };
  });
  // 主席：名字、角色、颜色按模式（主席 / 主编），模型换成选的
  let chair = speakerDef(base.chair);
  if (lineup.chair) {
    const m = pool.get(lineup.chair);
    if (!m) throw new ConfigError(`主席：没有「${lineup.chair}」这个模型`);
    for (const k of MODEL_ONLY) delete chair[k];
    Object.assign(chair, pick(m, MODEL_ONLY));
  }
  // 核实员：有代码时读代码答「待核实的事实」；本场无代码时联网搜集资料、联网核实。都由调研员审查后再发
  let research = cfg.research;
  if (lineup.factChecker && mode === 'decision') {
    const m = pool.get(lineup.factChecker);
    if (!m) throw new ConfigError(`核实员：没有「${lineup.factChecker}」这个模型`);
    if (!readsCode(cfg, m)) throw new ConfigError(`核实员：${m.name} 不能读代码，只能选 claude-cli 的模型`);
    research = { ...cfg.research, factChecker: factCheckerOf(m) };
  } else if (research?.factChecker) {
    research = { ...research, factChecker: undefined };
  }
  return normalizeConfig({ ...cfg, participants, chair, personas: {}, customLineup: true, ...(research ? { research } : {}) }, overrides);
}

/** 存进讨论状态的阵容：完整的发言者定义（不含 webhook），追问时不再依赖模型清单。 */
export function savedLineup(cfg) {
  if (!cfg.customLineup) return null;
  return { participants: cfg.participants.map(speakerDef), chair: speakerDef(cfg.chair), ...(cfg.research?.factChecker ? { factChecker: speakerDef(cfg.research.factChecker) } : {}) };
}

/** 追问或补写主文档：讨论存了自己的阵容就用它，否则（群里和命令行的讨论）用配置。 */
export function configForState(cfg, state) {
  if (!state?.lineup) return { ...cfg, mode: state?.mode ?? cfg.mode };
  const research = cfg.research ? { ...cfg.research, factChecker: state.lineup.factChecker ?? undefined } : cfg.research;
  return normalizeConfig({ ...cfg, participants: state.lineup.participants, chair: state.lineup.chair, personas: {}, customLineup: true, ...(research ? { research } : {}) }, { mode: state.mode });
}

function speakerDef(s) {
  const { basePersona, webhook, ...rest } = s;
  return structuredClone(Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
}
