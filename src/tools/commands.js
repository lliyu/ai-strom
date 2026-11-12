import fs from 'node:fs';
import path from 'node:path';
import { loadCommandTools } from './manifest.js';
import { runCommandTool } from './run.js';
import { mcpSetup, allowedToolsNote, ROOT } from './index.js';
import { createProviderRegistry } from '../providers/index.js';

/** node src/cli.js tools：列出命令行工具（含跳过的）和登记的 MCP 服务。 */
export function listTools(cfg) {
  const d = cfg.dataTools;
  let loaded;
  try {
    loaded = loadCommandTools(d.dir);
  } catch (err) {
    console.log(`❌ ${err.message}`);
    return 1;
  }
  console.log(`命令行工具：${loaded.file}${fs.existsSync(loaded.file) ? '' : '（不存在，没有命令行工具）'}`);
  for (const t of loaded.tools) {
    const params = t.params.map((p) => `${p.name}${p.required ? '*' : ''}`).join(' ');
    console.log(`  ✅ ${t.id}${params ? `  [${params}]` : ''}\n     ${t.description}`);
  }
  for (const s of loaded.skipped) console.log(`  ⏭  ${s.id}：${s.reason}`);
  const servers = Object.entries(d.mcpServers);
  console.log(`\nMCP 服务：${servers.length ? '' : '没有登记（config.json 的 dataTools.mcpServers）'}`);
  for (const [name, s] of servers) {
    console.log(`  ${name}（${s.url ?? [s.command, ...(s.args ?? [])].join(' ')}）\n     放行：${s.allow.join('、')}`);
  }
  console.log(`\n默认超时 ${d.timeoutSec}s，返回给模型的输出上限 ${d.maxOutputChars} 字。`);
  return 0;
}

/** node src/cli.js tools call <id> 参数=值 …：不经过模型，直接执行一个命令行工具，看它返回给模型的文字。 */
export async function callTool(cfg, id, pairs) {
  const { tools, skipped } = loadCommandTools(cfg.dataTools.dir);
  const tool = tools.find((t) => t.id === id);
  if (!tool) {
    const why = skipped.find((s) => s.id === id)?.reason;
    console.error(why ? `${id} 没有开放：${why}` : `没有命令行工具「${id}」。可用：${tools.map((t) => t.id).join('、') || '无'}`);
    return 2;
  }
  const input = {};
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i <= 0) {
      console.error(`参数写成 名字=值，例如 sql="select 1"；收到 ${pair}`);
      return 2;
    }
    const name = pair.slice(0, i).replace(/^--/, '');
    const raw = pair.slice(i + 1);
    const type = tool.params.find((p) => p.name === name)?.type;
    input[name] = type === 'boolean' ? raw === 'true' : raw;
  }
  let out;
  try {
    out = await runCommandTool(tool, input, { timeoutSec: cfg.dataTools.timeoutSec, maxOutputChars: cfg.dataTools.maxOutputChars });
  } catch (err) {
    console.error(`参数有误：${err.message}`);
    return 2;
  }
  console.log(out.text);
  return out.ok ? 0 : 1;
}

/**
 * node src/cli.js tools try "<问题>" [--model sonnet]：让模型带着全部数据工具回答一个问题，
 * 端到端检查网关、MCP 服务和登录态。调用记录写在 runs/.tools/。
 */
export async function tryTools(cfg, question, { model } = {}) {
  const dir = path.join(ROOT, 'runs', '.tools');
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  const setup = mcpSetup(cfg.dataTools, { logFile });
  if (!setup.allowed.length) {
    console.error('没有可用的数据工具：local/tools/tools.json 里没有只读工具，config.json 也没有登记 dataTools.mcpServers');
    return 2;
  }
  const providerName = cfg.research?.provider
    ?? Object.entries(cfg.providers).find(([, p]) => p.type === 'claude-cli')?.[0]
    ?? 'claude-cli';
  const provider = createProviderRegistry(cfg).get(providerName);
  const system = '你在用数据工具回答问题。只用放行的工具，不要编造数据；查不到或工具报错时如实说明，并写出你用的查询条件。';
  const prompt = `${allowedToolsNote(setup)}\n\n**问题**\n${question}`;
  console.log(`放行 ${setup.allowed.length} 个工具，模型 ${model ?? '默认'}，调用记录：${path.relative(process.cwd(), logFile)}\n`);
  const res = await provider.complete({ model, system, prompt, mcp: setup, timeoutMs: (cfg.dataTools.timeoutSec + 300) * 1000 });
  console.log(res.text);
  console.log(`\n工具调用 ${res.toolCalls?.length ?? 0} 次：`);
  for (const c of res.toolCalls ?? []) {
    const state = c.denied ? '被拒（不在放行名单）' : c.isError ? `出错，返回 ${c.resultChars ?? 0} 字` : `返回 ${c.resultChars ?? 0} 字`;
    console.log(`  ${c.name} ${JSON.stringify(c.input)} → ${state}`);
  }
  console.log(`\n${res.model}，${res.turns ?? '?'} 轮，${Math.round(res.durationMs / 1000)}s${typeof res.costUsd === 'number' ? `，$${res.costUsd.toFixed(4)}` : ''}`);
  return 0;
}
