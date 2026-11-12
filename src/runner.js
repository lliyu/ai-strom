import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './config.js';
import { createProviderRegistry } from './providers/index.js';
import { createLarkPublisher, createConsolePublisher, createStorePublisher, combinePublishers } from './publishers.js';
import { createInterjectionReader } from './lark/interjections.js';
import { runDiscussion, runFollowUp, backfillDoc, rewriteDocs } from './orchestrator.js';
import { nextNumber, saveState, findState, expireOldSessions } from './state.js';
import { DEFAULT_CLAUDE_CWD } from './providers/claude-cli.js';
import { isTrigger, DEFAULT_TRIGGERS } from './watch.js';
import { describeRepo, resolveRepos, prepareRepos, allRepoSpecs, parseRepoSpecs } from './repos.js';
import { createStoreInbox, combineInterjections } from './inbox.js';
import { savedLineup, configForState } from './lineup.js';
import { prepareData } from './tools/index.js';
import { knowledgeSetup } from './knowledge.js';
import { budgetFromUsage } from './budget.js';
import { HANDLING_LABELS } from './modes.js';
import { memorySetup } from './memory.js';
import { sharedStore } from './db.js';

/**
 * 跑一场讨论或一次追问：命令行（discuss / followup）、Lark 监听（watch）和本地网页（web）共用。
 * 发到哪里由调用方决定：默认发 Lark（dryRun 时打印到终端）；网页上发起的传 lark: false，只写记录库。
 * 发言、用量、插话、工具调用和讨论状态都在记录库里（db.js），插话除了群消息，还读网页写进库里的，见 inbox.js。
 */

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const log = (s) => process.stderr.write(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · ${s}\n`);

/** runs/ 只放 Lark 监听进程的运行文件（.watch.pid、.watch.state.json、.watch.log），讨论记录都在记录库里。 */
export const RUNS = path.join(ROOT, 'runs');

/** 这份配置对应的记录库（同一进程共用一个连接）。 */
export const storeOf = (cfg) => sharedStore(cfg.db.path);
const retention = (cfg) => ({ retentionDays: cfg.sessionRetentionDays ?? 7, claudeCwd: cfg.providers['claude-cli']?.cwd ?? DEFAULT_CLAUDE_CWD });

/** 清理超过保留期的会话（每次讨论、追问、watch 启动时顺手做）。 */
export function cleanupSessions(cfg, store = storeOf(cfg)) {
  try {
    const cleaned = expireOldSessions(store, retention(cfg));
    if (cleaned.length) log(`已清理超过 ${retention(cfg).retentionDays} 天的会话：${cleaned.map((n) => `#${n}`).join('、')}`);
  } catch (err) {
    log(`⚠️ 清理过期会话失败：${err.message}`);
  }
}

/** 讨论和追问共用：记录库、Lark/终端发布、插话读取、用量事件。 */
function setupRun(cfg, { store, execId, number, dryRun, mock, interject, triggers, echo = true, lark: toLark = true, extraPublishers = [], interjections: ownInterjections, onEvent: watcher }) {
  const list = [createStorePublisher(store, execId), ...extraPublishers];
  if (!toLark) {
    if (echo) list.push(createConsolePublisher({ full: false }));
  } else if (dryRun) {
    list.push(createConsolePublisher());
  } else {
    const lark = createLarkPublisher(cfg, { recordHint: number ? `本机 ai-storm 网页 #${number}` : '本机 ai-storm 记录库' });
    if (lark.missing.length) {
      throw new ConfigError(`这些发言者没有配置 webhook：${lark.missing.join(', ')}。在 .env 里补上，或加 --dry-run 先在终端演练。`);
    }
    list.push(lark);
    list.push(createConsolePublisher({ full: false }));
  }
  const publisher = combinePublishers(list);

  let interjections = ownInterjections;
  const ij = cfg.lark.interjection;
  if (!ownInterjections && toLark && !dryRun && ij.enabled && interject && !mock) {
    // 指令消息（/讨论、/脑洞）不算插话，留给 watch 排队
    interjections = createInterjectionReader({
      chatId: ij.chatId,
      allowFrom: ij.allowFrom,
      since: new Date(),
      ignore: (text) => isTrigger(text, triggers ?? cfg.lark.watch?.triggers ?? DEFAULT_TRIGGERS),
    });
  }
  // 网页上的插话：不管这场讨论在哪个进程里跑，都从记录库里这次运行的插话读
  if (interject) interjections = combineInterjections([interjections, createStoreInbox(store, execId)]);
  const channel = toLark ? (dryRun ? 'dry-run' : 'lark') : 'web';

  const providers = createProviderRegistry(cfg, { forceMock: mock });
  // 用量事件：每次模型调用的用量与上下文，写进记录库的 events 表，klook-console 等外部看板读这张表
  const onEvent = (e) => {
    const row = { at: new Date().toISOString(), ...e };
    if (e.type === 'run_started') Object.assign(row, { pid: process.pid, dryRun, mock, channel });
    try {
      store.addEvent(execId, row);
    } catch (err) {
      log(`⚠️ 写用量记录失败：${err.message}`);
    }
    watcher?.(row);
  };
  return { publisher, interjections, providers, onEvent, channel };
}

/** 跑一场讨论：discuss、watch 和网页共用。先解析并准备仓库：别名写错、分支不存在时在发任何消息之前就报错。 */
export async function runOne(cfg, { repos, ...opts }) {
  const code = prepareCode(cfg, repos);
  try {
    return await runPrepared(cfg, { ...opts, code });
  } finally {
    code?.cleanup();
  }
}

/**
 * 指定了仓库就读这些；写「无」不读；没写时（方案讨论）把全部登记的仓库交给调研员按议题定位。
 */
export function prepareCode(cfg, repos) {
  if (repos === undefined || repos === null) {
    const auto = cfg.mode === 'decision' && cfg.research?.auto !== false && Object.keys(cfg.repos).length > 0;
    if (!auto) return null;
    const code = prepareRepos(resolveRepos(cfg, allRepoSpecs(cfg)), { skipMissing: true });
    for (const p of code.skipped) log(`⚠️ 登记的目录不存在，跳过：${p}`);
    return { ...code, auto: true };
  }
  const specs = parseRepoSpecs(repos);
  return specs.length ? prepareRepos(resolveRepos(cfg, specs)) : null;
}

/**
 * number：网页先分好编号再排队（页面马上能跳到这场讨论）；不传时这里分配。
 * subject：打磨模式的打磨对象（墨稿里的脑洞 / 梗概 / 总纲）。
 * store：记录库，默认按配置的 db.path 打开。onExecution：建好这次运行的记录后回调（运行 id、编号）。
 */
export async function runPrepared(cfg, { topic, dryRun, mock, interject, triggers, code, number: given, subject, lark, extraPublishers, interjections: ownInterjections, onExecution, onEvent: watcher, store = storeOf(cfg), echo, data: dataSelection, material, memory: memoryDomains }) {
  cleanupSessions(cfg, store);
  // mock 演练不编号、不保存会话，免得被当成「最近一场」追问（网页演练例外：页面靠编号找讨论）
  const number = given ?? (mock ? undefined : nextNumber(store, { mode: cfg.mode, topic, info: subject ? { subject: { type: subject.type, id: subject.id, title: subject.title } } : null }));
  const execId = store.startExecution({ number: number ?? null, kind: 'discussion', topic: subject ? subject.title : topic });
  onExecution?.(execId, number);
  const { publisher, interjections, providers, onEvent, channel } = guard(store, execId, () => setupRun(cfg, { store, execId, number, dryRun, mock, interject, triggers, lark, extraPublishers, interjections: ownInterjections, onEvent: watcher, echo }));
  log(`开始${number ? ` #${number}` : ''} ${{ brainstorm: '脑洞风暴', refine: '打磨', decision: '方案讨论', quick: '快问' }[cfg.mode]}：${cfg.participants.length} 位参与者，${cfg.adaptive ? `自动轮数（最多 ${cfg.rounds} 轮）` : `${cfg.rounds} 轮`}${dryRun ? '（dry-run，不发到 Lark）' : ''}${mock ? '（mock，不调用模型）' : ''}`);
  if (code?.auto) log(`代码上下文：未指定仓库，调研员从 ${code.repos.length} 个登记的仓库里按议题定位`);
  else if (code) for (const r of code.repos) log(`代码上下文 ${describeRepo(r)}`);
  const data = dataFor(cfg, dataSelection, { store, execId });
  const memory = memoryDomains?.length ? memorySetup(cfg.memory?.path, memoryDomains) : null;
  if (memory?.domains.length) log(`记忆：${memory.domains.map((d) => `${d.label}（档案 ${d.profileChars} 字，结论 ${d.entries} 条）`).join('、')}`);
  else if (memoryDomains?.length) log('⚠️ 选了记忆，但这些域里还没有内容，这场不带记忆');

  let result;
  try {
    result = await runDiscussion({ cfg, topic, providers, publisher, interjections, log, onEvent, code, number, subject, data, material, memory });
  } catch (err) {
    onEvent({ type: 'run_failed', error: err.message.slice(0, 500) });
    throw err;
  }
  const { state, ...rest } = result;
  // 讨论状态（会话、主文档……）存进记录库，追问时接着用；超过保留期后会话会被清理
  // 网页上自己选的阵容也存进状态，追问时照原样用
  const lineup = savedLineup(cfg);
  if (number) saveState(store, { ...state, dryRun, channel, ...(lineup ? { lineup } : {}), ...(mock ? { mock: true } : {}) });
  store.finishExecution(execId, { result: { number, topic, mode: cfg.mode, ...rest } });
  log(`完成${number ? ` #${number}` : ''}。记录在 ${recordWhere(store, number)}`);
  return result;
}

/** 运行开始前（建发布者等）就出错时，把这次运行标成失败，免得页面上一直显示进行中。 */
function guard(store, execId, fn) {
  try {
    return fn();
  } catch (err) {
    store.finishExecution(execId, { status: 'failed', error: err.message.slice(0, 500) });
    throw err;
  }
}

const recordWhere = (store, number) => `${number ? `网页 #${number}，` : ''}记录库 ${store.file === ':memory:' ? '（内存）' : path.relative(process.cwd(), store.file) || store.file}`;

/** 追问一场讨论：默认最近一场；在原讨论的会话上接着进行，结束后更新原讨论的状态。 */
export async function followUpOne(cfg, { question, number, dryRun = false, mock = false, interject = true, triggers, lark, extraPublishers, interjections: ownInterjections, onExecution, onEvent: watcher, store = storeOf(cfg), echo, context }) {
  cleanupSessions(cfg, store);
  let found;
  try {
    found = findState(store, number, { dryRun });
  } catch (err) {
    throw new ConfigError(err.message); // 找不到讨论：只提示，不打印调用栈
  }
  const state = withBudget(found.state, store);
  if (state.mode === 'refine' && lark !== false) throw new ConfigError(`#${state.number} 是网页上的打磨讨论，请在 ai-storm 页面上追问`);
  if (state.lineup && lark !== false) throw new ConfigError(`#${state.number} 是网页上自选阵容的讨论，请在 ai-storm 页面上追问`);
  if (state.expired) throw new ConfigError(`讨论 #${state.number} 已超过 ${retention(cfg).retentionDays} 天，会话已清理，请重新发起讨论`);
  const jobCfg = configForState(cfg, state);
  const execId = store.startExecution({ number: state.number, kind: 'followup', topic: question });
  onExecution?.(execId, state.number);
  const { publisher, interjections, providers, onEvent } = guard(store, execId, () => setupRun(jobCfg, { store, execId, number: state.number, dryRun, mock, interject, triggers, lark, extraPublishers, interjections: ownInterjections, onEvent: watcher, echo }));
  log(`追问 #${state.number}「${state.topic.split('\n')[0].slice(0, 30)}」：${question.split('\n')[0].slice(0, 40)}${dryRun ? '（dry-run）' : ''}`);
  const code = codeForFollowUp(jobCfg, state);
  const data = dataFor(jobCfg, state.data, { store, execId });
  let result;
  try {
    result = await runFollowUp({ cfg: jobCfg, state, question, providers, publisher, interjections, log, onEvent, code, context, data });
  } catch (err) {
    onEvent({ type: 'run_failed', error: err.message.slice(0, 500) });
    throw err;
  } finally {
    code?.cleanup();
  }
  saveState(store, result.state);
  store.finishExecution(execId, { result: { followUpOf: state.number, question, handling: result.handling, context: result.context, answer: result.answer, stats: result.stats } });
  log(`追问完成（${HANDLING_LABELS[result.handling] ?? result.handling}，${result.context === 'fresh' ? '新会话' : '接着原会话'}）。记录在 ${recordWhere(store, state.number)}`);
  return result;
}

/**
 * 给还没有主文档的旧讨论补写一份；rewrite 时按现在的写法重写已有的文档（记为新的一版，可能拆出新文档）。
 * 只打印到终端，不发群、不写发言记录；结果写回原讨论的状态。
 */
export async function docOne(cfg, { number, mock = false, rewrite = false, store = storeOf(cfg) }) {
  let found;
  try {
    found = findState(store, number);
  } catch (err) {
    throw new ConfigError(err.message);
  }
  const state = withBudget(found.state, store);
  const providers = createProviderRegistry(cfg, { forceMock: mock });
  const publisher = combinePublishers([createConsolePublisher({ full: false })]);
  const title = state.topic.split('\n')[0].slice(0, 30);
  log(rewrite
    ? `重写主文档 #${state.number}「${title}」：主席按现在的写法重写${state.expired ? '' : '，主笔核对'}`
    : `补写主文档 #${state.number}「${title}」：主席读全部记录写初稿，主笔核对`);
  let result;
  try {
    const job = { cfg: configForState(cfg, state), state, providers, publisher, log };
    result = rewrite ? await rewriteDocs(job) : await backfillDoc(job);
  } catch (err) {
    throw new ConfigError(err.message);
  }
  saveState(store, result.state);
  const { stats, docs } = result;
  const lines = docs.map((d) => {
    const extra = Object.keys(d.attachments).length;
    return `${d.opened ? '新开' : ''}《${d.title}》第 ${d.version} 版，正文 ${d.text.length} 字${extra ? `，附录 ${extra} 份` : ''}`;
  });
  log(`完成：${lines.join('；')}。${stats.calls} 次模型调用${stats.costUsd ? `，约 $${stats.costUsd.toFixed(2)}` : ''}。在网页 #${state.number} 查看`);
  return result;
}

/**
 * 网页上选的数据工具和知识来源：命令行工具的调用记录写进记录库的 tool_calls 表，挂在这次运行上。
 * 选了但用不上的（没有工具、来源目录不存在）记一行日志。
 */
export function dataFor(cfg, selection, { store, execId } = {}) {
  if (!selection) return null;
  const data = prepareData(cfg, selection, { record: store ? { db: store.file, execId } : undefined, knowledgeSetup });
  if (selection.tools && !data?.mcp) log('⚠️ 选了数据工具，但没有可用的工具（local/tools 或 dataTools.mcpServers 都没有，或没有调研员配置），这场不查实时数据');
  const missing = (selection.knowledge ?? []).filter((n) => !data?.knowledge?.sources.includes(n));
  if (missing.length) log(`⚠️ 这些知识来源用不上（没登记或目录不存在）：${missing.join('、')}`);
  if (data) log(`数据工具：${data.mcp ? `${data.mcp.allowed.length} 个` : '不用'}；知识来源：${data.knowledge?.sources.join('、') || '不用'}`);
  return data;
}

/** 旧讨论的状态里没有主席输入预算的数据时，从讨论本身那次运行的用量事件推出来。 */
export function withBudget(state, store) {
  if (state.budget) return state;
  try {
    const first = store.executionsOf(state.number).find((e) => e.kind === 'discussion');
    if (!first) return state;
    return { ...state, budget: budgetFromUsage(store.events(first.id)) };
  } catch {
    return state;
  }
}

/**
 * 追问时重新准备原讨论的代码目录，让主笔能查代码、调研员能核实事实。
 * 读的是本机当前的代码（指定了分支的重新导出），可能和原讨论时有出入。
 * 旧讨论没记 code 时：自动定位的按 auto 处理，指定仓库的从 context.repos 的说明里取别名。
 */
export function codeForFollowUp(cfg, state) {
  if (!state.context || state.context.web || !cfg.research || !Object.keys(cfg.repos ?? {}).length) return null;
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
