import fs from 'node:fs';
import path from 'node:path';

/**
 * 把旧的 runs/ 目录导进记录库：node src/cli.js migrate [--dir runs]
 *
 * 旧格式：每场讨论一个目录「<时间>-#<编号>-<议题>」，每次追问一个「<时间>-追问#<编号>-<问题>」，
 * 命令行 --mock 演练不编号「<时间>-<议题>」；目录里有 state.json、events.jsonl、usage.jsonl、result.json、
 * inbox.jsonl、tool-calls.jsonl；runs/.tools/*.jsonl 是 tools try 的调用记录。
 * transcript.md、主文档.md、附录-*.md 是从这些内容生成的，不用导。
 *
 * 每个目录导成一次运行（executions.legacy_dir 记目录名），已经导过的跳过，可以重复执行。不删除也不改动旧目录。
 * 还在进行的（run_started 的进程还活着、没有结束记录）先不导，等它结束后再执行一次；
 * 已经导过的讨论如果之后又被旧版程序追问过（state.json 的 updatedAt 比库里新），状态会同步过来。
 */
const FOLLOW_UP = /-追问#(\d+)-/;
const NUMBERED = /^\d{8}-\d{6}-#(\d+)-/;
const STAMP = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/;

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 目录名里的时间（本机时区）。 */
function stampOf(name, dir) {
  const m = STAMP.exec(name);
  if (!m) return fs.statSync(dir).mtime.toISOString();
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).toISOString();
}

const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/** 旧目录里的讨论还在进行：进程活着、没有结束记录。 */
function inProgress(dir) {
  const usage = readJsonl(path.join(dir, 'usage.jsonl'));
  const start = usage.find((r) => r.type === 'run_started');
  if (!start) return false;
  return !usage.some((r) => r.type === 'run_finished' || r.type === 'run_failed') && alive(start.pid);
}

export function migrateRuns(store, runsDir, { log = () => {}, isRunning = inProgress } = {}) {
  const out = { discussions: 0, executions: 0, posts: 0, events: 0, interjections: 0, toolCalls: 0, skipped: 0, synced: 0, running: [], problems: [] };
  if (!fs.existsSync(runsDir)) return out;
  const names = fs.readdirSync(runsDir)
    .filter((n) => !n.startsWith('.') && fs.statSync(path.join(runsDir, n)).isDirectory())
    .sort(); // 时间前缀：讨论在它的追问之前
  const done = new Set(store.db.prepare('SELECT legacy_dir FROM executions WHERE legacy_dir IS NOT NULL').all().map((r) => r.legacy_dir));

  for (const name of names) {
    if (done.has(name)) {
      out.skipped += 1;
      // 已经导过的讨论之后又被旧版程序追问过：state.json 比库里新时，把状态同步过来
      const state = FOLLOW_UP.test(name) ? null : readJson(path.join(runsDir, name, 'state.json'));
      const saved = state?.number ? store.discussion(state.number)?.state : null;
      if (state?.number && (state.updatedAt ?? '') > (saved?.updatedAt ?? '')) {
        store.saveState(state);
        out.synced += 1;
      }
      continue;
    }
    const dir = path.join(runsDir, name);
    if (isRunning(dir)) {
      out.running.push(name);
      continue;
    }
    try {
      store.tx(() => importDir(store, dir, name, out));
    } catch (err) {
      out.problems.push(`${name}：${err.message}`);
    }
  }

  // tools try 的调用记录：每个文件一次运行
  const toolsDir = path.join(runsDir, '.tools');
  if (fs.existsSync(toolsDir)) {
    for (const f of fs.readdirSync(toolsDir).filter((x) => x.endsWith('.jsonl')).sort()) {
      const legacy = `.tools/${f}`;
      if (done.has(legacy)) {
        out.skipped += 1;
        continue;
      }
      const rows = readJsonl(path.join(toolsDir, f));
      store.tx(() => {
        const startedAt = rows[0]?.time ?? fs.statSync(path.join(toolsDir, f)).mtime.toISOString();
        const execId = store.startExecution({ kind: 'tools-try', topic: null, pid: null, startedAt, legacyDir: legacy, status: 'done' });
        store.finishExecution(execId, { status: 'done', finishedAt: rows.at(-1)?.time ?? startedAt });
        for (const r of rows) store.addToolCall(execId, r);
        out.executions += 1;
        out.toolCalls += rows.length;
      });
    }
  }
  log(`导入 ${out.discussions} 场讨论、${out.executions} 次运行、${out.posts} 条发言、${out.events} 条用量事件、${out.interjections} 条插话、${out.toolCalls} 次工具调用；跳过已导入的 ${out.skipped} 个${out.synced ? `（其中 ${out.synced} 场的状态比库里新，已同步）` : ''}`);
  if (out.running.length) log(`⚠️ 这些还在进行，没有导入，结束后再执行一次 migrate：${out.running.join('、')}`);
  return out;
}

function importDir(store, dir, name, out) {
  const state = readJson(path.join(dir, 'state.json'));
  const usage = readJsonl(path.join(dir, 'usage.jsonl'));
  const posts = readJsonl(path.join(dir, 'events.jsonl'));
  const result = readJson(path.join(dir, 'result.json'));
  const inbox = readJsonl(path.join(dir, 'inbox.jsonl'));
  const tools = readJsonl(path.join(dir, 'tool-calls.jsonl'));
  const start = usage.find((r) => r.type === 'run_started');
  const follow = FOLLOW_UP.exec(name);
  const kind = follow ? 'followup' : 'discussion';
  const number = follow ? Number(follow[1]) : state?.number ?? start?.number ?? (NUMBERED.exec(name) ? Number(NUMBERED.exec(name)[1]) : null);

  if (number && !store.discussion(number)) {
    if (state?.number === number) store.saveState(state);
    else {
      // 没有 state.json（讨论没跑完）或追问找不到原讨论：用 run_started 的信息先建一行
      store.db.prepare('INSERT INTO discussions (number, mode, topic, channel, dry_run, mock, created_at, info) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        number, start?.mode ?? null, (follow ? null : start?.topic) ?? null, start?.channel ?? null, start?.dryRun ? 1 : 0, start?.mock ? 1 : 0,
        start?.at ?? stampOf(name, dir), start?.subject ? JSON.stringify({ subject: { type: start.subject.type, id: start.subject.id, title: start.subject.title } }) : null,
      );
    }
    out.discussions += 1;
  } else if (number && state?.number === number) {
    store.saveState(state); // 讨论行先由排队占位建好的情况
  }

  const end = usage.findLast((r) => r.type === 'run_finished' || r.type === 'run_failed');
  const status = end?.type === 'run_failed' ? 'failed' : end || result || (kind === 'discussion' && state) ? 'done' : 'failed';
  const startedAt = start?.at ?? posts[0]?.at ?? stampOf(name, dir);
  const execId = store.startExecution({
    number: number ?? null,
    kind,
    topic: follow ? result?.question ?? start?.topic ?? null : start?.subject?.title ?? start?.topic ?? state?.topic ?? null,
    pid: start?.pid ?? null,
    startedAt,
    legacyDir: name,
    status,
  });
  store.finishExecution(execId, {
    result: result ?? undefined,
    status,
    error: end?.type === 'run_failed' ? end.error : status === 'failed' ? '没有正常结束（迁移时没有结束记录）' : undefined,
    finishedAt: end?.at ?? usage.at(-1)?.at ?? posts.at(-1)?.at ?? startedAt,
  });
  for (const p of posts) store.addPost(execId, p, p.at ?? startedAt);
  for (const r of usage) store.addEvent(execId, { ...r, at: r.at ?? startedAt });
  // addEvent 遇到 run_started / run_finished 会改状态，最后按上面判断的结果写回
  store.db.prepare('UPDATE executions SET status = ?, pid = ? WHERE id = ?').run(status, start?.pid ?? null, execId);
  for (const m of inbox) if (m.text) store.addInterjection(execId, { at: m.at ?? startedAt, sender: m.sender, text: m.text, source: m.source ?? 'web' });
  for (const t of tools) store.addToolCall(execId, t);
  out.executions += 1;
  out.posts += posts.length;
  out.events += usage.length;
  out.interjections += inbox.length;
  out.toolCalls += tools.length;
}
