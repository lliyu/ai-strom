import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './config.js';
import { createProviderRegistry } from './providers/index.js';
import { createLarkPublisher, createConsolePublisher, createTranscriptPublisher, combinePublishers } from './publishers.js';
import { createInterjectionReader } from './lark/interjections.js';
import { runDiscussion, runFollowUp } from './orchestrator.js';
import { nextNumber, saveState, findState, expireOldSessions } from './state.js';
import { DEFAULT_CLAUDE_CWD } from './providers/claude-cli.js';
import { isTrigger, DEFAULT_TRIGGERS } from './watch.js';
import { describeRepo, resolveRepos, prepareRepos, allRepoSpecs } from './repos.js';

/**
 * 跑一场讨论或一次追问：命令行（discuss / followup）、Lark 监听（watch）和本地网页（web）共用。
 * 发到哪里由调用方决定：默认发 Lark（dryRun 时打印到终端）；网页传 lark: false，
 * 再通过 extraPublishers / interjections 接上自己的发布者和插话来源。
 */

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const log = (s) => process.stderr.write(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · ${s}\n`);

export const RUNS = path.join(ROOT, 'runs');
const retention = (cfg) => ({ retentionDays: cfg.sessionRetentionDays ?? 7, claudeCwd: cfg.providers['claude-cli']?.cwd ?? DEFAULT_CLAUDE_CWD });

/** 清理超过保留期的会话（每次讨论、追问、watch 启动时顺手做）。 */
export function cleanupSessions(cfg, runsDir = RUNS) {
  try {
    const cleaned = expireOldSessions(runsDir, retention(cfg));
    if (cleaned.length) log(`已清理超过 ${retention(cfg).retentionDays} 天的会话：${cleaned.map((n) => `#${n}`).join('、')}`);
  } catch (err) {
    log(`⚠️ 清理过期会话失败：${err.message}`);
  }
}

/** 讨论和追问共用：本地记录、Lark/终端发布、插话读取、usage.jsonl。 */
function setupRun(cfg, { runDir, dryRun, mock, interject, triggers, echo = true, lark: toLark = true, extraPublishers = [], interjections: ownInterjections, onEvent: watcher }) {
  const transcript = createTranscriptPublisher(runDir);
  const list = [transcript, ...extraPublishers];
  if (!toLark) {
    if (echo) list.push(createConsolePublisher({ full: false }));
  } else if (dryRun) {
    list.push(createConsolePublisher());
  } else {
    const lark = createLarkPublisher(cfg, { transcriptPath: transcript.path });
    if (lark.missing.length) {
      throw new ConfigError(`这些发言者没有配置 webhook：${lark.missing.join(', ')}。在 .env 里补上，或加 --dry-run 先在终端演练。`);
    }
    list.push(lark);
    list.push(createConsolePublisher({ full: false }));
  }
  const publisher = combinePublishers(list);

  let interjections = ownInterjections;
  const ij = cfg.lark.interjection;
  if (!ownInterjections && toLark && ij.enabled && interject && !mock) {
    // 指令消息（/讨论、/脑洞）不算插话，留给 watch 排队
    interjections = createInterjectionReader({
      chatId: ij.chatId,
      allowFrom: ij.allowFrom,
      since: new Date(),
      ignore: (text) => isTrigger(text, triggers ?? cfg.lark.watch?.triggers ?? DEFAULT_TRIGGERS),
    });
  }

  const providers = createProviderRegistry(cfg, { forceMock: mock });
  // usage.jsonl：每次模型调用的用量与上下文，供 klook-console 等外部看板读取
  const usageFile = path.join(runDir, 'usage.jsonl');
  const onEvent = (e) => {
    const row = { at: new Date().toISOString(), ...e };
    if (e.type === 'run_started') Object.assign(row, { pid: process.pid, dryRun, mock });
    fs.appendFileSync(usageFile, `${JSON.stringify(row)}\n`);
    watcher?.(row);
  };
  return { publisher, interjections, providers, onEvent };
}

/**
 * number：网页先分好编号再排队（页面马上能跳到这场讨论）；不传时这里分配。
 * subject：打磨模式的打磨对象（墨稿里的脑洞 / 梗概 / 总纲）。
 * onRunDir：建好本地记录目录后回调，网页用来找这场讨论的记录。
 */
export async function runPrepared(cfg, { topic, dryRun, mock, interject, triggers, code, number: given, subject, lark, extraPublishers, interjections: ownInterjections, onRunDir, onEvent: watcher, runsDir = RUNS, echo }) {
  cleanupSessions(cfg, runsDir);
  // mock 演练不编号、不保存会话，免得被当成「最近一场」追问（网页演练例外：页面靠编号找讨论）
  const number = given ?? (mock ? undefined : nextNumber(runsDir));
  const runDir = path.join(runsDir, `${stamp()}-${number ? `#${number}-` : ''}${slug(subject ? `打磨-${subject.title}` : topic)}`);
  onRunDir?.(runDir, number);
  const { publisher, interjections, providers, onEvent } = setupRun(cfg, { runDir, dryRun, mock, interject, triggers, lark, extraPublishers, interjections: ownInterjections, onEvent: watcher, echo });
  log(`开始${number ? ` #${number}` : ''} ${{ brainstorm: '脑洞风暴', refine: '打磨', decision: '方案讨论' }[cfg.mode]}：${cfg.participants.length} 位参与者，${cfg.adaptive ? `自动轮数（最多 ${cfg.rounds} 轮）` : `${cfg.rounds} 轮`}${dryRun ? '（dry-run，不发到 Lark）' : ''}${mock ? '（mock，不调用模型）' : ''}`);
  if (code?.auto) log(`代码上下文：未指定仓库，调研员从 ${code.repos.length} 个登记的仓库里按议题定位`);
  else if (code) for (const r of code.repos) log(`代码上下文 ${describeRepo(r)}`);

  let result;
  try {
    result = await runDiscussion({ cfg, topic, providers, publisher, interjections, log, onEvent, code, number, subject });
  } catch (err) {
    onEvent({ type: 'run_failed', error: err.message.slice(0, 500) });
    throw err;
  }
  const { state, ...rest } = result;
  // state.json：会话与讨论状态，追问时接着用；超过保留期后会话会被清理
  if (number) saveState(runDir, { ...state, dryRun, ...(mock ? { mock: true } : {}) });
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ number, topic, mode: cfg.mode, ...rest }, null, 2));
  log(`完成${number ? ` #${number}` : ''}。本地记录：${path.relative(process.cwd(), runDir) || runDir}`);
  return result;
}

/** 追问一场讨论：默认最近一场；在原讨论的会话上接着进行，结束后更新原讨论的 state.json。 */
export async function followUpOne(cfg, { question, number, dryRun = false, mock = false, interject = true, triggers, lark, extraPublishers, interjections: ownInterjections, onRunDir, onEvent: watcher, runsDir = RUNS, echo }) {
  cleanupSessions(cfg, runsDir);
  let found;
  try {
    found = findState(runsDir, number, { dryRun });
  } catch (err) {
    throw new ConfigError(err.message); // 找不到讨论：只提示，不打印调用栈
  }
  const { dir, state } = found;
  if (state.mode === 'refine' && lark !== false) throw new ConfigError(`#${state.number} 是网页上的打磨讨论，请在 ai-storm 页面上追问`);
  if (state.expired) throw new ConfigError(`讨论 #${state.number} 已超过 ${retention(cfg).retentionDays} 天，会话已清理，请重新发起讨论`);
  const jobCfg = { ...cfg, mode: state.mode };
  const runDir = path.join(runsDir, `${stamp()}-追问#${state.number}-${slug(question)}`);
  onRunDir?.(runDir, state.number, dir);
  const { publisher, interjections, providers, onEvent } = setupRun(jobCfg, { runDir, dryRun, mock, interject, triggers, lark, extraPublishers, interjections: ownInterjections, onEvent: watcher, echo });
  log(`追问 #${state.number}「${state.topic.split('\n')[0].slice(0, 30)}」：${question.split('\n')[0].slice(0, 40)}${dryRun ? '（dry-run）' : ''}`);
  const code = codeForFollowUp(jobCfg, state);
  let result;
  try {
    result = await runFollowUp({ cfg: jobCfg, state, question, providers, publisher, interjections, log, onEvent, code });
  } catch (err) {
    onEvent({ type: 'run_failed', error: err.message.slice(0, 500) });
    throw err;
  } finally {
    code?.cleanup();
  }
  saveState(dir, result.state);
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ followUpOf: state.number, question, handling: result.handling, answer: result.answer, stats: result.stats }, null, 2));
  log(`追问完成（${result.handling === 'answer' ? '主席直接回答' : '重新讨论'}）。本地记录：${path.relative(process.cwd(), runDir) || runDir}`);
  return result;
}

/**
 * 追问时重新准备原讨论的代码目录，让主笔能查代码、调研员能核实事实。
 * 读的是本机当前的代码（指定了分支的重新导出），可能和原讨论时有出入。
 * 旧讨论没记 code 时：自动定位的按 auto 处理，指定仓库的从 context.repos 的说明里取别名。
 */
export function codeForFollowUp(cfg, state) {
  if (!state.context || !cfg.research || !Object.keys(cfg.repos ?? {}).length) return null;
  try {
    const auto = state.code ? state.code.auto : Boolean(state.context.auto);
    if (auto) return { ...prepareRepos(resolveRepos(cfg, allRepoSpecs(cfg)), { skipMissing: true }), auto: true };
    const specs = state.code?.repos
      ?? (state.context.repos ?? []).map((line) => ({ name: /^[\w.\-]+/.exec(line)?.[0] })).filter((x) => x.name);
    const known = specs.filter((x) => cfg.repos[x.name] || cfg.repoGroups?.[x.name]);
    if (!known.length) return null;
    const code = prepareRepos(resolveRepos(cfg, known), { skipMissing: true });
    for (const r of code.repos) log(`追问代码目录 ${describeRepo(r)}`);
    return code;
  } catch (err) {
    log(`⚠️ 追问时准备代码目录失败，这次不查代码：${err.message}`);
    return null;
  }
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function slug(text) {
  return text.trim().split('\n')[0].replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 24).replace(/^-+|-+$/g, '') || 'topic';
}

