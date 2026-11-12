import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './tools/index.js';

/**
 * 知识来源：给调研员、核实员读的业务知识目录（Markdown）。可以登记多个：
 *   knowledge.<名字> = { path, index?: [索引文件], description? }
 *   - path：目录，绝对路径、~/ 或相对 ai-storm 目录
 *   - index：索引文件（相对 path），默认 ["INDEX.md"]；索引内容写进提示词，其余文档由模型按需用 Read/Grep 打开
 * 「local」固定指 ai-storm 自己维护的 local/knowledge（不进仓库），没登记也会加上；其他来源（例如 insight 的领域知识）
 * 只读，ai-storm 从不写入。
 */
export const LOCAL_SOURCE = 'local';
export const DEFAULT_LOCAL_PATH = 'local/knowledge';
export const INDEX_MAX_CHARS = 12000;
const NAME_RE = /^[\w.-]+$/;

const resolvePath = (p) => {
  const expanded = p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
  return path.isAbsolute(expanded) ? expanded : path.join(ROOT, expanded);
};

export function normalizeKnowledge(cfg, errors) {
  const raw = cfg.knowledge ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('knowledge 需要是对象：{ 名字: { path, index, description } }');
    cfg.knowledge = {};
    return;
  }
  const out = {};
  for (const [name, s] of Object.entries(raw)) {
    const where = `knowledge.${name}`;
    if (!NAME_RE.test(name)) errors.push(`${where}：名字只能用字母、数字、点、横线和下划线`);
    if (typeof s?.path !== 'string' || !s.path) {
      errors.push(`${where}：缺少 path`);
      continue;
    }
    const index = s.index ?? ['INDEX.md'];
    if (!Array.isArray(index) || index.some((f) => typeof f !== 'string' || !f || path.isAbsolute(f) || f.split(/[\\/]/).includes('..'))) {
      errors.push(`${where}：index 需要是相对 path 的文件列表，例如 ["INDEX.md"]`);
      continue;
    }
    out[name] = { path: resolvePath(s.path), index, description: s.description ?? '' };
  }
  out[LOCAL_SOURCE] ??= { path: resolvePath(DEFAULT_LOCAL_PATH), index: ['INDEX.md'], description: 'ai-storm 自己维护的知识（不进仓库）' };
  cfg.knowledge = out;
}

/** 每个来源的现状：目录在不在、索引文件、Markdown 文档数。 */
export function inspectKnowledge(knowledge) {
  return Object.entries(knowledge).map(([name, s]) => {
    const exists = fs.existsSync(s.path) && fs.statSync(s.path).isDirectory();
    const indexes = s.index.map((f) => {
      const file = path.join(s.path, f);
      return { file: f, exists: exists && fs.existsSync(file), chars: exists && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').length : 0 };
    });
    return { name, ...s, exists, indexes, docs: exists ? countMarkdown(s.path) : 0 };
  });
}

function countMarkdown(dir, depth = 0) {
  if (depth > 6) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    if (e.isDirectory()) n += countMarkdown(path.join(dir, e.name), depth + 1);
    else if (e.name.endsWith('.md')) n += 1;
  }
  return n;
}

/**
 * 一次调用要带的知识：可读目录（交给 --add-dir）和写进提示词的说明（来源、索引内容、读法与冲突规则）。
 * names 不给时用全部来源；目录不存在的来源跳过。
 */
export function knowledgeSetup(knowledge, names) {
  const picked = (names ?? Object.keys(knowledge)).filter((n) => knowledge[n]);
  const sources = inspectKnowledge(Object.fromEntries(picked.map((n) => [n, knowledge[n]])));
  const usable = sources.filter((s) => s.exists);
  const skipped = sources.filter((s) => !s.exists).map((s) => ({ name: s.name, reason: `目录不存在：${s.path}` }));
  if (!usable.length) return { dirs: [], block: '', sources: [], skipped };
  const parts = usable.map((s) => {
    const indexText = s.indexes.filter((i) => i.exists).map((i) => {
      let text = fs.readFileSync(path.join(s.path, i.file), 'utf8').trim();
      if (text.length > INDEX_MAX_CHARS) text = `${text.slice(0, INDEX_MAX_CHARS)}\n…（索引超过 ${INDEX_MAX_CHARS} 字，后面的部分没放进来，需要时用 Read 打开 ${i.file}）`;
      return `#### ${i.file}\n${text}`;
    });
    const head = `### 来源「${s.name}」${s.description ? `：${s.description}` : ''}\n目录：${s.path}（${s.docs} 篇文档）`;
    return indexText.length ? `${head}\n\n${indexText.join('\n\n')}` : `${head}\n（没有索引文件，用 Glob 列出 *.md 再挑着读）`;
  });
  const block = [
    '**业务知识**（之前核实过的业务事实和排查方法，只读）',
    '',
    '读法：',
    '- 先看下面各来源的索引，按需用 Read / Grep 打开具体文档；索引里的链接相对于索引文件所在的目录。',
    '- 引用知识时写「来源名:相对路径」，例如 local:hotel/time-fields.md。',
    '- 知识可能过时：和代码、实时数据不一致时以实时证据为准，并写明「知识库的说法与实测不一致」以及两边各是什么。',
    '- 不同来源说法冲突时两边都列出来，写明冲突，不要自己挑一边。',
    '',
    ...parts,
  ].join('\n');
  return { dirs: usable.map((s) => s.path), block, sources: usable.map((s) => s.name), skipped };
}
