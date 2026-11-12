import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCommandTools, MANIFEST_FILE } from './manifest.js';
import { GATEWAY_NAME } from './gateway.js';
import { DEFAULT_TIMEOUT_SEC, DEFAULT_MAX_OUTPUT_CHARS } from './run.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const GATEWAY_PATH = fileURLToPath(new URL('./gateway.js', import.meta.url));
export const DEFAULT_TOOLS_DIR = 'local/tools';
const SERVER_RE = /^[A-Za-z0-9_-]+$/;

const expandHome = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

/**
 * dataTools：给调研员、核实员查数据用的工具。
 *   dir            命令行工具目录（清单 tools.json + 脚本），相对路径按 ai-storm 目录解析，默认 local/tools
 *   timeoutSec     命令行工具单次超时，默认 120
 *   maxOutputChars 命令行工具返回给模型的输出上限，默认 20000 字
 *   mcpServers     现成的 MCP 服务，写法和 Claude Code 的 mcpServers 一样，另加 allow：允许调用的工具名
 */
export function normalizeDataTools(cfg, errors) {
  const d = cfg.dataTools ?? {};
  const dir = expandHome(d.dir ?? DEFAULT_TOOLS_DIR);
  const out = {
    // 配置里写了 dataTools 才算启用（没写时不去看本机目录，测试和没配的环境不受 local/tools 影响）
    declared: d.declared ?? cfg.dataTools !== undefined,
    dir: path.isAbsolute(dir) ? dir : path.join(ROOT, dir),
    timeoutSec: d.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    maxOutputChars: d.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
    mcpServers: {},
  };
  if (!(Number.isFinite(out.timeoutSec) && out.timeoutSec > 0)) errors.push('dataTools.timeoutSec 需要是正数');
  if (!(Number.isFinite(out.maxOutputChars) && out.maxOutputChars > 0)) errors.push('dataTools.maxOutputChars 需要是正数');
  const servers = d.mcpServers ?? {};
  if (typeof servers !== 'object' || Array.isArray(servers)) errors.push('dataTools.mcpServers 需要是对象：{ 名字: { ...服务配置, allow: [工具名] } }');
  else {
    for (const [name, s] of Object.entries(servers)) {
      const where = `dataTools.mcpServers.${name}`;
      if (!SERVER_RE.test(name)) errors.push(`${where}：名字只能用字母、数字、横线和下划线`);
      if (name === GATEWAY_NAME) errors.push(`${where}：${GATEWAY_NAME} 留给 ai-storm 自己的命令行工具网关`);
      const isHttp = s?.type === 'http' || s?.type === 'sse';
      if (isHttp ? typeof s.url !== 'string' : typeof s?.command !== 'string') errors.push(`${where}：需要 command（本地进程）或 type: "http" 加 url`);
      const allow = s?.allow;
      if (!Array.isArray(allow) || !allow.length || allow.some((x) => typeof x !== 'string' || !x)) {
        errors.push(`${where}：需要 allow，列出允许调用的工具名（只放只读的工具）`);
      } else if (allow.some((x) => x.startsWith('mcp__'))) {
        errors.push(`${where}：allow 里写工具本身的名字，不带 mcp__${name}__ 前缀`);
      }
      out.mcpServers[name] = { ...s };
    }
  }
  cfg.dataTools = out;
}

/**
 * 一次调用要用的 MCP 配置：网关（有命令行工具时）加上登记的 MCP 服务，以及放行名单。
 * 放行名单就是权限边界：claude -p 里没放行的工具调用一律被拒（服务的其他工具模型能看到但用不了）。
 */
export function mcpSetup(dataTools, { logFile } = {}) {
  const { tools, skipped, file } = loadCommandTools(dataTools.dir);
  const mcpServers = {};
  const allowed = [];
  const listed = [];
  if (tools.length) {
    mcpServers[GATEWAY_NAME] = {
      command: process.execPath,
      args: [
        GATEWAY_PATH, '--dir', dataTools.dir,
        '--timeout', String(dataTools.timeoutSec), '--max-chars', String(dataTools.maxOutputChars),
        ...(logFile ? ['--log', logFile] : []),
      ],
    };
    for (const t of tools) {
      allowed.push(`mcp__${GATEWAY_NAME}__${t.id}`);
      listed.push({ source: 'command', server: GATEWAY_NAME, name: t.id, description: t.description });
    }
  }
  for (const [name, s] of Object.entries(dataTools.mcpServers)) {
    const { allow, ...server } = s;
    mcpServers[name] = server;
    for (const t of allow) {
      allowed.push(`mcp__${name}__${t}`);
      listed.push({ source: 'mcp', server: name, name: t });
    }
  }
  return { config: { mcpServers }, allowed, listed, skipped, manifest: file };
}

/** 写进提示词：能用的工具（外部 MCP 服务的其他工具模型也看得到，但调用会被拒）。 */
export function allowedToolsNote(setup) {
  if (!setup.allowed.length) return '';
  const lines = setup.listed.map((t) => `- mcp__${t.server}__${t.name}${t.description ? `：${t.description}` : ''}`);
  return `**可以用的数据工具**（只有这些会被放行，其他工具调用会被拒绝）：\n${lines.join('\n')}`;
}

/** 有没有可用的数据工具：登记了 MCP 服务，或工具目录里有清单。 */
export function hasDataTools(dataTools) {
  if (!dataTools?.declared) return false;
  return Object.keys(dataTools.mcpServers ?? {}).length > 0 || fs.existsSync(path.join(dataTools.dir, MANIFEST_FILE));
}

/**
 * 一场讨论要带的数据工具和知识：selection = { tools: 布尔, knowledge: [来源名] }（网页上选的，存进 state.json）。
 * 工具调用记录写到 logFile。都没有时返回 null。
 */
export function prepareData(cfg, selection, { logFile, knowledgeSetup } = {}) {
  if (!selection || cfg.mode !== 'decision') return null;
  const mcp = selection.tools && cfg.research && hasDataTools(cfg.dataTools) ? mcpSetup(cfg.dataTools, { logFile }) : null;
  const usableMcp = mcp?.allowed.length ? mcp : null;
  const know = selection.knowledge?.length ? knowledgeSetup(cfg.knowledge, selection.knowledge) : null;
  const usableKnow = know?.dirs.length ? know : null;
  if (!usableMcp && !usableKnow) return null;
  return { selection: { tools: Boolean(usableMcp), knowledge: usableKnow?.sources ?? [] }, mcp: usableMcp, knowledge: usableKnow };
}
