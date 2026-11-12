import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { normalizeConfig } from '../src/config.js';
import { createWebApp, startWebServer } from '../src/web/server.js';
import { openStore } from '../src/db.js';
import { sharedSystem, SETTING_MAX } from '../src/modes.js';

const cfg = normalizeConfig({
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead', role: '结构' },
    { id: 'r1', name: 'R1', provider: 'fake', part: 'reviewer', role: '读者' },
  ],
  chair: { id: 'chair', name: '主编', provider: 'fake' },
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

const CHAPTER = '第一章 雨夜\n雨下了一整夜，他坐在窗边想了很多事情，想到小时候，想到父亲。\n门外有人敲门。\n他站起来。';

test('改稿：改稿 → 挑刺 → 定稿共 3 次调用；修改说明是文档正文，完整修改稿在附录；不写要求时标题用原文第一行', async (t) => {
  const { app, store, port } = await serve(t);
  const res = await request(port, 'POST', '/api/runs', { mode: 'redraft', topic: '', material: CHAPTER, setting: '主角：林舟，寡言' });
  assert.equal(res.status, 201);
  await waitIdle(app);
  const { number } = res.body;
  assert.deepEqual(calls(store, number), [['a:redraft', 'r1:challenge', 'a:doc']]);
  const d = (await request(port, 'GET', `/api/runs/${number}`)).body;
  assert.equal(d.mode, 'redraft');
  assert.equal(d.setting, '主角：林舟，寡言');
  const doc = d.docs[0];
  assert.match(doc.text, /## 修改说明/);
  assert.match(doc.attachments['修改稿'], /mock 改过的第一段[\s\S]*门外有人敲门/);
  const s = d.docSections[0];
  assert.equal(s.failed, false);
  assert.deepEqual(s.order, ['notes', 'rejected', 'memo']);
  assert.deepEqual(s.memoItems, ['主角说话简短，不用感叹号（mock）']);
  // 第一步的修改稿折叠在卡片的「完整方案」里，不占卡片正文
  const first = d.posts.find((p) => p.stage === 'redraft');
  assert.match(first.plan, /门外有人敲门/);
  const state = store.discussion(number).state;
  assert.match(state.shared, /## 作者的要求\n（作者没有写具体要求[\s\S]*## 章节原文\n第一章 雨夜[\s\S]*## 设定与上下文[\s\S]*林舟/);
  const list = (await request(port, 'GET', '/api/runs')).body.runs;
  assert.equal(list.find((r) => r.number === number).topic, '改稿：第一章 雨夜');
});

test('改稿的追问：改稿的一方看着文档和修改稿直接回答，需要时更新修改稿', async (t) => {
  const { app, store, port } = await serve(t);
  const { number } = (await request(port, 'POST', '/api/runs', { mode: 'redraft', topic: '节奏快一点', material: CHAPTER })).body;
  await waitIdle(app);
  await request(port, 'POST', `/api/runs/${number}/followup`, { question: '第二段再收一点' });
  await waitIdle(app);
  assert.deepEqual(calls(store, number)[1], ['a:answer', 'a:doc']);
  const d = (await request(port, 'GET', `/api/runs/${number}`)).body;
  assert.deepEqual(d.docs.map((x) => x.version), [1, 2]);
  assert.ok(d.docs[1].attachments['修改稿'], '没改的附录原样保留');
});

test('改稿：修改稿比原文短很多时提醒可能不完整', async (t) => {
  const { app, port } = await serve(t);
  const long = `${'很长的第一段。'.repeat(200)}\n第二段`;
  const { number } = (await request(port, 'POST', '/api/runs', { mode: 'redraft', topic: '压缩开头', material: long })).body;
  await waitIdle(app);
  const d = (await request(port, 'GET', `/api/runs/${number}`)).body;
  const warn = d.posts.find((p) => /修改稿可能不完整/.test(p.title));
  assert.ok(warn, '应该有提醒');
  assert.match(warn.body, /可能有段落被省略/);
});

test('改稿校验：没有原文、设定超长、阵容不是两位都 400', async (t) => {
  const { port } = await serve(t);
  assert.equal((await request(port, 'POST', '/api/runs', { mode: 'redraft', topic: '改一下', material: '  ' })).status, 400);
  assert.equal((await request(port, 'POST', '/api/runs', { mode: 'redraft', material: CHAPTER, setting: '字'.repeat(SETTING_MAX + 1) })).status, 400);
  const seat = (model, part) => ({ model, part, role: '角色' });
  const bad = await request(port, 'POST', '/api/runs', { mode: 'redraft', material: CHAPTER, lineup: { participants: [seat('a', 'lead'), seat('r1', 'lead')] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /改稿要两位/);
});

test('作品打磨的共用提示词也带上记忆', () => {
  const s = sharedSystem({ mode: 'refine', topic: '', subject: { type: 'idea', title: '废土', background: '', current: 'x', fields: {} }, memory: '## 提问人的记忆\n小说档案' });
  assert.match(s, /提问人的记忆\n小说档案/);
});
