import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, ConfigError } from '../config.js';
import { lineupConfig, modelPool, roleTemplates, defaultLineup, tierLineup, MAX_SEATS, readsCode } from '../lineup.js';
import { nextNumber, saveState, removeSessionFiles } from '../state.js';
import { STAGE_LABELS, SUBJECT_LABELS, docChangelog, docTitle, MATERIAL_MAX, SETTING_MAX } from '../modes.js';
import { groupKeys, critiqueDigest, blockerSummary, docSections, itemDigest } from './digest.js';
import { listMemory, appendEntries, deleteEntry, isDomain, memoCandidates, ENTRY_MAX_CHARS } from '../memory.js';
import { RUNS, storeOf, runOne, runPrepared, followUpOne, log as defaultLog } from '../runner.js';
import { claudeSessionFile, DEFAULT_CLAUDE_CWD } from '../providers/claude-cli.js';
import { parseRepoSpecs, resolveRepos, availableRepos } from '../repos.js';
import { appendInbox } from '../inbox.js';
import { createNovelClient } from '../novel.js';
import { hasDataTools, mcpSetup } from '../tools/index.js';
import { inspectKnowledge } from '../knowledge.js';

/**
 * 本地网页：所有讨论（群里发起的和网页上发起的）都能在这里看、插话、追问；
 * 网页上可以发起方案讨论、脑洞风暴（只在网页上，不发群），以及从墨稿挑一项做作品打磨。只监听本机地址，没有登录。
 *
 * 讨论记录都在记录库里（db.js）：一场讨论一行，讨论本身和每次追问各是一次运行，发言、用量事件、插话挂在运行上。
 * 不管讨论是 Lark 监听进程还是网页自己跑的，看到的都一样；进行中的讨论每秒查一次库，有新发言就推给页面。
 * 插话写进正在进行的那次运行，跑讨论的进程每轮开始时读。
 * 列表可以按议题和发言内容搜索、按模式和时间筛选；讨论可以归档（默认不在列表里）和删除。
 *
 * 网页上发起的讨论和追问一场一场排队，由网页进程自己跑；群里发起的讨论在网页上追问时，追问照样发到群里。
 */

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page.html');
const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const MODE_LABELS = { decision: '方案讨论', brainstorm: '脑洞风暴', refine: '作品打磨', quick: '快问', redraft: '改稿' };
/** 方案讨论的档位：小会是两位主笔、一位评审，最多 3 轮。 */
const MEETING_MAX_ROUNDS = 3;

/** runsDir：Lark 监听进程的运行文件所在目录（.watch.state.json）。store：记录库，默认按配置打开。 */
export function createWebApp({ cfg, novel = createNovelClient(cfg.novel), mock = false, store = storeOf(cfg), runsDir = RUNS, log = defaultLog, echo = true, pollMs = 1000, runner = { runOne, runPrepared, followUpOne } } = {}) {
  const queue = [];
  let current = null;
  const failures = new Map(); // 网页跑的讨论在开始运行之前就失败了：编号 -> 错误

  const cfgFor = (mode, rounds) => normalizeConfig(cfg, { mode, ...(rounds !== undefined ? { rounds } : {}) });
  const speakers = () => {
    const all = new Map();
    for (const mode of ['decision', 'refine']) {
      const c = cfgFor(mode);
      for (const s of [...c.participants, c.chair, ...(c.research ? [c.research] : [])]) all.set(`${mode}:${s.id}`, s);
    }
    return all;
  };

  // ---------- 读记录库 ----------

  function readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  /** 一场讨论：{ number, row（discussions 一行）, state, start（讨论本身那次运行的 run_started）, execs（全部运行，讨论在前） } */
  function loadRun(row) {
    const execs = store.executionsOf(row.number);
    const first = execs.find((e) => e.kind === 'discussion');
    return { number: row.number, row, state: row.state, start: first ? store.startEvent(first.id) : null, execs };
  }

  const findRun = (number) => {
    const row = store.discussion(number);
    return row ? loadRun(row) : null;
  };
  const latestExec = (run) => run.execs.at(-1) ?? null;
  const modeOf = (run) => run.state?.mode ?? run.start?.mode ?? run.row.mode ?? 'decision';
  const channelOf = (run) => run.state?.channel ?? run.start?.channel ?? run.row.channel
    ?? (modeOf(run) === 'refine' ? 'web' : (run.state?.dryRun ?? run.start?.dryRun) ? 'dry-run' : 'lark');
  const subjectOf = (run) => run.state?.subject ?? run.start?.subject ?? run.row.info?.subject ?? null;

  /** 发言者 id -> { name, color }：先看这场讨论自己记的阵容（网页上自选的阵容和配置里的不一样），再看配置。 */
  function speakerOf(run) {
    const own = new Map();
    const lineup = run.state?.lineup;
    const start = run.start;
    for (const s of [...(lineup?.participants ?? []), ...(lineup?.chair ? [lineup.chair] : []), ...(lineup?.factChecker ? [lineup.factChecker] : []), ...(start?.participants ?? []), ...(start?.chair ? [start.chair] : []), ...(start?.research ? [start.research] : []), ...(start?.factChecker ? [start.factChecker] : [])]) {
      if (s?.id && !own.has(s.id)) own.set(s.id, s);
    }
    const table = speakers();
    const mode = modeOf(run);
    return (id) => own.get(id) ?? table.get(`${mode}:${id}`) ?? table.get(`decision:${id}`);
  }

  /**
   * 一场讨论的全部发言，按「所属运行（按开始时间）、id」排。每条带轮次、代号、组键；
   * 评审发言另带 verdict / blockerLines / blocked（读取时派生，见 digest.js）。
   */
  function postsOf(run) {
    const who = speakerOf(run);
    const partOf = new Map(run.execs.map((e, i) => [e.id, i]));
    const rows = store.posts(run.execs.map((e) => e.id))
      .map((e) => ({ e, part: partOf.get(e.exec_id) ?? 0 }))
      .sort((x, y) => x.part - y.part || x.e.id - y.e.id);
    const posts = rows.map(({ e, part }, i) => {
      const sp = who(e.speaker);
      const meta = e.meta ?? {};
      const p = {
        seq: i + 1,
        at: e.at,
        speaker: { id: e.speaker, name: sp?.name ?? e.speaker, color: sp?.color ?? 'grey' },
        title: e.title,
        subtitle: e.subtitle ?? '',
        brief: e.brief ?? null,
        body: e.body ?? '',
        plan: e.plan ?? null,
        footer: e.footer ?? '',
        stage: meta.stage ?? null,
        error: meta.error ?? null,
        followUp: part > 0,
        part,
        ...(Number.isFinite(meta.round) ? { round: meta.round } : {}),
        ...(meta.tag ? { tag: meta.tag } : {}),
      };
      if (p.stage === 'critique') Object.assign(p, critiqueDigest(p));
      Object.assign(p, itemDigest(p));
      return p;
    });
    groupKeys(posts).forEach((g, i) => Object.assign(posts[i], g));
    return posts;
  }

  /** 每次运行的结束事件：{ ending, handling, roundsUsed } 或 null（还没结束或失败）。 */
  function finishOf(exec) {
    const ev = store.events(exec.id).filter((r) => r.type === 'run_finished').at(-1);
    return ev ? { ending: ev.ending ?? null, handling: ev.handling ?? null, roundsUsed: ev.roundsUsed ?? null } : null;
  }

  /**
   * 结束状态：结束原因取最近一次结束了的运行的 run_finished；最新一次追问进行中或失败时另作提示；
   * 都找不到时退回讨论状态里存的结束原因。facts：已核实的问题数（讨论状态里各次核实的问题数之和）。
   */
  function outcomeOf(run) {
    const execs = run.execs.filter((e) => e.kind === 'discussion' || e.kind === 'followup');
    const latest = execs.at(-1) ?? null;
    let ending = null;
    let handling = null;
    let from = null;
    for (let i = execs.length - 1; i >= 0; i -= 1) {
      const f = finishOf(execs[i]);
      if (f) {
        ({ ending, handling } = f);
        from = execs[i];
        break;
      }
    }
    let followUpStatus = null;
    if (latest?.kind === 'followup' && latest !== from) followUpStatus = latest.status === 'failed' ? 'failed' : latest.status === 'running' ? 'running' : null;
    if (!ending && run.state?.ending?.reason) ending = run.state.ending.reason;
    const round = from?.kind === 'discussion' || !from ? run.state?.ending?.round ?? null : null;
    const facts = Array.isArray(run.state?.facts) ? run.state.facts.reduce((n, f) => n + (f.questions?.length ?? 0), 0) : null;
    return { ending, round, handling: from?.kind === 'followup' ? handling : null, followUpStatus, facts };
  }

  /** 阻断区块：最后一次含评审发言的运行；它之后还有按裁决定稿的追问时，标题改成「裁决前」。 */
  function blockersOf(run, posts) {
    const s = blockerSummary(posts);
    if (!s) return null;
    const later = run.execs.slice(s.part + 1).some((e) => e.kind === 'followup' && finishOf(e)?.handling === 'verdict');
    return later ? { ...s, beforeVerdict: true } : s;
  }

  /** 主文档每份（docNo）最新一版切段。切不开的记一次日志（同一版只记一次）。 */
  const degraded = new Set();
  function sectionsOf(run, mode) {
    const docs = run.state?.docs ?? [];
    const latest = new Map();
    for (const d of docs) latest.set(d.docNo ?? 1, d);
    return [...latest.values()].map((d) => {
      const s = docSections(d.text, mode);
      const key = `${run.number}:${d.version}`;
      if (s.failed && ['decision', 'quick', 'redraft'].includes(mode) && !degraded.has(key)) {
        degraded.add(key);
        log(`网页：#${run.number} 第 ${d.version} 版主文档未能提取结论（缺：${s.missing.join('、') || '大纲'}），结论页显示全文`);
      }
      return { docNo: d.docNo ?? 1, version: d.version, ...s, ...(s.memo ? { memoItems: memoCandidates(s.memo.text) } : {}) };
    });
  }

  /** 评审结论解析不出（页面标「未识别」）的发言数：数字变了才记一次日志。 */
  const unknownSeen = new Map();
  function logUnknown(run, posts) {
    const crit = posts.filter((p) => p.stage === 'critique' && !p.error);
    const n = crit.filter((p) => p.verdict === null).length;
    if (!n || unknownSeen.get(run.number) === n) return;
    unknownSeen.set(run.number, n);
    log(`网页：#${run.number} 有 ${n}/${crit.length} 条评审发言解析不出评审结论，页面标「未识别」`);
  }

  const alive = (pid) => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  };

  /** 进度：看最新一次运行（讨论本身或最后一次追问）的状态和用量事件。 */
  function progressOf(number, run) {
    const qi = queue.findIndex((j) => j.number === number);
    if (qi >= 0) return { status: 'queued', queuedAhead: qi + (current ? 1 : 0), speaking: [] };
    const exec = run && latestExec(run);
    if (!exec) {
      if (failures.has(number)) return { status: 'failed', error: failures.get(number), speaking: [] };
      if (current?.number === number) return { status: 'running', speaking: [] };
      return { status: 'failed', error: '没有开始：排队时网页进程退出了，或者开始前就出错了', speaking: [] };
    }
    if (exec.status === 'failed') return { status: 'failed', error: exec.error ?? '运行失败', speaking: [] };
    if (exec.status === 'done') return { status: current?.number === number ? 'running' : 'done', speaking: [] };
    if (current?.number !== number && !alive(exec.pid)) return { status: 'failed', error: '跑这场讨论的进程已经退出，讨论没有正常结束', speaking: [] };
    const open = [];
    for (const r of store.events(exec.id)) {
      if (r.type === 'call_started') open.push(r);
      if (r.type === 'call_finished' || r.type === 'call_failed') {
        const i = open.findIndex((x) => x.speaker === r.speaker && x.stage === r.stage && x.round === r.round);
        if (i >= 0) open.splice(i, 1);
      }
    }
    const who = speakerOf(run);
    return {
      status: 'running',
      speaking: open.map((x) => ({ name: who(x.speaker)?.name ?? x.speaker, stage: STAGE_LABELS[x.stage] ?? x.stage, round: x.round, at: x.at })),
    };
  }

  function summaryOf(run) {
    const { state, start, row } = run;
    const mode = modeOf(run);
    const subject = subjectOf(run);
    const topic = state?.topic ?? start?.topic ?? row.topic ?? '';
    const material = state?.material ?? start?.material ?? row.info?.material ?? '';
    return {
      number: run.number,
      mode,
      channel: channelOf(run),
      topic: mode === 'refine' ? subject?.title ?? '' : mode === 'redraft' && !topic.trim() ? `改稿：${material.trim().split('\n')[0].slice(0, 40)}` : topic.split('\n')[0].slice(0, 120),
      requirement: mode === 'refine' ? topic : undefined,
      type: subject?.type,
      createdAt: state?.createdAt ?? start?.at ?? row.created_at ?? null,
      updatedAt: state?.updatedAt ?? null,
      status: progressOf(run.number, run).status,
      followUps: state?.followUps?.length ?? run.execs.filter((e) => e.kind === 'followup').length,
      hasRevision: Boolean(state?.revision),
      docVersion: state?.docs?.at(-1)?.version ?? null,
      applied: state?.applied ?? null,
      mock: Boolean(state?.mock ?? start?.mock ?? row.mock) || (!run.execs.length && mock),
      archived: Boolean(row.archived_at),
      tier: row.info?.tier ?? null,
    };
  }

  /** 列表：q 搜议题和发言内容，mode 模式，days 最近几天，archived 只看归档的。 */
  function listRuns({ q, mode, days, archived } = {}) {
    const since = Number(days) > 0 ? new Date(Date.now() - Number(days) * 86400000).toISOString() : undefined;
    return store.discussions({ q: q || undefined, mode: MODE_LABELS[mode] ? mode : undefined, since, archived: Boolean(archived) })
      .map((row) => summaryOf(loadRun(row)))
      .sort((x, y) => y.number - x.number);
  }

  function runDetail(number) {
    const run = findRun(number);
    if (!run) throw httpError(404, `没有 #${number} 这场讨论`);
    const { state, start, row } = run;
    const mode = modeOf(run);
    const subject = subjectOf(run);
    const progress = progressOf(number, run);
    const lastDiscuss = [...(state?.followUps ?? [])].reverse().find((f) => f.handling === 'discuss');
    const posts = postsOf(run);
    logUnknown(run, posts);
    return {
      number,
      mode,
      channel: channelOf(run),
      topic: state?.topic ?? start?.topic ?? row.topic ?? '',
      tier: row.info?.tier ?? null,
      material: state?.material ?? start?.material ?? null,
      setting: state?.setting ?? start?.setting ?? null,
      // 这场带了哪些记忆；这场已经存进记忆的结论（结论页标「已存入」）
      memory: state?.memory ?? start?.memory ?? null,
      memorySaved: savedFrom(number),
      // 条目化发言（第二期试跑）是按场开的
      items: Boolean(state?.items ?? start?.items),
      subject: subject && subject.fields ? { type: subject.type, id: subject.id, title: subject.title, current: subject.current, background: subject.background, fields: subject.fields, version: subject.version } : subject,
      summary: state?.summary ?? null,
      conclusion: lastDiscuss?.answer ?? state?.summary ?? null,
      // 主文档的所有版本（最新的在最后）；旧讨论没有主文档时为空，页面退回显示汇总
      docs: state?.docs ?? [],
      revision: state?.revision ?? null,
      revisions: state?.revisions ?? [],
      followUps: (state?.followUps ?? []).map((f) => ({ question: f.question, handling: f.handling, answer: f.answer, doc: f.doc ?? null, context: f.context ?? 'resume', at: f.at })),
      followUpContext: cfg.followUpContext === 'fresh' ? 'fresh' : 'resume',
      applied: state?.applied ?? null,
      expired: Boolean(state?.expired),
      archived: Boolean(row.archived_at),
      docFailed: Boolean(state?.docFailed),
      mock: Boolean(state?.mock ?? start?.mock ?? row.mock) || (!run.execs.length && mock),
      dryRun: Boolean(state?.dryRun ?? start?.dryRun),
      code: state?.context && !state.context.web ? { auto: Boolean(state.context.auto), repos: state.context.repos ?? [] } : null,
      web: state?.context?.web ? { questions: state.context.questions ?? [] } : null,
      data: state?.data ? { tools: Boolean(state.data.tools), knowledge: state.data.knowledge ?? [], questions: state.dataContext?.questions ?? [] } : null,
      canFollowUp: Boolean(state) && !state.expired && progress.status !== 'running' && progress.status !== 'queued',
      progress,
      posts,
      // 读取时派生：结束状态、阻断区块、主文档切段（每份文档最新一版）
      outcome: outcomeOf(run),
      blockers: blockersOf(run, posts),
      docSections: sectionsOf(run, mode),
    };
  }

  // ---------- 记忆 ----------

  const memoryDir = () => cfg.memory?.path ?? null;
  /** 这场讨论存进记忆的结论：[{ domain, text }]。 */
  function savedFrom(number) {
    if (!memoryDir()) return [];
    return listMemory(memoryDir()).flatMap((d) => d.entries.filter((e) => e.source === `#${number}`).map((e) => ({ domain: d.id, text: e.text })));
  }
  /** 新建页和记忆页用：各域的档案字数、结论条数（status 里只给概况，/api/memory 给全文）。 */
  function memoryOverview() {
    return listMemory(memoryDir()).map((d) => ({ id: d.id, label: d.label, path: d.path, profileChars: d.profile.length, entries: d.entries.length }));
  }
  /** 人在结论页勾选后存进记忆：只有这里会写记忆文件。 */
  function saveMemory({ number, domain, items }) {
    if (!memoryDir()) throw httpError(409, '记忆目录没有配置（config.json 的 memory.path）');
    if (!isDomain(domain)) throw httpError(400, 'domain 只能是 work、personal 或 novel');
    if (!Array.isArray(items) || !items.length || items.some((t) => typeof t !== 'string')) throw httpError(400, 'items 需要是非空的文字列表');
    if (items.length > 10) throw httpError(400, '一次最多存 10 条');
    if (number !== undefined && number !== null && !store.discussion(number)) throw httpError(404, `没有 #${number} 这场讨论`);
    const out = appendEntries(memoryDir(), domain, items.map((t) => t.slice(0, ENTRY_MAX_CHARS * 2)), { source: number ? `#${number}` : undefined });
    log(`网页：记忆「${domain}」存入 ${out.saved.length} 条${out.skipped.length ? `，${out.skipped.length} 条已经有了` : ''}${number ? `（来自 #${number}）` : ''}`);
    return out;
  }
  function removeMemory({ domain, id }) {
    if (!memoryDir()) throw httpError(409, '记忆目录没有配置');
    if (!deleteEntry(memoryDir(), domain, String(id ?? ''))) throw httpError(404, '没有这条记忆');
    log(`网页：记忆「${domain}」删掉一条`);
    return { ok: true };
  }

  /** 下载主文档的某一版：Markdown，正文后面接附录。 */
  function exportDoc(res, number, version) {
    const run = findRun(number);
    if (!run) throw httpError(404, `没有 #${number} 这场讨论`);
    const doc = (run.state?.docs ?? []).find((d) => d.version === version);
    if (!doc) throw httpError(404, `#${number} 没有第 ${version} 版主文档`);
    const topic = doc.title || docTitle(doc.text) || run.state?.topic || run.row.topic || '';
    const name = docFileName({ number, version, topic });
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="ai-storm-${number}-v${version}.md"; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    res.end(docMarkdown(doc, docChangelog(run.state.docs, version)));
  }

  // ---------- 网页自己跑的讨论 ----------

  async function pump() {
    if (current || !queue.length) return;
    current = queue.shift();
    const job = current;
    const common = { store, echo, mock, interject: true };
    try {
      if (job.kind === 'refine') {
        await runner.runPrepared(job.cfg ?? cfgFor('refine'), { ...common, lark: false, topic: job.topic, number: job.number, subject: job.subject, memory: job.memory });
      } else if (job.kind === 'discuss') {
        await runner.runOne(job.cfg ?? cfgFor(job.mode, job.rounds), { ...common, lark: false, topic: job.topic, material: job.material, setting: job.setting, memory: job.memory, number: job.number, repos: job.repos, data: job.data });
      } else {
        // 群里的讨论在网页上追问：照样发到群里（dry-run 的讨论打印到终端）
        await runner.followUpOne(cfgFor(job.mode), { ...common, lark: job.lark, dryRun: job.dryRun, question: job.question, number: job.number, context: job.context });
      }
    } catch (err) {
      log(`⚠️ #${job.number} 失败：${err.message}`);
      failures.set(job.number, err.message);
    } finally {
      current = null;
      setImmediate(pump);
    }
  }

  function enqueue(job) {
    queue.push(job);
    setImmediate(pump);
  }

  const busyWith = (number) => current?.number === number || queue.some((j) => j.number === number);

  // ---------- 操作 ----------

  /** 页面上选的阵容 -> 这场讨论的配置；不传阵容用配置里的默认阵容。写错了直接 400，不排队。 */
  function jobConfig(mode, rounds, lineup, base = cfg) {
    try {
      return lineupConfig(base, { mode, ...(rounds !== undefined ? { rounds } : {}), lineup });
    } catch (err) {
      if (err instanceof ConfigError) throw httpError(400, err.message.replace(/^配置有误：\n- /, '阵容有误：').replace(/\n- /g, '；'));
      throw err;
    }
  }

  async function startRefine({ type, id, requirement = '', lineup, memory }) {
    if (!SUBJECT_LABELS[type] || !id) throw httpError(400, '需要 type（idea / premise / outline）和 id');
    const mem = memoryPick(memory);
    const jobCfg = jobConfig('refine', undefined, lineup);
    const item = await novel.get(type, id);
    const number = nextNumber(store, { mode: 'refine', topic: String(requirement).slice(0, 4000), channel: 'web', info: { subject: { type: item.type, id: item.id, title: item.title } } });
    const subject = {
      type: item.type,
      id: item.id,
      title: item.title,
      version: item.version,
      background: item.background,
      current: item.current,
      fields: item.fields,
      fieldsSchema: item.fieldsSchema,
      rules: item.rules,
    };
    const topic = String(requirement).slice(0, 4000);
    enqueue({ kind: 'refine', number, subject, topic, cfg: jobCfg, memory: mem.length ? mem : undefined });
    log(`网页：#${number} 打磨${SUBJECT_LABELS[type]}「${item.title}」排队`);
    return { number };
  }

  /** 网页上发起方案讨论或脑洞风暴：只在网页上，不发到群里。 */
  /** 页面上选的数据工具和知识来源：{ tools, knowledge: [名字] }。只用于方案讨论；选了用不上的直接 400。 */
  function dataSelection(mode, data) {
    if (!data || (mode !== 'decision' && mode !== 'quick')) return undefined;
    const tools = data.tools === true && mode === 'decision'; // 快问没有调研员，数据工具没人执行
    const knowledge = Array.isArray(data.knowledge) ? [...new Set(data.knowledge.map(String))] : [];
    const avail = dataAvailable();
    if (tools && !avail.tools.count) throw httpError(400, `选了数据工具，但没有可用的工具：${avail.tools.reason}`);
    const unknown = knowledge.filter((n) => !avail.knowledge.some((k) => k.name === n && k.exists));
    if (unknown.length) throw httpError(400, `这些知识来源用不上（没登记或目录不存在）：${unknown.join('、')}`);
    return tools || knowledge.length ? { tools, knowledge } : undefined;
  }

  /** 能选的数据工具和知识来源。 */
  function dataAvailable() {
    let tools = { count: 0, reason: '' };
    if (!cfg.research) tools.reason = '没有调研员配置（research）';
    else if (!hasDataTools(cfg.dataTools)) tools.reason = 'config.json 里没有 dataTools，或 local/tools 里没有工具';
    else {
      try {
        const setup = mcpSetup(cfg.dataTools);
        tools = { count: setup.allowed.length, sources: [...new Set(setup.listed.map((t) => t.server))], reason: setup.allowed.length ? '' : '没有只读工具' };
      } catch (err) {
        tools.reason = err.message.split('\n')[0];
      }
    }
    const knowledge = inspectKnowledge(cfg.knowledge ?? {}).map((k) => ({ name: k.name, description: k.description, exists: k.exists, docs: k.docs }));
    return { tools, knowledge };
  }

  /**
   * 网页上发起：快问（quick）、方案讨论（decision，tier 为 meeting 时是小会）、脑洞风暴（brainstorm）。
   * material 是「材料」框里的内容，单独限长，不占议题的字数上限。
   */
  /** 记忆：按域勾选（work / personal / novel）。 */
  function memoryPick(memory) {
    const mem = Array.isArray(memory) ? [...new Set(memory.map(String))] : [];
    if (mem.some((d) => !isDomain(d))) throw httpError(400, 'memory 只能是 work、personal、novel 的组合');
    return mem;
  }

  function startDiscussion({ mode, tier, topic, material, setting, memory, repos, rounds, lineup, data, items }) {
    if (!['decision', 'brainstorm', 'quick', 'redraft'].includes(mode)) throw httpError(400, 'mode 只能是 quick、redraft、decision 或 brainstorm');
    const light = mode === 'quick' || mode === 'redraft'; // 两位、一轮
    if (tier !== undefined && tier !== null && tier !== '' && !(tier === 'meeting' && mode === 'decision')) throw httpError(400, 'tier 只能是 meeting（方案讨论的小会）');
    const meeting = tier === 'meeting';
    const text = String(topic ?? '').trim();
    if (!text && mode !== 'redraft') throw httpError(400, `${mode === 'brainstorm' ? '题目' : mode === 'quick' ? '问题' : '议题'}不能为空`);
    const mat = String(material ?? '').trim();
    if (mat.length > MATERIAL_MAX) throw httpError(400, `${mode === 'redraft' ? '章节原文' : '材料'}最多 ${MATERIAL_MAX} 字，现在 ${mat.length} 字`);
    if (mode === 'redraft' && !mat) throw httpError(400, '改稿要贴上章节原文');
    const set = mode === 'redraft' ? String(setting ?? '').trim() : '';
    if (set.length > SETTING_MAX) throw httpError(400, `设定与上下文最多 ${SETTING_MAX} 字，现在 ${set.length} 字`);
    const mem = memoryPick(memory);
    let r;
    if (light || meeting) r = light ? undefined : 'auto';
    else if (rounds !== undefined && rounds !== null && rounds !== '' && rounds !== 'auto') {
      r = Number(rounds);
      if (!Number.isInteger(r) || r < 2 || r > 12) throw httpError(400, '轮数要是 2 到 12 的整数，或者自动');
    } else if (rounds === 'auto') r = 'auto';
    // 快问、小会不传阵容时用各自的默认阵容（方案讨论默认阵容里挑人）
    const seats = lineup ?? (light || meeting ? tierLineup(cfg, meeting ? 'meeting' : mode) : undefined);
    if ((light || meeting) && !seats) throw httpError(400, `配置里的参与者不够组成${meeting ? '小会' : MODE_LABELS[mode]}，请在阵容里选`);
    if (items !== undefined && items !== null && typeof items !== 'boolean') throw httpError(400, 'items 只能是 true 或 false');
    // 条目化发言按场开关（试跑用）；不传就用配置里的 items
    const base = { ...cfg, ...(meeting ? { maxRounds: MEETING_MAX_ROUNDS } : {}), ...(typeof items === 'boolean' ? { items } : {}) };
    const jobCfg = jobConfig(mode, r, seats, base);
    // 仓库：不写 = 方案讨论自动定位；「无」= 不读代码；否则是别名列表。先校验，写错了不排队
    let repoSpecs;
    const repoText = mode === 'redraft' ? '无' : String(repos ?? '').trim(); // 改稿不读代码；快问和方案讨论一样，不写就由调研员按内容定位
    if (repoText) {
      try {
        const specs = parseRepoSpecs(repoText);
        if (specs.length) resolveRepos(cfgFor(mode), specs);
        repoSpecs = repoText;
      } catch (err) {
        throw httpError(400, err.message);
      }
    }
    const picked = mode === 'redraft' ? undefined : dataSelection(mode, data);
    // 改稿没写要求时，列表标题用原文第一行（排队时就要能显示）
    const info = { ...(meeting ? { tier: 'meeting' } : {}), ...(mode === 'redraft' && !text ? { material: mat.split('\n')[0].slice(0, 80) } : {}) };
    const number = nextNumber(store, { mode, topic: text.slice(0, 8000), channel: 'web', ...(Object.keys(info).length ? { info } : {}) });
    enqueue({ kind: 'discuss', number, mode, topic: text.slice(0, 8000), material: mat || undefined, setting: set || undefined, memory: mem.length ? mem : undefined, repos: repoSpecs, rounds: r, cfg: jobCfg, data: picked });
    log(`网页：#${number} ${meeting ? '小会' : MODE_LABELS[mode]}排队`);
    return { number };
  }

  function interject(number, text) {
    const t = String(text ?? '').trim();
    if (!t) throw httpError(400, '插话不能为空');
    const run = findRun(number);
    if (!run || progressOf(number, run).status !== 'running') throw httpError(409, '这场讨论没有在进行，插话不会被看到；讨论结束后可以追问');
    appendInbox(store, latestExec(run).id, { sender: modeOf(run) === 'refine' ? '作者' : '主持人', text: t.slice(0, 4000) });
    return { ok: true, lark: channelOf(run) === 'lark' };
  }

  function followUp(number, question, context) {
    if (context !== undefined && context !== null && context !== '' && !['resume', 'fresh'].includes(context)) throw httpError(400, 'context 只能是 resume 或 fresh');
    const q = String(question ?? '').trim();
    if (!q) throw httpError(400, '追问不能为空');
    const run = findRun(number);
    if (!run?.state) throw httpError(404, `#${number} 还没结束或没有保存状态，不能追问`);
    if (run.state.expired) throw httpError(409, `#${number} 已超过保留期，会话已清理，请重新发起讨论`);
    if (busyWith(number) || progressOf(number, run).status === 'running') throw httpError(409, `#${number} 还在进行或排队中`);
    const channel = channelOf(run);
    enqueue({ kind: 'followup', number, mode: modeOf(run), question: q.slice(0, 4000), lark: channel !== 'web', dryRun: channel === 'dry-run', context: context || undefined });
    return { ok: true, lark: channel === 'lark' };
  }

  async function apply(number, revisionAt) {
    const run = findRun(number);
    const state = run?.state;
    if (!state?.revision) throw httpError(404, `#${number} 还没有修订版`);
    if (busyWith(number)) throw httpError(409, `#${number} 还在进行，等它结束再写回`);
    if (revisionAt && revisionAt !== state.revision.at) throw httpError(409, '页面上的修订版已经过时，刷新后再确认');
    if (state.applied?.revisionAt === state.revision.at) throw httpError(409, '这一版已经写回过了');
    if (state.mock) throw httpError(409, '这是 mock 演练出来的修订版，不写回墨稿');
    const res = await novel.apply({
      type: state.subject.type,
      id: state.subject.id,
      version: state.applied?.version ?? state.subject.version,
      fields: state.revision.fields,
      note: `ai-storm #${number} 打磨写回前`,
    });
    const applied = { at: new Date().toISOString(), revisionAt: state.revision.at, version: res.version };
    saveState(store, { ...state, applied, appliedHistory: [...(state.appliedHistory ?? []), applied] });
    log(`网页：#${number} 修订版已写回墨稿`);
    return { ok: true, applied };
  }

  function archive(number, archived) {
    if (!store.discussion(number)) throw httpError(404, `没有 #${number} 这场讨论`);
    store.setArchived(number, archived !== false);
    log(`网页：#${number} ${archived === false ? '取消归档' : '已归档'}`);
    return { ok: true, archived: archived !== false };
  }

  /** 删除一场讨论的全部记录，连同它的 Claude 会话文件；进行中或排队中的不能删。 */
  function remove(number) {
    const run = findRun(number);
    if (!run) throw httpError(404, `没有 #${number} 这场讨论`);
    if (busyWith(number) || progressOf(number, run).status === 'running') throw httpError(409, `#${number} 还在进行或排队中，等它结束再删`);
    const cwd = cfg.providers?.['claude-cli']?.cwd ?? DEFAULT_CLAUDE_CWD;
    removeSessionFiles(run.state, (id) => claudeSessionFile(cwd, id));
    store.deleteDiscussion(number);
    failures.delete(number);
    log(`网页：#${number} 已删除`);
    return { ok: true };
  }

  function status() {
    const watch = readJson(path.join(runsDir, '.watch.state.json'));
    const { repos, groups } = availableRepos(cfg);
    const people = (mode) => {
      const c = cfgFor(mode);
      return c.participants.map((p) => ({ id: p.id, name: p.name, role: p.role, part: p.part ?? 'lead', color: p.color }));
    };
    return {
      mock,
      novel: novel.baseUrl,
      current: current ? { number: current.number, kind: current.kind } : null,
      queued: queue.map((j) => ({ number: j.number, kind: j.kind })),
      watch: watch && alive(watch.pid) ? { phase: watch.phase, current: watch.current, dryRun: watch.dryRun } : null,
      repos,
      groups,
      maxRounds: cfg.maxRounds,
      items: cfg.items,
      participants: { decision: people('decision'), brainstorm: people('brainstorm'), refine: people('refine') },
      // 新建页的档位：快问、小会的默认阵容（从方案讨论的默认阵容里挑），材料框的上限
      tiers: { quick: tierLineup(cfg, 'quick'), meeting: tierLineup(cfg, 'meeting'), redraft: tierLineup(cfg, 'redraft'), meetingMaxRounds: MEETING_MAX_ROUNDS },
      materialMax: MATERIAL_MAX,
      settingMax: SETTING_MAX,
      memory: memoryDir() ? memoryOverview() : null,
      // 自选阵容：可选的模型、角色模板、各模式的默认阵容
      models: modelPool(cfg).map((m) => ({ id: m.id, name: m.name, provider: m.provider, model: m.model ?? null, color: m.color ?? 'grey', readsCode: readsCode(cfg, m) })),
      roleTemplates: roleTemplates(cfg),
      lineups: { decision: defaultLineup(cfg, 'decision'), brainstorm: defaultLineup(cfg, 'brainstorm'), refine: defaultLineup(cfg, 'refine') },
      maxSeats: MAX_SEATS,
      // 方案讨论能选的数据工具和知识来源
      data: dataAvailable(),
    };
  }

  // ---------- 路由 ----------

  async function route(req, res, url) {
    const exp = /^\/api\/runs\/(\d+)\/docs\/(\d+)\.md$/.exec(url.pathname);
    if (req.method === 'GET' && exp) return exportDoc(res, Number(exp[1]), Number(exp[2]));
    const m = /^\/api\/runs\/(\d+)(?:\/(events|interject|followup|apply|archive|delete))?$/.exec(url.pathname);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(PAGE));
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, status());
    if (req.method === 'GET' && url.pathname === '/api/memory') return json(res, { dir: memoryDir(), domains: listMemory(memoryDir()) });
    if (req.method === 'POST' && url.pathname === '/api/memory/save') return json(res, saveMemory(await body(req)));
    if (req.method === 'POST' && url.pathname === '/api/memory/delete') return json(res, removeMemory(await body(req)));
    if (req.method === 'GET' && url.pathname === '/api/novel/items') return json(res, { items: await novel.list() });
    if (req.method === 'GET' && url.pathname === '/api/novel/item') return json(res, await novel.get(url.searchParams.get('type'), url.searchParams.get('id')));
    if (req.method === 'GET' && url.pathname === '/api/runs') {
      const p = url.searchParams;
      return json(res, { runs: listRuns({ q: p.get('q')?.trim(), mode: p.get('mode'), days: p.get('days'), archived: p.get('archived') === '1' }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/runs') {
      const b = await body(req);
      return json(res, b.type ? await startRefine(b) : startDiscussion(b), 201);
    }
    if (!m) throw httpError(404, '没有这个地址');
    const number = Number(m[1]);
    if (req.method === 'GET' && !m[2]) return json(res, runDetail(number));
    if (req.method === 'GET' && m[2] === 'events') return sse(req, res, number);
    if (req.method === 'POST' && m[2] === 'interject') return json(res, interject(number, (await body(req)).text));
    if (req.method === 'POST' && m[2] === 'followup') {
      const b = await body(req);
      return json(res, followUp(number, b.question, b.context), 202);
    }
    if (req.method === 'POST' && m[2] === 'apply') return json(res, await apply(number, (await body(req)).revisionAt));
    if (req.method === 'POST' && m[2] === 'archive') return json(res, archive(number, (await body(req)).archived));
    if (req.method === 'POST' && m[2] === 'delete') return json(res, remove(number));
    throw httpError(405, '不支持的请求');
  }

  /** 每秒查一次库：有新发言就推 post，进度变了就推 progress。 */
  function sse(req, res, number) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    let sent = Number(new URL(req.url, 'http://x').searchParams.get('after') ?? 0);
    let lastProgress = '';
    let lastBlockers = '';
    const tick = () => {
      try {
        const run = findRun(number);
        if (run) {
          const posts = postsOf(run);
          for (const p of posts) {
            if (p.seq > sent) {
              res.write(`event: post\ndata: ${JSON.stringify(p)}\n\n`);
              sent = p.seq;
            }
          }
          // 阻断区块随新评审发言变化（进行中状态条上的阻断数靠它更新）
          const blockers = JSON.stringify(blockersOf(run, posts));
          if (blockers !== lastBlockers) res.write(`event: blockers\ndata: ${blockers}\n\n`);
          lastBlockers = blockers;
        }
        const prog = JSON.stringify(progressOf(number, run));
        if (prog !== lastProgress) {
          res.write(`event: progress\ndata: ${prog}\n\n`);
          lastProgress = prog;
        }
      } catch (err) {
        log(`⚠️ 推送 #${number} 失败：${err.message}`);
      }
    };
    tick();
    const timer = setInterval(tick, pollMs);
    const beat = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(timer);
      clearInterval(beat);
    });
  }

  async function handle(req, res) {
    try {
      // 只接受本机地址；浏览器里的其他网站不能借你的浏览器来调用（POST 必须同源）
      const host = req.headers.host ?? '';
      if (!LOCAL.test(host)) throw httpError(403, '只接受本机请求');
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}`) throw httpError(403, '不接受跨站请求');
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) throw httpError(415, '需要 JSON');
      }
      await route(req, res, new URL(req.url, `http://${host}`));
    } catch (err) {
      const code = err.status ?? 500;
      if (!err.status) log(`⚠️ 网页出错：${err.stack ?? err.message}`);
      if (!res.headersSent) json(res, { error: err.message }, code);
      else res.end();
    }
  }

  return { handle, queue, idle: () => !current && !queue.length };
}

/**
 * 主文档一版导出成 Markdown：正文原样，附录按顺序接在后面，每份以「附录《标题》」为一级标题；
 * 最后是程序生成的变更记录（旧版本正文里已经写了变更记录的不再重复）。
 */
export function docMarkdown(doc, changelog = '') {
  const parts = [doc.text.trimEnd()];
  for (const [title, text] of Object.entries(doc.attachments ?? {})) parts.push(`# 附录《${title}》\n\n${String(text).trimEnd()}`);
  if (changelog && !/^#{1,3}\s*变更记录/m.test(doc.text)) parts.push(`# 变更记录\n\n${changelog}`);
  return `${parts.join('\n\n---\n\n')}\n`;
}

/** 导出文件名：讨论编号-第N版-议题首行（去掉文件名里不能用的字符，最长 40 字）。 */
export function docFileName({ number, version, topic = '' }) {
  const title = topic.split('\n')[0].replace(/[\\/:*?"<>|#\s]+/g, ' ').trim().slice(0, 40).trim();
  return `讨论${number}-第${version}版${title ? `-${title}` : ''}.md`;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw httpError(413, '请求太大');
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw httpError(400, '不是合法的 JSON');
  }
}

export function startWebServer(app, { host, port, log = defaultLog }) {
  const server = http.createServer((req, res) => app.handle(req, res));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log(`ai-storm 页面：http://${host === '::1' ? '[::1]' : host}:${port}/`);
      resolve(server);
    });
  });
}
