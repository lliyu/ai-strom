import fs from 'node:fs';
import path from 'node:path';

/**
 * 命令行数据工具的清单：<工具目录>/tools.json = { "tools": [ 条目 ] }。
 *
 * 条目：
 *   id            小写字母、数字、横线，例如 query-db
 *   description   做什么、什么时候用（模型据此选工具）
 *   effect        read | write …；只有 read 会开放给模型，其余跳过并列出原因
 *   command       程序与固定参数，例如 ["node", "query-db.js"]；在工具目录里执行，不经过 shell
 *   params        [{ name, description?, required?, type?: string|number|boolean, enum? }]
 *                 调用时按 --name=value 传给命令（boolean 为 true 时只传 --name）
 *   timeoutSec    单次超时，默认取 dataTools.timeoutSec
 *   maxOutputChars 返回给模型的输出上限，默认取 dataTools.maxOutputChars
 */
export const MANIFEST_FILE = 'tools.json';
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const PARAM_TYPES = new Set(['string', 'number', 'boolean']);

/** 读工具目录的清单。目录或清单不存在时没有工具；条目有误时整份报错（不静默跳过写错的工具）。 */
export function loadCommandTools(dir) {
  const file = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(file)) return { file, tools: [], skipped: [] };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} 不是合法的 JSON：${err.message}`);
  }
  if (!Array.isArray(raw?.tools)) throw new Error(`${file}：需要 { "tools": [ ... ] }`);
  const errors = [];
  const tools = [];
  const skipped = [];
  const ids = new Set();
  raw.tools.forEach((t, i) => {
    const where = `${MANIFEST_FILE} 第 ${i + 1} 条（${t?.id ?? '未命名'}）`;
    const before = errors.length;
    if (!ID_RE.test(t?.id ?? '')) errors.push(`${where}：id 只能用小写字母、数字和横线`);
    else if (ids.has(t.id)) errors.push(`${where}：id 重复`);
    ids.add(t?.id);
    if (typeof t?.description !== 'string' || !t.description.trim()) errors.push(`${where}：缺少 description`);
    if (typeof t?.effect !== 'string' || !t.effect) errors.push(`${where}：缺少 effect（只读工具写 read）`);
    if (!Array.isArray(t?.command) || !t.command.length || t.command.some((c) => typeof c !== 'string' || !c)) errors.push(`${where}：command 需要是非空的字符串数组，例如 ["node", "x.js"]`);
    const params = t?.params ?? [];
    if (!Array.isArray(params)) errors.push(`${where}：params 需要是数组`);
    else {
      const names = new Set();
      params.forEach((p) => {
        if (!ID_RE.test(p?.name ?? '')) errors.push(`${where}：参数名「${p?.name}」只能用小写字母、数字和横线（不写前面的 --）`);
        else if (names.has(p.name)) errors.push(`${where}：参数 ${p.name} 重复`);
        names.add(p?.name);
        if (p?.type !== undefined && !PARAM_TYPES.has(p.type)) errors.push(`${where}：参数 ${p?.name} 的 type 只能是 string、number、boolean`);
        if (p?.enum !== undefined && (!Array.isArray(p.enum) || !p.enum.length)) errors.push(`${where}：参数 ${p?.name} 的 enum 需要是非空数组`);
      });
    }
    for (const k of ['timeoutSec', 'maxOutputChars']) {
      if (t?.[k] !== undefined && !(Number.isFinite(t[k]) && t[k] > 0)) errors.push(`${where}：${k} 需要是正数`);
    }
    if (errors.length > before) return;
    if (t.effect !== 'read') {
      skipped.push({ id: t.id, reason: `effect 是 ${t.effect}，只开放只读（read）工具` });
      return;
    }
    tools.push({ ...t, params: params.map((p) => ({ type: 'string', required: false, ...p })), dir });
  });
  if (errors.length) throw new Error(`工具清单有误（${file}）：\n- ${errors.join('\n- ')}`);
  return { file, tools, skipped };
}

/** MCP 的 inputSchema：参数名原样作属性名。 */
export function inputSchema(tool) {
  const properties = {};
  for (const p of tool.params) {
    properties[p.name] = { type: p.type, ...(p.description ? { description: p.description } : {}), ...(p.enum ? { enum: p.enum } : {}) };
  }
  const required = tool.params.filter((p) => p.required).map((p) => p.name);
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/**
 * 把模型给的参数转成命令行参数。只认登记过的参数；值一律用 --name=value 的写法，
 * 值以「--」开头时也不会被命令当成另一个开关（例如 --sql=--confirm 仍是 --sql 的值）。
 */
export function buildArgs(tool, input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数需要是对象');
  const known = new Map(tool.params.map((p) => [p.name, p]));
  const unknown = Object.keys(input).filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`没有这些参数：${unknown.join('、')}；可用参数：${[...known.keys()].join('、') || '无'}`);
  const args = [];
  for (const p of tool.params) {
    const v = input[p.name];
    if (v === undefined || v === null || v === '') {
      if (p.required) throw new Error(`缺少必填参数 ${p.name}`);
      continue;
    }
    if (p.type === 'boolean') {
      if (typeof v !== 'boolean') throw new Error(`参数 ${p.name} 需要是 true 或 false`);
      if (v) args.push(`--${p.name}`);
      continue;
    }
    if (p.type === 'number' && !Number.isFinite(Number(v))) throw new Error(`参数 ${p.name} 需要是数字`);
    if (typeof v === 'object') throw new Error(`参数 ${p.name} 需要是${p.type === 'number' ? '数字' : '字符串'}`);
    const s = String(v);
    if (p.enum && !p.enum.map(String).includes(s)) throw new Error(`参数 ${p.name} 只能是 ${p.enum.join('、')}`);
    args.push(`--${p.name}=${s}`);
  }
  return args;
}
