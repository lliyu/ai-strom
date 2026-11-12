import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { normalizeConfig } from '../src/config.js';
import { isBlockerLine, hasBlocker } from '../src/modes.js';
import { groupKeys, critiqueDigest, blockerLinesOf, blockerSummary, docSections, splitH2, oneLinerOf } from '../src/web/digest.js';
import { createWebApp, startWebServer } from '../src/web/server.js';
import { openStore } from '../src/db.js';

// ---------- isBlockerLine ----------

test('isBlockerLine：只认行首的【阻断】，否定句和顺带提到的不算（hasBlocker 会误判）', () => {
  const no = [
    '本轮没有新的【阻断】',
    '- 本轮没有【阻断】；只有 2 条【建议】。',
    '- 三个方案都没有【阻断】级问题，依赖关系均支持落地。',
    '0 条【阻断】级问题。',
    '- 【建议】靠提示词要求每条【阻断】都配一条待核实 → 模型可能漏写',
    '- 上一轮列出的阻断问题，两个方案都已解决；本轮没有新的【阻断】，只剩 2 条【建议】。',
    '- 3 条【阻断】：方案 A 两条，方案 B 一条。',
    '',
  ];
  for (const l of no) assert.equal(isBlockerLine(l), false, l);
  for (const l of no.slice(0, 5)) assert.equal(hasBlocker(l), true, `旧函数会误判：${l}`);
  const yes = [
    '- 【阻断】第一档只以 main 和 test 零引用为删除判据…',
    '【阻断】回滚预案依赖不存在的重算入口',
    '  * **【阻断】** 删除类会导致 test 编译失败',
    '1. 【阻断】入口根集不全',
    '**【阻断】按轮分组遗漏无 round 卡片**',
    '- [阻断] 半角括号也认',
  ];
  for (const l of yes) assert.equal(isBlockerLine(l), true, l);
});

test('评审派生字段：结论、阻断行（要点和正文去重）、blocked；失败卡片不算', () => {
  const d = critiqueDigest({
    brief: '- 共 1 条【阻断】，在方案 A。\n- 【阻断】回滚依赖不存在的入口',
    body: '**方案 A**\n- **【阻断】回滚依赖不存在的入口**\n- 【建议】补监控\n\n评审结论：继续讨论',
  });
  assert.equal(d.verdict, 'continue');
  assert.deepEqual(d.blockerLines, ['- 【阻断】回滚依赖不存在的入口']);
  assert.equal(d.blocked, true);
  // 写了「没有意见了」：即使正文里还留着行首阻断，也不算仍提阻断
  assert.equal(critiqueDigest({ brief: '无', body: '- 【阻断】旧问题\n评审结论：没有意见了' }).blocked, false);
  // 解析不出结论：verdict 为 null（未识别），不当成没有意见
  const unknown = critiqueDigest({ brief: '- 本轮没有【阻断】', body: '只剩建议' });
  assert.deepEqual([unknown.verdict, unknown.blocked, unknown.blockerLines], [null, false, []]);
  assert.deepEqual(critiqueDigest({ brief: '- 【阻断】x', body: '', error: '超时' }), { verdict: null, blockerLines: [], blocked: false });
  assert.deepEqual(blockerLinesOf('- 【阻断】a\n- 【阻断】b', '1. **【阻断】a**'), ['- 【阻断】a', '- 【阻断】b']);
});

// ---------- 分组 ----------

const P = (part, stage, round, extra = {}) => ({ part, stage, ...(round === undefined ? {} : { round }), ...extra });

test('分组：背景 / 第 N 轮 / 收尾；插话继承上一条的组；开场、结束卡不进组；追问重新分组；不丢不改顺序', () => {
  const posts = [
    P(0, null), // 开场
    P(0, 'research', 0),
    P(0, 'dataplan', 0),
    P(0, 'propose', 1),
    P(0, 'propose', 1),
    P(0, 'interjection'), // 插话：继承第 1 轮
    P(0, 'factcheck', 2),
    P(0, 'critique', 2),
    P(0, 'review', 2),
    P(0, 'doccheck', 3), // 收尾卡的 round 是最后一轮加 1
    P(0, 'doc', 3),
    P(0, null), // 结束
    P(1, null), // 追问开场
    P(1, 'interjection'), // part 内第一条、没有轮次：归背景
    P(1, 'triage', 2),
    P(1, 'followup', 3),
    P(1, 'critique', 4),
    P(1, 'verify', 4),
    P(1, null),
  ];
  const g = groupKeys(posts);
  assert.equal(g.length, posts.length);
  assert.deepEqual(g.map((x) => x.groupKey), [
    null, '0:bg', '0:bg', '0:r1', '0:r1', '0:r1', '0:r2', '0:r2', '0:r2', '0:end', '0:end', null,
    null, '1:bg', '1:bg', '1:r3', '1:r4', '1:end', null,
  ]);
  assert.equal(g[3].groupLabel, '第 1 轮');
  assert.equal(g[9].groupLabel, '收尾');
  assert.equal(g[14].groupLabel, '追问判断与背景');
});

// ---------- 主文档切段 ----------

const DOC = `# 拆库方案

**一句话结论**：先不拆，
- 先做读写分离

## 要点
- 先不拆

## 要拍板的事
开头一句。
### 尚未统一的执行细节
- 批次大小
### 需要业务或负责人拍板
- 【先定】是否接受停写 5 分钟

## 问题
\`\`\`
## 这不是标题
\`\`\`

## 风险与未核实的前提
- 容量估算未核实

## 下一步
1. 压测
`;

test('主文档切段：按 ## 切、跳过代码块；一句话结论取到第一个 ## 之前；拍板子段排前面', () => {
  const s = docSections(DOC, 'decision');
  assert.equal(s.failed, false);
  assert.equal(s.oneLiner, '先不拆，\n- 先做读写分离');
  assert.equal(s.points.text, '- 先不拆');
  assert.equal(s.next.text, '1. 压测');
  assert.equal(s.risks.text, '- 容量估算未核实');
  assert.equal(s.decisions.lead, '开头一句。');
  assert.deepEqual(s.decisions.parts.map((p) => [p.title, p.pick]), [['需要业务或负责人拍板', true], ['尚未统一的执行细节', false]]);
  assert.deepEqual(splitH2(DOC).sections.map((x) => x.title), ['要点', '要拍板的事', '问题', '风险与未核实的前提', '下一步']);
});

test('主文档切段：旧结构「分歧与需要拍板的问题」也认；缺必需的段就不切（宁可不提取，也不提取错）', () => {
  const old = '# t\n**一句话结论**：x\n## 要点\n- a\n## 分歧与需要拍板的问题\n无\n## 下一步\n- b\n';
  const s = docSections(old, 'decision');
  assert.equal(s.failed, false);
  assert.equal(s.decisions.title, '分歧与需要拍板的问题');
  assert.equal(s.risks, null); // 风险不是必需的
  const bad = docSections('# t\n## 要点\n- a\n## 结论与下一步\n- b\n', 'decision');
  assert.equal(bad.failed, true);
  assert.deepEqual(bad.missing, ['decisions', 'next']);
  assert.equal(docSections(old, 'quick').failed, true, '没登记大纲的模式不切');
  assert.equal(oneLinerOf('# t\n没有一句话结论'), null);
});

// ---------- 阻断区块 ----------

const C = (part, tag, round, digest, extra = {}) => ({ part, stage: 'critique', tag, round, speaker: { id: tag, name: tag }, ...digest, ...extra });
const BLOCK = (line) => ({ verdict: 'continue', blockerLines: [line], blocked: true });
const DONE = { verdict: 'done', blockerLines: [], blocked: false };

test('阻断区块：只看最后一次含评审的运行；每位评审取最近一次；失败卡片不算；后来没再提的单独标出', () => {
  const posts = [
    C(0, '评审 1', 2, BLOCK('- 【阻断】原讨论的旧阻断')),
    C(1, '评审 1', 5, BLOCK('- 【阻断】回滚没有数据预案')),
    C(1, '评审 2', 5, BLOCK('- 【阻断】接口不兼容')),
    C(1, '评审 1', 6, BLOCK('- 【阻断】回滚没有数据预案')),
    C(1, '评审 1', 7, { verdict: null, blockerLines: [], blocked: false }, { error: '超时' }), // 失败卡片：前一次的阻断仍然列出
    C(1, '评审 2', 6, DONE),
    C(1, '评审 3', 6, { verdict: null, blockerLines: [], blocked: false }),
  ];
  const s = blockerSummary(posts);
  assert.deepEqual([s.part, s.source, s.reviewers, s.blocking, s.unknown], [1, '追问 1', 3, 1, 1]);
  const [r1, r2, r3] = s.rows;
  assert.deepEqual([r1.tag, r1.round, r1.lines], ['评审 1', 6, ['- 【阻断】回滚没有数据预案']]);
  assert.deepEqual([r2.dropped.round, r2.dropped.lines], [5, ['- 【阻断】接口不兼容']]);
  assert.deepEqual(r1.items.map((it) => [it.level, it.head]), [['阻断', '回滚没有数据预案']], '阻断行同时解析成条目');
  assert.equal(r3.verdict, null);
  assert.equal(blockerSummary([{ part: 0, stage: 'review' }]), null);
});

// ---------- 接口：排序、派生字段、结束原因 ----------

const cfg = normalizeConfig({
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead' },
    { id: 'r1', name: 'R1', provider: 'fake', part: 'reviewer' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake' },
  providers: { fake: { type: 'mock' } },
  rounds: 2,
});

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => resolve(JSON.parse(raw)));
    }).on('error', reject);
  });
}

async function serve(t) {
  const store = openStore(':memory:');
  const logs = [];
  const app = createWebApp({ cfg, novel: { baseUrl: 'fake' }, store, log: (m) => logs.push(m), echo: false });
  const server = await startWebServer(app, { host: '127.0.0.1', port: 0, log: () => {} });
  t.after(() => server.close());
  return { store, logs, port: server.address().port };
}

test('接口：运行按开始时间排（补导的追问 id 在最后也不错位），插话和进度看时间上最新的那次运行', async (t) => {
  const { store, port } = await serve(t);
  store.db.prepare('INSERT INTO discussions (number, mode, topic, channel, created_at) VALUES (?, ?, ?, ?, ?)').run(10, 'decision', '页面', 'web', '2026-11-12T02:00:00Z');
  const main = store.startExecution({ number: 10, kind: 'discussion', startedAt: '2026-11-12T02:00:00Z' });
  const late = store.startExecution({ number: 10, kind: 'followup', startedAt: '2026-11-12T05:00:00Z' }); // 时间最晚，先导入
  const early = store.startExecution({ number: 10, kind: 'followup', startedAt: '2026-11-12T03:00:00Z' }); // 补导的：id 最大，时间在中间
  store.addEvent(main, { type: 'run_finished', ending: 'converged' });
  store.addEvent(early, { type: 'run_finished', ending: 'converged', handling: 'discuss' });
  store.addEvent(late, { type: 'run_started', pid: process.pid });
  store.saveState({ version: 1, number: 10, topic: '页面', mode: 'decision', sessions: {}, ending: { reason: 'converged', round: 7 }, facts: [{ questions: ['a', 'b'] }, { questions: ['c'] }] });
  store.addPost(late, { speaker: { id: 'a' }, title: '第二次追问', meta: { stage: 'followup', round: 12 } });
  store.addPost(early, { speaker: { id: 'a' }, title: '第一次追问', meta: { stage: 'followup', round: 8 } });
  store.addPost(main, { speaker: { id: 'a' }, title: '讨论', meta: { stage: 'propose', round: 1, tag: '方案 A' } });

  assert.deepEqual(store.executionsOf(10).map((e) => e.id), [main, early, late]);
  const d = await get(port, '/api/runs/10');
  assert.deepEqual(d.posts.map((p) => [p.part, p.title, p.seq]), [[0, '讨论', 1], [1, '第一次追问', 2], [2, '第二次追问', 3]]);
  assert.deepEqual([d.posts[0].round, d.posts[0].tag, d.posts[0].groupKey], [1, '方案 A', '0:r1']);
  assert.equal(d.progress.status, 'running'); // 看的是时间上最新的那次（还在跑）
  // 最新一次追问还没结束：结束原因取前一次，另外提示追问进行中
  assert.deepEqual(d.outcome, { ending: 'converged', round: null, handling: 'discuss', followUpStatus: 'running', facts: 3 });
});

test('接口：结束原因取最近一次结束的运行；追问失败时提示未完成；都没有时退回讨论状态', async (t) => {
  const { store, port } = await serve(t);
  store.db.prepare('INSERT INTO discussions (number, mode, topic, channel, created_at) VALUES (?, ?, ?, ?, ?)').run(4, 'decision', 't', 'web', '2026-11-12T02:00:00Z');
  const main = store.startExecution({ number: 4, kind: 'discussion', startedAt: '2026-11-12T02:00:00Z' });
  store.addEvent(main, { type: 'run_finished', ending: 'deadlock' });
  const f1 = store.startExecution({ number: 4, kind: 'followup', startedAt: '2026-11-12T03:00:00Z' });
  store.addEvent(f1, { type: 'run_finished', ending: 'answered', handling: 'answer' });
  const f2 = store.startExecution({ number: 4, kind: 'followup', startedAt: '2026-11-12T04:00:00Z' });
  store.addEvent(f2, { type: 'run_failed', error: 'boom' });
  store.saveState({ version: 1, number: 4, topic: 't', mode: 'decision', sessions: {}, ending: { reason: 'deadlock', round: 5 } });
  const d = await get(port, '/api/runs/4');
  assert.deepEqual([d.outcome.ending, d.outcome.handling, d.outcome.followUpStatus], ['answered', 'answer', 'failed']);

  store.db.prepare('INSERT INTO discussions (number, mode, topic, channel, created_at) VALUES (?, ?, ?, ?, ?)').run(5, 'decision', 't', 'web', '2026-11-12T02:00:00Z');
  store.startExecution({ number: 5, kind: 'discussion', startedAt: '2026-11-12T02:00:00Z', status: 'done' });
  store.saveState({ version: 1, number: 5, topic: 't', mode: 'decision', sessions: {}, ending: { reason: 'max', round: 8 } });
  const old = await get(port, '/api/runs/5');
  assert.deepEqual([old.outcome.ending, old.outcome.round, old.outcome.facts], ['max', 8, null]);
});

test('接口：评审发言带派生字段；阻断区块在裁决类追问之后改为「裁决前」；主文档每份切段，切不开记日志', async (t) => {
  const { store, port, logs } = await serve(t);
  store.db.prepare('INSERT INTO discussions (number, mode, topic, channel, created_at) VALUES (?, ?, ?, ?, ?)').run(6, 'decision', 't', 'web', '2026-11-12T02:00:00Z');
  const main = store.startExecution({ number: 6, kind: 'discussion', startedAt: '2026-11-12T02:00:00Z' });
  store.addPost(main, { speaker: { id: 'r1' }, title: 'R1', brief: '- 本轮没有【阻断】', body: '- 【阻断】接口不兼容\n评审结论：继续讨论', meta: { stage: 'critique', round: 2, tag: '评审 1' } });
  store.addEvent(main, { type: 'run_finished', ending: 'deadlock' });
  const f = store.startExecution({ number: 6, kind: 'followup', startedAt: '2026-11-12T03:00:00Z' });
  store.addEvent(f, { type: 'run_finished', ending: 'verdict', handling: 'verdict' });
  store.saveState({ version: 1, number: 6, topic: 't', mode: 'decision', sessions: {}, docs: [
    { version: 1, text: DOC },
    { version: 2, docNo: 2, text: '# 另一件事\n## 要点\n- a\n' },
  ] });
  const d = await get(port, '/api/runs/6');
  const c = d.posts[0];
  assert.deepEqual([c.verdict, c.blocked, c.blockerLines], ['continue', true, ['- 【阻断】接口不兼容']]);
  assert.deepEqual([d.blockers.blocking, d.blockers.beforeVerdict, d.blockers.source], [1, true, '原讨论']);
  assert.deepEqual(d.docSections.map((s) => [s.docNo, s.version, s.failed]), [[1, 1, false], [2, 2, true]]);
  assert.equal(d.docSections[0].oneLiner, '先不拆，\n- 先做读写分离');
  assert.equal(logs.filter((m) => /未能提取/.test(m)).length, 1);
  await get(port, '/api/runs/6');
  assert.equal(logs.filter((m) => /未能提取/.test(m)).length, 1, '同一版只记一次');
  assert.equal(logs.filter((m) => /未识别/.test(m)).length, 0, '评审结论都解析出来了，不记');
  // 再来一条解析不出结论的评审：记一次「未识别」，数字没变就不重复记
  store.addPost(main, { speaker: { id: 'r1' }, title: 'R1', brief: '- 只剩建议', body: '没写结论', meta: { stage: 'critique', round: 3, tag: '评审 1' } });
  await get(port, '/api/runs/6');
  await get(port, '/api/runs/6');
  assert.deepEqual(logs.filter((m) => /未识别/.test(m)), ['网页：#6 有 1/2 条评审发言解析不出评审结论，页面标「未识别」']);
});
