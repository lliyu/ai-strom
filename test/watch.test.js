import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTrigger, watchLoop, acquireLock } from '../src/watch.js';
import { createInterjectionReader, toInterjection } from '../src/lark/interjections.js';

test('解析指令', () => {
  assert.deepEqual(parseTrigger('/讨论 要不要拆服务'), { mode: 'decision', rounds: undefined, topic: '要不要拆服务' });
  assert.deepEqual(parseTrigger('  /脑洞 修仙+外卖 '), { mode: 'brainstorm', rounds: undefined, topic: '修仙+外卖' });
  assert.deepEqual(parseTrigger('/讨论 3轮 要不要拆服务'), { mode: 'decision', rounds: 3, topic: '要不要拆服务' });
  assert.deepEqual(parseTrigger('/讨论\n背景：xxx\n问题：yyy'), { mode: 'decision', rounds: undefined, topic: '背景：xxx\n问题：yyy' });
  assert.deepEqual(parseTrigger('/讨论 3 轮'), { mode: 'decision', error: '缺少议题' });
  assert.deepEqual(parseTrigger('/脑洞'), { mode: 'brainstorm', error: '缺少题目' });
  assert.equal(parseTrigger('/讨论区怎么走'), null);
  assert.equal(parseTrigger('补充：不能改表结构'), null);
  assert.equal(parseTrigger('我们 /讨论 一下'), null);
});

test('解析指令：指令后面跟标点也算', () => {
  assert.deepEqual(parseTrigger('/追问，继续讨论，直到达成一致'), { mode: 'followup', target: undefined, topic: '继续讨论，直到达成一致' });
  assert.deepEqual(parseTrigger('/追问：#2，问题'), { mode: 'followup', target: 2, topic: '问题' });
  assert.deepEqual(parseTrigger('/讨论：3轮 议题'), { mode: 'decision', rounds: 3, topic: '议题' });
  assert.deepEqual(parseTrigger('/追问，'), { mode: 'followup', error: '缺少问题' });
  assert.equal(parseTrigger('/追问问题'), null);
  assert.deepEqual(parseTrigger('/追问 #2继续讨论'), { mode: 'followup', target: 2, topic: '继续讨论' });
});

test('watchLoop：排队执行、不完整指令回帮助、失败通知后继续', async () => {
  const batches = [
    [
      { id: '1', sender: '我', text: '随便聊聊' },
      { id: '2', sender: '我', text: '/讨论 议题一' },
      { id: '3', sender: '我', text: '/脑洞' },
      { id: '4', sender: '我', text: '/脑洞 2轮 题目二' },
    ],
    [{ id: '5', sender: '我', text: '/讨论 会失败的议题' }],
  ];
  let polls = 0;
  const reader = { async poll() { polls += 1; return batches.shift() ?? []; } };
  const ran = [];
  const notes = [];
  const states = [];
  await watchLoop({
    onState: (s) => states.push(s),
    reader,
    runOne: async (job) => {
      ran.push(job);
      if (job.topic.includes('失败')) throw new Error('模型挂了');
    },
    notify: async (n) => notes.push(n),
    sleep: async () => {},
    shouldStop: () => polls >= 3,
  });
  assert.deepEqual(ran.map((j) => [j.mode, j.rounds, j.topic]), [
    ['decision', undefined, '议题一'],
    ['brainstorm', 2, '题目二'],
    ['decision', undefined, '会失败的议题'],
  ]);
  assert.ok(notes.some((n) => /无法开始：缺少题目/.test(n.title) && /用法/.test(n.body)));
  assert.ok(notes.some((n) => /收到 2 个议题/.test(n.title)));
  assert.ok(notes.some((n) => /讨论中断/.test(n.title) && /模型挂了/.test(n.body)));
  // 状态：讨论时 running 并带议题，结束后记录上一场结果
  const running = states.filter((s) => s.phase === 'running');
  assert.deepEqual(running.map((s) => s.current.topic), ['议题一', '题目二', '会失败的议题']);
  assert.equal(running[0].queued, 1);
  assert.ok(states.some((s) => s.lastJob?.ok === false && /模型挂了/.test(s.lastJob.error)));
  assert.ok(states.some((s) => s.lastPollAt));
});

test('watchLoop：读取失败时退避重试', async () => {
  let polls = 0;
  const waits = [];
  await watchLoop({
    reader: { async poll() { polls += 1; if (polls < 3) throw new Error('网络'); return []; } },
    runOne: async () => {},
    notify: async () => {},
    intervalMs: 1000,
    sleep: async (ms) => waits.push(ms),
    shouldStop: () => polls >= 3,
  });
  assert.deepEqual(waits, [2000, 4000]);
});

const msg = (id, text, extra = {}) => ({ message_id: id, msg_type: 'text', create_time: '2026-11-10 15:30', sender: { sender_type: 'user', id: 'ou_me', name: '我' }, content: text, deleted: false, ...extra });

test('读取器：游标前进、按 id 去重、忽略指令、只收人', async () => {
  const pages = [
    [msg('a', '第一条'), msg('b', '/讨论 xx'), msg('c', '机器人', { sender: { sender_type: 'app', id: 'cli_x' }, msg_type: 'interactive' })],
    [msg('a', '第一条'), msg('d', '第二条'), msg('e', '系统', { sender: { sender_type: '' }, msg_type: 'system' })],
  ];
  const starts = [];
  let t = Date.parse('2026-11-10T07:00:00Z');
  const reader = createInterjectionReader({
    chatId: 'oc_1',
    since: new Date(t),
    overlapMs: 60000,
    now: () => t,
    ignore: (text) => text.startsWith('/讨论'),
    execImpl: async (bin, args) => {
      starts.push(args[args.indexOf('--start') + 1]);
      return { ok: true, data: { messages: pages.shift() ?? [] } };
    },
  });
  assert.deepEqual((await reader.poll()).map((m) => m.text), ['第一条']);
  t += 10 * 60000; // 十分钟后
  assert.deepEqual((await reader.poll()).map((m) => m.text), ['第二条']);
  assert.equal(starts[0], '2026-11-10T07:00:00.000Z');
  assert.equal(starts[1], '2026-11-10T07:00:00.000Z'); // 第二次读取的起点 = 第一次读取时刻 - 重叠，不早于 since
  await reader.poll();
  assert.equal(starts[2], '2026-11-10T07:09:00.000Z'); // 第三次：第二次读取时刻 - 1 分钟
});

test('分钟精度的时间显示', () => {
  assert.equal(toInterjection(msg('x', 'hi')).time, '15:30');
});

test('单实例锁', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'storm-lock-')), '.watch.pid');
  const release = acquireLock(file);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  // 记录的是一个活着的其他进程时拒绝：用父进程 pid 模拟
  fs.writeFileSync(file, String(process.ppid));
  assert.throws(() => acquireLock(file), /已经有一个 watch 在运行/);
  // 记录的进程已不存在时接管
  fs.writeFileSync(file, '999999');
  const release2 = acquireLock(file);
  release2();
  assert.equal(fs.existsSync(file), false);
  release();
});

const limited = { ok: false, error: { type: 'api', subtype: 'rate_limit', code: 99991400, message: 'request trigger frequency limit' } };

test('读取器：限流时隔几秒重试，仍限流就抛出 rateLimited', async () => {
  const waits = [];
  const replies = [limited, limited, { ok: true, data: { messages: [msg('z', '你好')] } }];
  const reader = createInterjectionReader({
    chatId: 'oc_1',
    since: new Date(0),
    execImpl: async () => replies.shift(),
    sleep: async (ms) => waits.push(ms),
    random: () => 0,
  });
  assert.deepEqual((await reader.poll()).map((m) => m.text), ['你好']);
  assert.deepEqual(waits, [3000, 6000]);

  const always = createInterjectionReader({ chatId: 'oc_1', since: new Date(0), execImpl: async () => limited, sleep: async () => {}, retryDelaysMs: [1, 1] });
  await assert.rejects(always.poll(), (err) => err.rateLimited === true && /限流/.test(err.message));
});

test('watchLoop：限流不算故障，按正常间隔再读', async () => {
  let polls = 0;
  const waits = [];
  const logs = [];
  await watchLoop({
    reader: { async poll() { polls += 1; if (polls < 3) throw Object.assign(new Error('限流'), { rateLimited: true }); return []; } },
    runOne: async () => {},
    notify: async () => {},
    log: (s) => logs.push(s),
    intervalMs: 30000,
    sleep: async (ms) => waits.push(ms),
    shouldStop: () => polls >= 3,
  });
  assert.deepEqual(waits, [30000, 30000]);
  assert.ok(logs.every((l) => !/⚠️/.test(l)));
});
