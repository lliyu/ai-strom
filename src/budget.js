import { splitReply } from './modes.js';

/**
 * 主席输入预算：汇总、追问判断、追问后更新主文档、补写主文档都要把讨论记录和核实结果拼进一次调用，
 * 讨论越长、追问越多就越长，原来没有上限。这里按预算装填：
 *
 * - 必须保留、不缩略（由调用方放在提示词里，允许超出预算）：各主笔的最终方案、现在的主文档 / 上次汇总、
 *   之前追问的回答、用户的全部插话、这次的追问。
 * - 可缩略：讨论记录（按轮）和核实结果，从新到旧放入。放不下时，较早的轮次只留每条发言的要点，
 *   较早的核实只留问题和回答开头 200 字；要点也放不下的更早部分整段省略，并注明省略范围。
 *
 * 预算 = 主席上下文窗口 × CHAIR_SHARE ÷ 每字 tokens 数。每字 tokens 数从本场无会话、单回合的调用里学
 * （tokens ÷ 提示词字数），存进 state.json；没有记录时按 DEFAULT_TOKENS_PER_CHAR 估。
 */

export const CHAIR_SHARE = 0.5;
/** 参与者新会话（fresh 追问、会话轮换）的预算：窗口的 40%。 */
export const PARTICIPANT_SHARE = 0.4;
export const DEFAULT_TOKENS_PER_CHAR = 2;
/** 主席的窗口不知道时（第一次调用之前、配置里也没写）按这个估，宁小勿大。 */
export const DEFAULT_WINDOW = 200000;
export const FACT_HEAD_CHARS = 200;
const BRIEF_FALLBACK_CHARS = 150;

const entryChars = (e) => (e.text?.length ?? 0) + 24;
const BRIEF_MAX_CHARS = 300;
const cut = (t, n) => (t.length > n ? `${t.slice(0, n)}…` : t);
/** 要点：发言开头的「要点」一节（模型偶尔写长，最多留 300 字）；没写要点时取开头 150 字。 */
const briefOf = (e) => {
  const brief = splitReply(e.text ?? '').brief;
  return brief ? cut(brief, BRIEF_MAX_CHARS) : cut(String(e.text ?? ''), BRIEF_FALLBACK_CHARS);
};

function compactRound(r) {
  return { ...r, compact: true, entries: r.entries.map((e) => ({ ...e, text: `（较早的轮次，只留要点）\n${briefOf(e)}`, plan: undefined })) };
}

function compactFact(f) {
  const long = f.answer.length > FACT_HEAD_CHARS;
  return { ...f, compact: true, answer: long ? `${f.answer.slice(0, FACT_HEAD_CHARS)}…（较早的核实，只留开头）` : f.answer };
}

const roundChars = (r) => r.entries.reduce((n, e) => n + entryChars(e), 40);
const factChars = (f) => f.questions.reduce((n, q) => n + q.length + 4, 0) + f.answer.length + 40;

/** 连续的轮次写成「第 3–7 轮」。 */
function spans(nums) {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const out = [];
  for (const n of sorted) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `第 ${a} 轮` : `第 ${a}–${b} 轮`)).join('、');
}

/**
 * 按预算（字数）装填讨论记录和核实结果，从新到旧。
 * 返回 { rounds, facts, note, stats }：rounds / facts 仍按时间顺序；note 是给主席的省略说明（没有省略时为空）。
 */
export function fitHistory({ rounds = [], facts = [], budgetChars }) {
  const items = [
    ...rounds.map((r, i) => ({ kind: 'round', round: r.round, order: i, ref: r })),
    ...facts.map((f, i) => ({ kind: 'fact', round: f.round, order: i, ref: f })),
  ];
  // 新的在前；同一轮里讨论在核实之后（核实在那一轮开始前做）
  items.sort((a, b) => b.round - a.round || (a.kind === b.kind ? b.order - a.order : a.kind === 'round' ? -1 : 1));
  let left = Math.max(0, budgetChars);
  let level = 'full';
  for (const it of items) {
    const full = it.kind === 'round' ? roundChars(it.ref) : factChars(it.ref);
    if (level === 'full' && full <= left) {
      it.keep = it.ref;
      left -= full;
      continue;
    }
    if (level !== 'drop') {
      level = 'compact';
      const small = it.kind === 'round' ? compactRound(it.ref) : compactFact(it.ref);
      const cost = it.kind === 'round' ? roundChars(small) : factChars(small);
      if (cost <= left) {
        it.keep = small;
        left -= cost;
        continue;
      }
      level = 'drop';
    }
    it.keep = null;
  }
  const back = (kind) => items.filter((x) => x.kind === kind).sort((a, b) => a.order - b.order);
  const keptRounds = back('round').map((x) => x.keep).filter(Boolean);
  const keptFacts = back('fact').map((x) => x.keep).filter(Boolean);
  const compactRounds = back('round').filter((x) => x.keep?.compact).map((x) => x.round);
  const droppedRounds = back('round').filter((x) => !x.keep).map((x) => x.round);
  const compactFacts = back('fact').filter((x) => x.keep?.compact).length;
  const droppedFacts = back('fact').filter((x) => !x.keep).map((x) => x.round);
  const lines = [];
  if (droppedRounds.length) lines.push(`${spans(droppedRounds)}的讨论记录因篇幅省略。`);
  if (compactRounds.length) lines.push(`${spans(compactRounds)}的讨论记录只留了每条发言的要点。`);
  if (droppedFacts.length) lines.push(`${spans(droppedFacts)}的代码核实结果因篇幅省略。`);
  if (compactFacts) lines.push(`较早的 ${compactFacts} 次代码核实只留了问题和回答开头。`);
  if (lines.length) lines.push('省略或缩略的部分，以各主笔的最终方案、仍保留的讨论记录和核实结果为准；不要凭空补写省略部分的内容。');
  return {
    rounds: keptRounds,
    facts: keptFacts,
    note: lines.join('\n'),
    stats: {
      trimmed: lines.length > 0,
      rounds: rounds.length,
      compactRounds: compactRounds.length,
      droppedRounds: droppedRounds.length,
      facts: facts.length,
      compactFacts,
      droppedFacts: droppedFacts.length,
    },
  };
}

/** 预算换算：字数 = 窗口 × 比例 × factor ÷ 每字 tokens 数。 */
export function budgetChars({ window, share = CHAIR_SHARE, factor = 1, tokensPerChar }) {
  const w = window || DEFAULT_WINDOW;
  const r = tokensPerChar > 0 ? tokensPerChar : DEFAULT_TOKENS_PER_CHAR;
  return Math.floor((w * share * factor) / r);
}

/**
 * 旧讨论的 state.json 里没有预算数据：从它的 usage.jsonl 推出各模型的窗口和每字 tokens 数，
 * 免得追问时主席的窗口未知、按保守的默认值把讨论记录缩略得太多。
 * rows：usage.jsonl 的各行（已解析）。
 */
export function budgetFromUsage(rows, { minChars = 2000 } = {}) {
  const speakers = new Map();
  const started = new Map();
  const windows = {};
  const tokenRatios = {};
  for (const r of rows) {
    if (r.type === 'run_started') {
      for (const sp of [...(r.participants ?? []), r.chair, r.research].filter(Boolean)) speakers.set(sp.id, sp);
    }
    const key = `${r.speaker}|${r.stage}|${r.round}`;
    if (r.type === 'call_started') started.set(key, r);
    if (r.type !== 'call_finished') continue;
    const sp = speakers.get(r.speaker);
    if (!sp) continue;
    if (r.contextWindow) windows[`${sp.provider}:${sp.model ?? ''}`] = r.contextWindow;
    const chars = started.get(key)?.promptChars ?? 0;
    const single = !r.turns || r.turns <= 1;
    const first = r.sessionTurn === undefined || r.sessionTurn === 1;
    if (single && first && chars >= minChars && r.inputTokens > 0) tokenRatios[sp.provider] = Math.round((r.inputTokens / chars) * 1000) / 1000;
  }
  return { windows, tokenRatios };
}
