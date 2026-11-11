import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, ConfigError } from '../config.js';
import { lineupConfig, modelPool, roleTemplates, defaultLineup, MAX_SEATS } from '../lineup.js';
import { listStates, nextNumber, saveState, STATE_FILE, DOC_FILE } from '../state.js';
import { STAGE_LABELS, SUBJECT_LABELS } from '../modes.js';
import { RUNS, runOne, runPrepared, followUpOne, log as defaultLog } from '../runner.js';
import { parseRepoSpecs, resolveRepos, availableRepos } from '../repos.js';
import { appendInbox } from '../inbox.js';
import { createNovelClient } from '../novel.js';

/**
 * 本地网页：所有讨论（群里发起的和网页上发起的）都能在这里看、插话、追问；
 * 网页上可以发起方案讨论、脑洞风暴（只在网页上，不发群），以及从墨稿挑一项做作品打磨。只监听本机地址，没有登录。
 *
 * 讨论记录都在 runs/ 下：每场讨论一个目录，追问各自一个「…-追问#编号-…」目录。
 * 网页直接读这些目录里的 events.jsonl（发言）、usage.jsonl（进度）和 state.json（结论、会话），
 * 所以不管讨论是 Lark 监听进程还是网页自己跑的，看到的都一样；进行中的讨论每秒检查一次文件，有新发言就推给页面。
 * 插话写进正在进行的那个目录的 inbox.jsonl，跑讨论的进程每轮开始时读。
 *
 * 网页上发起的讨论和追问一场一场排队，由网页进程自己跑；群里发起的讨论在网页上追问时，追问照样发到群里。
 */

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page.html');
const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const FOLLOW_UP_DIR = /-追问#(\d+)-/;
const MODE_LABELS = { decision: '方案讨论', brainstorm: '脑洞风暴', refine: '作品打磨' };

export function createWebApp({ cfg, novel = createNovelClient(cfg.novel), mock = false, runsDir = RUNS, log = defaultLog, echo = true, pollMs = 1000, runner = { runOne, runPrepared, followUpOne } } = {}) {
  const queue = [];
  let current = null;
  const pending = new Map(); // 网页上刚排队、还没建目录的讨论：编号 -> { mode, topic, subject }
  const failures = new Map(); // 网页跑的讨论在建目录之前就失败了：编号 -> 错误

  const cfgFor = (mode, rounds) => normalizeConfig(cfg, { mode, ...(rounds !== undefined ? { rounds } : {}) });
  const speakers = () => {
    const all = new Map();
    for (const mode of ['decision', 'refine']) {
      const c = cfgFor(mode);
      for (const s of [...c.participants, c.chair, ...(c.research ? [c.research] : [])]) all.set(`${mode}:${s.id}`, s);
    }
    return all;
  };

  // ---------- 读 runs/ ----------

  function readJsonl(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  }

  function readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  /** 编号 -> { number, dir, start（usage.jsonl 第一行）, state, followDirs } */
  function scan() {
    const runs = new Map();
    const follows = [];
    if (!fs.existsSync(runsDir)) return runs;
    for (const name of fs.readdirSync(runsDir).sort()) {
      const dir = path.join(runsDir, name);
      if (name.startsWith('.') || !fs.statSync(dir).isDirectory()) continue;
      const f = FOLLOW_UP_DIR.exec(name);
      if (f) {
        follows.push({ number: Number(f[1]), dir });
        continue;
      }
      const start = readJsonl(path.join(dir, 'usage.jsonl')).find((r) => r.type === 'run_started');
      const state = readJson(path.join(dir, STATE_FILE));
      const number = state?.number ?? start?.number;
      if (!number) continue; // 命令行 --mock 演练不编号
      runs.set(number, { number, dir, start: start ?? null, state, followDirs: [] });
    }
    for (const f of follows) runs.get(f.number)?.followDirs.push(f.dir);
    return runs;
  }

  const findRun = (number) => scan().get(number) ?? null;
  const dirsOf = (run) => [run.dir, ...run.followDirs];
  const latestDir = (run) => dirsOf(run).at(-1);
  const modeOf = (run) => run.state?.mode ?? run.start?.mode ?? 'decision';
  const channelOf = (run) => run.state?.channel ?? run.start?.channel
    ?? (modeOf(run) === 'refine' ? 'web' : (run.state?.dryRun ?? run.start?.dryRun) ? 'dry-run' : 'lark');

  /** 发言者 id -> { name, color }：先看这场讨论自己记的阵容（网页上自选的阵容和配置里的不一样），再看配置。 */
  function speakerOf(run) {
    const own = new Map();
    const lineup = run.state?.lineup;
    const start = run.start;
    for (const s of [...(lineup?.participants ?? []), ...(lineup?.chair ? [lineup.chair] : []), ...(start?.participants ?? []), ...(start?.chair ? [start.chair] : []), ...(start?.research ? [start.research] : [])]) {
      if (s?.id && !own.has(s.id)) own.set(s.id, s);
    }
    const table = speakers();
    const mode = modeOf(run);
    return (id) => own.get(id) ?? table.get(`${mode}:${id}`) ?? table.get(`decision:${id}`);
  }

  function postsOf(run) {
    const who = speakerOf(run);
    const posts = [];
    for (const [part, dir] of dirsOf(run).entries()) {
      const followUp = part > 0;
      for (const e of readJsonl(path.join(dir, 'events.jsonl'))) {
        const sp = who(e.speaker);
        posts.push({
          seq: posts.length + 1,
          at: e.at,
          speaker: { id: e.speaker, name: sp?.name ?? e.speaker, color: sp?.color ?? 'grey' },
          title: e.title,
          subtitle: e.subtitle ?? '',
          brief: e.brief ?? null,
          body: e.body ?? '',
          plan: e.plan ?? null,
          footer: e.footer ?? '',
          stage: e.meta?.stage ?? null,
          error: e.meta?.error ?? null,
          followUp,
          part,
        });
      }
    }
    return posts;
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

  /** 进度：看最新一个目录（原讨论或最后一次追问）的 usage.jsonl。 */
  function progressOf(number, run) {
    const qi = queue.findIndex((j) => j.number === number);
    if (qi >= 0) return { status: 'queued', queuedAhead: qi + (current ? 1 : 0), speaking: [] };
    if (!run) {
      if (failures.has(number)) return { status: 'failed', error: failures.get(number), speaking: [] };
      return { status: current?.number === number ? 'running' : 'queued', speaking: [] };
    }
    const rows = readJsonl(path.join(latestDir(run), 'usage.jsonl'));
    const startIdx = rows.findLastIndex((r) => r.type === 'run_started');
    const tail = startIdx >= 0 ? rows.slice(startIdx) : rows;
    const end = tail.find((r) => r.type === 'run_finished' || r.type === 'run_failed');
    if (end?.type === 'run_failed') return { status: 'failed', error: end.error, speaking: [] };
    if (end || startIdx < 0) return { status: current?.number === number ? 'running' : 'done', speaking: [] };
    const started = tail[0];
    if (current?.number !== number && !alive(started.pid)) return { status: 'failed', error: '跑这场讨论的进程已经退出，讨论没有正常结束', speaking: [] };
    const open = [];
    for (const r of tail) {
      if (r.type === 'call_started') open.push(r);
      if (r.type === 'call_finished' || r.type === 'call_failed') {
        const i = open.findIndex((s) => s.speaker === r.speaker && s.stage === r.stage && s.round === r.round);
        if (i >= 0) open.splice(i, 1);
      }
    }
    const who = speakerOf(run);
    return {
      status: 'running',
      speaking: open.map((s) => ({ name: who(s.speaker)?.name ?? s.speaker, stage: STAGE_LABELS[s.stage] ?? s.stage, round: s.round, at: s.at })),
    };
  }

  function summaryOf(run) {
    const { state, start } = run;
    const mode = modeOf(run);
    const subject = state?.subject ?? start?.subject;
    return {
      number: run.number,
      mode,
      channel: channelOf(run),
      topic: mode === 'refine' ? subject?.title ?? '' : (state?.topic ?? start?.topic ?? '').split('\n')[0].slice(0, 120),
      requirement: mode === 'refine' ? (state?.topic ?? start?.topic ?? '') : undefined,
      type: subject?.type,
      createdAt: state?.createdAt ?? start?.at ?? null,
      updatedAt: state?.updatedAt ?? null,
      status: progressOf(run.number, run).status,
      followUps: state?.followUps?.length ?? run.followDirs.length,
      hasRevision: Boolean(state?.revision),
      docVersion: state?.docs?.at(-1)?.version ?? null,
      applied: state?.applied ?? null,
      mock: Boolean(state?.mock ?? start?.mock),
    };
  }

  function listRuns() {
    const runs = scan();
    const rows = [...runs.values()].map(summaryOf);
    for (const [number, p] of pending) {
      if (runs.has(number)) {
        pending.delete(number);
        continue;
      }
      rows.push({ number, mode: p.mode, channel: 'web', topic: p.mode === 'refine' ? p.subject.title : p.topic.split('\n')[0].slice(0, 120), requirement: p.mode === 'refine' ? p.topic : undefined, type: p.subject?.type, status: progressOf(number, null).status, followUps: 0, hasRevision: false, applied: null, mock });
    }
    return rows.sort((a, b) => b.number - a.number);
  }

  function runDetail(number) {
    const run = findRun(number);
    const p = pending.get(number);
    if (!run && !p) throw httpError(404, `没有 #${number} 这场讨论`);
    if (!run) {
      return { number, mode: p.mode, channel: 'web', topic: p.topic, subject: p.subject ?? null, summary: null, docs: [], docFile: null, revision: null, revisions: [], followUps: [], applied: null, expired: false, mock, canFollowUp: false, progress: progressOf(number, null), posts: [] };
    }
    const { state, start } = run;
    const mode = modeOf(run);
    const subject = state?.subject ?? start?.subject ?? null;
    const progress = progressOf(number, run);
    const lastDiscuss = [...(state?.followUps ?? [])].reverse().find((f) => f.handling === 'discuss');
    return {
      number,
      mode,
      channel: channelOf(run),
      topic: state?.topic ?? start?.topic ?? '',
      subject: subject && subject.fields ? { type: subject.type, id: subject.id, title: subject.title, current: subject.current, background: subject.background, fields: subject.fields, version: subject.version } : subject,
      summary: state?.summary ?? null,
      conclusion: lastDiscuss?.answer ?? state?.summary ?? null,
      // 主文档的所有版本（最新的在最后）；旧讨论没有主文档时为空，页面退回显示汇总
      docs: state?.docs ?? [],
      docFile: state?.docs?.length ? path.join(run.dir, DOC_FILE) : null,
      revision: state?.revision ?? null,
      revisions: state?.revisions ?? [],
      followUps: (state?.followUps ?? []).map((f) => ({ question: f.question, handling: f.handling, answer: f.answer, doc: f.doc ?? null, at: f.at })),
      applied: state?.applied ?? null,
      expired: Boolean(state?.expired),
      docFailed: Boolean(state?.docFailed),
      mock: Boolean(state?.mock ?? start?.mock),
      dryRun: Boolean(state?.dryRun ?? start?.dryRun),
      code: state?.context ? { auto: Boolean(state.context.auto), repos: state.context.repos ?? [] } : null,
      canFollowUp: Boolean(state) && !state.expired && progress.status !== 'running' && progress.status !== 'queued',
      progress,
      posts: postsOf(run),
    };
  }

  // ---------- 网页自己跑的讨论 ----------

  async function pump() {
    if (current || !queue.length) return;
    current = queue.shift();
    const job = current;
    const common = { runsDir, echo, mock, interject: true };
    try {
      if (job.kind === 'refine') {
        await runner.runPrepared(job.cfg ?? cfgFor('refine'), { ...common, lark: false, topic: job.topic, number: job.number, subject: job.subject });
      } else if (job.kind === 'discuss') {
        await runner.runOne(job.cfg ?? cfgFor(job.mode, job.rounds), { ...common, lark: false, topic: job.topic, number: job.number, repos: job.repos });
      } else {
        // 群里的讨论在网页上追问：照样发到群里（dry-run 的讨论打印到终端）
        await runner.followUpOne(cfgFor(job.mode), { ...common, lark: job.lark, dryRun: job.dryRun, question: job.question, number: job.number });
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
  function jobConfig(mode, rounds, lineup) {
    try {
      return lineupConfig(cfg, { mode, ...(rounds !== undefined ? { rounds } : {}), lineup });
    } catch (err) {
      if (err instanceof ConfigError) throw httpError(400, err.message.replace(/^配置有误：\n- /, '阵容有误：').replace(/\n- /g, '；'));
      throw err;
    }
  }

  async function startRefine({ type, id, requirement = '', lineup }) {
    if (!SUBJECT_LABELS[type] || !id) throw httpError(400, '需要 type（idea / premise / outline）和 id');
    const jobCfg = jobConfig('refine', undefined, lineup);
    const item = await novel.get(type, id);
    const number = nextNumber(runsDir);
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
    pending.set(number, { mode: 'refine', topic, subject });
    enqueue({ kind: 'refine', number, subject, topic, cfg: jobCfg });
    log(`网页：#${number} 打磨${SUBJECT_LABELS[type]}「${item.title}」排队`);
    return { number };
  }

  /** 网页上发起方案讨论或脑洞风暴：只在网页上，不发到群里。 */
  function startDiscussion({ mode, topic, repos, rounds, lineup }) {
    if (mode !== 'decision' && mode !== 'brainstorm') throw httpError(400, 'mode 只能是 decision 或 brainstorm');
    const text = String(topic ?? '').trim();
    if (!text) throw httpError(400, `${mode === 'brainstorm' ? '题目' : '议题'}不能为空`);
    let r;
    if (rounds !== undefined && rounds !== null && rounds !== '' && rounds !== 'auto') {
      r = Number(rounds);
      if (!Number.isInteger(r) || r < 2 || r > 12) throw httpError(400, '轮数要是 2 到 12 的整数，或者自动');
    } else if (rounds === 'auto') r = 'auto';
    const jobCfg = jobConfig(mode, r, lineup);
    // 仓库：不写 = 方案讨论自动定位；「无」= 不读代码；否则是别名列表。先校验，写错了不排队
    let repoSpecs;
    const repoText = String(repos ?? '').trim();
    if (repoText) {
      try {
        const specs = parseRepoSpecs(repoText);
        if (specs.length) resolveRepos(cfgFor(mode), specs);
        repoSpecs = repoText;
      } catch (err) {
        throw httpError(400, err.message);
      }
    }
    const number = nextNumber(runsDir);
    pending.set(number, { mode, topic: text.slice(0, 8000) });
    enqueue({ kind: 'discuss', number, mode, topic: text.slice(0, 8000), repos: repoSpecs, rounds: r, cfg: jobCfg });
    log(`网页：#${number} ${MODE_LABELS[mode]}排队`);
    return { number };
  }

  function interject(number, text) {
    const t = String(text ?? '').trim();
    if (!t) throw httpError(400, '插话不能为空');
    const run = findRun(number);
    if (!run || progressOf(number, run).status !== 'running') throw httpError(409, '这场讨论没有在进行，插话不会被看到；讨论结束后可以追问');
    appendInbox(latestDir(run), { sender: modeOf(run) === 'refine' ? '作者' : '主持人', text: t.slice(0, 4000) });
    return { ok: true, lark: channelOf(run) === 'lark' };
  }

  function followUp(number, question) {
    const q = String(question ?? '').trim();
    if (!q) throw httpError(400, '追问不能为空');
    const run = findRun(number);
    if (!run?.state) throw httpError(404, `#${number} 还没结束或没有保存状态，不能追问`);
    if (run.state.expired) throw httpError(409, `#${number} 已超过保留期，会话已清理，请重新发起讨论`);
    if (busyWith(number) || progressOf(number, run).status === 'running') throw httpError(409, `#${number} 还在进行或排队中`);
    const channel = channelOf(run);
    enqueue({ kind: 'followup', number, mode: modeOf(run), question: q.slice(0, 4000), lark: channel !== 'web', dryRun: channel === 'dry-run' });
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
    saveState(run.dir, { ...state, applied, appliedHistory: [...(state.appliedHistory ?? []), applied] });
    log(`网页：#${number} 修订版已写回墨稿`);
    return { ok: true, applied };
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
      participants: { decision: people('decision'), brainstorm: people('brainstorm'), refine: people('refine') },
      // 自选阵容：可选的模型、角色模板、各模式的默认阵容
      models: modelPool(cfg).map((m) => ({ id: m.id, name: m.name, provider: m.provider, model: m.model ?? null, color: m.color ?? 'grey' })),
      roleTemplates: roleTemplates(cfg),
      lineups: { decision: defaultLineup(cfg, 'decision'), brainstorm: defaultLineup(cfg, 'brainstorm'), refine: defaultLineup(cfg, 'refine') },
      maxSeats: MAX_SEATS,
    };
  }

  // ---------- 路由 ----------

  async function route(req, res, url) {
    const m = /^\/api\/runs\/(\d+)(?:\/(events|interject|followup|apply))?$/.exec(url.pathname);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(PAGE));
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, status());
    if (req.method === 'GET' && url.pathname === '/api/novel/items') return json(res, { items: await novel.list() });
    if (req.method === 'GET' && url.pathname === '/api/novel/item') return json(res, await novel.get(url.searchParams.get('type'), url.searchParams.get('id')));
    if (req.method === 'GET' && url.pathname === '/api/runs') return json(res, { runs: listRuns() });
    if (req.method === 'POST' && url.pathname === '/api/runs') {
      const b = await body(req);
      return json(res, b.type ? await startRefine(b) : startDiscussion(b), 201);
    }
    if (!m) throw httpError(404, '没有这个地址');
    const number = Number(m[1]);
    if (req.method === 'GET' && !m[2]) return json(res, runDetail(number));
    if (req.method === 'GET' && m[2] === 'events') return sse(req, res, number);
    if (req.method === 'POST' && m[2] === 'interject') return json(res, interject(number, (await body(req)).text));
    if (req.method === 'POST' && m[2] === 'followup') return json(res, followUp(number, (await body(req)).question), 202);
    if (req.method === 'POST' && m[2] === 'apply') return json(res, await apply(number, (await body(req)).revisionAt));
    throw httpError(405, '不支持的请求');
  }

  /** 每秒看一次文件：有新发言就推 post，进度变了就推 progress。 */
  function sse(req, res, number) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    let sent = Number(new URL(req.url, 'http://x').searchParams.get('after') ?? 0);
    let lastProgress = '';
    const tick = () => {
      try {
        const run = findRun(number);
        if (run) {
          for (const p of postsOf(run)) {
            if (p.seq > sent) {
              res.write(`event: post\ndata: ${JSON.stringify(p)}\n\n`);
              sent = p.seq;
            }
          }
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
