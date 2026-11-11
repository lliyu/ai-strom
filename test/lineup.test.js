import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { normalizeConfig } from '../src/config.js';
import { lineupConfig, modelPool, defaultLineup, savedLineup, configForState, roleTemplates } from '../src/lineup.js';
import { findState, saveState } from '../src/state.js';
import { createWebApp, startWebServer } from '../src/web/server.js';

const raw = {
  participants: [
    { id: 'a', name: 'A', role: '架构', persona: 'pa', provider: 'fake', model: 'm-a', part: 'lead', color: 'blue', webhook: { urlEnv: 'X' } },
    { id: 'b', name: 'B', role: '质疑', provider: 'fake', model: 'm-b', part: 'lead' },
    { id: 'r', name: 'R', role: '风险', provider: 'fake', model: 'm-r', part: 'reviewer' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake', model: 'm-chair', color: 'purple' },
  models: [{ id: 'x', name: 'X 模型', provider: 'fake', model: 'm-x' }],
  personas: { refine: { a: { role: '结构与人物', persona: '编辑' }, chair: { name: '主编' } } },
  roleTemplates: [{ name: '架构视角', persona: '我自己的架构模板' }, { name: '新模板', persona: 'p', modes: ['refine'] }],
  providers: { fake: { type: 'mock' } },
  rounds: 2,
};
const cfg = normalizeConfig(raw);

test('模型清单：参与者 + models + 主席用的模型', () => {
  assert.deepEqual(modelPool(cfg).map((m) => m.id), ['a', 'b', 'r', 'x', 'chair']);
  assert.equal(modelPool(cfg).find((m) => m.id === 'chair').model, 'm-chair');
  // 主席和某位参与者同一个模型时不重复列
  const same = normalizeConfig({ ...raw, chair: { ...raw.chair, model: 'm-a' } });
  assert.deepEqual(modelPool(same).map((m) => m.id), ['a', 'b', 'r', 'x']);
  assert.equal(defaultLineup(same, 'decision').chair, 'a');
});

test('默认阵容按模式带角色；角色模板同名覆盖内置的', () => {
  const d = defaultLineup(cfg, 'refine');
  assert.deepEqual(d.participants.map((p) => [p.model, p.part, p.role]), [['a', 'lead', '结构与人物'], ['b', 'lead', '质疑'], ['r', 'reviewer', '风险']]);
  assert.equal(d.chair, 'chair');
  const t = roleTemplates(cfg);
  assert.equal(t.find((x) => x.name === '架构视角').persona, '我自己的架构模板');
  assert.ok(t.some((x) => x.name === '新模板'));
});

test('自选阵容：同一模型可以选多次，主席换模型，不套用模式角色表', () => {
  const c = lineupConfig(cfg, {
    mode: 'refine',
    lineup: {
      participants: [
        { model: 'a', part: 'lead', role: '读者', persona: '挑剔' },
        { model: 'a', part: 'lead', role: '逻辑' },
        { model: 'x', part: 'reviewer', role: '市场' },
      ],
      chair: 'b',
    },
  });
  assert.deepEqual(c.participants.map((p) => [p.id, p.name, p.role, p.part, p.model]), [
    ['a', 'A', '读者', 'lead', 'm-a'],
    ['a-2', 'A（2）', '逻辑', 'lead', 'm-a'],
    ['x', 'X 模型', '市场', 'reviewer', 'm-x'],
  ]);
  assert.equal(c.chair.name, '主编'); // 名字按模式
  assert.equal(c.chair.model, 'm-b');
  assert.equal(c.customLineup, true);
  // 存进 state 的阵容不带 webhook，追问时还原成一样的配置
  const saved = savedLineup(c);
  assert.equal(saved.participants[0].webhook, undefined);
  const back = configForState(cfg, { mode: 'refine', lineup: saved });
  assert.deepEqual(back.participants.map((p) => [p.id, p.role, p.model]), c.participants.map((p) => [p.id, p.role, p.model]));
  assert.equal(back.chair.model, 'm-b');
  // 没有自选阵容的讨论（群里、命令行）照旧用配置
  assert.equal(savedLineup(normalizeConfig(raw)), null);
  assert.deepEqual(configForState(cfg, { mode: 'decision' }).participants.map((p) => p.id), ['a', 'b', 'r']);
});

test('自选阵容：不合法时报错', () => {
  const bad = (lineup, re) => assert.throws(() => lineupConfig(cfg, { mode: 'decision', lineup }), re);
  bad({ participants: [{ model: 'a', role: 'x' }] }, /至少选 2 位/);
  bad({ participants: [{ model: 'a', role: 'x' }, { model: 'nope', role: 'y' }] }, /第 2 位：没有「nope」/);
  bad({ participants: [{ model: 'a', role: 'x' }, { model: 'b', role: ' ' }] }, /第 2 位（B）：角色不能为空/);
  bad({ participants: [{ model: 'a', part: 'reviewer', role: 'x' }, { model: 'b', part: 'reviewer', role: 'y' }] }, /至少需要 1 位主笔/);
  bad({ participants: [{ model: 'a', role: 'x' }, { model: 'b', role: 'y' }], chair: 'nope' }, /主席：没有「nope」/);
});

test('「最近一场」不找网页上自选阵容的讨论', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-storm-lineup-'));
  try {
    for (const [n, extra] of [[1, {}], [2, { lineup: { participants: [], chair: {} } }]]) {
      const dir = path.join(runsDir, `run-${n}`);
      fs.mkdirSync(dir);
      saveState(dir, { number: n, mode: 'decision', topic: 't', ...extra });
    }
    assert.equal(findState(runsDir).state.number, 1);
    assert.equal(findState(runsDir, 2).state.number, 2);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('网页：按自选阵容讨论，阵容存进 state.json，追问照原样用', async (t) => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-storm-lineup-web-'));
  const app = createWebApp({ cfg, novel: { baseUrl: 'fake' }, runsDir, log: () => {}, echo: false });
  const server = await startWebServer(app, { host: '127.0.0.1', port: 0, log: () => {} });
  t.after(() => { server.close(); fs.rmSync(runsDir, { recursive: true, force: true }); });
  const port = server.address().port;
  const waitIdle = async () => { for (let i = 0; i < 300 && !app.idle(); i += 1) await new Promise((r) => setTimeout(r, 10)); };

  const status = await request(port, 'GET', '/api/status');
  assert.deepEqual(status.body.models.map((m) => m.id), ['a', 'b', 'r', 'x', 'chair']);
  assert.equal(status.body.lineups.refine.participants[0].role, '结构与人物');
  assert.ok(status.body.roleTemplates.length > 5);

  const bad = await request(port, 'POST', '/api/runs', { mode: 'decision', topic: '拆库', lineup: { participants: [{ model: 'a', role: 'x' }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /至少选 2 位/);

  const lineup = { participants: [{ model: 'x', part: 'lead', role: '性能' }, { model: 'x', part: 'lead', role: '成本' }, { model: 'r', part: 'reviewer', role: '风险' }], chair: 'a' };
  const started = await request(port, 'POST', '/api/runs', { mode: 'decision', topic: '拆库要不要做', repos: '无', rounds: 2, lineup });
  assert.equal(started.status, 201);
  const { number } = started.body;
  await waitIdle();
  const detail = await request(port, 'GET', `/api/runs/${number}`);
  assert.equal(detail.body.progress.status, 'done');
  const names = new Set(detail.body.posts.map((p) => p.speaker.name));
  assert.ok(names.has('X 模型') && names.has('X 模型（2）'), [...names].join(','));
  assert.ok(!names.has('A') && !names.has('B'));

  const dir = fs.readdirSync(runsDir).find((n) => n.includes(`#${number}-`));
  const state = JSON.parse(fs.readFileSync(path.join(runsDir, dir, 'state.json'), 'utf8'));
  assert.deepEqual(state.lineup.participants.map((p) => [p.id, p.role]), [['x', '性能'], ['x-2', '成本'], ['r', '风险']]);
  assert.equal(state.lineup.chair.model, 'm-a');

  const asked = await request(port, 'POST', `/api/runs/${number}/followup`, { question: '成本再算细一点' });
  assert.equal(asked.status, 202);
  await waitIdle();
  const follow = fs.readdirSync(runsDir).find((n) => n.includes(`追问#${number}-`));
  const started2 = fs.readFileSync(path.join(runsDir, follow, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.type === 'run_started');
  assert.deepEqual(started2.participants.map((p) => p.id), ['x', 'x-2', 'r']);
  assert.equal(started2.chair.model, 'm-a');
});
