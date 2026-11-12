import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { normalizeConfig } from '../src/config.js';
import { createWebApp, startWebServer } from '../src/web/server.js';
import { openStore } from '../src/db.js';
import { appendEntries, readEntries, deleteEntry, memorySetup, memoCandidates, listMemory } from '../src/memory.js';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-storm-memory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('记忆文件：追加一行一条、同一个域不重复、能删；格式不对的行忽略', (t) => {
  const dir = tmp(t);
  const now = new Date('2026-11-12T08:00:00Z');
  const a = appendEntries(dir, 'work', ['- 订单库按用户分库不划算', '2. 价格中心的 GTTD 不能直接删\n要先确认下游'], { source: '#10', now });
  assert.equal(a.saved.length, 2);
  assert.deepEqual(readEntries(dir, 'work').map((e) => [e.text, e.source, e.at]), [
    ['订单库按用户分库不划算', '#10', '2026-11-12'],
    ['价格中心的 GTTD 不能直接删 要先确认下游', '#10', '2026-11-12'],
  ]);
  const again = appendEntries(dir, 'work', ['订单库按用户分库不划算', '新的一条'], { source: '#11', now });
  assert.deepEqual([again.saved.map((e) => e.text), again.skipped], [['新的一条'], ['订单库按用户分库不划算']]);
  fs.appendFileSync(path.join(dir, 'work', 'conclusions.md'), '手工写错格式的一行\n');
  assert.equal(readEntries(dir, 'work').length, 3);
  assert.equal(deleteEntry(dir, 'work', a.saved[0].id), true);
  assert.equal(deleteEntry(dir, 'work', a.saved[0].id), false);
  assert.deepEqual(readEntries(dir, 'work').map((e) => e.text), ['价格中心的 GTTD 不能直接删 要先确认下游', '新的一条']);
  assert.throws(() => appendEntries(dir, 'secret', ['x']), /没有「secret」/);
  assert.deepEqual(readEntries(dir, 'personal'), []);
});

test('注入：只带选中的域；档案在前、结论新的在前，超出上限的旧结论不放并说明；空的域不带', (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'work', 'profile.md'), '我是酒店供应链的后端负责人。');
  fs.mkdirSync(path.join(dir, 'personal'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'personal', 'profile.md'), '个人档案：不该出现在工作讨论里');
  for (let i = 1; i <= 30; i += 1) appendEntries(dir, 'work', [`第 ${i} 条结论：${'很长的说明'.repeat(10)}`], { source: `#${i}` });
  const m = memorySetup(dir, ['work', 'novel'], { maxChars: 1000 });
  assert.match(m.block, /^## 提问人的记忆/);
  assert.match(m.block, /我是酒店供应链的后端负责人/);
  assert.doesNotMatch(m.block, /个人档案/, '默认不跨域：没选的域不带');
  assert.deepEqual(m.domains.map((d) => d.id), ['work'], '小说域是空的，不带');
  const [w] = m.domains;
  assert.ok(w.entries > 0 && w.omitted > 0 && w.entries + w.omitted === 30);
  assert.ok(m.block.indexOf('第 30 条') < m.block.indexOf(`第 ${31 - w.entries} 条`), '新的在前');
  assert.doesNotMatch(m.block, /第 1 条结论/);
  assert.match(m.block, new RegExp(`更早的 ${w.omitted} 条放不下`));
  assert.deepEqual(memorySetup(dir, []), { block: '', domains: [] });
  assert.deepEqual(memorySetup(null, ['work']), { block: '', domains: [] });
});

test('从「可存入知识库的结论」取条目：列表项逐条取，写「无」为空', () => {
  assert.deepEqual(memoCandidates('- 结论一\n- **结论二**\n1. 结论三\n说明文字不算'), ['结论一', '结论二', '结论三']);
  assert.deepEqual(memoCandidates('无'), []);
  assert.deepEqual(memoCandidates('- 无'), []);
});

// ---------- 接口 ----------

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

async function serve(t, dir) {
  const cfg = normalizeConfig({
    participants: [
      { id: 'a', name: 'A', provider: 'fake', part: 'lead', role: '架构' },
      { id: 'r1', name: 'R1', provider: 'fake', part: 'reviewer', role: '质疑' },
    ],
    chair: { id: 'chair', name: '主席', provider: 'fake' },
    providers: { fake: { type: 'mock' } },
    memory: { path: dir },
  });
  const store = openStore(':memory:');
  const app = createWebApp({ cfg, novel: { baseUrl: 'fake' }, store, log: () => {}, echo: false });
  const server = await startWebServer(app, { host: '127.0.0.1', port: 0, log: () => {} });
  t.after(() => server.close());
  return { app, store, port: server.address().port };
}
const waitIdle = async (app) => { for (let i = 0; i < 300 && !app.idle(); i += 1) await new Promise((r) => setTimeout(r, 10)); };

test('接口：快问带上选中的记忆（所有模型共用的系统提示词里有全文），开场卡片列出；结束后没确认的结论不落盘', async (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'work', 'profile.md'), '我负责酒店价格中心。');
  fs.mkdirSync(path.join(dir, 'personal'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'personal', 'profile.md'), '个人：周末带娃');
  const { app, store, port } = await serve(t, dir);
  const bad = await request(port, 'POST', '/api/runs', { mode: 'quick', topic: 'x', memory: ['secret'] });
  assert.equal(bad.status, 400);
  const { number } = (await request(port, 'POST', '/api/runs', { mode: 'quick', topic: '缓存要不要加', memory: ['work'] })).body;
  await waitIdle(app);
  const state = store.discussion(number).state;
  assert.match(state.shared, /提问人的记忆[\s\S]*我负责酒店价格中心/);
  assert.doesNotMatch(state.shared, /周末带娃/);
  assert.deepEqual(state.memory.domains.map((d) => [d.id, d.profileChars, d.entries]), [['work', 10, 0]]);
  const d = (await request(port, 'GET', `/api/runs/${number}`)).body;
  assert.match(d.posts[0].body, /\*\*记忆\*\*：工作（档案 10 字）/);
  assert.deepEqual(d.memory.domains.map((x) => x.id), ['work']);
  // 文档里提议了要存的结论，但人还没确认：记忆文件里什么都没有
  assert.deepEqual(d.docSections[0].memoItems, ['可以复用的结论（mock）']);
  assert.ok(!fs.existsSync(path.join(dir, 'work', 'conclusions.md')));
  assert.deepEqual(d.memorySaved, []);

  // 人在结论页勾选后存入：记到这场讨论名下，之后的讨论能带上
  const saved = await request(port, 'POST', '/api/memory/save', { number, domain: 'work', items: d.docSections[0].memoItems });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.saved[0].source, `#${number}`);
  assert.deepEqual((await request(port, 'GET', `/api/runs/${number}`)).body.memorySaved, [{ domain: 'work', text: '可以复用的结论（mock）' }]);
  const status = (await request(port, 'GET', '/api/status')).body;
  assert.deepEqual(status.memory.map((m) => [m.id, m.entries]), [['work', 1], ['personal', 0], ['novel', 0]]);
  const next = (await request(port, 'POST', '/api/runs', { mode: 'quick', topic: '下一个问题', memory: ['work'] })).body.number;
  await waitIdle(app);
  assert.match(store.discussion(next).state.shared, /可以复用的结论（mock）（#\d+，\d{4}-\d{2}-\d{2}）/);

  // 删除
  const all = (await request(port, 'GET', '/api/memory')).body;
  const entry = all.domains.find((x) => x.id === 'work').entries[0];
  assert.equal((await request(port, 'POST', '/api/memory/delete', { domain: 'work', id: entry.id })).status, 200);
  assert.equal((await request(port, 'POST', '/api/memory/delete', { domain: 'work', id: entry.id })).status, 404);
  assert.equal(listMemory(dir).find((x) => x.id === 'work').entries.length, 0);
});

test('接口：存入时校验域、条目和讨论编号；没配置记忆目录时不能存', async (t) => {
  const dir = tmp(t);
  const { port } = await serve(t, dir);
  assert.equal((await request(port, 'POST', '/api/memory/save', { domain: 'x', items: ['a'] })).status, 400);
  assert.equal((await request(port, 'POST', '/api/memory/save', { domain: 'work', items: [] })).status, 400);
  assert.equal((await request(port, 'POST', '/api/memory/save', { domain: 'work', items: ['a'], number: 99 })).status, 404);
  assert.equal((await request(port, 'POST', '/api/memory/save', { domain: 'work', items: ['手工记一条'] })).body.saved[0].source, '手工');

  const store = openStore(':memory:');
  const cfg = normalizeConfig({ participants: [{ id: 'a', provider: 'fake' }, { id: 'b', provider: 'fake' }], chair: { id: 'chair', provider: 'fake' }, providers: { fake: { type: 'mock' } } });
  assert.equal(cfg.memory.path, null, '跑测试时默认不用本机的记忆目录');
  const app = createWebApp({ cfg, novel: { baseUrl: 'fake' }, store, log: () => {}, echo: false });
  const server = await startWebServer(app, { host: '127.0.0.1', port: 0, log: () => {} });
  t.after(() => server.close());
  const p2 = server.address().port;
  assert.equal((await request(p2, 'POST', '/api/memory/save', { domain: 'work', items: ['a'] })).status, 409);
  assert.equal((await request(p2, 'GET', '/api/status')).body.memory, null);
});
