// 第四批：数据工具和业务知识接进讨论。开场主席判断要不要查实时数据，核实员查、调研员审查；
// 讨论中的待核实问题也能查数据；调研员审查时看得到核实员的查询记录；选择存进 state.json，追问照用。
import { whoOf } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion, runFollowUp, toolCallsNote } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';
import { parseDataPlan } from '../src/modes.js';
import { prepareData } from '../src/tools/index.js';
import { knowledgeSetup } from '../src/knowledge.js';

const GOOD_DOC = '【说明】\n一句话结论\n【主文档】\n# 结论\n正文';
const DONE = '**要点**：没有了\n评审结论：没有意见了';
const PLAN_NEED = '查数据：需要\n**要查的问题**\n- 近 7 天 hotel 订单按供应商的取消率\n- hotelfissionsrv 现在部署的版本';
const DRAFT = '1. 供应商 X 取消率 30%（query-db，demo_db.orders，近 7 天 UTC）\n2. v1';
const FINAL = '**审查**：共 2 条，1 条有更正（第 1 条）\n1. 【已更正】至少 12%：初稿漏了时区换算（query-db …）\n2. v1（query-service）';
const CALLS = [{ name: 'mcp__storm__query-db', input: { db: 'demo_db', sql: 'select 1' }, isError: false, resultChars: 120 }];

const MCP = { config: { mcpServers: { storm: { command: 'node', args: [] } } }, allowed: ['mcp__storm__query-db', 'mcp__storm__query-service'], listed: [{ server: 'storm', name: 'query-db', description: '查库' }, { server: 'storm', name: 'query-service', description: '查服务' }] };
const KNOW = { dirs: ['/know/hotel'], block: '**业务知识**（测试）\n时间列存 UTC', sources: ['hotel'], skipped: [] };
const DATA = { selection: { tools: true, knowledge: ['hotel'] }, mcp: MCP, knowledge: KNOW };

const cfg = ({ checker = true, ...extra } = {}) => normalizeConfig({
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead' },
    { id: 'b', name: 'B', provider: 'fake', part: 'lead' },
    { id: 'r', name: 'R', provider: 'fake', part: 'reviewer' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake' },
  providers: { fake: { type: 'mock' } },
  research: checker ? { factChecker: { id: 'factchecker', name: '核实员', role: '代码核实 · Sonnet', provider: 'fake', model: 'sonnet' } } : { provider: 'fake' },
  repos: checker ? {} : { x: { path: '/r/x', description: 'x' } },
  retryDelayMs: 0,
  rounds: 3,
  ...extra,
});

function scripted(reply = () => null) {
  const calls = [];
  const provider = {
    async complete(opts) {
      const who = whoOf(opts);
      const stage = /【阶段：([^】]+)】/.exec(opts.prompt)?.[1] ?? '';
      const round = Number(/第 (\d+) 轮/.exec(stage)?.[1] ?? 0);
      const call = { who, stage, round, prompt: opts.prompt, system: opts.system, tools: opts.tools, addDirs: opts.addDirs, mcp: opts.mcp };
      calls.push(call);
      const out = reply(call);
      if (out instanceof Error) throw out;
      const text = out ?? (stage.includes('主文档') ? (stage === '核对主文档' ? '没有问题' : GOOD_DOC) : `发言-${calls.length}`);
      return { text, usage: { inputTokens: 1, outputTokens: 1 }, ...(opts.mcp ? { toolCalls: CALLS } : {}) };
    },
  };
  return { calls, registry: { get: () => provider } };
}

const script = ({ plan = PLAN_NEED, reviewer = () => DONE } = {}) => (c) => {
  if (c.stage === '数据核实判断') return plan;
  if (c.stage === '实时数据初稿') return DRAFT;
  if (c.stage === '实时数据审查') return FINAL;
  if (c.who === '核实员') return '1. 数据初稿';
  if (c.who === '调研员' && c.stage.includes('核实审查')) return '**审查**：共 1 条，全部无误\n1. 数据定稿';
  if (c.who === '调研员' && c.stage.includes('代码核实')) return '1. 调研员直接查的数据';
  if (c.who === 'R') return reviewer(c);
  return null;
};

test('解析查数据判断', () => {
  assert.equal(parseDataPlan(PLAN_NEED).questions.length, 2);
  assert.deepEqual(parseDataPlan('查数据：不需要\n纯取舍'), { need: false, questions: [] });
  assert.deepEqual(parseDataPlan('搜集资料：需要\n**要查的问题**\n- x'), { need: false, questions: [] });
});

test('开场查实时数据：主席列问题，核实员带数据工具和知识写初稿，调研员看着查询记录审查，只有定稿进背景', async () => {
  const { calls, registry } = scripted(script({ plan: PLAN_NEED }));
  const publisher = createMemoryPublisher();
  const res = await runDiscussion({ cfg: cfg(), topic: '供应商 X 要不要下线', providers: registry, publisher, rng: () => 0, data: DATA });
  const plan = calls.find((c) => c.stage === '数据核实判断');
  assert.equal(plan.who, '主席');
  assert.match(plan.prompt, /mcp__storm__query-db/);
  assert.equal(plan.mcp, undefined, '主席不用工具');
  const draft = calls.find((c) => c.stage === '实时数据初稿');
  assert.equal(draft.who, '核实员');
  assert.equal(draft.mcp, MCP);
  assert.deepEqual(draft.addDirs, ['/know/hotel']);
  assert.ok(draft.tools.includes('Read'));
  assert.match(draft.prompt, /时间列存 UTC/);
  assert.match(draft.prompt, /limit_reached/);
  const review = calls.find((c) => c.stage === '实时数据审查');
  assert.equal(review.who, '调研员');
  assert.equal(review.mcp, MCP);
  assert.match(review.prompt, /核实员的查询记录/);
  assert.match(review.prompt, /mcp__storm__query-db \{"db":"demo_db"/);
  assert.match(review.prompt, /供应商 X 取消率 30%/);
  // 主笔看到的是定稿
  const lead = calls.find((c) => c.who === 'A' && c.stage === '独立方案');
  assert.match(lead.system, /## 实时数据/);
  assert.match(lead.system, /【已更正】至少 12%/);
  assert.doesNotMatch(lead.system, /取消率 30%/);
  assert.equal(lead.mcp, undefined, '参与者不直接用数据工具');
  assert.match(lead.prompt, /\*\*数据核实\*\*/);
  assert.deepEqual(res.state.data, { tools: true, knowledge: ['hotel'] });
  assert.equal(res.state.dataContext.review.corrections, 1);
  assert.equal(res.state.dataContext.toolCalls.draft[0].name, 'mcp__storm__query-db');
  // 卡片带查询记录
  const draftCard = publisher.posts.find((p) => p.meta?.stage === 'dataresearch');
  assert.match(draftCard.body, /\*\*查询记录\*\*（1 次）/);
  assert.match(publisher.posts[0].body, /\*\*实时数据\*\*/);
  assert.match(publisher.posts[0].body, /\*\*业务知识\*\*：.*hotel/);
});

test('主席判断不需要：不查；讨论中的待核实问题用数据工具查，记下查询记录', async () => {
  const { calls, registry } = scripted(script({
    plan: '查数据：不需要\n纯取舍',
    reviewer: (c) => (c.round === 2 ? '**要点**：1 条\n- 【阻断】取消率没依据 → 判断会错 → 查数据\n\n**待核实的事实**\n- 供应商 X 近 7 天取消率？\n\n评审结论：继续讨论' : DONE),
  }));
  const res = await runDiscussion({ cfg: cfg(), topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0, data: DATA });
  assert.ok(!calls.some((c) => c.stage === '实时数据初稿'));
  assert.equal(res.state.dataContext, undefined);
  const draft = calls.find((c) => c.who === '核实员' && c.stage.includes('代码核实'));
  assert.equal(draft.mcp, MCP);
  assert.match(draft.prompt, /需要核实的问题/);
  // 本场无代码但选了核实员：数据核实时也能联网
  assert.ok(draft.tools.includes('WebSearch'));
  assert.match(draft.prompt, /也可以联网/);
  const review = calls.find((c) => c.who === '调研员' && c.stage.includes('核实审查'));
  assert.match(review.prompt, /核实员的查询记录/);
  const fact = res.state.facts[0];
  assert.equal(fact.source, 'data');
  assert.equal(fact.toolCalls.draft.length, 1);
  assert.match(calls.find((c) => c.who === 'A' && c.round === 3).prompt, /事实核实结果（调研员刚查代码、实时数据或业务知识得出/);
});

test('有代码时：代码核实也带上数据工具和知识；没有核实员时调研员直接查', async () => {
  const code = { repos: [{ alias: 'x', description: 'x', readPath: '/tmp/x', branch: 'main', commit: 'abc', dirty: 0, snapshot: false }], docs: [], groups: [], dirs: ['/tmp/x'] };
  const { calls, registry } = scripted((c) => {
    if (c.who === '调研员' && c.stage === '代码调研') return '**一句话现状**\nx:a.go:1';
    if (c.stage === '数据核实判断') return '查数据：不需要\nx';
    if (c.who === 'R' && c.round === 2) return '**要点**：1 条\n- 【阻断】x → y → z\n\n**待核实的事实**\n- 线上有没有 status=4 的记录？\n\n评审结论：继续讨论';
    if (c.who === 'R') return DONE;
    return null;
  });
  const res = await runDiscussion({ cfg: cfg({ checker: false }), topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0, code, data: DATA });
  const research = calls.find((c) => c.stage === '代码调研');
  assert.deepEqual(research.addDirs, ['/tmp/x', '/know/hotel']);
  assert.match(research.prompt, /时间列存 UTC/);
  assert.equal(research.mcp, undefined);
  const check = calls.find((c) => c.who === '调研员' && c.stage.includes('代码核实'));
  assert.equal(check.mcp, MCP);
  assert.deepEqual(check.addDirs, ['/tmp/x', '/know/hotel']);
  assert.match(check.prompt, /另外可以用的证据/);
  assert.match(check.prompt, /不要写「代码回答不了」/);
  assert.equal(res.state.facts[0].toolCalls.review.length, 1);
});

test('追问：按 state 里的选择带上数据工具，核实型追问用数据查', async () => {
  const first = await runDiscussion({ cfg: cfg(), topic: 't', providers: scripted(script({ plan: '查数据：不需要\nx' })).registry, publisher: createMemoryPublisher(), rng: () => 0, data: DATA });
  const { calls, registry } = scripted((c) => {
    if (c.stage === '追问判断') return '处理方式：核实\n**要核实的问题**\n- 昨天的订单量？';
    if (c.who === '核实员') return '1. 1200 单（query-db …）';
    if (c.who === '调研员') return '**审查**：共 1 条，全部无误\n1. 1200 单';
    return null;
  });
  const out = await runFollowUp({ cfg: cfg(), state: first.state, question: '查一下昨天订单量', providers: registry, publisher: createMemoryPublisher(), data: DATA });
  assert.equal(out.handling, 'verify');
  assert.match(calls.find((c) => c.stage === '追问判断').prompt, /处理方式：核实/);
  assert.equal(calls.find((c) => c.who === '核实员').mcp, MCP);
  assert.equal(out.state.facts.at(-1).source, 'data');
  // 没带数据（例如工具没了）时不能核实
  const none = scripted((c) => (c.stage === '追问判断' ? '处理方式：核实\n**要核实的问题**\n- x' : null));
  const out2 = await runFollowUp({ cfg: cfg({ checker: false, repos: {} }), state: { ...first.state, context: null }, question: 'q', providers: none.registry, publisher: createMemoryPublisher() });
  assert.equal(out2.handling, 'discuss');
});

test('没选数据工具时流程不变；查询记录的卡片写法', async () => {
  const { calls, registry } = scripted(script());
  const res = await runDiscussion({ cfg: cfg(), topic: 't', providers: registry, publisher: createMemoryPublisher(), rng: () => 0 });
  assert.ok(!calls.some((c) => c.stage === '数据核实判断'));
  assert.ok(!calls.some((c) => c.mcp));
  assert.equal(res.state.data, undefined);
  assert.equal(toolCallsNote([]), '');
  assert.match(toolCallsNote([{ name: 'mcp__logs__query_logs', input: { q: 'x'.repeat(300) }, denied: true }]), /- logs · query_logs `\{"q":"x+…` → 被拒/);
});

test('prepareData：按选择准备；工具没登记、来源不存在时用不上', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-storm-data-'));
  fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify({ tools: [{ id: 'q', description: 'q', effect: 'read', command: ['node', 'q.js'] }] }));
  const know = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-storm-know-'));
  fs.writeFileSync(path.join(know, 'INDEX.md'), '索引');
  const c = cfg({ dataTools: { dir }, knowledge: { hotel: { path: know } } });
  const d = prepareData(c, { tools: true, knowledge: ['hotel', 'nope'] }, { logFile: '/tmp/x.jsonl', knowledgeSetup });
  assert.deepEqual(d.selection, { tools: true, knowledge: ['hotel'] });
  assert.deepEqual(d.mcp.allowed, ['mcp__storm__q']);
  assert.deepEqual(d.knowledge.dirs, [know]);
  assert.equal(prepareData(c, null, { knowledgeSetup }), null);
  assert.equal(prepareData(normalizeConfig({ ...c, mode: 'brainstorm' }), { tools: true }, { knowledgeSetup }), null);
  // 配置里没写 dataTools：不用本机工具目录
  const plain = cfg();
  assert.equal(prepareData(plain, { tools: true }, { knowledgeSetup }), null);
  assert.equal(prepareData(c, { tools: false, knowledge: [] }, { knowledgeSetup }), null);
});

test('网页：列出能选的数据工具和知识来源，选了用不上的直接 400', async (t) => {
  const http = await import('node:http');
  const { createWebApp, startWebServer } = await import('../src/web/server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-storm-data-web-'));
  fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify({ tools: [{ id: 'q', description: 'q', effect: 'read', command: ['node', 'q.js'] }] }));
  const know = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-storm-know-'));
  fs.writeFileSync(path.join(know, 'INDEX.md'), '索引');
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-storm-data-runs-'));
  const c = cfg({ dataTools: { dir }, knowledge: { hotel: { path: know } } });
  const app = createWebApp({ cfg: c, novel: { baseUrl: 'fake' }, runsDir, log: () => {}, echo: false });
  const server = await startWebServer(app, { host: '127.0.0.1', port: 0, log: () => {} });
  t.after(() => server.close());
  const port = server.address().port;
  const request = (method, p, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'content-type': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', (x) => { d += x; });
      res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  const st = await request('GET', '/api/status');
  assert.equal(st.body.data.tools.count, 1);
  assert.deepEqual(st.body.data.knowledge.map((k) => [k.name, k.exists]).sort(), [['hotel', true], ['local', fs.existsSync(c.knowledge.local.path)]].sort());
  const bad = await request('POST', '/api/runs', { mode: 'decision', topic: 'x', repos: '无', data: { tools: true, knowledge: ['nope'] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /知识来源用不上.*nope/);
  const plain = createWebApp({ cfg: cfg(), novel: { baseUrl: 'fake' }, runsDir, log: () => {}, echo: false });
  const server2 = await startWebServer(plain, { host: '127.0.0.1', port: 0, log: () => {} });
  t.after(() => server2.close());
  const r2 = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: server2.address().port, method: 'POST', path: '/api/runs', headers: { 'content-type': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', (x) => { d += x; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.end(JSON.stringify({ mode: 'decision', topic: 'x', repos: '无', data: { tools: true } }));
  });
  assert.equal(r2.status, 400);
  assert.match(r2.body.error, /没有可用的工具/);
});
