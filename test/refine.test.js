import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { whoOf } from './helpers.js';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion, runFollowUp } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';
import { parseRevision } from '../src/modes.js';
import { createWebApp, startWebServer } from '../src/web/server.js';
import { openStore } from '../src/db.js';

const base = (extra = {}) => ({
  mode: 'refine',
  participants: [
    { id: 'a', name: 'A', role: '架构', provider: 'fake', part: 'lead' },
    { id: 'b', name: 'B', provider: 'fake', part: 'lead' },
    { id: 'r1', name: 'R1', provider: 'fake', part: 'reviewer' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake' },
  providers: { fake: { type: 'mock' } },
  personas: { refine: { a: { role: '结构与人物' }, chair: { name: '主编' } } },
  ...extra,
});

const subject = {
  type: 'premise',
  id: 'p1',
  title: '挂机流',
  version: 'v1',
  background: '定位：番茄男频',
  current: '书名：挂机流\n金手指：离线收益',
  fields: { title: '挂机流', goldenFinger: '离线收益', identityRole: 'core' },
  fieldsSchema: { type: 'object', properties: { title: { type: 'string' }, goldenFinger: { type: 'string' } } },
  rules: ['所有字段都要写'],
};

function scripted(reply) {
  const calls = [];
  const provider = {
    async complete(opts) {
      const who = whoOf(opts);
      const stage = /【阶段：([^】]+)】/.exec(opts.prompt)?.[1] ?? '';
      const call = { who, stage, prompt: opts.prompt, system: opts.system };
      calls.push(call);
      return { text: reply(call) ?? `发言-${calls.length}`, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { calls, registry: { get: () => provider } };
}

const done = ({ who }) => (who === 'R1' ? '没问题\n评审结论：没有意见了' : null);

test('parseRevision：缺的字段用原值补，多的丢掉，类型不对报错', () => {
  const r = parseRevision('好的\n```json\n{"goldenFinger":"离线收益，每天复利","extra":1}\n```', subject.fields);
  assert.deepEqual(r.fields, { title: '挂机流', goldenFinger: '离线收益，每天复利', identityRole: 'core' });
  assert.deepEqual(r.changed, ['goldenFinger']);
  assert.throws(() => parseRevision('```json\n{"title":["x"]}\n```', subject.fields), /title 应该是 string/);
  assert.throws(() => parseRevision('不是 JSON', subject.fields), /不是合法的 JSON/);
});

test('打磨：打磨对象放在共用系统提示词里，换成打磨的角色，最后主编写出修订版', async () => {
  const cfg = normalizeConfig(base());
  assert.equal(cfg.participants[0].role, '结构与人物');
  const { calls, registry } = scripted((c) => {
    if (c.stage === '修订版') return '```json\n{"goldenFinger":"离线收益，按天复利"}\n```';
    return done(c);
  });
  const publisher = createMemoryPublisher();
  const res = await runDiscussion({ cfg, topic: '金手指太强', providers: registry, publisher, subject });

  const first = calls.find((c) => c.stage === '诊断与修改方案');
  assert.ok(first, '第 1 轮是诊断');
  assert.match(first.system, /打磨对象：梗概「挂机流」/);
  assert.match(first.system, /金手指：离线收益/);
  assert.match(first.system, /作者的要求\n金手指太强/);
  assert.match(first.prompt, /结构与人物/);
  const doc = calls.find((c) => c.stage === '主文档');
  assert.match(doc.prompt, /你是「主编」[\s\S]*## 原稿的问题[\s\S]*## 修改方案/);
  // 修订版按主文档写
  assert.match(calls.find((c) => c.stage === '修订版').prompt, /讨论形成的修改说明（主文档）/);
  assert.deepEqual(res.revision.changed, ['goldenFinger']);
  assert.equal(res.state.revision.fields.goldenFinger, '离线收益，按天复利');
  assert.equal(res.state.subject.version, 'v1');
  // 修订版的原始 JSON 不发出来，只发一条说明
  assert.ok(publisher.posts.some((p) => p.meta?.stage === 'rewrite' && /改动的部分：金手指/.test(p.body)));
  assert.ok(!publisher.posts.some((p) => /```json/.test(p.body)));
});

test('打磨：修订版格式不对时重写一次', async () => {
  const cfg = normalizeConfig(base());
  let tries = 0;
  const { registry } = scripted((c) => {
    if (c.stage === '修订版') {
      tries += 1;
      return tries === 1 ? '我觉得应该这样改……' : '```json\n{"title":"挂机流：利滚利"}\n```';
    }
    return done(c);
  });
  const res = await runDiscussion({ cfg, topic: '', providers: registry, publisher: createMemoryPublisher(), subject });
  assert.equal(tries, 2);
  assert.deepEqual(res.revision.changed, ['title']);
});

test('打磨的追问：重新讨论后重写修订版', async () => {
  const cfg = normalizeConfig(base());
  let n = 0;
  const { registry } = scripted((c) => {
    if (c.stage === '修订版') return `\`\`\`json\n{"title":"版本${(n += 1)}"}\n\`\`\``;
    if (c.stage === '追问判断') return '处理方式：重新讨论\n**给参与者的说明**：作者想换书名';
    return done(c);
  });
  const first = await runDiscussion({ cfg, topic: '', providers: registry, publisher: createMemoryPublisher(), subject, number: 7 });
  const res = await runFollowUp({ cfg, state: first.state, question: '书名再土一点', providers: registry, publisher: createMemoryPublisher() });
  assert.equal(res.handling, 'discuss');
  assert.equal(res.state.revision.fields.title, '版本2');
  assert.equal(res.state.revisions.length, 2);
});

// ---------- 网页 ----------

function request(port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('网页：发起打磨 → 讨论结束有修订版 → 确认后写回墨稿，带上开始时的 version', async (t) => {
  const applied = [];
  const novel = {
    baseUrl: 'fake',
    list: async () => [{ type: 'premise', id: 'p1', title: '挂机流' }],
    get: async () => structuredClone(subject),
    apply: async (req) => { applied.push(req); return { ok: true, version: 'v2' }; },
  };
  // providers.fake 是 mock 类型：不是 --mock 演练，修订版可以写回
  const app = createWebApp({ cfg: normalizeConfig(base({ mode: 'decision' })), novel, store: openStore(':memory:'), log: () => {}, echo: false });
  const server = await startWebServer(app, { host: '127.0.0.1', port: 0, log: () => {} });
  t.after(() => server.close());
  const { port } = server.address();

  const started = await request(port, 'POST', '/api/runs', { type: 'premise', id: 'p1', requirement: '金手指太强' });
  assert.equal(started.status, 201);
  const { number } = started.body;
  for (let i = 0; i < 200 && !app.idle(); i += 1) await new Promise((r) => setTimeout(r, 10));

  const detail = await request(port, 'GET', `/api/runs/${number}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.revision, '有修订版');
  assert.ok(detail.body.posts.length > 3, '发言写进了 thread.jsonl');
  assert.equal(detail.body.topic, '金手指太强');
  assert.equal(detail.body.mode, 'refine');
  assert.equal(detail.body.channel, 'web');

  // 跨站请求被拒
  const foreign = await request(port, 'POST', `/api/runs/${number}/apply`, {}, { origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);

  const ok = await request(port, 'POST', `/api/runs/${number}/apply`, { revisionAt: detail.body.revision.at });
  assert.equal(ok.status, 200);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].version, 'v1');
  assert.deepEqual(applied[0].fields, detail.body.revision.fields);
  assert.match(applied[0].note, new RegExp(`#${number}`));

  const again = await request(port, 'POST', `/api/runs/${number}/apply`, { revisionAt: detail.body.revision.at });
  assert.equal(again.status, 409, '同一版不重复写回');

  const runs = await request(port, 'GET', '/api/runs');
  assert.equal(runs.body.runs[0].number, number);
  assert.ok(runs.body.runs[0].applied);
});
