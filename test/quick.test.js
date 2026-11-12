import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { normalizeConfig } from '../src/config.js';
import { createWebApp, startWebServer } from '../src/web/server.js';
import { openStore } from '../src/db.js';
import { tierLineup } from '../src/lineup.js';
import { MATERIAL_MAX } from '../src/modes.js';

const cfg = normalizeConfig({
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead', role: '架构' },
    { id: 'b', name: 'B', provider: 'fake', part: 'lead', role: '落地' },
    { id: 'r1', name: 'R1', provider: 'fake', part: 'reviewer', role: '质疑' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake' },
  providers: { fake: { type: 'mock' } },
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

async function serve(t) {
  const store = openStore(':memory:');
  const app = createWebApp({ cfg, novel: { baseUrl: 'fake' }, store, log: () => {}, echo: false });
  const server = await startWebServer(app, { host: '127.0.0.1', port: 0, log: () => {} });
  t.after(() => server.close());
  return { app, store, port: server.address().port };
}
const waitIdle = async (app) => { for (let i = 0; i < 300 && !app.idle(); i += 1) await new Promise((r) => setTimeout(r, 10)); };
const calls = (store, number) => store.executionsOf(number).map((e) => store.events(e.id).filter((x) => x.type === 'call_finished').map((x) => `${x.speaker}:${x.stage}`));

test('默认阵容：快问是第一位主笔回答、第一位评审挑刺；小会是两位主笔、一位评审', () => {
  const q = tierLineup(cfg, 'quick');
  assert.deepEqual(q.participants.map((p) => [p.model, p.part]), [['a', 'lead'], ['r1', 'reviewer']]);
  const m = tierLineup(cfg, 'meeting');
  assert.deepEqual(m.participants.map((p) => [p.model, p.part]), [['a', 'lead'], ['b', 'lead'], ['r1', 'reviewer']]);
});

test('快问：回答 → 挑刺 → 定稿共 3 次调用，存成快问文档和讨论状态，结论页能切段', async (t) => {
  const { app, store, port } = await serve(t);
  const res = await request(port, 'POST', '/api/runs', { mode: 'quick', topic: '周末去杭州还是苏州？', material: '预算 2000 元，两个人' });
  assert.equal(res.status, 201);
  await waitIdle(app);
  const { number } = res.body;
  const d = (await request(port, 'GET', `/api/runs/${number}`)).body;
  assert.equal(d.mode, 'quick');
  assert.equal(d.progress.status, 'done');
  assert.equal(d.material, '预算 2000 元，两个人');
  assert.deepEqual(calls(store, number), [['a:quickanswer', 'r1:challenge', 'a:doc']]);
  assert.deepEqual(d.posts.map((p) => [p.stage, p.groupKey]), [[null, null], ['quickanswer', '0:r1'], ['challenge', '0:r1'], ['doc', '0:end'], [null, null]]);
  assert.equal(d.docs.length, 1);
  const s = d.docSections[0];
  assert.equal(s.failed, false);
  assert.deepEqual(s.order, ['answer', 'blind', 'need', 'next', 'memo']);
  assert.equal(d.outcome.ending, 'answered');
  assert.equal(d.blockers, null); // 快问没有评审发言，不出阻断区块
  assert.equal(d.canFollowUp, true);
  // 材料进了共用的系统提示词，参与者都能看到
  const state = store.discussion(number).state;
  assert.match(state.shared, /提问人提供的材料[\s\S]*预算 2000 元/);
  assert.equal(state.ending.reason, 'answered');
});

test('快问的追问：不经过主席分流，回答的一方按快问文档直接回答，再更新文档', async (t) => {
  const { app, store, port } = await serve(t);
  const { number } = (await request(port, 'POST', '/api/runs', { mode: 'quick', topic: '要不要换工作？' })).body;
  await waitIdle(app);
  const r = await request(port, 'POST', `/api/runs/${number}/followup`, { question: '补充：现在的工作稳定但涨薪慢' });
  assert.equal(r.status, 202);
  await waitIdle(app);
  const d = (await request(port, 'GET', `/api/runs/${number}`)).body;
  assert.deepEqual(calls(store, number)[1], ['a:answer', 'a:doc']);
  assert.ok(!d.posts.some((p) => p.stage === 'triage'));
  assert.equal(d.followUps[0].handling, 'answer');
  assert.deepEqual(d.docs.map((x) => x.version), [1, 2]);
  assert.equal(d.docSections[0].version, 2);
  assert.equal(d.outcome.handling, 'answer');
});

test('快问校验：两人一轮能过；人数或分工不对、材料超长都直接 400；快问不读代码，数据工具不放开', async (t) => {
  const { app, port, store } = await serve(t);
  const seat = (model, part) => ({ model, part, role: '角色' });
  const ok = await request(port, 'POST', '/api/runs', { mode: 'quick', topic: 'x', lineup: { participants: [seat('b', 'lead'), seat('a', 'reviewer')] }, data: { tools: true } });
  assert.equal(ok.status, 201);
  await waitIdle(app);
  assert.deepEqual(calls(store, ok.body.number), [['b:quickanswer', 'a:challenge', 'b:doc']]);
  const three = await request(port, 'POST', '/api/runs', { mode: 'quick', topic: 'x', lineup: { participants: [seat('a', 'lead'), seat('b', 'lead'), seat('r1', 'reviewer')] } });
  assert.equal(three.status, 400);
  assert.match(three.body.error, /快问要两位/);
  const twoLeads = await request(port, 'POST', '/api/runs', { mode: 'quick', topic: 'x', lineup: { participants: [seat('a', 'lead'), seat('b', 'lead')] } });
  assert.equal(twoLeads.status, 400);
  const long = await request(port, 'POST', '/api/runs', { mode: 'quick', topic: 'x', material: '字'.repeat(MATERIAL_MAX + 1) });
  assert.equal(long.status, 400);
  assert.match(long.body.error, /材料最多/);
  assert.equal((await request(port, 'POST', '/api/runs', { mode: 'quick', topic: '  ' })).status, 400);
});

test('小会：方案讨论的两位主笔、一位评审，最多 3 轮，列表里标出档位', async (t) => {
  const { app, store, port } = await serve(t);
  const res = await request(port, 'POST', '/api/runs', { mode: 'decision', tier: 'meeting', topic: '要不要上缓存', repos: '无' });
  assert.equal(res.status, 201);
  await waitIdle(app);
  const { number } = res.body;
  const start = store.startEvent(store.executionsOf(number)[0].id);
  assert.deepEqual([start.rounds, start.adaptive, start.participants.length], [3, true, 3]);
  const list = (await request(port, 'GET', '/api/runs')).body.runs;
  assert.equal(list.find((r) => r.number === number).tier, 'meeting');
  assert.equal((await request(port, 'POST', '/api/runs', { mode: 'brainstorm', tier: 'meeting', topic: 'x' })).status, 400);
});
