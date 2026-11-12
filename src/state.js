import fs from 'node:fs';
import { claudeSessionFile } from './providers/claude-cli.js';

/**
 * 讨论状态：每场讨论结束后存进记录库 discussions.state，追问时读回来接着聊。
 *
 * 编号：记录库里最大的编号 +1（store.reserveNumber）。
 * 保留期：超过 retentionDays（默认 7 天）没有更新的讨论，删掉 Claude 会话文件、清空状态里的对话记录，
 * 标记 expired。发言、主文档等讨论记录不受影响。
 */

/** 下一个讨论编号（先在库里占一行）。 */
export function nextNumber(store, info = {}) {
  return store.reserveNumber(info);
}

export function saveState(store, state) {
  store.saveState(state);
}

/** 所有有状态的讨论：[{ state }]，按编号从大到小。 */
export function listStates(store) {
  return store.states().map(({ state }) => ({ state }));
}

/**
 * 找要追问的讨论：给了编号找那一场；否则找最近一场，且 dry-run 和正式讨论分开找，
 * 免得正式追问落到演练出来的讨论上。
 */
export function findState(store, number, { dryRun } = {}) {
  const all = listStates(store);
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

/** 删掉一场讨论用过的 Claude 会话文件（当前会话和 fresh 追问时换下来的旧会话）。 */
export function removeSessionFiles(state, sessionFile) {
  for (const s of [...Object.values(state?.sessions ?? {}), ...(state?.retiredSessions ?? [])]) {
    if (!s?.id || !sessionFile) continue;
    try {
      fs.rmSync(sessionFile(s.id), { force: true });
    } catch {
      // 已经不在了
    }
  }
}

/**
 * 清理超过保留期的会话。返回清理掉的编号。
 * claudeCwd：claude-cli 的工作目录，Claude 按它存会话文件。
 */
export function expireOldSessions(store, { retentionDays = 7, claudeCwd, now = Date.now(), sessionFile = claudeCwd ? (id) => claudeSessionFile(claudeCwd, id) : null } = {}) {
  const cleaned = [];
  for (const { state } of listStates(store)) {
    if (state.expired) continue;
    const updated = Date.parse(state.updatedAt ?? state.createdAt ?? 0);
    if (!(now - updated > retentionDays * 86400000)) continue;
    removeSessionFiles(state, sessionFile);
    store.saveState({ ...state, expired: true, expiredAt: new Date(now).toISOString(), sessions: {}, retiredSessions: [] });
    cleaned.push(state.number);
  }
  return cleaned;
}
