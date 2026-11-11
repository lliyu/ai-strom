import fs from 'node:fs';
import path from 'node:path';
import { claudeSessionFile } from './providers/claude-cli.js';

/**
 * 讨论状态：每场讨论结束后写 runs/<讨论>/state.json，追问时读回来接着聊。
 *
 * 编号：runs/.counter 里存最后一个编号，新讨论 +1。
 * 保留期：超过 retentionDays（默认 7 天）没有更新的讨论，删掉 Claude 会话文件、清空 state.json 里的对话记录，
 * 标记 expired。transcript.md 等讨论记录不受影响。
 */

export const STATE_FILE = 'state.json';

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** 下一个讨论编号。 */
export function nextNumber(runsDir) {
  fs.mkdirSync(runsDir, { recursive: true });
  const file = path.join(runsDir, '.counter');
  let n = 0;
  try {
    n = Number(fs.readFileSync(file, 'utf8').trim()) || 0;
  } catch {
    // 第一次
  }
  // 计数文件丢了也不重号：取已有 state.json 里的最大编号
  for (const s of listStates(runsDir)) n = Math.max(n, s.state.number ?? 0);
  fs.writeFileSync(file, String(n + 1));
  return n + 1;
}

export function saveState(runDir, state) {
  writeJsonAtomic(path.join(runDir, STATE_FILE), state);
  writeDocFiles(runDir, state);
}

export const DOC_FILE = '主文档.md';
const ATTACHMENT = /^附录-.+\.md$/;
const fileSafe = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40);

/**
 * 把最新一版主文档写成 Markdown 文件，方便在本机直接打开：主文档.md、附录-<标题>.md。
 * 历史版本只在 state.json 的 docs 里。没有主文档时不写；新版删掉的附录，对应的文件也去掉。
 */
export function writeDocFiles(runDir, state) {
  const doc = state?.docs?.at(-1);
  if (!doc?.text) return;
  fs.writeFileSync(path.join(runDir, DOC_FILE), `${doc.text.trim()}\n`);
  const keep = new Set();
  for (const [title, text] of Object.entries(doc.attachments ?? {})) {
    const name = `附录-${fileSafe(title)}.md`;
    keep.add(name);
    fs.writeFileSync(path.join(runDir, name), `# ${title}\n\n${text.trim()}\n`);
  }
  for (const name of fs.readdirSync(runDir)) {
    if (ATTACHMENT.test(name) && !keep.has(name)) fs.unlinkSync(path.join(runDir, name));
  }
}

/** 所有有 state.json 的讨论：[{ dir, state }]，按编号从大到小。 */
export function listStates(runsDir) {
  if (!fs.existsSync(runsDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(runsDir)) {
    const file = path.join(runsDir, name, STATE_FILE);
    if (!fs.existsSync(file)) continue;
    try {
      out.push({ dir: path.join(runsDir, name), state: JSON.parse(fs.readFileSync(file, 'utf8')) });
    } catch {
      // 损坏的文件跳过
    }
  }
  return out.sort((a, b) => (b.state.number ?? 0) - (a.state.number ?? 0));
}

/**
 * 找要追问的讨论：给了编号找那一场；否则找最近一场，且 dry-run 和正式讨论分开找，
 * 免得正式追问落到演练出来的讨论上。
 */
export function findState(runsDir, number, { dryRun } = {}) {
  const all = listStates(runsDir);
  if (number == null) {
    // 「最近一场」只在群里的讨论里找：网页上的打磨（refine）、网页上自选阵容的讨论和 mock 演练不算
    const candidates = all.filter((s) => s.state.mode !== 'refine' && !s.state.lineup && !s.state.mock);
    const same = dryRun === undefined ? candidates : candidates.filter((s) => Boolean(s.state.dryRun) === Boolean(dryRun));
    if (!same.length) throw new Error(`还没有可以追问的${dryRun ? ' dry-run ' : ''}讨论`);
    return same[0];
  }
  if (!all.length) throw new Error('还没有可以追问的讨论');
  const hit = all.find((s) => s.state.number === Number(number));
  if (!hit) throw new Error(`找不到讨论 #${number}。最近的几场：${all.slice(0, 5).map((s) => `#${s.state.number}`).join('、')}`);
  return hit;
}

/**
 * 清理超过保留期的会话。返回清理掉的编号。
 * claudeCwd：claude-cli 的工作目录，Claude 按它存会话文件。
 */
export function expireOldSessions(runsDir, { retentionDays = 7, claudeCwd, now = Date.now(), sessionFile = (id) => claudeSessionFile(claudeCwd, id) } = {}) {
  const cleaned = [];
  for (const { dir, state } of listStates(runsDir)) {
    if (state.expired) continue;
    const updated = Date.parse(state.updatedAt ?? state.createdAt ?? 0);
    if (!(now - updated > retentionDays * 86400000)) continue;
    for (const s of Object.values(state.sessions ?? {})) {
      if (s.id && (claudeCwd || sessionFile)) {
        try {
          fs.rmSync(sessionFile(s.id), { force: true });
        } catch {
          // 已经不在了
        }
      }
    }
    saveState(dir, { ...state, expired: true, expiredAt: new Date(now).toISOString(), sessions: {} });
    cleaned.push(state.number);
  }
  return cleaned;
}
