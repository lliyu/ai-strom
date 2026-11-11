import { randomUUID } from 'node:crypto';
import {
  STAGE_LABELS, participantSystem, chairSystem,
  proposePrompt, critiquePrompt, reviewPrompt, decisionSummaryPrompt,
  divergePrompt, feedbackPrompt, revisePrompt, brainstormSummaryPrompt,
  researchSystem, researchPrompt, sharedSystem, parseVerdict, parseStanceChange,
  triagePrompt, parseTriage, stripTriageLine, followUpPrompt, followUpSummaryPrompt,
  refineSummaryPrompt, rewriteSystem, rewritePrompt, parseRevision, SUBJECT_LABELS, FIELD_LABELS,
  limitsFor, splitReply, overLimit, compressPrompt, hasBlocker, PLAN_MARKER,
  parseFactQuestions, factsBlock, factCheckPrompt, codeAccessNote, factAskLine,
} from './modes.js';
import { describeRepo } from './repos.js';
import { estimateCost, priceFor } from './pricing.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
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
function createRun({ cfg, providers, publisher, interjections, log, onEvent, tags, sessions, latest, rounds, facts = [] }) {
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
  const run = { participants, leads, reviewers, reviewerIds, tagOf, convo, heard, stats, emit, ideasPerAgent, limits, shared: '' };
  /**
   * 代码目录（prepareRepos 的结果）：调研员确认议题涉及代码后才设置。
   * 有值时：readCode 的参与者发言时带只读工具；参与者列出的「待核实的事实」由调研员在下一轮开始前查代码回答。
   */
  run.code = null;
  run.facts = [...facts]; // [{ round, questions, answer }]，追问时接着原讨论的
  const research = cfg.research ?? null;
  const factChecking = () => Boolean(run.code && research && research.factCheck !== false);
  const canReadCode = (p) => Boolean(run.code && research && p.readCode === true);
  const toldCode = new Set(); // 本次运行已经拿到完整目录说明的参与者

  /** 各阶段的字数上限：给人看的部分 max，完整方案 plan。 */
  const STAGE_LIMIT = { propose: 'propose', diagnose: 'propose', critique: 'critique', review: 'review', followup: 'followup' };
  run.limitOf = (stage) => {
    const key = STAGE_LIMIT[stage];
    if (!limits || !key) return null;
    return { max: limits[key], brief: limits.brief, plan: stage === 'review' || stage === 'followup' ? limits.plan : undefined, tolerance: limits.tolerance };
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
    } catch (err) {
      log(`⚠️ 读取插话失败，本轮跳过：${err.message}`);
    }
  };

  /** 调一次模型并记账；失败时抛错。 */
  const call = async (speaker, { stage, round, system, prompt, callOptions = {}, session, retry }) => {
    const provider = providers.get(speaker.provider);
    stats.calls += 1;
    const started = Date.now();
    emit({ type: 'call_started', speaker: speaker.id, stage, round, promptChars: prompt.length + (system?.length ?? 0), ...(retry ? { retry } : {}) });
    try {
      const res = await provider.complete({ model: speaker.model, system, prompt, effort: speaker.effort, temperature: speaker.temperature, ...callOptions, ...(session ? { session } : {}) });
      if (session) session.turns.push({ prompt, reply: res.text });
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
        contextWindow: speaker.contextWindow ?? res.contextWindow ?? null,
        costUsd: res.costUsd ?? null,
        ...(estimate ? { costEstimated: true, costOriginal: { amount: estimate.amount, currency: estimate.currency, offPeak: estimate.offPeak } } : {}),
        durationMs: res.durationMs ?? Date.now() - started,
        truncated: Boolean(res.truncated),
        ...(res.turns ? { turns: res.turns } : {}),
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
   * 发言：调模型，超出字数上限（limit）时让它压缩重写一次，然后发布。
   * 卡片上只露出「要点」，详细内容折叠；「【完整方案】」之后的部分不发到群里。
   */
  run.speak = async (speaker, { stage, round, system, prompt, callOptions = {}, session, subtitle, quiet = false, limit = null }) => {
    const tag = tags.get(speaker.id)?.tag;
    const noRound = ['research', 'summary', 'triage', 'rewrite'].includes(stage);
    log(`${speaker.name} · ${STAGE_LABELS[stage]}${stage === 'research' ? '（只读查看代码，通常要几分钟）' : noRound ? '' : ` 第 ${round} 轮`} …`);
    try {
      let res = await call(speaker, { stage, round, system, prompt, callOptions, session });
      const over = limit ? overLimit(res.text, limit) : null;
      if (over) {
        log(`${speaker.name} 超出字数上限（${over}），要求压缩重写`);
        try {
          const shorter = await call(speaker, {
            stage, round, system, callOptions, session, retry: 'compress',
            prompt: compressPrompt({ over, original: session ? null : res.text, limit }),
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
      if (!quiet) {
        const text = stage === 'triage' ? stripTriageLine(res.text) : res.text;
        const parts = splitReply(text);
        await publisher.post({
          speaker,
          title: `${speaker.name}${speaker.role ? ` · ${speaker.role}` : ''}`,
          subtitle: subtitle ?? `${noRound ? '' : `第 ${round} 轮 · `}${STAGE_LABELS[stage]}${tag ? ` · 代号 ${tag}` : ''}`,
          brief: parts.brief,
          body: parts.brief ? parts.detail : parts.shown,
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
      const code = run.codeFor(p, session);
      const text = await run.speak(p, { stage, round, system: run.shared, prompt: `${intro}${code.text}${promptFor(p)}`, session, limit: run.limitOf(stage), callOptions: code.callOptions });
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
  run.codeFor = (p, session) => {
    if (!run.code) return { text: '', callOptions: {} };
    const parts = [];
    const fresh = convo ? run.facts.slice(session?.factsSeen ?? 0) : run.facts;
    if (fresh.length) parts.push(factsBlock(fresh));
    let callOptions = {};
    if (canReadCode(p)) {
      const tools = research.tools ?? ['Read', 'Grep', 'Glob'];
      parts.push(codeAccessNote({ repos: run.code.repos, docs: run.code.docs, tools, full: !(convo && toldCode.has(p.id)) }));
      callOptions = { tools, addDirs: run.code.dirs, timeoutMs: research.timeoutMs, ...(p.maxBudgetUsd ? { maxBudgetUsd: p.maxBudgetUsd } : {}) };
    }
    if (factChecking()) parts.push(factAskLine());
    return { text: parts.length ? `${parts.join('\n\n')}\n\n` : '', callOptions };
  };

  // 已经扫描过「待核实的事实」的轮次条目数；追问时从原讨论之后开始
  let factCursor = rounds.length;
  const normQ = (q) => q.replace(/\s+/g, '').replace(/[？?。.]+$/, '');
  const asked = new Set(run.facts.flatMap((f) => f.questions.map(normQ)));
  let pendingQuestions = [];
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
    const max = research.factCheckMaxQuestions ?? 8;
    const questions = fresh.slice(0, max);
    pendingQuestions = fresh.slice(max);
    if (pendingQuestions.length) log(`待核实的问题有 ${fresh.length} 个，这次先查 ${max} 个，其余留到下一轮`);
    const tools = research.tools ?? ['Read', 'Grep', 'Glob'];
    const answer = await run.speak(research, {
      stage: 'factcheck',
      round,
      system: run.shared,
      prompt: factCheckPrompt({ round, questions, repos: run.code.repos, docs: run.code.docs, tools, maxChars: research.factCheckMaxChars ?? 4000 }),
      callOptions: { tools, addDirs: run.code.dirs, maxBudgetUsd: research.maxBudgetUsd, timeoutMs: research.timeoutMs },
      subtitle: `第 ${round} 轮 · 代码核实 · ${questions.length} 个问题`,
    });
    if (!answer) {
      log('代码核实失败，这些问题下一轮再试');
      pendingQuestions = [...questions, ...pendingQuestions];
      return false;
    }
    for (const q of questions) asked.add(normQ(q));
    run.facts.push({ round, questions, answer });
    emit({ type: 'fact_checked', round, questions: questions.length });
    return true;
  };

  // 自动轮数：有评审时看评审结论，没有评审时看主笔立场是否还在变；脑洞风暴没有评审时按固定轮数
  run.stopRule = reviewers.length ? '评审都没有新意见' : '主笔的立场都不再变化';
  /**
   * 本轮评审是否都表示没有意见：每位评审都要成功发言并写明「没有意见了」；有人失败或没写结论都算继续。
   * 方案讨论和打磨的评审要给问题分级：写了「继续讨论」却没有任何【阻断】级问题，按没有意见处理。
   */
  const graded = cfg.mode !== 'brainstorm';
  const reviewersDone = (entries) => reviewers.length > 0 && reviewers.every((p) => {
    const e = entries.find((x) => x.id === p.id);
    if (!e) return false;
    const verdict = parseVerdict(e.text);
    return verdict === 'done' || (graded && verdict === 'continue' && !hasBlocker(e.text));
  });

  /**
   * 第 from 到 to 轮：方案讨论是「评审提意见 → 主笔互评修订」，脑洞是「盲审 → 修订」。
   * adaptive 时评审都没有新意见（且没有新插话要回应）就提前结束。
   * scope：追问原文，交给评审作为本次讨论范围（主笔已经在回应追问时看过）。
   * 会话模式下每位评审成功收到一次后就不再重复；非会话模式每轮都要带上。
   */
  run.iterate = async ({ from, to, adaptive, scope }) => {
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
        const critiques = reviewers.length
          ? await run.runStage(reviewers, round, 'critique', (p) => critiquePrompt({ round, proposals, interjections: run.ijFor(p), askVerdict: adaptive, convo, mode: cfg.mode, limits, scope: scopeFor(p) }))
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
        }));
      }
      // 本轮失败的主笔沿用上一版
      for (const e of revised) latest.set(e.id, e);
      answered = heard.length;
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
  run.postEnd = async ({ title, subtitle, number }) => {
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
        `**用量**：输入 ${stats.inputTokens} tokens，输出 ${stats.outputTokens} tokens${stats.costUsd ? `，约 $${stats.costUsd.toFixed(2)}` : ''}`,
        heard.length ? `**收到的插话**：${heard.length} 条` : null,
        number && cfg.mode === 'refine' ? '**追问**：在页面上接着追问，主编会判断是直接回答还是重新讨论；重新讨论后会重写修订版。' : null,
        number && cfg.mode !== 'refine' ? `**追问**：发 \`/追问 <问题>\` 接着问这场讨论（更早的讨论写 \`/追问 #${number} <问题>\`），主席会判断是直接回答还是重新讨论。` : null,
      ].filter((l) => l !== null).join('\n'),
    });
  };

  /**
   * 打磨：主编按汇总写出完整修订版。格式不对时把错误告诉它再写一次。
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

/** 讨论结束后可以续接的状态，写到 runs/<讨论>/state.json。 */
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

function exportState({ number, topic, cfg, tags, shared, context, code, facts = [], sessions, latest, rounds, lastRound, summary, followUps = [], createdAt, subject, revision }) {
  return {
    version: STATE_VERSION,
    number: number ?? null,
    topic,
    mode: cfg.mode,
    createdAt: createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: Object.fromEntries(tags),
    shared,
    context: context ? { auto: Boolean(context.auto), repos: context.repos.map(describeRepo), text: context.text } : null,
    code: codeSpecOf(code),
    facts,
    sessions: Object.fromEntries(sessions),
    latest: [...latest.values()],
    rounds,
    lastRound,
    summary,
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
 * @param {function} [opts.onEvent]  用量事件回调（写 usage.jsonl）
 * @param {object} [opts.code]       prepareRepos 的结果：有值时先由调研员读代码，整理背景资料给所有人
 * @param {number} [opts.number]     讨论编号，显示在卡片上，追问时用
 */
export async function runDiscussion({ cfg, topic, providers, publisher, interjections, log = () => {}, rng = Math.random, onEvent = () => {}, code, number, subject }) {
  if (cfg.mode === 'refine' && !subject) throw new Error('打磨模式需要打磨对象（subject）');
  const tags = assignTags(cfg.participants, rng);
  const sessions = new Map(cfg.participants.map((p) => [p.id, { id: randomUUID(), turns: [], seen: 0 }]));
  const latest = new Map(); // 主笔 id -> 最新一版方案
  const rounds = [];        // [{ round, stage, entries: [{ id, label, tag, text }] }]
  const run = createRun({ cfg, providers, publisher, interjections, log, onEvent, tags, sessions, latest, rounds });
  const { leads, reviewers, participants, stats, emit, heard, tagOf, convo, ideasPerAgent } = run;

  const researcher = code ? cfg.research : null;
  emit({
    type: 'run_started',
    topic,
    mode: cfg.mode,
    rounds: cfg.rounds,
    adaptive: Boolean(cfg.adaptive),
    number: number ?? null,
    ...(subject ? { subject: { type: subject.type, id: subject.id, title: subject.title } } : {}),
    participants: participants.map(brief),
    chair: { ...brief(cfg.chair), part: 'chair' },
    ...(researcher ? { research: { ...brief(researcher), part: 'research' }, code: { auto: Boolean(code.auto), groups: code.groups, repos: code.auto ? [] : code.repos.map(describeRepo) } } : {}),
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
      '',
      `**流程**：${flowText}。`,
      reviewers.length ? `**主笔**：${who(leads)}\n**评审**：${who(reviewers)}（只提意见，不出方案）` : null,
      code?.auto ? `**代码上下文**：没有指定仓库，调研员会从已登记的 ${code.repos.length} 个仓库里按议题定位相关代码（读本机当前分支），整理成背景资料发给所有人。想指定仓库可以写 \`仓库:别名\`，不想读代码写 \`仓库:无\`` : null,
      code && !code.auto ? `**代码上下文**：先由调研员只读查看下面的仓库，整理成背景资料发给所有人\n${code.repos.map((r) => `- ${describeRepo(r)}`).join('\n')}` : null,
      interjections ? (refine ? '**插话**：在页面下方输入，会在下一轮开始时交给所有模型。' : '**插话**：直接在群里发消息，会在下一轮开始时交给所有模型。') : null,
      refine ? '**写回**：修订版不会自动写回墨稿，要你在页面上确认。' : null,
    ].filter((l) => l !== null).join('\n'),
  });

  // ---------- 讨论前：调研员读代码 ----------
  let context = null;
  if (researcher) {
    const text = await run.speak(researcher, {
      stage: 'research',
      round: 0,
      system: researchSystem(),
      prompt: researchPrompt({ topic, mode: cfg.mode, repos: code.repos, docs: code.docs, maxChars: researcher.maxChars, auto: code.auto }),
      callOptions: { tools: researcher.tools, addDirs: code.dirs, maxBudgetUsd: researcher.maxBudgetUsd, timeoutMs: researcher.timeoutMs },
      subtitle: code.auto ? '背景资料 · 按议题定位仓库' : `背景资料 · 读了 ${code.repos.map((r) => r.alias).join('、')}`,
    });
    if (!text) throw new Error('代码调研失败，讨论没有开始');
    const cap = Math.round(researcher.maxChars * 1.5);
    if (code.auto && /^\s*无相关代码/.test(text)) {
      log('调研员判断议题不涉及登记的仓库，不带代码讨论');
    } else {
      context = {
        auto: Boolean(code.auto),
        repos: code.repos,
        text: text.length > cap ? `${text.slice(0, cap)}\n\n（资料过长，后面的部分已截断）` : text,
      };
    }
  }

  // 议题和背景资料整场不变，所有人共用同一份系统提示词，后面的调用都能命中缓存
  run.shared = sharedSystem({ mode: cfg.mode, topic, context, subject });
  // 调研员确认涉及代码后，讨论中才能查代码、核实事实
  if (context) run.code = code;

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

  // ---------- 汇总 ----------
  await run.pullInterjections();
  await run.factCheck(lastRound + 1); // 最后一轮提出的待核实问题也查掉，主席汇总时以核实结果为准
  const summary = await run.speak(cfg.chair, {
    stage: 'summary',
    round: lastRound + 1,
    system: run.shared,
    prompt: `${chairSystem(cfg.mode)}\n\n${cfg.mode === 'brainstorm'
      ? brainstormSummaryPrompt({ latest: [...latest.values()].sort(byTag), interjections: heard, ending })
      : refine
        ? refineSummaryPrompt({ rounds, finals: [...latest.values()].sort(byTag), interjections: heard, ending, subject })
        : decisionSummaryPrompt({ rounds, finals: [...latest.values()].sort(byTag), interjections: heard, ending })}${chairFacts(run.facts)}`,
  });

  // ---------- 打磨：写修订版 ----------
  const revision = refine && summary ? await run.rewrite({ subject, summary, round: lastRound + 1 }) : null;

  await run.postEnd({
    number,
    title: `讨论${no} 结束`,
    subtitle: `共 ${lastRound} 轮${ending.reason === 'converged' ? `，${run.stopRule}` : ending.reason === 'max' ? '，达到上限仍有意见' : ''} · ${stats.calls} 次模型调用${stats.failures ? `，${stats.failures} 次失败` : ''}`,
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
    context: context ? { repos: context.repos.map(describeRepo), text: context.text } : null,
    ...(refine ? { subject: { type: subject.type, id: subject.id, title: subject.title }, revision } : {}),
    state: exportState({ number, topic, cfg, tags, shared: run.shared, context, code: run.code, facts: run.facts, sessions, latest, rounds, lastRound, summary, subject, revision }),
  };
}

/**
 * 追问：在原讨论的会话上接着进行。
 * 主席先判断直接回答还是重新讨论；重新讨论时主笔在各自的会话里回应追问并修订，
 * 之后照常「评审提意见 → 主笔修订」，直到评审没有新意见（最多 cfg.followUpMaxRounds 轮），主席说明结论有什么变化。
 *
 * @param {object} opts.state  原讨论的 state.json
 * @returns {Promise<{ handling, answer, stats, state }>}  state 是更新后的，调用方负责写回
 */
export async function runFollowUp({ cfg, state, question, providers, publisher, interjections, log = () => {}, onEvent = () => {}, code }) {
  if (state?.version !== STATE_VERSION) throw new Error('讨论状态的版本不对，无法追问');
  if (state.expired) throw new Error(`讨论 #${state.number} 已超过保留期，会话已清理，请重新发起讨论`);
  const tags = new Map(Object.entries(state.tags));
  // 追问里的插话从头算，seen 归零
  const sessions = new Map(Object.entries(state.sessions).map(([id, s]) => [id, { ...s, turns: [...s.turns], seen: 0 }]));
  const latest = new Map(state.latest.map((e) => [e.id, e]));
  const rounds = [...state.rounds];
  const run = createRun({ cfg, providers, publisher, interjections, log, onEvent, tags, sessions, latest, rounds, facts: state.facts ?? [] });
  const { leads, participants, stats, emit, heard, ideasPerAgent } = run;
  run.shared = state.shared; // 和原讨论完全一样，缓存还能命中
  // 原讨论带了代码背景时，调用方会重新准备代码目录：追问中照样能查代码、核实事实
  if (code && state.context) run.code = code;
  const no = state.number ? ` #${state.number}` : '';
  const maxRounds = cfg.followUpMaxRounds ?? 10;

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
    body: `**追问**\n${question.trim()}\n\n主席先判断：讨论记录里能回答的直接回答；需要重新权衡的，让参与者接着原来的会话再讨论。`,
  });

  // ---------- 主席判断 ----------
  const triage = await run.speak(cfg.chair, {
    stage: 'triage',
    round: state.lastRound,
    system: run.shared,
    prompt: `${chairSystem(state.mode)}\n\n${triagePrompt({ rounds: state.rounds, finals: [...latest.values()].sort(byTag), summary: state.summary, question, followUps: state.followUps })}${chairFacts(run.facts)}`,
  });
  if (!triage) throw new Error('主席没能处理这次追问');
  const handling = parseTriage(triage);
  const followUps = [...(state.followUps ?? [])];
  let answer = stripTriageLine(triage);
  let lastRound = state.lastRound;
  let revision = null;

  if (handling === 'answer') {
    log('主席判断：直接回答');
    followUps.push({ question, handling, answer, at: new Date().toISOString() });
    await run.postEnd({ title: `追问已回答 · 讨论${no}`, subtitle: `主席直接回答 · ${stats.calls} 次模型调用` });
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
    await run.pullInterjections();
    await run.factCheck(lastRound + 1);
    const previous = [...followUps].reverse().find((f) => f.handling === 'discuss')?.answer ?? state.summary;
    answer = await run.speak(cfg.chair, {
      stage: 'summary',
      round: lastRound + 1,
      system: run.shared,
      prompt: `${chairSystem(state.mode)}\n\n${followUpSummaryPrompt({
        mode: state.mode, question, brief: briefText, rounds: rounds.filter((r) => r.round >= r0), finals: [...latest.values()].sort(byTag), previousSummary: previous, interjections: heard, ending: it.ending,
      })}${chairFacts(run.facts)}`,
    });
    followUps.push({ question, handling, brief: briefText, answer, rounds: [r0, lastRound], at: new Date().toISOString() });
    if (state.mode === 'refine' && state.subject && answer) {
      revision = await run.rewrite({ subject: state.subject, summary: state.summary, followUp: answer, round: lastRound + 1 });
    }
    await run.postEnd({
      title: `追问讨论结束 · 讨论${no}`,
      subtitle: `追问后讨论了 ${lastRound - r0 + 1} 轮${it.ending.reason === 'converged' ? `，${run.stopRule}` : it.ending.reason === 'max' ? '，达到上限仍有意见' : ''} · ${stats.calls} 次模型调用`,
    });
  }

  emit({ type: 'run_finished', stats, handling, roundsUsed: lastRound - state.lastRound, ending: handling === 'answer' ? 'answered' : 'followup' });
  const next = {
    ...state,
    updatedAt: new Date().toISOString(),
    sessions: Object.fromEntries(sessions),
    latest: [...latest.values()],
    rounds,
    lastRound,
    followUps,
    facts: run.facts,
    ...(revision ? { revision, revisions: [...(state.revisions ?? []), revision] } : {}),
  };
  return { handling, answer, stats, state: next, revision };
}

function footerOf(res) {
  const parts = [res.model];
  if (res.durationMs) parts.push(`${(res.durationMs / 1000).toFixed(1)}s`);
  if (res.usage) parts.push(`输入 ${res.usage.inputTokens} / 输出 ${res.usage.outputTokens} tokens`);
  if (res.usage?.cacheReadTokens && res.usage.inputTokens) parts.push(`缓存命中 ${Math.round((res.usage.cacheReadTokens / res.usage.inputTokens) * 100)}%`);
  return parts.filter(Boolean).join(' · ');
}
