// 断点续跑：讨论每跑完一步存断点，进程中断后从断点接着跑；快问失败重新跑、排队丢了重新排队、追问中断重新追问。
import { whoOf } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';
import { createWebApp, startWebServer } from '../src/web/server.js';
import { openStore } from '../src/db.js';

const GOOD_DOC = '【说明】\n一句话结论\n【主文档】\n# 结论\n正文';
const PLAN = (x) => `**要点**：方案 ${x}\n**改了什么**\n- 改了\n**立场变化**（小幅）\n\n【完整方案】\n完整方案-${x}`;
const SAME = '**要点**：不改\n**改了什么**\n- 无变化\n**立场变化**（无）\n\n【完整方案】\n无变化';
const BLOCK = '**要点**：1 条阻断\n- 【阻断】回滚没设计 → 出事回不去 → 加开关\n评审结论：继续讨论';

const cfgOf = (extra = {}) => normalizeConfig({
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead' },
    { id: 'b', name: 'B', provider: 'fake', part: 'lead' },
    { id: 'r1', name: 'R1', provider: 'fake', part: 'reviewer' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake' },
  providers: { fake: { type: 'mock' } },
  retryDelayMs: 0,
  ...extra,
});

function scripted(reply = () => null) {
  const calls = [];
  const provider = {
    async complete(opts) {
      const who = whoOf(opts);
      const stage = /【阶段：([^】]+)】/.exec(opts.prompt)?.[1] ?? '';
      const round = Number(/第 (\d+) 轮/.exec(stage)?.[1] ?? 0);
      const call = { who, stage, round, prompt: opts.prompt };
      calls.push(call);
      return { text: reply(call) ?? (stage.includes('主文档') ? (stage === '核对主文档' ? '没有问题' : GOOD_DOC) : `发言-${calls.length}`), usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { calls, registry: { get: () => provider } };
}
const lead = (c) => c.who === 'A' || c.who === 'B';

/** 跑一场完整讨论，收下每次存的断点（经过 JSON，和存进库里的一样）。 */
async function withCheckpoints(cfg, reply) {
  const cps = [];
  const { registry } = scripted(reply);
  const result = await runDiscussion({ cfg, topic: '议题', providers: registry, publisher: createMemoryPublisher(), rng: () => 0, onCheckpoint: (d) => cps.push(JSON.parse(JSON.stringify(d))) });
  return { cps, result };
}

test('断点：开场后、每一轮跑完、轮次结束后各存一次', async () => {
  const { cps } = await withCheckpoints(cfgOf({ rounds: 4 }), (c) => (lead(c) ? PLAN(`${c.who}${c.round}`) : null));
  assert.deepEqual(cps.map((c) => (c.phase === 'round' ? `round${c.round}` : c.phase)), ['opened', 'round1', 'round2', 'round3', 'round4', 'iterated']);
  const r2 = cps[2];
  assert.equal(r2.rounds.filter((x) => x.round === 2).length, 2, '第 2 轮的评审和修订都在断点里');
  assert.ok(Object.values(r2.sessions).every((s) => s.turns.length > 0), '会话也存下了');
  assert.ok(r2.stats.calls > 0);
  assert.deepEqual(cps.at(-1).ending.reason, 'fixed');
});

test('从第 2 轮之后续跑：不重跑前两轮，会话接着用（身份不再重复说），先发一张续跑卡片，最后照常写主文档', async () => {
  const cfg = cfgOf({ rounds: 4 });
  const { cps } = await withCheckpoints(cfg, (c) => (lead(c) ? PLAN(`${c.who}${c.round}`) : null));
  const cp = cps.find((c) => c.phase === 'round' && c.round === 2);
  const { calls, registry } = scripted((c) => (lead(c) ? PLAN(`${c.who}${c.round}`) : null));
  const publisher = createMemoryPublisher();
  const res = await runDiscussion({ cfg, topic: cp.topic, providers: registry, publisher, rng: () => 0.9, resume: { ...cp, postId: 7 } });
  assert.equal(calls[0].stage, '第 3 轮评审意见');
  assert.ok(!calls.some((c) => /独立方案|第 2 轮/.test(c.stage)), '前两轮不重跑');
  assert.ok(calls.filter((c) => c.who === 'R1' || lead(c)).every((c) => !/^你是「/.test(c.prompt)), '会话接着用，身份不再重复说');
  const card = publisher.posts[0];
  assert.match(card.title, /续跑/);
  assert.match(card.subtitle, /第 2 轮之后，从第 3 轮/);
  assert.deepEqual(card.meta, { stage: 'resume', round: 2, discardAfter: 7 });
  assert.deepEqual(res.rounds.map((x) => `${x.round}${x.stage[0]}`), ['1p', '2c', '2r', '3c', '3r', '4c', '4r']);
  assert.ok(res.docs.length);
  assert.ok(res.stats.calls > cp.stats.calls, '用量接着断点累加');
  assert.equal(res.state.tags.a.tag, cp.tags.a.tag, '代号沿用断点里的，不重新抽');
});

test('熔断计数从断点恢复：第 2 轮之后续跑，第 3 轮照样判僵局', async () => {
  const cfg = cfgOf({ rounds: 'auto', maxRounds: 8 });
  const reply = (c) => (lead(c) ? (c.round >= 2 ? SAME : PLAN(c.who)) : c.who === 'R1' ? BLOCK : null);
  const { cps, result } = await withCheckpoints(cfg, reply);
  assert.equal(result.ending.reason, 'deadlock');
  assert.equal(result.ending.round, 3);
  const cp = cps.find((c) => c.phase === 'round' && c.round === 2);
  assert.equal(cp.loop.stuck, 1);
  const { registry } = scripted(reply);
  const res = await runDiscussion({ cfg, topic: cp.topic, providers: registry, publisher: createMemoryPublisher(), rng: () => 0, resume: cp });
  assert.deepEqual([res.ending.reason, res.ending.round], ['deadlock', 3]);
});

test('从开场之后续跑：从第 1 轮开始；从轮次结束之后续跑：只写主文档', async () => {
  const cfg = cfgOf({ rounds: 3 });
  const { cps } = await withCheckpoints(cfg, (c) => (lead(c) ? PLAN(`${c.who}${c.round}`) : null));
  const a = scripted((c) => (lead(c) ? PLAN(c.who) : null));
  await runDiscussion({ cfg, topic: 't', providers: a.registry, publisher: createMemoryPublisher(), rng: () => 0, resume: cps.find((c) => c.phase === 'opened') });
  assert.equal(a.calls[0].stage, '独立方案');
  const b = scripted();
  const res = await runDiscussion({ cfg, topic: 't', providers: b.registry, publisher: createMemoryPublisher(), rng: () => 0, resume: cps.find((c) => c.phase === 'iterated') });
  assert.ok(b.calls.every((c) => c.stage.includes('主文档')), b.calls.map((c) => c.stage).join(','));
  assert.equal(res.roundsUsed, 3);
});

// ---------- 网页：中断后的按钮 ----------

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
const waitIdle = async (app) => { for (let i = 0; i < 300 && !app.idle(); i += 1) await new Promise((r) => setTimeout(r, 10)); };

async function serve(t) {
  const cfg = normalizeConfig({
    participants: [
      { id: 'a', name: 'A', provider: 'fake', part: 'lead', role: '架构' },
      { id: 'b', name: 'B', provider: 'fake', part: 'lead', role: '质疑' },
      { id: 'r1', name: 'R1', provider: 'fake', part: 'reviewer', role: '落地' },
    ],
    chair: { id: 'chair', name: '主席', provider: 'fake' },
    providers: { fake: { type: 'mock' } },
  });
  const store = openStore(':memory:');
  const app = createWebApp({ cfg, novel: { baseUrl: 'fake' }, store, log: () => {}, echo: false });
  const server = await startWebServer(app, { host: '127.0.0.1', port: 0, log: () => {} });
  t.after(() => server.close());
  return { app, store, port: server.address().port };
}

/** 模拟进程在第 2 轮之后中断：断点只留到第 2 轮，讨论状态不存，运行标成失败。 */
function crashAfterRound2(store) {
  const real = { saveCheckpoint: store.saveCheckpoint, saveState: store.saveState, clearCheckpoint: store.clearCheckpoint };
  store.saveCheckpoint = (n, e, d) => (d.phase === 'opened' || (d.phase === 'round' && d.round <= 2) ? real.saveCheckpoint(n, e, d) : undefined);
  store.saveState = () => {};
  store.clearCheckpoint = () => {};
  return () => Object.assign(store, real);
}

test('网页：中断的讨论显示「从断点续跑」，续跑后正常结束；断点之后的旧发言标成作废，不算进阻断和问题追踪', async (t) => {
  const { app, store, port } = await serve(t);
  const restore = crashAfterRound2(store);
  const { number } = (await request(port, 'POST', '/api/runs', { mode: 'decision', topic: '预算扣减', repos: '无', rounds: 4, items: true })).body;
  await waitIdle(app);
  restore();
  const exec = store.executionsOf(number)[0];
  store.finishExecution(exec.id, { status: 'failed', error: '进程退出' });
  const before = (await request(port, 'GET', `/api/runs/${number}`)).body;
  assert.equal(before.progress.status, 'failed');
  assert.deepEqual([before.recovery.action, before.recovery.where], ['resume', '第 2 轮之后']);
  assert.equal(before.docs.length, 0);
  // 续跑
  assert.equal((await request(port, 'POST', `/api/runs/${number}/recover`, { action: 'rerun' })).status, 409, '动作不对就拒绝');
  assert.equal((await request(port, 'POST', `/api/runs/${number}/recover`, { action: 'resume' })).status, 202);
  await waitIdle(app);
  const d = (await request(port, 'GET', `/api/runs/${number}`)).body;
  assert.equal(d.progress.status, 'done');
  assert.equal(d.recovery, null);
  assert.equal(d.docs.length, 1);
  assert.equal(store.executionsOf(number).length, 1, '续跑记在原来那次运行名下，不另起一段');
  assert.equal(store.checkpoint(number), null, '正常结束后断点删掉');
  const resumeAt = d.posts.findIndex((p) => p.stage === 'resume');
  assert.ok(resumeAt > 0);
  const voided = d.posts.filter((p) => p.discarded);
  assert.ok(voided.length > 0 && voided.every((p) => d.posts.indexOf(p) < resumeAt), '作废的都在续跑卡片之前');
  assert.ok(voided.some((p) => p.stage === 'critique' && p.round === 3), '中断前第 3 轮的评审作废');
  assert.ok(d.posts.filter((p) => !p.discarded && p.stage === 'critique' && p.round === 3).length === 1, '续跑后的第 3 轮评审只有一份有效');
  assert.ok(d.issues.issues.every((x) => x.mentions.length === 1), '作废的发言不进问题追踪');
});

test('网页：排队时进程退出的重新排队（同一个编号）；快问失败的重新跑（新编号）；追问中断的重新追问', async (t) => {
  const { app, store, port } = await serve(t);
  // 排队中丢了：有发起参数、没有任何运行
  const number = store.reserveNumber({ mode: 'quick', topic: '缓存要不要加', channel: 'web' });
  store.saveJob(number, { kind: 'discuss', params: { mode: 'quick', topic: '缓存要不要加' } });
  const lost = (await request(port, 'GET', `/api/runs/${number}`)).body;
  assert.equal(lost.recovery.action, 'requeue');
  await request(port, 'POST', `/api/runs/${number}/recover`, { action: 'requeue' });
  await waitIdle(app);
  const done = (await request(port, 'GET', `/api/runs/${number}`)).body;
  assert.equal(done.progress.status, 'done');
  assert.equal(done.docs.length, 1);

  // 快问跑到一半失败：用原来的问题另起一场
  const failed = store.reserveNumber({ mode: 'quick', topic: '另一个问题', channel: 'web' });
  store.saveJob(failed, { kind: 'discuss', params: { mode: 'quick', topic: '另一个问题' } });
  const ex = store.startExecution({ number: failed, kind: 'discussion', topic: '另一个问题' });
  store.finishExecution(ex, { status: 'failed', error: '超时' });
  assert.equal((await request(port, 'GET', `/api/runs/${failed}`)).body.recovery.action, 'rerun');
  const again = (await request(port, 'POST', `/api/runs/${failed}/recover`, { action: 'rerun' })).body;
  assert.ok(again.number > failed);
  await waitIdle(app);
  assert.equal((await request(port, 'GET', `/api/runs/${again.number}`)).body.topic, '另一个问题');

  // 追问中断：原讨论还在，用同一个问题再追问
  const fx = store.startExecution({ number, kind: 'followup', topic: '再展开说说' });
  store.finishExecution(fx, { status: 'failed', error: '进程退出' });
  const r = (await request(port, 'GET', `/api/runs/${number}`)).body.recovery;
  assert.deepEqual(r, { action: 'refollow', question: '再展开说说' });
  assert.equal((await request(port, 'POST', `/api/runs/${number}/recover`, { action: 'refollow' })).status, 202);
  await waitIdle(app);
  assert.equal(store.executionsOf(number).at(-1).status, 'done');
});
