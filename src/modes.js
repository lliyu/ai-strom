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
 * brainstorm（脑洞风暴，求发散；只用来给长篇网文想开书的点子）：
 *   从作者给的题目、一句话脑洞或几个关键词出发，第 1 轮各自按固定视角发散 → 每个循环先盲审（只给意见、不改写）再各自修订 → 主编挑选与组合。
 *   不让参与者自由讨论，避免多轮之后观点趋同。
 *
 * refine（作品打磨，从墨稿 novel-idea 取一份脑洞 / 梗概 / 总纲 / 一段章节细纲）：
 *   流程同 decision：主笔诊断并给修改方案 → 评审提意见 → 主笔修订 → 主编写主文档（修改说明）；
 *   最后主编按主文档写出完整修订版（JSON，结构由墨稿给出），作者在 ai-storm 页面上确认后才写回墨稿。
 */

export const SUBJECT_LABELS = { idea: '脑洞', premise: '梗概', outline: '总纲', chapters: '细纲' };

/** 墨稿字段的中文名，修订版说明里用。 */
export const FIELD_LABELS = {
  content: '内容', angle: '创意方向', fromMaterial: '素材延伸', marketRef: '借鉴榜单', coreIdea: '核心创意', identityRole: '原身份的分量',
  title: '书名', logline: '一句话梗概', protagonist: '主角', goal: '目标', obstacle: '阻碍', goldenFinger: '金手指',
  goldenFingerCost: '金手指的边界', goldenFingerGrowth: '金手指的成长', sellingPoint: '卖点', hook: '开篇钩子', differentiation: '差异点',
  arc: '总纲', volumes: '分卷', chapters: '章节细纲',
};
const subjectLabel = (subject) => SUBJECT_LABELS[subject?.type] ?? '作品';
/** 细纲是写正文前的最后一层，审法和脑洞 / 梗概 / 总纲（搭架子）不同。 */
const isChapters = (subjectType) => subjectType === 'chapters';

export const STAGE_LABELS = {
  propose: '独立方案',
  critique: '评审意见',
  review: '互评与修订',
  diverge: '发散',
  feedback: '盲审意见',
  abandon: '放弃脑洞',
  askcheck: '征询判断',
  revise: '修订',
  summary: '汇总',
  research: '代码调研',
  triage: '追问判断',
  answer: '回答追问',
  followup: '回应追问',
  diagnose: '诊断与修改方案',
  rewrite: '修订版',
  factcheck: '代码核实',
  factreview: '核实审查',
  webplan: '资料搜集判断',
  final: '按裁决定稿',
  webresearch: '资料搜集',
  webreview: '资料审查',
  dataplan: '数据核实判断',
  dataresearch: '实时数据初稿',
  datareview: '实时数据审查',
  doc: '主文档',
  doccheck: '核对主文档',
  quickanswer: '回答',
  challenge: '挑刺',
  quickfinal: '快问定稿',
  redraft: '改稿',
  redraftfinal: '改稿定稿',
};

export function participantSystem(p, { maxChars, mode } = {}) {
  const refine = mode === 'refine';
  const capped = Boolean(LIMITS[mode]);
  return [
    mode === 'redraft'
      ? `你是「${p.name}${p.role ? ` · ${p.role}` : ''}」，正在和另一位 AI 一起改一章小说：一位改稿，另一位挑刺，最后由改稿的一方定稿。过程只在作者的网页上显示。`
      : mode === 'quick'
      ? `你是「${p.name}${p.role ? ` · ${p.role}` : ''}」，正在和另一位 AI 一起处理一个人的提问：一位先回答，另一位挑刺，最后由回答的一方定稿。过程只在提问人的网页上显示。`
      : `你是「${p.name}${p.role ? ` · ${p.role}` : ''}」，正在和其他几位 AI 参与一场多人讨论，${refine ? '作者会全程看着讨论过程' : '讨论过程会发到团队群里'}。`,
    p.persona ?? '',
    '规则：',
    '- 独立思考。不要为了和别人保持一致而改变观点；同意或反对都要给出依据。',
    '- 不知道的事实明确说不知道，不要编造数据、接口或配置。',
    refine || mode === 'redraft' ? '- 作品定位是作者定的，不要建议换题材、换平台；以作者的要求为准。' : '',
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
/** 主笔这一轮没改方案时，【完整方案】下面只写这三个字，程序沿用上一版。 */
export const UNCHANGED_MARK = '无变化';
export function isUnchangedPlan(plan) {
  return /^\s*\**\s*无变化\s*\**\s*[。.]?\s*$/.test(String(plan ?? ''));
}
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
export function compressPrompt({ over, original, limit, items = false }) {
  return join(
    `【压缩重写】你刚才的回答超出了字数上限：${over}。`,
    original ? `## 你刚才的回答\n${original}` : '',
    [
      `请压缩后完整重写一遍：结构、结论和立场都不变，删掉复述、铺垫、举例和次要细节，每条只留一句话。`,
      items ? '保留【阻断】【建议】等级别标记、每条的改法和依据，以及最后的「评审结论」行；依据不计入字数。' : '',
      `要点不超过 3 行${limit.brief ? `、${limit.brief} 字` : ''}，给人看的部分不超过 ${limit.max} 字${limit.plan ? `，「${PLAN_MARKER}」之后的完整方案不超过 ${limit.plan} 字` : ''}。`,
      '只输出重写后的全文，不要解释。',
    ].filter(Boolean).join('\n'),
  );
}

/** 评审是否还提了阻断级问题。 */
export function hasBlocker(text) {
  return /[【\[]\s*阻断\s*[】\]]/.test(String(text ?? ''));
}

/**
 * 一行是不是阻断条目：去掉行首空白、列表符号、序号、加粗后，以【阻断】开头才算。
 * 和 hasBlocker 的差别：hasBlocker 只看一行里有没有【阻断】，会把「本轮没有【阻断】」这类否定句也算成阻断。
 * 网页的阻断统计用这个；流程控制（收敛、熔断）仍用 hasBlocker，误判只会多跑一轮，漏判会提前收敛。
 */
export function isBlockerLine(line) {
  const rest = String(line ?? '').replace(/^(?:\s|[-*+•]\s|\d+[.、)）]\s*|\*\*|__)+/u, '');
  return /^[【\[]\s*阻断\s*[】\]]/.test(rest);
}

// ---------- 条目化发言（配置 items 开关控制）：「【级别】问题 ｜改法：… ｜依据：… ｜影响：…」 ----------
//
// 诊断和评审类发言每个问题写成一行条目；页面读取时用 parseItems 拆开，不落盘。
// 依据不计入字数上限（压缩时最容易被删的就是它）；写入时检查格式，不合格合并重写一次，并防止立场漂移。

/** 条目的级别：评审、修订、代码核实、核对主文档各用各的。 */
export const ITEM_LEVELS = ['阻断', '建议', '改', '采纳', '不采纳', '不同意', '补充', '仍成立', '已解决', '确认', '推翻', '查不到', '漏', '错', '不清'];
/**
 * 问题编号（第三期）：「Q评审号-序号」，例如 Q1-3 是评审 1 整场的第 3 个问题。写在【级别】之后。
 * 【阻断】【建议】上的是这个问题自己的编号；【采纳】【不采纳】【不同意】【补充】【仍成立】【已解决】上的是引用。
 */
const ISSUE_ID = /^(?:\*\*)?\s*(Q(\d+)-(\d+))\b\s*(?:\*\*)?\s*[:：]?\s*/u;
const ITEM_HEAD = new RegExp(`^(?:\\s|[-*+•]\\s|\\d+[.、)）]\\s*|\\*\\*|__)*[【\\[]\\s*(${ITEM_LEVELS.join('|')})\\s*[】\\]]\\s*(?:\\*\\*)?\\s*`, 'u');
/** 标签段：只在「｜」后面紧跟已知标签时才切，正文里别的竖线不切。 */
const ITEM_LABELS = { 改法: 'fix', 解决: 'fix', 怎么改: 'fix', 依据: 'evidence', 影响: 'impact', 后果: 'impact' };
const ITEM_SPLIT = new RegExp(`\\s*[｜|]\\s*(?=(?:${Object.keys(ITEM_LABELS).join('|')})\\s*[:：])`, 'u');
const ITEM_SEGMENT = new RegExp(`^(${Object.keys(ITEM_LABELS).join('|')})\\s*[:：]\\s*([\\s\\S]*)$`, 'u');
const clean = (s) => String(s ?? '').replace(/\*\*/g, '').replace(/[\s；;。]+$/u, '').trim();

/** 依据的类别：code 代码坐标 / verify 某轮核实 / source 资料 / guess 推断。 */
export function evidenceKind(text) {
  const t = clean(text);
  if (!t) return null;
  if (/^推断/.test(t)) return 'guess';
  if (/[\w.@-]+:[^\s:：，,]+:\d+/.test(t)) return 'code';
  if (/第\s*[\d一二三四五六七八九十]+\s*轮[^\n]{0,6}核实/.test(t)) return 'verify';
  return 'source';
}

/**
 * 解析一行条目；不是条目返回 null。
 * 新格式按「｜标签：」切段；没有标签的旧箭头格式（「【阻断】问题 → 后果 → 怎么改」）按位置拆，legacy 为 true。
 */
export function parseItemLine(line) {
  const m = ITEM_HEAD.exec(String(line ?? ''));
  if (!m) return null;
  const level = m[1];
  const [headRaw, ...segs] = String(line).slice(m[0].length).split(ITEM_SPLIT);
  const idm = ISSUE_ID.exec(headRaw.trimStart());
  const item = { level, head: clean(idm ? headRaw.trimStart().slice(idm[0].length) : headRaw), fix: null, evidence: null, impact: null, legacy: false, ...(idm ? { id: idm[1] } : {}) };
  for (const s of segs) {
    const sm = ITEM_SEGMENT.exec(s.trim());
    if (!sm) continue;
    const key = ITEM_LABELS[sm[1]];
    const val = clean(sm[2]);
    if (val) item[key] = item[key] ? `${item[key]}；${val}` : val;
  }
  if (!segs.length && (level === '阻断' || level === '建议')) {
    const parts = item.head.split(/\s*→\s*/u).map((x) => clean(x.replace(/^\s*(?:后果|影响|怎么改|改法|解决)\s*[:：]\s*/u, ''))).filter(Boolean);
    if (parts.length >= 2) {
      item.head = parts[0];
      item.legacy = true;
      if (parts.length >= 3) {
        item.impact = parts[1];
        item.fix = parts.slice(2).join(' → ');
      } else item.fix = parts[1];
    }
  }
  // 核实审查里更正过的条目：级别后面跟「【已更正】」
  if (/^[【\[]\s*已更正\s*[】\]]/.test(item.head)) {
    item.corrected = true;
    item.head = clean(item.head.replace(/^[【\[]\s*已更正\s*[】\]]/, ''));
  }
  if (!item.head && !item.id) return null;
  item.evidenceKind = evidenceKind(item.evidence);
  return item;
}

// ---------- 问题编号与跨轮追踪（第三期，条目化打开的方案讨论和打磨） ----------

/** 评审代号里的序号：「评审 2」→ 2。 */
export const reviewerNoOf = (tag) => Number(/评审\s*(\d+)/.exec(String(tag ?? ''))?.[1]) || null;
const issueOwner = (id) => Number(/^Q(\d+)-/.exec(id)?.[1]);
const issueSeq = (id) => Number(/^Q\d+-(\d+)$/.exec(id)?.[1]);

/** 要点之后、【完整方案】之前的行号范围（编号只写在这一段，和页面解析条目的范围一致）。 */
function bodyRange(lines) {
  let end = lines.findIndex((l) => PLAN_LINE.test(l));
  if (end < 0) end = lines.length;
  let start = 0;
  const at = lines.slice(0, 3).findIndex((l) => BRIEF_HEAD.test(l));
  if (at >= 0) {
    start = at + 1;
    while (start < end && !(BOLD_HEAD.test(lines[start]) || /^\s*#{1,6}\s/.test(lines[start]))) start += 1;
  }
  return [start, end];
}

/**
 * 给一条评审发言的【阻断】【建议】写上编号（发布前由程序做，模型不自己编号）。
 * 评审写了自己的、之前出现过的、这条发言里第一次出现的编号就保留（仍坚持的旧问题）；
 * 别人的、不存在的、重复的编号剥掉，和没写编号的一样按新问题从「已有最大序号 + 1」起分配。
 * own：评审序号；used：这位评审之前发言里出现过的编号。返回 { text, kept, assigned, stripped: [{ id, reason }] }。
 */
export function assignIssueIds(text, { own, used = new Set() }) {
  const lines = String(text ?? '').split('\n');
  const [start, end] = bodyRange(lines);
  let next = Math.max(0, ...[...used].filter((id) => issueOwner(id) === own).map(issueSeq)) + 1;
  const seen = new Set();
  const out = { kept: [], assigned: [], stripped: [] };
  let fence = false;
  for (let i = start; i < end; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const item = parseItemLine(lines[i]);
    if (!item || (item.level !== '阻断' && item.level !== '建议')) continue;
    if (item.id && issueOwner(item.id) === own && used.has(item.id) && !seen.has(item.id)) {
      seen.add(item.id);
      out.kept.push(item.id);
      continue;
    }
    if (item.id) out.stripped.push({ id: item.id, reason: issueOwner(item.id) !== own ? '别人的编号' : seen.has(item.id) ? '重复' : '不存在' });
    const id = `Q${own}-${next}`;
    next += 1;
    const m = ITEM_HEAD.exec(lines[i]);
    const prefix = lines[i].slice(0, m.index + m[0].length).replace(/\s+$/, '');
    let rest = lines[i].slice(m.index + m[0].length).trimStart();
    const idm = ISSUE_ID.exec(rest);
    if (idm) rest = rest.slice(idm[0].length);
    lines[i] = `${prefix}${id} ${rest}`;
    seen.add(id);
    out.assigned.push(id);
  }
  return { text: lines.join('\n'), ...out };
}

/**
 * 按编号把问题串成时间线。speeches：按发生顺序的评审（critique）和主笔修订（review）发言 [{ stage, round, tag, body }]，
 * body 是要点之后的正文。返回 { issues: [...], invalid: [...] }，没有任何编号时 issues 为空。
 * 每个问题：id、owner（评审代号）、level（最近一次的级别）、head、section、raised（首次提出的轮次）、
 * mentions（原评审提到它的轮次）、responses（主笔称采纳 / 不采纳）、stances（其他评审仍成立 / 已解决 / 不同意 / 补充）、
 * status：current（原评审最近一次发言仍在提）/ dropped（原评审之后发言没再提，after 写之前主笔的处理：accepted / rejected / unanswered）。
 * invalid：引用了不存在、或不是原评审自己的编号。
 */
export function trackIssues(speeches) {
  const issues = new Map();
  const invalid = [];
  const critiques = new Map(); // 评审序号 → 发言序号列表
  speeches.forEach((s, n) => {
    const items = parseItems(s.body ?? splitReply(s.text).detail);
    if (s.stage === 'critique') {
      const own = reviewerNoOf(s.tag);
      if (!critiques.has(own)) critiques.set(own, []);
      critiques.get(own).push(n);
      for (const it of items) {
        if (!it.id) continue;
        if (it.level === '阻断' || it.level === '建议') {
          if (issueOwner(it.id) !== own) {
            invalid.push({ id: it.id, round: s.round, tag: s.tag, kind: it.level });
            continue;
          }
          const issue = issues.get(it.id) ?? { id: it.id, owner: s.tag, raised: s.round, mentions: [], responses: [], stances: [] };
          issue.level = it.level;
          issue.head = it.head;
          issue.section = it.section ?? issue.section ?? null;
          issue.mentions.push({ n, round: s.round, level: it.level, head: it.head });
          issues.set(it.id, issue);
        } else if (STANCE_LEVELS.includes(it.level)) {
          if (issues.has(it.id)) issues.get(it.id).stances.push({ n, round: s.round, tag: s.tag, kind: it.level, note: it.evidence ?? it.head ?? null });
          else invalid.push({ id: it.id, round: s.round, tag: s.tag, kind: it.level });
        }
      }
    } else if (s.stage === 'review') {
      for (const it of items) {
        if (!it.id || (it.level !== '采纳' && it.level !== '不采纳')) continue;
        if (issues.has(it.id)) issues.get(it.id).responses.push({ n, round: s.round, tag: s.tag, kind: it.level, note: it.fix ?? it.evidence ?? it.head ?? null });
        else invalid.push({ id: it.id, round: s.round, tag: s.tag, kind: it.level });
      }
    }
  });
  const list = [...issues.values()].map((x) => {
    const last = x.mentions.at(-1);
    const later = (critiques.get(issueOwner(x.id)) ?? []).filter((n) => n > last.n);
    const after = x.responses.filter((r) => r.n > last.n);
    const handled = after.length ? (after.some((r) => r.kind === '不采纳') ? 'rejected' : 'accepted') : 'unanswered';
    const strip = ({ n, ...rest }) => rest;
    return {
      ...x,
      mentions: x.mentions.map(strip),
      responses: x.responses.map(strip),
      stances: x.stances.map(strip),
      lastRound: last.round,
      handled,
      latestResponses: after.map(strip),
      status: later.length ? 'dropped' : 'current',
    };
  });
  return { issues: list, invalid };
}

/** 一段发言里的全部条目：[{ level, head, fix, evidence, impact, evidenceKind, legacy, section }]；section 是所在的加粗小节标题。代码块里的不算。 */
export function parseItems(text) {
  const out = [];
  let section = null;
  let fence = false;
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const item = parseItemLine(line);
    if (item) {
      out.push({ ...item, section });
      continue;
    }
    const head = /^[ \t]*\*\*([^*\n]+)\*\*/.exec(line);
    if (head && !/^\s*[-*+•]\s/.test(line)) section = clean(head[1]).replace(/[（(][^）)]*[）)]$/u, '').replace(/[:：]$/u, '').trim() || null;
    else if (/^\s*#{1,6}\s/.test(line)) section = clean(line.replace(/^\s*#+\s*/, '')) || null;
  }
  return out;
}

/** 去掉依据段（从「｜依据：」到下一个「｜」或行尾），字数统计用：依据不计入上限。 */
export function stripEvidence(text) {
  return String(text ?? '').replace(/[｜|]\s*依据\s*[:：][^｜|\n]*/gu, '');
}

/** 行首阻断行的条数（同一行只算一次）。 */
export function blockerCount(text) {
  return String(text ?? '').split('\n').filter(isBlockerLine).length;
}

/**
 * 写入时检查（只在 items 开关打开时用）：返回不合格项 [{ kind, note }]，合格返回空数组。
 * verdict：要求写评审结论行；stance：主笔要写「立场变化」；blockers：【阻断】要带改法和依据；limit：字数上限（依据不计）。
 */
export function replyIssues(text, { limit = null, verdict = false, stance = false, blockers = false, peers = null } = {}) {
  const issues = [];
  const { shown } = splitReply(text);
  if (verdict && parseVerdict(text) === null) issues.push({ kind: 'verdict', note: `缺最后一行「${VERDICT_LINE}：${VERDICT_CONTINUE} / ${VERDICT_DONE}」` });
  if (blockers) {
    const bad = parseItems(shown).filter((it) => it.level === '阻断' && (!it.fix || !it.evidence));
    for (const it of bad) {
      const miss = [!it.fix && '改法', !it.evidence && '依据'].filter(Boolean).join('和');
      issues.push({ kind: 'blocker', note: `【阻断】「${it.head.slice(0, 30)}${it.head.length > 30 ? '…' : ''}」缺${miss}` });
    }
  }
  if (stance && parseStanceChange(text) === null) issues.push({ kind: 'stance', note: '缺「**立场变化**」（无 / 小幅 / 较大，一句话说明）' });
  if (peers?.length) issues.push(...stanceIssues(text, peers));
  const over = limit ? overLimit(stripEvidence(text), limit) : null;
  if (over) issues.push({ kind: 'over', note: `超出字数上限：${over}（依据不计入）` });
  return issues;
}

/** 不合格时的合并重写：只补缺项或压缩，内容和立场不变。会话模式下原回答已经在会话里。 */
export function fixReplyPrompt({ issues, original, limit }) {
  return join(
    '【补全重写】你刚才的回答有几处不合要求：',
    issues.map((x) => `- ${x.note}`).join('\n'),
    original ? `## 你刚才的回答\n${original}` : '',
    [
      '请完整重写一遍，只补缺项或压缩，内容和立场不变：评审结论不能改，【阻断】的条数和每条的意思不能变，不要新增或删掉问题。',
      issues.some((x) => x.kind === 'peer' || x.kind === 'peer-evidence')
        ? '对其他评审阻断的表态写在单独一行加粗的「**对其他评审的阻断**」下面，每条一行【仍成立】/【已解决】/【不同意】，引用照抄题目里的；【不同意】必须带「｜依据：…」。'
        : '',
      '缺依据又没有实据的，写「依据：推断」。缺改法的，补一句能直接执行的改法。',
      issues.some((x) => x.kind === 'over') && limit
        ? `压缩时删复述、铺垫和举例，保留级别标记、改法和依据（依据不计字数）；要点不超过 3 行${limit.brief ? `、${limit.brief} 字` : ''}，给人看的部分不超过 ${limit.max} 字${limit.plan ? `，「${PLAN_MARKER}」之后的完整方案不超过 ${limit.plan} 字` : ''}。`
        : '',
      '只输出重写后的全文，不要解释。',
    ].filter(Boolean).join('\n'),
  );
}

/**
 * 重写保护：重写后评审结论变了，或者行首阻断变少了，就用第一次的原文。返回 null 表示可以用重写稿，否则返回原因。
 */
export function rewriteDrift(before, after) {
  const v0 = parseVerdict(before);
  const v1 = parseVerdict(after);
  if (v0 !== null && v1 !== v0) return `评审结论从「${v0 === 'done' ? VERDICT_DONE : VERDICT_CONTINUE}」变成了「${v1 === null ? '没写' : v1 === 'done' ? VERDICT_DONE : VERDICT_CONTINUE}」`;
  const b0 = blockerCount(splitReply(before).shown);
  const b1 = blockerCount(splitReply(after).shown);
  if (b1 < b0) return `行首【阻断】从 ${b0} 条变成 ${b1} 条`;
  return null;
}

/** 条目的写法说明，各阶段共用。 */
function itemFormat({ levels, need = '', fix = '改法' }) {
  return [
    `每个问题写成一行条目，格式固定：「- 【级别】问题 ｜${fix}：… ｜依据：… ｜影响：…」。级别只用 ${levels}。`,
    `- 「【级别】问题」必写；后面的段按「${fix}、依据、影响」的顺序，用全角竖线「｜」隔开，没有的段整段省掉，不写「影响：无」。一行一条，不嵌套。`,
    need,
    '- 依据只写四类之一：代码坐标「仓库别名:路径:行号」、「第 N 轮核实第 K 条」、资料（写明是哪条联网资料或实时数据）、「推断」。没有实据就写「依据：推断」，如果这一轮要求列「待核实的事实」，把它也列进去。',
    '- 依据不计入字数上限，不要为了省字删掉依据。',
  ].filter(Boolean).join('\n');
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
      '你是「主编」，负责从一场多 AI 网文脑洞风暴里挑出最值得开书的点子。',
      '你只看到匿名代号（方案 A、方案 B……），不要猜测它们来自哪个模型。',
      '看重新鲜感、读者想不想点开追下去、能不能撑起长篇；保留不同方向的多样性，不要把所有点子揉成一个。',
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
  return `## ${mode === 'brainstorm' ? '题目' : mode === 'quick' ? '问题' : '议题'}\n${topic.trim()}`;
}

/** 新建时贴进「材料」框的内容（章节原文、日志、文档片段……）：单独放，不占议题的字数上限。 */
export const MATERIAL_MAX = 30000;
/** 改稿的「设定与上下文」框：人物、世界观、前情，单独限长。 */
export const SETTING_MAX = 20000;
export function materialBlock(material) {
  const text = String(material ?? '').trim();
  if (!text) return '';
  return `## 提问人提供的材料（只作参考，问题以上面为准）\n${text}`;
}
/** 改稿要求为空时用的说法。 */
export const REDRAFT_DEFAULT_ASK = '（作者没有写具体要求：找出最影响阅读体验的问题来改）';

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
  const lines = items.map((m) => `- ${m.time ? `[${m.time}] ` : ''}${m.sender}${m.answerTo ? `（回答主席的征询：${m.answerTo.questions.join('；')}）` : ''}：${m.text}`);
  return `## 人类主持人的插话（优先级最高，必须回应）\n${lines.join('\n')}`;
}

/**
 * 所有参与者和主席共用的系统提示词：整场讨论里内容不变，放在最前面方便命中缓存。
 * 这里不写任何发言者的身份，身份和本轮任务在消息正文开头。
 */
export function sharedSystem({ mode, topic, context, subject, dataContext, material, memory, setting }) {
  if (mode === 'redraft') {
    return join(
      '这是一次粘贴式改稿：一位 AI 按作者的要求改下面这章，另一位 AI 挑刺，最后由改稿的一方定稿。过程只在作者的网页上显示，不发到群里，结果由作者自己复制回去。你的身份、规则和本次任务写在用户消息开头，以那里为准。',
      `## 作者的要求\n${String(topic ?? '').trim() || REDRAFT_DEFAULT_ASK}`,
      `## 章节原文\n${String(material ?? '').trim()}`,
      String(setting ?? '').trim() ? `## 设定与上下文（人物、世界观、前情；不在这次修改范围内，用来判断改得对不对）\n${String(setting).trim()}` : '',
      memory,
    );
  }
  if (mode === 'quick') {
    return join(
      '这是一次快问：一位 AI 先回答下面的问题，另一位 AI 挑刺，最后由回答的一方定稿成一份短文档给提问人。过程只在提问人的网页上显示，不发到群里。你的身份、规则和本次任务写在用户消息开头，以那里为准。',
      topicBlock(topic, mode),
      materialBlock(material),
      memory,
      contextBlock(context),
    );
  }
  if (mode === 'refine') {
    const label = subjectLabel(subject);
    return join(
      `这是一场多 AI 网文${label}打磨讨论：几位 AI 找出下面这份${label}的不足、讨论怎么改，作者全程看着，最后决定是否采用。你的身份、规则和本轮任务写在用户消息开头，以那里为准。`,
      subjectBlock(subject, topic),
      memory,
    );
  }
  return join(
    `这是一场多 AI ${mode === 'brainstorm' ? '网文脑洞风暴：从作者给的题目或关键词出发，为一部长篇网文想开书的点子' : '方案讨论'}，过程会发到团队群里。你的身份、规则和本轮任务写在用户消息开头，以那里为准。`,
    topicBlock(topic, mode),
    materialBlock(material),
    memory,
    contextBlock(context),
    dataContextBlock(dataContext),
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
  if (context.web) {
    return [
      '## 背景资料（讨论前联网搜集的公开资料，已经调研员逐条审查；每条都注明了来源链接）',
      '本场没有读代码。讨论要以这里的事实为准；资料没覆盖、也不是公开资料能回答的（例如公司内部的系统和数据），写进需要确认的问题，不要猜。',
      '',
      context.text,
    ].join('\n');
  }
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
/** 本场没有代码、但可以联网查证时，参与者怎么提待核实的问题。 */
export function webAskLine() {
  return `**事实核实**：如果有会影响结论、但背景资料里没写清的外部事实（开源软件的行为和限制、公开标准、厂商文档、行业公开数据等），在发言末尾（有评审结论的写在评审结论之前）单独写一节「**${FACT_HEADING}**」，下面每行一个能用公开资料回答的具体问题。核实员会联网查证、调研员审查后发给所有人。公司内部的系统、代码和数据联网查不到，不要问；没有就不写这一节，已经核实过的不要重复问。`;
}

/** 内部信息不外发：搜索关键词只用公开的说法。 */
const NO_INTERNAL = '搜索关键词里不要出现公司内部的系统名、服务名、项目代号、内部数据和人名：这些既搜不到，也不该发给搜索引擎。只用公开的技术名词、开源项目名和行业通用说法。';

/** 开场：主席判断本场要不要联网搜集资料，要的话列出问题和关键词。 */
export function webPlanPrompt({ topic, interjections }) {
  return join(
    `【阶段：${STAGE_LABELS.webplan}】`,
    [
      '你是「主席」。一场多 AI 方案讨论马上开始，本场没有读代码。你先判断：要不要在讨论前联网搜集一些公开资料，给参与者当背景。',
      '只有当结论明显取决于外部事实时才需要搜集，例如开源软件或云服务的行为与限制、公开标准、厂商文档、公开的行业数据。纯粹的取舍、团队内部的事、常识性的问题不需要。',
    ].join('\n'),
    `## 议题\n${String(topic ?? '').trim()}`,
    interjectionBlock(interjections),
    [
      '## 输出格式',
      '第一行只能写「搜集资料：需要」或「搜集资料：不需要」。',
      '写「需要」时，接着写一节「**要查的问题**」，每行一个具体问题（最多 6 个），句末用括号写搜索关键词，例如「- Kafka 单分区的顺序保证在消费者重平衡时是否会被打破？（关键词：Kafka partition ordering rebalance）」。',
      NO_INTERNAL,
      '写「不需要」时，接着用一句话说明原因。不要写别的。',
    ].join('\n'),
  );
}

/** 解析主席的搜集判断：{ need, questions }。没写第一行时按不需要处理。 */
export function parseWebPlan(text) {
  return parsePlan(text, '搜集资料');
}

/** 联网查证的写法，开场搜集和讨论中核实共用。 */
function webRules(maxChars) {
  return [
    '## 要求',
    '- 用 WebSearch 搜索，用 WebFetch 打开原始页面确认。优先官方文档、源码仓库、标准原文和厂商公告，其次是有署名的技术文章；论坛和问答帖只能作旁证。',
    '- 每条事实后面写来源链接；版本相关的写明适用的版本和资料日期。',
    '- 搜不到或资料互相矛盾的写「公开资料查不到」或「资料有冲突：……」，不要推测。属于公司内部信息的写「公开资料回答不了」，不要去搜。',
    `- ${NO_INTERNAL}`,
    `- 不要提建议，不要评价方案。全文不超过 ${maxChars} 字，只输出回答本身。用中文，使用 Markdown 的加粗和列表，不要使用表格和 # 标题。`,
  ].join('\n');
}

/** 联网搜集 / 核实的初稿：核实员（例如 Sonnet）写，调研员审查后才发给参与者。 */
export function webResearchPrompt({ round, topic, questions, who = '核实员', maxChars = 8000, opening = false, draft = true }) {
  const draftNote = draft ? '你写的是初稿：调研员会逐条审查、纠正后，定稿才发给参与者。' : '参与者会直接以你的回答为准。';
  return join(
    `【阶段：${opening ? STAGE_LABELS.webresearch : `第 ${round} 轮${STAGE_LABELS.factcheck}`}】`,
    opening
      ? `你是「${who}」。一场多 AI 方案讨论马上开始，本场没有读代码。主席列出了下面这些需要联网查的问题，请查清后整理成背景资料。${draftNote}`
      : `你是「${who}」。讨论参与者提出了下面这些需要用公开资料核实的问题，他们会以核实结果为准修改方案。${draftNote}`,
    opening ? `## 议题\n${String(topic ?? '').trim()}` : '',
    `## ${opening ? '要查的问题' : '待核实的问题'}\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
    '逐条回答，编号和问题一致。每条先写结论，再写依据和来源链接。',
    webRules(maxChars),
  );
}

/** 联网资料的审查：调研员（Opus）同样能联网，逐条打开来源核对，纠正后输出定稿。 */
export function webReviewPrompt({ round, topic, questions, draft, checker = '核实员', maxChars = 8000, opening = false }) {
  return join(
    `【阶段：${opening ? STAGE_LABELS.webreview : `第 ${round} 轮${STAGE_LABELS.factreview}`}】`,
    `你是「调研员」，这次负责审查。「${checker}」已经联网查过下面的问题，写了初稿。初稿还没有发给讨论参与者：你审查、纠正之后的定稿才会发出去，主笔和评审会以定稿为准，所以每条结论都必须站得住。`,
    opening ? `## 议题\n${String(topic ?? '').trim()}` : '',
    `## ${opening ? '要查的问题' : '待核实的问题'}\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
    `## ${checker}的初稿\n${draft}`,
    [
      '## 审查要求',
      '- 逐条打开初稿引用的来源核对：链接是否存在、内容是否真的支撑结论、版本和日期是否对得上。拿不准的自己再搜一次。',
      '- 有错就改，漏了就补；来源撑不住、你也查不到的结论，改成「公开资料查不到」，不要保留。',
      '- 第一行写审查结论：「**审查**：共 N 条，全部无误」或「**审查**：共 N 条，M 条有更正（第 x、y 条）」。',
      '- 然后写定稿：逐条回答，编号和问题一致，每条先写结论，再写依据和来源链接。更正过的条目在结论前标「【已更正】」，再用一句话说明初稿错在哪里。参与者看不到初稿，定稿要完整独立，不要写「同初稿」。',
    ].join('\n'),
    webRules(maxChars),
  );
}

export function factAskLine() {
  return `**代码核实**：如果有会影响结论、但背景资料里没写清、你也没能自己查清的代码事实，在发言末尾（有评审结论的写在评审结论之前）单独写一节「**${FACT_HEADING}**」，下面每行一个能用代码回答的具体问题，例如「SP 的 stack_strategy 对同一 promotion_type 的多条规则是叠加还是只取一条？」。调研员会查代码回答，结果发给所有人。没有就不写这一节；已经核实过的不要重复问。`;
}

/** 核实结果：给参与者时只给新的（会话模式），给主席时给全部。 */
export function factsBlock(facts, { forChair = false } = {}) {
  if (!facts?.length) return '';
  if (facts.every((f) => f.source === 'web')) {
    const webHead = forChair
      ? '## 讨论中的事实核实结果（联网查证、调研员审查后的定稿；方案和它冲突时以它为准，主文档里要指出冲突）'
      : '## 事实核实结果（联网查证、调研员审查后的定稿；和之前的判断冲突时以这里为准，受影响的结论要改）';
    return [webHead, ...facts.map((f) => `### 第 ${f.round} 轮核实\n**问题**\n${f.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n**结果**\n${f.answer}`)].join('\n\n');
  }
  const withData = facts.some((f) => f.source === 'data' || f.toolCalls);
  const head = withData
    ? (forChair
      ? '## 讨论中的事实核实结果（调研员查代码、实时数据或业务知识得出；方案或背景资料和它冲突时以它为准，汇总里要指出冲突。数据只代表写明的查询条件）'
      : '## 事实核实结果（调研员刚查代码、实时数据或业务知识得出；和背景资料或之前的判断冲突时以这里为准，受影响的结论要改。数据只代表写明的查询条件）')
    : forChair
    ? '## 讨论中的代码核实结果（调研员查代码得出；方案或背景资料和它冲突时以它为准，汇总里要指出冲突）'
    : '## 代码核实结果（调研员刚查代码得出；和背景资料或之前的判断冲突时以这里为准，受影响的结论要改）';
  return [head, ...facts.map((f) => `### 第 ${f.round} 轮核实\n**问题**\n${f.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n**结果**\n${f.answer}`)].join('\n\n');
}

/** 调研员在讨论中途回答待核实的问题。系统提示词沿用讨论的共享提示词（有议题和背景资料）。 */
/** 条目化时代码核实的写法。 */
const FACT_ITEM_RULE = '- 逐条回答，编号和问题一致，每条一行：「1. 【确认】结论 ｜依据：仓库别名:仓内相对路径:行号」。级别只用三种：【确认】问题里的说法或前提成立；【推翻】不成立（结论里写清实际是什么）；【查不到】代码里找不到或代码回答不了（依据写查了哪里）。依据必须是源码坐标，不计入字数。';

export function factCheckPrompt({ round, questions, repos, docs = [], tools = ['Read', 'Grep', 'Glob'], maxChars = 4000, who = '调研员', draft = false, items = false }) {
  return join(
    `【阶段：第 ${round} 轮${STAGE_LABELS.factcheck}】`,
    [
      draft
        ? `你是「${who}」。讨论参与者在讨论中提出了下面这些需要用代码核实的问题。你的回答是初稿：调研员会逐条审查、纠正后，定稿才发给参与者，他们会以定稿为准修改方案。`
        : `你是「${who}」。讨论参与者在讨论中提出了下面这些需要用代码核实的问题，他们会以你的回答为准修改方案。`,
      `你只能用 ${tools.join('、')} 只读查看下面的目录：`,
      ...dirLines(repos, docs),
    ].join('\n'),
    `## 待核实的问题\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
    [
      '## 要求',
      items ? FACT_ITEM_RULE : '- 逐条回答，编号和问题一致。每条先写结论（是 / 否 / 具体的值或行为），再写依据，依据带源码坐标「仓库别名:仓内相对路径:行号」。',
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
        isChapters(subject?.type)
          ? '**主要问题**（按严重程度排序，最多 5 条；每条写清是第几章的哪一栏、为什么会让读者跳读弃书，或者写正文时卡住、和前后对不上）'
          : '**主要问题**（按严重程度排序，最多 5 条；每条一句话写清问题在哪、为什么会让读者弃书或让长篇写不下去）',
        isChapters(subject?.type)
          ? '**具体修改**（逐条写第几章的哪一栏改成什么，尽量给出能直接用的文字；不改的章节不用列。章数和章号不能动，要拆要并写进「需要作者决定的」）'
          : '**具体修改**（逐条写改哪里、改成什么，尽量给出能直接用的文字；不改的地方不用列）',
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
export function verdictInstruction(round, mode, { graded = false, subjectType } = {}) {
  const matters = mode === 'refine'
    ? (isChapters(subjectType) ? '明显影响这几章（读者会不会追下去、能不能照着写正文）' : '明显影响作品质量（读者会不会追、长篇写不写得下去）')
    : '影响方案取舍、正确性或落地';
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
  // 立场写在下一行的列表项里（「**立场变化**\n- 小幅：…」）也认
  const m = /立场变化\**[^\n]{0,4}\n?\s*(?:[-*+•]\s*)?[（(【]?\s*\**(无|小幅|较大)/.exec(String(text ?? ''));
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
 * 评审互见：上一轮其他评审提的【阻断】原文。只贴那几行，不贴整段意见。
 * 每一条都要表态（【仍成立】/【已解决】/【不同意】），不能不管：对照主笔这一轮的方案核对一遍。
 * 引用：有问题编号（条目化 + 问题追踪）的用编号，没有的由程序标成「评审 N 第 K 条」。
 */
export const STANCE_LEVELS = ['仍成立', '已解决', '不同意', '补充'];

/** 别人的阻断逐条展开：[{ tag, line, label（表态时照抄的引用）, key（匹配用）, owner（评审序号）}]。 */
export function peerItems(peers = []) {
  const out = [];
  for (const x of peers) {
    const no = reviewerNoOf(x.tag);
    x.lines.forEach((line, i) => {
      const id = parseItemLine(line)?.id;
      out.push(id
        ? { tag: x.tag, line, label: id, key: id, owner: issueOwner(id) }
        : { tag: x.tag, line, label: `评审 ${no} 第 ${i + 1} 条`, key: `${no}#${i + 1}`, owner: no });
    });
  }
  return out;
}

/** 一段评审发言里对别人阻断的表态：[{ kind, key, owner, evidence }]；引用认不出的不算。 */
export function parseStances(text) {
  const out = [];
  for (const it of parseItems(text)) {
    if (!STANCE_LEVELS.includes(it.level)) continue;
    let key = it.id ?? /\bQ\d+-\d+\b/.exec(it.head)?.[0] ?? null;
    let rest = it.id ? it.head : it.head.replace(/\bQ\d+-\d+\b/, '');
    if (!key) {
      const m = /评审\s*(\d+)\s*第\s*(\d+)\s*条/.exec(it.head);
      if (m) {
        key = `${Number(m[1])}#${Number(m[2])}`;
        rest = it.head.replace(m[0], '');
      }
    }
    if (!key) continue;
    // 没按「｜依据：」写、但引用后面跟了理由的（「【不同意】评审 2 第 1 条：已有开关」），理由也算依据
    rest = clean(rest.replace(/^[\s:：，,—-]+/u, ''));
    out.push({ kind: it.level, key, owner: keyOwner(key), evidence: it.evidence ?? (rest.length >= 4 ? rest : null) });
  }
  return out;
}

const keyOwner = (key) => Number(/^Q(\d+)-/.exec(key)?.[1] ?? /^(\d+)#/.exec(key)?.[1]) || null;

/** 写完后的检查：别人的阻断有没有逐条表态，【不同意】有没有依据。 */
export function stanceIssues(text, items = []) {
  const stances = parseStances(text);
  const answered = new Set(stances.map((x) => x.key));
  const missing = items.filter((x) => !answered.has(x.key));
  const issues = [];
  if (missing.length) issues.push({ kind: 'peer', note: `没有对其他评审的这些阻断表态：${missing.map((x) => x.label).join('、')}（每条一行【仍成立】/【已解决】/【不同意】）`, missing: missing.map((x) => x.label) });
  const bare = stances.filter((x) => x.kind === '不同意' && !x.evidence && items.some((i) => i.key === x.key));
  if (bare.length) issues.push({ kind: 'peer-evidence', note: `【不同意】没写依据：${bare.map((x) => items.find((i) => i.key === x.key).label).join('、')}` });
  return issues;
}

/** 主笔修订里【不采纳】了哪些评审的问题：按问题编号或「评审 N」认，返回评审序号集合。 */
export function rejectedReviewers(text) {
  const out = new Set();
  for (const line of String(text ?? '').split('\n')) {
    if (!/不采纳/.test(line)) continue;
    for (const m of line.matchAll(/\bQ(\d+)-\d+\b/g)) out.add(Number(m[1]));
    for (const m of line.matchAll(/评审\s*((?:\d+\s*[\/、,，和与]?\s*)+)/g)) for (const n of m[1].match(/\d+/g) ?? []) out.add(Number(n));
  }
  return out;
}

export function peersBlock(peers = [], { tracking = false } = {}) {
  const items = peerItems(peers);
  if (!items.length) return '';
  const ex = items[0].label;
  const byTag = new Map();
  for (const x of items) {
    if (!byTag.has(x.tag)) byTag.set(x.tag, []);
    byTag.get(x.tag).push(x.key === x.label ? x.line : `- 〔${x.label}〕${x.line.replace(/^(?:\s|[-*+•]\s|\d+[.、)）]\s*)+/u, '')}`);
  }
  return [
    '## 上一轮其他评审提的阻断（原文，匿名）',
    ...[...byTag].map(([tag, lines]) => `### ${tag}\n${lines.join('\n')}`),
    '',
    `上面每一条都要表态，不能跳过：对照主笔这一轮的方案核对一遍，写在单独一行加粗的「**对其他评审的阻断**」下面，每条一行：`,
    `- 「- 【仍成立】${ex} ｜依据：…」：主笔这一轮还没解决（依据可写可不写，能补充证据就写）`,
    `- 「- 【已解决】${ex}」：主笔这一轮已经解决了`,
    `- 「- 【不同意】${ex} ｜依据：…」：这条本来就不成立，或者不该算阻断；必须写依据`,
    `引用照抄上面的${tracking ? '编号（例如 Q2-1）' : '「评审 N 第 K 条」'}，表态行里不要抄原文的【阻断】标记。表态【仍成立】的不要再当成你自己的【阻断】重复提；评审结论只按你自己的问题写。主笔对这些阻断的回应在方案的修订说明里。`,
  ].join('\n');
}

/**
 * 你提过、还没解决的问题（第三期）：这位评审最近一次发言里仍在提的【阻断】，附上主笔之后怎么处理的。
 * 清单由程序从发布的版本生成：会话里存的是模型的原始回答，没有编号，也可能不是发布的那一版。
 */
export function ownIssuesBlock(issues = []) {
  const handled = (x) => (x.latestResponses?.length
    ? x.latestResponses.map((r) => `${r.tag}${r.kind === '采纳' ? '称采纳' : `不采纳${r.note ? `：${r.note}` : ''}`}`).join('；')
    : '主笔未回应');
  return [
    '## 你提过、还没解决的问题（以这张清单为准，不以会话里的旧发言为准）',
    issues.length ? issues.map((x) => `- ${x.id}【${x.level}】${x.head}${x.section ? `（${x.section}）` : ''} · 主笔：${handled(x)}`).join('\n') : '（没有）',
    '',
    '问题编号由程序写。新问题不要写编号。仍然坚持上面某个问题时，在级别后面写它的原编号，例如「- 【阻断】Q1-3 ……」，改法和依据可以更新；主笔称采纳、你核对后认为确实改好了，就不用再提。不要把其他评审的编号写在你的【阻断】【建议】上。',
  ].join('\n');
}

/**
 * 已经解决的阻断：评审后来写了「没有意见了」，或者人已经裁决过。不要再提，除非认为当时的解决办法本身有问题。
 * 太多时只放最近的几条。
 */
export function resolvedBlock(resolved = []) {
  if (!resolved.length) return '';
  const recent = [...resolved].sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)).slice(0, 8);
  return [
    '## 已经解决的阻断（匿名）',
    ...recent.map((x) => `### ${x.tag} 第 ${x.round} 轮提出（${x.by === 'ruling' ? '人已经裁决过' : `第 ${x.resolvedAt} 轮评审结论：${VERDICT_DONE}`}）\n${x.lines.join('\n')}`),
    ...(resolved.length > recent.length ? [`（更早的 ${resolved.length - recent.length} 条没有列出，同样不要再提）`] : []),
    '',
    '这些阻断不要再提。只有你认为当时的解决办法本身有问题时才能再提：照样标【阻断】，问题开头写「重提」，说明原来的解决办法错在哪里、依据是什么（新的核实结果、代码坐标或资料），不能只重复原来的理由。',
  ].join('\n');
}

/** 评审：不出自己的方案，只给主笔的方案挑问题，并分级。 */
/**
 * 打磨（脑洞 / 梗概 / 总纲 / 细纲）的阻断门槛：这些是在搭架子，后面写作时还会改，
 * 不按能直接开写的细则去审，免得评审逐轮下钻、主笔为堵口子不断加规则。
 */
export const REFINE_BLOCKER_BAR = [
  '这是在搭架子，后面写作时还会改，阻断从宽：',
  '- 具体数值（价格、次数、人数、票数、日期）、某一卷的执行细则、写到那里再定也来得及的参数，最多算【建议】，不标【阻断】。',
  '- 一句话就能补上的小漏洞、只在少数情节里才会碰到的边角情况，最多算【建议】。',
  '- 后期卷只要方向清楚、和前面的设定不冲突就够了，不要求写到能直接执行。',
].join('\n');

/**
 * 细纲的阻断门槛：这是写正文前的最后一层，要能照着直接写，
 * 所以前后衔接、时间线和数字账都算数；文笔和总纲层面的问题不在这次范围内。
 */
export const CHAPTERS_BLOCKER_BAR = [
  '这是写正文前的章节细纲，要能照着直接写；只审这几章本身：',
  '- 和总纲、本卷概要、前后已写章节对不上的（时间线、日期、数字账、人物出场和信息揭露的顺序），算【阻断】。',
  '- 文笔、台词、具体措辞留给正文，最多算【建议】。',
  '- 总纲层面的问题（主线、人物设定、后面几卷怎么写）不在这次修改范围内，最多算【建议】，提醒主编写进主文档。',
].join('\n');

export function critiquePrompt({ topic, round, proposals, peers = [], resolved = [], interjections, context, askVerdict = false, convo = false, mode, limits = limitsFor(mode), scope, items = false, ownIssues = null, subjectType }) {
  const tracking = items && ownIssues !== null;
  const refine = mode === 'refine';
  const chapters = refine && isChapters(subjectType);
  return join(
    `【阶段：第 ${round} 轮${STAGE_LABELS.critique}】`,
    scopeBlock(scope, { once: convo }),
    `## 待评审的${refine ? '修改' : ''}方案（匿名）\n${planned(proposals)}`,
    tracking && (ownIssues.length || round > 2) ? ownIssuesBlock(ownIssues) : '',
    peersBlock(peers, { tracking }),
    resolvedBlock(resolved),
    interjectionBlock(interjections),
    [
      ...followUpLines(convo, round),
      refine
        ? '你是评审，不要提出自己的修改方案，只指出上面每个修改方案的问题（改错了、改过头、没改到根上，或者漏掉了更要紧的短板），引用方案代号。'
        : '你是评审，不要提出自己的方案，只指出上面每个方案的问题，引用方案代号。',
      `只写会${refine ? '影响作品质量' : '改变结论、导致做不成或出错'}的问题；措辞、细节、锦上添花不写，不要复述方案内容，不要写优点。`,
      '每个问题标级别：',
      chapters
        ? '- 【阻断】只给照着写会出问题的：和前后章节、本卷概要或总纲对不上，某章没有推进也没有爽点、主角连着一两章以上被动挨打，章末钩子断档让人不想点下一章，场景只有“发生冲突”“取得进展”这类空话写不出正文，一章塞得太多或太空（按每章约 2500 字估），违背作者的定位或要求'
        : refine
          ? '- 【阻断】只给动摇架子的问题：核心卖点或金手指的主规则自相矛盾、读者前几章就会出戏的硬伤、长篇写不下去（主线断档、成长线提前用完）、违背作者的定位或要求'
          : '- 【阻断】不解决的话方案不成立、会出错或无法落地',
      '- 【建议】改了更好，不改也行（最多 2 条）',
      chapters ? CHAPTERS_BLOCKER_BAR : refine ? REFINE_BLOCKER_BAR : '',
      `按下面的结构${limits ? `，全文不超过 ${limits.critique} 字${items ? '（依据不计）' : ''}` : ''}：`,
      items ? `${briefLine('还有几条阻断级问题、最要紧的是哪条')}。要点里只用文字说，不写【阻断】【建议】这类标记` : briefLine('还有几条阻断级问题、最要紧的是哪条'),
      items
        ? `然后按方案代号分组：每组单独一行加粗的方案代号（例如「**方案 A**」），下面是条目，条目不要直接接在要点后面。没有新问题的方案在代号下写「无新问题」。\n${itemFormat({ levels: '【阻断】【建议】', need: `- 【阻断】必须写改法和依据。${tracking ? '\n- 问题编号由程序在发布前写上，新问题不要自己编号；仍坚持的旧问题写原编号（见上面的清单）。' : ''}` })}`
        : '然后按方案代号分组，每个问题一行：「【阻断】问题 → 后果 → 怎么改」。没有新问题的方案写「无新问题」。',
      askVerdict ? verdictInstruction(round, mode, { graded: true, subjectType }) : '',
    ].filter(Boolean).join('\n'),
  );
}

export function reviewPrompt({ topic, round, own, others, critiques = [], interjections, context, convo = false, mode, limits = limitsFor(mode), items = false, tracking = false }) {
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
      items
        ? '**改了什么**（每条一行：「- 【改】原来… → 现在… ｜依据：…」；依据只写代码坐标「仓库别名:路径:行号」、「第 N 轮核实第 K 条」、资料或「推断」，不计入字数；没改写「无变化」）'
        : '**改了什么**（每条一行：「原来… → 现在… · 原因」；没改写「无变化」）',
      critiques.length
        ? (items && tracking
          ? '**对评审意见的回应**（只回应【阻断】级问题和你不采纳的意见，按问题编号每条一行：「- 【采纳】Q1-3 ｜改法：…」或「- 【不采纳】Q1-3 ｜依据：…」，编号照抄评审意见里的；不采纳必须带依据）'
          : items
          ? '**对评审意见的回应**（只回应【阻断】级问题和你不采纳的意见，每条一行：「- 【采纳】评审 N 的「问题开头几个字」 ｜改法：…」或「- 【不采纳】评审 N 的「…」 ｜依据：…」；不采纳必须带依据）'
          : '**对评审意见的回应**（只回应【阻断】级问题和你不采纳的意见，每条一行：「采纳：评审 N 的「问题开头几个字」」或「不采纳：评审 N 的「…」：理由」）')
        : '',
      hasOthers ? '**对其他方案的看法**（只写会影响结论的分歧或值得借鉴的地方，一两行，引用方案代号；没有就不写）' : '',
      '**立场变化**（无 / 小幅 / 较大，一句话说明）',
      mode === 'refine' && critiques.length
        ? '这是在搭架子，后面写作时还会改：补漏洞用最少的规则；评审要的具体数值或后期卷的细则，写进「可调参数」或标成待定即可，不要为了堵口子新增成套机制。'
        : '',
      '',
      `第二部分不发到${mode === 'refine' ? '页面' : '群里'}，只给其他参与者和主席看：单独一行写「${PLAN_MARKER}」，下面写修订后的完整${plan}（结构同第 1 轮，${mode === 'refine' ? '完整写出，不要只写这一轮的变化，' : ''}${limits ? `不超过 ${limits.plan} 字` : ''}）。`,
      `这一轮${plan}没有任何改动时，「${PLAN_MARKER}」下面只写「${UNCHANGED_MARK}」三个字，程序会沿用你上一版；改了哪怕一处，就写完整的${plan}。`,
    ].filter((l) => l !== '').join('\n'),
  );
}

/** 主笔的最终方案：讨论记录里修订轮只有变化，完整方案在这里。 */
function finalsBlock(finals, title = '各主笔的最终方案') {
  if (!finals?.some((e) => e.plan)) return '';
  return `## ${title}（匿名，讨论记录里的修订轮只写了变化，完整方案以这里为准）\n${finals.map((e) => `### ${e.tag ?? `方案 ${e.label}`}\n${e.plan ?? e.text}`).join('\n\n')}`;
}

/**
 * 核实审查：核实员（例如 Sonnet）先读代码写初稿，调研员（Opus）逐条复查、纠正，定稿才发给主笔和评审。
 * 参与者看不到初稿，所以定稿要完整独立。
 */
export function factReviewPrompt({ round, questions, draft, checker = '核实员', repos, docs = [], tools = ['Read', 'Grep', 'Glob'], maxChars = 4000, items = false }) {
  return join(
    `【阶段：第 ${round} 轮${STAGE_LABELS.factreview}】`,
    [
      `你是「调研员」，这次负责审查。「${checker}」已经按下面的问题查过代码，写了回答初稿。初稿还没有发给讨论参与者：你审查、纠正之后的定稿才会发出去，主笔和评审会以定稿为准修改方案，所以定稿里的每条结论都必须站得住。`,
      `你只能用 ${tools.join('、')} 只读查看下面的目录：`,
      ...dirLines(repos, docs),
    ].join('\n'),
    `## 待核实的问题\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
    `## ${checker}的初稿\n${draft}`,
    [
      '## 要求',
      '- 逐条复查：结论对不对，引用的源码坐标是否存在、是否真的支撑结论，有没有漏掉适用条件或例外。拿不准的自己到代码里查，不要因为初稿写得肯定就相信。',
      '- 有错就改，漏了就补。初稿没有依据、你也查不到的结论，改成「代码里找不到」（说明查了哪里）或「代码回答不了」，不要保留。',
      '- 第一行写审查结论：「**审查**：共 N 条，全部无误」或「**审查**：共 N 条，M 条有更正（第 x、y 条）」。',
      items
        ? `- 然后写定稿。${FACT_ITEM_RULE.slice(2)}更正过的条目在级别后面加「【已更正】」，并在结论里用一句话说明初稿错在哪里。`
        : '- 然后写定稿：逐条回答，编号和问题一致。每条先写结论（是 / 否 / 具体的值或行为），再写依据，依据带源码坐标「仓库别名:仓内相对路径:行号」。更正过的条目在结论前标「【已更正】」，再用一句话说明初稿错在哪里。',
      '- 结论和背景资料不一致或比它更完整时，明确写「背景资料有误：……」或「背景资料不完整：……」。',
      `- 参与者看不到初稿，定稿要完整独立，不要写「同初稿」。不要提建议，不要评价方案。全文不超过 ${maxChars} 字，只输出审查结论和定稿。`,
    ].join('\n'),
  );
}

/** 审查里更正了几条：解析第一行「**审查**：共 N 条，M 条有更正」；写「全部无误」为 0；没写时返回 null。 */
export function parseReviewCorrections(text) {
  const head = String(text ?? '').split('\n').find((l) => l.trim()) ?? '';
  if (!/审查/.test(head)) return null;
  if (/全部无误/.test(head)) return 0;
  const m = /(\d+)\s*条有更正/.exec(head);
  return m ? Number(m[1]) : null;
}

/** 主席输入按预算缩略或省略了较早的讨论记录、核实结果时的说明。 */
function omittedBlock(omitted) {
  return omitted ? `## 篇幅说明\n${omitted}` : '';
}

/** 本场没有读代码：涉及代码现状的说法都是参与者的推测。 */
function noCodeBlock(noCode) {
  return noCode ? '## 代码上下文\n本场无代码：讨论前没有读代码，讨论中也没有核实代码事实（联网查证的只是公开资料）。参与者关于代码现状的说法都是推测，主文档里涉及代码现状的结论要标为「未核实」，并在开头注明「本场无代码」。' : '';
}

/** 讨论没有收敛（熔断或到上限）时，主文档要写成能让人直接裁决的样子。 */
const VERDICT_RULES = [
  '这次主文档要让人能直接裁决：',
  '- 「要点」里写清讨论怎么结束的、有几条待裁决的分歧，列出最多 5 条分歧的标题。',
  '- 「分歧与需要拍板的问题」逐条写待裁决项：引用阻断原文（见「阻断原文存档」：标「仍在阻断」的是待裁决项；标「格式未识别」的由你看原文判断是不是真的阻断；标「没有意见了」或「未再提」的不算待裁决），写双方的理由和证据、你倾向哪一边和为什么、可选项和各自的代价。',
  '- 被代码核实结果否定、评审却仍然坚持的阻断，不算待裁决：单独写一节「已核实不成立」，写明是哪次核实、核实结论是什么。这一判断由你做，拿不准就仍然列为待裁决。',
  '- 没有核实过的前提写进「风险与未核实的前提」。',
  '- 「方案」写你推荐的方案，开头标明「推荐方案（未经评审）」：评审没有看过这个组合，每处注明取自哪种做法（用内容命名，不用代号），涉及代码事实的地方引用核实结果。',
].join('\n');

/**
 * 行首阻断行（网页和阻断存档共用）：几段文字里满足 isBlockerLine 的行，同一行只算一次（去掉列表符号和加粗后比较），保留原文。
 */
export function lineStartBlockers(...texts) {
  const seen = new Set();
  const out = [];
  for (const text of texts) {
    for (const raw of String(text ?? '').split('\n')) {
      if (!isBlockerLine(raw)) continue;
      const line = raw.trim();
      const norm = line.replace(/^(?:[-*+•]\s+|\d+[.、)）]\s*)/u, '').replace(/\*\*/g, '').trim();
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(line);
    }
  }
  return out;
}

/** 阻断存档里还算待裁决的：仍在阻断（open）和格式未识别（unknown）。旧状态没有 status 时看 clearedAt。 */
export const isPendingBlocker = (b) => (b.status ? b.status === 'open' || b.status === 'unknown' : !b.clearedAt);

/** 存档条目的状态说明，主席、卡片、兜底清单共用。 */
export function blockerStatusText(b) {
  if (b.status === 'unknown') return `第 ${b.round} 轮；格式未识别：评审结论不是「${VERDICT_DONE}」，但【阻断】不在行首，可能是否定句、引用或格式不规范的阻断，请自行判断`;
  if (b.status === 'done') return `第 ${b.round} 轮；第 ${b.statusRound} 轮评审结论：${VERDICT_DONE}`;
  if (b.status === 'dropped' || (!b.status && b.clearedAt)) return `第 ${b.round} 轮；第 ${b.clearedAt} 轮起未再提阻断`;
  return `第 ${b.round} 轮；仍在阻断`;
}

/** 一条存档的正文：原文行；未识别的另附更早一次写在行首的阻断。 */
export function blockerEntryText(b, bullet = (l) => l) {
  return [
    ...b.lines.map(bullet),
    ...(b.prev ? [`更早第 ${b.prev.round} 轮写在行首的阻断：`, ...b.prev.lines.map(bullet)] : []),
  ].join('\n');
}

/**
 * 阻断原文存档：状态按每位评审最后一次发言的评审结论，原文取最近一次写在行首的【阻断】。
 * status 为 resolved 的是更早已经解决的阻断（评审后来写了「没有意见了」或人裁决过），单独放一小节，不算待裁决。
 */
export function blockersBlock(blockers = []) {
  const current = blockers.filter((b) => b.status !== 'resolved');
  const resolved = blockers.filter((b) => b.status === 'resolved');
  if (!current.length && !resolved.length) return '';
  return [
    '## 阻断原文存档（每位评审的状态按他最后一次发言的评审结论；原文取最近一次写在行首的【阻断】，照录）',
    ...(current.length ? current.map((b) => `### ${b.tag}（${blockerStatusText(b)}）\n${blockerEntryText(b)}`) : ['（评审最后都没有待处理的阻断）']),
    ...(resolved.length ? [
      '',
      '### 已经解决的阻断（不算待裁决，供写「考虑过但没采用的做法」和判断评审有没有重提时参考）',
      ...resolved.map((b) => `#### ${b.tag} 第 ${b.round} 轮提出（${b.by === 'ruling' ? '人已经裁决过' : `第 ${b.resolvedAt} 轮评审结论：${VERDICT_DONE}`}）\n${b.lines.join('\n')}`),
    ] : []),
  ].join('\n');
}

/** 告诉主席讨论是怎么结束的。 */
function endingBlock(ending) {
  if (!ending) return '';
  const block = endingBlockBase(ending);
  if (!block || !ending.dropped?.length || ending.reason === 'dropped') return block;
  const [head, ...rest] = block.split('\n\n');
  return [`${head}\n${ending.dropped.join('、')} 中途连续调用失败掉线，后面的轮次没有参与；它掉线前提的意见仍在讨论记录里，写结论时说明这一点。`, ...rest].join('\n\n');
}

function endingBlockBase(ending) {
  if (ending.reason === 'dropped') return `## 讨论如何结束\n第 ${ending.round} 轮之后${ending.part === 'lead' ? '主笔' : '评审'}全部掉线（${(ending.dropped ?? []).join('、')} 连续调用失败），讨论没法继续，被提前结束。${ending.part === 'lead' ? '方案停在各主笔最后一版。' : '最后几轮的方案没有经过评审。'}\n\n${VERDICT_RULES}`;
  if (ending.reason === 'abandoned') return `## 讨论如何结束\n第 ${ending.round} 轮所有脑洞都被评审过半判定放弃，讨论提前结束。没有留下值得推荐的脑洞：在「一句话结论」和「最值得写的脑洞」里如实说明，写清各个脑洞为什么被放弃、下一场换什么方向更有希望。`;
  if (ending.reason === 'converged') return `## 讨论如何结束\n第 ${ending.round} 轮${ending.byReviewers ? '所有评审都表示没有新意见' : '所有主笔的立场都不再变化'}，讨论提前结束。`;
  if (ending.reason === 'max') return `## 讨论如何结束\n已经达到上限 ${ending.round} 轮，${ending.byReviewers ? '评审仍有意见' : '主笔的立场仍在变化'}，讨论被强制结束。\n\n${VERDICT_RULES}`;
  if (ending.reason === 'deadlock') return `## 讨论如何结束\n主笔连续两轮都没有改方案（第 ${ending.round - 1}、${ending.round} 轮），评审仍有阻断：双方各自坚持，讨论以分歧结束，交给人裁决。\n\n${VERDICT_RULES}`;
  if (ending.reason === 'dissent') return `## 讨论如何结束\n${ending.tag ?? '一位评审'}连续 3 轮独自坚持阻断（到第 ${ending.round} 轮），其他评审都已经没有意见，而且每一轮都有人明确反对它的阻断（其他评审【不同意】、认为已解决而它仍坚持，或主笔【不采纳】）：讨论以评审之间的分歧结束，交给人裁决。\n\n${VERDICT_RULES}`;
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
      `请从你的视角独立给出 ${ideasPerAgent} 个长篇网文脑洞，彼此差异要大（题材、主角、核心冲突至少有一样不同），不要只是同一个点子的变体。`,
      '每个脑洞按下面写，并编号（1、2、3……）：',
      '**一句话钩子**（像简介的第一句，读者一眼就想点开）',
      '**题材**（一两个词，如都市、仙侠、悬疑）',
      '**主角和他想要什么**',
      '**核心冲突或金手指**（金手指写清能做什么、代价或限制是什么）',
      '展开（3 到 5 句：开局是什么局面，主线往哪里走）',
      '**最抓人的点**（读者追下去是为了看什么）',
    ].join('\n'),
  );
}

/** 脑洞代号：「方案 B」的第 2 个脑洞是「B2」。 */
export const ideaCode = (tag, no) => `${/方案\s*([A-Z])/.exec(String(tag ?? ''))?.[1] ?? '?'}${no}`;

/** 已经放弃的脑洞：告诉评审不要再评，告诉主编不能推荐。 */
function abandonedBlock(abandoned = [], { forChair = false } = {}) {
  if (!abandoned.length) return '';
  return [
    forChair ? '## 讨论中放弃的脑洞（评审过半判定放弃，不能进推荐；写进「放弃的方向」）' : '## 已经放弃的脑洞（不要再评，也不要建议恢复）',
    ...abandoned.map((a) => (a.by === 'human'
      ? `- ${a.code}（第 ${a.round} 轮之后作者没选）`
      : `- ${a.code}（第 ${a.round} 轮，${a.votes}/${a.voters} 位评审标【弃】）${a.reasons?.length ? `：${a.reasons.join('；')}` : ''}`)),
  ].join('\n');
}

/** 什么问题值得在脑洞阶段继续讨论；数字、逻辑小漏洞、正文执行都留给后面。 */
export const BRAINSTORM_BAR = [
  '这是开书前的脑洞阶段，只看点子值不值得写，不审大纲：',
  '- **问题**只写脑洞级的：钩子不抓人、老套路、看不出主角要干什么或爽在哪里、核心冲突或金手指撑不起长篇。',
  '- 具体数字、设定里的逻辑小漏洞、某一卷怎么写、某个情节怎么圆、人物台词和表现，都不是脑洞级问题，写进**后续注意**，主笔这一轮不用改。',
  '- **可以更大胆的方向**也只写会改变这个脑洞卖点或核心冲突的方向；只是补细节的不算。',
].join('\n');

/** 每个脑洞第一行的去留标记：「【留】B1」或「【弃】B1：理由」。 */
const MARK_RE = /^[\s>*\-#]*\**\s*【(留|弃)】\s*\**\s*(?:方案\s*)?([A-Z])\s*(\d+)\s*\**\s*(?:[:：]\s*(.*))?$/;

/** 解析一条盲审意见里的去留标记：[{ code: 'B1', keep, reason }]，同一个脑洞取第一次出现的。 */
export function parseIdeaMarks(text) {
  const out = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const m = MARK_RE.exec(line);
    if (!m) continue;
    const code = `${m[2]}${m[3]}`;
    if (!out.has(code)) out.set(code, { code, keep: m[1] === '留', reason: (m[4] ?? '').replace(/\**\s*$/, '').trim() });
  }
  return [...out.values()];
}

/**
 * 从讨论记录里算出被放弃的脑洞：每一轮盲审，评审过半标【弃】的脑洞就放弃，之后不再讨论。
 * 有评审时只算评审的票，没有评审时算其他主笔的票；没写标记的算【留】。放弃的不补新的。
 * 返回 [{ code, round, votes, voters, reasons }]，按放弃的先后排。
 */
export function abandonedIdeas(rounds = [], { hasReviewers = true, already = [] } = {}) {
  const gone = new Map(already.map((a) => [a.code, a])); // 已经放弃的（例如作者没选的）不再计票，也不重复返回
  const skip = new Set(gone.keys());
  for (const r of [...rounds].filter((x) => x.stage === 'feedback').sort((a, b) => a.round - b.round)) {
    const voters = r.entries.filter((e) => (hasReviewers ? /^评审/.test(e.tag ?? '') : /^方案/.test(e.tag ?? '')));
    const tally = new Map();
    for (const e of voters) {
      const own = /方案\s*([A-Z])/.exec(e.tag ?? '')?.[1];
      for (const m of parseIdeaMarks(e.text)) {
        if (gone.has(m.code) || m.code[0] === own) continue;
        const t = tally.get(m.code) ?? { votes: 0, reasons: [] };
        if (!m.keep) {
          t.votes += 1;
          if (m.reason) t.reasons.push(m.reason);
        }
        tally.set(m.code, t);
      }
    }
    for (const [code, t] of tally) {
      // 主笔不给自己的脑洞投票，不算进分母
      const n = voters.filter((e) => /方案\s*([A-Z])/.exec(e.tag ?? '')?.[1] !== code[0]).length;
      if (n && t.votes * 2 > n) gone.set(code, { code, round: r.round, votes: t.votes, voters: n, reasons: t.reasons });
    }
  }
  return [...gone.values()].filter((a) => !skip.has(a.code));
}

/** 从一位主笔的发散里取每个脑洞的一句话钩子（给作者挑选用）；取不到的留空。 */
export function ideaHooks(text, n) {
  const hooks = [...String(text ?? '').matchAll(/一句话钩子\**\s*[:：]?\s*\**\s*[:：]?\s*(.+)/g)].map((m) => m[1].replace(/\*\*/g, '').trim());
  return Array.from({ length: n }, (_, i) => (hooks[i] ?? '').slice(0, 120));
}

/**
 * 解析作者选了哪些脑洞：认 A1、b3、C 2 这样的编号（只认 codes 里有的）；没写编号但说了「全部」就都留。
 * 一个都没认出来返回 null（接着等）。
 */
export function parsePick(text, codes) {
  const t = String(text ?? '');
  const valid = new Set(codes);
  const picked = [...new Set([...t.matchAll(/([A-Za-z])\s*(\d+)/g)].map((m) => `${m[1].toUpperCase()}${m[2]}`))].filter((c) => valid.has(c));
  if (picked.length) return codes.filter((c) => picked.includes(c)); // 写了编号就以编号为准（「选 A1，其余全部不要」）
  return /全部|都要|都留|都保留|都继续/.test(t) ? [...codes] : null;
}

/** 某位主笔还留着的脑洞编号。 */
export function keptIdeas(tag, ideasPerAgent, abandoned = []) {
  const gone = new Set(abandoned.map((a) => a.code));
  return Array.from({ length: ideasPerAgent }, (_, i) => i + 1).filter((n) => !gone.has(ideaCode(tag, n)));
}

export function feedbackPrompt({ topic, round, others, interjections, context, askVerdict = false, convo = false, scope, abandoned = [] }) {
  return join(
    `【阶段：第 ${round} 轮${STAGE_LABELS.feedback}】`,
    scopeBlock(scope, { once: convo }),
    `## 待评的脑洞（匿名）\n${labeled(others)}`,
    abandonedBlock(abandoned),
    interjectionBlock(interjections),
    [
      ...followUpLines(convo, round),
      '只给意见，不要改写、合并或替别人重写脑洞。',
      '站在网文读者的角度，逐个评每个方案里还在讨论的脑洞，用「方案代号 + 编号」指代（如 B1）。',
      '每个脑洞的第一行单独写去留，二选一：「【留】B1」或「【弃】B1：一句话理由」。',
      '- 【弃】：这个点子不值得再投入，继续改也写不出让人想追的书（核心钩子不成立、老套路换皮、改到现在越补越重）。不要因为还能改进就留着，该放弃就放弃。',
      '- 评审过半标【弃】的脑洞会被直接拿掉，主笔不能保留，也不会补新的。',
      '然后写：',
      '**亮点**（读者会为了什么点开、追下去）',
      '**问题**（只写脑洞级的；没有就写「无」）',
      '**可以更大胆的方向**（一句话；没有就写「无」）',
      '**后续注意**（写梗概、大纲、正文时要留意的，主笔这一轮不用改；没有就写「无」）',
      '标了【弃】的脑洞只写理由，后面几项不用写。',
      BRAINSTORM_BAR,
      askVerdict ? brainstormVerdict(round) : '',
    ].filter(Boolean).join('\n'),
  );
}

/** 脑洞风暴的评审结论：只有还留着的脑洞有脑洞级问题才继续。 */
function brainstormVerdict(round) {
  return [
    '',
    `最后单独一行写结论，只能二选一：「${VERDICT_LINE}：${VERDICT_CONTINUE}」或「${VERDICT_LINE}：${VERDICT_DONE}」。`,
    `只有你标了【留】的脑洞里还有脑洞级问题、或者有值得一试的更大胆方向时，才写「${VERDICT_CONTINUE}」；只剩后续注意、数字或细节时写「${VERDICT_DONE}」。`,
    round > 2 ? '已经被主笔采纳或合理反驳的意见不要重复提。' : '',
  ].filter((l) => l !== '').join('\n');
}

export function revisePrompt({ topic, round, own, feedback, ideasPerAgent, interjections, context, convo = false, kept = null, dropped = [] }) {
  const fb = feedback.map((f, i) => `### 意见 ${i + 1}\n${f}`).join('\n\n');
  const keep = kept ?? Array.from({ length: ideasPerAgent }, (_, i) => i + 1);
  return join(
    `【阶段：第 ${round} 轮${STAGE_LABELS.revise}】`,
    ownBlock('你上一版的脑洞', own, convo),
    `## 别人给你的意见（匿名）\n${fb || '（这一轮没有收到意见）'}`,
    dropped.length
      ? `## 这一轮被放弃的脑洞\n评审过半标了【弃】，已经拿掉：\n${dropped.map((a) => `- ${a.code}${a.reasons?.length ? `：${a.reasons.join('；')}` : ''}`).join('\n')}\n修订版里不要再写它们，也不要换个名字或拆成别的点子写回来。`
      : '',
    interjectionBlock(interjections),
    [
      '按你自己的视角修订脑洞：意见可以采纳、部分采纳或拒绝（拒绝要说明理由）。',
      '保持你的风格，不要向别人的点子靠拢。',
      '修问题用最少的改动：宁可换掉一个弱的设定，也不要为了堵漏洞新增规则或机制。意见里的「后续注意」是写大纲和正文时的事，这一轮不用改。',
      `只写还留着的脑洞（编号 ${keep.join('、')}），编号不变，不补新的；结构和上一版一致。`,
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
export const TRIAGE_VERDICT = '裁决';
export const TRIAGE_VERIFY = '核实';
/** 追问的处理方式，给人看的名字。 */
export const HANDLING_LABELS = { answer: '直接回答', discuss: '重新讨论', verdict: '按裁决定稿', verify: '核实' };

function followUpHistory(followUps = []) {
  if (!followUps.length) return '';
  return `## 之前的追问\n${followUps.map((f, i) => `### 追问 ${i + 1}：${f.question}\n${f.handling === 'discuss' ? '（重新讨论过）' : ''}\n${f.answer ?? ''}`).join('\n\n')}`;
}

export function triagePrompt({ rounds, finals, summary, question, followUps, isDoc = false, omitted = '', blockers = [], canVerify = false }) {
  const history = rounds
    .map((r) => `### 第 ${r.round} 轮（${STAGE_LABELS[r.stage]}）\n\n${labeled(r.entries).replace(/^### /gm, '#### ')}`)
    .join('\n\n');
  return join(
    `【阶段：${STAGE_LABELS.triage}】`,
    omittedBlock(omitted),
    history ? `## 讨论记录（匿名）\n${history}` : '',
    finalsBlock(finals, '各主笔目前的方案'),
    summary ? `## ${isDoc ? '现在的主文档（讨论结论，之前追问的结论已经合进去）' : '你上次的汇总'}\n${summary}` : '',
    blockersBlock(blockers),
    followUpHistory(followUps),
    `## 人类的追问\n${question.trim()}`,
    [
      `先判断怎么处理这个追问，第一行只能写下面${canVerify ? '四' : '三'}选一：`,
      `「处理方式：${TRIAGE_ANSWER}」：追问是澄清、解释、找出讨论里已经有的内容，或者讨论记录足以回答。`,
      `「处理方式：${TRIAGE_VERDICT}」：人在对分歧做选择，例如「按方案 A」「第 1 条按 B，第 2 条不做」。不用再讨论，按人的选择定稿。`,
      canVerify ? `「处理方式：${TRIAGE_VERIFY}」：人要求查证某些事实（代码现状或公开资料），查清了就能回答，不需要参与者重新权衡。` : null,
      `「处理方式：${TRIAGE_DISCUSS}」：追问带来了新的约束或信息、质疑了结论、要求换方向，或者讨论里没覆盖、需要参与者重新权衡。`,
      '',
      `写「${TRIAGE_ANSWER}」时，接着直接回答，引用方案代号和轮次。`,
      `写「${TRIAGE_VERDICT}」时，接着写 **按哪个方案定稿**：一个方案代号（例如「方案 A」）；人的选择不对应单个方案、需要把几个方案组合起来时写「合并」。再写 **人的裁决**：把人的选择逐条复述成定稿必须遵守的要求，不要加人没说的内容。`,
      canVerify ? `写「${TRIAGE_VERIFY}」时，接着写 **要核实的问题**：每行一个具体问题（最多 8 个）。` : null,
      `写「${TRIAGE_DISCUSS}」时，接着写 **给参与者的说明**：追问改变了什么、要重点重新考虑哪些地方（不要自己给答案），以及一句 **为什么需要重新讨论**。`,
    ].filter((l) => l !== null).join('\n'),
  );
}

/** 解析主席的处理方式：'answer' | 'verdict' | 'verify' | 'discuss'（没写时按直接回答）。 */
export function parseTriage(text) {
  const m = /处理方式\**\s*[:：]\s*\**\s*(直接回答|重新讨论|裁决|核实)/.exec(String(text ?? ''));
  return { [TRIAGE_DISCUSS]: 'discuss', [TRIAGE_VERDICT]: 'verdict', [TRIAGE_VERIFY]: 'verify' }[m?.[1]] ?? 'answer';
}

/** 某个加粗小标题后面的列表项（遇到空行之后的非列表内容就停）。 */
function listAfter(text, heading) {
  const t = String(text ?? '');
  const at = t.indexOf(heading);
  if (at < 0) return [];
  const out = [];
  for (const raw of t.slice(at + heading.length).split('\n').slice(1)) {
    const m = /^\s*(?:[-*]|\d+[.、)])\s+(.+)$/.exec(raw);
    if (m) out.push(m[1].trim());
    else if (raw.trim() && out.length) break;
  }
  return out;
}

/** 裁决型追问：{ target: '方案 A' | 'merge' | null, ruling }。 */
export function parseVerdictPick(text) {
  const t = String(text ?? '');
  const m = /按哪个方案定稿\**\s*[:：]\s*\**\s*(方案\s*[A-Z]|合并)/.exec(t);
  const target = m ? (m[1] === '合并' ? 'merge' : m[1].replace(/\s+/, ' ')) : null;
  const at = t.search(/\**人的裁决\**/);
  const ruling = at >= 0 ? t.slice(at).replace(/^\**人的裁决\**\s*[:：]?\s*/, '').trim() : stripTriageLine(t);
  return { target, ruling };
}

/** 核实型追问：要核实的问题。 */
export function parseVerifyQuestions(text) {
  return listAfter(text, '要核实的问题').slice(0, 8);
}

/** 裁决型追问：被选中的主笔按人的裁决写定稿，不再经过评审。 */
export function finalPrompt({ round, question, ruling, others, interjections, mode, limits = limitsFor(mode) }) {
  const plan = mode === 'refine' ? '修改方案' : '方案';
  return join(
    `【阶段：第 ${round} 轮${STAGE_LABELS.final}】`,
    `## 人的追问\n${question.trim()}`,
    `## 人的裁决（主席复述，定稿必须遵守）\n${ruling}`,
    others?.length ? `## 其他主笔目前的${plan}（匿名，裁决要求借用其中的内容时参考）\n${planned(others)}` : '',
    interjectionBlock(interjections),
    [
      `人已经对分歧做了选择，选的是你的${plan}。不再讨论，按裁决写出定稿：裁决里要求改的地方照改，裁决没提到的部分保持你上一版的内容。不要重新争论已经裁决的问题。`,
      '你的回答分两部分。',
      `第一部分给人看${limits ? `，不超过 ${limits.followup} 字` : ''}：`,
      briefLine('定稿的结论，以及按裁决改了什么'),
      '**按裁决改了什么**（每条一行：「原来… → 现在… · 依据裁决的哪一条」）',
      '',
      `第二部分单独一行写「${PLAN_MARKER}」，下面写完整的定稿${plan}${limits ? `（不超过 ${limits.plan} 字）` : ''}。必须完整写出，不能写「无变化」。`,
    ].join('\n'),
  );
}

/**
 * 新会话追问（fresh）：参与者原来的对话不在新会话里，第一条消息里带上讨论到现在的结论。
 * 原议题和背景资料在系统提示词里，不用重复。
 */
export function freshBlock({ doc, blockers = [], own, others = [], facts = [], omitted = '', interjections = [] }) {
  return join(
    '## 讨论现状（这是一条新会话：你之前的对话不在这里，下面是讨论到现在的结论，以此为准）',
    doc ? `### 现在的主文档\n${doc}` : '',
    own ? `### 你目前的方案（代号${own.tag}）\n${own.plan ?? own.text}` : '',
    others.length ? `### 其他主笔目前的方案（匿名）\n${planned(others)}` : '',
    blockersBlock(blockers),
    omittedBlock(omitted),
    facts.length ? factsBlock(facts) : '',
    interjections.length ? `### 讨论中人的全部插话\n${interjections.map((m) => `- ${m.sender ?? '人'}：${m.text}`).join('\n')}` : '',
  ) + '\n\n';
}

/** 去掉第一行的「处理方式：…」，留下给人看的正文。 */
export function stripTriageLine(text) {
  return String(text ?? '').replace(/^\s*\**处理方式\**\s*[:：][^\n]*\n?/, '').trim();
}

/** 主笔回应追问：在自己的会话里接着聊，所以只发新内容。 */
export function followUpPrompt({ mode, round, question, brief, others, interjections, ideasPerAgent = 3, limits = limitsFor(mode), kept = null }) {
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
        `**修订后的脑洞**（只写还留着的脑洞${kept ? `：编号 ${kept.join('、')}` : `，最多 ${ideasPerAgent} 个`}，编号与之前一致；被放弃的不要再写，也不补新的）`,
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
        `第二部分不发给人，只给其他参与者和主席看：单独一行写「${PLAN_MARKER}」，下面写修订后的完整${plan}${limits ? `（不超过 ${limits.plan} 字）` : ''}。${plan}没有任何改动时，下面只写「${UNCHANGED_MARK}」。`,
      ].join('\n'),
  );
}


// ---------- 主文档 ----------
//
// 每场讨论维护主文档，替代原来的汇总：讨论结束时主席写初稿，主笔对照讨论核对，主席按意见修改后定稿；
// 之后每次追问都改当前文档（留历史版本）。讨论分出了互相独立的方向时，主席可以新开一份文档，并写清原因。
// 主文档给没看过讨论的人读：先提炼结论和要拍板的事，再展开；细节写成附录，删掉附录正文也能独立读懂。
// 变更记录不写进正文，由程序按各版的原因和说明生成（docChangelog）。

export const DOC_MARK = { note: '【说明】', doc: '【主文档】', unchanged: '【无需修改】', newDoc: '【新文档】' };
// 标记单独一行；模型偶尔把内容接在标记后面同一行，也认
const DOC_LINE = /^[ \t]*\**[ \t]*【(说明|主文档|无需修改|新文档|附录[:：][ \t]*([^】\n]+?))】[ \t]*\**[ \t]*[:：]?[ \t]*(.*)$/;
const DELETED = /^[（(]\s*删除\s*[)）]$/;
const OPEN_REASON = /^[ \t]*\**[ \t]*(?:新开)?原因\**[ \t]*[:：][ \t]*(.+)$/;

/** 拍板项和风险的重要程度标记。 */
export const PRIORITY = { first: '【先定】', later: '【可后定】' };

const KEY_POINTS = '## 要点（最多 5 条，每条一句完整的话，不嵌套子项，按重要程度排序；人只看这里就知道结论、最要紧的拍板和下一步）';

/** 各模式主文档的结构。 */
const DOC_OUTLINE = {
  decision: [
    '# 标题（一句话说清讨论的是什么问题）',
    '**一句话结论**：……（只写一句话，不分行、不列点；分期或多项内容放到要点里）',
    KEY_POINTS,
    `## 要拍板的事（没达成一致、或要人决定的事，按重要程度排序。每条开头标${PRIORITY.first}或${PRIORITY.later}，写清要定什么、可选项和各自的代价、讨论的倾向；没有就写「无」）`,
    '## 问题（为什么要解决、现状、约束条件。只写影响结论的事实，核实的证据和代码坐标放附录）',
    '## 方案（先用一段话说清整体做法和为什么这样做，再写关键设计和落地步骤）',
    '## 考虑过但没采用的做法（每个一两句：是什么、为什么不选）',
    '## 风险与未核实的前提（按影响从大到小排，只写会改变结论或让方案做不成的）',
    '## 下一步（按先后顺序，只写接下来最近要做的几步；拍板项已经在上面，不要再列一遍）',
    '## 可存入知识库的结论（最多 5 条以后的讨论会反复用到的结论或事实，每条一句完整的话，不含只对这次有效的细节，也不要和记忆里已有的重复；没有就写「无」。人确认后才会存）',
  ],
  brainstorm: [
    '# 标题（题目是什么）',
    '**一句话结论**：最值得写的是哪个脑洞、为什么（只写一句话，不分行、不列点）',
    KEY_POINTS,
    '## 题目与要求',
    '## 最值得写的脑洞（3 个左右，按推荐程度排序，每个都写完整，不能只写编号：一句话钩子、题材、主角和他想要什么、核心冲突或金手指（含代价或限制）、开篇第一个场景、卖点和与同类热门书的差异、主线大致怎么走才能撑起长篇、为什么值得写、写梗概和大纲时要注意什么（来自评审的「后续注意」））',
    '## 可以组合的点子（组合后是什么样子）',
    '## 被低估的点子',
    '## 放弃的方向（讨论中被放弃的脑洞和你没选的方向，每个一句话：是什么、为什么放弃）',
    '## 下一步',
  ],
  quick: [
    '# 标题（一句话说清问的是什么）',
    '**一句话结论**：……（只写一句话，不分行、不列点）',
    '## 回答（直接回答问题：先给结论，再给理由；问题有歧义时写明按哪种理解回答）',
    '## 你可能没考虑到的（挑刺里成立的盲点、风险、反例和更简单的做法，按重要程度排序，每条写清会怎样；没有就写「无」）',
    '## 需要你补充的（回答依赖、但问题里没给的信息，每条写清补上之后结论可能怎样变；没有就写「无」）',
    '## 下一步（提问人接下来最该做的几件事，按先后顺序）',
    '## 可存入知识库的结论（最多 3 条以后会反复用到的结论，每条一句完整的话，不含只对这次有效的细节，也不要和记忆里已有的重复；没有就写「无」。提问人确认后才会存）',
  ],
  redraft: [
    '# 标题（改的是哪一章、改成什么样）',
    '**一句话结论**：……（这次最主要改了什么，只写一句话）',
    '## 修改说明（按重要程度排序，每条写清改了哪里、为什么这样改；作者照着就能判断要不要接受）',
    '## 没采纳的意见（挑刺里没采纳的，每条一句为什么不采纳；没有就写「无」）',
    '## 可存入知识库的结论（关于这部作品以后改稿都要遵守的设定、人物、文风约定，最多 3 条，每条一句完整的话；没有就写「无」。作者确认后才会存）',
  ],
  refine: [
    '# 标题（打磨的是哪一份、改成什么样）',
    '**一句话结论**：最该改的是什么、改完会好在哪里（只写一句话，不分行、不列点）',
    KEY_POINTS,
    `## 要作者拍板的事（各方的改法与理由、你倾向哪一种。每条开头标${PRIORITY.first}或${PRIORITY.later}；没有就写「无」）`,
    '## 原稿的问题（按重要程度排序，先用一句话说清最根本的问题）',
    '## 修改方案（逐条写清改哪里、改成什么、为什么，作者可以照着改；最重要的放最前面）',
    '## 保留不改的地方（以及为什么不改）',
  ],
};

/** 写文档的规则：初稿、追问后更新、按核对意见修改、重写共用。 */
function docRules(mode) {
  if (mode === 'redraft') {
    return [
      '## 写法',
      '这份文档给作者读：先看修改说明决定接不接受，再从「修改稿」附录里复制全文。',
      '- 修改说明只写会影响判断的改动，按重要程度排序；措辞上的小改动合成一条带过。',
      '- 修改说明对照的是作者给的章节原文：作者只看过原文，没看过你中间的修改稿，不要写「上一稿」「第一版修改稿」「之前改成了」这类说法，直接写原文哪里改成了什么。',
      '- 挑刺里成立的意见吸收进修改稿；不采纳的写进「没采纳的意见」。',
      '- 不要出现「方案 A」「评审 1」这些代号。不要写「变更记录」，程序会自动生成。',
      `- 修改后的完整章节放在「${DOC_MARK.doc}」之后的附录里，标记写「【附录：修改稿】」：完整写出整章，没改的段落也照抄，保持原文的分段，不要加标题、批注或解释，不要省略。`,
      '',
      '## 文档的结构',
      ...DOC_OUTLINE.redraft,
    ].join('\n');
  }
  if (mode === 'quick') {
    return [
      '## 写法',
      '这份文档给提问人读：读完就知道答案、自己可能漏掉了什么、还要补什么信息、接下来做什么。',
      '- 先给结论再展开，只写会影响判断的内容，不写铺垫和客套。',
      '- 挑刺里成立的意见吸收进回答，或者写进「你可能没考虑到的」；不成立的不用写。',
      '- 不要出现「方案 A」「评审 1」这些代号。不知道的事实写明不知道，不要编造。',
      '- 用 Markdown：# 标题、列表、加粗都可以，不要用表格。整份文档尽量控制在 1500 字以内。',
      '- 不要写「变更记录」，程序会按版本自动生成。',
      '',
      '## 文档的结构',
      ...DOC_OUTLINE.quick,
    ].join('\n');
  }
  return [
    '## 写法',
    '这份文档给没看过讨论的人读，不是讨论记录的归档。动笔前先想清楚：读者读完要知道什么结论、要做什么决定、接下来做什么，全文围绕这几件事组织。',
    '- **先提炼，再展开**：每个部分开头先用一两句话写出这部分的结论，后面的内容只用来支撑它。不能只罗列。',
    '- **不要堆碎点**：讨论里的零碎意见不要逐条搬进来。相关的点合并成一个判断，写清它们之间的关系（因果、取舍、先后）；并不进任何结论、也不影响决策的点直接删掉。',
    '- **能压缩就压缩**：篇幅没有硬性上限，但每一段都要有理由留下。确实压缩不了的内容（例如落地步骤、关键设计）可以写长，写成连贯的段落或有序步骤，不要写成一串碎点。列表最多两层，每条写一个完整的意思。',
    '- **同一件事只写一次**：要点里提到的事，后文只在一个地方展开；别的地方需要时写「见『某部分』」。',
    `- **标出重点**：要拍板的事每条开头标${PRIORITY.first}（不定就没法开工或会做错）或${PRIORITY.later}（开工后再定也来得及），${PRIORITY.first}排在前面。要点和各部分里的条目都按重要程度排序，最要紧的放最前面。`,
    '- **细节进附录**：核实的证据和代码坐标、完整的接口或字段清单、逐项的实现约定、不影响开工的实现细节分歧、被否决做法的完整论证，都放进附录。正文写出这一点的结论并注明「详见附录《标题》」。删掉附录，正文也要能独立读懂、能据此拍板。',
    '- 读者不知道「方案 A」「评审 1」这些代号和轮次：文中不要出现代号和轮次，各个做法用内容本身命名（例如「按供应商分批迁移」）。',
    '- 共识和分歧分清楚：没有达成一致的不要写成定论，也不要替人拍板；没核实的写明「未核实」。影响决策或落地的信息（关键数据、约束、前提假设、已核实的事实、没解决的分歧）不能丢，但要放在合适的层级：正文写结论，附录写细节。',
    mode === 'decision' ? '- 用「方案」写清楚要做什么，不要只列结论：读者照着它就能知道怎么落地。' : '',
    '- 不要写「变更记录」，程序会按版本自动生成。',
    '- 用 Markdown：# 标题、列表、加粗、代码块都可以，不要用表格。',
    '- **一份文档只讲一件事**：讨论分成了互相独立的方向（各自有自己的结论、拍板项和下一步，读者可能只关心其中一个），可以把其中的方向新开一份文档，必须写清新开的原因：它和当前文档为什么是两件事。只是同一件事的补充、细化或改主意，就改当前文档，不要新开。',
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
      ? '发到讨论里的短消息，3 行以内：这次的结论，以及文档改了哪些地方（新开了文档的话说明开了什么、为什么）。'
      : '发到讨论里的短消息，3 行以内：一句话结论，加上最需要人拍板或注意的一件事。',
    `${DOC_MARK.doc}`,
    update ? '修改后的当前文档全文。当前文档这次不需要改、只新开文档时，省掉这个标记和内容。' : '完整的主文档。',
    '【附录：标题】（可选，可以有多个，属于它前面最近的那份文档）',
    update
      ? '只输出新增或改动过的附录，没改的不要输出（会原样保留）；要删掉某个附录，内容只写「（删除）」。'
      : '附录的完整内容。',
    `${DOC_MARK.newDoc}（可选，可以有多个；只在讨论分出了独立的方向时用）`,
    '第一行写「原因：……」，一两句话说清为什么它是另一件事、为什么不放进当前文档；下面是这份新文档的全文，结构和写法同上，后面可以接它自己的【附录：标题】。从当前文档移过去的内容，要从当前文档里删掉，只留一句「见《新文档标题》」。',
    allowUnchanged ? `\n如果这次的内容不需要写进文档（例如只是解释文档里已经写清楚的内容），整个回答只输出一行「${DOC_MARK.unchanged}」。` : '',
  ].filter((l) => l !== '').join('\n');
}

export function docSystem(mode) {
  if (mode === 'redraft') {
    return [
      '你刚才按作者的要求改了一章，另一位 AI 对你的修改稿挑了刺。现在由你定稿：写出修改说明，并给出修改后的完整章节。',
      '你只看到匿名代号，不要猜测它们来自哪个模型。挑刺的意见要认真对待，但不成立的不要为了迎合而采纳。',
      '作品定位、人设和世界观以作者给的设定为准；作者之后还可能追问，你会接着改。',
    ].join('\n');
  }
  if (mode === 'quick') {
    return [
      '你刚才回答了提问人的问题，另一位 AI 对你的回答挑了刺。现在由你定稿，写成一份给提问人看的短文档。',
      '你只看到匿名代号，不要猜测它们来自哪个模型。挑刺的意见要认真对待，但不成立的不要为了迎合而采纳。',
      '文档会一直维护：提问人之后每次追问，你都会回答并改进这份文档。',
    ].join('\n');
  }
  const who = mode === 'decision' ? '主席' : '主编';
  return [
    `你是「${who}」，负责把一场多 AI ${mode === 'brainstorm' ? '脑洞风暴' : mode === 'refine' ? '作品打磨讨论' : '方案讨论'}的结果整理成主文档，给没看过讨论的人读。`,
    '你只看到匿名代号（方案 A、方案 B……，评审 1、评审 2……），不要猜测它们来自哪个模型。',
    mode === 'brainstorm'
      ? '看重新鲜感、读者想不想点开追下去、能不能撑起长篇；保留不同方向的多样性，不要把所有点子揉成一个。'
      : '保持中立：如实写出共识与分歧，不要自己另起一个新方案，也不要替人拍板。',
    '你的价值在提炼：把讨论里分散的意见归纳成少数几个清楚的判断，标出重点，让人花最少的时间知道结论和该做的决定。',
    '文档会一直维护：之后每次追问的结论都会改进当前文档；讨论分出独立的方向时可以新开文档。',
  ].join('\n');
}

function historyBlock(rounds) {
  if (!rounds?.length) return '';
  return `## 讨论记录（匿名）\n${rounds
    .map((r) => `### 第 ${r.round} 轮（${STAGE_LABELS[r.stage] ?? r.stage}）\n\n${labeled(r.entries).replace(/^### /gm, '#### ')}`)
    .join('\n\n')}`;
}

/** 这场讨论里的其他文档：只给标题和一句话结论，避免新开重复的文档或把别的文档的内容写进来。 */
function otherDocsBlock(otherDocs = []) {
  if (!otherDocs.length) return '';
  return `## 这场讨论的其他文档（只读，不要改，也不要把它们的内容写进当前文档）\n${otherDocs.map((d) => `- 《${d.title}》${d.lead ? `：${d.lead}` : ''}`).join('\n')}`;
}

function attachmentsBlock(attachments) {
  const list = Object.entries(attachments ?? {});
  if (!list.length) return '';
  return `## 现有附录\n${list.map(([title, text]) => `### 附录《${title}》\n${text}`).join('\n\n')}`;
}

/**
 * 初稿：讨论结束时写。补写旧讨论时 earlier 带上原来的汇总和追问记录。
 */
export function docPrompt({ mode, rounds, finals, interjections, ending, earlier, noCode = false, omitted = '', blockers = [], abandoned = [] }) {
  const hasCritique = rounds?.some((r) => r.stage === 'critique');
  return join(
    `【阶段：${STAGE_LABELS.doc}】`,
    omittedBlock(omitted),
    historyBlock(rounds),
    mode === 'brainstorm'
      ? (finals?.length ? `## 各方最终版脑洞（匿名）\n${labeled(finals)}` : '')
      : finalsBlock(finals, mode === 'refine' ? '各主笔最终的修改方案' : '各主笔的最终方案'),
    abandonedBlock(abandoned, { forChair: true }),
    earlier ? `## 之前的汇总和追问（按时间先后，后面的结论推翻前面时以后面为准）\n${earlier}` : '',
    blockersBlock(blockers),
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
export function docUpdatePrompt({ mode, doc, attachments, version, question, handling, answer, brief, rounds, finals, interjections, ending, noCode = false, omitted = '', blockers = [], ruling, final, verifyQuestions = [], otherDocs = [], abandoned = [] }) {
  return join(
    `【阶段：更新${STAGE_LABELS.doc}】`,
    `## 现在的主文档（第 ${version} 版）\n${doc}`,
    attachmentsBlock(attachments),
    otherDocsBlock(otherDocs),
    `## 人类的追问\n${question.trim()}`,
    handling === 'answer'
      ? `## 你对追问的回答${mode === 'quick' ? '' : '（主席判断讨论记录足以回答，没有重新讨论）'}\n${answer}`
      : handling === 'verdict'
      ? join(
        `## 人的裁决（你复述的）\n${ruling}`,
        final
          ? `## 定稿${mode === 'refine' ? '修改方案' : '方案'}（被选中的主笔按裁决写出，没有经过评审）\n${final.plan}`
          : '## 定稿\n人的选择不对应单个方案：由你按裁决把各方案组合成定稿，写进主文档的方案部分。',
        finalsBlock(finals, '各主笔目前的方案'),
        [
          '## 这次更新的要求',
          `- 方案部分换成定稿，开头标明「定稿（按人的裁决${final ? '' : '合并'}，未经评审）」，并逐条对上裁决。`,
          '- 已裁决的分歧从「分歧与需要拍板的问题」里移走，改写成「已裁决：选了什么、理由」；没裁决的仍然保留。',
          '- 定稿和已核实的事实冲突时，在风险里写明冲突，不要替人改裁决。',
        ].join('\n'),
      )
      : handling === 'verify'
      ? join(
        `## 这次要核实的问题\n${verifyQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
        '核实结果见下面的核实部分（最后一次）。把结论合进主文档对应的位置；被核实推翻的说法直接改掉，受影响的结论和风险一起改。',
      )
      : join(
        brief ? `## 你给参与者的说明\n${brief}` : '',
        omittedBlock(omitted),
        historyBlock(rounds).replace('## 讨论记录（匿名）', '## 追问之后的讨论（匿名）'),
        mode === 'brainstorm' ? (finals?.length ? `## 各方最新的脑洞（匿名）\n${labeled(finals)}` : '') : finalsBlock(finals, '各主笔目前的方案'),
        abandonedBlock(abandoned, { forChair: true }),
        blockersBlock(blockers),
        endingBlock(ending),
        noCodeBlock(noCode),
      ),
    interjectionBlock(interjections),
    [
      '## 要求',
      '- 把这次追问得出的结论合进文档对应的位置，改完的文档要反映现在完整的结论，读者不需要再看追问记录。',
      '- 被推翻的旧结论直接改掉，不要保留后再补一句「后来改了」；被放弃的做法移到「考虑过但没采用」一类的部分，写明原因。',
      '- 不要只往里加：被新结论取代或已经不重要的内容删掉或压缩，和新内容重复的合并，要点和拍板项按新的重要程度重排。没受影响、也已经符合下面写法的部分不用重新措辞。',
      '- 现在的文档里如果有「变更记录」部分，删掉它（程序会按版本自动生成）。',
      `- 先判断这次追问是不是开出了和当前文档不同的独立方向：是的话用${DOC_MARK.newDoc}新开一份并写清原因，不要把它塞进当前文档；只是当前这件事的补充或改主意，就改当前文档。`,
    ].join('\n'),
    docRules(mode),
    docFormat({ update: true, allowUnchanged: handling === 'answer' }),
  );
}

/** 主笔核对主文档：在自己的会话里，对照自己参与过的讨论。 */
export function docCheckPrompt({ doc, attachments, own, items = false }) {
  return join(
    `【阶段：${STAGE_LABELS.doccheck}】`,
    `## 主文档\n${doc}`,
    attachmentsBlock(attachments),
    own ? `## 你最后的方案\n${own}` : '',
    [
      '主席根据讨论写了上面的主文档，给没看过讨论的人读。请对照你参与的讨论核对，只指出重要的问题：',
      '- 漏掉了影响决策或落地的信息（关键约束、数据、已核实的事实、被否决做法的理由、没解决的分歧）；',
      '- 写错了，或者把没有达成一致的写成了定论；',
      '- 读者看不懂的地方（用了代号、缺少前提）；',
      '- 读起来费力的地方：没有提炼出结论、只是堆着碎点的部分，同一件事在几处重复，最要紧的结论或拍板项没有排在前面、没有标出来。能删、能并的直接指出来。',
      '要求补充遗漏时，同时说清补在哪一层（正文写结论，还是附录写细节），不要为了完整把细节都塞进正文。',
      items
        ? '措辞、格式和次要细节不用提。每条一行：「- 【漏 / 错 / 不清】问题 ｜改法：…」，【漏】是漏掉的信息，【错】是写错或把没达成一致的写成定论，【不清】是看不懂或读起来费力；不超过 600 字。'
        : '措辞、格式和次要细节不用提。每条一行，写清应该怎么改，不超过 600 字。',
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
      '逐条判断：对照讨论记录确实如此的，改进文档；不成立的忽略。其余部分原样保留。',
      '补充遗漏时仍然按写法来：正文只写结论，细节进附录；补完后看一下有没有因此重复或变散，顺手合并。',
      `按同样的格式重新输出：${DOC_MARK.note}仍然写发到讨论里的短消息；${DOC_MARK.doc}写修改后的完整文档；附录只输出这次新增或改动的，要删掉的写「（删除）」。初稿里新开的文档（${DOC_MARK.newDoc}）也要按原来的顺序重新输出全文和原因。`,
    ].join('\n'),
  );
}

/**
 * 按新的写法重写现有文档：不增加新结论，不丢影响决策的信息；可以按方向拆成几份。
 * otherDocs：这场讨论里的其他文档（标题和一句话结论），避免重复。
 */
export function docRewritePrompt({ mode, doc, attachments, version, otherDocs = [] }) {
  return join(
    `【阶段：重写${STAGE_LABELS.doc}】`,
    `## 现在的主文档（第 ${version} 版）\n${doc}`,
    attachmentsBlock(attachments),
    otherDocsBlock(otherDocs),
    [
      '## 要求',
      '这份文档是按旧的写法一版版累积出来的，读起来费力：碎点多、没有总结、同一件事写了好几处、重点不突出。请按下面的写法把它重写成新的一版：',
      '- 不增加新的结论，也不改变已有的结论、分歧和「未核实」的标注；只重新组织、提炼、合并、删掉重复。',
      '- 影响决策或落地的信息不能丢，但要放到合适的层级：正文写结论，细节移进附录（可以新建、合并或重写附录）。',
      '- 现在的文档里如果有「变更记录」部分，删掉。',
      `- 如果文档其实讲了几件互相独立的事，按「一份文档只讲一件事」拆开：当前文档保留最初议题的那件事，其余的用${DOC_MARK.newDoc}新开，并写清原因。`,
      '- 附录也按同样的要求整理；保留的附录要完整输出（这次视为全部改动过），不再需要的附录写「（删除）」。',
    ].join('\n'),
    docRules(mode),
    docFormat({ update: true }),
  );
}

/**
 * 拆开主席写的文档：{ unchanged, note, doc, attachments, newDocs }。
 * doc 是当前文档（初稿或改后的全文），只新开文档、当前文档不改时为 null；attachments 是它这次输出的附录：{ 标题: 内容 }，内容为 null 表示删除。
 * newDocs：新开的文档 [{ title, reason, doc, attachments }]，附录属于它前面最近的那份文档。
 * 没写【主文档】也没写【新文档】时整段当作主文档。
 */
export function parseDoc(text) {
  const raw = String(text ?? '').trim();
  const lines = raw.split('\n');
  const parts = [];
  let current = null;
  for (const line of lines) {
    const m = DOC_LINE.exec(line);
    if (m) {
      current = { key: m[2] ? 'attachment' : { 说明: 'note', 主文档: 'doc', 无需修改: 'unchanged', 新文档: 'newDoc' }[m[1]], title: m[2]?.trim(), lines: m[3]?.trim() ? [m[3].trim()] : [] };
      parts.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  const body = (p) => p.lines.join('\n').trim();
  const hasDoc = parts.some((p) => p.key === 'doc');
  const hasNew = parts.some((p) => p.key === 'newDoc');
  if (parts.some((p) => p.key === 'unchanged') && !hasDoc && !hasNew) return { unchanged: true };
  const attachments = {};
  const newDocs = [];
  let owner = attachments; // 附录归到前面最近的那份文档
  let doc = hasDoc || hasNew ? null : raw;
  for (const p of parts) {
    if (p.key === 'doc') {
      doc = body(p);
      owner = attachments;
    } else if (p.key === 'newDoc') {
      const ls = [...p.lines];
      const i = ls.findIndex((l) => l.trim());
      const m = i >= 0 ? OPEN_REASON.exec(ls[i]) : null;
      if (m) ls.splice(i, 1);
      const text = ls.join('\n').trim();
      if (!text) throw new Error('新文档是空的');
      const nd = { title: docTitle(text), reason: m ? m[1].trim() : null, doc: text, attachments: {} };
      newDocs.push(nd);
      owner = nd.attachments;
    } else if (p.key === 'attachment') {
      const t = body(p);
      owner[p.title] = DELETED.test(t) || !t ? null : t;
    }
  }
  if (hasDoc && !doc) throw new Error('主文档是空的');
  if (!doc && !newDocs.length) throw new Error('主文档是空的');
  const notePart = parts.find((p) => p.key === 'note');
  return { unchanged: false, note: notePart ? body(notePart) || null : null, doc, attachments, newDocs };
}

/** 文档标题：第一行 # 标题；没有时取第一行非空文字。 */
export function docTitle(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const h = lines.find((l) => /^#\s/.test(l));
  return (h ? h.replace(/^#\s+/, '') : lines[0] ?? '').replace(/\*\*/g, '').slice(0, 80);
}

/** 文档编号：旧版本没有 docNo 的都算第 1 份。 */
export const docNoOf = (d) => d?.docNo ?? 1;

/** 同一份文档的各版本（按版本号先后）。 */
export function docSeries(docs = [], docNo) {
  return docs.filter((d) => docNoOf(d) === docNo);
}

/**
 * 变更记录：同一份文档到第 version 版为止，每版一行「第 N 版（原因）：说明」。
 * 新开的文档第一行写从哪份分出来、为什么。
 */
export function docChangelog(docs = [], version) {
  const target = docs.find((d) => d.version === version);
  if (!target) return '';
  // 每版一行：说明压成一行，超过 100 字截断（完整说明在讨论里那条主文档消息上）
  const flat = (t) => cut(String(t ?? '').replace(/\*\*/g, '').split('\n').map((l) => l.replace(/^[-*\s]+/, '').trim()).filter(Boolean).join('；'));
  const cut = (t, n = 100) => (t.length > n ? `${t.slice(0, n)}…` : t);
  return docSeries(docs, docNoOf(target))
    .filter((d) => d.version <= version)
    .map((d) => {
      const from = d.opened ? `新开文档${d.opened.from ? `（从《${d.opened.from}》分出）` : ''}，原因：${cut(d.opened.reason ?? '（没写）')}` : '';
      const note = flat(d.note);
      return `- 第 ${d.version} 版（${d.reason}${d.at ? `，${d.at.slice(0, 10)}` : ''}）：${[from, note].filter(Boolean).join('。') || '（没有说明）'}`;
    })
    .join('\n');
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


// ---------- 实时数据与业务知识 ----------

/** 开场查到的实时数据（调研员审查后的定稿）；所有参与者和主席都拿同一份。 */
export function dataContextBlock(dataContext) {
  if (!dataContext?.text) return '';
  return [
    '## 实时数据（讨论前用数据工具查的生产数据、日志、监控或部署状态，已经调研员审查；每条都写了查询条件）',
    '讨论要以这里的数据为准。数据只代表写明的查询条件和时间范围；标了「至少」「不完整」「查不了」的不要当成全部或当成没有。',
    '',
    dataContext.text,
  ].join('\n');
}

/** 能查实时数据时，参与者怎么提要查数据的问题。 */
export function dataAskLine() {
  return `**数据核实**：需要生产数据、日志、监控或部署状态才能回答、又会影响结论的问题，也写进「**${FACT_HEADING}**」，每行一个具体问题，写清对象、范围和时间，例如「近 7 天 hotel 订单里供应商 X 的取消率是多少？」。核实员会用数据工具查、调研员审查后发给所有人。`;
}

/** 用数据工具查证的写法：开场查数据、讨论中核实、审查共用。 */
export function dataRules() {
  return [
    '## 查数据的要求',
    '- 只用放行的数据工具，只读；不要尝试任何写操作。先看业务知识（有的话）确认该查哪个库、表、服务，以及时间列是什么时区，再去查。',
    '- 每条结论都写明用的工具和查询条件（环境、库表或服务、过滤条件、时间范围和时区），写到别人能照着复查。',
    '- 工具末行写了 limit_reached 或 truncated 的，结果不完整，写「至少 N 条」「结果不完整」，不能当成全部。',
    '- 报 NO_TOKEN（没有权限）、LOGIN_REQUIRED（登录过期）或其他错误的，写「查不了：原因」，不能写成「没有数据」。',
    '- 「没查到」只在查询成功、结果完整时成立，而且要附上查询条件。',
    '- 线上数据、日志、监控、部署这类问题用数据工具查，不要写「代码回答不了」。',
  ].join('\n');
}

/** 追加在核实、审查提示词后面：能用的数据工具、业务知识和查数据的规则。 */
export function evidenceBlock({ toolsNote = '', knowledgeBlock = '' } = {}) {
  if (!toolsNote && !knowledgeBlock) return '';
  return join(
    '## 另外可以用的证据',
    toolsNote,
    knowledgeBlock,
    toolsNote ? dataRules() : '',
  );
}

/** 核实员实际执行的查询，交给调研员审查。 */
export function toolCallsBlock(calls, who = '核实员') {
  if (!calls?.length) return '';
  const lines = calls.map((c, i) => {
    const state = c.denied ? '被拒（不在放行名单）' : c.isError ? '出错' : `返回 ${c.resultChars ?? 0} 字`;
    return `${i + 1}. ${c.name} ${JSON.stringify(c.input ?? {}).slice(0, 600)} → ${state}`;
  });
  return `## ${who}的查询记录（工具、参数和结果大小；审查时重点看查的对象、环境、时间范围和时区对不对，必要时自己重查）\n${lines.join('\n')}`;
}

/** 开场：主席判断要不要在讨论前查实时数据。 */
export function dataPlanPrompt({ topic, interjections, toolsNote = '' }) {
  return join(
    `【阶段：${STAGE_LABELS.dataplan}】`,
    [
      '你是「主席」。一场多 AI 方案讨论马上开始，核实员和调研员可以用数据工具只读查生产数据、日志、监控和部署状态。你先判断：要不要在讨论前查一些实时数据，给参与者当背景。',
      '只有当结论明显取决于现在的线上事实时才需要，例如数据量和分布、错误率和耗时、配置的当前值、服务现在部署的版本、某类记录有没有。纯粹的取舍、代码怎么写、常识性的问题不需要。',
    ].join('\n'),
    `## 议题\n${String(topic ?? '').trim()}`,
    interjectionBlock(interjections),
    toolsNote,
    [
      '## 输出格式',
      '第一行只能写「查数据：需要」或「查数据：不需要」。',
      '写「需要」时，接着写一节「**要查的问题**」，每行一个具体问题（最多 6 个），写清对象、范围和时间，例如「- 近 7 天 hotel 订单按供应商的取消率分布」。',
      '写「不需要」时，接着用一句话说明原因。不要写别的。',
    ].join('\n'),
  );
}

/** 解析主席的查数据判断：{ need, questions }。 */
export function parseDataPlan(text) {
  return parsePlan(text, '查数据');
}

/** 解析「<关键词>：需要 / 不需要」加「要查的问题」列表；联网搜集和查数据共用。 */
function parsePlan(text, keyword) {
  const t = String(text ?? '');
  const re = (word) => new RegExp(`${keyword}\\**\\s*[:：]\\s*\\**\\s*${word}`);
  const need = re('需要').test(t) && !re('不需要').test(t);
  if (!need) return { need: false, questions: [] };
  const start = t.search(/要查的问题/);
  const lines = (start >= 0 ? t.slice(start).split('\n').slice(1) : []);
  const questions = [];
  for (const raw of lines) {
    const m = /^\s*(?:[-*]|\d+[.、)])\s+(.+)$/.exec(raw);
    if (m) questions.push(m[1].trim());
    else if (raw.trim() && questions.length) break;
  }
  return { need: questions.length > 0, questions: questions.slice(0, 6) };
}

/** 用数据工具查证的初稿（开场查数据，或讨论中本场既没代码也不联网时的核实）。 */
export function dataCheckPrompt({ round, topic, questions, who = '核实员', maxChars = 4000, opening = false, draft = true }) {
  const draftNote = draft ? '你写的是初稿：调研员会逐条审查、纠正后，定稿才发给参与者。' : '参与者会直接以你的回答为准。';
  return join(
    `【阶段：${opening ? STAGE_LABELS.dataresearch : `第 ${round} 轮${STAGE_LABELS.factcheck}`}】`,
    opening
      ? `你是「${who}」。一场多 AI 方案讨论马上开始，主席列出了下面这些需要查实时数据的问题，请用数据工具查清后整理成背景资料。${draftNote}`
      : `你是「${who}」。讨论参与者提出了下面这些需要核实的问题，他们会以核实结果为准修改方案。${draftNote}`,
    opening ? `## 议题\n${String(topic ?? '').trim()}` : '',
    `## ${opening ? '要查的问题' : '待核实的问题'}\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
    [
      '## 要求',
      '- 逐条回答，编号和问题一致。每条先写结论（具体的数、状态或有无），再写依据和查询条件。',
      '- 数据工具回答不了的（例如代码怎么写、业务决策）写「数据回答不了」。',
      `- 不要提建议，不要评价方案。全文不超过 ${maxChars} 字，只输出回答本身。用中文，使用 Markdown 的加粗和列表，不要使用表格和 # 标题。`,
    ].join('\n'),
  );
}

/** 数据核实的审查：调研员同样能用数据工具，复查核实员的查询，纠正后输出定稿。 */
export function dataReviewPrompt({ round, topic, questions, draft, checker = '核实员', maxChars = 4000, opening = false }) {
  return join(
    `【阶段：${opening ? STAGE_LABELS.datareview : `第 ${round} 轮${STAGE_LABELS.factreview}`}】`,
    `你是「调研员」，这次负责审查。「${checker}」已经用数据工具查过下面的问题，写了初稿。初稿还没有发给讨论参与者：你审查、纠正之后的定稿才会发出去，主笔和评审会以定稿为准，所以每条结论都必须站得住。`,
    opening ? `## 议题\n${String(topic ?? '').trim()}` : '',
    `## ${opening ? '要查的问题' : '待核实的问题'}\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
    `## ${checker}的初稿\n${draft}`,
    reviewRules(maxChars),
  );
}

/** 审查的写法：代码、联网之外的数据审查用；查询记录另外附在后面。 */
function reviewRules(maxChars) {
  return [
    '## 审查要求',
    '- 逐条复查：查的对象（环境、库表、服务）、过滤条件、时间范围和时区对不对；结果是否完整（有没有用满上限、被截断）；结论是否超出了数据能支撑的范围。拿不准的自己用工具重查。',
    '- 有错就改，漏了就补；查不了或数据撑不住的结论，改成「查不了：原因」或「数据回答不了」，不要保留。',
    '- 第一行写审查结论：「**审查**：共 N 条，全部无误」或「**审查**：共 N 条，M 条有更正（第 x、y 条）」。',
    '- 然后写定稿：逐条回答，编号和问题一致，每条先写结论，再写依据和查询条件。更正过的条目在结论前标「【已更正】」，再用一句话说明初稿错在哪里。参与者看不到初稿，定稿要完整独立，不要写「同初稿」。',
    `- 不要提建议，不要评价方案。全文不超过 ${maxChars} 字，只输出审查结论和定稿。用中文，使用 Markdown 的加粗和列表，不要使用表格和 # 标题。`,
  ].join('\n');
}

/** 数据核实时也能联网（本场无代码、选了核实员）：只用来查公开资料。 */
export function webAlsoLine() {
  return `**也可以联网**：需要公开资料（开源软件或云服务的行为、公开标准、厂商文档）时可以用 WebSearch、WebFetch，结论写来源链接。${NO_INTERNAL}公司内部的数据用数据工具查，不要去搜。`;
}

// ---------- 快问：回答 → 挑刺 → 定稿，共 3 次调用 ----------

/** 快问里带上的知识来源：索引；能读本机文件的模型（claude-cli）还能按需打开正文。 */
function quickKnowledgeBlock(knowledge, canRead) {
  if (!knowledge) return '';
  return join(
    knowledge,
    canRead
      ? '上面的知识来源你可以用 Read / Grep / Glob 打开（只读）。和问题相关时先查再答，引用时写来源名和相对路径。'
      : '上面只是知识来源的索引，你打不开正文；只在索引本身能说明问题时引用，不要猜正文内容。',
  );
}

/** 快问第一步：回答。不停下来反问，缺的信息列出来。 */
export function quickAnswerPrompt({ knowledge = '', canRead = false } = {}) {
  return join(
    `【阶段：${STAGE_LABELS.quickanswer}】`,
    quickKnowledgeBlock(knowledge, canRead),
    [
      '请回答上面的问题。',
      '- 先给结论，再给理由。问题有歧义时按最合理的理解回答，并说明你是怎么理解的。',
      '- 不要停下来反问。回答依赖、但问题里没给的信息，单独列在「**需要补充的信息**」下，每条写清补上之后结论可能怎样变。',
      '- 开头写「**要点**」，不超过 3 行；正文不超过 1500 字。',
    ].join('\n'),
  );
}

/** 快问第二步：另一位 AI 挑刺。 */
export function quickChallengePrompt({ answer, knowledge = '', canRead = false, items = false }) {
  return join(
    `【阶段：${STAGE_LABELS.challenge}】`,
    `## 另一位 AI 的回答（匿名）\n${answer}`,
    quickKnowledgeBlock(knowledge, canRead),
    [
      '你的任务是挑刺，帮提问人发现自己和回答者都没想到的地方：',
      '- 回答里错了或站不住的地方；',
      '- 提问人可能没考虑到的盲点、风险、反例，或者更简单的做法；',
      '- 回答依赖、但没说出来的前提。',
      '只写成立且会改变判断的问题，每条写清为什么、会怎样；回答没问题的地方不用夸。没有实质问题就直接说没有。',
      items
        ? `开头写「**要点**」，不超过 3 行，只用文字说，不写【阻断】【建议】这类标记；然后单独一行「**问题**」，下面是条目；正文不超过 800 字（依据不计）。\n${itemFormat({ levels: '【阻断】（不改回答就错了或会误导提问人）【建议】（改了更好）', need: '- 【阻断】必须写改法和依据。' })}`
        : '开头写「**要点**」，不超过 3 行；正文不超过 800 字。',
    ].join('\n'),
  );
}

/** 快问第三步：回答者吸收挑刺，按快问大纲定稿成短文档。 */
export function quickFinalPrompt({ answer, challenge }) {
  return join(
    `【阶段：${STAGE_LABELS.quickfinal}】`,
    `## 你的回答\n${answer}`,
    challenge ? `## 挑刺（另一位 AI 的意见，匿名）\n${challenge}` : '## 挑刺\n这次挑刺没有成功，只按你的回答定稿，「你可能没考虑到的」写你自己能想到的。',
    '请吸收挑刺里成立的意见，把回答定稿成给提问人看的短文档。',
    docRules('quick'),
    docFormat(),
  );
}

/** 快问的追问：只靠现在的快问文档回答，不重新讨论。 */
export function quickFollowUpPrompt({ doc, version, attachments = {}, followUps = [], question, knowledge = '', canRead = false, redraft = false }) {
  const asked = followUps.filter((f) => f.question && f.answer);
  return join(
    `【阶段：${STAGE_LABELS.answer}】`,
    `## 现在的${redraft ? '改稿文档' : '快问文档'}（第 ${version} 版）\n${doc}`,
    attachmentsBlock(attachments),
    asked.length ? `## 之前的追问（按时间先后）\n${asked.map((f, i) => `### ${i + 1}. ${f.question.trim()}\n${f.answer}`).join('\n\n')}` : '',
    quickKnowledgeBlock(knowledge, canRead),
    `## ${redraft ? '作者' : '提问人'}的追问\n${question.trim()}`,
    [
      redraft
        ? '请直接回答这次追问。作者要求再改的，说清怎么改、改哪几段（完整的修改稿接下来更新文档时再写），不要在这里贴整章。'
        : '请直接回答这次追问。追问补充了信息的，说明它怎样改变原来的结论；推翻了原来的结论就直接说。',
      '- 先给结论，再给理由；不要停下来反问，缺的信息照样列出来。',
      '- 开头写「**要点**」，不超过 3 行；正文不超过 1200 字。',
    ].join('\n'),
  );
}

// ---------- 粘贴式改稿：改稿 → 挑刺 → 定稿，共 3 次调用 ----------

/** 改稿第一步：按要求改，修改后的完整章节写在「【完整方案】」之后（只交给挑刺的一方和定稿时用，卡片上折叠）。 */
export function redraftPrompt() {
  return join(
    `【阶段：${STAGE_LABELS.redraft}】`,
    [
      '请按作者的要求修改上面的章节原文。',
      '- 先写「**要点**」，不超过 3 行：这次最主要的改动；然后用几条列表说明改了哪里、为什么，不超过 600 字。',
      `- 然后单独一行写「${PLAN_MARKER}」，下面是修改后的完整章节：整章完整写出，没改的段落也照抄，保持原文分段，不要加标题、批注或解释。`,
      '- 设定和人设以作者给的为准，不要擅自改人名、地名和已经发生的情节。',
    ].join('\n'),
  );
}

/** 改稿第二步：另一位 AI 对照原文挑刺。 */
export function redraftChallengePrompt({ notes, draft, items = false }) {
  return join(
    `【阶段：${STAGE_LABELS.challenge}】`,
    notes ? `## 改稿的一方说明的改动（匿名）\n${notes}` : '',
    `## 修改稿\n${draft}`,
    [
      '对照上面的章节原文和设定，给这份修改稿挑刺：',
      '- 改坏了的地方：节奏、情绪、信息量变差，或者原文的好东西被删掉了；',
      '- 和设定、人设、前情冲突的地方；',
      '- 作者的要求没做到或做过头的地方；',
      '- 还能明显更好的地方（给出具体改法，指明是哪一段）。',
      '只写成立且值得改的问题，每条指明位置（引用原句开头几个字）；没有实质问题就直接说没有。',
      items
        ? `开头写「**要点**」，不超过 3 行，只用文字说，不写【阻断】【建议】这类标记；然后单独一行「**问题**」，下面是条目；正文不超过 800 字（依据不计）。\n${itemFormat({ levels: '【阻断】（不改这版就不该采用）【建议】（改了更好）', need: '- 【阻断】必须写改法和依据。问题里指明位置（引用原句开头几个字）；依据可以引用原文或设定里的句子，算作资料。' })}`
        : '开头写「**要点**」，不超过 3 行；正文不超过 800 字。',
    ].join('\n'),
  );
}

/** 改稿第三步：改稿的一方吸收挑刺，写修改说明，并在附录里给出完整的修改稿。 */
export function redraftFinalPrompt({ notes, draft, challenge }) {
  return join(
    `【阶段：${STAGE_LABELS.redraftfinal}】`,
    notes ? `## 你说明的改动\n${notes}` : '',
    `## 你的修改稿\n${draft}`,
    challenge ? `## 挑刺（另一位 AI 的意见，匿名）\n${challenge}` : '## 挑刺\n这次挑刺没有成功，只按你的修改稿定稿，「没采纳的意见」写「无」。',
    '请吸收挑刺里成立的意见，定稿：写出修改说明，并在【附录：修改稿】里给出修改后的完整章节。',
    docRules('redraft'),
    docFormat(),
  );
}

// ---------- 征询人：每轮结束后主席判断要不要停下来问人 ----------
//
// 人跟不上讨论的速度，很少主动插话；讨论跑偏要等结束才知道。
// 每轮结束后由主席看一眼现状，只有需要人来定、而且现在不问会走偏或白跑时才问，问了就暂停，一直等到人回答。

export const ASK_LINE = '是否需要问人';
export const ASK_MAX_QUESTIONS = 3;

/** 主席的征询判断：给最新方案、这一轮的意见、人说过的话和问过的问题。 */
export function askCheckPrompt({ mode, round, finals = [], entries = [], heard = [], asks = [], abandoned = [], remaining = null }) {
  const plans = mode === 'brainstorm'
    ? (finals.length ? `## 各主笔目前的脑洞（匿名）\n${labeled(finals)}` : '')
    : (finals.some((e) => e.plan) ? finalsBlock(finals, mode === 'refine' ? '各主笔目前的修改方案' : '各主笔目前的方案') : (finals.length ? `## 各主笔目前的方案（匿名）\n${labeled(finals)}` : ''));
  const said = heard.filter((m) => !m.answerTo);
  return join(
    `【阶段：第 ${round} 轮${STAGE_LABELS.askcheck}】`,
    plans,
    entries.length ? `## 这一轮的意见（匿名）\n${labeled(entries)}` : '',
    abandoned.length ? `## 已经放弃的脑洞\n${abandoned.map((a) => `- ${a.code}`).join('\n')}` : '',
    said.length ? `## 人类主持人说过的话\n${said.map((m) => `- ${m.text}`).join('\n')}` : '',
    asks.length
      ? `## 之前问过人的问题\n${asks.map((a) => `### 第 ${a.round} 轮问的\n${a.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n**人的回答**：${a.answer ?? '（还没回答）'}`).join('\n\n')}`
      : '',
    [
      '你是主持这场讨论的人，现在判断：要不要暂停讨论，向人类主持人问几个问题。问了以后讨论会一直停着，直到人回答，所以只在值得打断人的时候问。',
      '**该问**：',
      '- 题目或要求里没写清、各方理解不一致，按哪种理解做结论完全不同；',
      '- 方向卡在两三个都说得通的选项之间，取舍取决于人的偏好、目标、预算或资源，不是讨论能推出来的；',
      '- 讨论正在偏离人在题目和插话里明确说过的要求，或者各方都默认了一个人没说过的前提；',
      '- 主笔和评审、或评审之间僵住了，只有人能裁决。',
      '**不该问**：模型能自己查到或推理出的事实；写到最后、由主文档列给人拍板也来得及的细节；人已经回答过的；只是为了确认或礼貌。拿不准就不问。',
      remaining === null ? '' : `这场讨论还能再问 ${remaining} 次。`,
      '',
      '按下面的格式回答：',
      `第一行：「${ASK_LINE}：需要」或「${ASK_LINE}：不需要」。`,
      `需要时，下面每行一个问题，编号 1、2、3，最多 ${ASK_MAX_QUESTIONS} 个。每个问题写成人一两句话就能回答的样子：先说要人定什么，把可选的答案列出来，最后用「——」接一句为什么现在要问（不问的话讨论会怎样）。不要用代号，人没看过讨论，要用内容本身说清楚。`,
      '不需要时，第二行用一句话说明理由。',
    ].join('\n'),
  );
}

/** 解析征询判断：{ need, questions }；格式不对按不需要处理。 */
export function parseAsk(text) {
  const s = String(text ?? '');
  const m = new RegExp(`${ASK_LINE}\\**\\s*[:：]\\s*\\**\\s*(需要|不需要)`).exec(s);
  if (!m || m[1] !== '需要') return { need: false, questions: [] };
  const questions = s.slice(m.index + m[0].length).split('\n')
    .map((l) => /^\s*(?:[-*]\s*)?\**\s*(\d+)\s*[.、)）]\s*\**\s*(.+)$/.exec(l)?.[2]?.trim())
    .filter(Boolean)
    .slice(0, ASK_MAX_QUESTIONS);
  return { need: questions.length > 0, questions };
}
