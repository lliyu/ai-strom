import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 代码上下文：把群指令里的仓库别名解析成本机目录，交给调研员只读查看。
 *
 * config.json：
 *   repos:      { 别名: { path, description, docs: [目录或文件] } }
 *   repoGroups: { 组名: { description, repos: [别名], docs: [目录或文件] } }
 *
 * 指令里写「仓库:fission,pricing@develop」：组展开成成员仓；@ 后面是分支、tag 或 commit。
 * 不写 @ 时读本机工作区（当前分支 + 未提交改动）；写了就把那个版本导出到临时目录再读。
 * 指令里没写仓库时，把全部登记的仓库交给调研员，由它按议题自己定位（auto）；写「仓库:无」不读代码。
 */

const SPEC_RE = /^[\w.\-]+(?:@[\w.\-/]+)?$/;
export const NO_REPOS_RE = /^(?:无|不读|none|no)$/i;

/** 「fission,pricing@develop」→ [{ name: 'fission' }, { name: 'pricing', ref: 'develop' }]；「无」→ [] */
export function parseRepoSpecs(input) {
  const list = (Array.isArray(input) ? input : String(input ?? '').split(/[,，\s]+/)).map((s) => String(s).trim()).filter(Boolean);
  if (list.length === 1 && NO_REPOS_RE.test(list[0])) return [];
  return list.map((s) => {
    if (!SPEC_RE.test(s)) throw new Error(`仓库写法不对：${s}（应为 别名 或 别名@分支）`);
    const at = s.indexOf('@');
    return at < 0 ? { name: s } : { name: s.slice(0, at), ref: s.slice(at + 1) };
  });
}

/** 全部登记的组和仓库，给 auto 模式用：组在前，这样各组的参考资料也会带上。 */
export function allRepoSpecs(cfg) {
  return [...Object.keys(cfg.repoGroups ?? {}), ...Object.keys(cfg.repos ?? {})].map((name) => ({ name }));
}

/** 列出可用的别名（给帮助和报错用）。 */
export function availableRepos(cfg) {
  return {
    repos: Object.keys(cfg.repos ?? {}),
    groups: Object.keys(cfg.repoGroups ?? {}),
  };
}

/**
 * 把别名和组解析成仓库列表与参考资料目录。未知别名抛错并列出可用的。
 * 同一个仓库出现多次时只保留第一次（带 ref 的优先）。
 */
export function resolveRepos(cfg, specs) {
  const repos = cfg.repos ?? {};
  const groups = cfg.repoGroups ?? {};
  const out = new Map();
  const docs = [];
  const groupsUsed = [];
  const unknown = [];
  const addDocs = (list) => {
    for (const d of list ?? []) if (!docs.includes(d)) docs.push(d);
  };
  const addRepo = (alias, ref) => {
    const r = repos[alias];
    const prev = out.get(alias);
    if (prev && (prev.ref || !ref)) return;
    out.set(alias, { alias, path: r.path, description: r.description ?? '', ref: ref ?? null });
    addDocs(r.docs);
  };
  for (const { name, ref } of specs) {
    if (repos[name]) {
      addRepo(name, ref);
    } else if (groups[name]) {
      groupsUsed.push(name);
      addDocs(groups[name].docs);
      for (const alias of groups[name].repos ?? []) addRepo(alias, ref);
    } else {
      unknown.push(name);
    }
  }
  if (unknown.length) {
    const { repos: r, groups: g } = availableRepos(cfg);
    throw new Error(`没有登记的仓库：${unknown.join('、')}。可用的组：${g.join('、') || '无'}；可用的仓库：${r.join('、') || '无'}`);
  }
  return { repos: [...out.values()], docs, groups: groupsUsed };
}

/**
 * 准备只读目录：校验路径，记录分支、commit 与未提交改动；指定了 ref 的导出到临时目录。
 * 返回 { repos: [{ alias, description, path, readPath, ref, branch, commit, dirty, snapshot }], docs, dirs, cleanup }。
 */
export function prepareRepos(resolved, { tmpRoot = os.tmpdir(), git = defaultGit, skipMissing = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'ai-storm-repos-'));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  const skipped = [];
  try {
    // auto 模式下某个仓库目录不在了就跳过，不让整场讨论失败
    // 不跳过时保留下来，由后面的检查报出「目录不存在」
    const present = (p) => {
      if (!skipMissing || fs.existsSync(p)) return true;
      skipped.push(p);
      return false;
    };
    const repos = resolved.repos.filter((r) => present(r.path)).map((r) => {
      if (!fs.existsSync(r.path)) throw new Error(`仓库 ${r.alias} 的目录不存在：${r.path}`);
      if (!isGitRepo(git, r.path)) {
        return { ...r, readPath: r.path, branch: null, commit: null, dirty: 0, snapshot: false };
      }
      const branch = git(r.path, ['branch', '--show-current']).trim() || null;
      const head = git(r.path, ['rev-parse', '--short', 'HEAD']).trim();
      if (!r.ref) {
        const dirty = git(r.path, ['status', '--porcelain']).split('\n').filter(Boolean).length;
        return { ...r, readPath: r.path, branch, commit: head, dirty, snapshot: false };
      }
      const commit = resolveRef(git, r.path, r.ref);
      const dest = path.join(tmp, r.alias);
      fs.mkdirSync(dest);
      exportTree(r.path, commit, dest);
      return { ...r, readPath: dest, branch, commit: commit.slice(0, 9), dirty: 0, snapshot: true };
    });
    const docs = resolved.docs.filter(present).map((d) => {
      if (!fs.existsSync(d)) throw new Error(`参考资料不存在：${d}`);
      return d;
    });
    const dirs = [...new Set([
      ...repos.map((r) => r.readPath),
      ...docs.map((d) => (fs.statSync(d).isDirectory() ? d : path.dirname(d))),
    ])];
    return { repos, docs, groups: resolved.groups ?? [], dirs, skipped, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

function isGitRepo(git, dir) {
  try {
    return git(dir, ['rev-parse', '--show-toplevel']).trim() === fs.realpathSync(dir);
  } catch {
    return false;
  }
}

/** 先按本地分支、tag、commit 找，找不到再试 origin/<ref>。不做 fetch。 */
function resolveRef(git, dir, ref) {
  for (const candidate of [ref, `origin/${ref}`]) {
    try {
      return git(dir, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]).trim();
    } catch {
      // 试下一个
    }
  }
  throw new Error(`仓库 ${path.basename(dir)} 里找不到 ${ref}（也没有 origin/${ref}）。需要的话先在本机 git fetch`);
}

function exportTree(dir, commit, dest) {
  // 参数用位置变量传给 sh，不拼进命令字符串
  execFileSync('sh', ['-c', 'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"', 'sh', dir, commit, dest], {
    stdio: ['ignore', 'ignore', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function defaultGit(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 一行说明：fission（酒店价格计算）feature/x @ abc123，3 个未提交改动 */
export function describeRepo(r) {
  const where = r.snapshot
    ? `${r.ref} @ ${r.commit}`
    : r.commit ? `${r.branch ?? '(detached)'} @ ${r.commit}${r.dirty ? `，${r.dirty} 个未提交改动` : ''}` : '非 git 目录';
  return `${r.alias}${r.description ? `（${r.description}）` : ''}：${where}`;
}
