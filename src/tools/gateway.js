#!/usr/bin/env node
/**
 * 数据工具网关：一个本地 MCP 服务（stdio，按行收发 JSON-RPC），把工具目录里登记的只读命令行工具
 * 交给 claude CLI 调用。调研员不开 Bash，只能通过这里执行登记过的命令，参数也只能填登记过的。
 *
 * 用法：node src/tools/gateway.js --dir <工具目录> [--db <记录库> --exec <运行 id>] [--timeout <秒>] [--max-chars <字数>]
 */
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadCommandTools, inputSchema } from './manifest.js';
import { runCommandTool } from './run.js';
import { openStore } from '../db.js';

export const GATEWAY_NAME = 'storm';
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** 处理一条 JSON-RPC 消息；通知返回 null。拆出来便于测试。 */
/** record(调用记录)：每次调用后回调，主进程里写进记录库。 */
export function createGateway({ dir, record, timeoutSec, maxOutputChars, run = runCommandTool }) {
  const { tools } = loadCommandTools(dir);
  const byId = new Map(tools.map((t) => [t.id, t]));

  const log = (rec) => {
    if (!record) return;
    try {
      record(rec);
    } catch {
      // 记录失败不影响调用结果
    }
  };

  async function handle(msg) {
    const { id, method, params } = msg ?? {};
    const isRequest = id !== undefined && id !== null;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: isRequest ? id : null, error: { code, message } });
    if (msg?.jsonrpc !== '2.0' || typeof method !== 'string') return isRequest ? fail(-32600, 'Invalid Request') : null;
    if (!isRequest) return null; // notifications/initialized、notifications/cancelled 等不需要回复

    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ai-storm-tools', version: '1.0.0' },
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({
          tools: tools.map((t) => ({ name: t.id, description: t.description, inputSchema: inputSchema(t) })),
        });
      case 'tools/call': {
        const tool = byId.get(params?.name);
        if (!tool) return reply({ content: [{ type: 'text', text: `没有工具「${params?.name}」。可用：${[...byId.keys()].join('、') || '无'}` }], isError: true });
        try {
          const out = await run(tool, params?.arguments ?? {}, { timeoutSec, maxOutputChars });
          log(out.record);
          return reply({ content: [{ type: 'text', text: out.text }], isError: !out.ok });
        } catch (err) {
          log({ time: new Date().toISOString(), source: 'command', tool: tool.id, input: params?.arguments ?? {}, error: err.message, rejected: true });
          return reply({ content: [{ type: 'text', text: `参数有误：${err.message}` }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  }

  return { tools, handle };
}

/** 网关进程里写记录库：第一次调用时才打开。 */
function recorder(file, execId) {
  let store;
  return (rec) => {
    store ??= openStore(file);
    store.addToolCall(execId, rec);
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      db: { type: 'string' },
      exec: { type: 'string' },
      timeout: { type: 'string' },
      'max-chars': { type: 'string' },
    },
  });
  if (!values.dir) {
    process.stderr.write('缺少 --dir <工具目录>\n');
    process.exit(2);
  }
  const gateway = createGateway({
    dir: path.resolve(values.dir),
    record: values.db ? recorder(path.resolve(values.db), values.exec ? Number(values.exec) : null) : undefined,
    timeoutSec: values.timeout ? Number(values.timeout) : undefined,
    maxOutputChars: values['max-chars'] ? Number(values['max-chars']) : undefined,
  });
  const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    // 工具调用可能并发：各自完成后各自回复
    const p = gateway.handle(msg).then((res) => { if (res) write(res); }).catch((err) => {
      if (msg?.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } });
    }).finally(() => pending.delete(p));
    pending.add(p);
  });
  rl.on('close', async () => {
    await Promise.allSettled([...pending]);
    process.exit(0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
