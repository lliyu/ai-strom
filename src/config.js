import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CARD_COLORS = [
  'blue', 'wathet', 'turquoise', 'green', 'yellow', 'orange',
  'red', 'carmine', 'violet', 'purple', 'indigo', 'grey',
];
export const MODES = ['decision', 'brainstorm', 'refine'];
export const PARTS = ['lead', 'reviewer'];

/** 解析 .env：KEY=VALUE，忽略空行与注释；已存在的环境变量不覆盖。 */
export function loadDotEnv(file, env = process.env) {
  if (!fs.existsSync(file)) return {};
  const loaded = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) {
      env[key] = value;
      loaded[key] = true;
    }
  }
  return loaded;
}

export function loadConfig(configPath) {
  const file = path.resolve(configPath);
  if (!fs.existsSync(file)) {
    throw new ConfigError(`找不到配置文件 ${file}。先复制 config.example.json 为 config.json 再修改。`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`配置文件不是合法 JSON：${file}：${err.message}`);
  }
  return normalizeConfig(raw);
}

export class ConfigError extends Error {}

/** 补默认值并校验；返回新对象，不修改入参。 */
export function normalizeConfig(raw, overrides = {}) {
  const cfg = structuredClone(raw ?? {});
  Object.assign(cfg, Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)));
  cfg.mode ??= 'decision';
  // rounds：数字是固定轮数；'auto'（默认）是自动——评审都没有新意见就结束，最多 maxRounds 轮
  cfg.maxRounds = Number(cfg.maxRounds ?? 20);
  // 已经规范化过的配置（adaptive 为 true）再规范化时保持自动；命令行或指令里给了轮数就改成固定
  cfg.adaptive = overrides.rounds !== undefined
    ? overrides.rounds === 'auto'
    : cfg.adaptive === true || cfg.rounds === undefined || cfg.rounds === null || cfg.rounds === 'auto';
  cfg.rounds = cfg.adaptive ? cfg.maxRounds : Number(cfg.rounds);
  cfg.concurrency = Number(cfg.concurrency ?? 3);
  // 会话：每位参与者整场讨论在同一条会话里，记得自己之前说过的话。false 时每轮都是新会话
  cfg.conversation = cfg.conversation !== false;
  cfg.providers ??= {};
  cfg.lark ??= {};
  cfg.lark.maxCardBytes ??= 18000;
  cfg.lark.minIntervalMs ??= 250;
  cfg.lark.interjection ??= { enabled: false };
  cfg.lark.interjection.allowFrom ??= [];

  const errors = [];
  if (!MODES.includes(cfg.mode)) errors.push(`mode 只能是 ${MODES.join(' / ')}，当前是 ${cfg.mode}`);
  if (!Number.isInteger(cfg.maxRounds) || cfg.maxRounds < 2 || cfg.maxRounds > 20) errors.push('maxRounds 需要是 2 到 20 的整数');
  else if (!Number.isInteger(cfg.rounds) || cfg.rounds < 1 || cfg.rounds > 20) errors.push('rounds 需要是 "auto" 或 1 到 20 的整数');
  if (!Number.isInteger(cfg.concurrency) || cfg.concurrency < 1) errors.push('concurrency 需要是正整数');
  if (!Array.isArray(cfg.participants) || cfg.participants.length < 2) {
    errors.push('participants 至少需要 2 个发言者');
  }
  if (!cfg.chair) errors.push('缺少 chair（主席）配置');

  const speakers = [...(cfg.participants ?? []), ...(cfg.chair ? [cfg.chair] : [])];
  const ids = new Set();
  for (const s of speakers) {
    const where = `发言者 ${s.id ?? '(未命名)'}`;
    if (!s.id) errors.push(`${where}：缺少 id`);
    if (ids.has(s.id)) errors.push(`${where}：id 重复`);
    ids.add(s.id);
    s.name ??= s.id;
    s.role ??= '';
    s.color ??= 'grey';
    if (!CARD_COLORS.includes(s.color)) errors.push(`${where}：color 只能是 ${CARD_COLORS.join(', ')}`);
    if (!s.provider) errors.push(`${where}：缺少 provider`);
    else if (!resolveProviderSpec(cfg, s.provider)) errors.push(`${where}：providers 里没有 ${s.provider}`);
  }
  const parts = (cfg.participants ?? []).map((p) => p.part ?? 'lead');
  const badPart = (cfg.participants ?? []).filter((p) => p.part !== undefined && !PARTS.includes(p.part));
  for (const p of badPart) errors.push(`发言者 ${p.id}：part 只能是 ${PARTS.join(' / ')}`);
  const leadCount = parts.filter((x) => x === 'lead').length;
  const reviewerCount = parts.filter((x) => x === 'reviewer').length;
  if (Array.isArray(cfg.participants) && leadCount === 0) errors.push('至少需要 1 位主笔（part 为 lead 或不填）');
  if (reviewerCount && cfg.rounds < 2) errors.push('配置了评审时 rounds 至少为 2，否则评审没有发言机会');

  applyModePersonas(cfg, errors);
  normalizeRepos(cfg, errors);

  // 打磨（refine）用的墨稿接口与本地网页
  cfg.novel = { baseUrl: 'http://127.0.0.1:3000', timeoutMs: 60000, ...(cfg.novel ?? {}) };
  cfg.web = { host: '127.0.0.1', port: 8790, ...(cfg.web ?? {}) };
  if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.web.host)) errors.push('web.host 只能是本机地址（127.0.0.1 / localhost / ::1），页面没有登录');

  const ij = cfg.lark.interjection;
  if (ij.enabled && !/^oc_/.test(ij.chatId ?? '')) errors.push('lark.interjection.enabled 为 true 时需要填写群的 chatId（oc_ 开头）');

  if (errors.length) throw new ConfigError(`配置有误：\n- ${errors.join('\n- ')}`);
  return cfg;
}

/**
 * 按模式换角色：personas.<mode>.<发言者 id> = { role, persona, name? }。
 * 例如打磨小说时把「架构视角」换成「结构与人物」。原来的角色记在 basePersona 里，换模式重新规范化时先还原。
 */
function applyModePersonas(cfg, errors) {
  const table = cfg.personas?.[cfg.mode] ?? {};
  const speakers = [...(cfg.participants ?? []), ...(cfg.chair ? [cfg.chair] : [])];
  const ids = new Set(speakers.map((s) => s.id));
  for (const id of Object.keys(table)) if (!ids.has(id)) errors.push(`personas.${cfg.mode}.${id}：没有这个发言者`);
  for (const s of speakers) {
    s.basePersona ??= { name: s.name, role: s.role, persona: s.persona };
    Object.assign(s, s.basePersona, table[s.id] ?? {});
  }
}

const expandHome = (p) => (typeof p === 'string' && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const ALIAS_RE = /^[\w.\-]+$/;
const RESEARCH_PROVIDER_TYPES = new Set(['claude-cli', 'mock']);

/** 代码上下文：repos、repoGroups 与调研员 research。只在登记了仓库时校验 research。 */
function normalizeRepos(cfg, errors) {
  cfg.repos ??= {};
  cfg.repoGroups ??= {};
  for (const [alias, r] of Object.entries(cfg.repos)) {
    if (!ALIAS_RE.test(alias)) errors.push(`repos.${alias}：别名只能用字母、数字、点、横线和下划线`);
    if (typeof r?.path !== 'string' || !path.isAbsolute(expandHome(r.path))) errors.push(`repos.${alias}：path 需要是绝对路径`);
    else r.path = expandHome(r.path);
    r.docs = (r.docs ?? []).map(expandHome);
  }
  for (const [name, g] of Object.entries(cfg.repoGroups)) {
    if (!ALIAS_RE.test(name)) errors.push(`repoGroups.${name}：组名只能用字母、数字、点、横线和下划线`);
    if (cfg.repos[name]) errors.push(`repoGroups.${name}：和 repos 里的别名重名`);
    g.repos ??= [];
    g.docs = (g.docs ?? []).map(expandHome);
    for (const a of g.repos) if (!cfg.repos[a]) errors.push(`repoGroups.${name}：repos 里没有 ${a}`);
  }
  if (!Object.keys(cfg.repos).length) return;

  const r = cfg.research ?? {};
  cfg.research = {
    id: 'research',
    name: '调研员',
    role: '代码调研',
    color: 'grey',
    provider: 'claude-cli',
    model: 'opus',
    effort: 'medium',
    tools: ['Read', 'Grep', 'Glob'],
    timeoutMs: 15 * 60000,
    maxChars: 16000,
    auto: true,
    // 讨论中途核实：参与者列出「待核实的事实」后，下一轮开始前由调研员查代码回答
    factCheck: true,
    factCheckMaxQuestions: 8,
    factCheckMaxChars: 4000,
    webhook: cfg.chair?.webhook,
    ...r,
  };
  const spec = resolveProviderSpec(cfg, cfg.research.provider);
  if (!spec) errors.push(`research：providers 里没有 ${cfg.research.provider}`);
  else if (!RESEARCH_PROVIDER_TYPES.has(spec.type)) errors.push('research：调研员需要读代码，provider 只能是 claude-cli');
  if (!CARD_COLORS.includes(cfg.research.color)) errors.push(`research：color 只能是 ${CARD_COLORS.join(', ')}`);
  if (!Number.isInteger(cfg.research.factCheckMaxQuestions) || cfg.research.factCheckMaxQuestions < 1) errors.push('research.factCheckMaxQuestions 需要是正整数');

  // readCode：讨论中能否自己只读查看代码。不填时，用 claude-cli 的主笔默认可以；只有 claude-cli 能带只读工具
  for (const p of cfg.participants ?? []) {
    const type = resolveProviderSpec(cfg, p.provider)?.type;
    if (p.readCode === undefined) p.readCode = (p.part ?? 'lead') === 'lead' && type === 'claude-cli';
    else if (p.readCode && !RESEARCH_PROVIDER_TYPES.has(type)) errors.push(`发言者 ${p.id}：readCode 需要 claude-cli（只有它能只读查看代码）`);
  }
}

const BUILTIN_PROVIDER_TYPES = new Set(['claude-cli', 'openai-compatible', 'anthropic-compatible', 'mock']);

/** provider 名字先查 providers 表；表里没有、但本身是内置类型名时直接用默认参数。 */
export function resolveProviderSpec(cfg, name) {
  const entry = cfg.providers?.[name];
  if (entry) return { type: entry.type ?? name, ...entry, name };
  if (BUILTIN_PROVIDER_TYPES.has(name)) return { type: name, name };
  return null;
}

/** 读取发言者的 webhook 地址与密钥；缺失时返回 null。 */
export function resolveWebhook(speaker, env = process.env) {
  const hook = speaker.webhook;
  if (!hook?.urlEnv) return null;
  const url = env[hook.urlEnv];
  if (!url) return null;
  return { url, secret: hook.secretEnv ? env[hook.secretEnv] || null : null };
}

export function maskUrl(url) {
  if (!url) return '(未设置)';
  const tail = url.slice(-4);
  const head = url.replace(/\/hook\/.*$/, '/hook/');
  return `${head}****${tail}`;
}
