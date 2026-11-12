import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 记忆：跨讨论带着走的背景和结论，分工作、个人、小说三个域，都是 Markdown 文件（默认 local/memory，不进仓库）：
 *   <域>/profile.md      档案：你自己写的背景（身份、偏好、长期约束……），ai-storm 只读
 *   <域>/conclusions.md  结论：讨论或快问结束后，你在结论页勾选确认才追加，一行一条，带来源讨论和日期
 * 发起时按域勾选，默认只带一个域（不跨域）。选中的域限长放全文进共用的系统提示词：所有模型（包括走接口、
 * 读不了本机文件的）都能看到，整场不变、缓存能命中。没确认的结论不会写进来；网页上能查看和删除结论。
 */

export const MEMORY_DOMAINS = [
  { id: 'work', label: '工作' },
  { id: 'personal', label: '个人' },
  { id: 'novel', label: '小说' },
];
const LABEL = Object.fromEntries(MEMORY_DOMAINS.map((d) => [d.id, d.label]));
export const isDomain = (id) => Boolean(LABEL[id]);
export const domainLabel = (id) => LABEL[id] ?? id;

/** 每个域放进提示词的上限：档案最多占一半，剩下的按新到旧放结论。 */
export const MEMORY_MAX_CHARS = 4000;
/** 一条结论最长多少字。 */
export const ENTRY_MAX_CHARS = 300;

const ENTRY = /^- (.+?) （(#\d+|手工)，(\d{4}-\d{2}-\d{2})）<!-- m:([0-9a-f]{8}) -->\s*$/;
const HEAD = '# 已确认的结论\n\n由 ai-storm 在你确认后追加，一行一条（新的在后）。可以手工删改，保持每行的格式即可。\n';

const files = (dir, id) => ({ dir: path.join(dir, id), profile: path.join(dir, id, 'profile.md'), conclusions: path.join(dir, id, 'conclusions.md') });
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

/** 一个域的结论：[{ id, text, source, at }]，按文件里的顺序（旧的在前）。格式不对的行忽略。 */
export function readEntries(dir, id) {
  if (!dir || !isDomain(id)) return [];
  return read(files(dir, id).conclusions).split('\n').map((l) => ENTRY.exec(l)).filter(Boolean)
    .map((m) => ({ id: m[4], text: m[1], source: m[2], at: m[3] }));
}

/** 各域现状：档案字数和全文、结论列表。dir 为空（例如跑测试没指定）时记忆不可用。 */
export function listMemory(dir) {
  return MEMORY_DOMAINS.map((d) => {
    const f = dir ? files(dir, d.id) : null;
    const profile = f ? read(f.profile).trim() : '';
    return { ...d, path: f?.dir ?? null, profile, entries: f ? readEntries(dir, d.id) : [] };
  });
}

/** 一条结论规整成一行：去掉列表符号、合并换行、限长。 */
export function cleanEntry(text) {
  const t = String(text ?? '').replace(/^\s*(?:[-*+•]\s+|\d+[.、)）]\s*)/, '').replace(/\s*\n\s*/g, ' ').replace(/<!--.*?-->/g, '').replace(/\*\*/g, '').trim();
  return t.length > ENTRY_MAX_CHARS ? `${t.slice(0, ENTRY_MAX_CHARS)}…` : t;
}

/**
 * 追加结论（只在人确认后调用）：同一个域里一模一样的不重复写。source 是「#编号」。
 * 返回 { saved: [新写的条目], skipped: [重复的文本] }。
 */
export function appendEntries(dir, id, texts, { source, now = new Date() } = {}) {
  if (!dir) throw new Error('记忆目录没有配置');
  if (!isDomain(id)) throw new Error(`没有「${id}」这个记忆域`);
  const existing = new Set(readEntries(dir, id).map((e) => e.text));
  const at = now.toISOString().slice(0, 10);
  const saved = [];
  const skipped = [];
  for (const raw of texts) {
    const text = cleanEntry(raw);
    if (!text) continue;
    if (existing.has(text)) {
      skipped.push(text);
      continue;
    }
    existing.add(text);
    saved.push({ id: randomBytes(4).toString('hex'), text, source: /^#\d+$/.test(source ?? '') ? source : '手工', at });
  }
  if (saved.length) {
    const f = files(dir, id);
    fs.mkdirSync(f.dir, { recursive: true });
    const before = read(f.conclusions);
    const lines = saved.map((e) => `- ${e.text} （${e.source}，${e.at}）<!-- m:${e.id} -->`).join('\n');
    fs.writeFileSync(f.conclusions, `${before || HEAD}${before && !before.endsWith('\n') ? '\n' : ''}${lines}\n`);
  }
  return { saved, skipped };
}

/** 删掉一条结论。返回是否删到了。 */
export function deleteEntry(dir, id, entryId) {
  if (!dir || !isDomain(id)) return false;
  const file = files(dir, id).conclusions;
  const lines = read(file).split('\n');
  const keep = lines.filter((l) => ENTRY.exec(l)?.[4] !== entryId);
  if (keep.length === lines.length) return false;
  fs.writeFileSync(file, keep.join('\n'));
  return true;
}

/**
 * 这次讨论要带的记忆：选中的各域限长拼成一段，放进共用的系统提示词。
 * 返回 { block, domains: [{ id, label, profileChars, entries, omitted }] }；什么都没有时 block 为空。
 */
export function memorySetup(dir, ids = [], { maxChars = MEMORY_MAX_CHARS } = {}) {
  const picked = [...new Set(ids)].filter(isDomain);
  const parts = [];
  const domains = [];
  for (const id of picked) {
    const profileRaw = dir ? read(files(dir, id).profile).trim() : '';
    const half = Math.floor(maxChars / 2);
    const profile = profileRaw.length > half ? `${profileRaw.slice(0, half)}\n…（档案超过 ${half} 字，后面的没放进来）` : profileRaw;
    let left = maxChars - profile.length;
    const kept = [];
    const all = readEntries(dir, id);
    for (const e of [...all].reverse()) {
      const line = `- ${e.text}（${e.source}，${e.at}）`;
      if (line.length + 1 > left) break;
      kept.push(line);
      left -= line.length + 1;
    }
    if (!profile && !kept.length) continue;
    domains.push({ id, label: domainLabel(id), profileChars: profile.length, entries: kept.length, omitted: all.length - kept.length });
    parts.push([
      `### ${domainLabel(id)}`,
      profile ? `**档案**\n${profile}` : '',
      kept.length ? `**之前确认过的结论**（新的在前${all.length > kept.length ? `，更早的 ${all.length - kept.length} 条放不下，没放进来` : ''}）\n${kept.join('\n')}` : '',
    ].filter(Boolean).join('\n\n'));
  }
  if (!parts.length) return { block: '', domains };
  return {
    block: `## 提问人的记忆（之前确认过的背景和结论，只作参考；和这次的问题、材料或实时证据冲突时以这次为准，并指出冲突）\n\n${parts.join('\n\n')}`,
    domains,
  };
}

/** 从文档的「可存入知识库的结论」段里取出各条；写「无」时为空。 */
export function memoCandidates(text) {
  return String(text ?? '').split('\n')
    .filter((l) => /^\s*(?:[-*+•]\s+|\d+[.、)）]\s*)\S/.test(l))
    .map(cleanEntry)
    .filter((t) => t && !/^[（(]?无[)）。.]?$/.test(t));
}
