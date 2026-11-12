// 页面第二期：条目化发言。条目解析（新旧格式）、依据不计字数、写入时检查与重写保护、按场开关、页面派生字段。
import { whoOf } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { normalizeConfig } from '../src/config.js';
import { runDiscussion } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';
import { createWebApp, startWebServer } from '../src/web/server.js';
import { openStore } from '../src/db.js';
import {
  parseItems, parseItemLine, stripEvidence, charCount, replyIssues, rewriteDrift, limitsFor,
  critiquePrompt, reviewPrompt, docCheckPrompt, quickChallengePrompt, factCheckPrompt,
} from '../src/modes.js';
import { itemDigest, briefBlockerCount } from '../src/web/digest.js';

// #8 第 3 轮评审 2 的原文（旧的箭头格式，带全角括号）
const OLD_CRITIQUE = `**方案 A**
- 【阻断】VERIFY 已证实功能性断裂：main 里没有写入 verifyStatus 的代码，VerifyFallback 读到 null 后跳过，接口始终返回 200、status=null；方案 A 给的「接回 TokenEncoder 或整链下线」二选一，其判据（调用量、出参比对）在现状下都恒为 200，判不出差异 → 后果：删除或保留都没有依据，而且这是线上缺陷，并非清理项 → 从清理清单移出，单独开缺陷单，先确认调用方是否读取 status，修复或废弃定论后再动。
- 【建议】确定性出参比对清单包含 verify，而它恒返回相同结果 → 比对会给出假通过 → 改为对 status 的断言，或等缺陷修复后再纳入。

**方案 B**
- 【阻断】第三档「先查 /verify 流量，判明是缺陷还是废弃」判不出来 → 后果：第三档永久无法推进 → 改为按代码事实先定为缺陷。

对评审 1：无不同意项，不重复。

评审结论：继续讨论`;

const NEW_CRITIQUE = `**要点**：方案 A 还有 1 条阻断，扣减会超扣
**方案 A**
- 【阻断】并发扣减会超扣 ｜改法：扣减时加行锁 ｜依据：price-center:src/main/java/Budget.java:88（见 deduct()，未加锁（含重试）） ｜影响：活动亏钱
- 【建议】补超扣告警 ｜改法：扣减后比对余额
- 本轮没有新的【阻断】级问题要补充
**方案 B**
无新问题
\`\`\`
- 【阻断】代码块里的不算
\`\`\`
评审结论：继续讨论`;

test('条目解析：新格式按「｜标签：」切段；记下所在小节；否定句、代码块里的不算', () => {
  const items = parseItems(NEW_CRITIQUE);
  assert.deepEqual(items.map((it) => [it.section, it.level, it.head]), [['方案 A', '阻断', '并发扣减会超扣'], ['方案 A', '建议', '补超扣告警']]);
  const [a, b] = items;
  assert.equal(a.fix, '扣减时加行锁');
  assert.equal(a.evidence, 'price-center:src/main/java/Budget.java:88（见 deduct()，未加锁（含重试））');
  assert.equal(a.evidenceKind, 'code');
  assert.equal(a.impact, '活动亏钱');
  assert.deepEqual([b.fix, b.evidence, b.impact, b.legacy], ['扣减后比对余额', null, null, false]);
});

test('条目解析：旧的箭头格式按位置拆出问题、后果和改法；修订的「原来 → 现在」不拆', () => {
  const items = parseItems(OLD_CRITIQUE);
  assert.equal(items.length, 3);
  assert.ok(items.every((it) => it.legacy));
  assert.match(items[0].head, /^VERIFY 已证实功能性断裂.*（调用量、出参比对）在现状下都恒为 200，判不出差异$/);
  assert.equal(items[0].impact, '删除或保留都没有依据，而且这是线上缺陷，并非清理项');
  assert.match(items[0].fix, /^从清理清单移出/);
  assert.deepEqual([items[2].section, items[2].impact], ['方案 B', '第三档永久无法推进']);
  const rev = parseItemLine('- 【改】全量迁 → 按商户迁 ｜依据：第 2 轮核实第 1 条');
  assert.deepEqual([rev.head, rev.evidenceKind, rev.legacy], ['全量迁 → 按商户迁', 'verify', false]);
  // 其他阶段的级别
  assert.deepEqual(parseItemLine('2. 【推翻】【已更正】超时是 3 秒不是 5 秒 ｜依据：pc:src/a.js:12'), {
    level: '推翻', head: '超时是 3 秒不是 5 秒', fix: null, evidence: 'pc:src/a.js:12', impact: null, legacy: false, corrected: true, evidenceKind: 'code',
  });
  assert.equal(parseItemLine('- 【漏】没写回滚 ｜改法：补进风险').level, '漏');
  assert.equal(parseItemLine('- 【不采纳】评审 2 的「要分库」 ｜依据：推断').evidenceKind, 'guess');
  assert.equal(parseItemLine('- 【先定】要不要做'), null, '主文档的优先级标记不是条目');
  assert.equal(parseItemLine('- 本轮没有【阻断】'), null);
});

test('依据不计字数：只剔除「｜依据：」到下一个「｜」，后面的影响照算；括号里的竖线以外都不误剔', () => {
  const line = '- 【阻断】问题 ｜改法：加锁 ｜依据：pc:src/a.js:1（嵌套（括号）） ｜影响：亏钱';
  assert.equal(stripEvidence(line), '- 【阻断】问题 ｜改法：加锁 ｜影响：亏钱');
  assert.equal(stripEvidence('- 【阻断】问题 ｜依据：推断'), '- 【阻断】问题 ');
  // 旧格式没有依据段：一个字都不剔
  assert.equal(stripEvidence(OLD_CRITIQUE), OLD_CRITIQUE);
  assert.ok(charCount(stripEvidence(NEW_CRITIQUE)) < charCount(NEW_CRITIQUE));
});

test('写入时检查：缺结论行、阻断缺改法或依据、主笔缺立场变化、超字数（依据不计）', () => {
  const limit = { max: 700, brief: 150, tolerance: 1.25 };
  assert.deepEqual(replyIssues(NEW_CRITIQUE, { limit, verdict: true, blockers: true }), []);
  const bad = replyIssues('**要点**：1 条阻断\n**方案 A**\n- 【阻断】会超扣 ｜影响：亏钱', { limit, verdict: true, blockers: true });
  assert.deepEqual(bad.map((x) => x.kind), ['verdict', 'blocker']);
  assert.match(bad[1].note, /「会超扣」缺改法和依据/);
  assert.deepEqual(replyIssues('**要点**：改了\n**改了什么**\n- 【改】a → b', { stance: true }).map((x) => x.kind), ['stance']);
  // #19 的真实写法：立场写在下一行的列表项里，不算缺
  assert.deepEqual(replyIssues('**要点**：改了\n**立场变化**\n- 小幅：核心设计不变', { stance: true }), []);
  // 依据很长也不算超字数；正文超了才算
  const longEvidence = `**要点**：1 条\n**方案 A**\n- 【阻断】问题 ｜改法：改 ｜依据：${'资料'.repeat(500)}\n评审结论：继续讨论`;
  assert.deepEqual(replyIssues(longEvidence, { limit, verdict: true, blockers: true }), []);
  const longBody = `**要点**：1 条\n**方案 A**\n- 【阻断】${'问题'.repeat(500)} ｜改法：改 ｜依据：推断\n评审结论：继续讨论`;
  assert.deepEqual(replyIssues(longBody, { limit, verdict: true, blockers: true }).map((x) => x.kind), ['over']);
});

test('重写保护：评审结论变了、或行首阻断变少了，用原文', () => {
  const before = '**要点**：1 条\n**方案 A**\n- 【阻断】会超扣 ｜影响：亏钱\n评审结论：继续讨论';
  assert.equal(rewriteDrift(before, '**要点**：1 条\n**方案 A**\n- 【阻断】会超扣 ｜改法：加锁 ｜依据：推断\n评审结论：继续讨论'), null);
  assert.match(rewriteDrift(before, '**要点**：1 条\n**方案 A**\n- 【阻断】会超扣 ｜改法：加锁 ｜依据：推断\n评审结论：没有意见了'), /评审结论/);
  assert.match(rewriteDrift(before, '**要点**：没有了\n**方案 A**\n- 【建议】会超扣 ｜改法：加锁\n评审结论：继续讨论'), /从 1 条变成 0 条/);
});

test('提示词：开关关着时和原来一样；打开后各阶段写条目格式', () => {
  const proposals = [{ label: 'A', tag: '方案 A', text: 'x' }];
  const off = critiquePrompt({ round: 2, proposals, askVerdict: true, mode: 'decision' });
  assert.match(off, /「【阻断】问题 → 后果 → 怎么改」/);
  assert.doesNotMatch(off, /｜改法/);
  const on = critiquePrompt({ round: 2, proposals, askVerdict: true, mode: 'decision', items: true });
  assert.match(on, /「- 【级别】问题 ｜改法：… ｜依据：… ｜影响：…」/);
  assert.match(on, /【阻断】必须写改法和依据/);
  assert.match(on, /要点里只用文字说，不写【阻断】【建议】/);
  assert.match(on, /单独一行加粗的方案代号/);
  assert.match(on, /依据不计入字数上限/);
  const rv = reviewPrompt({ round: 2, own: { text: 'x' }, others: [], critiques: [{ tag: '评审 1', text: 'y' }], mode: 'decision', items: true });
  assert.match(rv, /- 【改】原来… → 现在… ｜依据：…/);
  assert.match(rv, /- 【不采纳】评审 N 的「…」 ｜依据：…/);
  assert.match(docCheckPrompt({ doc: 'd', items: true }), /【漏 \/ 错 \/ 不清】问题 ｜改法/);
  assert.match(quickChallengePrompt({ answer: 'a', items: true }), /然后单独一行「\*\*问题\*\*」/);
  assert.match(factCheckPrompt({ round: 2, questions: ['q'], repos: [], items: true }), /【确认】结论 ｜依据：仓库别名/);
});

test('页面派生：条目、正文阻断数、解析是否成功、要点与条目不一致', () => {
  const d = itemDigest({ stage: 'critique', brief: '方案 A 还有 2 条阻断', body: NEW_CRITIQUE.split('\n').slice(1).join('\n') });
  assert.equal(d.items.length, 2);
  assert.equal(d.bodyBlockers, 1);
  assert.equal(d.itemsOk, true);
  assert.deepEqual(d.itemsMismatch, { brief: 2, body: 1 });
  assert.deepEqual(itemDigest({ stage: 'review', brief: 'x', body: '**改了什么**\n无变化\n**立场变化**：无' }), { items: [], bodyBlockers: 0, itemsOk: true });
  assert.equal(itemDigest({ stage: 'review', brief: 'x', body: '改了一些东西' }).itemsOk, false);
  assert.deepEqual(itemDigest({ stage: 'propose', body: '- 【阻断】x' }), {}, '方案不写条目');
  assert.deepEqual(itemDigest({ stage: 'critique', error: '超时' }), {});
  assert.deepEqual(['1 条阻断', '阻断 2 条，另有一条建议', '方案 A 一条阻断、方案 B 两个阻断', '没有阻断了', '只剩建议'].map(briefBlockerCount), [1, 2, 3, 0, null]);
});

// ---------- 流程：写入时检查与重写 ----------

const base = {
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead' },
    { id: 'r1', name: 'R1', provider: 'fake', part: 'reviewer' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake' },
  providers: { fake: { type: 'mock' } },
  rounds: 2,
};

function scripted(reply) {
  const calls = [];
  const provider = {
    async complete(opts) {
      const { prompt } = opts;
      const who = whoOf(opts);
      const stageText = /【阶段：([^】]+)】/.exec(prompt)?.[1] ?? (/【补全重写】/.test(prompt) ? '补全重写' : /【压缩重写】/.test(prompt) ? '压缩重写' : '');
      const call = { who, stageText, prompt, n: calls.filter((c) => c.who === who).length };
      calls.push(call);
      return { text: reply(call) ?? `发言-${calls.length}`, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { calls, registry: { get: () => provider } };
}

const MISSING = '**要点**：1 条阻断\n**方案 A**\n- 【阻断】会超扣 ｜影响：亏钱\n评审结论：继续讨论';
const FIXED = '**要点**：1 条阻断\n**方案 A**\n- 【阻断】会超扣 ｜改法：加锁 ｜依据：推断 ｜影响：亏钱\n评审结论：继续讨论';
const DRIFTED = '**要点**：没有阻断\n**方案 A**\n- 【建议】会超扣 ｜改法：加锁\n评审结论：没有意见了';

async function runWith(rewrite, { items = true } = {}) {
  const { calls, registry } = scripted((c) => {
    if (c.stageText === '补全重写') return rewrite;
    if (/评审意见/.test(c.stageText)) return MISSING;
    if (/互评与修订/.test(c.stageText)) return '**要点**：采纳\n**改了什么**\n- 【改】不加锁 → 加锁 ｜依据：推断\n**立场变化**：小幅\n\n【完整方案】\n方案';
    return null;
  });
  const events = [];
  const pub = createMemoryPublisher();
  await runDiscussion({ cfg: normalizeConfig({ ...base, items }), topic: '议题', providers: registry, publisher: pub, onEvent: (e) => events.push(e) });
  return { calls, events, pub };
}

test('写入时检查：阻断缺依据时合并重写一次，用重写稿；记下 reply_check 事件', async () => {
  const { calls, events, pub } = await runWith(FIXED);
  assert.equal(calls.filter((c) => c.stageText === '补全重写').length, 1);
  const fix = calls.find((c) => c.stageText === '补全重写');
  assert.match(fix.prompt, /「会超扣」缺改法和依据/);
  assert.match(fix.prompt, /只补缺项或压缩，内容和立场不变/);
  const checks = events.filter((e) => e.type === 'reply_check');
  assert.deepEqual(checks.map((e) => [e.stage, e.result]), [['critique', 'rewritten'], ['review', 'ok']]);
  const card = pub.posts.find((p) => p.meta?.stage === 'critique');
  assert.match(card.body, /｜改法：加锁 ｜依据：推断/);
});

test('重写保护：重写后结论变了、阻断变少了，发布第一次的原文', async () => {
  const { events, pub } = await runWith(DRIFTED);
  const check = events.find((e) => e.type === 'reply_check' && e.stage === 'critique');
  assert.equal(check.result, 'kept-original');
  assert.match(check.drift, /评审结论/);
  assert.match(pub.posts.find((p) => p.meta?.stage === 'critique').body, /【阻断】会超扣 ｜影响：亏钱/);
});

test('开关关着：不做格式检查，提示词不带条目格式', async () => {
  const { calls, events } = await runWith(FIXED, { items: false });
  assert.equal(calls.filter((c) => c.stageText === '补全重写').length, 0);
  assert.equal(events.filter((e) => e.type === 'reply_check').length, 0);
  assert.ok(calls.filter((c) => /评审意见/.test(c.stageText)).every((c) => !/｜改法/.test(c.prompt)));
});

// ---------- 接口：按场打开，mock 走一遍 ----------

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

test('接口：按场打开条目化；mock 讨论的评审和修订解析出条目，阻断区块按条目给；开关记进讨论状态', async (t) => {
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
  const port = server.address().port;
  assert.equal((await request(port, 'POST', '/api/runs', { mode: 'decision', topic: 'x', items: 'yes' })).status, 400);
  const { number } = (await request(port, 'POST', '/api/runs', { mode: 'decision', topic: '预算扣减怎么做', repos: '无', items: true })).body;
  await waitIdle(app);
  const d = (await request(port, 'GET', `/api/runs/${number}`)).body;
  const crit = d.posts.filter((p) => p.stage === 'critique');
  assert.ok(crit.length >= 2);
  assert.ok(crit.every((p) => p.itemsOk && p.items.length));
  assert.equal(crit[0].items[0].level, '阻断');
  assert.equal(crit[0].bodyBlockers, 1);
  assert.equal(crit.at(-1).bodyBlockers, 0, 'mock 第 3 轮只剩建议');
  const rev = d.posts.filter((p) => p.stage === 'review');
  assert.ok(rev.every((p) => p.itemsOk && p.items.some((it) => it.level === '采纳')));
  assert.equal(d.outcome.ending, 'converged');
  assert.equal(store.discussion(number).state.items, true);
  // 收敛后最近一次评审没有阻断：之前的阻断在「后来没再提」里，也按条目给
  assert.equal(d.blockers.blocking, 0);
  assert.equal(d.blockers.rows[0].dropped.items[0].fix, '扣减时加行锁');
  const checks = store.executionsOf(number).flatMap((e) => store.events(e.id)).filter((e) => e.type === 'reply_check');
  assert.ok(checks.length >= 4 && checks.every((e) => e.result === 'ok'), 'mock 的格式都合格，不重写');

  // 默认（配置没开）不带条目格式
  const started = await request(port, 'POST', '/api/runs', { mode: 'quick', topic: '缓存要不要加' });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const plain = started.body.number;
  await waitIdle(app);
  const q = (await request(port, 'GET', `/api/runs/${plain}`)).body;
  assert.deepEqual(q.posts.find((p) => p.stage === 'challenge').items, []);
  const qi = (await request(port, 'POST', '/api/runs', { mode: 'quick', topic: '缓存要不要加', items: true })).body.number;
  await waitIdle(app);
  const qd = (await request(port, 'GET', `/api/runs/${qi}`)).body;
  assert.equal(qd.posts.find((p) => p.stage === 'challenge').items[0].fix, '先问清预算');
});
