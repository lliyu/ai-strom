/**
 * 两种讨论模式的阶段与提示词。
 *
 * decision（方案讨论，求收敛）：
 *   第 1 轮各自独立出方案 → 第 2..N 轮看到别人的匿名方案后互评并修订 → 主席写主文档（见文件末尾「主文档」）。
 *
 * 提示词的顺序按缓存设计：整场不变的议题和背景资料放在所有发言者共用的系统提示词里（sharedSystem），
 * 发言者的身份和本轮任务放在消息正文。这样同一场讨论里后面的调用都能命中前面写下的缓存，
 * Claude 的几位发言者之间也能互相命中。
 *
 * brainstorm（脑洞风暴，求发散）：
 *   第 1 轮各自按固定视角发散 → 每个循环先盲审（只给意见、不改写）再各自修订 → 主编挑选与组合。
 *   不让参与者自由讨论，避免多轮之后观点趋同。
 *
 * refine（作品打磨，从墨稿 novel-idea 取一份脑洞 / 梗概 / 总纲）：
 *   流程同 decision：主笔诊断并给修改方案 → 评审提意见 → 主笔修订 → 主编写主文档（修改说明）；
 *   最后主编按主文档写出完整修订版（JSON，结构由墨稿给出），作者在 ai-storm 页面上确认后才写回墨稿。
 */

export const SUBJECT_LABELS = { idea: '脑洞', premise: '梗概', outline: '总纲' };

/** 墨稿字段的中文名，修订版说明里用。 */
export const FIELD_LABELS = {
  content: '内容', angle: '创意方向', fromMaterial: '素材延伸', marketRef: '借鉴榜单', coreIdea: '核心创意', identityRole: '原身份的分量',
  title: '书名', logline: '一句话梗概', protagonist: '主角', goal: '目标', obstacle: '阻碍', goldenFinger: '金手指',
  goldenFingerCost: '金手指的边界', goldenFingerGrowth: '金手指的成长', sellingPoint: '卖点', hook: '开篇钩子', differentiation: '差异点',
  arc: '总纲', volumes: '分卷',
};
const subjectLabel = (subject) => SUBJECT_LABELS[subject?.type] ?? '作品';

export const STAGE_LABELS = {
  propose: '独立方案',
  critique: '评审意见',
  review: '互评与修订',
  diverge: '发散',
  feedback: '盲审意见',
  revise: '修订',
  summary: '汇总',
  research: '代码调研',
  triage: '追问判断',
  answer: '回答追问',
  followup: '回应追问',
  diagnose: '诊断与修改方案',
  rewrite: '修订版',
  factcheck: '代码核实',
  doc: '主文档',
  doccheck: '核对主文档',
};

export function participantSystem(p, { maxChars, mode } = {}) {
  const refine = mode === 'refine';
  const capped = Boolean(LIMITS[mode]);
  return [
    `你是「${p.name}${p.role ? ` · ${p.role}` : ''}」，正在和其他几位 AI 参与一场多人讨论，${refine ? '作者会全程看着讨论过程' : '讨论过程会发到团队群里'}。`,
    p.persona ?? '',
    '规则：',
    '- 独立思考。不要为了和别人保持一致而改变观点；同意或反对都要给出依据。',
    '- 不知道的事实明确说不知道，不要编造数据、接口或配置。',
    refine ? '- 作品定位是作者定的，不要建议换题材、换平台；以作者的要求为准。' : '',
    '- 一针见血：先说结论，只写会影响判断的内容。不复述议题、别人的方案、评审意见或你自己说过的话，不写铺垫和客套。',
    capped
      ? '- 用中文，使用 Markdown 的加粗和列表，不要使用表格和 # 标题。每次发言的字数上限写在本轮任务里，必须遵守，宁可少写；超出会被要求压缩重写。'
      : `- 用中文，使用 Markdown 的加粗和列表，不要使用表格和 # 标题，控制在 ${maxChars ?? 1200} 字以内。`,
  ].filter(Boolean).join('\n');
}

// ---------- 篇幅：每类发言的字数上限，以及「要点 / 详细 / 完整方案」的拆分 ----------
//
// 人只需要看「要点」：卡片上默认只显示要点，详细内容折叠。
// 主笔修订时只把这一轮的变化写给人看；完整方案写在「【完整方案】」这一行之后，
// 只交给其他参与者和主席，不发到群里（本地记录里有）。

/** 各模式的字数上限（按去掉空白和 Markdown 符号后的字数算）；脑洞风暴不限。 */
export const LIMITS = {
  decision: { brief: 150, propose: 1500, critique: 700, review: 800, followup: 800, plan: 1800 },
  refine: { brief: 150, propose: 2200, critique: 900, review: 1000, followup: 1000, plan: 2500 },
};

/** 合并配置里的 limits（可以只覆盖几项）；tolerance 是超出多少倍才要求压缩重写。 */
export function limitsFor(mode, override = {}) {
  const base = LIMITS[mode];
  return base ? { ...base, tolerance: 1.25, ...override } : null;
}

export const PLAN_MARKER = '【完整方案】';
const PLAN_LINE = /^[ \t]*\**[ \t]*【完整方案】[^\n]*$/m;
const BRIEF_HEAD = /^[ \t]*\**[ \t]*要点[ \t]*\**[ \t]*(?:[（(][^\n]*?[)）])?[ \t]*\**[ \t]*[:：]?[ \t]*\**[ \t]*(.*)$/;
const BOLD_HEAD = /^[ \t]*\*\*[^*\n]+\*\*/;

/** 字数：去掉空白和 Markdown 符号。 */
export function charCount(text) {
  return String(text ?? '').replace(/[\s*`>#|\-]/g, '').length;
}

/**
 * 拆开一条发言：brief 是开头「要点」一节（没写就是 null），detail 是要点之后、完整方案之前的部分，
 * plan 是「【完整方案】」之后的部分（没写就是 null），shown = 要点 + 详细（给人看的全部）。
 */
export function splitReply(text) {
  const raw = String(text ?? '').trim();
  const m = PLAN_LINE.exec(raw);
  // 模型常在完整方案前加一条分隔线，去掉
  const shown = (m ? raw.slice(0, m.index) : raw).trim().replace(/\n[ \t]*([-*_])\1{2,}[ \t]*$/, '').trim();
  const plan = m ? raw.slice(m.index + m[0].length).trim() || null : null;
  const lines = shown.split('\n');
  // 要点要在开头几行里，前面最多容一行多余的话
  const at = lines.slice(0, 3).findIndex((l) => BRIEF_HEAD.test(l));
  if (at < 0) return { brief: null, detail: shown, plan, shown };
  const brief = [];
  const inlineText = BRIEF_HEAD.exec(lines[at])[1].trim();
  if (inlineText) brief.push(inlineText);
  let i = at + 1;
  for (; i < lines.length; i += 1) {
    const l = lines[i];
    // 下一节的标题（加粗开头的行或 # 标题）就是要点的结束；列表项里的加粗不算
    if (BOLD_HEAD.test(l) || /^\s*#{1,6}\s/.test(l)) break;
    brief.push(l);
  }
  const briefText = brief.join('\n').trim();
  if (!briefText) return { brief: null, detail: shown, plan, shown };
  const detail = [...lines.slice(0, at), ...lines.slice(i)].join('\n').trim();
  return { brief: briefText, detail, plan, shown };
}

/** 是否超出上限：给人看的部分和完整方案分开算。返回超出的说明，没超出返回 null。 */
export function overLimit(text, { max, plan: planMax, brief: briefMax, tolerance = 1.25 } = {}) {
  const { shown, plan, brief } = splitReply(text);
  const over = [];
  if (briefMax && brief && charCount(brief) > briefMax * tolerance) over.push(`要点 ${charCount(brief)} 字（上限 ${briefMax}）`);
  if (max && charCount(shown) > max * tolerance) over.push(`给人看的部分 ${charCount(shown)} 字（上限 ${max}）`);
  if (planMax && plan && charCount(plan) > planMax * tolerance) over.push(`完整方案 ${charCount(plan)} 字（上限 ${planMax}）`);
  return over.length ? over.join('，') : null;
}

/** 超出上限时让发言者压缩重写。会话模式下原回答已经在会话里，非会话模式要贴回去。 */
export function compressPrompt({ over, original, limit }) {
  return join(
    `【压缩重写】你刚才的回答超出了字数上限：${over}。`,
    original ? `## 你刚才的回答\n${original}` : '',
    [
      `请压缩后完整重写一遍：结构、结论和立场都不变，删掉复述、铺垫、举例和次要细节，每条只留一句话。`,
      `要点不超过 3 行${limit.brief ? `、${limit.brief} 字` : ''}，给人看的部分不超过 ${limit.max} 字${limit.plan ? `，「${PLAN_MARKER}」之后的完整方案不超过 ${limit.plan} 字` : ''}。`,
      '只输出重写后的全文，不要解释。',
    ].join('\n'),
  );
}

/** 评审是否还提了阻断级问题。 */
export function hasBlocker(text) {
  return /[【\[]\s*阻断\s*[】\]]/.test(String(text ?? ''));
}

/** 要点一节的写法，所有发言共用。 */
function briefLine(what) {
  return `**要点**（放在最前面，不超过 3 行，人只看这几行就要知道${what}）`;
}

export function chairSystem(mode) {
  if (mode === 'refine') {
    return [
      '你是「主编」，负责汇总一场多 AI 作品打磨讨论，帮作者决定怎么改。',
      '你只看到匿名代号（方案 A、方案 B……，评审 1、评审 2……），不要猜测它们来自哪个模型。',
      '保持中立：如实呈现共识与分歧，不要自己另起一套改法；作者的要求优先。',
      '用中文，使用 Markdown 的加粗和列表，不要使用表格和 # 标题。',
    ].join('\n');
  }
  if (mode === 'brainstorm') {
    return [
      '你是「主编」，负责从一场多 AI 头脑风暴里挑出最有潜力的点子。',
      '你只看到匿名代号（方案 A、方案 B……），不要猜测它们来自哪个模型。',
      '看重新鲜感和可写性，保留不同方向的多样性，不要把所有点子揉成一个。',
      '用中文，使用 Markdown 的加粗和列表，不要使用表格和 # 标题。',
    ].join('\n');
  }
  return [
    '你是「主席」，负责汇总一场多 AI 方案讨论，供人类做决定。',
    '你只看到匿名代号（方案 A、方案 B……），不要猜测它们来自哪个模型。',
    '保持中立：如实呈现共识与分歧，不要自己另起一个新方案，也不要替人类拍板。',
    '用中文，使用 Markdown 的加粗和列表，不要使用表格和 # 标题。',
  ].join('\n');
}

function topicBlock(topic, mode) {
  return `## ${mode === 'brainstorm' ? '题目' : '议题'}\n${topic.trim()}`;
}

/**
 * 追问后给评审看的讨论范围：人类追问的原文（不含主席的说明，避免评审被主席的判断带偏）。
 * 会话模式下每位评审在一次追问里只需要看到一次，之后几轮按同一范围评审。
 */
export function scopeBlock(scope, { once = false } = {}) {
  if (!scope?.trim()) return '';
  return [
    `## 本次讨论范围（人类的追问原文）\n${scope.trim()}`,
    '',
    '这次评审以上面的追问为准：',
    '- 人类在追问里已经明确的决定当作前提，不要再质疑。',
    '- 超出这个范围的问题（包括人类说了不需要讨论的内容）不要提，也不能标为【阻断】。',
    '- 和追问直接相关、会改变结论或导致结论不成立的问题照常提。',
    once ? '- 这段范围本次追问里只说这一次，后面几轮评审也按它来。' : '',
  ].filter((l) => l !== '').join('\n');
}

export function interjectionBlock(items) {
  if (!items?.length) return '';
  const lines = items.map((m) => `- ${m.time ? `[${m.time}] ` : ''}${m.sender}：${m.text}`);
  return `## 人类主持人的插话（优先级最高，必须回应）\n${lines.join('\n')}`;
}

/**
 * 所有参与者和主席共用的系统提示词：整场讨论里内容不变，放在最前面方便命中缓存。
 * 这里不写任何发言者的身份，身份和本轮任务在消息正文开头。
 */
export function sharedSystem({ mode, topic, context, subject }) {
  if (mode === 'refine') {
    const label = subjectLabel(subject);
    return join(
      `这是一场多 AI 网文${label}打磨讨论：几位 AI 找出下面这份${label}的不足、讨论怎么改，作者全程看着，最后决定是否采用。你的身份、规则和本轮任务写在用户消息开头，以那里为准。`,
      subjectBlock(subject, topic),
    );
  }
  return join(
    `这是一场多 AI ${mode === 'brainstorm' ? '脑洞风暴' : '方案讨论'}，过程会发到团队群里。你的身份、规则和本轮任务写在用户消息开头，以那里为准。`,
    topicBlock(topic, mode),
    contextBlock(context),
  );
}

/** 打磨对象：背景（不改）、现在的版本、作者的要求。 */
export function subjectBlock(subject, requirement) {
  const label = subjectLabel(subject);
  return [
    `## 打磨对象：${label}「${subject.title}」`,
    '',
    '### 背景（不在这次修改范围内，用来判断改得对不对）',
    subject.background?.trim() || '（无）',
    '',
    '### 现在的版本',
    subject.current.trim(),
    '',
    '## 作者的要求',
    requirement?.trim() || `（作者没有额外要求：找出最影响这份${label}质量的问题并改好）`,
  ].join('\n');
}

/** 调研员整理的背景资料；所有参与者和主席都拿同一份。 */
export function contextBlock(context) {
  if (!context?.text) return '';
  return [
    `## 背景资料（调研员在讨论前从代码里整理${context.auto ? '，仓库由调研员按议题定位' : `，涉及仓库：${context.repos.map((r) => r.alias).join('、')}`}）`,
    '讨论要以这里的事实为准。资料里的源码坐标写作「仓库别名:路径:行号」，可以直接引用。资料没覆盖的代码细节不要猜，写进需要确认的问题。',
    '',
    context.text,
  ].join('\n');
}

// ---------- 代码调研（讨论开始前） ----------

export function researchSystem() {
  return [
    '你是「调研员」。一场多 AI 讨论马上开始，参与者看不到代码，只能看到你整理的背景资料。',
    '你只能用 Read、Grep、Glob 只读查看下面列出的目录。',
    '你的任务是摸清与议题相关的代码现状，不是提方案：不要给建议，不要评价设计好坏。',
    '只写你在代码或文档里亲眼看到的事实，每条事实都带源码坐标。看不到的就写进「需要人确认的问题」，不要推测。',
    '用中文，使用 Markdown 的加粗、列表和代码块，不要使用表格和 # 标题。',
  ].join('\n');
}

export function researchPrompt({ topic, mode, repos, docs = [], maxChars = 16000, auto = false }) {
  const repoLines = repos.map((r) => {
    const where = r.snapshot
      ? `${r.ref} 的快照（commit ${r.commit}）`
      : r.commit ? `本机工作区，分支 ${r.branch ?? '(detached)'}，commit ${r.commit}${r.dirty ? `，含 ${r.dirty} 个未提交改动` : ''}` : '本机目录';
    return `- **${r.alias}**${r.description ? `（${r.description}）` : ''}：\`${r.readPath}\`，${where}`;
  });
  const docLines = docs.map((d) => `- \`${d}\``);
  const isBrainstorm = mode === 'brainstorm';
  return join(
    `【阶段：${STAGE_LABELS.research}】`,
    topicBlock(topic, mode),
    auto
      ? `## 已登记的仓库（议题没有指定仓库：先判断涉及哪些，只查相关的，不要每个都查）\n${repoLines.join('\n')}`
      : `## 可以查看的仓库\n${repoLines.join('\n')}`,
    docLines.length ? `## 参考资料（团队整理的文档，先看这里找线索，再到代码里核实）\n${docLines.join('\n')}` : '',
    [
      '## 做法',
      ...(auto ? [
        '0. 先定位仓库。议题里的名字可能是简称、服务名、拼写变体或中文业务词（例如 pricecenter、price center、价格中心都可能指 price-center 一类仓库），对照上面的别名、目录名和描述判断涉及哪些仓库；拿不准时在候选仓库里 Grep 议题里的关键词确认。',
        '   如果议题和这些仓库都无关，只输出「无相关代码」，不要做别的。',
      ] : []),
      '1. 先用 Glob 看目录结构，用 Grep 按议题里的业务词、类名、表名、接口名定位，再用 Read 读关键代码。',
      '2. 从入口顺着调用往下追，直到弄清数据从哪来、写到哪去。',
      '3. 源码坐标写成「仓库别名:仓内相对路径:行号」，例如 `fission:src/main/java/Foo.java:42`。不要写本机绝对路径。',
      '',
      '## 输出',
      isBrainstorm ? '按下面的结构整理与题目相关的资料（设定、人物、已有情节或已有实现都算）：' : '按下面的结构整理：',
      auto ? '**涉及的仓库**（别名，以及为什么判断它相关）' : null,
      '**一句话现状**',
      '**相关位置**（入口、核心类或函数、配置；每条一个坐标加一句话作用）',
      isBrainstorm ? '**已有设定和约束**' : '**关键流程**（按调用顺序，每一跳带坐标；写清读写了哪些表、缓存、消息和外部接口）',
      '**关键代码片段**（最多 5 段，每段不超过 30 行，放在代码块里，代码块前写坐标）',
      isBrainstorm ? null : '**现有约束**（配置开关、事务、幂等、并发、兼容性、已知的特殊处理）',
      '**需要人确认的问题**（代码里看不出来的）',
      '',
      `全文控制在 ${maxChars} 字以内。只输出资料本身，不要写开场白和查找过程。`,
    ].filter((l) => l !== null).join('\n'),
  );
}

function join(...parts) {
  return parts.filter(Boolean).join('\n\n');
}

// ---------- 讨论中的代码核实 ----------

export const FACT_HEADING = '待核实的事实';
const FACT_HEADING_RE = /^\**\s*待核实的事实\s*\**\s*[:：]?\s*\**\s*(?:[（(][^）)]*[）)])?\s*$/;

/**
 * 从发言里取出「**待核实的事实**」一节的问题：标题之后连续的列表项，遇到空行后的非列表内容或其他段落就结束。
 * 写「无」时返回空。
 */
export function parseFactQuestions(text) {
  const out = [];
  let inside = false;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (FACT_HEADING_RE.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (!line) continue;
    const item = /^(?:[-*•]\s+|\d+(?:[.)]\s+|[、）]\s*))(.+)$/.exec(line);
    if (!item) {
      inside = false;
      continue;
    }
    const q = item[1].trim();
    if (!/^(无|没有|暂无)[。.]?$/.test(q)) out.push(q);
  }
  return out;
}

const dirLines = (repos = [], docs = []) => [
  ...repos.map((r) => `- ${r.alias}：\`${r.readPath}\``),
  ...docs.map((d) => `- 参考资料：\`${d}\``),
];

/** 主笔可以自己查代码时的说明：每次运行第一次给完整目录，之后只提醒一句。 */
export function codeAccessNote({ repos, docs, tools = ['Read', 'Grep', 'Glob'], full = true }) {
  const names = tools.join('、');
  if (!full) return `**你可以查代码**：和前面一样，可以用 ${names} 只读查看代码目录，对代码事实没把握时先查清再下结论。`;
  return [
    `**你可以查代码**：这场讨论里你可以用 ${names} 只读查看下面的目录。背景资料没写到、或者你对某个代码事实没把握时，先自己查清再下结论，引用时写「仓库别名:仓内相对路径:行号」。只查和当前问题相关的代码，不要通读。`,
    ...dirLines(repos, docs),
  ].join('\n');
}

/** 请参与者把没查清、又影响结论的代码事实列出来，交给调研员在下一轮开始前核实。 */
export function factAskLine() {
  return `**代码核实**：如果有会影响结论、但背景资料里没写清、你也没能自己查清的代码事实，在发言末尾（有评审结论的写在评审结论之前）单独写一节「**${FACT_HEADING}**」，下面每行一个能用代码回答的具体问题，例如「SP 的 stack_strategy 对同一 promotion_type 的多条规则是叠加还是只取一条？」。调研员会查代码回答，结果发给所有人。没有就不写这一节；已经核实过的不要重复问。`;
}

/** 核实结果：给参与者时只给新的（会话模式），给主席时给全部。 */
export function factsBlock(facts, { forChair = false } = {}) {
  if (!facts?.length) return '';
  const head = forChair
    ? '## 讨论中的代码核实结果（调研员查代码得出；方案或背景资料和它冲突时以它为准，汇总里要指出冲突）'
    : '## 代码核实结果（调研员刚查代码得出；和背景资料或之前的判断冲突时以这里为准，受影响的结论要改）';
  return [head, ...facts.map((f) => `### 第 ${f.round} 轮核实\n**问题**\n${f.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n**结果**\n${f.answer}`)].join('\n\n');
}

/** 调研员在讨论中途回答待核实的问题。系统提示词沿用讨论的共享提示词（有议题和背景资料）。 */
export function factCheckPrompt({ round, questions, repos, docs = [], tools = ['Read', 'Grep', 'Glob'], maxChars = 4000 }) {
  return join(
    `【阶段：第 ${round} 轮${STAGE_LABELS.factcheck}】`,
    [
      '你是「调研员」。讨论参与者在讨论中提出了下面这些需要用代码核实的问题，他们会以你的回答为准修改方案。',
      `你只能用 ${tools.join('、')} 只读查看下面的目录：`,
      ...dirLines(repos, docs),
    ].join('\n'),
    `## 待核实的问题\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
    [
      '## 要求',
      '- 逐条回答，编号和问题一致。每条先写结论（是 / 否 / 具体的值或行为），再写依据，依据带源码坐标「仓库别名:仓内相对路径:行号」。',
      '- 讲清实际行为和适用条件，不要只复述字段名或常量。',
      '- 结论和背景资料不一致或比它更完整时，明确写「背景资料有误：……」或「背景资料不完整：……」。',
      '- 代码里确实找不到的写「代码里找不到」，并说明查了哪里；不要推测。',
      '- 不是代码能回答的问题（业务决策、线上数据、其他团队的计划）写「代码回答不了」。',
      `- 不要提建议，不要评价方案。全文不超过 ${maxChars} 字，只输出回答本身。`,
    ].join('\n'),
  );
}

/** entries: [{ tag: '方案 A' | '评审 1', text }]；没有 tag 时按「方案 + label」显示 */
function labeled(entries) {
  return entries.map((e) => `### ${e.tag ?? `方案 ${e.label}`}\n${e.text}`).join('\n\n');
}

// ---------- decision ----------

/** 会话模式第一轮告诉主笔自己的匿名代号，之后各轮别人会用它指代。 */
function ownTagLine(ownTag) {
  return ownTag ? `你的代号是「${ownTag}」，之后各轮别人会用这个代号指代你的方案。` : '';
}

/** 会话模式下自己上一版已经在本会话里，不再重复贴。 */
function ownBlock(title, own, convo) {
  const tag = own.tag ?? `方案 ${own.label}`;
  return convo
    ? `## ${title}\n就是你在本会话中上一次的回答（代号${tag}），这里不再重复。`
    : `## ${title}（你的代号是${tag}）\n${own.plan ?? own.text}`;
}

/** 会话模式下评审先跟进自己上一轮的意见。 */
function followUpLines(convo, round, kind = '意见') {
  if (!convo || round <= 2) return [];
  return [
    `你上一轮的${kind}就在本会话里：已解决或被合理反驳的不要再写；仍未解决的直接列在下面，句末标「（上轮未解决）」。`,
    '',
  ];
}

export function proposePrompt({ topic, interjections, context, ownTag, mode, subject, limits = limitsFor(mode) }) {
  const cap = limits ? `全文不超过 ${limits.propose} 字。` : '';
  if (mode === 'refine') {
    const label = subjectLabel(subject);
    return join(
      `【阶段：${STAGE_LABELS.diagnose}】`,
      ownTagLine(ownTag),
      interjectionBlock(interjections),
      [
        `请独立诊断这份${label}，给出你的修改方案，按下面的结构。${cap}`,
        briefLine('最大的短板是什么、你打算怎么改'),
        '**主要问题**（按严重程度排序，最多 5 条；每条一句话写清问题在哪、为什么会让读者弃书或让长篇写不下去）',
        '**具体修改**（逐条写改哪里、改成什么，尽量给出能直接用的文字；不改的地方不用列）',
        '**要保留的长处**（一两条）',
        '**需要作者决定的**（有几种改法、取决于作者偏好的地方；没有就不写）',
      ].join('\n'),
    );
  }
  return join(
    `【阶段：${STAGE_LABELS.propose}】`,
    ownTagLine(ownTag),
    interjectionBlock(interjections),
    [
      `请独立给出你的方案，按下面的结构。${cap}`,
      briefLine('你的结论和最关键的前提'),
      '**方案要点**（每条一句话）',
      '**关键权衡**（选择了什么、放弃了什么）',
      '**主要风险**（最多 3 条）',
      '**需要确认的问题**（没有就不写）',
    ].join('\n'),
  );
}

// ---------- 评审结论：自动轮数时用来判断要不要继续 ----------

const VERDICT_LINE = '评审结论';
export const VERDICT_CONTINUE = '继续讨论';
export const VERDICT_DONE = '没有意见了';

/** 要求评审在最后单独一行给出结论。graded：问题分了阻断 / 建议两级，只有阻断级才继续。 */
export function verdictInstruction(round, mode, { graded = false } = {}) {
  const matters = mode === 'refine' ? '明显影响作品质量（读者会不会追、长篇写不写得下去）' : '影响方案取舍、正确性或落地';
  return [
    '',
    `最后单独一行写结论，只能二选一：「${VERDICT_LINE}：${VERDICT_CONTINUE}」或「${VERDICT_LINE}：${VERDICT_DONE}」。`,
    graded
      ? `只有还存在【阻断】级问题时才写「${VERDICT_CONTINUE}」；只剩【建议】级、措辞或细节时写「${VERDICT_DONE}」（没有【阻断】却写继续，会按没有意见处理）。`
      : `只要还有会${matters}的问题没解决，就写「${VERDICT_CONTINUE}」；只剩措辞、细枝末节或你已经提过且被合理回应的点，才写「${VERDICT_DONE}」。`,
    round > 2 ? '已经被主笔采纳或合理反驳的意见不要重复提。' : '',
  ].filter((l) => l !== '').join('\n');
}

/** 解析评审结论：'done' | 'continue' | null（没写结论）。取最后一次出现的。 */
export function parseVerdict(text) {
  const all = [...String(text ?? '').matchAll(/评审结论\**\s*[:：]\s*\**\s*(没有意见了?|无意见|继续讨论|继续|还有意见)/g)];
  const last = all.at(-1)?.[1];
  if (!last) return null;
  return /没有意见|无意见/.test(last) ? 'done' : 'continue';
}

/** 没有评审时，看主笔的「立场变化」：都写「无」就算收敛。 */
export function parseStanceChange(text) {
  const m = /立场变化\**[^\n]{0,4}\n?\s*[（(【]?\s*\**(无|小幅|较大)/.exec(String(text ?? ''));
  return m?.[1] ?? null;
}

/** 其他人看到的方案：有完整方案时给完整方案，再附上这一轮的修订说明。 */
function planned(entries) {
  return entries.map((e) => {
    const tag = e.tag ?? `方案 ${e.label}`;
    return e.plan ? `### ${tag}\n${e.plan}\n\n**${tag} 这一轮的修订说明**\n${e.text}` : `### ${tag}\n${e.text}`;
  }).join('\n\n');
}

/**
 * 评审互见：上一轮其他评审提的【阻断】原文。只贴那几行，不贴整段意见；
 * 评审只对不同意的、或能补充证据的条目表态，同意的不用重复。
 */
export function peersBlock(peers = []) {
  if (!peers.length) return '';
  return [
    '## 上一轮其他评审提的阻断（原文，匿名）',
    ...peers.map((x) => `### ${x.tag}\n${x.lines.join('\n')}`),
    '',
    '对这些阻断，你只需对不同意的、或能补充证据的条目表态，每条一行：「对评审 N 的『……』：不同意 / 补充：理由或证据」。同意的不用重复，也不用逐条回应。主笔对这些阻断的回应在方案的修订说明里。',
  ].join('\n');
}

/** 评审：不出自己的方案，只给主笔的方案挑问题，并分级。 */
export function critiquePrompt({ topic, round, proposals, peers = [], interjections, context, askVerdict = false, convo = false, mode, limits = limitsFor(mode), scope }) {
  const refine = mode === 'refine';
  return join(
    `【阶段：第 ${round} 轮${STAGE_LABELS.critique}】`,
    scopeBlock(scope, { once: convo }),
    `## 待评审的${refine ? '修改' : ''}方案（匿名）\n${planned(proposals)}`,
    peersBlock(peers),
    interjectionBlock(interjections),
    [
      ...followUpLines(convo, round),
      refine
        ? '你是评审，不要提出自己的修改方案，只指出上面每个修改方案的问题（改错了、改过头、没改到根上，或者漏掉了更要紧的短板），引用方案代号。'
        : '你是评审，不要提出自己的方案，只指出上面每个方案的问题，引用方案代号。',
      `只写会${refine ? '影响作品质量' : '改变结论、导致做不成或出错'}的问题；措辞、细节、锦上添花不写，不要复述方案内容，不要写优点。`,
      '每个问题标级别：',
      `- 【阻断】不解决的话${refine ? '这版修改就不该采用' : '方案不成立、会出错或无法落地'}`,
      '- 【建议】改了更好，不改也行（最多 2 条）',
      `按下面的结构${limits ? `，全文不超过 ${limits.critique} 字` : ''}：`,
      briefLine('还有几条阻断级问题、最要紧的是哪条'),
      '然后按方案代号分组，每个问题一行：「【阻断】问题 → 后果 → 怎么改」。没有新问题的方案写「无新问题」。',
      askVerdict ? verdictInstruction(round, mode, { graded: true }) : '',
    ].filter(Boolean).join('\n'),
  );
}

export function reviewPrompt({ topic, round, own, others, critiques = [], interjections, context, convo = false, mode, limits = limitsFor(mode) }) {
  const hasOthers = others.length > 0;
  const plan = mode === 'refine' ? '修改方案' : '方案';
  return join(
    `【阶段：第 ${round} 轮${STAGE_LABELS.review}】`,
    ownBlock('你上一轮的方案', own, convo),
    hasOthers ? `## 其他主笔目前的方案（匿名）\n${planned(others)}` : '',
    critiques.length ? `## 评审意见（匿名，针对所有方案）\n${labeled(critiques)}` : '',
    interjectionBlock(interjections),
    [
      '你的回答分两部分。',
      `第一部分发到${mode === 'refine' ? '页面上给作者' : '群里给人'}看，只写这一轮的变化，不要复述整个${plan}，也不要复述评审意见和别人的方案${limits ? `，不超过 ${limits.review} 字` : ''}：`,
      briefLine(`你现在的结论，以及这一轮改了什么（没改就说为什么坚持）`),
      '**改了什么**（每条一行：「原来… → 现在… · 原因」；没改写「无变化」）',
      critiques.length ? '**对评审意见的回应**（只回应【阻断】级问题和你不采纳的意见，每条一行：「采纳」或「不采纳：理由」）' : '',
      hasOthers ? '**对其他方案的看法**（只写会影响结论的分歧或值得借鉴的地方，一两行，引用方案代号；没有就不写）' : '',
      '**立场变化**（无 / 小幅 / 较大，一句话说明）',
      '',
      `第二部分不发到${mode === 'refine' ? '页面' : '群里'}，只给其他参与者和主席看：单独一行写「${PLAN_MARKER}」，下面写修订后的完整${plan}（结构同第 1 轮，${mode === 'refine' ? '完整写出，不要只写这一轮的变化，' : ''}${limits ? `不超过 ${limits.plan} 字` : ''}）。`,
    ].filter((l) => l !== '').join('\n'),
  );
}

/** 主笔的最终方案：讨论记录里修订轮只有变化，完整方案在这里。 */
function finalsBlock(finals, title = '各主笔的最终方案') {
  if (!finals?.some((e) => e.plan)) return '';
  return `## ${title}（匿名，讨论记录里的修订轮只写了变化，完整方案以这里为准）\n${finals.map((e) => `### ${e.tag ?? `方案 ${e.label}`}\n${e.plan ?? e.text}`).join('\n\n')}`;
}

/** 主席输入按预算缩略或省略了较早的讨论记录、核实结果时的说明。 */
function omittedBlock(omitted) {
  return omitted ? `## 篇幅说明\n${omitted}` : '';
}

/** 本场没有读代码：涉及代码现状的说法都是参与者的推测。 */
function noCodeBlock(noCode) {
  return noCode ? '## 代码上下文\n本场无代码：讨论前没有读代码，讨论中也没有核实代码事实。参与者关于代码现状的说法都是推测，主文档里涉及代码现状的结论要标为「未核实」，并在开头注明「本场无代码」。' : '';
}

/** 告诉主席讨论是怎么结束的。 */
function endingBlock(ending) {
  if (!ending) return '';
  if (ending.reason === 'converged') return `## 讨论如何结束\n第 ${ending.round} 轮${ending.byReviewers ? '所有评审都表示没有新意见' : '所有主笔的立场都不再变化'}，讨论提前结束。`;
  if (ending.reason === 'max') return `## 讨论如何结束\n已经达到上限 ${ending.round} 轮，${ending.byReviewers ? '评审仍有意见' : '主笔的立场仍在变化'}，讨论被强制结束。请把仍未解决的问题列清楚，说明还卡在哪里。`;
  return '';
}

// ---------- refine：修订版 ----------

export function rewriteSystem() {
  return [
    '你是「主编」，负责把一场作品打磨讨论的结论落实成完整的修订版，交给作者确认。',
    '只做讨论里定下来的修改，没提到的部分原样保留，不要顺手改写。',
  ].join('\n');
}

export function rewritePrompt({ subject, summary, followUp, error }) {
  return join(
    `【阶段：${STAGE_LABELS.rewrite}】`,
    `## 讨论形成的修改说明（主文档）\n${summary}`,
    followUp ? `## 之后作者追问、重新讨论得出的结论（和上面冲突时以这里为准）\n${followUp}` : '',
    [
      '## 修订版的格式',
      `按下面的 JSON Schema 写出完整的修订版${subjectLabel(subject)}（和「现在的版本」同一份内容的结构化形式）：`,
      '```json',
      JSON.stringify(subject.fieldsSchema),
      '```',
      ...(subject.rules ?? []).map((r) => `- ${r}`),
    ].join('\n'),
    [
      '## 要求',
      '- 「修改方案」里的修改全部改进去。',
      '- 「分歧与需要作者拍板的问题」：文档里有倾向的按倾向改，没有倾向的保持原样。',
      '- 讨论没提到的部分原样保留，一个字都不要动。',
      '- 只输出一个 ```json 代码块，不要写别的文字。',
    ].join('\n'),
    error ? `## 上一次的输出有问题，请改正后重新输出\n${error}` : '',
  );
}

/**
 * 从主编的回答里取出修订版 JSON，并按原来的字段对齐：缺的字段用原值补上，多出来的字段丢掉，类型不对的报错。
 * 返回 { fields, changed: [字段名] }。
 */
export function parseRevision(text, original) {
  const raw = String(text ?? '');
  const block = [...raw.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].at(-1)?.[1]
    ?? raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch (err) {
    throw new Error(`修订版不是合法的 JSON：${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('修订版应该是一个 JSON 对象');
  const fields = {};
  const changed = [];
  for (const [key, before] of Object.entries(original)) {
    const after = key in parsed ? parsed[key] : before;
    const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
    if (before !== null && after !== null && kind(before) !== kind(after)) {
      throw new Error(`修订版的 ${key} 应该是 ${kind(before)}，实际是 ${kind(after)}`);
    }
    fields[key] = after;
    if (JSON.stringify(after) !== JSON.stringify(before)) changed.push(key);
  }
  return { fields, changed };
}

// ---------- brainstorm ----------

export function divergePrompt({ topic, ideasPerAgent, interjections, context, ownTag }) {
  return join(
    `【阶段：${STAGE_LABELS.diverge}】`,
    ownTagLine(ownTag),
    interjectionBlock(interjections),
    [
      `请从你的视角独立给出 ${ideasPerAgent} 个脑洞，彼此差异要大，不要只是同一个点子的变体。`,
      '每个脑洞按下面写，并编号（1、2、3……）：',
      '**一句话钩子**',
      '展开（3 到 5 句）',
      '**最抓人的点**',
    ].join('\n'),
  );
}

export function feedbackPrompt({ topic, round, others, interjections, context, askVerdict = false, convo = false, scope }) {
  return join(
    `【阶段：第 ${round} 轮${STAGE_LABELS.feedback}】`,
    scopeBlock(scope, { once: convo }),
    `## 待评的脑洞（匿名）\n${labeled(others)}`,
    interjectionBlock(interjections),
    [
      ...followUpLines(convo, round),
      '只给意见，不要改写、合并或替别人重写脑洞。',
      '对每个方案里的每个脑洞（用「方案代号 + 编号」指代）写：',
      '**亮点**、**问题**、**可以更大胆的方向**（一句话）',
      askVerdict ? verdictInstruction(round).replace('影响方案取舍、正确性或落地', '明显提升这些脑洞') : '',
    ].filter(Boolean).join('\n'),
  );
}

export function revisePrompt({ topic, round, own, feedback, ideasPerAgent, interjections, context, convo = false }) {
  const fb = feedback.map((f, i) => `### 意见 ${i + 1}\n${f}`).join('\n\n');
  return join(
    `【阶段：第 ${round} 轮${STAGE_LABELS.revise}】`,
    ownBlock('你上一版的脑洞', own, convo),
    `## 别人给你的意见（匿名）\n${fb || '（这一轮没有收到意见）'}`,
    interjectionBlock(interjections),
    [
      '按你自己的视角修订脑洞：意见可以采纳、部分采纳或拒绝（拒绝要说明理由）。',
      '保持你的风格，不要向别人的点子靠拢。可以删掉弱的、补新的。',
      `修订后仍给出 ${ideasPerAgent} 个，结构和编号与上一版一致。`,
    ].join('\n'),
  );
}

// ---------- 追问（讨论结束后） ----------
//
// 主席先判断：追问只是澄清、解释或查找讨论里已有的内容，就直接回答；
// 追问带来新约束、新信息，或者质疑结论、要求改方案，就重新发起讨论：
// 主笔在各自的会话里回应追问并修订，评审照常提意见，直到评审没有新意见。

export const TRIAGE_ANSWER = '直接回答';
export const TRIAGE_DISCUSS = '重新讨论';

function followUpHistory(followUps = []) {
  if (!followUps.length) return '';
  return `## 之前的追问\n${followUps.map((f, i) => `### 追问 ${i + 1}：${f.question}\n${f.handling === 'discuss' ? '（重新讨论过）' : ''}\n${f.answer ?? ''}`).join('\n\n')}`;
}

export function triagePrompt({ rounds, finals, summary, question, followUps, isDoc = false, omitted = '' }) {
  const history = rounds
    .map((r) => `### 第 ${r.round} 轮（${STAGE_LABELS[r.stage]}）\n\n${labeled(r.entries).replace(/^### /gm, '#### ')}`)
    .join('\n\n');
  return join(
    `【阶段：${STAGE_LABELS.triage}】`,
    omittedBlock(omitted),
    history ? `## 讨论记录（匿名）\n${history}` : '',
    finalsBlock(finals, '各主笔目前的方案'),
    summary ? `## ${isDoc ? '现在的主文档（讨论结论，之前追问的结论已经合进去）' : '你上次的汇总'}\n${summary}` : '',
    followUpHistory(followUps),
    `## 人类的追问\n${question.trim()}`,
    [
      '先判断怎么处理这个追问，第一行只能写下面二选一：',
      `「处理方式：${TRIAGE_ANSWER}」：追问是澄清、解释、找出讨论里已经有的内容，或者讨论记录足以回答。`,
      `「处理方式：${TRIAGE_DISCUSS}」：追问带来了新的约束或信息、质疑了结论、要求换方向，或者讨论里没覆盖、需要参与者重新权衡。`,
      '',
      `写「${TRIAGE_ANSWER}」时，接着直接回答，引用方案代号和轮次。`,
      `写「${TRIAGE_DISCUSS}」时，接着写 **给参与者的说明**：追问改变了什么、要重点重新考虑哪些地方（不要自己给答案），以及一句 **为什么需要重新讨论**。`,
    ].join('\n'),
  );
}

/** 解析主席的处理方式：'discuss' | 'answer'（没写时按直接回答）。 */
export function parseTriage(text) {
  const m = /处理方式\**\s*[:：]\s*\**\s*(直接回答|重新讨论)/.exec(String(text ?? ''));
  return m?.[1] === TRIAGE_DISCUSS ? 'discuss' : 'answer';
}

/** 去掉第一行的「处理方式：…」，留下给人看的正文。 */
export function stripTriageLine(text) {
  return String(text ?? '').replace(/^\s*\**处理方式\**\s*[:：][^\n]*\n?/, '').trim();
}

/** 主笔回应追问：在自己的会话里接着聊，所以只发新内容。 */
export function followUpPrompt({ mode, round, question, brief, others, interjections, ideasPerAgent = 3, limits = limitsFor(mode) }) {
  const isBrainstorm = mode === 'brainstorm';
  const plan = mode === 'refine' ? '修改方案' : '方案';
  return join(
    `【阶段：第 ${round} 轮${STAGE_LABELS.followup}】`,
    `## 人类的追问\n${question.trim()}`,
    brief ? `## 主席的说明\n${brief}` : '',
    others?.length ? `## 其他主笔目前的${isBrainstorm ? '脑洞' : '方案'}（匿名）\n${planned(others)}` : '',
    interjectionBlock(interjections),
    isBrainstorm
      ? [
        '讨论已经结束过一次，现在人类追问了上面的问题。你之前的脑洞和讨论都在本会话里。',
        '结合追问重新审视你的脑洞：需要改就改，不需要改要说明理由。',
        '按下面的结构：',
        '**对追问的回应**',
        `**修订后的脑洞**（仍给出 ${ideasPerAgent} 个，编号与之前一致）`,
        '**立场变化**（无 / 小幅 / 较大，一句话说明）',
      ].join('\n')
      : [
        `讨论已经结束过一次，现在人类追问了上面的问题。你之前的${plan}和讨论都在本会话里。结合追问重新审视：需要改就改，不需要改要说明理由。`,
        '你的回答分两部分。',
        `第一部分发给人看，只写对追问的回应和这一轮的变化，不要复述整个${plan}${limits ? `，不超过 ${limits.followup} 字` : ''}：`,
        briefLine('你对追问的回答，以及方案因此改了什么'),
        '**对追问的回应**（直接回答，不复述问题）',
        '**改了什么**（每条一行：「原来… → 现在… · 原因」；没改写「无变化」）',
        '**立场变化**（无 / 小幅 / 较大，一句话说明）',
        '',
        `第二部分不发给人，只给其他参与者和主席看：单独一行写「${PLAN_MARKER}」，下面写修订后的完整${plan}${limits ? `（不超过 ${limits.plan} 字）` : ''}。`,
      ].join('\n'),
  );
}


// ---------- 主文档 ----------
//
// 每场讨论维护一份主文档，替代原来的汇总：讨论结束时主席写初稿，主笔对照讨论核对，主席按意见修改后定稿；
// 之后每次追问都改这同一份文档（留历史版本），不另写一份。
// 主文档要让没看过讨论的人读懂：有什么问题、怎么解决、还有什么没定。某一点需要大段细节时写成附录，
// 主文档里保留这一点的结论并注明见附录，删掉附录也能独立读懂。

export const DOC_MARK = { note: '【说明】', doc: '【主文档】', unchanged: '【无需修改】' };
// 标记单独一行；模型偶尔把内容接在标记后面同一行，也认
const DOC_LINE = /^[ \t]*\**[ \t]*【(说明|主文档|无需修改|附录[:：][ \t]*([^】\n]+?))】[ \t]*\**[ \t]*[:：]?[ \t]*(.*)$/;
const DELETED = /^[（(]\s*删除\s*[)）]$/;

/** 各模式主文档的结构。 */
const DOC_OUTLINE = {
  decision: [
    '# 标题（一句话说清讨论的是什么问题）',
    '**一句话结论**：……',
    '## 要点（3–5 条，人只看这里就能知道结论和要拍板的事）',
    '## 问题（背景、现状、为什么要解决、约束条件；关键数据和已核实的代码事实写在这里）',
    '## 方案（讨论达成一致的做法：怎么做、关键设计、落地步骤、前提假设）',
    '## 考虑过但没采用的做法（每个一两句：是什么、为什么不选）',
    '## 分歧与需要拍板的问题（没有达成一致的点：各方立场和理由、可选项和各自的代价；没有就写「无」）',
    '## 风险与未核实的前提',
    '## 下一步',
    '## 变更记录（每个版本一行）',
  ],
  brainstorm: [
    '# 标题（题目是什么）',
    '**一句话结论**：最值得写的是哪个脑洞、为什么',
    '## 要点（3–5 条）',
    '## 题目与要求',
    '## 最值得写的脑洞（3 个左右，每个都写完整：核心设定、主角与冲突、钩子和卖点、为什么值得写；不能只写编号）',
    '## 可以组合的点子（组合后是什么样子）',
    '## 被低估的点子',
    '## 放弃的方向（每个一句话：是什么、为什么放弃）',
    '## 下一步',
    '## 变更记录（每个版本一行）',
  ],
  refine: [
    '# 标题（打磨的是哪一份、改成什么样）',
    '**一句话结论**：最该改的是什么、改完会好在哪里',
    '## 要点（3–5 条）',
    '## 原稿的问题（按重要程度排序）',
    '## 修改方案（逐条写清改哪里、改成什么、为什么，作者可以照着改）',
    '## 保留不改的地方（以及为什么不改）',
    '## 分歧与需要作者拍板的问题（各方的改法与理由、你倾向哪一种；没有就写「无」）',
    '## 变更记录（每个版本一行）',
  ],
};

/** 写文档的规则：初稿、追问后更新、按核对意见修改共用。 */
function docRules(mode) {
  return [
    '## 写法',
    '- 读者没有看过讨论过程，也不知道「方案 A」「评审 1」这些代号和轮次：文中不要出现代号和轮次，各个做法用内容本身命名（例如「按供应商分批迁移」）。',
    '- 先结论、后细节。尽量简洁，但影响决策或落地的信息一条都不能丢：关键数据、约束、前提假设、已核实的代码事实（写出处）、被否决做法的理由、没解决的分歧。',
    '- 共识和分歧分清楚：没有达成一致的不要写成定论，也不要替人拍板；没核实的写明「未核实」。',
    mode === 'decision' ? '- 用「方案」写清楚要做什么，不要只列结论：读者照着它就能知道怎么落地。' : '',
    '- 用 Markdown：# 标题、列表、加粗、代码块都可以，不要用表格。',
    '- 附录：某一点需要大段细节（完整的接口或字段清单、迁移步骤、数据明细等），放进主文档会影响阅读时，才写成附录。主文档里写出这一点的结论，并注明「详见附录《标题》」；删掉附录，主文档也要能独立读懂。没有必要就不写附录。',
    '',
    '## 主文档的结构',
    ...DOC_OUTLINE[mode],
  ].filter((l) => l !== '').join('\n');
}

function docFormat({ update = false, allowUnchanged = false } = {}) {
  return [
    '## 输出格式',
    '按顺序输出下面几部分，每部分以单独一行的标记开头，标记前后不要写别的文字：',
    `${DOC_MARK.note}`,
    update
      ? '发到讨论里的短消息，3 行以内：追问的结论，以及主文档改了哪些地方。'
      : '发到讨论里的短消息，3 行以内：一句话结论，加上最需要人拍板或注意的一件事。',
    `${DOC_MARK.doc}`,
    '完整的主文档。',
    '【附录：标题】（可选，可以有多个）',
    update
      ? '只输出新增或改动过的附录，没改的不要输出（会原样保留）；要删掉某个附录，内容只写「（删除）」。'
      : '附录的完整内容。',
    allowUnchanged ? `\n如果这次的内容不需要写进主文档（例如只是解释文档里已经写清楚的内容），整个回答只输出一行「${DOC_MARK.unchanged}」。` : '',
  ].filter((l) => l !== '').join('\n');
}

export function docSystem(mode) {
  const who = mode === 'decision' ? '主席' : '主编';
  return [
    `你是「${who}」，负责把一场多 AI ${mode === 'brainstorm' ? '脑洞风暴' : mode === 'refine' ? '作品打磨讨论' : '方案讨论'}的结果整理成一份主文档，给没看过讨论的人读。`,
    '你只看到匿名代号（方案 A、方案 B……，评审 1、评审 2……），不要猜测它们来自哪个模型。',
    mode === 'brainstorm'
      ? '看重新鲜感和可写性，保留不同方向的多样性，不要把所有点子揉成一个。'
      : '保持中立：如实写出共识与分歧，不要自己另起一个新方案，也不要替人拍板。',
    '这份文档会一直维护：之后每次追问的结论都会改进这同一份文档。',
  ].join('\n');
}

function historyBlock(rounds) {
  if (!rounds?.length) return '';
  return `## 讨论记录（匿名）\n${rounds
    .map((r) => `### 第 ${r.round} 轮（${STAGE_LABELS[r.stage] ?? r.stage}）\n\n${labeled(r.entries).replace(/^### /gm, '#### ')}`)
    .join('\n\n')}`;
}

function attachmentsBlock(attachments) {
  const list = Object.entries(attachments ?? {});
  if (!list.length) return '';
  return `## 现有附录\n${list.map(([title, text]) => `### 附录《${title}》\n${text}`).join('\n\n')}`;
}

/**
 * 初稿：讨论结束时写。补写旧讨论时 earlier 带上原来的汇总和追问记录。
 */
export function docPrompt({ mode, rounds, finals, interjections, ending, earlier, noCode = false, omitted = '' }) {
  const hasCritique = rounds?.some((r) => r.stage === 'critique');
  return join(
    `【阶段：${STAGE_LABELS.doc}】`,
    omittedBlock(omitted),
    historyBlock(rounds),
    mode === 'brainstorm'
      ? (finals?.length ? `## 各方最终版脑洞（匿名）\n${labeled(finals)}` : '')
      : finalsBlock(finals, mode === 'refine' ? '各主笔最终的修改方案' : '各主笔的最终方案'),
    earlier ? `## 之前的汇总和追问（按时间先后，后面的结论推翻前面时以后面为准）\n${earlier}` : '',
    endingBlock(ending),
    noCodeBlock(noCode),
    interjectionBlock(interjections),
    hasCritique ? '「方案」是主笔给出的方案，「评审」是评审给出的意见；以主笔的最终方案为准，评审意见用来判断哪些问题已经解决、哪些还没有。' : '',
    '请把这场讨论的结果写成主文档。',
    docRules(mode),
    docFormat(),
  );
}

/**
 * 追问之后更新主文档：直接回答的给回答，重新讨论的给追问之后的讨论记录。
 */
export function docUpdatePrompt({ mode, doc, attachments, version, question, handling, answer, brief, rounds, finals, interjections, ending, noCode = false, omitted = '' }) {
  return join(
    `【阶段：更新${STAGE_LABELS.doc}】`,
    `## 现在的主文档（第 ${version} 版）\n${doc}`,
    attachmentsBlock(attachments),
    `## 人类的追问\n${question.trim()}`,
    handling === 'answer'
      ? `## 你对追问的回答（主席判断讨论记录足以回答，没有重新讨论）\n${answer}`
      : join(
        brief ? `## 你给参与者的说明\n${brief}` : '',
        omittedBlock(omitted),
        historyBlock(rounds).replace('## 讨论记录（匿名）', '## 追问之后的讨论（匿名）'),
        mode === 'brainstorm' ? (finals?.length ? `## 各方最新的脑洞（匿名）\n${labeled(finals)}` : '') : finalsBlock(finals, '各主笔目前的方案'),
        endingBlock(ending),
        noCodeBlock(noCode),
      ),
    interjectionBlock(interjections),
    [
      '## 要求',
      '- 把这次追问得出的结论合进主文档对应的位置，改完的文档要反映现在完整的结论，读者不需要再看追问记录。',
      '- 被推翻的旧结论直接改掉，不要保留后再补一句「后来改了」；被放弃的做法移到「考虑过但没采用」一类的部分，写明原因。',
      '- 没受影响的部分原样保留，不要重新措辞。',
      `- 「变更记录」加一行：「第 ${version + 1} 版（追问：问题的简短概括）：改了什么」。`,
    ].join('\n'),
    docRules(mode),
    docFormat({ update: true, allowUnchanged: handling === 'answer' }),
  );
}

/** 主笔核对主文档：在自己的会话里，对照自己参与过的讨论。 */
export function docCheckPrompt({ doc, attachments, own }) {
  return join(
    `【阶段：${STAGE_LABELS.doccheck}】`,
    `## 主文档\n${doc}`,
    attachmentsBlock(attachments),
    own ? `## 你最后的方案\n${own}` : '',
    [
      '主席根据讨论写了上面这份主文档，给没看过讨论的人读。请对照你参与的讨论核对，只指出重要的问题：',
      '- 漏掉了影响决策或落地的信息（关键约束、数据、已核实的事实、被否决做法的理由、没解决的分歧）；',
      '- 写错了，或者把没有达成一致的写成了定论；',
      '- 读者看不懂的地方（用了代号、缺少前提）。',
      '措辞、格式和次要细节不用提。每条一行，写清应该怎么改，不超过 600 字。',
      '没有重要问题时只写一行「没有问题」。',
    ].join('\n'),
  );
}

/** 核对的结论：没有问题返回 null，否则返回意见原文。 */
export function parseDocCheck(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  return /^\**\s*没有问题\s*\**[。.！!]?\s*$/.test(t.split('\n')[0]) && t.split('\n').filter((l) => l.trim()).length <= 1 ? null : t;
}

/** 主席按核对意见修改：会话模式接着写初稿的那条会话（讨论记录已经在会话里），非会话模式贴上初稿。 */
export function docFixPrompt({ issues, draft }) {
  return join(
    `【阶段：按核对意见修改${STAGE_LABELS.doc}】`,
    draft ? `## 你写的初稿\n${draft}` : '',
    `## 主笔的核对意见（匿名，可能有错）\n${issues.map((x) => `### ${x.tag}\n${x.text}`).join('\n\n')}`,
    [
      '逐条判断：对照讨论记录确实如此的，改进主文档；不成立的忽略。其余部分原样保留。',
      `按同样的格式重新输出：${DOC_MARK.note}仍然写发到讨论里的短消息；${DOC_MARK.doc}写修改后的完整主文档；附录只输出这次新增或改动的，要删掉的写「（删除）」。`,
    ].join('\n'),
  );
}

/**
 * 拆开主席写的文档：{ unchanged, note, doc, attachments }。
 * attachments 是这次输出的附录：{ 标题: 内容 }，内容为 null 表示删除。没写【主文档】标记时整段当作主文档。
 */
export function parseDoc(text) {
  const raw = String(text ?? '').trim();
  const lines = raw.split('\n');
  const parts = [];
  let current = null;
  for (const line of lines) {
    const m = DOC_LINE.exec(line);
    if (m) {
      current = { key: m[2] ? 'attachment' : { 说明: 'note', 主文档: 'doc', 无需修改: 'unchanged' }[m[1]], title: m[2]?.trim(), lines: m[3]?.trim() ? [m[3].trim()] : [] };
      parts.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  const body = (p) => p.lines.join('\n').trim();
  if (parts.some((p) => p.key === 'unchanged') && !parts.some((p) => p.key === 'doc')) return { unchanged: true };
  const docPart = parts.find((p) => p.key === 'doc');
  const doc = docPart ? body(docPart) : raw;
  if (!doc) throw new Error('主文档是空的');
  const attachments = {};
  for (const p of parts.filter((x) => x.key === 'attachment')) {
    const t = body(p);
    attachments[p.title] = DELETED.test(t) || !t ? null : t;
  }
  const notePart = parts.find((p) => p.key === 'note');
  return { unchanged: false, note: notePart ? body(notePart) || null : null, doc, attachments };
}

/** 合并附录：delta 里为 null 的删掉，其余覆盖。 */
export function mergeAttachments(base = {}, delta = {}) {
  const out = { ...base };
  for (const [k, v] of Object.entries(delta)) {
    if (v == null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** 没写说明时，从主文档开头取一句话结论和要点。 */
export function docLead(doc) {
  const lines = String(doc ?? '').split('\n');
  const out = [];
  let headings = 0;
  for (const l of lines) {
    if (/^\s*#{1,6}\s/.test(l)) {
      headings += 1;
      if (headings > 2) break; // 标题、要点之后就停
      continue;
    }
    if (l.trim()) out.push(l);
  }
  return out.join('\n').trim();
}
