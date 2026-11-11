import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../config.js';
import { listStates, nextNumber, saveState } from '../state.js';
import { STAGE_LABELS, SUBJECT_LABELS } from '../modes.js';
import { RUNS, runPrepared, followUpOne, log as defaultLog } from '../runner.js';
import { createNovelClient } from '../novel.js';

/**
 * 本地网页：从墨稿列出脑洞 / 梗概 / 总纲，挑一项发起多模型打磨，实时看讨论、插话、追问，
 * 对比修订版，确认后写回墨稿。只监听本机地址，没有登录。
 *
 * 讨论一场一场排队执行。每场讨论的全部发言（包括之后的追问）写在 runs/<讨论>/thread.jsonl，
 * 页面打开时先读这个文件，再用 SSE 接着收新的发言。
 */

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page.html');
const THREAD = 'thread.jsonl';
const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export function createWebApp({ cfg, novel = createNovelClient(cfg.novel), mock = false, runsDir = RUNS, log = defaultLog, echo = true, runner = { runPrepared, followUpOne } } = {}) {
  const refineCfg = () => normalizeConfig(cfg, { mode: 'refine' });
  const live = new Map(); // 编号 -> { status, posts, clients, inbox, subject, topic, threadFile, error, speaking }
  const queue = [];
  let current = null;

  const stateOf = (number) => listStates(runsDir).find((s) => s.state.number === number) ?? null;

  function entryFor(number) {
    if (!live.has(number)) live.set(number, { number, status: 'idle', clients: new Set(), inbox: [], speaking: [] });
    return live.get(number);
  }

  function broadcast(entry, event, data) {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of entry.clients) res.write(line);
  }

  function readThread(file) {
    if (!file || !fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  }

  /** 网页发布者：发言写进 thread.jsonl，并推给正在看这场讨论的页面。 */
  function webPublisher(number) {
    const entry = entryFor(number);
    return {
      name: 'web',
      async post(msg) {
        if (!entry.threadFile) return;
        const post = {
          seq: readThread(entry.threadFile).length + 1,
          at: new Date().toISOString(),
          speaker: { id: msg.speaker.id, name: msg.speaker.name, color: msg.speaker.color },
          title: msg.title,
          subtitle: msg.subtitle ?? '',
          brief: msg.brief ?? null,
          body: msg.body,
          plan: msg.plan ?? null,
          footer: msg.footer ?? '',
          stage: msg.meta?.stage ?? null,
          error: msg.meta?.error ?? null,
        };
        fs.appendFileSync(entry.threadFile, `${JSON.stringify(post)}\n`);
        broadcast(entry, 'post', post);
      },
    };
  }

  /** 页面上的插话：下一轮开始时交给所有模型。 */
  function webInterjections(number) {
    const entry = entryFor(number);
    return {
      async poll() {
        return entry.inbox.splice(0);
      },
    };
  }

  function onEventFor(number) {
    const entry = entryFor(number);
    return (e) => {
      if (e.type === 'call_started') entry.speaking.push({ speaker: e.speaker, stage: e.stage, round: e.round, at: e.at });
      if (e.type === 'call_finished' || e.type === 'call_failed') {
        const i = entry.speaking.findIndex((s) => s.speaker === e.speaker && s.stage === e.stage);
        if (i >= 0) entry.speaking.splice(i, 1);
      }
      if (e.type.startsWith('call_')) broadcast(entry, 'progress', progressOf(entry));
    };
  }

  const speakerName = (id) => [...cfg.participants, cfg.chair].find((s) => s.id === id)?.name ?? id;
  const progressOf = (entry) => ({
    status: entry.status,
    error: entry.error ?? null,
    speaking: entry.speaking.map((s) => ({ name: speakerName(s.speaker), stage: STAGE_LABELS[s.stage] ?? s.stage, round: s.round, at: s.at })),
    // 前面还有几场（包括正在进行的那场）
    queuedAhead: entry.status === 'queued' ? queue.findIndex((j) => j.number === entry.number) + (current ? 1 : 0) : 0,
  });

  function setStatus(number, status, error) {
    const entry = entryFor(number);
    entry.status = status;
    entry.error = error ?? null;
    if (status !== 'running') entry.speaking = [];
    broadcast(entry, 'progress', progressOf(entry));
  }

  async function pump() {
    if (current || !queue.length) return;
    current = queue.shift();
    const job = current;
    const entry = entryFor(job.number);
    setStatus(job.number, 'running');
    const common = {
      runsDir,
      echo,
      mock,
      lark: false,
      interject: true,
      extraPublishers: [webPublisher(job.number)],
      interjections: webInterjections(job.number),
      onEvent: onEventFor(job.number),
    };
    try {
      if (job.kind === 'refine') {
        await runner.runPrepared(refineCfg(), {
          ...common,
          topic: job.topic,
          number: job.number,
          subject: job.subject,
          onRunDir: (dir) => { entry.threadFile = path.join(dir, THREAD); },
        });
      } else {
        await runner.followUpOne(refineCfg(), {
          ...common,
          question: job.question,
          number: job.number,
          onRunDir: (_dir, _n, origDir) => { entry.threadFile = path.join(origDir, THREAD); },
        });
      }
      setStatus(job.number, 'done');
    } catch (err) {
      log(`⚠️ #${job.number} 失败：${err.message}`);
      await webPublisher(job.number).post({ speaker: cfg.chair, title: '讨论中断', subtitle: '出错了', body: err.message, meta: { error: err.message } }).catch(() => {});
      setStatus(job.number, 'failed', err.message);
    } finally {
      current = null;
      for (const e of live.values()) if (e.status === 'queued') broadcast(e, 'progress', progressOf(e));
      setImmediate(pump);
    }
  }

  function enqueue(job) {
    queue.push(job);
    setStatus(job.number, 'queued');
    setImmediate(pump);
  }

  const busyWith = (number) => current?.number === number || queue.some((j) => j.number === number);

  // ---------- 路由 ----------

  async function startRefine({ type, id, requirement = '' }) {
    if (!SUBJECT_LABELS[type] || !id) throw httpError(400, '需要 type（idea / premise / outline）和 id');
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
    const entry = entryFor(number);
    Object.assign(entry, { subject, topic: String(requirement).slice(0, 4000) });
    enqueue({ kind: 'refine', number, subject, topic: entry.topic });
    log(`网页：#${number} 打磨${SUBJECT_LABELS[type]}「${item.title}」排队`);
    return { number };
  }

  function runSummary({ state }) {
    const entry = live.get(state.number);
    return {
      number: state.number,
      type: state.subject?.type,
      title: state.subject?.title,
      requirement: state.topic,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      status: entry && entry.status !== 'idle' ? entry.status : 'done',
      hasRevision: Boolean(state.revision),
      applied: state.applied ?? null,
      followUps: state.followUps?.length ?? 0,
      mock: Boolean(state.mock),
    };
  }

  function listRuns() {
    const saved = listStates(runsDir).filter((s) => s.state.mode === 'refine').map(runSummary);
    const savedNumbers = new Set(saved.map((r) => r.number));
    const pending = [...live].filter(([n, e]) => !savedNumbers.has(n) && e.subject).map(([n, e]) => ({
      number: n, type: e.subject.type, title: e.subject.title, requirement: e.topic, status: e.status, hasRevision: false, applied: null, followUps: 0, mock,
    }));
    return [...pending, ...saved].sort((a, b) => b.number - a.number);
  }

  function runDetail(number) {
    const found = stateOf(number);
    const entry = live.get(number);
    if (!found && !entry?.subject) throw httpError(404, `没有 #${number} 这场打磨`);
    const state = found?.state;
    if (state && state.mode !== 'refine') throw httpError(404, `#${number} 不是打磨讨论`);
    const threadFile = found ? path.join(found.dir, THREAD) : entry.threadFile;
    if (entry && found) entry.threadFile ??= threadFile;
    const subject = state?.subject ?? entry.subject;
    return {
      number,
      subject: { type: subject.type, id: subject.id, title: subject.title, current: subject.current, background: subject.background, fields: subject.fields, version: subject.version },
      requirement: state?.topic ?? entry.topic,
      summary: state?.summary ?? null,
      revision: state?.revision ?? null,
      revisions: state?.revisions ?? [],
      followUps: (state?.followUps ?? []).map((f) => ({ question: f.question, handling: f.handling, at: f.at })),
      applied: state?.applied ?? null,
      expired: Boolean(state?.expired),
      mock: Boolean(state?.mock ?? mock),
      progress: entry ? progressOf(entry) : { status: 'done', speaking: [] },
      posts: readThread(threadFile),
    };
  }

  function interject(number, text) {
    const entry = live.get(number);
    if (!entry || entry.status !== 'running') throw httpError(409, '这场讨论没有在进行，插话不会被看到；讨论结束后可以追问');
    const t = String(text ?? '').trim();
    if (!t) throw httpError(400, '插话不能为空');
    entry.inbox.push({ sender: '作者', text: t.slice(0, 4000), time: new Date().toTimeString().slice(0, 5) });
    return { ok: true, pending: entry.inbox.length };
  }

  function followUp(number, question) {
    const q = String(question ?? '').trim();
    if (!q) throw httpError(400, '追问不能为空');
    const found = stateOf(number);
    if (!found || found.state.mode !== 'refine') throw httpError(404, `没有 #${number} 这场打磨，或者它还没结束`);
    if (found.state.expired) throw httpError(409, `#${number} 已超过保留期，会话已清理，请重新发起打磨`);
    if (busyWith(number)) throw httpError(409, `#${number} 还在进行或排队中`);
    const entry = entryFor(number);
    entry.threadFile = path.join(found.dir, THREAD);
    enqueue({ kind: 'followup', number, question: q.slice(0, 4000) });
    return { ok: true };
  }

  async function apply(number, revisionAt) {
    const found = stateOf(number);
    if (!found?.state.revision) throw httpError(404, `#${number} 还没有修订版`);
    if (busyWith(number)) throw httpError(409, `#${number} 还在进行，等它结束再写回`);
    const { state, dir } = found;
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
    saveState(dir, { ...state, applied, appliedHistory: [...(state.appliedHistory ?? []), applied] });
    log(`网页：#${number} 修订版已写回墨稿`);
    return { ok: true, applied };
  }

  async function route(req, res, url) {
    const m = /^\/api\/runs\/(\d+)(?:\/(events|interject|followup|apply))?$/.exec(url.pathname);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(PAGE));
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json(res, {
        mock,
        novel: novel.baseUrl,
        current: current ? { number: current.number, kind: current.kind } : null,
        queued: queue.map((j) => ({ number: j.number, kind: j.kind })),
        participants: refineCfg().participants.map((p) => ({ id: p.id, name: p.name, role: p.role, part: p.part ?? 'lead', color: p.color })),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/novel/items') return json(res, { items: await novel.list() });
    if (req.method === 'GET' && url.pathname === '/api/novel/item') return json(res, await novel.get(url.searchParams.get('type'), url.searchParams.get('id')));
    if (req.method === 'GET' && url.pathname === '/api/runs') return json(res, { runs: listRuns() });
    if (req.method === 'POST' && url.pathname === '/api/runs') return json(res, await startRefine(await body(req)), 201);
    if (!m) throw httpError(404, '没有这个地址');
    const number = Number(m[1]);
    if (req.method === 'GET' && !m[2]) return json(res, runDetail(number));
    if (req.method === 'GET' && m[2] === 'events') return sse(req, res, number);
    if (req.method === 'POST' && m[2] === 'interject') return json(res, interject(number, (await body(req)).text));
    if (req.method === 'POST' && m[2] === 'followup') return json(res, followUp(number, (await body(req)).question), 202);
    if (req.method === 'POST' && m[2] === 'apply') return json(res, await apply(number, (await body(req)).revisionAt));
    throw httpError(405, '不支持的请求');
  }

  function sse(req, res, number) {
    const entry = entryFor(number);
    if (!entry.threadFile) {
      const found = stateOf(number);
      if (found) entry.threadFile = path.join(found.dir, THREAD);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    entry.clients.add(res);
    // 打开页面到连上 SSE 之间的发言：按 seq 补发
    const after = Number(new URL(req.url, 'http://x').searchParams.get('after') ?? 0);
    for (const p of readThread(entry.threadFile)) if (p.seq > after) res.write(`event: post\ndata: ${JSON.stringify(p)}\n\n`);
    res.write(`event: progress\ndata: ${JSON.stringify(progressOf(entry))}\n\n`);
    const beat = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(beat);
      entry.clients.delete(res);
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
      const status = err.status ?? 500;
      if (status >= 500 && !(err.status)) log(`⚠️ 网页出错：${err.stack ?? err.message}`);
      if (!res.headersSent) json(res, { error: err.message }, status);
      else res.end();
    }
  }

  return { handle, live, queue, idle: () => !current && !queue.length };
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
      log(`打磨页面：http://${host === '::1' ? '[::1]' : host}:${port}/`);
      resolve(server);
    });
  });
}
