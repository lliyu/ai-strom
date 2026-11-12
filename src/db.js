import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 讨论记录库（SQLite，一个文件，默认 local/ai-storm.db，不进仓库）。
 *
 *   discussions    一场讨论：编号、模式、议题、渠道，以及完整状态（state，JSON：会话、主文档各版本、追问……）
 *   executions     一次运行：讨论本身（discussion）、一次追问（followup）、tools try；进度、进程号、结果
 *   posts          发言（网页和 Lark 上看到的每张卡片）
 *   events         用量事件：run_started、call_started、call_finished……（klook-console 读这张表）
 *   interjections  网页插话：跑讨论的进程每轮开始时读新增的
 *   tool_calls     数据工具调用（命令行工具网关写入）
 *
 * Lark 监听、网页、命令行和工具网关是不同进程，同时读写同一个文件：用 WAL，写冲突时等最多 5 秒。
 * JSON 列存整行原始数据，常用的字段另抽成列便于查询。
 */

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS discussions (
  number      INTEGER PRIMARY KEY,
  mode        TEXT,
  topic       TEXT,
  channel     TEXT,
  dry_run     INTEGER NOT NULL DEFAULT 0,
  mock        INTEGER NOT NULL DEFAULT 0,
  expired     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT,
  archived_at TEXT,
  info        TEXT,
  state       TEXT
);
CREATE TABLE IF NOT EXISTS executions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      INTEGER REFERENCES discussions(number) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  topic       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running',
  error       TEXT,
  pid         INTEGER,
  result      TEXT,
  legacy_dir  TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS executions_number ON executions(number);
CREATE TABLE IF NOT EXISTS posts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  exec_id  INTEGER NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  at       TEXT NOT NULL,
  speaker  TEXT,
  title    TEXT,
  subtitle TEXT,
  brief    TEXT,
  body     TEXT,
  plan     TEXT,
  footer   TEXT,
  meta     TEXT
);
CREATE INDEX IF NOT EXISTS posts_exec ON posts(exec_id, id);
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  exec_id INTEGER NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  at      TEXT NOT NULL,
  type    TEXT NOT NULL,
  speaker TEXT,
  stage   TEXT,
  round   INTEGER,
  data    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_exec ON events(exec_id, id);
CREATE TABLE IF NOT EXISTS interjections (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  exec_id INTEGER NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  at      TEXT NOT NULL,
  sender  TEXT,
  text    TEXT NOT NULL,
  source  TEXT
);
CREATE INDEX IF NOT EXISTS interjections_exec ON interjections(exec_id, id);
CREATE TABLE IF NOT EXISTS tool_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  exec_id     INTEGER REFERENCES executions(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  source      TEXT,
  tool        TEXT,
  ok          INTEGER,
  duration_ms INTEGER,
  data        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_exec ON tool_calls(exec_id, id);
`;

const now = () => new Date().toISOString();
const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = (s) => {
  if (s === null || s === undefined) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const bool = (v) => (v ? 1 : 0);
const plain = (row) => (row ? { ...row } : row); // node:sqlite 返回的行没有原型，转成普通对象

/** 打开（没有就建）记录库。file 为 ':memory:' 时只在内存里，测试用。 */
export function openStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));

  const cache = new Map();
  const q = (sql) => {
    let st = cache.get(sql);
    if (!st) {
      st = db.prepare(sql);
      cache.set(sql, st);
    }
    return st;
  };
  // 事务可以嵌套：外层已经开了事务时，里面的直接执行（迁移时整个目录一个事务）
  let depth = 0;
  const tx = (fn) => {
    if (depth > 0) return fn();
    db.exec('BEGIN IMMEDIATE');
    depth += 1;
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      depth -= 1;
    }
  };

  const discussionRow = (r) => r && { ...plain(r), dry_run: Boolean(r.dry_run), mock: Boolean(r.mock), expired: Boolean(r.expired), info: parse(r.info), state: parse(r.state) };
  const execRow = (r) => r && { ...plain(r), result: parse(r.result) };

  const store = {
    file,
    db,
    tx,

    // ---------- 讨论 ----------

    /** 分一个新编号，先占一行（网页排队时页面就能看到这场讨论）。 */
    reserveNumber({ mode = null, topic = null, channel = null, info = null } = {}) {
      return tx(() => {
        const n = (q('SELECT MAX(number) AS n FROM discussions').get().n ?? 0) + 1;
        q('INSERT INTO discussions (number, mode, topic, channel, created_at, info) VALUES (?, ?, ?, ?, ?, ?)').run(n, mode, topic, channel, now(), json(info));
        return n;
      });
    },

    /** 讨论结束或追问后写回完整状态；没有这一行时补上（迁移、直接调用时）。 */
    saveState(state) {
      if (!state?.number) throw new Error('state 里没有编号，不能保存');
      const at = now();
      q(`INSERT INTO discussions (number, mode, topic, channel, dry_run, mock, expired, created_at, updated_at, state)
         VALUES (@number, @mode, @topic, @channel, @dry, @mock, @expired, @created, @updated, @state)
         ON CONFLICT(number) DO UPDATE SET mode = excluded.mode, topic = excluded.topic, channel = COALESCE(excluded.channel, discussions.channel),
           dry_run = excluded.dry_run, mock = excluded.mock, expired = excluded.expired, updated_at = excluded.updated_at, state = excluded.state`).run({
        number: state.number,
        mode: state.mode ?? null,
        topic: state.topic ?? null,
        channel: state.channel ?? null,
        dry: bool(state.dryRun),
        mock: bool(state.mock),
        expired: bool(state.expired),
        created: state.createdAt ?? at,
        updated: state.updatedAt ?? at,
        state: JSON.stringify(state),
      });
    },

    discussion(number) {
      return discussionRow(q('SELECT * FROM discussions WHERE number = ?').get(Number(number)));
    },

    /** 有状态（讨论已结束）的讨论，编号从大到小。 */
    states() {
      return q('SELECT number, state FROM discussions WHERE state IS NOT NULL ORDER BY number DESC').all()
        .map((r) => ({ number: r.number, state: parse(r.state) }))
        .filter((r) => r.state);
    },

    /**
     * 列表：q 搜编号、议题和发言内容；mode 模式；since 创建时间下限（ISO）；archived 为 true 时只看归档的，默认不含归档。
     */
    discussions({ q: text, mode, since, archived = false } = {}) {
      const where = [archived ? 'd.archived_at IS NOT NULL' : 'd.archived_at IS NULL'];
      const args = {};
      if (mode) {
        where.push('d.mode = @mode');
        args.mode = mode;
      }
      if (since) {
        where.push('d.created_at >= @since');
        args.since = since;
      }
      if (text) {
        // 「#12」或「12」也按编号找
        const num = /^#?(\d+)$/.exec(String(text).trim())?.[1];
        args.num = num ? Number(num) : -1;
        where.push(`(d.number = @num OR d.topic LIKE @like ESCAPE '\\' OR d.info LIKE @like ESCAPE '\\' OR EXISTS (
          SELECT 1 FROM posts p JOIN executions e ON e.id = p.exec_id WHERE e.number = d.number AND (p.body LIKE @like ESCAPE '\\' OR p.title LIKE @like ESCAPE '\\')))`);
        args.like = `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      }
      return db.prepare(`SELECT d.* FROM discussions d WHERE ${where.join(' AND ')} ORDER BY d.number DESC`).all(args).map(discussionRow);
    },

    setArchived(number, archived) {
      return q('UPDATE discussions SET archived_at = ? WHERE number = ?').run(archived ? now() : null, Number(number)).changes > 0;
    },

    /** 删除一场讨论和它的全部记录（发言、用量、插话、工具调用）。 */
    deleteDiscussion(number) {
      return q('DELETE FROM discussions WHERE number = ?').run(Number(number)).changes > 0;
    },

    // ---------- 运行 ----------

    /** kind：discussion | followup | tools-try。number 可以没有（命令行 --mock 演练、tools try）。 */
    startExecution({ number = null, kind, topic = null, pid = process.pid, startedAt = now(), legacyDir = null, status = 'running' }) {
      return Number(q('INSERT INTO executions (number, kind, topic, started_at, pid, legacy_dir, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(number, kind, topic, startedAt, pid, legacyDir, status).lastInsertRowid);
    },

    finishExecution(id, { result, status, error, finishedAt } = {}) {
      q(`UPDATE executions SET result = COALESCE(?, result), status = COALESCE(?, status), error = COALESCE(?, error),
           finished_at = COALESCE(finished_at, ?) WHERE id = ?`).run(json(result), status ?? null, error ?? null, finishedAt ?? now(), id);
    },

    execution(id) {
      return execRow(q('SELECT * FROM executions WHERE id = ?').get(id));
    },

    /**
     * 一场讨论的全部运行，按开始时间排（讨论本身在前，追问按时间排）。
     * 不按 id 排：补导的旧目录 id 在最后，按 id 排追问编号会错位，插话和进度也会看错运行。
     */
    executionsOf(number) {
      return q('SELECT * FROM executions WHERE number = ? ORDER BY started_at, id').all(Number(number)).map(execRow);
    },

    executions({ limit = 200 } = {}) {
      return q('SELECT * FROM executions ORDER BY id DESC LIMIT ?').all(limit).map(execRow);
    },

    // ---------- 发言、用量、插话、工具调用 ----------

    addPost(execId, msg, at = now()) {
      return Number(q('INSERT INTO posts (exec_id, at, speaker, title, subtitle, brief, body, plan, footer, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        execId, at, msg.speaker?.id ?? msg.speaker ?? null, msg.title ?? null, msg.subtitle ?? null, msg.brief ?? null,
        msg.body ?? null, msg.plan ?? null, msg.footer ?? null, json(msg.meta),
      ).lastInsertRowid);
    },

    /** 一组运行的发言，按顺序；afterId 只要更新的。 */
    posts(execIds, afterId = 0) {
      if (!execIds.length) return [];
      const marks = execIds.map(() => '?').join(',');
      return db.prepare(`SELECT * FROM posts WHERE exec_id IN (${marks}) AND id > ? ORDER BY id`).all(...execIds, afterId)
        .map((r) => ({ ...plain(r), meta: parse(r.meta) }));
    },

    /** 用量事件。run_started 记进程号，run_finished / run_failed 顺带更新运行状态。 */
    addEvent(execId, row) {
      const at = row.at ?? now();
      tx(() => {
        q('INSERT INTO events (exec_id, at, type, speaker, stage, round, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          execId, at, row.type, row.speaker ?? null, row.stage ?? null, Number.isFinite(row.round) ? row.round : null, JSON.stringify({ ...row, at }),
        );
        if (row.type === 'run_started' && row.pid) q('UPDATE executions SET pid = ? WHERE id = ?').run(row.pid, execId);
        if (row.type === 'run_finished') q("UPDATE executions SET status = 'done', finished_at = ? WHERE id = ?").run(at, execId);
        if (row.type === 'run_failed') q("UPDATE executions SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(row.error ?? null, at, execId);
      });
    },

    /** 一次运行的 run_started（参与者、模式、渠道……）。 */
    startEvent(execId) {
      return parse(q("SELECT data FROM events WHERE exec_id = ? AND type = 'run_started' ORDER BY id LIMIT 1").get(execId)?.data);
    },

    events(execId) {
      return q('SELECT data FROM events WHERE exec_id = ? ORDER BY id').all(execId).map((r) => parse(r.data)).filter(Boolean);
    },

    addInterjection(execId, { at = now(), sender, text, source = 'web' }) {
      return Number(q('INSERT INTO interjections (exec_id, at, sender, text, source) VALUES (?, ?, ?, ?, ?)').run(execId, at, sender ?? null, text, source).lastInsertRowid);
    },

    interjections(execId, afterId = 0) {
      return q('SELECT * FROM interjections WHERE exec_id = ? AND id > ? ORDER BY id').all(execId, afterId).map(plain);
    },

    addToolCall(execId, record) {
      const at = record.time ?? record.at ?? now();
      const ok = record.rejected || record.error || record.timedOut ? 0 : record.exitCode === undefined ? null : bool(record.exitCode === 0);
      q('INSERT INTO tool_calls (exec_id, at, source, tool, ok, duration_ms, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        execId ?? null, at, record.source ?? null, record.tool ?? null, ok, Number.isFinite(record.durationMs) ? record.durationMs : null, JSON.stringify(record),
      );
    },

    toolCalls(execId) {
      return q('SELECT data FROM tool_calls WHERE exec_id IS ? ORDER BY id').all(execId ?? null).map((r) => parse(r.data)).filter(Boolean);
    },

    close() {
      db.close();
    },
  };
  return store;
}

const opened = new Map();

/** 同一进程里同一个文件只开一次。 */
export function sharedStore(file) {
  let s = opened.get(file);
  if (!s) {
    s = openStore(file);
    opened.set(file, s);
  }
  return s;
}
