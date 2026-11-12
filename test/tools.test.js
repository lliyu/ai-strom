// 数据工具：命令行工具清单、执行、MCP 网关、配置与 claude CLI 的 MCP 参数。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { loadCommandTools, buildArgs, inputSchema } from '../src/tools/manifest.js';
import { runCommandTool, cut } from '../src/tools/run.js';
import { createGateway } from '../src/tools/gateway.js';
import { mcpSetup, allowedToolsNote, GATEWAY_PATH, ROOT } from '../src/tools/index.js';
import { normalizeConfig } from '../src/config.js';
import { createClaudeCliProvider, parseStream } from '../src/providers/claude-cli.js';

function toolDir(manifest, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-storm-tools-'));
  fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify(manifest));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

// 回显参数；--fail 时退出码 3；--big 时输出很长；--slow 时不退出
const ECHO = `
const a = process.argv.slice(2);
console.error(JSON.stringify({ query: a }));
if (a.includes('--slow')) setInterval(() => {}, 1000);
else {
  if (a.includes('--big')) console.log(Array.from({ length: 200 }, (_, i) => 'line-' + i).join('\\n'));
  else console.log(JSON.stringify(a));
  console.error(JSON.stringify({ rows: 1 }));
  process.exit(a.includes('--fail') ? 3 : 0);
}`;
const ECHO_TOOL = {
  id: 'echo', description: '回显', effect: 'read', command: ['node', 'echo.js'],
  params: [{ name: 'sql', required: true }, { name: 'env', enum: ['prod', 'test'] }, { name: 'fail', type: 'boolean' }, { name: 'big', type: 'boolean' }, { name: 'slow', type: 'boolean' }, { name: 'limit', type: 'number' }],
};

test('清单：只开放 read，写错的条目整份报错，没有清单就没有工具', () => {
  const dir = toolDir({ tools: [ECHO_TOOL, { id: 'deploy', description: '部署', effect: 'external', command: ['node', 'x.js'] }] });
  const { tools, skipped } = loadCommandTools(dir);
  assert.deepEqual(tools.map((t) => t.id), ['echo']);
  assert.equal(tools[0].dir, dir);
  assert.match(skipped[0].reason, /只开放只读/);
  assert.deepEqual(loadCommandTools(path.join(dir, 'nope')).tools, []);
  const bad = toolDir({ tools: [{ id: 'Bad_Id', effect: 'read', command: [] }, { ...ECHO_TOOL, params: [{ name: '--sql' }] }] });
  assert.throws(() => loadCommandTools(bad), (e) => /id 只能用/.test(e.message) && /缺少 description/.test(e.message) && /command 需要/.test(e.message) && /不写前面的 --/.test(e.message));
  const schema = inputSchema(tools[0]);
  assert.deepEqual(schema.required, ['sql']);
  assert.deepEqual(schema.properties.env.enum, ['prod', 'test']);
  assert.equal(schema.additionalProperties, false);
});

test('参数：只认登记的，一律 --name=value，值以 -- 开头也不会变成开关', () => {
  const tool = { ...ECHO_TOOL, params: ECHO_TOOL.params.map((p) => ({ type: 'string', ...p })) };
  assert.deepEqual(buildArgs(tool, { sql: 'select 1', env: 'prod', fail: false, limit: 5 }), ['--sql=select 1', '--env=prod', '--limit=5']);
  assert.deepEqual(buildArgs(tool, { sql: '--confirm', fail: true }), ['--sql=--confirm', '--fail']);
  assert.throws(() => buildArgs(tool, {}), /缺少必填参数 sql/);
  assert.throws(() => buildArgs(tool, { sql: 'x', confirm: 'abc' }), /没有这些参数：confirm/);
  assert.throws(() => buildArgs(tool, { sql: 'x', env: 'stage' }), /只能是 prod、test/);
  assert.throws(() => buildArgs(tool, { sql: 'x', limit: 'abc' }), /需要是数字/);
  assert.throws(() => buildArgs(tool, { sql: ['x'] }), /需要是字符串/);
});

test('执行：输出、stderr 首末行、退出码、截断、超时', async () => {
  const dir = toolDir({ tools: [ECHO_TOOL] }, { 'echo.js': ECHO });
  const [tool] = loadCommandTools(dir).tools;
  const ok = await runCommandTool(tool, { sql: 'select 1' });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /\["--sql=select 1"\]/);
  assert.match(ok.text, /退出码 0/);
  assert.match(ok.text, /stderr 首行：\{"query":\["--sql=select 1"\]\}/);
  assert.match(ok.text, /stderr 末行：\{"rows":1\}/);
  assert.equal(ok.record.tool, 'echo');
  assert.equal(ok.record.truncated, false);

  const failed = await runCommandTool(tool, { sql: 'x', fail: true });
  assert.equal(failed.ok, false);
  assert.match(failed.text, /退出码 3（失败）/);

  const big = await runCommandTool(tool, { sql: 'x', big: true }, { maxOutputChars: 100 });
  assert.equal(big.record.truncated, true);
  assert.ok(big.record.returnedChars <= 100);
  assert.match(big.text, /被截断，结果不完整/);

  const slow = await runCommandTool({ ...tool, timeoutSec: 0.3 }, { sql: 'x', slow: true });
  assert.equal(slow.ok, false);
  assert.equal(slow.record.timedOut, true);
  assert.match(slow.text, /超时/);

  const missing = await runCommandTool({ ...tool, command: ['./no-such-program'] }, { sql: 'x' });
  assert.equal(missing.ok, false);
  assert.match(missing.text, /找不到程序|无法启动/);

  assert.deepEqual(cut('a\nb\nc', 100), { text: 'a\nb\nc', truncated: false });
  assert.deepEqual(cut('aaaa\nbbbb\ncccc', 11), { text: 'aaaa\nbbbb', truncated: true });
});

test('网关：initialize、tools/list、tools/call，调用记进日志', async () => {
  const dir = toolDir({ tools: [ECHO_TOOL] }, { 'echo.js': ECHO });
  const logFile = path.join(dir, 'log', 'calls.jsonl');
  const g = createGateway({ dir, logFile });
  const init = await g.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  assert.equal(await g.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await g.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['echo']);
  const call = await g.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { sql: 'select 1' } } });
  assert.equal(call.result.isError, false);
  assert.match(call.result.content[0].text, /select 1/);
  const bad = await g.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { confirm: 'x' } } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /参数有误/);
  const none = await g.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'deploy' } });
  assert.match(none.result.content[0].text, /没有工具「deploy」/);
  const unknown = await g.handle({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
  assert.equal(unknown.error.code, -32601);
  const records = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(records.length, 2);
  assert.equal(records[0].exitCode, 0);
  assert.equal(records[1].rejected, true);
});

test('网关进程：按行收发 JSON-RPC', async () => {
  const dir = toolDir({ tools: [ECHO_TOOL] }, { 'echo.js': ECHO });
  const child = spawn(process.execPath, [GATEWAY_PATH, '--dir', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { sql: 'q' } } });
  child.stdin.write('不是 JSON\n');
  child.stdin.end();
  await new Promise((r) => child.on('close', r));
  assert.equal(replies.find((r) => r.id === 1).result.protocolVersion, '2024-11-05');
  assert.match(replies.find((r) => r.id === 2).result.content[0].text, /--sql=q/);
  assert.equal(replies.find((r) => r.error)?.error.code, -32700);
});

const baseCfg = {
  participants: [{ id: 'a', provider: 'fake' }, { id: 'b', provider: 'fake' }],
  chair: { id: 'chair', provider: 'fake' },
  providers: { fake: { type: 'mock' } },
};

test('配置：dataTools 默认值与校验', () => {
  const c = normalizeConfig(baseCfg);
  assert.equal(c.dataTools.dir, path.join(ROOT, 'local/tools'));
  assert.equal(c.dataTools.timeoutSec, 120);
  assert.deepEqual(c.dataTools.mcpServers, {});
  assert.equal(normalizeConfig(c).dataTools.dir, c.dataTools.dir, '再规范化一次不变');
  assert.equal(normalizeConfig({ ...baseCfg, dataTools: { dir: '/x/tools' } }).dataTools.dir, '/x/tools');
  const bad = (dataTools, re) => assert.throws(() => normalizeConfig({ ...baseCfg, dataTools }), re);
  bad({ mcpServers: { logs: { type: 'http', url: 'https://x' } } }, /需要 allow/);
  bad({ mcpServers: { logs: { type: 'http', url: 'https://x', allow: ['mcp__logs__q'] } } }, /不带 mcp__logs__ 前缀/);
  bad({ mcpServers: { logs: { type: 'http', allow: ['q'] } } }, /需要 command/);
  bad({ mcpServers: { storm: { command: 'x', allow: ['q'] } } }, /留给 ai-storm/);
  bad({ mcpServers: { 'a b': { command: 'x', allow: ['q'] } } }, /名字只能用/);
  bad({ timeoutSec: 0 }, /timeoutSec/);
});

test('MCP 配置：网关加登记的服务，放行名单带全名，allow 不传给 CLI', () => {
  const dir = toolDir({ tools: [ECHO_TOOL] });
  const c = normalizeConfig({ ...baseCfg, dataTools: { dir, mcpServers: { logs: { type: 'http', url: 'https://x', headersHelper: 'h', allow: ['query_logs', 'list_envs'] } } } });
  const setup = mcpSetup(c.dataTools, { logFile: '/tmp/calls.jsonl' });
  assert.deepEqual(setup.allowed, ['mcp__storm__echo', 'mcp__logs__query_logs', 'mcp__logs__list_envs']);
  assert.deepEqual(setup.config.mcpServers.logs, { type: 'http', url: 'https://x', headersHelper: 'h' });
  const gw = setup.config.mcpServers.storm;
  assert.equal(gw.command, process.execPath);
  assert.deepEqual(gw.args.slice(0, 3), [GATEWAY_PATH, '--dir', dir]);
  assert.ok(gw.args.includes('--log') && gw.args.includes('/tmp/calls.jsonl'));
  assert.match(allowedToolsNote(setup), /mcp__storm__echo：回显/);
  // 没有命令行工具时不起网关
  const empty = mcpSetup(normalizeConfig({ ...baseCfg, dataTools: { dir: path.join(dir, 'none') } }).dataTools);
  assert.deepEqual(empty.config.mcpServers, {});
  assert.equal(allowedToolsNote(empty), '');
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

const STREAM = [
  { type: 'system', subtype: 'init' },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__storm__echo', input: { sql: 'q' } }, { type: 'tool_use', id: 't2', name: 'mcp__logs__delete', input: {} }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'abc' }] }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Claude requested permissions' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: '答案', num_turns: 3, usage: { input_tokens: 5, output_tokens: 7 }, total_cost_usd: 0.01, permission_denials: [{ tool_name: 'mcp__logs__delete', tool_use_id: 't2' }] },
].map((e) => JSON.stringify(e)).join('\n');

test('claude CLI：带 MCP 时只加载这些服务、放行名单、stream-json 记下工具调用', async () => {
  const capture = [];
  const p = createClaudeCliProvider({ cwd: os.tmpdir() }, { spawnImpl: fakeSpawn(STREAM, capture) });
  const mcp = { config: { mcpServers: { logs: { type: 'http', url: 'https://x' } } }, allowed: ['mcp__logs__query_logs'] };
  const res = await p.complete({ model: 'sonnet', prompt: 'q', mcp });
  const { args } = capture[0];
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('--output-format'), 'stream-json');
  assert.ok(args.includes('--verbose') && args.includes('--strict-mcp-config') && args.includes('--restricted'));
  assert.deepEqual(JSON.parse(at('--mcp-config')), mcp.config);
  assert.equal(at('--tools'), '');
  assert.equal(at('--allowedTools'), 'mcp__logs__query_logs');
  assert.equal(res.text, '答案');
  assert.deepEqual(res.toolCalls, [
    { name: 'mcp__storm__echo', input: { sql: 'q' }, isError: false, resultChars: 3 },
    { name: 'mcp__logs__delete', input: {}, isError: true, resultChars: 28, denied: true },
  ]);

  // 读代码的工具和 MCP 一起放行
  const capture2 = [];
  const p2 = createClaudeCliProvider({ cwd: os.tmpdir() }, { spawnImpl: fakeSpawn(STREAM, capture2) });
  await p2.complete({ prompt: 'q', mcp, tools: ['Read', 'Grep'], addDirs: ['/r'] });
  const a2 = capture2[0].args;
  assert.equal(a2[a2.indexOf('--tools') + 1], 'Read,Grep');
  assert.equal(a2[a2.indexOf('--allowedTools') + 1], 'Read,Grep,mcp__logs__query_logs');

  // 不带 MCP 时照旧 json 输出、不加载任何 MCP 服务
  const capture3 = [];
  const p3 = createClaudeCliProvider({ cwd: os.tmpdir() }, { spawnImpl: fakeSpawn(JSON.stringify({ type: 'result', subtype: 'success', result: 'x', usage: {} }), capture3) });
  const r3 = await p3.complete({ prompt: 'q' });
  assert.equal(capture3[0].args[capture3[0].args.indexOf('--output-format') + 1], 'json');
  assert.ok(!capture3[0].args.includes('--mcp-config'));
  assert.equal(r3.toolCalls, undefined);
  assert.equal(parseStream('{"type":"system"}'), null);
});
