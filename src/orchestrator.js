import { randomUUID } from 'node:crypto';
import {
  STAGE_LABELS, participantSystem, chairSystem,
  proposePrompt, critiquePrompt, reviewPrompt,
  divergePrompt, feedbackPrompt, revisePrompt,
  researchSystem, researchPrompt, sharedSystem, parseVerdict, parseStanceChange,
  triagePrompt, parseTriage, stripTriageLine, followUpPrompt, parseVerdictPick, parseVerifyQuestions, finalPrompt, freshBlock, HANDLING_LABELS,
  rewriteSystem, rewritePrompt, parseRevision, SUBJECT_LABELS, FIELD_LABELS,
  docSystem, docPrompt, docUpdatePrompt, docRewritePrompt, docCheckPrompt, parseDocCheck, docFixPrompt, parseDoc, mergeAttachments, docLead, docTitle, docNoOf,
  limitsFor, splitReply, overLimit, compressPrompt, replyIssues, fixReplyPrompt, rewriteDrift, stripEvidence, hasBlocker, PLAN_MARKER, isUnchangedPlan, blockersBlock,
  lineStartBlockers, isPendingBlocker, blockerStatusText, blockerEntryText, assignIssueIds, trackIssues, reviewerNoOf,
  parseFactQuestions, factsBlock, factCheckPrompt, factReviewPrompt, parseReviewCorrections, codeAccessNote, factAskLine,
  webAskLine, webPlanPrompt, parseWebPlan, webResearchPrompt, webReviewPrompt,
  dataAskLine, webAlsoLine, evidenceBlock, toolCallsBlock, dataPlanPrompt, parseDataPlan, dataCheckPrompt, dataReviewPrompt,
  quickAnswerPrompt, quickChallengePrompt, quickFinalPrompt, quickFollowUpPrompt,
  redraftPrompt, redraftChallengePrompt, redraftFinalPrompt, REDRAFT_DEFAULT_ASK,
} from './modes.js';
import { resolveProviderSpec } from './config.js';
import { allowedToolsNote } from './tools/index.js';
import { describeRepo } from './repos.js';
import { estimateCost, priceFor } from './pricing.js';
import { fitHistory, budgetChars, CHAIR_SHARE, PARTICIPANT_SHARE } from './budget.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** 学每字 tokens 数时，提示词至少这么长。 */
export const MIN_RATIO_CHARS = 2000;
const PLAN_MARKER_LINE = PLAN_MARKER;
export const STATE_VERSION = 1;

/** 参与者分工：lead（主笔，出方案并多轮修订）或 reviewer（评审，只给主笔的方案提意见）。 */
export const partOf = (p) => (p.part === 'reviewer' ? 'reviewer' : 'lead');

function shuffle(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 每次讨论随机分配匿名代号，整场固定不变，便于互相引用。 */
export function assignLabels(participants, rng = Math.random) {
  const labels = new Map();
  shuffle(participants, rng).forEach((p, i) => labels.set(p.id, LETTERS[i]));
  return labels;
}

/** 主笔用「方案 A/B…」，评审用「评审 1/2…」，各自随机分配。 */
export function assignTags(participants, rng = Math.random) {
  const tags = new Map();
  const leads = participants.filter((p) => partOf(p) === 'lead');
  const reviewers = participants.filter((p) => partOf(p) === 'reviewer');
  shuffle(leads, rng).forEach((p, i) => tags.set(p.id, { label: LETTERS[i], tag: `方案 ${LETTERS[i]}` }));
  shuffle(reviewers, rng).forEach((p, i) => tags.set(p.id, { label: String(i + 1), tag: `评审 ${i + 1}` }));
  return tags;
}

/** 并发上限内依次执行。 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const byTag = (a, b) => a.tag.localeCompare(b.tag, 'zh-CN', { numeric: true });
const brief = (s) => ({ id: s.id, name: s.name, role: s.role, part: partOf(s), provider: s.provider, model: s.model, color: s.color, contextWindow: s.contextWindow });
const who = (list) => list.map((p) => `${p.name} · ${p.role}`).join(' / ');

/**
 * 一场讨论（或一次追问）共用的运行环境：发言、按阶段并发、插话、多轮循环。
 *
 * 会话：每位参与者一条会话（sessions），整场讨论接着聊，模型记得自己说过的话；
 * 每轮只发新内容。主席和调研员不用会话：主席只在汇总时拿到完整记录，调研员开场调研和中途核实都是一次性调用。
 */
function createRun({ cfg, providers, publisher, interjections, log, onEvent, tags, sessions, latest, rounds, facts = [], budget = {}, data = null }) {
  const emit = (e) => {
    try {
      onEvent(e);
    } catch (err) {
      log(`⚠️ 记录用量事件失败：${err.message}`);
    }
  };
  // 追问时只用原讨论里有代号的参与者（配置后来增减了人也不影响）
  const participants = cfg.participants.filter((p) => tags.has(p.id));
  const leads = participants.filter((p) => partOf(p) === 'lead');
  const reviewers = participants.filter((p) => partOf(p) === 'reviewer');
  const reviewerIds = new Set(reviewers.map((p) => p.id));
  const tagOf = (p) => tags.get(p.id).tag;
  // 条目里的 text 是给人看的部分；主笔写了「【完整方案】」时，完整方案单独放在 plan，给其他参与者和主席看
  const entryOf = (p, text) => {
    const { shown, plan } = splitReply(text);
    return { id: p.id, label: tags.get(p.id).label, tag: tagOf(p), text: shown, ...(plan ? { plan } : {}) };
  };
  const convo = cfg.conversation !== false;
  const heard = []; // 本次运行收到的插话
  const stats = { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const ideasPerAgent = cfg.ideasPerAgent ?? 3;
  const limits = limitsFor(cfg.mode, cfg.limits); // 脑洞风暴不限字数（null）
  const run = { participants, leads, reviewers, reviewerIds, tagOf, convo, heard, stats, emit, ideasPerAgent, limits, shared: '', truncations: 0 };
  /**
   * 代码目录（prepareRepos 的结果）：调研员确认议题涉及代码后才设置。
   * 有值时：readCode 的参与者发言时带只读工具；参与者列出的「待核实的事实」由调研员在下一轮开始前查代码回答。
   */
  run.code = null;
  /** 本场无代码、但网页阵容选了核实员：待核实的事实联网查（核实员答、调研员审查）。 */
  run.web = false;
  run.facts = [...facts]; // [{ round, questions, answer }]，追问时接着原讨论的
  const research = cfg.research ?? null;
  /**
   * 数据工具和业务知识（网页上选的）：{ selection, mcp, knowledge }。核实员和调研员核实、开场查数据时带上；
   * 参与者不直接用工具，只看审查后的定稿。
   */
  run.data = data && (data.mcp || data.knowledge) ? data : null;
  const hasData = () => Boolean(run.data?.mcp && research);
  const factChecking = () => Boolean((run.code || run.web || hasData()) && research && research.factCheck !== false);
  /** 核实、审查调用带上数据工具（MCP）和知识目录（只读）。 */
  const withEvidence = (callOptions = {}) => {
    if (!run.data) return callOptions;
    const k = run.data.knowledge;
    const tools = [...new Set([...(callOptions.tools ?? []), ...(k?.dirs?.length ? ['Read', 'Grep', 'Glob'] : [])])];
    return {
      ...callOptions,
      tools,
      addDirs: [...(callOptions.addDirs ?? []), ...(k?.dirs ?? [])],
      ...(run.data.mcp ? { mcp: run.data.mcp } : {}),
    };
  };
  /** 追加在核实、审查提示词后面的证据说明；没有数据工具和知识时为空。 */
  const evidence = () => (run.data ? evidenceBlock({ toolsNote: run.data.mcp ? allowedToolsNote(run.data.mcp) : '', knowledgeBlock: run.data.knowledge?.block ?? '' }) : '');
  const plus = (...parts) => parts.filter(Boolean).join('\n\n');
  run.evidence = evidence;
  run.withEvidence = withEvidence;
  /** 快问：发言者能不能自己打开知识来源的正文（只有 claude-cli 能带只读工具）。 */
  run.readsFiles = (p) => Boolean(run.data?.knowledge?.dirs?.length) && ['claude-cli', 'mock'].includes(resolveProviderSpec(cfg, p.provider)?.type);
  /** 快问：知识来源的索引（提示词里）和只读目录（能读文件的模型）。 */
  run.knowledgeFor = (p) => {
    const k = run.data?.knowledge;
    if (!k?.block) return { text: '', canRead: false, callOptions: {} };
    const canRead = run.readsFiles(p);
    return { text: k.block, canRead, callOptions: canRead ? { tools: ['Read', 'Grep', 'Glob'], addDirs: k.dirs } : {} };
  };
  const canReadCode = (p) => Boolean(run.code && research && p.readCode === true);
  const toldCode = new Set(); // 本次运行已经拿到完整目录说明的参与者

  /** 各阶段的字数上限：给人看的部分 max，完整方案 plan。 */
  const STAGE_LIMIT = { propose: 'propose', diagnose: 'propose', critique: 'critique', review: 'review', followup: 'followup', final: 'followup' };
  run.limitOf = (stage) => {
    const key = STAGE_LIMIT[stage];
    if (!limits || !key) return null;
    return { max: limits[key], brief: limits.brief, plan: ['review', 'followup', 'final'].includes(stage) ? limits.plan : undefined, tolerance: limits.tolerance };
  };

  /** 发给这位发言者的插话：会话模式只发它还没收到过的，非会话模式每轮都发全部。 */
  run.ijFor = (p) => (convo ? heard.slice(sessions.get(p.id)?.seen ?? 0) : heard);
  run.latestOthers = (p) => [...latest.values()].filter((e) => e.id !== p.id).sort(byTag);

  run.pullInterjections = async () => {
    if (!interjections) return;
    try {
      const fresh = await interjections.poll();
      if (fresh.length) {
        heard.push(...fresh);
        log(`收到 ${fresh.length} 条插话`);
      }
      // 网页上的插话群里看不到：由主席发一张卡片，大家知道模型在回应什么
      for (const m of fresh.filter((x) => x.source === 'web')) {
        await publisher.post({
          speaker: cfg.chair,
          title: `📝 ${m.sender}插话`,
          subtitle: '来自网页，下一轮交给所有模型',
          body: m.text,
          meta: { stage: 'interjection' },
        });
      }
    } catch (err) {
      log(`⚠️ 读取插话失败，本轮跳过：${err.message}`);
    }
  };

  const retryDelayMs = cfg.retryDelayMs ?? 5000;
  // 主席输入预算用：各模型的上下文窗口（provider:model）、各 provider 每字多少 tokens。随讨论状态保存，追问时接着用
  run.budget = { windows: { ...(budget.windows ?? {}) }, tokenRatios: { ...(budget.tokenRatios ?? {}) } };
  run.occupancy = new Map(); // 参与者 id -> 最近一次的上下文占用 { tokens, kind, pct }

  /**
   * 调一次模型并记账；失败时抛错。超时、5xx 这类临时故障（isTransient）隔 retryDelayMs 重试一次。
   * 会话还没开始（第一条消息）时重试换一个新的会话 id：上一次可能已经用这个 id 建了会话文件。
   */
  const call = async (speaker, opts) => {
    try {
      return await callOnce(speaker, opts);
    } catch (err) {
      if (!isTransient(err)) throw err;
      log(`⚠️ ${speaker.name} 调用失败（${err.message.slice(0, 120)}），${Math.round(retryDelayMs / 1000)} 秒后重试一次`);
      emit({ type: 'call_failed', speaker: speaker.id, stage: opts.stage, round: opts.round, error: err.message.slice(0, 500), durationMs: err.durationMs ?? 0, willRetry: true });
      if (retryDelayMs) await new Promise((res) => setTimeout(res, retryDelayMs));
      if (opts.session && !opts.session.turns.length) opts.session.id = randomUUID();
      return callOnce(speaker, { ...opts, retry: opts.retry ?? 'error' });
    }
  };

  const callOnce = async (speaker, { stage, round, system, prompt, callOptions = {}, session, retry }) => {
    const provider = providers.get(speaker.provider);
    stats.calls += 1;
    const started = Date.now();
    emit({ type: 'call_started', speaker: speaker.id, stage, round, promptChars: prompt.length + (system?.length ?? 0), ...(retry ? { retry } : {}) });
    try {
      const firstTurn = !session || !session.turns.length;
      const res = await provider.complete({ model: speaker.model, system, prompt, effort: speaker.effort, temperature: speaker.temperature, ...callOptions, ...(session ? { session } : {}) });
      if (session) session.turns.push({ prompt, reply: res.text });
      const window = speaker.contextWindow ?? res.contextWindow ?? null;
      res.occupancy = occupancyOf(res, { window, last: session?.contextTokens });
      if (window) run.budget.windows[`${speaker.provider}:${speaker.model ?? ''}`] = window;
      // 每字 tokens 数只从会话第一条（或无会话）、单回合的调用学：这时输入 tokens 正好对应这次的系统提示词加提示词
      const chars = prompt.length + (system?.length ?? 0);
      // 太短的提示词里 CLI 自带的固定开销占比大，算出来偏高，不用
      if (firstTurn && res.occupancy.kind === 'exact' && res.occupancy.tokens > 0 && chars >= MIN_RATIO_CHARS) {
        run.budget.tokenRatios[speaker.provider] = Math.round((res.occupancy.tokens / chars) * 1000) / 1000;
      }
      if (session) session.contextTokens = res.occupancy.tokens;
      if (tags.has(speaker.id)) run.occupancy.set(speaker.id, res.occupancy);
      if (res.truncated) {
        run.truncations += 1;
        log(`⚠️ ${speaker.name} 的输出到了长度上限，被截断了`);
      }
      // 接口不返回费用时（例如百炼），按配置的价格估算
      const estimate = res.costUsd == null ? estimateCost(priceFor(cfg, speaker, res.model), res.usage, new Date(started)) : null;
      if (estimate?.costUsd != null) res.costUsd = estimate.costUsd;
      stats.inputTokens += res.usage?.inputTokens ?? 0;
      stats.outputTokens += res.usage?.outputTokens ?? 0;
      stats.costUsd += res.costUsd ?? 0;
      emit({
        type: 'call_finished',
        speaker: speaker.id,
        stage,
        round,
        model: res.model,
        inputTokens: res.usage?.inputTokens ?? 0,
        outputTokens: res.usage?.outputTokens ?? 0,
        cacheReadTokens: res.usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: res.usage?.cacheWriteTokens ?? 0,
        contextWindow: window,
        // 上下文占用：inputTokens 在多回合调用（带工具）时是各回合的累计值，不能直接除以窗口
        contextTokens: res.occupancy.tokens,
        contextKind: res.occupancy.kind,
        contextPct: res.occupancy.pct,
        costUsd: res.costUsd ?? null,
        ...(estimate ? { costEstimated: true, costOriginal: { amount: estimate.amount, currency: estimate.currency, offPeak: estimate.offPeak } } : {}),
        durationMs: res.durationMs ?? Date.now() - started,
        truncated: Boolean(res.truncated),
        ...(res.turns ? { turns: res.turns } : {}),
        ...(res.toolCalls ? { toolCalls: res.toolCalls.length, toolDenied: res.toolCalls.filter((c) => c.denied).length } : {}),
        ...(session ? { sessionTurn: session.turns.length } : {}),
        ...(retry ? { retry } : {}),
      });
      return res;
    } catch (err) {
      err.durationMs = Date.now() - started;
      throw err;
    }
  };

  /**
   * 写入时检查（条目化开关打开时）：评审缺结论行、【阻断】缺改法或依据、主笔缺「立场变化」、超字数（依据不计）。
   * 有任何一项不合格，合并成一次重写，只补缺项或压缩；重写后评审结论变了或行首阻断变少了，用第一次的原文。
   * 仍不合格照常发布。每次检查都记一条 reply_check 事件，试跑时用来统计重写率。
   */
  run.checkReply = async (speaker, res, { stage, round, system, callOptions, session, limit, check }) => {
    const issues = replyIssues(res.text, { limit, ...check });
    const record = (result, extra = {}) => emit({ type: 'reply_check', speaker: speaker.id, stage, round, issues: issues.map((x) => x.kind), result, ...extra });
    if (!issues.length) {
      record('ok');
      return res;
    }
    log(`${speaker.name} 的发言不合要求（${issues.map((x) => x.note).join('；')}），要求补全重写`);
    let fixed;
    try {
      fixed = await call(speaker, {
        stage, round, system, callOptions, session, retry: 'fix',
        prompt: fixReplyPrompt({ issues, original: session ? null : res.text, limit }),
      });
    } catch (err) {
      log(`⚠️ ${speaker.name} 补全重写失败，用原回答：${err.message}`);
      record('rewrite-failed', { error: err.message.slice(0, 200) });
      return res;
    }
    if (!fixed.text?.trim()) {
      record('rewrite-empty');
      return res;
    }
    const drift = rewriteDrift(res.text, fixed.text);
    if (drift) {
      log(`⚠️ ${speaker.name} 重写后${drift}，用第一次的原文`);
      record('kept-original', { drift });
      return res;
    }
    // 重写时偶尔会丢掉完整方案：那就沿用第一次写的
    const before = splitReply(res.text).plan;
    const after = splitReply(fixed.text).plan;
    const text = before && !after ? `${fixed.text.trim()}\n\n${PLAN_MARKER_LINE}\n${before}` : fixed.text;
    const left = replyIssues(text, { limit, ...check });
    if (left.length) log(`${speaker.name} 重写后仍不合要求（${left.map((x) => x.note).join('；')}），照常发布`);
    record(left.length ? 'still-failing' : 'rewritten', left.length ? { left: left.map((x) => x.kind) } : {});
    return { ...fixed, text };
  };

  /**
   * 调研员读代码，整理成背景资料（方案讨论开场、快问回答前）。auto：没指定仓库，调研员从登记的仓库里按内容定位，
   * 判断不涉及代码时只回「无相关代码」，发一张「本场无代码」卡片、返回 null。
   * required：读失败时整场不开始（方案讨论）；否则记一行日志，不带代码接着跑（快问）。
   */
  run.codeResearch = async ({ topic, code, knowledgeOn = false, required = true }) => {
    const researcher = cfg.research;
    const text = await run.speak(researcher, {
      stage: 'research',
      round: 0,
      system: researchSystem(),
      prompt: [researchPrompt({ topic, mode: cfg.mode, repos: code.repos, docs: code.docs, maxChars: researcher.maxChars, auto: code.auto }), knowledgeOn ? run.data.knowledge.block : ''].filter(Boolean).join('\n\n'),
      callOptions: { tools: researcher.tools, addDirs: [...code.dirs, ...(knowledgeOn ? run.data.knowledge.dirs : [])], maxBudgetUsd: researcher.maxBudgetUsd, timeoutMs: researcher.timeoutMs },
      subtitle: code.auto ? '背景资料 · 按内容定位仓库' : `背景资料 · 读了 ${code.repos.map((r) => r.alias).join('、')}`,
    });
    if (!text) {
      if (required) throw new Error('代码调研失败，讨论没有开始');
      log('⚠️ 代码调研失败，不带代码接着回答');
      return null;
    }
    const cap = Math.round(researcher.maxChars * 1.5);
    if (code.auto && /^\s*无相关代码/.test(text)) {
      log('调研员判断内容不涉及登记的仓库，不带代码');
      await publisher.post({ speaker: cfg.chair, title: '本场无代码', subtitle: '代码上下文', body: '调研员判断内容不涉及登记的仓库。参与者不能查代码，也不会核实代码事实；涉及代码现状的说法都按未核实处理。', meta: { stage: 'nocode' } });
      return null;
    }
    return {
      auto: Boolean(code.auto),
      repos: code.repos,
      text: text.length > cap ? `${text.slice(0, cap)}\n\n（资料过长，后面的部分已截断）` : text,
    };
  };

  /** 问题追踪（第三期）：条目化打开的方案讨论和打磨里，评审的【阻断】【建议】由程序编号，主笔按编号回应。 */
  run.tracking = Boolean(cfg.items) && (cfg.mode === 'decision' || cfg.mode === 'refine');
  /** 评审和主笔修订的发布版本，按发生顺序，给问题追踪用。 */
  run.issueSpeeches = () => rounds.flatMap((x) => (x.stage === 'critique' || x.stage === 'review'
    ? x.entries.map((e) => ({ stage: x.stage, round: x.round, tag: e.tag, text: e.text })) : []));
  /** 给评审的「你提过、还没解决的问题」：最近一次发言仍在提的【阻断】。不追踪时返回 null。 */
  run.ownIssuesFor = (p) => {
    if (!run.tracking) return null;
    return trackIssues(run.issueSpeeches()).issues.filter((x) => x.owner === tagOf(p) && x.status === 'current' && x.level === '阻断');
  };
  /** 发布前给评审发言写编号：只动正文里的【阻断】【建议】，记一条 issue_ids 事件（沿用、新分配、剥掉的个数）。 */
  run.numberIssues = (speaker, text, round) => {
    const own = reviewerNoOf(tagOf(speaker));
    if (!own) return text;
    const used = new Set(trackIssues(run.issueSpeeches()).issues.filter((x) => x.owner === tagOf(speaker)).map((x) => x.id));
    const r = assignIssueIds(text, { own, used });
    emit({ type: 'issue_ids', speaker: speaker.id, round, kept: r.kept.length, assigned: r.assigned.length, stripped: r.stripped });
    return r.text;
  };

  /** 哪些发言要做写入时检查：评审（结论行、阻断）、主笔修订（立场变化）、快问和改稿的挑刺（阻断）。 */
  run.checkOf = (stage) => {
    if (!cfg.items) return null;
    if (stage === 'critique') return { verdict: Boolean(run.verdictAsked), blockers: true };
    if (stage === 'review') return { stance: true };
    if (stage === 'challenge') return { blockers: true };
    return null;
  };

  /**
   * 发言：调模型，超出字数上限（limit）时让它压缩重写一次，然后发布。
   * 卡片上只露出「要点」，详细内容折叠；「【完整方案】」之后的部分不发到群里。
   */
  run.speak = async (speaker, { stage, round, system, prompt, callOptions = {}, session, subtitle, quiet = false, limit = null, check = null, onResult }) => {
    const tag = tags.get(speaker.id)?.tag;
    const noRound = ['research', 'summary', 'triage', 'rewrite', 'doc', 'doccheck', 'webplan', 'webresearch', 'webreview', 'dataplan', 'dataresearch', 'datareview'].includes(stage);
    log(`${speaker.name} · ${STAGE_LABELS[stage]}${stage === 'research' ? '（只读查看代码，通常要几分钟）' : noRound ? '' : ` 第 ${round} 轮`} …`);
    try {
      let res = await call(speaker, { stage, round, system, prompt, callOptions, session });
      // 条目化开着、这类发言要检查格式时：合并检查、最多重写一次（代替单纯的压缩重写）
      const checking = cfg.items && check;
      if (checking) res = await run.checkReply(speaker, res, { stage, round, system, callOptions, session, limit, check });
      // 编号在写入检查（和重写）之后、发布之前写上：库里、讨论记录、群卡片和主笔看到的是同一份带编号的文本
      if (run.tracking && stage === 'critique' && res.text) res = { ...res, text: run.numberIssues(speaker, res.text, round) };
      const over = !checking && limit ? overLimit(cfg.items ? stripEvidence(res.text) : res.text, limit) : null;
      if (over) {
        log(`${speaker.name} 超出字数上限（${over}），要求压缩重写`);
        try {
          const shorter = await call(speaker, {
            stage, round, system, callOptions, session, retry: 'compress',
            prompt: compressPrompt({ over, original: session ? null : res.text, limit, items: cfg.items }),
          });
          if (shorter.text?.trim()) {
            // 压缩时偶尔会丢掉完整方案：那就沿用第一次写的
            const before = splitReply(res.text).plan;
            const after = splitReply(shorter.text).plan;
            res = { ...shorter, text: before && !after ? `${shorter.text.trim()}\n\n${PLAN_MARKER_LINE}\n${before}` : shorter.text };
          }
        } catch (err) {
          log(`⚠️ ${speaker.name} 压缩重写失败，用原回答：${err.message}`);
        }
      }
      onResult?.(res);
      if (!quiet) {
        const text = stage === 'triage' ? stripTriageLine(res.text) : res.text;
        const parts = splitReply(text);
        const callsNote = toolCallsNote(res.toolCalls);
        await publisher.post({
          speaker,
          title: `${speaker.name}${speaker.role ? ` · ${speaker.role}` : ''}`,
          subtitle: subtitle ?? `${noRound ? '' : `第 ${round} 轮 · `}${STAGE_LABELS[stage]}${tag ? ` · 代号 ${tag}` : ''}`,
          brief: parts.brief,
          body: `${parts.brief ? parts.detail : parts.shown}${callsNote}`,
          plan: parts.plan,
          footer: footerOf(res),
          meta: { stage, round, tag, model: res.model, usage: res.usage, durationMs: res.durationMs },
        });
      }
      return res.text;
    } catch (err) {
      stats.failures += 1;
      log(`⚠️ ${speaker.name} 发言失败：${err.message}`);
      emit({ type: 'call_failed', speaker: speaker.id, stage, round, error: err.message.slice(0, 500), durationMs: err.durationMs ?? 0 });
      await publisher.post({
        speaker,
        title: `${speaker.name} · 发言失败`,
        subtitle: noRound ? STAGE_LABELS[stage] : `第 ${round} 轮 · ${STAGE_LABELS[stage]}`,
        body: `这一轮没有拿到回答：${err.message}`,
        meta: { stage, round, tag, error: err.message },
      });
      return null;
    }
  };

  /** 让一组参与者并发发言，记录成一轮，返回成功的条目。 */
  run.runStage = async (list, round, stage, promptFor) => {
    const results = await mapLimit(list, cfg.concurrency, async (p) => {
      const session = convo ? sessions.get(p.id) : null;
      const seenNow = heard.length;
      const factsNow = run.facts.length;
      // 身份和规则只在会话的第一条消息里说一次；非会话模式每轮都要说
      const intro = session && session.turns.length ? '' : `${participantSystem(p, { mode: cfg.mode })}\n\n`;
      const fresh = run.freshFor(p, session);
      const code = run.codeFor(p, session);
      const text = await run.speak(p, { stage, round, system: run.shared, prompt: `${intro}${fresh}${code.text}${promptFor(p)}`, session, limit: run.limitOf(stage), check: run.checkOf(stage), callOptions: code.callOptions });
      if (text != null && session) {
        session.seen = seenNow;
        session.factsSeen = factsNow;
      }
      if (text != null && code.callOptions.tools) toldCode.add(p.id);
      return text;
    });
    const entries = list.map((p, i) => (results[i] == null ? null : entryOf(p, results[i]))).filter(Boolean).sort(byTag);
    rounds.push({ round, stage, entries });
    return entries;
  };

  /**
   * 这位参与者本次发言要额外带上的代码相关内容：新的核实结果、能否自己查代码、怎么提待核实的问题；
   * 能查代码时附带只读工具和目录。
   */
  /** 新会话追问（fresh）时第一条消息里带上的讨论现状；默认没有。runFollowUp 按需替换。 */
  run.freshFor = () => '';
  /** 能不能核实：有代码，或者本场无代码但可以联网。 */
  run.canCheck = () => factChecking();
  /** 追问时主席指定的核实问题，排到下一次核实里。 */
  run.queueQuestions = (qs) => {
    for (const q of qs) if (!asked.has(normQ(q)) && !pendingQuestions.some((x) => normQ(x) === normQ(q))) pendingQuestions.push(q);
  };

  run.codeFor = (p, session) => {
    const fresh = convo ? run.facts.slice(session?.factsSeen ?? 0) : run.facts;
    const parts = [];
    if (fresh.length) parts.push(factsBlock(fresh));
    let callOptions = {};
    if (run.code && canReadCode(p)) {
      const tools = research.tools ?? ['Read', 'Grep', 'Glob'];
      parts.push(codeAccessNote({ repos: run.code.repos, docs: run.code.docs, tools, full: !(convo && toldCode.has(p.id)) }));
      callOptions = { tools, addDirs: run.code.dirs, timeoutMs: research.timeoutMs, ...(p.maxBudgetUsd ? { maxBudgetUsd: p.maxBudgetUsd } : {}) };
    }
    if (factChecking()) {
      if (run.code) parts.push(factAskLine());
      else if (run.web) parts.push(webAskLine());
      if (hasData()) parts.push(dataAskLine());
    }
    return { text: parts.length ? `${parts.join('\n\n')}\n\n` : '', callOptions };
  };

  // 已经扫描过「待核实的事实」的轮次条目数；追问时从原讨论之后开始
  let factCursor = rounds.length;
  const normQ = (q) => q.replace(/\s+/g, '').replace(/[？?。.]+$/, '');
  const asked = new Set(run.facts.flatMap((f) => f.questions.map(normQ)));
  let pendingQuestions = [];
  run.pendingQuestions = () => [...pendingQuestions];
  // 核实连续失败 2 次（每次已含一次临时故障重试），下一批条数减半，直到 1 条；成功后恢复
  let factFailures = 0;
  let factBatch = null;
  /**
   * 收集上次核实之后参与者列出的「待核实的事实」，交给调研员查代码回答。
   * 有新结果时返回 true：这一轮不提前结束，主笔要先按核实结果修订。
   */
  run.factCheck = async (round) => {
    const fresh = [...pendingQuestions];
    for (const r of rounds.slice(factCursor)) {
      for (const e of r.entries) {
        for (const q of parseFactQuestions(`${e.text}\n${e.plan ?? ''}`)) {
          if (!asked.has(normQ(q)) && !fresh.some((x) => normQ(x) === normQ(q))) fresh.push(q);
        }
      }
    }
    factCursor = rounds.length;
    pendingQuestions = [];
    if (!factChecking() || !fresh.length) return false;
    const full = research.factCheckMaxQuestions ?? 8;
    const max = factBatch ?? full;
    const questions = fresh.slice(0, max);
    pendingQuestions = fresh.slice(max);
    if (pendingQuestions.length) log(`待核实的问题有 ${fresh.length} 个，这次先查 ${max} 个，其余留到下一轮`);
    // 本场无代码：能用数据工具时按数据核实（选了核实员的也可以联网），否则联网核实
    if (!run.code && hasData()) return run.dataFactCheck({ round, questions });
    if (!run.code && run.web) return run.webFactCheck({ round, questions });
    const tools = research.tools ?? ['Read', 'Grep', 'Glob'];
    const maxChars = research.factCheckMaxChars ?? 4000;
    const where = { repos: run.code.repos, docs: run.code.docs, tools, maxChars };
    const callOptions = withEvidence({ tools, addDirs: run.code.dirs, maxBudgetUsd: research.maxBudgetUsd, timeoutMs: research.timeoutMs });
    const checker = research.factChecker ?? null;
    const calls = {};
    const keep = (k) => (res) => { if (res.toolCalls?.length) calls[k] = res.toolCalls; };
    let answer = null;
    let review = null;
    let draft = null;
    if (checker) {
      // 两步：核实员（例如 Sonnet）读代码写初稿 → 调研员（Opus）审查纠正，定稿才发给主笔和评审
      draft = await run.speak(checker, {
        stage: 'factcheck',
        round,
        system: run.shared,
        prompt: plus(factCheckPrompt({ round, questions, ...where, who: checker.name, draft: true, items: cfg.items }), evidence()),
        callOptions: { ...callOptions, maxBudgetUsd: checker.maxBudgetUsd ?? research.maxBudgetUsd },
        subtitle: `第 ${round} 轮 · 代码核实初稿 · ${questions.length} 个问题 · 待调研员审查，不发给参与者`,
        onResult: keep('draft'),
      });
      if (draft) {
        answer = await run.speak(research, {
          stage: 'factreview',
          round,
          system: run.shared,
          prompt: plus(factReviewPrompt({ round, questions, draft, checker: checker.name, ...where, items: cfg.items }), evidence(), toolCallsBlock(calls.draft, checker.name)),
          callOptions,
          subtitle: `第 ${round} 轮 · 核实审查定稿 · ${questions.length} 个问题`,
          onResult: keep('review'),
        });
        // 审查失败时不把没审过的初稿发出去：这批问题留到下一轮
        if (answer) review = { checker: checker.model ?? checker.provider, corrections: parseReviewCorrections(answer) };
      } else {
        log(`${checker.name}没答出来，这次由调研员直接核实`);
      }
    }
    if (!answer && !(checker && draft)) {
      answer = await run.speak(research, {
        stage: 'factcheck',
        round,
        system: run.shared,
        prompt: plus(factCheckPrompt({ round, questions, ...where, items: cfg.items }), evidence()),
        callOptions,
        subtitle: `第 ${round} 轮 · 代码核实 · ${questions.length} 个问题`,
        onResult: keep('review'),
      });
    }
    return run.factDone({ round, questions, answer, review, draft, calls });
  };

  /** 本场无代码时联网核实：核实员联网写初稿，调研员联网审查纠正；审查没过不发。 */
  run.webFactCheck = async ({ round, questions }) => {
    const checker = research.factChecker;
    const webOptions = withEvidence({ tools: research.webTools ?? ['WebSearch', 'WebFetch'], timeoutMs: research.timeoutMs });
    const maxChars = research.factCheckMaxChars ?? 4000;
    const calls = {};
    const keep = (k) => (res) => { if (res.toolCalls?.length) calls[k] = res.toolCalls; };
    let answer = null;
    let review = null;
    const draft = await run.speak(checker, {
      stage: 'factcheck',
      round,
      system: run.shared,
      prompt: plus(webResearchPrompt({ round, questions, who: checker.name, maxChars }), evidence()),
      callOptions: { ...webOptions, maxBudgetUsd: checker.maxBudgetUsd ?? research.maxBudgetUsd },
      subtitle: `第 ${round} 轮 · 联网核实初稿 · ${questions.length} 个问题 · 待调研员审查，不发给参与者`,
      onResult: keep('draft'),
    });
    if (draft) {
      answer = await run.speak(research, {
        stage: 'factreview',
        round,
        system: run.shared,
        prompt: plus(webReviewPrompt({ round, questions, draft, checker: checker.name, maxChars }), evidence(), toolCallsBlock(calls.draft, checker.name)),
        callOptions: { ...webOptions, maxBudgetUsd: research.maxBudgetUsd },
        subtitle: `第 ${round} 轮 · 联网核实审查定稿 · ${questions.length} 个问题`,
        onResult: keep('review'),
      });
      if (answer) review = { checker: checker.model ?? checker.provider, corrections: parseReviewCorrections(answer) };
    } else {
      log(`${checker.name}没答出来，这次由调研员直接联网核实`);
      answer = await run.speak(research, {
        stage: 'factcheck',
        round,
        system: run.shared,
        prompt: plus(webResearchPrompt({ round, questions, who: '调研员', maxChars, draft: false }), evidence()),
        callOptions: { ...webOptions, maxBudgetUsd: research.maxBudgetUsd },
        subtitle: `第 ${round} 轮 · 联网核实 · ${questions.length} 个问题`,
        onResult: keep('review'),
      });
    }
    return run.factDone({ round, questions, answer, review, draft, source: 'web', calls });
  };

  /** 本场没有代码、也不联网，但能用数据工具：核实员用数据工具写初稿，调研员审查纠正；没有核实员时调研员直接查。 */
  run.dataFactCheck = async ({ round, questions }) => {
    const checker = research.factChecker ?? null;
    const maxChars = research.factCheckMaxChars ?? 4000;
    const callOptions = withEvidence({ ...(run.web ? { tools: research.webTools ?? ['WebSearch', 'WebFetch'] } : {}), timeoutMs: research.timeoutMs, maxBudgetUsd: research.maxBudgetUsd });
    const webLine = run.web ? webAlsoLine() : '';
    const calls = {};
    const keep = (k) => (res) => { if (res.toolCalls?.length) calls[k] = res.toolCalls; };
    let answer = null;
    let review = null;
    let draft = null;
    if (checker) {
      draft = await run.speak(checker, {
        stage: 'factcheck',
        round,
        system: run.shared,
        prompt: plus(dataCheckPrompt({ round, questions, who: checker.name, maxChars }), evidence(), webLine),
        callOptions: { ...callOptions, maxBudgetUsd: checker.maxBudgetUsd ?? research.maxBudgetUsd },
        subtitle: `第 ${round} 轮 · 数据核实初稿 · ${questions.length} 个问题 · 待调研员审查，不发给参与者`,
        onResult: keep('draft'),
      });
      if (draft) {
        answer = await run.speak(research, {
          stage: 'factreview',
          round,
          system: run.shared,
          prompt: plus(dataReviewPrompt({ round, questions, draft, checker: checker.name, maxChars }), evidence(), webLine, toolCallsBlock(calls.draft, checker.name)),
          callOptions,
          subtitle: `第 ${round} 轮 · 数据核实审查定稿 · ${questions.length} 个问题`,
          onResult: keep('review'),
        });
        if (answer) review = { checker: checker.model ?? checker.provider, corrections: parseReviewCorrections(answer) };
      } else {
        log(`${checker.name}没答出来，这次由调研员直接用数据工具核实`);
      }
    }
    if (!answer && !(checker && draft)) {
      answer = await run.speak(research, {
        stage: 'factcheck',
        round,
        system: run.shared,
        prompt: plus(dataCheckPrompt({ round, questions, who: '调研员', maxChars, draft: false }), evidence(), webLine),
        callOptions,
        subtitle: `第 ${round} 轮 · 数据核实 · ${questions.length} 个问题`,
        onResult: keep('review'),
      });
    }
    return run.factDone({ round, questions, answer, review, draft, source: 'data', calls });
  };

  /** 核实收尾：失败时问题回到队列（连续失败条数减半），成功时记下结果。 */
  run.factDone = ({ round, questions, answer, review, draft, source, calls }) => {
    if (!answer) {
      factFailures += 1;
      // 这次查的条数就是当前批次大小
      const size = questions.length;
      if (factFailures >= 2 && size > 1) {
        factBatch = Math.max(1, Math.ceil(size / 2));
        factFailures = 0;
        log(`核实连续失败，下一次只查 ${factBatch} 个问题`);
      } else log('核实失败，这些问题下一轮再试');
      pendingQuestions = [...questions, ...pendingQuestions];
      return false;
    }
    factFailures = 0;
    factBatch = null;
    for (const q of questions) asked.add(normQ(q));
    const toolCalls = compactCalls(calls);
    run.facts.push({ round, questions, answer, ...(source ? { source } : {}), ...(review ? { review: { ...review, draft } } : {}), ...(toolCalls ? { toolCalls } : {}) });
    emit({ type: 'fact_checked', round, questions: questions.length, ...(source ? { source } : {}), ...(review ? { reviewed: true, corrections: review.corrections } : {}), ...(toolCalls ? { toolCalls: (toolCalls.draft?.length ?? 0) + (toolCalls.review?.length ?? 0) } : {}) });
    if (review?.corrections) log(`调研员审查更正了核实初稿里的 ${review.corrections} 条`);
    return true;
  };

  // 自动轮数：有评审时看评审结论，没有评审时看主笔立场是否还在变；脑洞风暴没有评审时按固定轮数
  run.stopRule = reviewers.length ? '评审都没有新意见' : '主笔的立场都不再变化';
  /**
   * 本轮评审是否都表示没有意见：每位评审都要成功发言并写明「没有意见了」；有人失败或没写结论都算继续。
   * 方案讨论和打磨的评审要给问题分级：写了「继续讨论」却没有任何【阻断】级问题，按没有意见处理。
   */
  const graded = cfg.mode !== 'brainstorm';
  const reviewerDone = (p, entries) => {
    const e = entries.find((x) => x.id === p.id);
    if (!e) return false;
    const verdict = parseVerdict(e.text);
    return verdict === 'done' || (graded && verdict === 'continue' && !hasBlocker(e.text));
  };
  const reviewersDone = (entries) => reviewers.length > 0 && reviewers.every((p) => reviewerDone(p, entries));

  /**
   * 第 from 到 to 轮：方案讨论是「评审提意见 → 主笔互评修订」，脑洞是「盲审 → 修订」。
   * adaptive 时评审都没有新意见（且没有新插话要回应）就提前结束。
   * scope：追问原文，交给评审作为本次讨论范围（主笔已经在回应追问时看过）。
   * 会话模式下每位评审成功收到一次后就不再重复；非会话模式每轮都要带上。
   */
  run.iterate = async ({ from, to, adaptive, scope }) => {
    run.verdictAsked = adaptive;
    let lastRound = from - 1;
    const scoped = new Set(); // 已经在会话里收到讨论范围的评审
    const scopeFor = (p) => (scope && reviewerIds.has(p.id) && !(convo && scoped.has(p.id)) ? scope : undefined);
    const markScoped = (entries) => {
      if (scope) for (const e of entries) if (reviewerIds.has(e.id)) scoped.add(e.id);
    };
    let ending = { reason: adaptive ? 'max' : 'fixed', round: to, byReviewers: reviewers.length > 0 };
    let answered = heard.length; // 主笔已经回应过的插话条数
    const converge = (round) => {
      ending = { reason: 'converged', round, byReviewers: reviewers.length > 0 };
      log(`第 ${round} 轮${run.stopRule}，提前结束`);
    };
    // 熔断只看确定性信号：主笔的「无变化」标记、评审有没有【阻断】、评审结论
    const breakers = adaptive && graded && reviewers.length > 0;
    let stuck = 0; // 连续几轮：主笔全部「无变化」，评审仍有阻断
    const lone = new Map(); // 评审 id -> 连续几轮独自坚持阻断（其他评审都没有意见）

    for (let round = from; round <= to; round += 1) {
      await run.pullInterjections();
      lastRound = round;
      const activeLeads = leads.filter((p) => latest.has(p.id));
      // 新的插话或新的代码核实结果都要主笔先回应，这一轮不提前结束
      const newFacts = await run.factCheck(round);
      const newInterjections = heard.length > answered || newFacts;
      let revised;

      if (cfg.mode === 'brainstorm') {
        // 盲审：主笔评其他主笔的脑洞，评审评所有主笔的脑洞；只给意见
        const givers = [...activeLeads, ...reviewers];
        const fb = await run.runStage(givers, round, 'feedback', (p) => feedbackPrompt({ round, others: run.latestOthers(p), interjections: run.ijFor(p), askVerdict: adaptive && reviewerIds.has(p.id), convo, scope: scopeFor(p) }));
        markScoped(fb);
        if (adaptive && reviewers.length && !newInterjections && reviewersDone(fb)) {
          converge(round);
          break;
        }
        const fbBy = new Map(fb.map((e) => [e.id, e.text]));
        // 修订：主笔只看到别人给的意见（来源匿名），独立修改
        revised = await run.runStage(activeLeads, round, 'revise', (p) => revisePrompt({
          round,
          own: latest.get(p.id),
          feedback: givers.filter((q) => q.id !== p.id && fbBy.has(q.id)).map((q) => fbBy.get(q.id)),
          ideasPerAgent,
          interjections: run.ijFor(p),
          convo,
        }));
      } else {
        // 评审先提意见，主笔再看着意见互评修订
        const proposals = [...latest.values()].sort(byTag);
        // 评审互见：上一轮其他评审提的【阻断】原文（只取那几行），评审只对不同意或能补充证据的表态
        const lastCritiques = rounds.find((x) => x.round === round - 1 && x.stage === 'critique')?.entries ?? [];
        // 评审互见只认行首【阻断】：「本轮没有【阻断】」这类否定句不再转给其他评审
        const peersFor = (p) => lastCritiques.filter((e) => e.id !== p.id).map((e) => ({ tag: e.tag, lines: capLines(lineStartBlockers(e.text)) })).filter((x) => x.lines.length);
        const resolved = run.blockerHistory().resolved;
        const critiques = reviewers.length
          ? await run.runStage(reviewers, round, 'critique', (p) => critiquePrompt({ round, proposals, peers: peersFor(p), resolved, interjections: run.ijFor(p), askVerdict: adaptive, convo, mode: cfg.mode, limits, scope: scopeFor(p), items: cfg.items, ownIssues: run.ownIssuesFor(p) }))
          : [];
        markScoped(critiques);
        if (adaptive && reviewers.length && !newInterjections && reviewersDone(critiques)) {
          converge(round);
          break;
        }
        revised = await run.runStage(activeLeads, round, 'review', (p) => reviewPrompt({
          round,
          own: latest.get(p.id),
          others: run.latestOthers(p),
          critiques,
          interjections: run.ijFor(p),
          convo,
          mode: cfg.mode,
          limits,
          items: cfg.items,
          tracking: run.tracking,
        }));
      }
      // 「无变化」：沿用上一版完整方案；没写这个标记、发言失败或写了别的内容，都算有变化
      for (const e of revised) {
        if (e.plan !== undefined && isUnchangedPlan(e.plan)) {
          const prev = latest.get(e.id);
          e.unchanged = true;
          e.plan = prev?.plan ?? prev?.text;
        }
      }
      const allUnchanged = cfg.mode !== 'brainstorm' && revised.length === activeLeads.length && revised.length > 0 && revised.every((e) => e.unchanged);
      // 本轮失败的主笔沿用上一版
      for (const e of revised) latest.set(e.id, e);
      answered = heard.length;
      if (breakers && cfg.mode !== 'brainstorm') {
        const critiques = rounds.find((x) => x.round === round && x.stage === 'critique')?.entries ?? [];
        const blocking = reviewers.filter((p) => {
          const e = critiques.find((x) => x.id === p.id);
          return e && parseVerdict(e.text) === 'continue' && hasBlocker(e.text);
        });
        // 修订后结束：评审都没有阻断（这一轮因为新核实或新插话没有提前结束），主笔看完也都没改
        if (newInterjections && reviewersDone(critiques) && allUnchanged) {
          converge(round);
          break;
        }
        // 熔断一：主笔连续 2 轮全部「无变化」，这两轮评审都有阻断
        stuck = allUnchanged && blocking.length ? stuck + 1 : 0;
        if (stuck >= 2) {
          ending = { reason: 'deadlock', round, byReviewers: true };
          log(`第 ${round - 1}、${round} 轮主笔都没改方案，评审仍有阻断：以分歧结束`);
          break;
        }
        // 熔断二：评审不少于 2 位，同一位评审连续 3 轮独自坚持阻断，其他评审都没有意见
        const alone = blocking.length === 1 && reviewers.length >= 2
          && reviewers.filter((q) => q.id !== blocking[0].id).every((q) => reviewerDone(q, critiques))
          ? blocking[0] : null;
        for (const p of reviewers) lone.set(p.id, alone?.id === p.id ? (lone.get(p.id) ?? 0) + 1 : 0);
        if (alone && lone.get(alone.id) >= 3) {
          ending = { reason: 'dissent', round, byReviewers: true, tag: tagOf(alone) };
          log(`${tagOf(alone)}连续 3 轮独自坚持阻断，其他评审都没有意见：以评审之间的分歧结束`);
          break;
        }
      }
      // 没有评审的方案讨论：所有主笔都写「立场变化：无」就算收敛
      if (adaptive && !reviewers.length && cfg.mode !== 'brainstorm' && revised.length === activeLeads.length
        && revised.every((e) => parseStanceChange(e.text) === '无')) {
        converge(round);
        break;
      }
    }
    return { lastRound, ending };
  };

  /** 讨论结束卡片：代号对照、用量、追问提示。 */
  run.postEnd = async ({ title, subtitle, number, noCode = false }) => {
    const mapping = participants
      .map((p) => ({ tag: tagOf(p), line: `- ${tagOf(p)}：${p.name}${p.role ? ` · ${p.role}` : ''}（${p.provider}${p.model ? ` / ${p.model}` : ''}）` }))
      .sort(byTag)
      .map((x) => x.line);
    await publisher.post({
      speaker: cfg.chair,
      title,
      subtitle,
      body: [
        '**代号对照**',
        ...mapping,
        '',
        `**用量**：输入 ${stats.inputTokens} tokens（多回合调用按各回合累计），输出 ${stats.outputTokens} tokens${stats.costUsd ? `，约 $${stats.costUsd.toFixed(2)}` : ''}`,
        occupancyLine(participants, run.occupancy),
        noCode ? '**代码上下文**：本场无代码，涉及代码现状的结论都没有核实。' : null,
        heard.length ? `**收到的插话**：${heard.length} 条` : null,
        number && cfg.mode === 'refine' ? '**追问**：在页面上接着追问，主编会判断是直接回答还是重新讨论；重新讨论后会重写修订版。' : null,
        number && cfg.mode === 'quick' ? '**追问**：在页面上接着追问，回答的一方会直接回答并更新快问文档；想深入讨论可以「升级为讨论」。' : null,
        number && cfg.mode === 'redraft' ? '**追问**：在页面上接着追问（例如「第三段再收一点」），改稿的一方会回答，需要时更新修改稿。' : null,
        number && !['refine', 'quick', 'redraft'].includes(cfg.mode) ? `**追问**：发 \`/追问 <问题>\` 接着问这场讨论（更早的讨论写 \`/追问 #${number} <问题>\`），主席会判断是直接回答还是重新讨论。` : null,
      ].filter((l) => l !== null).join('\n'),
    });
  };

  /**
   * 按主席的输入预算拼提示词。build({ rounds, facts, omitted }) 返回完整提示词；
   * 必须保留的内容由 build 自己放（不受预算限制，超出也照发），讨论记录和核实结果按预算从新到旧装填。
   * factor：预算倍数，主席第一次失败后重写时传 0.5。
   */
  run.fitChair = (build, { rounds: history = [], facts: checked = [], factor = 1, stage = 'doc' } = {}) => {
    const chair = cfg.chair;
    const window = chair.contextWindow ?? run.budget.windows[`${chair.provider}:${chair.model ?? ''}`];
    const total = budgetChars({ window, share: CHAIR_SHARE, factor, tokensPerChar: run.budget.tokenRatios[chair.provider] });
    const fixed = build({ rounds: [], facts: [], omitted: '' }).length + (run.shared?.length ?? 0);
    const fit = fitHistory({ rounds: history, facts: checked, budgetChars: total - fixed });
    const over = fixed > total;
    if (fit.stats.trimmed || over) {
      log(`${chair.name}输入预算 ${total} 字（窗口${window ? ` ${window}` : '未知，按默认估'} tokens × ${CHAIR_SHARE * factor}）：${over ? `必须保留的内容 ${fixed} 字已超出预算，照发；` : ''}讨论记录 ${fit.stats.rounds} 轮里缩略 ${fit.stats.compactRounds}、省略 ${fit.stats.droppedRounds}，核实 ${fit.stats.facts} 次里缩略 ${fit.stats.compactFacts}、省略 ${fit.stats.droppedFacts}`);
    }
    emit({ type: 'chair_budget', stage, budgetChars: total, fixedChars: fixed, factor, overBudget: over, ...fit.stats });
    return build({ rounds: fit.rounds, facts: fit.facts, omitted: fit.note });
  };

  /**
   * 主文档：主席写（或更新）→ 主笔在各自的会话里核对 → 有意见时主席按意见修改 → 在讨论里发一条短消息。
   * prompt 是 docPrompt、docUpdatePrompt 或 docRewritePrompt；previous 是当前文档的上一版（没有时为 null）；
   * existing 是这场讨论已有的全部版本（定版本号和新文档编号）。
   * 主席可以改当前文档，也可以新开文档（讨论分出了独立的方向，要写原因）。
   * 返回这次写出的各版 [{ version, docNo, title, at, reason, text, note, attachments, check, opened? }]，当前文档在前；
   * 不需要修改时返回 []；写失败返回 null。
   */
  run.writeDoc = async ({ prompt, previous = null, existing = previous ? [previous] : [], round, reason, check = true, writer = cfg.chair }) => {
    // 主席这次写文档用一条临时会话：按核对意见修改时讨论记录已经在会话里，不用再发一遍。非会话模式把初稿贴回去
    let session = null;
    const write = async (text) => run.speak(writer, { stage: 'doc', round, system: run.shared, prompt: text, session, quiet: true });
    // 主席没写出来（失败或格式不对）时换一条新会话重写一次；仍不行返回 null，由调用方发兜底卡片
    let raw = null;
    let parsed = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
      if (attempt) log('主席重写一次主文档');
      session = convo ? { id: randomUUID(), turns: [], seen: 0 } : null;
      // prompt 是函数时按预算拼：重写那次预算减半，讨论记录缩略得更多
      const text = typeof prompt === 'function' ? prompt(attempt ? 0.5 : 1) : prompt;
      raw = await write(`${docSystem(cfg.mode)}\n\n${text}`);
      if (raw == null) continue;
      try {
        parsed = parseDoc(raw);
        // 还没有文档时必须写出当前文档
        if (!previous && !parsed.unchanged && !parsed.doc) throw new Error('没有写出主文档');
      } catch (err) {
        parsed = null;
        log(`⚠️ 主文档格式不对：${err.message}`);
      }
    }
    if (!parsed) return null;
    if (parsed.unchanged) {
      log('主席判断：这次追问不需要改主文档');
      return [];
    }
    let attachments = parsed.doc ? mergeAttachments(previous?.attachments, parsed.attachments) : previous?.attachments ?? {};
    let fresh = parsed.newDocs.map((d) => ({ ...d, attachments: mergeAttachments({}, d.attachments) }));
    const combined = () => [
      parsed.doc ?? '',
      ...fresh.map((d) => `---\n\n（新开的文档《${d.title}》，原因：${d.reason ?? '没写'}）\n\n${d.doc}`),
    ].filter(Boolean).join('\n\n');
    const allAttachments = () => Object.assign({}, parsed.doc ? attachments : {}, ...fresh.map((d) => d.attachments));

    // ---------- 主笔核对 ----------
    let checkInfo = null;
    const checkers = check ? leads.filter((p) => latest.has(p.id) && (!convo || sessions.get(p.id)?.turns.length)) : [];
    if (checkers.length) {
      const results = await mapLimit(checkers, cfg.concurrency ?? checkers.length, (p) => run.speak(p, {
        stage: 'doccheck',
        round,
        system: run.shared,
        // 非会话模式（或会话还没开始）没有身份和讨论记忆：带上身份和自己最后的方案
        prompt: `${convo ? '' : `${participantSystem(p, { mode: cfg.mode })}\n\n`}${docCheckPrompt({ doc: combined(), attachments: allAttachments(), own: convo ? null : (latest.get(p.id).plan ?? latest.get(p.id).text), items: cfg.items })}`,
        session: convo ? sessions.get(p.id) : null,
        quiet: true,
      }));
      const issues = checkers.map((p, i) => ({ p, tag: tagOf(p), text: parseDocCheck(results[i]) })).filter((x) => x.text);
      // 「没有问题」不发，只把提了意见的发出来
      for (const x of issues) {
        await publisher.post({
          speaker: x.p,
          title: `${x.p.name}${x.p.role ? ` · ${x.p.role}` : ''}`,
          subtitle: `${STAGE_LABELS.doccheck} · 代号 ${x.tag}`,
          body: x.text,
          meta: { stage: 'doccheck', round, tag: x.tag },
        });
      }
      checkInfo = { by: results.filter((x) => x != null).length, issues: issues.length, fixed: false };
      if (issues.length) {
        log(`主笔核对提了 ${issues.length} 份意见，主席修改主文档`);
        const fixedRaw = await write(docFixPrompt({ issues, draft: session ? null : raw }));
        try {
          const fixed = fixedRaw == null ? null : parseDoc(fixedRaw);
          if (fixed && !fixed.unchanged && (fixed.doc || !parsed.doc)) {
            if (fixed.doc) attachments = mergeAttachments(attachments, fixed.attachments);
            // 新开的文档按顺序对上初稿里的，附录在初稿的基础上合并
            fresh = fixed.newDocs.map((d, i) => ({ ...d, reason: d.reason ?? fresh[i]?.reason ?? null, attachments: mergeAttachments(fresh[i]?.attachments, d.attachments) }));
            parsed = { ...fixed, doc: fixed.doc ?? parsed.doc, note: fixed.note ?? parsed.note };
            checkInfo.fixed = true;
          }
        } catch (err) {
          log(`⚠️ 按核对意见修改的主文档格式不对，用修改前的版本：${err.message}`);
        }
      }
    }

    const at = new Date().toISOString();
    let version = Math.max(0, ...existing.map((d) => d.version ?? 0));
    let docNo = Math.max(0, ...existing.map(docNoOf));
    const written = [];
    const currentNo = previous ? docNoOf(previous) : (docNo || 1);
    const currentTitle = previous ? previous.title ?? docTitle(previous.text) : null;
    if (parsed.doc) {
      version += 1;
      written.push({ version, docNo: currentNo, title: docTitle(parsed.doc), at, reason, text: parsed.doc, note: parsed.note ?? docLead(parsed.doc), attachments, check: checkInfo });
      docNo = Math.max(docNo, currentNo);
    }
    const fromTitle = written[0]?.title ?? currentTitle;
    for (const d of fresh) {
      version += 1;
      docNo += 1;
      // 只新开、当前文档没改时，主席的说明记在第一份新文档上
      const note = !parsed.doc && !written.length && parsed.note ? parsed.note : docLead(d.doc);
      written.push({ version, docNo, title: d.title, at, reason, text: d.doc, note, attachments: d.attachments, check: checkInfo, opened: { reason: d.reason, ...(fromTitle ? { from: fromTitle } : {}) } });
    }
    const checkText = checkInfo ? ` · ${checkInfo.issues ? `主笔核对提了 ${checkInfo.issues} 份意见${checkInfo.fixed ? '，已修改' : ''}` : '主笔核对没有意见'}` : '';
    const lines = written.map((d) => {
      const names = Object.keys(d.attachments);
      return `- ${d.opened ? '新开' : ''}《${d.title}》第 ${d.version} 版${names.length ? `，附录 ${names.map((n) => `《${n}》`).join('、')}` : ''}${d.opened ? `。新开原因：${d.opened.reason ?? '（没写）'}` : ''}`;
    });
    await publisher.post({
      speaker: writer,
      title: `${writer.name} · ${cfg.mode === 'quick' ? '快问文档' : STAGE_LABELS.doc}`,
      subtitle: `${written.length > 1 ? `${written.length} 份文档` : `第 ${written[0].version} 版`} · ${reason}${checkText}`,
      body: [parsed.note ?? written[0].note, '', ...lines, '', '完整文档在网页的「文档」页。'].join('\n'),
      meta: { stage: 'doc', round, docVersion: written[0].version },
    });
    for (const d of written) emit({ type: 'doc_written', version: d.version, docNo: d.docNo, reason, chars: d.text.length, attachments: Object.keys(d.attachments).length, check: checkInfo, ...(d.opened ? { opened: true } : {}) });
    return written;
  };

  /**
   * 开场联网搜集资料（本场无代码、网页阵容选了核实员时）：主席判断要不要搜、列出问题和关键词 →
   * 核实员联网写初稿 → 调研员联网审查纠正。只有审查后的定稿作为背景资料发给参与者；任何一步失败都不带资料讨论。
   * 返回背景资料 { web: true, text, questions, review } 或 null。
   */
  run.webResearch = async ({ topic }) => {
    const checker = research?.factChecker;
    if (!checker) return null;
    const planText = await run.speak(cfg.chair, {
      stage: 'webplan',
      round: 0,
      prompt: webPlanPrompt({ topic, interjections: heard }),
      subtitle: '开场 · 要不要联网搜集资料（关键词不带公司内部信息）',
    });
    const plan = parseWebPlan(planText);
    if (!plan.need) {
      log(`${cfg.chair.name}判断不需要联网搜集资料`);
      return null;
    }
    const webOptions = { tools: research.webTools ?? ['WebSearch', 'WebFetch'], timeoutMs: research.timeoutMs };
    const maxChars = research.webMaxChars ?? 8000;
    const draft = await run.speak(checker, {
      stage: 'webresearch',
      round: 0,
      prompt: webResearchPrompt({ topic, questions: plan.questions, who: checker.name, maxChars, opening: true }),
      callOptions: { ...webOptions, maxBudgetUsd: checker.maxBudgetUsd ?? research.maxBudgetUsd },
      subtitle: `开场 · 资料初稿 · ${plan.questions.length} 个问题 · 待调研员审查，不发给参与者`,
    });
    if (!draft) {
      log(`${checker.name}没搜出资料，这场不带联网资料讨论`);
      return null;
    }
    const final = await run.speak(research, {
      stage: 'webreview',
      round: 0,
      prompt: webReviewPrompt({ topic, questions: plan.questions, draft, checker: checker.name, maxChars, opening: true }),
      callOptions: { ...webOptions, maxBudgetUsd: research.maxBudgetUsd },
      subtitle: `开场 · 资料审查定稿 · ${plan.questions.length} 个问题`,
    });
    if (!final) {
      log('调研员没能审查联网资料，没审过的初稿不发，这场不带联网资料讨论');
      return null;
    }
    const corrections = parseReviewCorrections(final);
    emit({ type: 'web_researched', questions: plan.questions.length, corrections });
    return { web: true, text: final, questions: plan.questions, review: { checker: checker.model ?? checker.provider, corrections, draft } };
  };

  /**
   * 开场查实时数据（网页上选了数据工具时）：主席判断要不要查、列出问题 → 核实员用数据工具写初稿 → 调研员审查纠正。
   * 没有核实员时调研员直接查。只有审查后的定稿（或调研员直接查的结果）作为背景发给参与者；失败时不带实时数据讨论。
   * 返回 { text, questions, review?, toolCalls? } 或 null。
   */
  run.dataResearch = async ({ topic }) => {
    if (!hasData()) return null;
    const planText = await run.speak(cfg.chair, {
      stage: 'dataplan',
      round: 0,
      prompt: dataPlanPrompt({ topic, interjections: heard, toolsNote: allowedToolsNote(run.data.mcp) }),
      subtitle: '开场 · 要不要先查实时数据',
    });
    const plan = parseDataPlan(planText);
    if (!plan.need) {
      log(`${cfg.chair.name}判断不需要先查实时数据`);
      return null;
    }
    const checker = research.factChecker ?? null;
    const maxChars = research.factCheckMaxChars ?? 4000;
    const callOptions = withEvidence({ timeoutMs: research.timeoutMs, maxBudgetUsd: research.maxBudgetUsd });
    const calls = {};
    const keep = (k) => (res) => { if (res.toolCalls?.length) calls[k] = res.toolCalls; };
    if (!checker) {
      const text = await run.speak(research, {
        stage: 'dataresearch',
        round: 0,
        prompt: plus(dataCheckPrompt({ topic, questions: plan.questions, who: '调研员', maxChars, opening: true, draft: false }), evidence()),
        callOptions,
        subtitle: `开场 · 实时数据 · ${plan.questions.length} 个问题`,
        onResult: keep('review'),
      });
      if (!text) {
        log('调研员没查出实时数据，这场不带实时数据讨论');
        return null;
      }
      emit({ type: 'data_researched', questions: plan.questions.length });
      return { text, questions: plan.questions, ...(compactCalls(calls) ? { toolCalls: compactCalls(calls) } : {}) };
    }
    const draft = await run.speak(checker, {
      stage: 'dataresearch',
      round: 0,
      prompt: plus(dataCheckPrompt({ topic, questions: plan.questions, who: checker.name, maxChars, opening: true }), evidence()),
      callOptions: { ...callOptions, maxBudgetUsd: checker.maxBudgetUsd ?? research.maxBudgetUsd },
      subtitle: `开场 · 实时数据初稿 · ${plan.questions.length} 个问题 · 待调研员审查，不发给参与者`,
      onResult: keep('draft'),
    });
    if (!draft) {
      log(`${checker.name}没查出实时数据，这场不带实时数据讨论`);
      return null;
    }
    const final = await run.speak(research, {
      stage: 'datareview',
      round: 0,
      prompt: plus(dataReviewPrompt({ topic, questions: plan.questions, draft, checker: checker.name, maxChars, opening: true }), evidence(), toolCallsBlock(calls.draft, checker.name)),
      callOptions,
      subtitle: `开场 · 实时数据审查定稿 · ${plan.questions.length} 个问题`,
      onResult: keep('review'),
    });
    if (!final) {
      log('调研员没能审查实时数据，没审过的初稿不发，这场不带实时数据讨论');
      return null;
    }
    const corrections = parseReviewCorrections(final);
    emit({ type: 'data_researched', questions: plan.questions.length, corrections });
    return { text: final, questions: plan.questions, review: { checker: checker.model ?? checker.provider, corrections, draft }, ...(compactCalls(calls) ? { toolCalls: compactCalls(calls) } : {}) };
  };

  /**
   * 阻断原文存档：交给主席写主文档、判断追问，熔断或到上限时发待裁决卡片，也存进讨论状态。
   * 状态只看这位评审最后一次发言的评审结论；原文取最近一次写在行首、且那一轮结论不是「没有意见了」的【阻断】
   * （行首规则和网页共用，「本轮没有【阻断】」这类否定句不会再顶掉真实阻断）：
   *   open     结论不是「没有意见了」，最后一次发言有行首阻断：仍在阻断，待裁决
   *   unknown  结论不是「没有意见了」，有【阻断】但不在行首：格式未识别，照录最后一次的原文，待裁决（熔断用的是任意位置的【阻断】，卡片要能解释熔断）
   *   done     最后一次写了「没有意见了」：之前的阻断照录，标明这次结论，不算待裁决
   *   dropped  最后一次一个【阻断】都没写（没写结论、或写了继续却没有阻断）：之前的阻断照录，标明从哪一轮起未再提
   * done / dropped 照旧写 clearedAt（阻断那一轮之后第一次发言的轮次），兼容旧的读取方。没有提过阻断的评审不进存档。
   */
  run.rulings = []; // 追问里人按裁决定稿过时，各覆盖到第几轮（追问开始时从讨论状态里取）
  run.blockerHistory = () => blockerHistoryOf(rounds, reviewers.map((p) => ({ id: p.id, tag: tagOf(p) })), { rulings: run.rulings });
  run.blockerArchive = () => run.blockerHistory().archive;
  /**
   * 交给主席（和新会话追问的参与者）的存档：现状之外附上更早已经解决的阻断（最近 8 条，status 为 resolved）。
   * 最后一次发言才解决的已经在现状里标了「没有意见了」，不重复。待裁决卡片和讨论状态只用现状。
   */
  run.chairBlockers = () => {
    const { archive, resolved } = run.blockerHistory();
    const shown = new Set(archive.filter((b) => b.status === 'done').map((b) => `${b.id}:${b.round}`));
    const extra = resolved.filter((r) => !shown.has(`${r.id}:${r.round}`))
      .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)).slice(0, 8)
      .map((r) => ({ ...r, status: 'resolved' }));
    return [...archive, ...extra];
  };

  /** 熔断或到上限时，另发一张阻断存档卡片；正常收敛时不发（主文档里已经写了）。 */
  run.postBlockers = async (ending) => {
    if (!['deadlock', 'dissent', 'max'].includes(ending?.reason)) return;
    const archive = run.blockerArchive().filter(isPendingBlocker);
    if (!archive.length) return;
    await publisher.post({
      speaker: cfg.chair,
      title: '阻断存档 · 待裁决',
      subtitle: endingText(ending),
      body: blockersBlock(archive).replace(/^## .*\n/, ''),
      meta: { stage: 'blockers', round: ending.round },
    });
  };

  /**
   * 主席没写成主文档时，由程序直接发一张卡片：各主笔的最终方案、评审最后提的阻断、还没核实的问题。
   * 不经过任何模型，讨论的结果不至于整场丢掉。
   */
  run.postDocFallback = async ({ round, ending, number }) => {
    const finals = [...latest.values()].sort(byTag);
    const blockers = run.blockerArchive().map((b) => `**${b.tag}**（${blockerStatusText(b)}）\n${blockerEntryText(b, (l) => (/^更早第/.test(l) ? l : `- ${l.replace(/^[-*]\s*/, '')}`))}`);
    const pending = run.pendingQuestions();
    const checked = run.facts.reduce((n, f) => n + f.questions.length, 0);
    const chair = cfg.chair.name;
    const body = [
      `${chair}没能写出主文档（重写一次后仍失败）。下面是程序直接整理的材料，没有经过${chair}判断。`,
      endingText(ending),
      '',
      '## 各主笔的最终方案',
      ...finals.map((e) => `### ${e.tag}\n${e.plan ?? e.text}`),
      blockers.length ? '\n## 评审最后提的阻断' : null,
      ...blockers,
      checked || pending.length ? `\n## 代码核实\n已核实 ${checked} 个问题，结果在讨论里的「代码核实」卡片${pending.length ? `；还有 ${pending.length} 个没核实：\n${pending.map((q) => `- ${q}`).join('\n')}` : '。'}` : null,
      '',
      `补救：运行 \`node src/cli.js doc${number ? ` ${number}` : ''}\`，让${chair}按全部记录补写主文档。`,
    ].filter((l) => l !== null).join('\n');
    await publisher.post({ speaker: cfg.chair, title: `${chair}汇总失败 · 程序整理的结果`, subtitle: endingText(ending) || '讨论结束', body, meta: { stage: 'fallback', round } });
    emit({ type: 'doc_failed', round });
  };

  /**
   * 打磨：主编按主文档写出完整修订版。格式不对时把错误告诉它再写一次。
   * 返回 { fields, changed } 或 null（两次都失败）。
   */
  run.rewrite = async ({ subject, summary, followUp, round }) => {
    let error;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const text = await run.speak(cfg.chair, {
        stage: 'rewrite',
        round,
        system: run.shared,
        prompt: `${rewriteSystem()}\n\n${rewritePrompt({ subject, summary, followUp, error })}`,
        subtitle: `${STAGE_LABELS.rewrite}${attempt ? ' · 重写' : ''}`,
        quiet: true,
      });
      if (text == null) return null;
      try {
        const revision = parseRevision(text, subject.fields);
        log(`修订版：改动 ${revision.changed.map((k) => FIELD_LABELS[k] ?? k).join('、') || '无'}`);
        await publisher.post({
          speaker: cfg.chair,
          title: `${cfg.chair.name} · ${STAGE_LABELS.rewrite}`,
          subtitle: `${SUBJECT_LABELS[subject.type]}「${subject.title}」`,
          body: revision.changed.length
            ? `按讨论结论写好了修订版，改动的部分：${revision.changed.map((k) => FIELD_LABELS[k] ?? k).join('、')}。\n\n修订版不会自动写回墨稿：在页面上对比原稿，确认后再点「写回墨稿」。`
            : '讨论结论没有要改的地方，修订版和原稿一样。',
          meta: { stage: 'rewrite', round, revision },
        });
        return { ...revision, at: new Date().toISOString() };
      } catch (err) {
        error = err.message;
        log(`⚠️ 修订版格式不对：${error}${attempt ? '' : '，重写一次'}`);
      }
    }
    await publisher.post({ speaker: cfg.chair, title: `${cfg.chair.name} · 修订版失败`, subtitle: STAGE_LABELS.rewrite, body: `两次都没写出合格的修订版：${error}。可以追问「按汇总重写修订版」再试。`, meta: { stage: 'rewrite', error } });
    return null;
  };

  return run;
}

/** 卡片末尾的查询记录：调用了哪些工具、什么参数、结果大小。 */
export function toolCallsNote(calls) {
  if (!calls?.length) return '';
  const lines = calls.map((c) => {
    const state = c.denied ? '被拒' : c.isError ? '出错' : `${c.resultChars ?? 0} 字`;
    const input = JSON.stringify(c.input ?? {});
    return `- ${c.name.replace(/^mcp__/, '').replace('__', ' · ')} \`${input.length > 200 ? `${input.slice(0, 200)}…` : input}\` → ${state}`;
  });
  return `\n\n**查询记录**（${calls.length} 次）\n${lines.join('\n')}`;
}

/** 存进 state 的工具调用：参数截短。 */
function compactCalls(calls) {
  if (!calls) return null;
  const out = {};
  for (const [k, list] of Object.entries(calls)) {
    if (!list?.length) continue;
    out[k] = list.map((c) => ({ name: c.name, input: JSON.stringify(c.input ?? {}).slice(0, 1000), ...(c.isError ? { isError: true } : {}), ...(c.denied ? { denied: true } : {}), resultChars: c.resultChars ?? 0 }));
  }
  return Object.keys(out).length ? out : null;
}

/** 讨论结束后可以续接的状态，存进记录库（discussions.state）。 */
/** 主席提示词末尾附上的核实结果。 */
function chairFacts(facts) {
  const block = factsBlock(facts, { forChair: true });
  return block ? `\n\n${block}` : '';
}

/** 追问时重新准备代码目录用：自动定位的记 auto，指定仓库的记别名和分支。 */
function codeSpecOf(code) {
  if (!code) return null;
  return { auto: Boolean(code.auto), repos: code.auto ? [] : code.repos.map((r) => ({ name: r.alias, ...(r.ref ? { ref: r.ref } : {}) })) };
}

function exportState({ number, topic, cfg, tags, shared, context, code, facts = [], sessions, latest, rounds, lastRound, summary, docs = [], followUps = [], createdAt, subject, revision, ending, docFailed = false, budget, blockers = [], interjections = [], data, dataContext, material, memory }) {
  return {
    version: STATE_VERSION,
    number: number ?? null,
    topic,
    ...(material ? { material } : {}),
    ...(memory ? { memory } : {}),
    // 条目化发言是按场开的（试跑）：追问沿用发起时的设置
    ...(cfg.items ? { items: true } : {}),
    mode: cfg.mode,
    createdAt: createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: Object.fromEntries(tags),
    shared,
    context: contextOut(context),
    code: codeSpecOf(code),
    ...(data ? { data } : {}),
    ...(dataContext ? { dataContext } : {}),
    facts,
    sessions: Object.fromEntries(sessions),
    latest: [...latest.values()],
    rounds,
    lastRound,
    ending: ending ? { reason: ending.reason, round: ending.round, ...(ending.tag ? { tag: ending.tag } : {}) } : null,
    blockers,
    interjections,
    ...(budget ? { budget } : {}),
    ...(docFailed ? { docFailed: true } : {}),
    summary,
    docs,
    followUps,
    ...(subject ? { subject, revision: revision ?? null, revisions: revision ? [revision] : [] } : {}),
  };
}

/**
 * 主持一场讨论。
 *
 * decision：主笔第 1 轮独立出方案；之后每轮先由评审给主笔的方案提意见，
 *           主笔再看着其他主笔的方案和评审意见互评并修订；最后主席汇总。
 * brainstorm：主笔第 1 轮发散；之后每轮主笔与评审一起盲审主笔的脑洞，主笔各自修订；最后主编挑选。
 * 没有配置评审时，所有参与者都是主笔。
 *
 * @param {object} opts
 * @param {object} opts.cfg          normalizeConfig 之后的配置
 * @param {string} opts.topic        议题或题目
 * @param {object} opts.providers    createProviderRegistry 的结果
 * @param {object} opts.publisher    combinePublishers 的结果
 * @param {object} [opts.interjections] createInterjectionReader 的结果（可选）
 * @param {function} [opts.log]      进度日志
 * @param {function} [opts.rng]      随机数（测试时固定代号）
 * @param {function} [opts.onEvent]  用量事件回调（写进记录库 events 表）
 * @param {object} [opts.code]       prepareRepos 的结果：有值时先由调研员读代码，整理背景资料给所有人
 * @param {number} [opts.number]     讨论编号，显示在卡片上，追问时用
 */
export async function runDiscussion({ cfg, topic, providers, publisher, interjections, log = () => {}, rng = Math.random, onEvent = () => {}, code, number, subject, data, material, memory, setting }) {
  if (cfg.mode === 'quick' || cfg.mode === 'redraft') return runQuick({ cfg, topic, providers, publisher, log, rng, onEvent, number, data, material, memory, setting, code: cfg.mode === 'quick' ? code : null });
  if (cfg.mode === 'refine' && !subject) throw new Error('打磨模式需要打磨对象（subject）');
  const tags = assignTags(cfg.participants, rng);
  const sessions = new Map(cfg.participants.map((p) => [p.id, { id: randomUUID(), turns: [], seen: 0 }]));
  const latest = new Map(); // 主笔 id -> 最新一版方案
  const rounds = [];        // [{ round, stage, entries: [{ id, label, tag, text }] }]
  const run = createRun({ cfg, providers, publisher, interjections, log, onEvent, tags, sessions, latest, rounds, data: cfg.mode === 'decision' ? data : null });
  const { leads, reviewers, participants, stats, emit, heard, tagOf, convo, ideasPerAgent } = run;
  const dataOn = Boolean(run.data?.mcp && cfg.research);
  const knowledgeOn = Boolean(run.data?.knowledge?.dirs?.length);

  const researcher = code ? cfg.research : null;
  emit({
    type: 'run_started',
    topic,
    mode: cfg.mode,
    rounds: cfg.rounds,
    adaptive: Boolean(cfg.adaptive),
    number: number ?? null,
    ...(cfg.items ? { items: true } : {}),
    ...(material ? { material } : {}),
    ...(memoryOut(memory) ? { memory: memoryOut(memory) } : {}),
    ...(subject ? { subject: { type: subject.type, id: subject.id, title: subject.title } } : {}),
    participants: participants.map(brief),
    chair: { ...brief(cfg.chair), part: 'chair' },
    ...(researcher?.factChecker ? { factChecker: { ...brief(researcher.factChecker), part: 'research' } } : {}),
    ...(researcher ? { research: { ...brief(researcher), part: 'research' }, code: { auto: Boolean(code.auto), groups: code.groups, repos: code.auto ? [] : code.repos.map(describeRepo) } } : {}),
    ...(run.data ? { data: { tools: dataOn ? run.data.mcp.allowed.length : 0, knowledge: run.data.knowledge?.sources ?? [] } } : {}),
  });

  const adaptive = Boolean(cfg.adaptive) && (reviewers.length > 0 || cfg.mode === 'decision');
  const until = adaptive ? `，直到${run.stopRule}（最多 ${cfg.rounds} 轮）` : '';
  const more = adaptive ? '每轮' : `${cfg.rounds - 1} 轮`;
  const refine = cfg.mode === 'refine';
  const subjectName = subject ? `${SUBJECT_LABELS[subject.type]}「${subject.title}」` : '';
  const flowText = refine
    ? `第 1 轮主笔各自诊断并给出修改方案，之后${more}「评审提意见 → 主笔修订方案」${until}，最后主编汇总并写出修订版`
    : cfg.mode === 'brainstorm'
    ? `主笔发散 1 轮，之后${adaptive ? '每个循环' : ` ${cfg.rounds - 1} 个循环`}「盲审 → 修订」${until}，最后主编挑选`
    : reviewers.length
      ? `第 1 轮主笔独立出方案，之后${more}「评审提意见 → 主笔互评修订」${until}，最后主席汇总`
      : `第 1 轮独立方案，之后${more}匿名互评与修订${until}，最后主席汇总`;
  const no = number ? ` #${number}` : '';

  await publisher.post({
    speaker: cfg.chair,
    title: `${refine ? `✏️ 打磨${SUBJECT_LABELS[subject.type]}` : cfg.mode === 'brainstorm' ? '💡 脑洞风暴' : '🧭 方案讨论'}${no} 开始`,
    subtitle: reviewers.length ? `主笔：${who(leads)}　评审：${who(reviewers)}` : who(participants),
    body: [
      refine ? `**打磨对象**：${subjectName}` : `**${cfg.mode === 'brainstorm' ? '题目' : '议题'}**`,
      refine ? `**作者的要求**：${topic.trim() || '（没有额外要求）'}` : topic.trim(),
      material ? `\n**材料**：${material.length} 字，所有参与者都能看到（网页上「完整议题」旁边可以展开）。` : null,
      memoryLine(memory),
      '',
      `**流程**：${flowText}。`,
      reviewers.length ? `**主笔**：${who(leads)}\n**评审**：${who(reviewers)}（只提意见，不出方案）` : null,
      code?.auto ? `**代码上下文**：没有指定仓库，调研员会从已登记的 ${code.repos.length} 个仓库里按议题定位相关代码（读本机当前分支），整理成背景资料发给所有人。想指定仓库可以写 \`仓库:别名\`，不想读代码写 \`仓库:无\`` : null,
      code && !code.auto ? `**代码上下文**：先由调研员只读查看下面的仓库，整理成背景资料发给所有人\n${code.repos.map((r) => `- ${describeRepo(r)}`).join('\n')}` : null,
      !code && cfg.mode === 'decision' ? `**代码上下文**：本场无代码，参与者不能查代码，也不会核实代码事实；涉及代码现状的说法都按未核实处理。${cfg.research?.factChecker ? `\n**联网资料**：主席先判断要不要联网搜集公开资料；需要的话由${cfg.research.factChecker.role ? cfg.research.factChecker.role.replace(/^代码核实 · /, '') : '核实员'}联网查、调研员联网审查纠正后再发给所有人。讨论中的待核实问题也联网查。搜索关键词不带公司内部信息。` : ''}` : null,
      dataOn ? `**实时数据**：主席先判断要不要在讨论前查生产数据、日志、监控或部署状态；需要的话由核实员用数据工具查、调研员审查后发给所有人。讨论中的待核实问题也可以用数据工具查（只读）。` : null,
      knowledgeOn ? `**业务知识**：核实和调研时带上这些知识来源：${run.data.knowledge.sources.join('、')}。` : null,
      interjections ? (refine ? '**插话**：在页面下方输入，会在下一轮开始时交给所有模型。' : '**插话**：直接在群里发消息，会在下一轮开始时交给所有模型。') : null,
      refine ? '**写回**：修订版不会自动写回墨稿，要你在页面上确认。' : null,
    ].filter((l) => l !== null).join('\n'),
  });

  // ---------- 讨论前：调研员读代码 ----------
  let context = researcher ? await run.codeResearch({ topic, code, knowledgeOn }) : null;

  // ---------- 本场无代码：联网搜集资料（网页阵容选了核实员时） ----------
  const webEnabled = cfg.mode === 'decision' && !context && Boolean(cfg.research?.factChecker);
  if (webEnabled) context = await run.webResearch({ topic });

  // ---------- 实时数据：网页上选了数据工具时，主席判断要不要先查 ----------
  const dataContext = dataOn ? await run.dataResearch({ topic }) : null;

  // 议题和背景资料整场不变，所有人共用同一份系统提示词，后面的调用都能命中缓存
  run.shared = sharedSystem({ mode: cfg.mode, topic, context, subject, dataContext, material, memory: memory?.block });
  // 调研员确认涉及代码后，讨论中才能查代码、核实事实；本场无代码时可以联网核实
  if (context && !context.web) run.code = code;
  run.web = webEnabled;

  // ---------- 第 1 轮：主笔出方案 ----------
  await run.pullInterjections();
  const first = await run.runStage(leads, 1, cfg.mode === 'brainstorm' ? 'diverge' : refine ? 'diagnose' : 'propose', (p) => (cfg.mode === 'brainstorm'
    ? divergePrompt({ ideasPerAgent, interjections: run.ijFor(p), ownTag: convo ? tagOf(p) : undefined })
    : proposePrompt({ interjections: run.ijFor(p), ownTag: convo ? tagOf(p) : undefined, mode: cfg.mode, subject, limits: run.limits })));
  const minLeads = reviewers.length ? 1 : 2;
  if (first.length < minLeads) {
    throw new Error(`第 1 轮只有 ${first.length} 位主笔成功发言，讨论无法继续`);
  }
  for (const e of first) latest.set(e.id, e);

  // ---------- 后续轮次 ----------
  const iterated = cfg.rounds >= 2 ? await run.iterate({ from: 2, to: cfg.rounds, adaptive }) : { lastRound: 1, ending: { reason: 'fixed', round: 1 } };
  const { lastRound, ending } = iterated;

  // ---------- 主文档 ----------
  await run.pullInterjections();
  await run.factCheck(lastRound + 1); // 最后一轮提出的待核实问题也查掉，主席写文档时以核实结果为准
  await run.postBlockers(ending);
  const blockers = run.blockerArchive();
  const written = await run.writeDoc({
    round: lastRound + 1,
    reason: '讨论结束',
    prompt: (factor) => run.fitChair(({ rounds: hist, facts: checked, omitted }) => `${docPrompt({ mode: cfg.mode, rounds: hist, finals: [...latest.values()].sort(byTag), interjections: heard, ending, noCode: noCodeOf(cfg.mode, context), omitted, blockers: run.chairBlockers() })}${chairFacts(checked)}`, { rounds, facts: run.facts, factor }),
  });
  const docs = written ?? [];
  if (!docs.length) await run.postDocFallback({ round: lastRound + 1, ending, number });
  const doc = docs[0] ?? null;
  const summary = doc?.text ?? null;

  // ---------- 打磨：写修订版 ----------
  const revision = refine && summary ? await run.rewrite({ subject, summary, round: lastRound + 1 }) : null;

  await run.postEnd({
    number,
    title: `讨论${no} 结束`,
    subtitle: `共 ${lastRound} 轮${endingSuffix(ending, run.stopRule)} · ${stats.calls} 次模型调用${stats.failures ? `，${stats.failures} 次失败` : ''}`,
    noCode: noCodeOf(cfg.mode, context),
  });

  const labels = Object.fromEntries([...tags].map(([id, t]) => [id, t.tag]));
  emit({ type: 'run_finished', stats, labels, roundsUsed: lastRound, ending: ending.reason });
  return {
    labels,
    rounds,
    summary,
    interjections: heard,
    stats,
    roundsUsed: lastRound,
    ending,
    context: contextOut(context),
    ...(refine ? { subject: { type: subject.type, id: subject.id, title: subject.title }, revision } : {}),
    doc,
    docs,
    state: exportState({ number, topic, cfg, tags, shared: run.shared, context, code: run.code, facts: run.facts, sessions, latest, rounds, lastRound, summary, docs, subject, revision, ending, docFailed: !docs.length, budget: run.budget, blockers, interjections: heard, data: run.data?.selection, dataContext, material, memory: memoryOut(memory) }),
  };
}

/** 开场卡片里的一行：这次带了哪些记忆（域、档案字数、结论条数）。 */
function memoryLine(memory) {
  if (!memory?.domains?.length) return null;
  return `**记忆**：${memory.domains.map((d) => `${d.label}（${[d.profileChars ? `档案 ${d.profileChars} 字` : '', d.entries ? `结论 ${d.entries} 条` : '', d.omitted ? `另有 ${d.omitted} 条放不下` : ''].filter(Boolean).join('，')}）`).join('、')}，所有参与者都能看到。`;
}
/** 存进讨论状态和运行事件的记忆摘要（不存正文：正文已经在共用的系统提示词里）。 */
const memoryOut = (memory) => (memory?.domains?.length ? { domains: memory.domains } : null);

/**
 * 快问：一位回答（主笔）→ 一位挑刺（评审）→ 回答的一方吸收挑刺、按快问大纲定稿成短文档，共 3 次调用。
 * 不反问、不核实、不查代码；网页上选了知识来源时，索引写进提示词，能读本机文件的模型（claude-cli）可以打开正文。
 * 产出和方案讨论一样存成主文档的版本和讨论状态，结束原因记为「直接回答」：结论页、追问、升级为讨论共用一条管线。
 */
export async function runQuick({ cfg, topic, providers, publisher, log = () => {}, rng = Math.random, onEvent = () => {}, number, data, material, memory, setting, code = null }) {
  const redraft = cfg.mode === 'redraft';
  const kind = redraft ? '改稿' : '快问';
  const tags = assignTags(cfg.participants, rng);
  const sessions = new Map(cfg.participants.map((p) => [p.id, { id: randomUUID(), turns: [], seen: 0 }]));
  const latest = new Map();
  const rounds = [];
  const run = createRun({ cfg, providers, publisher, log, onEvent, tags, sessions, latest, rounds, data: redraft ? null : data });
  const { leads, reviewers, participants, stats, emit, tagOf, convo } = run;
  const answerer = leads[0];
  const critic = reviewers[0] ?? leads[1];
  if (!answerer || !critic) throw new Error(`${kind}需要一位${redraft ? '改稿' : '回答'}（主笔）和一位挑刺（评审）`);
  if (redraft && !String(material ?? '').trim()) throw new Error('改稿需要章节原文');
  const no = number ? ` #${number}` : '';
  const sources = run.data?.knowledge?.sources ?? [];
  // 快问可以带代码：指定了仓库就读这些，没指定时调研员按问题定位（不涉及代码就不带）
  const researcher = code && cfg.research ? cfg.research : null;

  emit({
    type: 'run_started',
    topic,
    mode: cfg.mode,
    rounds: 1,
    adaptive: false,
    number: number ?? null,
    ...(cfg.items ? { items: true } : {}),
    ...(material ? { material } : {}),
    ...(setting ? { setting } : {}),
    ...(memoryOut(memory) ? { memory: memoryOut(memory) } : {}),
    participants: participants.map(brief),
    chair: { ...brief(cfg.chair), part: 'chair' },
    ...(run.data ? { data: { tools: 0, knowledge: sources } } : {}),
    ...(researcher ? { research: { ...brief(researcher), part: 'research' }, code: { auto: Boolean(code.auto), groups: code.groups, repos: code.auto ? [] : code.repos.map(describeRepo) } } : {}),
  });
  await publisher.post({
    speaker: cfg.chair,
    title: `${redraft ? '✍️ 改稿' : '⚡ 快问'}${no} 开始`,
    subtitle: `${redraft ? '改稿' : '回答'}：${answerer.name} · ${answerer.role}　挑刺：${critic.name} · ${critic.role}`,
    body: [
      redraft ? '**作者的要求**' : '**问题**',
      topic.trim() || (redraft ? REDRAFT_DEFAULT_ASK : ''),
      redraft ? `\n**章节原文**：${material.length} 字${setting ? `；**设定与上下文**：${setting.length} 字` : ''}` : material ? `\n**材料**：${material.length} 字` : null,
      '',
      redraft
        ? `**流程**：${answerer.name}先改，${critic.name}对照原文挑刺，最后由${answerer.name}定稿：修改说明加完整的修改稿，共 3 次模型调用。结果只在页面上，自己复制回去，不写回墨稿。`
        : `**流程**：${researcher ? `${researcher.name ?? '调研员'}先${code.auto ? '判断问题涉及哪些登记的仓库、读相关代码（不涉及就跳过）' : '读下面的仓库'}，整理成背景资料，然后` : ''}${answerer.name}先回答，${critic.name}挑刺，最后由${answerer.name}定稿成一份短文档（回答、你可能没考虑到的、需要你补充的、下一步），共 ${researcher ? 4 : 3} 次模型调用。不会停下来反问：缺的信息写在结果里，用追问补充。`,
      researcher && !code.auto ? `**代码上下文**：\n${code.repos.map((r) => `- ${describeRepo(r)}`).join('\n')}` : null,
      memoryLine(memory),
      sources.length ? `**知识来源**：${sources.join('、')}（索引写进提示词；${participants.filter((p) => run.readsFiles(p)).map((p) => p.name).join('、') || '没有模型'}能打开正文）` : null,
      `**内容去向**：${redraft ? '章节和设定' : '问题和材料'}会发给这两位模型所在的服务（${[...new Set(participants.map((p) => p.provider))].join('、')}），不发到群里。`,
    ].filter((l) => l !== null).join('\n'),
  });

  const context = researcher ? await run.codeResearch({ topic: material ? `${topic}\n\n（另附材料 ${material.length} 字，见下方）` : topic, code, knowledgeOn: Boolean(run.data?.knowledge?.dirs?.length), required: false }) : null;
  run.shared = sharedSystem({ mode: cfg.mode, topic, material, memory: memory?.block, setting, context });
  const say = async (p, stage, task) => {
    const k = run.knowledgeFor(p);
    const session = convo ? sessions.get(p.id) : null;
    const text = await run.speak(p, { stage, round: 1, system: run.shared, prompt: `${participantSystem(p, { mode: cfg.mode })}\n\n${task(k)}`, session, check: run.checkOf(stage), callOptions: k.callOptions });
    if (text != null) rounds.push({ round: 1, stage, entries: [{ id: p.id, label: tags.get(p.id).label, tag: tagOf(p), text: splitReply(text).shown }] });
    return text;
  };

  // ---------- 回答 / 改稿 ----------
  const answer = await say(answerer, redraft ? 'redraft' : 'quickanswer', (k) => (redraft ? redraftPrompt() : quickAnswerPrompt({ knowledge: k.text, canRead: k.canRead })));
  if (answer == null) throw new Error(`${answerer.name}没能${redraft ? '改稿' : '回答'}，${kind}没有完成`);
  const parts = splitReply(answer);
  const shown = parts.shown;
  // 改稿：完整的修改稿写在「【完整方案】」之后；没按格式写时整段当修改稿
  const draft = redraft ? parts.plan ?? answer : null;
  latest.set(answerer.id, { id: answerer.id, label: tags.get(answerer.id).label, tag: tagOf(answerer), text: shown, ...(draft ? { plan: draft } : {}) });

  // ---------- 挑刺 ----------
  const challenge = await say(critic, 'challenge', (k) => (redraft ? redraftChallengePrompt({ notes: parts.plan ? shown : '', draft, items: cfg.items }) : quickChallengePrompt({ answer: shown, knowledge: k.text, canRead: k.canRead, items: cfg.items })));
  if (challenge == null) log(`⚠️ ${critic.name}挑刺失败，只按${redraft ? '修改稿' : '回答'}定稿`);
  const critique = challenge == null ? null : splitReply(challenge).shown;

  // ---------- 定稿：回答（改稿）的一方写成文档 ----------
  const truncatedBefore = run.truncations;
  const written = await run.writeDoc({
    writer: answerer,
    round: 2,
    reason: `${kind}定稿`,
    check: false,
    prompt: redraft ? redraftFinalPrompt({ notes: parts.plan ? shown : '', draft, challenge: critique }) : quickFinalPrompt({ answer: shown, challenge: critique }),
  });
  const docs = written ?? [];
  if (!docs.length) {
    await publisher.post({ speaker: cfg.chair, title: `${kind}定稿失败`, subtitle: `${redraft ? '修改稿' : '回答'}见上面`, body: `${answerer.name}没能写出${kind}文档，上面的${redraft ? '修改稿' : '回答'}${challenge == null ? '' : '和挑刺'}就是这次的结果。可以追问一次，会重新整理。`, meta: { stage: 'fallback', round: 2 } });
  }
  const doc = docs[0] ?? null;
  // 改稿：修改稿太短或者输出被截断，多半没写完，提醒作者别直接用
  if (redraft && doc) {
    const final = doc.attachments?.['修改稿'] ?? '';
    const warn = !final ? '定稿里没有「修改稿」附录，完整修改稿只能从第一步的卡片里取。'
      : run.truncations > truncatedBefore ? '定稿时模型输出到了长度上限，修改稿可能没写完。'
      : final.length < material.length * 0.6 ? `修改稿只有 ${final.length} 字，原文 ${material.length} 字，可能有段落被省略了。` : '';
    if (warn) {
      log(`⚠️ ${warn}`);
      await publisher.post({ speaker: cfg.chair, title: '⚠️ 修改稿可能不完整', subtitle: '复制前先核对', body: `${warn}可以追问「把修改稿完整写出来」，或者把章节拆短一点再改。`, meta: { stage: 'fallback', round: 2 } });
    }
  }
  const summary = doc?.text ?? shown;
  const ending = { reason: 'answered', round: 1 };
  await run.postEnd({ number, title: `${kind}${no} 完成`, subtitle: `${stats.calls} 次模型调用${stats.failures ? `，${stats.failures} 次失败` : ''}` });

  const labels = Object.fromEntries([...tags].map(([id, t]) => [id, t.tag]));
  emit({ type: 'run_finished', stats, labels, roundsUsed: 1, ending: ending.reason });
  const state = exportState({ number, topic, cfg, tags, shared: run.shared, context, code: context ? code : null, facts: [], sessions, latest, rounds, lastRound: 1, summary, docs, ending, docFailed: !docs.length, budget: run.budget, blockers: [], interjections: [], data: run.data?.selection, material, memory: memoryOut(memory) });
  return {
    labels,
    rounds,
    summary,
    interjections: [],
    stats,
    roundsUsed: 1,
    ending,
    context: null,
    doc,
    docs,
    state: setting ? { ...state, setting } : state,
  };
}

/**
 * 追问：在原讨论的会话上接着进行。
 * 主席先判断直接回答还是重新讨论；重新讨论时主笔在各自的会话里回应追问并修订，
 * 之后照常「评审提意见 → 主笔修订」，直到评审没有新意见（最多 cfg.followUpMaxRounds 轮），主席把结论改进主文档。
 * 直接回答的也会让主席判断要不要改主文档。还没有主文档的旧讨论，重新讨论后补写一份。
 *
 * @param {object} opts.state  原讨论的状态
 * @returns {Promise<{ handling, answer, stats, state }>}  state 是更新后的，调用方负责写回
 */
export async function runFollowUp({ cfg, state, question, providers, publisher, interjections, log = () => {}, onEvent = () => {}, code, context: contextMode, data }) {
  if (state?.version !== STATE_VERSION) throw new Error('讨论状态的版本不对，无法追问');
  if (state.expired) throw new Error(`讨论 #${state.number} 已超过保留期，会话已清理，请重新发起讨论`);
  if (state.items && !cfg.items) cfg = { ...cfg, items: true };
  const tags = new Map(Object.entries(state.tags));
  // 追问里的插话从头算，seen 归零
  const sessions = new Map(Object.entries(state.sessions).map(([id, s]) => [id, { ...s, turns: [...s.turns], seen: 0 }]));
  const latest = new Map(state.latest.map((e) => [e.id, e]));
  const rounds = [...state.rounds];
  const run = createRun({ cfg, providers, publisher, interjections, log, onEvent, tags, sessions, latest, rounds, facts: state.facts ?? [], budget: state.budget, data: state.mode === 'decision' || state.mode === 'quick' ? data : null });
  run.rulings = (state.followUps ?? []).filter((f) => f.handling === 'verdict').map((f) => f.ruledAfter);
  const { leads, participants, stats, emit, heard, ideasPerAgent, tagOf } = run;
  // 快问的追问固定走直接回答：不经过主席分流，由回答的一方只靠现在的快问文档回答，再更新文档
  const quick = state.mode === 'quick' || state.mode === 'redraft';
  const redraft = state.mode === 'redraft';
  run.shared = state.shared; // 和原讨论完全一样，缓存还能命中
  // 原讨论带了代码背景时，调用方会重新准备代码目录：追问中照样能查代码、核实事实
  if (code && state.context && !state.context.web) run.code = code;
  // 本场无代码、阵容里有核实员：追问中的待核实问题照样联网查
  run.web = !run.code && state.mode === 'decision' && Boolean(cfg.research?.factChecker);
  const no = state.number ? ` #${state.number}` : '';
  const maxRounds = cfg.followUpMaxRounds ?? 10;

  // 追问的会话：resume 接着原会话；fresh 给每位参与者开一条新会话，第一条消息由程序按预算拼出讨论现状
  const ctxMode = (contextMode ?? cfg.followUpContext) === 'fresh' ? 'fresh' : 'resume';
  const retired = [];
  const pastInterjections = [...(state.interjections ?? [])];
  if (ctxMode === 'fresh') {
    for (const p of participants) {
      const old = sessions.get(p.id);
      if (old?.id) retired.push({ id: old.id, participant: p.id, at: new Date().toISOString() });
      sessions.set(p.id, { id: randomUUID(), turns: [], seen: 0, factsSeen: run.facts.length });
    }
    const currentDoc = state.docs?.at(-1)?.text ?? state.summary ?? '';
    run.freshFor = (p, session) => {
      if (!session || session.turns.length) return '';
      // 参与者的预算：窗口的 PARTICIPANT_SHARE；必须保留的内容（主文档、方案、阻断存档、插话）不受限，核实结果按预算从新到旧放
      const window = p.contextWindow ?? run.budget.windows[`${p.provider}:${p.model ?? ''}`];
      const total = budgetChars({ window, share: PARTICIPANT_SHARE, tokensPerChar: run.budget.tokenRatios[p.provider] });
      const own = latest.get(p.id);
      const others = run.latestOthers(p);
      const build = (facts, omitted) => freshBlock({ doc: currentDoc, blockers: run.chairBlockers(), own, others, facts, omitted, interjections: [...pastInterjections, ...heard] });
      const fit = fitHistory({ facts: run.facts, budgetChars: total - build([], '').length - (run.shared?.length ?? 0) });
      return build(fit.facts, fit.note);
    };
    log(`追问用新会话：${participants.length} 位参与者各开一条新会话，第一条消息带上讨论现状`);
  }

  emit({
    type: 'run_started',
    topic: question,
    mode: state.mode,
    rounds: maxRounds,
    adaptive: true,
    followUpOf: state.number ?? null,
    parentTopic: state.topic,
    participants: participants.map(brief),
    chair: { ...brief(cfg.chair), part: 'chair' },
  });
  await publisher.post({
    speaker: cfg.chair,
    title: `🔁 追问 · 讨论${no}`,
    subtitle: state.topic.split('\n')[0].slice(0, 60),
    body: quick
      ? `**追问**\n${question.trim()}\n\n${leads[0]?.name ?? '回答的一方'}按现在的${redraft ? '改稿文档和修改稿直接回答，需要再改时更新修改稿' : '快问文档直接回答，再把结论改进文档。想深入讨论可以在页面上「升级为讨论」'}。`
      : `**追问**\n${question.trim()}\n\n主席先判断怎么处理：讨论记录里能回答的直接回答；对分歧做选择的按裁决定稿；要查证事实的先核实；需要重新权衡的让参与者再讨论（${ctxMode === 'fresh' ? '各开一条新会话，带上讨论现状' : '接着原来的会话'}）。`,
  });

  // ---------- 主席判断 ----------
  const triage = quick ? null : await run.speak(cfg.chair, {
    stage: 'triage',
    round: state.lastRound,
    system: run.shared,
    prompt: run.fitChair(({ rounds: hist, facts: checked, omitted }) => `${chairSystem(state.mode)}\n\n${triagePrompt({ rounds: hist, finals: [...latest.values()].sort(byTag), summary: state.summary, question, followUps: state.followUps, isDoc: Boolean(state.docs?.length), omitted, blockers: run.chairBlockers(), canVerify: run.canCheck() })}${chairFacts(checked)}`, { rounds: state.rounds, facts: run.facts, stage: 'triage' }),
  });
  // 主席判断失败时不放弃这次追问：按重新讨论处理，让参与者直接回应追问
  if (!triage && !quick) log('⚠️ 主席没能判断这次追问，按重新讨论处理');
  let handling = quick ? 'answer' : triage ? parseTriage(triage) : 'discuss';
  // 裁决型要有选中的方案或「合并」，核实型要有问题且能核实；不满足时按重新讨论处理
  const pick = handling === 'verdict' ? parseVerdictPick(triage) : null;
  const verifyQuestions = handling === 'verify' ? parseVerifyQuestions(triage) : [];
  if (handling === 'verdict' && !pick.target) handling = 'discuss';
  if (handling === 'verify' && (!verifyQuestions.length || !run.canCheck())) handling = 'discuss';
  const followUps = [...(state.followUps ?? [])];
  let answer = triage ? stripTriageLine(triage) : '';
  let lastRound = state.lastRound;
  let ending = { reason: 'answered', round: state.lastRound };
  let docFailed = false;
  let revision = null;
  const docs = [...(state.docs ?? [])];
  const current = docs.at(-1) ?? null;
  const reason = `追问：${question.trim().split('\n')[0].slice(0, 30)}`;

  if (handling === 'answer') {
    const answerer = quick ? leads[0] : null;
    if (quick) {
      if (!answerer) throw new Error('这场快问没有回答的一方，不能追问');
      const k = run.knowledgeFor(answerer);
      const text = await run.speak(answerer, {
        stage: 'answer',
        round: state.lastRound,
        system: run.shared,
        prompt: `${participantSystem(answerer, { mode: state.mode })}\n\n${quickFollowUpPrompt({ doc: current?.text ?? state.summary ?? '', version: current?.version ?? 1, attachments: current?.attachments, followUps: state.followUps, question, knowledge: k.text, canRead: k.canRead, redraft })}`,
        callOptions: k.callOptions,
      });
      if (text == null) throw new Error(`${answerer.name}没能回答这次追问`);
      answer = splitReply(text).shown;
    } else log('主席判断：直接回答');
    // 回答里有值得留下的信息时改进主文档；只是解释文档里已有的内容时不改
    const out = current ? await run.writeDoc({
      previous: current,
      existing: docs,
      round: state.lastRound,
      reason,
      check: false,
      ...(answerer ? { writer: answerer } : {}),
      prompt: docUpdatePrompt({ mode: state.mode, doc: current.text, attachments: current.attachments, version: current.version, otherDocs: othersOf(docs, current), question, handling, answer }),
    }) : null;
    const doc = firstDoc(out);
    if (out?.length) docs.push(...out);
    followUps.push({ question, handling, answer, ...(doc?.text ? { doc: doc.version } : {}), context: ctxMode, at: new Date().toISOString() });
    await run.postEnd({ title: `追问已回答 · ${redraft ? '改稿' : quick ? '快问' : '讨论'}${no}`, subtitle: `${quick ? `${answerer.name}` : '主席'}直接回答 · ${stats.calls} 次模型调用` });
  } else if (handling === 'verdict') {
    // ---------- 裁决型：被选中的主笔按裁决定稿；选择不对应单个方案时由主席合并。不再经过评审 ----------
    log(`主席判断：裁决，${pick.target === 'merge' ? '由主席合并定稿' : `由${pick.target}的主笔定稿`}`);
    const r0 = state.lastRound + 1;
    await run.pullInterjections();
    const chosen = pick.target === 'merge' ? null : leads.find((p) => latest.has(p.id) && tagOf(p) === pick.target) ?? null;
    let final = null;
    if (chosen) {
      const [e] = await run.runStage([chosen], r0, 'final', (p) => finalPrompt({ round: r0, question, ruling: pick.ruling, others: run.latestOthers(p), interjections: run.ijFor(p), mode: state.mode, limits: run.limits }));
      if (e) {
        latest.set(e.id, e);
        final = { tag: e.tag, plan: e.plan ?? e.text };
        lastRound = r0;
      } else log(`⚠️ ${pick.target}的主笔没写出定稿，由主席按裁决合并`);
    }
    ending = { reason: 'verdict', round: lastRound };
    const finals = [...latest.values()].sort(byTag);
    const out = await run.writeDoc(current
      ? {
        previous: current,
        existing: docs,
        round: r0,
        reason,
        check: false,
        prompt: (factor) => run.fitChair(({ facts: checked, omitted }) => `${docUpdatePrompt({ mode: state.mode, doc: current.text, attachments: current.attachments, version: current.version, otherDocs: othersOf(docs, current), question, handling, ruling: pick.ruling, final, finals, interjections: heard, omitted, blockers: run.chairBlockers() })}${chairFacts(checked)}`, { facts: run.facts, factor }),
      }
      : {
        round: r0,
        reason: `补写（${reason}）`,
        check: false,
        prompt: (factor) => run.fitChair(({ rounds: hist, facts: checked, omitted }) => `${docPrompt({ mode: state.mode, rounds: hist, finals, interjections: heard, omitted, blockers: run.chairBlockers(), earlier: earlierOf(state.summary, [...followUps, { question, answer: `人的裁决：${pick.ruling}${final ? `\n\n定稿方案：\n${final.plan}` : '\n\n（由主席按裁决合并定稿）'}` }]) })}${chairFacts(checked)}`, { rounds, facts: run.facts, factor }),
      });
    const doc = firstDoc(out);
    if (out?.length) docs.push(...out);
    else if (!doc) {
      docFailed = true;
      await run.postDocFallback({ round: r0, ending, number: state.number });
    }
    answer = doc?.text ? doc.note : pick.ruling;
    // ruledAfter：这次裁决覆盖到第几轮，之前的阻断之后算人已经裁决过
    followUps.push({ question, handling, ruling: pick.ruling, target: pick.target, ruledAfter: state.lastRound, answer, ...(doc?.text ? { doc: doc.version } : {}), context: ctxMode, at: new Date().toISOString() });
    await run.postEnd({ title: `追问已按裁决定稿 · 讨论${no}`, subtitle: `${final ? `${final.tag}按裁决定稿` : '主席按裁决合并定稿'}，未经评审 · ${stats.calls} 次模型调用` });
  } else if (handling === 'verify') {
    // ---------- 核实型：按主席列的问题核实（有代码读代码，无代码联网），主席把结论合进主文档。不进入多轮讨论 ----------
    log(`主席判断：核实 ${verifyQuestions.length} 个问题`);
    const r0 = state.lastRound + 1;
    run.queueQuestions(verifyQuestions);
    const checked = await run.factCheck(r0);
    ending = { reason: 'verified', round: state.lastRound };
    if (!checked) {
      answer = '这次核实没有成功，可以稍后再追问一次。';
      await publisher.post({ speaker: cfg.chair, title: `追问核实失败 · 讨论${no}`, subtitle: '主文档没有改', body: `要核实的问题：\n${verifyQuestions.map((q) => `- ${q}`).join('\n')}\n\n${answer}`, meta: { stage: 'verify', round: r0 } });
      followUps.push({ question, handling, questions: verifyQuestions, answer, failed: true, context: ctxMode, at: new Date().toISOString() });
    } else {
      const out = await run.writeDoc(current
        ? {
          previous: current,
        existing: docs,
          round: r0,
          reason,
          check: false,
          prompt: (factor) => run.fitChair(({ facts: f, omitted }) => `${docUpdatePrompt({ mode: state.mode, doc: current.text, attachments: current.attachments, version: current.version, otherDocs: othersOf(docs, current), question, handling, verifyQuestions, interjections: heard, omitted })}${chairFacts(f)}`, { facts: run.facts, factor }),
        }
        : {
          round: r0,
          reason: `补写（${reason}）`,
          check: false,
          prompt: (factor) => run.fitChair(({ rounds: hist, facts: f, omitted }) => `${docPrompt({ mode: state.mode, rounds: hist, finals: [...latest.values()].sort(byTag), interjections: heard, omitted, earlier: earlierOf(state.summary, followUps) })}${chairFacts(f)}`, { rounds, facts: run.facts, factor }),
        });
      const doc = firstDoc(out);
    if (out?.length) docs.push(...out);
      answer = doc?.text ? doc.note : run.facts.at(-1).answer;
      followUps.push({ question, handling, questions: verifyQuestions, answer, ...(doc?.text ? { doc: doc.version } : {}), context: ctxMode, at: new Date().toISOString() });
    }
    await run.postEnd({ title: `追问已核实 · 讨论${no}`, subtitle: `核实 ${verifyQuestions.length} 个问题${checked ? '' : '（失败）'} · ${stats.calls} 次模型调用` });
  } else {
    log('主席判断：重新讨论');
    const briefText = answer;
    // ---------- 主笔回应追问 ----------
    const r0 = state.lastRound + 1;
    await run.pullInterjections();
    const activeLeads = leads.filter((p) => latest.has(p.id));
    const revised = await run.runStage(activeLeads, r0, 'followup', (p) => followUpPrompt({
      mode: state.mode, round: r0, question, brief: briefText, others: run.latestOthers(p), interjections: run.ijFor(p), ideasPerAgent, limits: run.limits,
    }));
    if (!revised.length) throw new Error('主笔都没能回应追问');
    for (const e of revised) latest.set(e.id, e);

    // ---------- 评审与修订，直到没有新意见 ----------
    const it = maxRounds >= 2 ? await run.iterate({ from: r0 + 1, to: r0 + maxRounds - 1, adaptive: true, scope: question }) : { lastRound: r0, ending: { reason: 'fixed', round: r0 } };
    lastRound = it.lastRound;
    ending = it.ending;
    await run.pullInterjections();
    await run.factCheck(lastRound + 1);
    const finals = [...latest.values()].sort(byTag);
    // 有主文档就改它；还没有的旧讨论按全部记录补写一份
    const noCode = noCodeOf(state.mode, run.code ? state.context : null);
    await run.postBlockers(it.ending);
    const blockers = run.chairBlockers();
    const out = await run.writeDoc(current
      ? {
        previous: current,
        existing: docs,
        round: lastRound + 1,
        reason,
        prompt: (factor) => run.fitChair(({ rounds: hist, facts: checked, omitted }) => `${docUpdatePrompt({
          mode: state.mode, doc: current.text, attachments: current.attachments, version: current.version, otherDocs: othersOf(docs, current), question, handling, brief: briefText,
          rounds: hist, finals, interjections: heard, ending: it.ending, noCode, omitted, blockers,
        })}${chairFacts(checked)}`, { rounds: rounds.filter((r) => r.round >= r0), facts: run.facts, factor }),
      }
      : {
        round: lastRound + 1,
        reason: `补写（${reason}）`,
        prompt: (factor) => run.fitChair(({ rounds: hist, facts: checked, omitted }) => `${docPrompt({
          mode: state.mode, rounds: hist, finals, interjections: heard, ending: it.ending, noCode, omitted, blockers,
          earlier: earlierOf(state.summary, [...followUps, { question, answer: `（这次追问，第 ${r0} 轮之后的讨论记录就是它的讨论）` }]),
        })}${chairFacts(checked)}`, { rounds, facts: run.facts, factor }),
      });
    const doc = firstDoc(out);
    if (out?.length) docs.push(...out);
    else if (!doc) {
      log('⚠️ 主文档没有更新');
      docFailed = true;
      await run.postDocFallback({ round: lastRound + 1, ending: it.ending, number: state.number });
    }
    answer = doc?.text ? doc.note : null;
    followUps.push({ question, handling, brief: briefText, answer, ...(doc?.text ? { doc: doc.version } : {}), rounds: [r0, lastRound], ending: it.ending.reason, context: ctxMode, ...(triage ? {} : { triageFailed: true }), at: new Date().toISOString() });
    if (state.mode === 'refine' && state.subject && doc?.text) {
      revision = await run.rewrite({ subject: state.subject, summary: doc.text, round: lastRound + 1 });
    }
    await run.postEnd({
      title: `追问讨论结束 · 讨论${no}`,
      subtitle: `追问后讨论了 ${lastRound - r0 + 1} 轮${endingSuffix(it.ending, run.stopRule)} · ${stats.calls} 次模型调用`,
      noCode,
    });
  }

  // fresh 时这次没发言的参与者（例如直接回答、核实）换回原会话，下次追问还能接着原会话
  for (const r of [...retired]) {
    if (!sessions.get(r.participant)?.turns.length) {
      sessions.set(r.participant, { ...state.sessions[r.participant], turns: [...state.sessions[r.participant].turns], seen: 0 });
      retired.splice(retired.indexOf(r), 1);
    }
  }
  emit({ type: 'run_finished', stats, handling, context: ctxMode, roundsUsed: lastRound - state.lastRound, ending: ending.reason });
  const next = {
    ...state,
    updatedAt: new Date().toISOString(),
    sessions: Object.fromEntries(sessions),
    latest: [...latest.values()],
    rounds,
    lastRound,
    followUps,
    facts: run.facts,
    budget: run.budget,
    blockers: run.blockerArchive(),
    interjections: [...pastInterjections, ...heard],
    ...(retired.length || state.retiredSessions?.length ? { retiredSessions: [...(state.retiredSessions ?? []), ...retired] } : {}),
    docs,
    ...(docFailed && !docs.length ? { docFailed: true } : { docFailed: undefined }),
    summary: docs.at(-1)?.text ?? state.summary,
    ...(docs.length && !state.docs?.length && state.summary ? { legacySummary: state.summary } : {}),
    ...(revision ? { revision, revisions: [...(state.revisions ?? []), revision] } : {}),
  };
  return { handling, answer, stats, state: next, revision, context: ctxMode };
}

/** writeDoc 的结果取当前文档那一版：失败为 null，不需要修改为 { unchanged: true }。 */
function firstDoc(out) {
  if (out == null) return null;
  return out[0] ?? { unchanged: true };
}

/** 各份文档的最新一版（按文档编号）。 */
export function latestDocs(docs = []) {
  const by = new Map();
  for (const d of docs) by.set(docNoOf(d), d);
  return [...by.values()].sort((a, b) => docNoOf(a) - docNoOf(b));
}

/** 当前文档之外的其他文档：标题和一句话结论，给主席避免重复。 */
function othersOf(docs, current) {
  return latestDocs(docs).filter((d) => docNoOf(d) !== docNoOf(current)).map((d) => ({ title: d.title ?? docTitle(d.text), lead: oneLine(d) }));
}

function oneLine(d) {
  const m = /\*\*一句话结论\*\*[:：]\s*(.+)/.exec(d.text ?? '');
  return (m ? m[1] : docLead(d.text).split('\n')[0] ?? '').trim().slice(0, 120);
}

/** 旧讨论补写主文档时，原来的汇总和每次追问的结论。 */
function earlierOf(summary, followUps = []) {
  return [
    summary ? `### 讨论结束时的汇总\n${summary}` : '',
    ...followUps.map((f, i) => `### 追问 ${i + 1}：${f.question.trim()}\n${f.answer ?? '（没有结论）'}`),
  ].filter(Boolean).join('\n\n');
}

/**
 * 给还没有主文档的旧讨论补写一份：主席读全部讨论记录和之前的汇总、追问，主笔在各自的会话里核对。
 * 不发到群里（publisher 由调用方给，一般只打印到终端）。返回 { doc, stats, state }，state 由调用方写回。
 */
export async function backfillDoc({ cfg, state, providers, publisher, log = () => {}, onEvent = () => {} }) {
  if (state?.version !== STATE_VERSION) throw new Error('讨论状态的版本不对');
  if (state.docs?.length) throw new Error(`讨论 #${state.number} 已经有主文档了（第 ${state.docs.at(-1).version} 版）`);
  if (state.expired) throw new Error(`讨论 #${state.number} 已超过保留期，会话已清理，主笔没法核对`);
  const tags = new Map(Object.entries(state.tags));
  const sessions = new Map(Object.entries(state.sessions).map(([id, s]) => [id, { ...s, turns: [...s.turns], seen: 0 }]));
  const latest = new Map(state.latest.map((e) => [e.id, e]));
  const rounds = [...state.rounds];
  const run = createRun({ cfg: { ...cfg, mode: state.mode }, providers, publisher, interjections: null, log, onEvent, tags, sessions, latest, rounds, facts: state.facts ?? [], budget: state.budget });
  run.shared = state.shared;
  const written = await run.writeDoc({
    round: state.lastRound + 1,
    reason: '补写',
    prompt: (factor) => run.fitChair(({ rounds: hist, facts: checked, omitted }) => `${docPrompt({ mode: state.mode, rounds: hist, finals: [...latest.values()].sort(byTag), earlier: earlierOf(state.summary, state.followUps), omitted })}${chairFacts(checked)}`, { rounds, facts: run.facts, factor }),
  });
  if (!written?.length) throw new Error('主文档没写成');
  const [doc] = written;
  return {
    doc,
    docs: written,
    stats: run.stats,
    state: { ...state, updatedAt: new Date().toISOString(), sessions: Object.fromEntries(sessions), docs: written, summary: doc.text, legacySummary: state.summary },
  };
}

/**
 * 按现在的写法重写已有的文档（各份文档的最新一版）：不增加新结论，提炼、合并、删重复，细节移进附录；
 * 主席可以把独立的方向拆成新文档。主笔在各自的会话里核对（会话已过期时不核对）。
 * 不发到群里（publisher 由调用方给，一般只打印到终端）。返回 { docs: 这次写出的各版, stats, state }，state 由调用方写回。
 */
export async function rewriteDocs({ cfg, state, providers, publisher, log = () => {}, onEvent = () => {} }) {
  if (state?.version !== STATE_VERSION) throw new Error('讨论状态的版本不对');
  if (!state.docs?.length) throw new Error(`讨论 #${state.number} 还没有主文档，先用 doc ${state.number} 补写`);
  const tags = new Map(Object.entries(state.tags));
  const sessions = new Map(Object.entries(state.sessions ?? {}).map(([id, s]) => [id, { ...s, turns: [...s.turns], seen: 0 }]));
  const latest = new Map((state.latest ?? []).map((e) => [e.id, e]));
  const run = createRun({ cfg: { ...cfg, mode: state.mode }, providers, publisher, interjections: null, log, onEvent, tags, sessions, latest, rounds: [...(state.rounds ?? [])], facts: state.facts ?? [], budget: state.budget });
  run.shared = state.shared;
  if (state.expired) log('会话已过期，主笔不核对，只由主席重写');
  const docs = [...state.docs];
  const out = [];
  for (const current of latestDocs(state.docs)) {
    const written = await run.writeDoc({
      previous: current,
      existing: docs,
      round: state.lastRound + 1,
      reason: '按新写法重写',
      check: !state.expired,
      prompt: docRewritePrompt({ mode: state.mode, doc: current.text, attachments: current.attachments, version: current.version, otherDocs: othersOf(docs, current) }),
    });
    if (written == null) throw new Error(`《${current.title ?? docTitle(current.text)}》没重写成`);
    docs.push(...written);
    out.push(...written);
  }
  return {
    docs: out,
    stats: run.stats,
    state: { ...state, updatedAt: new Date().toISOString(), sessions: Object.fromEntries(sessions), docs, summary: docs.at(-1)?.text ?? state.summary },
  };
}

/**
 * 上下文占用。HTTP 调用和单回合的 claude-cli 调用，输入 tokens 就是这次实际送进去的量（exact）。
 * 多回合（带工具）的 claude-cli 调用，CLI 返回的是各回合的累计值，只能估一个下界（lower）：
 * max(累计 ÷ 回合数, 缓存写入, 这条会话上次已知的占用)。
 */
export function occupancyOf(res, { window = null, last } = {}) {
  const input = res.usage?.inputTokens ?? 0;
  const turns = res.turns ?? 0;
  let tokens = input;
  let kind = 'exact';
  if (turns > 1) {
    kind = 'lower';
    tokens = Math.max(Math.round(input / turns), res.usage?.cacheWriteTokens ?? 0, last ?? 0);
  }
  return { tokens, kind, pct: window ? Math.round((tokens / window) * 1000) / 1000 : null };
}

/** 占用超过这个比例时在卡片上提醒。 */
export const OCCUPANCY_WARN = 0.5;

function pctText(o) {
  if (o?.pct == null) return null;
  return `${o.kind === 'lower' ? '≥' : ''}${Math.round(o.pct * 100)}%`;
}

/** 结束卡片：每位有会话的参与者最近一次的上下文占用。 */
function occupancyLine(participants, occupancy) {
  const items = participants.filter((p) => occupancy.get(p.id)?.pct != null).map((p) => {
    const o = occupancy.get(p.id);
    return `${p.name} ${pctText(o)}${o.pct > OCCUPANCY_WARN ? ' ⚠️' : ''}`;
  });
  if (!items.length) return null;
  const warn = participants.some((p) => occupancy.get(p.id)?.pct > OCCUPANCY_WARN);
  return `**上下文占用**（最近一次发言）：${items.join('，')}${warn ? `。超过 ${OCCUPANCY_WARN * 100}% 的会话再追问几次就可能放不下` : ''}`;
}

/** 讨论怎么结束的，一句话。 */
function endingText(ending) {
  if (!ending) return '';
  if (ending.reason === 'converged') return `第 ${ending.round} 轮提前结束（收敛）`;
  if (ending.reason === 'max') return `到上限 ${ending.round} 轮结束，评审仍有意见`;
  if (ending.reason === 'fixed') return `按固定轮数在第 ${ending.round} 轮结束`;
  if (ending.reason === 'deadlock') return `第 ${ending.round} 轮以分歧结束：主笔连续两轮没改方案，评审仍有阻断`;
  if (ending.reason === 'dissent') return `第 ${ending.round} 轮以评审之间的分歧结束：${ending.tag ?? '一位评审'}连续 3 轮独自坚持阻断`;
  if (ending.reason === 'verdict') return '按人的裁决定稿，未经评审';
  if (ending.reason === 'verified') return '按追问核实了事实';
  return '';
}

/** 结束卡片副标题里的一小段。 */
function endingSuffix(ending, stopRule) {
  if (ending.reason === 'converged') return `，${stopRule}`;
  if (ending.reason === 'max') return '，达到上限仍有意见';
  if (ending.reason === 'deadlock') return '，以分歧结束，待你裁决';
  if (ending.reason === 'dissent') return `，${ending.tag ?? '一位评审'}独自坚持阻断，待你裁决`;
  return '';
}

/** 方案讨论没有带代码背景：主席写文档时要把代码相关的说法标为未核实。 */
function noCodeOf(mode, context) {
  return mode === 'decision' && (!context || Boolean(context.web));
}

/** 存进讨论状态和运行结果的背景资料。联网资料没有仓库。 */
function contextOut(context) {
  if (!context) return null;
  if (context.web) return { web: true, text: context.text, questions: context.questions, ...(context.review ? { review: context.review } : {}) };
  return { auto: Boolean(context.auto), repos: context.repos.map(describeRepo), text: context.text };
}

/**
 * 阻断的来龙去脉（规则见 run.blockerArchive 上的说明）。rounds：讨论记录；reviewers：[{ id, tag }]；
 * rulings：人按裁决定稿过的追问各覆盖到第几轮（这些轮次里的阻断算人已经裁决）。
 * 每位评审的发言按「解决点」切段：他自己写了「没有意见了」的那一轮，或者人的裁决。每段里最近一次行首阻断算已解决（resolved），
 * 往前找当前阻断时不越过最近的解决点（archive）：已经解决的阻断不会再被翻出来。
 */
export function blockerHistoryOf(rounds, reviewers, { rulings = [] } = {}) {
  const archive = [];
  const resolved = [];
  const rules = [...new Set(rulings.filter(Number.isFinite))].sort((a, b) => a - b);
  for (const p of reviewers) {
    const mine = rounds.filter((x) => (x.stage === 'critique' || x.stage === 'feedback') && x.entries.some((e) => e.id === p.id))
      .map((x) => {
        const text = x.entries.find((e) => e.id === p.id).text;
        return { round: x.round, text, verdict: parseVerdict(text), lines: capLines(lineStartBlockers(text)) };
      });
    const last = mine.at(-1);
    if (!last) continue;
    const base = { id: p.id, tag: p.tag };
    const cleared = (from) => mine.find((x) => x.round > from.round)?.round;
    let seg = [];
    let lastClose = null; // 最后一次切段：{ by, at, found }
    const close = (by, at) => {
      const found = [...seg].reverse().find((x) => x.lines.length) ?? null;
      if (found) resolved.push({ ...base, round: found.round, lines: found.lines, by, resolvedAt: at });
      lastClose = { by, at, found };
      seg = [];
    };
    let r = 0;
    for (const x of mine) {
      while (r < rules.length && rules[r] < x.round) close('ruling', rules[r++]);
      if (x.verdict === 'done') close('reviewer', x.round);
      else seg.push(x);
    }
    while (r < rules.length) close('ruling', rules[r++]);
    // 现状只看最后一次发言
    if (last.verdict === 'done') {
      const f = lastClose?.by === 'reviewer' && lastClose.at === last.round ? lastClose.found : null;
      if (f) archive.push({ ...base, round: f.round, lines: f.lines, status: 'done', statusRound: last.round, clearedAt: cleared(f) });
      continue;
    }
    if (!seg.length) continue; // 最后一次发言之后人已经裁决过：没有待处理的
    const found = [...seg].reverse().find((x) => x.lines.length);
    if (found === last) archive.push({ ...base, round: last.round, lines: last.lines, status: 'open' });
    else if (hasBlocker(last.text)) archive.push({ ...base, round: last.round, lines: blockerLines(last.text), status: 'unknown', ...(found ? { prev: { round: found.round, lines: found.lines } } : {}) });
    else if (found) archive.push({ ...base, round: found.round, lines: found.lines, status: 'dropped', clearedAt: cleared(found) });
  }
  return { archive, resolved };
}

/** 阻断原文存档：见 blockerHistoryOf。 */
export const blockerArchiveOf = (rounds, reviewers, opts) => blockerHistoryOf(rounds, reviewers, opts).archive;

/** 存档的行数和长度限制：最多 10 行，每行最多 300 字。 */
const capLines = (lines) => lines.slice(0, 10).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));

/** 发言里带【阻断】的那几行（不管在不在行首），原文照抄。格式未识别的存档用。 */
export function blockerLines(text) {
  return capLines(String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => hasBlocker(l)));
}

/** 超时、HTTP 5xx、连接中断这类临时故障：重试一次。 */
export function isTransient(err) {
  if (!err) return false;
  if (err.retryable === true) return true;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  return /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|network/i.test(`${err.message ?? ''} ${err.cause?.code ?? ''}`);
}

function footerOf(res) {
  const parts = [res.model];
  if (res.durationMs) parts.push(`${(res.durationMs / 1000).toFixed(1)}s`);
  const o = res.occupancy;
  if (res.usage) parts.push(`${o?.kind === 'lower' ? `累计输入 ${res.usage.inputTokens}（${res.turns} 回合）` : `输入 ${res.usage.inputTokens}`} / 输出 ${res.usage.outputTokens} tokens`);
  if (res.usage?.cacheReadTokens && res.usage.inputTokens) parts.push(`缓存命中 ${Math.round((res.usage.cacheReadTokens / res.usage.inputTokens) * 100)}%`);
  const pct = pctText(o);
  if (pct) parts.push(`${o.pct > OCCUPANCY_WARN ? '⚠️ ' : ''}上下文 ${pct}`);
  if (res.truncated) parts.push('⚠️ 输出被截断');
  return parts.filter(Boolean).join(' · ');
}
