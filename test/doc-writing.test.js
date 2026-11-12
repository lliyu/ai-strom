// 主文档的写法：先提炼再展开、标出重点、细节进附录、不写变更记录；主席可以按方向新开文档并写清原因；按新写法重写已有文档。
import { whoOf } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion, runFollowUp, rewriteDocs, latestDocs } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';
import { docPrompt, docUpdatePrompt, docRewritePrompt, docCheckPrompt, parseDoc, docChangelog, docTitle, PRIORITY } from '../src/modes.js';

const GOOD_DOC = (v = 1) => `【说明】\n第 ${v} 版说明\n【主文档】\n# 拆库\n**一句话结论**：拆 v${v}\n## 要点\n- 拆`;
const PLAN = (x) => `**要点**：方案 ${x}\n**改了什么**\n- 改了\n**立场变化**（小幅）\n\n【完整方案】\n完整方案-${x}`;

const cfg = () => normalizeConfig({
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead' },
    { id: 'b', name: 'B', provider: 'fake', part: 'lead' },
    { id: 'r', name: 'R', provider: 'fake', part: 'reviewer' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake' },
  providers: { fake: { type: 'mock' } },
  retryDelayMs: 0,
  rounds: 2,
  followUpMaxRounds: 2,
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
      const out = reply(call);
      if (out != null) return { text: out, usage: { inputTokens: 1, outputTokens: 1 } };
      if (stage === '核对主文档') return { text: '没有问题', usage: { inputTokens: 1, outputTokens: 1 } };
      if (stage.includes('主文档')) return { text: GOOD_DOC(1), usage: { inputTokens: 1, outputTokens: 1 } };
      if (who === 'A' || who === 'B') return { text: PLAN(`${who}${round}`), usage: { inputTokens: 1, outputTokens: 1 } };
      return { text: `发言-${calls.length}`, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { calls, registry: { get: () => provider } };
}

async function discussed() {
  const c = cfg();
  const res = await runDiscussion({ cfg: c, topic: '拆不拆库', providers: scripted().registry, publisher: createMemoryPublisher(), rng: () => 0 });
  return { c, state: res.state };
}

test('写法：三种模式都要求先提炼、不堆碎点、同一件事只写一次、标出重点、细节进附录；结构里没有变更记录', () => {
  for (const mode of ['decision', 'brainstorm', 'refine']) {
    const p = docPrompt({ mode, rounds: [], finals: [] });
    assert.match(p, /先提炼，再展开/);
    assert.match(p, /不要堆碎点/);
    assert.match(p, /同一件事只写一次/);
    assert.match(p, /细节进附录/);
    assert.match(p, /一份文档只讲一件事/);
    assert.match(p, /不要写「变更记录」/);
    assert.doesNotMatch(p, /## 变更记录/);
    assert.match(p, /## 要点（最多 5 条，每条一句完整的话，不嵌套子项/);
    assert.match(p, /【新文档】/);
  }
  assert.match(docPrompt({ mode: 'decision', rounds: [], finals: [] }), new RegExp(`## 要拍板的事[^\\n]*${PRIORITY.first}`));
  assert.match(docPrompt({ mode: 'refine', rounds: [], finals: [] }), new RegExp(`## 要作者拍板的事[^\\n]*${PRIORITY.first}`));
});

test('写法：追问更新不再要求原样保留和加变更记录，要删要并，可以新开文档；核对也看重复和碎点', () => {
  const p = docUpdatePrompt({ mode: 'decision', doc: '# 拆库', version: 2, question: '个人助手呢', handling: 'answer', answer: '要补快问', otherDocs: [{ title: '页面改造', lead: '分三期' }] });
  assert.doesNotMatch(p, /没受影响的部分原样保留/);
  assert.doesNotMatch(p, /「变更记录」加一行/);
  assert.match(p, /不要只往里加/);
  assert.match(p, /有「变更记录」部分，删掉它/);
  assert.match(p, /这场讨论的其他文档[\s\S]*《页面改造》：分三期/);
  const check = docCheckPrompt({ doc: '# 拆库' });
  assert.match(check, /没有提炼出结论、只是堆着碎点/);
  assert.match(check, /补在哪一层/);
  const re = docRewritePrompt({ mode: 'decision', doc: '# 拆库\n## 变更记录\n- v1', version: 3 });
  assert.match(re, /【阶段：重写主文档】/);
  assert.match(re, /不增加新的结论/);
});

test('解析：新开的文档带原因，附录归到前面最近的那份文档；只新开时当前文档为 null', () => {
  const r = parseDoc('【说明】\n拆成两份\n【主文档】\n# 页面改造\n正文\n【附录：字段】\nx\n【新文档】\n原因：个人助手是另一件事\n# 个人助手\n内容\n【附录：快问】\ny\n【新文档】\n**原因**：小说单独讲\n# 小说\nz');
  assert.equal(r.doc, '# 页面改造\n正文');
  assert.deepEqual(r.attachments, { 字段: 'x' });
  assert.deepEqual(r.newDocs.map((d) => [d.title, d.reason, d.doc, d.attachments]), [
    ['个人助手', '个人助手是另一件事', '# 个人助手\n内容', { 快问: 'y' }],
    ['小说', '小说单独讲', '# 小说\nz', {}],
  ]);
  const only = parseDoc('【说明】\n新开\n【新文档】\n原因：另一件事\n# 另一件事\n内容');
  assert.equal(only.doc, null);
  assert.equal(only.newDocs.length, 1);
  assert.throws(() => parseDoc('【新文档】\n原因：x\n'), /新文档是空的/);
  // 旧格式照常
  assert.deepEqual(parseDoc('# 只有正文').newDocs, []);
  assert.equal(docTitle('**一句话**\n# 标题 **加粗**'), '标题 加粗');
});

test('变更记录：程序按同一份文档的各版生成，新开的文档写明从哪份分出、原因', () => {
  const docs = [
    { version: 1, at: '2026-11-12T01:00:00Z', reason: '讨论结束', note: '**一句话结论**：拆\n- 先拆订单' },
    { version: 2, docNo: 1, at: '2026-11-12T02:00:00Z', reason: '追问：排期', note: '排期改到下周' },
    { version: 3, docNo: 2, at: '2026-11-12T02:00:00Z', reason: '追问：排期', note: '说明', opened: { reason: '是另一件事', from: '拆库' } },
  ];
  assert.equal(docChangelog(docs, 2), '- 第 1 版（讨论结束，2026-11-12）：一句话结论：拆；先拆订单\n- 第 2 版（追问：排期，2026-11-12）：排期改到下周');
  assert.equal(docChangelog(docs, 1), '- 第 1 版（讨论结束，2026-11-12）：一句话结论：拆；先拆订单');
  assert.equal(docChangelog(docs, 3), '- 第 3 版（追问：排期，2026-11-12）：新开文档（从《拆库》分出），原因：是另一件事。说明');
  assert.equal(docChangelog(docs, 9), '');
  // 长说明压成一行、截到 100 字
  const long = docChangelog([{ version: 1, reason: '讨论结束', note: `${'很长'.repeat(80)}\n- 第二行` }], 1);
  assert.equal(long, `- 第 1 版（讨论结束）：${'很长'.repeat(50)}…`);
});

test('写法：一句话结论只写一句，不分行、不列点', () => {
  for (const mode of ['decision', 'brainstorm', 'refine']) assert.match(docPrompt({ mode, rounds: [], finals: [] }), /\*\*一句话结论\*\*：[^\n]*只写一句话，不分行、不列点/);
});

test('追问时主席新开文档：记下原因和来源，当前文档不改；下一次追问改新文档，提示词里列出其他文档', async () => {
  const { c, state } = await discussed();
  assert.equal(state.docs[0].title, '拆库');
  assert.equal(state.docs[0].docNo, 1);
  const split = '【说明】\n个人助手另开一份\n【新文档】\n原因：个人助手和拆库是两件事，读者不同\n# 个人助手\n**一句话结论**：先做快问\n## 要点\n- 快问\n【附录：快问约定】\n三次调用';
  const one = scripted((x) => (x.stage === '追问判断' ? '处理方式：直接回答\n要做快问' : x.stage === '更新主文档' ? split : null));
  const r1 = await runFollowUp({ cfg: c, state, question: '做成个人助手还缺什么', providers: one.registry, publisher: createMemoryPublisher() });
  const docs = r1.state.docs;
  assert.equal(docs.length, 2);
  const nd = docs[1];
  assert.equal(nd.version, 2);
  assert.equal(nd.docNo, 2);
  assert.equal(nd.title, '个人助手');
  assert.deepEqual(nd.opened, { reason: '个人助手和拆库是两件事，读者不同', from: '拆库' });
  assert.deepEqual(nd.attachments, { 快问约定: '三次调用' });
  assert.equal(nd.note, '个人助手另开一份'); // 只新开时主席的说明记在新文档上
  assert.equal(r1.state.followUps.at(-1).doc, 2);
  assert.deepEqual(latestDocs(docs).map((d) => d.title), ['拆库', '个人助手']);

  // 下一次追问：当前文档是最近写的那份（个人助手），提示词里列出另一份
  const two = scripted((x) => (x.stage === '追问判断' ? '处理方式：直接回答\n快问三次' : x.stage === '更新主文档' ? '【说明】\n改了\n【主文档】\n# 个人助手\n**一句话结论**：快问三次调用' : null));
  const r2 = await runFollowUp({ cfg: c, state: r1.state, question: '快问几次调用', providers: two.registry, publisher: createMemoryPublisher() });
  const update = two.calls.find((x) => x.stage === '更新主文档');
  assert.match(update.prompt, /现在的主文档（第 2 版）\n# 个人助手/);
  assert.match(update.prompt, /这场讨论的其他文档[\s\S]*《拆库》：拆 v1/);
  const last = r2.state.docs.at(-1);
  assert.deepEqual([last.version, last.docNo, last.opened], [3, 2, undefined]);
  // 附录沿用上一版
  assert.deepEqual(last.attachments, { 快问约定: '三次调用' });
});

test('讨论结束时主席就把独立方向拆开：主文档和新文档都写进状态，主笔核对时看到两份', async () => {
  const both = '【说明】\n两件事\n【主文档】\n# 拆库\n**一句话结论**：拆\n【新文档】\n原因：监控是独立的事\n# 监控\n**一句话结论**：加告警';
  const s = scripted((x) => (x.stage === '主文档' ? both : null));
  const res = await runDiscussion({ cfg: cfg(), topic: '拆不拆库', providers: s.registry, publisher: createMemoryPublisher(), rng: () => 0 });
  assert.deepEqual(res.state.docs.map((d) => [d.version, d.docNo, d.title]), [[1, 1, '拆库'], [2, 2, '监控']]);
  assert.equal(res.state.docs[1].opened.from, '拆库');
  assert.equal(res.doc.title, '拆库');
  assert.equal(res.state.summary, res.state.docs[0].text);
  assert.match(s.calls.find((x) => x.stage === '核对主文档').prompt, /新开的文档《监控》，原因：监控是独立的事/);
});

test('重写：各份文档的最新一版按新写法重写成新的一版，主笔核对；没有主文档时报错', async () => {
  const { c, state } = await discussed();
  const s = scripted((x) => (x.stage === '重写主文档' ? '【说明】\n按新写法整理\n【主文档】\n# 拆库\n**一句话结论**：拆（重写）\n【附录：细节】\n坐标' : null));
  const res = await rewriteDocs({ cfg: c, state, providers: s.registry, publisher: createMemoryPublisher() });
  assert.equal(res.docs.length, 1);
  const [d] = res.docs;
  assert.deepEqual([d.version, d.docNo, d.reason], [2, 1, '按新写法重写']);
  assert.match(d.text, /拆（重写）/);
  assert.deepEqual(d.attachments, { 细节: '坐标' });
  assert.equal(res.state.docs.length, 2);
  assert.match(s.calls.find((x) => x.stage === '重写主文档').prompt, /现在的主文档（第 1 版）/);
  assert.equal(s.calls.filter((x) => x.stage === '核对主文档').length, 2);
  await assert.rejects(rewriteDocs({ cfg: c, state: { ...state, docs: [] }, providers: s.registry, publisher: createMemoryPublisher() }), /还没有主文档/);
});
