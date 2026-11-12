import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { normalizeConfig } from '../src/config.js';
import { createWebApp, startWebServer } from '../src/web/server.js';
import { createStoreInbox, combineInterjections, appendInbox } from '../src/inbox.js';
import { openStore } from '../src/db.js';
import { migrateRuns } from '../src/migrate.js';

const cfg = normalizeConfig({
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead' },
    { id: 'b', name: 'B', provider: 'fake', part: 'lead' },
    { id: 'r1', name: 'R1', provider: 'fake', part: 'reviewer' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake', color: 'purple' },
  providers: { fake: { type: 'mock' } },
  rounds: 2,
});

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { 'content-type': 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function serve(t, opts) {
  const store = openStore(':memory:');
  const app = createWebApp({ cfg, novel: { baseUrl: 'fake' }, store, log: () => {}, echo: false, ...opts });
  const server = await startWebServer(app, { host: '127.0.0.1', port: 0, log: () => {} });
  t.after(() => server.close());
  return { app, store, port: server.address().port };
}

const waitIdle = async (app) => { for (let i = 0; i < 300 && !app.idle(); i += 1) await new Promise((r) => setTimeout(r, 10)); };

/** 模拟群监听跑过的一场讨论：讨论本身 + 一次追问。返回讨论本身那次运行的 id。 */
function fakeLarkRun(store, { number = 3, running = false } = {}) {
  store.db.prepare('INSERT INTO discussions (number, mode, topic, channel, created_at) VALUES (?, ?, ?, ?, ?)').run(number, 'decision', '拆库\n背景……', 'lark', '2026-11-11T02:00:00Z');
  const exec = store.startExecution({ number, kind: 'discussion', topic: '拆库', startedAt: '2026-11-11T02:00:00Z' });
  store.addEvent(exec, { at: '2026-11-11T02:00:00Z', type: 'run_started', number, topic: '拆库\n背景……', mode: 'decision', pid: running ? process.pid : 999999, dryRun: false, mock: false });
  store.addEvent(exec, { type: 'call_started', speaker: 'a', stage: 'propose', round: 1, at: '2026-11-11T02:00:01Z' });
  store.addPost(exec, { speaker: { id: 'chair' }, title: '方案讨论开始', body: '议题' }, '2026-11-11T02:00:00Z');
  if (!running) {
    store.addEvent(exec, { type: 'run_finished' });
    store.saveState({ version: 1, number, topic: '拆库\n背景……', mode: 'decision', summary: '**共识**', followUps: [{ question: '换分库', handling: 'answer', answer: '不用' }], sessions: {}, dryRun: false, channel: 'lark' });
    const f = store.startExecution({ number, kind: 'followup', topic: '换分库', startedAt: '2026-11-11T03:00:00Z' });
    store.addEvent(f, { type: 'run_started', pid: 999999 });
    store.addEvent(f, { type: 'run_finished' });
    store.addPost(f, { speaker: { id: 'a' }, title: 'A', body: '回应追问（分库）' }, '2026-11-11T03:00:00Z');
  }
  return exec;
}

test('插话箱：只读新增的；只读这次运行的；合并来源时一个失败不影响另一个', async () => {
  const store = openStore(':memory:');
  const exec = store.startExecution({ kind: 'discussion' });
  const other = store.startExecution({ kind: 'discussion' });
  const inbox = createStoreInbox(store, exec);
  assert.deepEqual(await inbox.poll(), []);
  appendInbox(store, exec, { sender: '主持人', text: '先别考虑成本' });
  appendInbox(store, other, { sender: '主持人', text: '别的讨论' });
  const got = await inbox.poll();
  assert.deepEqual(got.map((m) => [m.sender, m.text, m.source]), [['主持人', '先别考虑成本', 'web']]);
  assert.match(got[0].time, /^\d\d:\d\d$/);
  assert.deepEqual(await inbox.poll(), []);
  appendInbox(store, exec, { sender: '主持人', text: '第二条' });
  const broken = { poll: async () => { throw new Error('限流'); } };
  const both = combineInterjections([broken, inbox]);
  assert.equal((await both.poll())[0].text, '第二条');
  await assert.rejects(both.poll(), /限流/); // 都没拿到时把错误抛出去记日志
});

test('网页：列出群里的讨论，发言含追问，结论来自讨论状态', async (t) => {
  const { port, store } = await serve(t);
  fakeLarkRun(store);
  const list = await request(port, 'GET', '/api/runs');
  assert.equal(list.body.runs[0].number, 3);
  assert.equal(list.body.runs[0].channel, 'lark');
  assert.equal(list.body.runs[0].status, 'done');
  assert.equal(list.body.runs[0].followUps, 1);
  assert.equal(list.body.runs[0].topic, '拆库');
  const detail = await request(port, 'GET', '/api/runs/3');
  assert.deepEqual(detail.body.posts.map((p) => [p.part, p.body]), [[0, '议题'], [1, '回应追问（分库）']]);
  assert.equal(detail.body.posts[0].speaker.color, 'purple');
  assert.equal(detail.body.conclusion, '**共识**');
  assert.equal(detail.body.canFollowUp, true);
});

test('网页：进行中的群讨论可以插话（写进这次运行的插话），没在进行的不行', async (t) => {
  const { port, store } = await serve(t);
  const exec = fakeLarkRun(store, { running: true });
  const detail = await request(port, 'GET', '/api/runs/3');
  assert.equal(detail.body.progress.status, 'running');
  assert.equal(detail.body.progress.speaking[0].name, 'A');
  const ok = await request(port, 'POST', '/api/runs/3/interject', { text: '只考虑 MySQL' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.lark, true);
  assert.deepEqual(store.interjections(exec).map((m) => [m.sender, m.text]), [['主持人', '只考虑 MySQL']]);

  fakeLarkRun(store, { number: 4 });
  assert.equal((await request(port, 'POST', '/api/runs/4/interject', { text: 'x' })).status, 409);
});

test('网页：进程已经退出、没写结束的讨论显示失败；排队时进程退出、一直没开始的也显示失败', async (t) => {
  const { port, store } = await serve(t);
  const exec = fakeLarkRun(store, { running: true });
  store.db.prepare('UPDATE executions SET pid = 999999 WHERE id = ?').run(exec);
  const detail = await request(port, 'GET', '/api/runs/3');
  assert.equal(detail.body.progress.status, 'failed');
  const n = store.reserveNumber({ mode: 'decision', topic: '没开始' });
  const never = await request(port, 'GET', `/api/runs/${n}`);
  assert.equal(never.body.progress.status, 'failed');
  assert.match(never.body.progress.error, /没有开始/);
});

test('网页：群里的讨论在网页上追问，追问照样发到群里', async (t) => {
  const calls = [];
  const runner = { followUpOne: async (c, opts) => { calls.push({ mode: c.mode, ...opts }); } };
  const { port, store, app } = await serve(t, { runner });
  fakeLarkRun(store);
  const res = await request(port, 'POST', '/api/runs/3/followup', { question: '换成按商家分库呢？' });
  assert.equal(res.status, 202);
  assert.equal(res.body.lark, true);
  await waitIdle(app);
  assert.equal(calls[0].lark, true);
  assert.equal(calls[0].number, 3);
  assert.equal(calls[0].question, '换成按商家分库呢？');
});

test('网页：发起方案讨论只在网页上跑；仓库别名写错直接报错', async (t) => {
  const { port, app, store } = await serve(t);
  const bad = await request(port, 'POST', '/api/runs', { mode: 'decision', topic: '拆库', repos: '不存在的仓库' });
  assert.equal(bad.status, 400);
  const started = await request(port, 'POST', '/api/runs', { mode: 'decision', topic: '拆库要不要做', repos: '无', rounds: 2 });
  assert.equal(started.status, 201);
  const { number } = started.body;
  await waitIdle(app);
  const detail = await request(port, 'GET', `/api/runs/${number}`);
  assert.equal(detail.body.mode, 'decision');
  assert.equal(detail.body.channel, 'web');
  assert.equal(detail.body.progress.status, 'done');
  assert.ok(detail.body.posts.length >= 4);
  // 讨论结论在主文档里：有版本，讨论流里有一条主文档消息；全部记在库里
  assert.equal(detail.body.docs.length, 1);
  assert.match(detail.body.docs[0].text, /# mock 主文档/);
  assert.ok(detail.body.posts.some((p) => p.stage === 'doc'));
  const [exec] = store.executionsOf(number);
  assert.equal(exec.status, 'done');
  assert.equal(exec.result.number, number);
  assert.ok(store.events(exec.id).some((e) => e.type === 'call_finished'));
  const list = await request(port, 'GET', '/api/runs');
  assert.equal(list.body.runs.find((r) => r.number === number).docVersion, 1);

  const brainstorm = await request(port, 'POST', '/api/runs', { mode: 'brainstorm', topic: '给独居老人的音箱想功能' });
  assert.equal(brainstorm.status, 201);
  await waitIdle(app);
  const b = await request(port, 'GET', `/api/runs/${brainstorm.body.number}`);
  assert.equal(b.body.mode, 'brainstorm');
  assert.equal(b.body.progress.status, 'done');
});

test('网页插话：交给模型的同时，由主席发一张卡片（群里能看到）', async () => {
  const { runDiscussion } = await import('../src/orchestrator.js');
  const { createMemoryPublisher } = await import('../src/publishers.js');
  const { createProviderRegistry } = await import('../src/providers/index.js');
  let sent = false;
  const interjections = { poll: async () => (sent ? [] : ((sent = true), [{ sender: '主持人', text: '只考虑 MySQL', source: 'web' }])) };
  const publisher = createMemoryPublisher();
  await runDiscussion({ cfg, topic: '拆库', providers: createProviderRegistry(cfg), publisher, interjections });
  const card = publisher.posts.find((p) => p.meta?.stage === 'interjection');
  assert.equal(card.speaker.id, 'chair');
  assert.equal(card.body, '只考虑 MySQL');
});

test('网页：按议题、发言内容、编号搜索，按模式和时间筛选；归档后默认不显示；删除连同全部记录', async (t) => {
  const { port, store } = await serve(t);
  fakeLarkRun(store, { number: 3 });
  store.db.prepare('INSERT INTO discussions (number, mode, topic, channel, created_at) VALUES (?, ?, ?, ?, ?)').run(4, 'brainstorm', '音箱功能', 'web', '2020-01-01T00:00:00Z');
  store.startExecution({ number: 4, kind: 'discussion' });
  const nums = async (query) => (await request(port, 'GET', `/api/runs${query}`)).body.runs.map((r) => r.number);
  assert.deepEqual(await nums(''), [4, 3]);
  assert.deepEqual(await nums(`?q=${encodeURIComponent('分库')}`), [3]); // 只出现在追问的发言里
  assert.deepEqual(await nums(`?q=${encodeURIComponent('音箱')}`), [4]);
  assert.deepEqual(await nums('?q=%234'), [4]);
  assert.deepEqual(await nums('?q=100%25'), []);
  assert.deepEqual(await nums('?mode=brainstorm'), [4]);
  assert.ok(!(await nums('?days=30')).includes(4), '2020 年的不在最近 30 天里');

  const arch = await request(port, 'POST', '/api/runs/3/archive', { archived: true });
  assert.equal(arch.body.archived, true);
  assert.deepEqual(await nums(''), [4]);
  assert.deepEqual(await nums('?archived=1'), [3]);
  assert.equal((await request(port, 'GET', '/api/runs/3')).body.archived, true);
  await request(port, 'POST', '/api/runs/3/archive', { archived: false });
  assert.deepEqual(await nums(''), [4, 3]);

  assert.equal((await request(port, 'POST', '/api/runs/3/delete', {})).status, 200);
  assert.equal((await request(port, 'GET', '/api/runs/3')).status, 404);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM executions WHERE number = 3').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 0);
  assert.equal((await request(port, 'POST', '/api/runs/9/delete', {})).status, 404);
  // 进行中的不能删
  fakeLarkRun(store, { number: 5, running: true });
  assert.equal((await request(port, 'POST', '/api/runs/5/delete', {})).status, 409);
});

test('迁移：旧 runs/ 目录导进记录库，讨论、追问、发言、用量、插话、工具调用都在；重复执行不重复导入', () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-storm-migrate-'));
  const w = (rel, rows) => {
    fs.mkdirSync(path.dirname(path.join(runs, rel)), { recursive: true });
    fs.writeFileSync(path.join(runs, rel), Array.isArray(rows) ? rows.map((r) => `${JSON.stringify(r)}\n`).join('') : JSON.stringify(rows));
  };
  const main = '20261111-100000-#3-拆库';
  w(`${main}/usage.jsonl`, [{ at: '2026-11-11T02:00:00Z', type: 'run_started', number: 3, topic: '拆库', mode: 'decision', pid: 1, channel: 'lark' }, { at: '2026-11-11T02:30:00Z', type: 'run_finished' }]);
  w(`${main}/events.jsonl`, [{ at: '2026-11-11T02:00:00Z', speaker: 'chair', title: '开始', body: '议题', meta: { stage: 'open' } }]);
  w(`${main}/state.json`, { version: 1, number: 3, topic: '拆库', mode: 'decision', docs: [{ version: 1, text: '# 结论' }], channel: 'lark' });
  w(`${main}/result.json`, { number: 3, topic: '拆库' });
  w(`${main}/inbox.jsonl`, [{ at: '2026-11-11T02:10:00Z', sender: '主持人', text: '只考虑 MySQL' }]);
  w(`${main}/tool-calls.jsonl`, [{ time: '2026-11-11T02:05:00Z', source: 'command', tool: 'query-db', exitCode: 0, durationMs: 30 }]);
  w('20261111-110000-追问#3-换分库/usage.jsonl', [{ at: '2026-11-11T03:00:00Z', type: 'run_started', pid: 2 }]);
  w('20261111-110000-追问#3-换分库/events.jsonl', [{ at: '2026-11-11T03:00:00Z', speaker: 'a', title: 'A', body: '回应' }]);
  w('20261111-120000-mock演练/events.jsonl', [{ at: '2026-11-11T04:00:00Z', speaker: 'a', title: 'A', body: 'mock' }]);
  w('.tools/2026-11-11T05-00-00-000Z.jsonl', [{ time: '2026-11-11T05:00:00Z', tool: 'time-convert', exitCode: 0 }]);

  w('20261111-130000-#4-进行中/usage.jsonl', [{ at: '2026-11-11T05:00:00Z', type: 'run_started', number: 4, pid: process.pid }]);
  const store = openStore(':memory:');
  const out = migrateRuns(store, runs);
  assert.deepEqual(out.running, ['20261111-130000-#4-进行中']); // 进程还活着、没结束的先不导
  assert.deepEqual([out.discussions, out.executions, out.posts, out.events, out.interjections, out.toolCalls, out.problems.length], [1, 4, 3, 3, 1, 2, 0]);
  const d = store.discussion(3);
  assert.equal(d.state.docs[0].text, '# 结论');
  const [disc, follow] = store.executionsOf(3);
  assert.deepEqual([disc.kind, disc.status, disc.pid, disc.result.topic], ['discussion', 'done', 1, '拆库']);
  assert.deepEqual([follow.kind, follow.status], ['followup', 'failed']); // 没有结束记录
  assert.equal(store.interjections(disc.id)[0].text, '只考虑 MySQL');
  assert.equal(store.toolCalls(disc.id)[0].tool, 'query-db');
  assert.equal(store.executions().find((e) => e.kind === 'tools-try').legacy_dir, '.tools/2026-11-11T05-00-00-000Z.jsonl');
  assert.equal(store.executions().filter((e) => e.number === null).length, 2); // mock 演练和 tools try 不编号
  assert.ok(!store.discussion(4));
  const again = migrateRuns(store, runs);
  assert.deepEqual([again.executions, again.skipped, again.synced], [0, 4, 0]);
  // 导过之后旧版程序又追问了一次：state.json 更新了，再执行时同步状态、导入新的追问目录
  w(`${main}/state.json`, { version: 1, number: 3, topic: '拆库', mode: 'decision', docs: [{ version: 1, text: '# 结论' }, { version: 2, text: '# 第 2 版' }], updatedAt: '2026-11-12T00:00:00Z' });
  w('20261112-100000-追问#3-再问/usage.jsonl', [{ at: '2026-11-12T00:00:00Z', type: 'run_started', pid: 3 }, { type: 'run_finished', at: '2026-11-12T00:01:00Z' }]);
  const third = migrateRuns(store, runs);
  assert.deepEqual([third.executions, third.synced], [1, 1]);
  assert.equal(store.discussion(3).state.docs.length, 2);
  assert.equal(store.executionsOf(3).length, 3);
  fs.rmSync(runs, { recursive: true, force: true });
});
