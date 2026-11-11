import { whoOf } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { normalizeConfig } from '../src/config.js';
import { parseRepoSpecs, resolveRepos, prepareRepos } from '../src/repos.js';
import { parseTrigger } from '../src/watch.js';
import { runDiscussion } from '../src/orchestrator.js';
import { createMemoryPublisher } from '../src/publishers.js';
import { createClaudeCliProvider } from '../src/providers/claude-cli.js';

const base = (extra = {}) => ({
  participants: [
    { id: 'a', name: 'A', provider: 'fake', part: 'lead' },
    { id: 'b', name: 'B', provider: 'fake', part: 'lead' },
    { id: 'c', name: 'C', provider: 'fake', part: 'reviewer' },
  ],
  chair: { id: 'chair', name: '主席', provider: 'fake', color: 'purple', webhook: { urlEnv: 'X' } },
  providers: { fake: { type: 'mock' } },
  ...extra,
});

const registry = {
  repos: { fission: { path: '/r/fission', description: '价格' }, job: { path: '/r/job', docs: ['/d/job.md'] }, admin: { path: '/r/admin' } },
  repoGroups: { pricing: { repos: ['job', 'admin'], docs: ['/d/pricing'] } },
};

test('仓库写法解析', () => {
  assert.deepEqual(parseRepoSpecs('fission, pricing@release/1.2'), [{ name: 'fission' }, { name: 'pricing', ref: 'release/1.2' }]);
  assert.deepEqual(parseRepoSpecs(['a@v1']), [{ name: 'a', ref: 'v1' }]);
  assert.throws(() => parseRepoSpecs('a;rm'), /写法不对/);
  assert.throws(() => parseRepoSpecs('a@$(x)'), /写法不对/);
});

test('仓库解析：组展开、参考资料、未知别名报错', () => {
  const cfg = normalizeConfig(base(registry));
  const r = resolveRepos(cfg, parseRepoSpecs('pricing@dev,fission'));
  assert.deepEqual(r.repos.map((x) => [x.alias, x.ref]), [['job', 'dev'], ['admin', 'dev'], ['fission', null]]);
  assert.deepEqual(r.docs, ['/d/pricing', '/d/job.md']);
  assert.deepEqual(r.groups, ['pricing']);
  // 先写不带分支、再写带分支：以带分支的为准
  assert.equal(resolveRepos(cfg, parseRepoSpecs('job,job@v2')).repos[0].ref, 'v2');
  assert.throws(() => resolveRepos(cfg, parseRepoSpecs('nope')), /没有登记的仓库：nope。可用的组：pricing/);
});

test('配置：登记仓库后补上调研员默认值，并校验', () => {
  const cfg = normalizeConfig(base(registry));
  assert.equal(cfg.research.provider, 'claude-cli');
  assert.deepEqual(cfg.research.tools, ['Read', 'Grep', 'Glob']);
  assert.deepEqual(cfg.research.webhook, cfg.chair.webhook); // 默认借用主席的机器人
  assert.equal(normalizeConfig(base()).research, undefined);
  assert.throws(() => normalizeConfig(base({ ...registry, research: { provider: 'fake2' }, providers: { fake: { type: 'mock' }, fake2: { type: 'openai-compatible' } } })), /只能是 claude-cli/);
  assert.throws(() => normalizeConfig(base({ repos: { x: { path: 'rel' } }, repoGroups: { g: { repos: ['y'] } } })), /绝对路径[\s\S]*repos 里没有 y/);
});

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storm-repo-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
  git('add', '.');
  git('commit', '-qm', 'one');
  git('tag', 'v1');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v2');
  git('commit', '-qam', 'two');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'dirty');
  return fs.realpathSync(dir);
}

test('准备仓库：工作区记录分支与改动，指定版本导出快照，结束后清理', () => {
  const dir = makeRepo();
  const cfg = normalizeConfig(base({ repos: { r: { path: dir }, s: { path: dir } } }));
  const code = prepareRepos(resolveRepos(cfg, parseRepoSpecs('r,s@v1')));
  const [live, snap] = code.repos;
  assert.equal(live.readPath, dir);
  assert.equal(live.branch, 'main');
  assert.equal(live.dirty, 1);
  assert.equal(snap.snapshot, true);
  assert.notEqual(snap.readPath, dir);
  assert.equal(fs.readFileSync(path.join(snap.readPath, 'a.txt'), 'utf8'), 'v1');
  assert.equal(fs.existsSync(path.join(snap.readPath, 'b.txt')), false);
  assert.deepEqual(code.dirs, [dir, snap.readPath]);
  code.cleanup();
  assert.equal(fs.existsSync(snap.readPath), false);
  assert.throws(() => prepareRepos(resolveRepos(cfg, parseRepoSpecs('r@nope'))), /找不到 nope/);
});

test('群指令：仓库写在议题前，和轮数顺序不限', () => {
  assert.deepEqual(parseTrigger('/讨论 仓库:fission,pricing@dev 要不要拆服务'), { mode: 'decision', rounds: undefined, repos: ['fission', 'pricing@dev'], topic: '要不要拆服务' });
  assert.deepEqual(parseTrigger('/讨论 仓库：fission， job 3轮 议题'), { mode: 'decision', rounds: 3, repos: ['fission', 'job'], topic: '议题' });
  assert.deepEqual(parseTrigger('/讨论 3轮 repo:fission\n背景：xx'), { mode: 'decision', rounds: 3, repos: ['fission'], topic: '背景：xx' });
  assert.deepEqual(parseTrigger('/讨论 仓库:fission'), { mode: 'decision', error: '缺少议题' });
  assert.equal(parseTrigger('/讨论 仓库的拆分方案').repos, undefined);
});

function fakeSpawn(stdout, capture) {
  return (bin, args, opts) => {
    capture.push({ bin, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', stdout);
      child.emit('close', 0);
    });
    return child;
  };
}

test('claude CLI：调研模式用受限只读工具和多个目录', async () => {
  const capture = [];
  const ok = JSON.stringify({ type: 'result', subtype: 'success', result: '资料', num_turns: 12, usage: {}, modelUsage: {} });
  const p = createClaudeCliProvider({ cwd: os.tmpdir() }, { spawnImpl: fakeSpawn(ok, capture) });
  const res = await p.complete({ prompt: 'q', tools: ['Read', 'Grep', 'Glob'], addDirs: ['/a', '/b'], maxBudgetUsd: 2 });
  assert.equal(res.turns, 12);
  const { args } = capture[0];
  assert.ok(args.includes('--restricted'));
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.deepEqual(args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : [])), ['/a', '/b']);
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '2');

  const over = JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 2.1 });
  const p2 = createClaudeCliProvider({ cwd: os.tmpdir() }, { spawnImpl: fakeSpawn(over, []) });
  await assert.rejects(p2.complete({ prompt: 'q', tools: ['Read'], maxBudgetUsd: 2 }), /超出单次预算 \$2/);
});

function recording({ failResearch = false } = {}) {
  const calls = [];
  const provider = {
    async complete(opts) {
      const who = whoOf(opts);
      calls.push({ who, ...opts });
      if (who === '调研员' && failResearch) throw new Error('读不到');
      return { text: who === '调研员' ? '**一句话现状**\n价格在 fission:Price.java:42 计算' : `发言-${calls.length}`, usage: { inputTokens: 1, outputTokens: 1 }, turns: who === '调研员' ? 8 : undefined };
    },
  };
  return { calls, registry: { get: () => provider } };
}

const code = {
  repos: [{ alias: 'fission', description: '价格', readPath: '/tmp/x', branch: 'main', commit: 'abc', dirty: 2, snapshot: false }],
  docs: ['/d/pricing'],
  groups: [],
  dirs: ['/tmp/x', '/d/pricing'],
};

test('有代码上下文时：调研员先读代码，背景资料进入之后所有人的提示词', async () => {
  const cfg = normalizeConfig(base(registry));
  const { calls, registry: providers } = recording();
  const events = [];
  const publisher = createMemoryPublisher();
  const res = await runDiscussion({ cfg, topic: '要不要加缓存', providers, publisher, rng: () => 0, onEvent: (e) => events.push(e), code });

  const [first, ...rest] = calls;
  assert.equal(first.who, '调研员');
  assert.deepEqual(first.tools, ['Read', 'Grep', 'Glob']);
  assert.deepEqual(first.addDirs, ['/tmp/x', '/d/pricing']);
  assert.equal(first.maxBudgetUsd, undefined); // 默认不限费用
  assert.match(first.prompt, /fission.*\/tmp\/x.*分支 main.*2 个未提交改动/);
  assert.match(first.prompt, /参考资料[\s\S]*\/d\/pricing/);
  assert.ok(rest.length > 0);
  for (const c of rest) {
    assert.match(c.system, /## 背景资料[\s\S]*fission:Price\.java:42/, `${c.who} 没收到背景资料`);
    assert.doesNotMatch(c.prompt, /要不要加缓存|## 背景资料/); // 议题和资料只在共享的系统提示词里
    assert.equal(c.tools, undefined); // 参与者不带工具
  }
  // 主笔、评审、主席共用一份系统提示词（缓存可以跨发言者命中），身份写在正文开头
  assert.equal(new Set(rest.map((c) => c.system)).size, 1);
  // 身份只在每位参与者会话的第一条消息里说一次
  const firstOf = new Map();
  for (const c of rest) if (!firstOf.has(c.who)) firstOf.set(c.who, c);
  assert.ok([...firstOf.values()].every((c) => /^你是「/.test(c.prompt)));
  assert.ok(rest.filter((c) => !c.who.startsWith('主席') && firstOf.get(c.who) !== c).every((c) => !/^你是「/.test(c.prompt)));
  // 开场卡片写明读了哪些仓库；调研员用主席的机器人发卡片
  assert.match(publisher.posts[0].body, /代码上下文[\s\S]*fission（价格）：main @ abc，2 个未提交改动/);
  assert.equal(publisher.posts[1].speaker.id, 'research');
  assert.equal(publisher.posts[1].subtitle, '背景资料 · 读了 fission');
  // 用量事件带上调研员
  const start = events.find((e) => e.type === 'run_started');
  assert.equal(start.research.part, 'research');
  assert.equal(events.find((e) => e.type === 'call_finished' && e.speaker === 'research').turns, 8);
  assert.match(res.context.text, /一句话现状/);
});

test('调研失败时讨论不开始', async () => {
  const cfg = normalizeConfig(base(registry));
  const { calls, registry: providers } = recording({ failResearch: true });
  await assert.rejects(
    runDiscussion({ cfg, topic: 't', providers, publisher: createMemoryPublisher(), code }),
    /代码调研失败/,
  );
  assert.equal(calls.length, 1);
});

test('没有代码上下文时流程不变', async () => {
  const cfg = normalizeConfig(base(registry));
  const { calls, registry: providers } = recording();
  await runDiscussion({ cfg, topic: 't', providers, publisher: createMemoryPublisher() });
  assert.ok(calls.every((c) => c.who !== '调研员' && !/背景资料/.test(c.system + c.prompt)));
});

test('没写仓库：方案讨论自动把全部登记仓库交给调研员；「仓库:无」不读', () => {
  assert.deepEqual(parseRepoSpecs('无'), []);
  assert.deepEqual(parseRepoSpecs('none'), []);
  assert.deepEqual(parseTrigger('/讨论 仓库:无 议题').repos, []);
  assert.deepEqual(parseTrigger('/讨论 仓库：none 议题').repos, []);
  assert.equal(parseTrigger('/讨论 分析下 pricecenter 的缓存').repos, undefined);
});

test('auto：缺失的目录跳过，不缺失时照常报错', () => {
  const dir = makeRepo();
  const cfg = normalizeConfig(base({ repos: { ok: { path: dir }, gone: { path: '/nope/x' } }, repoGroups: { g: { repos: ['ok'], docs: ['/nope/docs'] } } }));
  const code = prepareRepos(resolveRepos(cfg, [{ name: 'g' }, { name: 'ok' }, { name: 'gone' }]), { skipMissing: true });
  assert.deepEqual(code.repos.map((r) => r.alias), ['ok']);
  assert.deepEqual(code.skipped, ['/nope/x', '/nope/docs']);
  code.cleanup();
  assert.throws(() => prepareRepos(resolveRepos(cfg, [{ name: 'gone' }])), /目录不存在/);
});

test('auto：调研员先定位仓库；判断无关时不带代码讨论', async () => {
  const cfg = normalizeConfig(base(registry));
  const auto = { ...code, auto: true };
  const { calls, registry: providers } = recording();
  const publisher = createMemoryPublisher();
  await runDiscussion({ cfg, topic: '分析 pricecenter 缓存', providers, publisher, code: auto });
  assert.match(calls[0].prompt, /先判断涉及哪些[\s\S]*pricecenter、price center、价格中心[\s\S]*无相关代码[\s\S]*\*\*涉及的仓库\*\*/);
  assert.match(publisher.posts[0].body, /没有指定仓库，调研员会从已登记的 1 个仓库里按议题定位/);
  assert.match(calls[1].system, /仓库由调研员按议题定位/);

  const none = {
    calls: [],
    registry: { get: () => ({ async complete(o) { const who = whoOf(o); none.calls.push({ who, ...o }); return { text: who === '调研员' ? '无相关代码' : 'x', usage: {} }; } }) },
  };
  await runDiscussion({ cfg, topic: '团队周会改到周四？', providers: none.registry, publisher: createMemoryPublisher(), code: auto });
  assert.ok(none.calls.slice(1).every((c) => !/背景资料/.test(c.system + c.prompt)));
});
