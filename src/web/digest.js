import { isBlockerLine, parseVerdict } from '../modes.js';

/**
 * 网页读取时派生的结构化信息：发言分组、评审结论与阻断、主文档切段、阻断区块。
 * 都是纯函数，不落盘：历史讨论马上能用，规则改了旧讨论自动跟着变；群卡片不受影响。
 * 解析不出时如实返回「未识别」（null），不当成 0 或「无」。
 */

// ---------- 发言分组 ----------

/** 归「背景」组的阶段：调研、资料、数据、无代码说明、追问判断。 */
const BACKGROUND = new Set(['research', 'nocode', 'webplan', 'webresearch', 'webreview', 'dataplan', 'dataresearch', 'datareview', 'triage']);
/** 归「收尾」组的阶段：它们的 round 是最后一轮或最后一轮加 1，不按轮次归组。 */
const CLOSING = new Set(['doccheck', 'doc', 'blockers', 'fallback', 'verify', 'summary', 'rewrite', 'answer']);

/**
 * 给每条发言算组键（同一次运行内）：背景 / 第 N 轮 / 收尾；插话等没有轮次的继承上一条的组；
 * 没有 meta 的开场、结束、追问开场卡不进组（groupKey 为 null），原位显示。
 * 页面只合并相邻的同组卡片，不重排、不丢卡片。
 * posts：[{ part, stage, round }]，按显示顺序。返回同样长度的 [{ groupKey, groupLabel }]。
 */
export function groupKeys(posts) {
  let prev = null; // 同一 part 里上一条有组的发言
  return posts.map((p, i) => {
    if (i > 0 && posts[i - 1].part !== p.part) prev = null;
    let g = null;
    if (!p.stage) g = null;
    else if (BACKGROUND.has(p.stage)) g = { groupKey: `${p.part}:bg`, groupLabel: p.part > 0 ? '追问判断与背景' : '背景' };
    else if (CLOSING.has(p.stage)) g = { groupKey: `${p.part}:end`, groupLabel: '收尾' };
    else if (Number.isFinite(p.round) && p.round > 0) g = { groupKey: `${p.part}:r${p.round}`, groupLabel: `第 ${p.round} 轮` };
    else if (Number.isFinite(p.round) && p.round === 0) g = { groupKey: `${p.part}:bg`, groupLabel: p.part > 0 ? '追问判断与背景' : '背景' };
    else g = prev ?? { groupKey: `${p.part}:bg`, groupLabel: p.part > 0 ? '追问判断与背景' : '背景' };
    if (g) prev = g;
    return g ?? { groupKey: null, groupLabel: null };
  });
}

// ---------- 评审结论与阻断 ----------

/** 要点和正文里的行首阻断行，同一行只算一次（去掉列表符号和加粗后比较），保留原文。 */
export function blockerLinesOf(...texts) {
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

/**
 * 一条评审发言的派生字段：verdict（done / continue / null 未识别）、blockerLines、blocked。
 * blocked：结论不是「没有意见了」并且有行首阻断行。失败卡片一律不算。
 */
export function critiqueDigest({ brief, body, error }) {
  if (error) return { verdict: null, blockerLines: [], blocked: false };
  const verdict = parseVerdict(`${brief ?? ''}\n${body ?? ''}`);
  const blockerLines = blockerLinesOf(brief, body);
  return { verdict, blockerLines, blocked: verdict !== 'done' && blockerLines.length > 0 };
}

/**
 * 阻断区块：统计最后一次含评审发言的运行（part），每位评审取这次运行里最近一次评审发言（失败卡片不算）。
 * posts 已带 critiqueDigest 的字段。laterVerdict：这次运行之后还有按裁决定稿的追问。
 * 返回 null 表示没有评审发言（没有评审的讨论、或还没轮到评审）。
 */
export function blockerSummary(posts, { laterVerdict = false } = {}) {
  const crit = posts.filter((p) => p.stage === 'critique' && !p.error);
  if (!crit.length) return null;
  const part = crit.at(-1).part;
  const mine = crit.filter((p) => p.part === part);
  const by = new Map();
  for (const p of mine) {
    const key = p.tag || p.speaker?.id;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(p);
  }
  const reviewers = [...by.entries()].map(([key, list]) => {
    const last = list.at(-1);
    const earlier = list.slice(0, -1).filter((p) => p.blocked).at(-1);
    return {
      tag: last.tag ?? null,
      name: last.speaker?.name ?? key,
      round: last.round ?? null,
      verdict: last.verdict,
      blocked: last.blocked,
      lines: last.blocked ? last.blockerLines : [],
      // 以前提过、最近一次没再提的：不写「已解除」，没有证据表明阻断真的解除了
      dropped: !last.blocked && earlier ? { round: earlier.round ?? null, lines: earlier.blockerLines } : null,
    };
  });
  const lastRound = Math.max(...mine.map((p) => p.round ?? 0));
  return {
    part,
    source: part > 0 ? `追问 ${part}` : '原讨论',
    round: lastRound || null,
    reviewers: reviewers.length,
    blocking: reviewers.filter((r) => r.blocked).length,
    unknown: reviewers.filter((r) => r.verdict === null && !r.blocked).length,
    rows: reviewers,
    beforeVerdict: Boolean(laterVerdict),
  };
}

// ---------- 主文档切段 ----------

/** 各模式主文档的段：key -> 认这一段的标题规则；required 缺任何一个就不切，显示全文。 */
const DOC_SECTIONS = {
  decision: {
    sections: { points: /^要点/, decisions: /拍板/, next: /^下一步/, risks: /^风险/ },
    required: ['points', 'decisions', 'next'],
  },
  brainstorm: {
    sections: { points: /^要点/, next: /^下一步/ },
    required: ['points', 'next'],
  },
  refine: {
    sections: { points: /^要点/, decisions: /拍板/ },
    required: ['points', 'decisions'],
  },
};

/** 按行首 `## ` 切段，跳过代码块里的 `##`。返回 { head（第一个 ## 之前）, sections: [{ title, text }] }。 */
export function splitH2(text) {
  const lines = String(text ?? '').split('\n');
  const head = [];
  const sections = [];
  let fence = null;
  for (const line of lines) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    }
    const h = !fence && !f ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) sections.push({ title: h[1].trim(), lines: [] });
    else (sections.length ? sections.at(-1).lines : head).push(line);
  }
  return { head: head.join('\n'), sections: sections.map((s) => ({ title: s.title, text: s.lines.join('\n').trim() })) };
}

/** 一句话结论：从「**一句话结论**：」一直取到第一个 `## ` 之前（主席有时写成多行）。没有返回 null。 */
export function oneLinerOf(head) {
  const lines = String(head ?? '').split('\n');
  const at = lines.findIndex((l) => /^\s*\**\s*一句话结论\s*\**\s*[:：]/.test(l));
  if (at < 0) return null;
  const first = lines[at].replace(/^\s*\**\s*一句话结论\s*\**\s*[:：]\s*\**\s*/, '');
  const text = [first, ...lines.slice(at + 1)].join('\n').trim();
  return text || null;
}

/** 「拍板」段里按 `###` 切小段，标题含「拍板」的排前面并标记；其余照常跟在后面。 */
function splitDecisions(text) {
  const parts = [];
  const lead = [];
  let fence = false;
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) fence = !fence;
    const h = !fence ? /^###\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) parts.push({ title: h[1].trim(), lines: [] });
    else (parts.length ? parts.at(-1).lines : lead).push(line);
  }
  const subs = parts.map((p) => ({ title: p.title, text: p.lines.join('\n').trim(), pick: /拍板/.test(p.title) }));
  return { lead: lead.join('\n').trim(), parts: [...subs.filter((s) => s.pick), ...subs.filter((s) => !s.pick)] };
}

/**
 * 把一版主文档按该模式登记的段切开。必需的段缺任何一个：failed 为 true，页面显示全文并提示「未能提取」。
 * 宁可不提取，也不提取错。没登记大纲的模式一律 failed。
 */
export function docSections(text, mode = 'decision') {
  const spec = DOC_SECTIONS[mode];
  if (!spec || !text) return { failed: true, missing: [], oneLiner: null };
  const { head, sections } = splitH2(text);
  const out = { failed: false, missing: [], oneLiner: oneLinerOf(head) };
  for (const [key, rule] of Object.entries(spec.sections)) {
    const hit = sections.find((s) => rule.test(s.title));
    out[key] = hit ? { title: hit.title, text: hit.text } : null;
  }
  if (out.decisions) out.decisions = { ...out.decisions, ...splitDecisions(out.decisions.text) };
  out.missing = spec.required.filter((k) => !out[k]);
  out.failed = out.missing.length > 0;
  return out;
}
