import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { normalizeConfig } from '../src/config.js';
import { createWebApp, startWebServer } from '../src/web/server.js';
import { createFileInbox, combineInterjections, appendInbox } from '../src/inbox.js';

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
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-storm-web-'));
  const app = createWebApp({ cfg, novel: { baseUrl: 'fake' }, runsDir, log: () => {}, echo: false, ...opts });
  const server = await startWebServer(app, { host: '127.0.0.1', port: 0, log: () => {} });
  t.after(() => { server.close(); fs.rmSync(runsDir, { recursive: true, force: true }); });
  return { app, runsDir, port: server.address().port };
}

const waitIdle = async (app) => { for (let i = 0; i < 300 && !app.idle(); i += 1) await new Promise((r) => setTimeout(r, 10)); };

/** 模拟群监听跑过的一场讨论：主目录 + 一次追问目录。 */
function fakeLarkRun(runsDir, { number = 3, running = false } = {}) {
  const dir = path.join(runsDir, `20261111-100000-#${number}-拆库`);
  fs.mkdirSync(dir);
  const started = { at: '2026-11-11T02:00:00Z', type: 'run_started', number, topic: '拆库\n背景……', mode: 'decision', pid: running ? process.pid : 999999, dryRun: false, mock: false };
  fs.writeFileSync(path.join(dir, 'usage.jsonl'), `${JSON.stringify(started)}\n${JSON.stringify({ type: 'call_started', speaker: 'a', stage: 'propose', round: 1, at: '2026-11-11T02:00:01Z' })}\n${running ? '' : `${JSON.stringify({ type: 'run_finished' })}\n`}`);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ at: '2026-11-11T02:00:00Z', speaker: 'chair', title: '方案讨论开始', body: '议题' })}\n`);
  if (!running) {
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, number, topic: '拆库\n背景……', mode: 'decision', summary: '**共识**', followUps: [{ question: '换分库', handling: 'answer', answer: '不用' }], sessions: {}, dryRun: false }));
    const f = path.join(runsDir, `20261111-110000-追问#${number}-换分库`);
    fs.mkdirSync(f);
    fs.writeFileSync(path.join(f, 'usage.jsonl'), `${JSON.stringify({ type: 'run_started', pid: 999999 })}\n${JSON.stringify({ type: 'run_finished' })}\n`);
    fs.writeFileSync(path.join(f, 'events.jsonl'), `${JSON.stringify({ at: '2026-11-11T03:00:00Z', speaker: 'a', title: 'A', body: '回应追问' })}\n`);
  }
  return dir;
}

test('文件插话箱：只读新增的行；合并来源时一个失败不影响另一个', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-storm-inbox-'));
  const inbox = createFileInbox(dir);
  assert.deepEqual(await inbox.poll(), []);
  appendInbox(dir, { sender: '主持人', text: '先别考虑成本' });
  assert.equal((await inbox.poll())[0].text, '先别考虑成本');
  assert.deepEqual(await inbox.poll(), []);
  appendInbox(dir, { sender: '主持人', text: '第二条' });
  const broken = { poll: async () => { throw new Error('限流'); } };
  const both = combineInterjections([broken, inbox]);
  assert.equal((await both.poll())[0].text, '第二条');
  await assert.rejects(both.poll(), /限流/); // 都没拿到时把错误抛出去记日志
  fs.rmSync(dir, { recursive: true, force: true });
});

test('网页：列出群里的讨论，发言含追问，结论来自 state.json', async (t) => {
  const { port, runsDir } = await serve(t);
  fakeLarkRun(runsDir);
  const list = await request(port, 'GET', '/api/runs');
  assert.equal(list.body.runs[0].number, 3);
  assert.equal(list.body.runs[0].channel, 'lark');
  assert.equal(list.body.runs[0].status, 'done');
  assert.equal(list.body.runs[0].followUps, 1);
  assert.equal(list.body.runs[0].topic, '拆库');
  const detail = await request(port, 'GET', '/api/runs/3');
  assert.deepEqual(detail.body.posts.map((p) => [p.part, p.body]), [[0, '议题'], [1, '回应追问']]);
  assert.equal(detail.body.posts[0].speaker.color, 'purple');
  assert.equal(detail.body.conclusion, '**共识**');
  assert.equal(detail.body.canFollowUp, true);
});

test('网页：进行中的群讨论可以插话（写进 inbox.jsonl），没在进行的不行', async (t) => {
  const { port, runsDir } = await serve(t);
  const dir = fakeLarkRun(runsDir, { running: true });
  const detail = await request(port, 'GET', '/api/runs/3');
  assert.equal(detail.body.progress.status, 'running');
  assert.equal(detail.body.progress.speaking[0].name, 'A');
  const ok = await request(port, 'POST', '/api/runs/3/interject', { text: '只考虑 MySQL' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.lark, true);
  assert.match(fs.readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8'), /只考虑 MySQL/);

  fakeLarkRun(runsDir, { number: 4 });
  assert.equal((await request(port, 'POST', '/api/runs/4/interject', { text: 'x' })).status, 409);
});

test('网页：进程已经退出、没写结束的讨论显示失败', async (t) => {
  const { port, runsDir } = await serve(t);
  const dir = fakeLarkRun(runsDir, { running: true });
  const usage = path.join(dir, 'usage.jsonl');
  fs.writeFileSync(usage, fs.readFileSync(usage, 'utf8').replace(`"pid":${process.pid}`, '"pid":999999'));
  const detail = await request(port, 'GET', '/api/runs/3');
  assert.equal(detail.body.progress.status, 'failed');
});

test('网页：群里的讨论在网页上追问，追问照样发到群里', async (t) => {
  const calls = [];
  const runner = { followUpOne: async (c, opts) => { calls.push({ mode: c.mode, ...opts }); } };
  const { port, runsDir, app } = await serve(t, { runner });
  fakeLarkRun(runsDir);
  const res = await request(port, 'POST', '/api/runs/3/followup', { question: '换成按商家分库呢？' });
  assert.equal(res.status, 202);
  assert.equal(res.body.lark, true);
  await waitIdle(app);
  assert.equal(calls[0].lark, true);
  assert.equal(calls[0].number, 3);
  assert.equal(calls[0].question, '换成按商家分库呢？');
});

test('网页：发起方案讨论只在网页上跑；仓库别名写错直接报错', async (t) => {
  const { port, app } = await serve(t);
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
  // 讨论结论在主文档里：有版本、本机文件，讨论流里有一条主文档消息
  assert.equal(detail.body.docs.length, 1);
  assert.match(detail.body.docs[0].text, /# mock 主文档/);
  assert.ok(fs.existsSync(detail.body.docFile));
  assert.equal(fs.readFileSync(detail.body.docFile, 'utf8').trim(), detail.body.docs[0].text.trim());
  assert.ok(detail.body.posts.some((p) => p.stage === 'doc'));
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
