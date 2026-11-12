#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { loadDotEnv, loadConfig, normalizeConfig, resolveWebhook, maskUrl, ConfigError } from './config.js';
import { createProviderRegistry } from './providers/index.js';
import { createLarkPublisher } from './publishers.js';
import { createInterjectionReader } from './lark/interjections.js';
import { RUNS, log, cleanupSessions, runOne, followUpOne, docOne } from './runner.js';
import { buildCardWithinLimit } from './lark/card.js';
import { sendCard } from './lark/webhook.js';
import { watchLoop, acquireLock, isTrigger, DEFAULT_TRIGGERS } from './watch.js';
import { listTools, callTool, tryTools, listKnowledge } from './tools/commands.js';
import { parseRepoSpecs, resolveRepos, prepareRepos, availableRepos, describeRepo, allRepoSpecs } from './repos.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `ai-storm：多个模型分角色讨论，每个模型用自己的 Lark 群自定义机器人发言。

用法：
  node src/cli.js discuss "<议题>" [选项]     开始一场讨论
  node src/cli.js discuss --topic-file <文件> [选项]
  node src/cli.js check [--config <文件>]      检查配置、webhook、claude CLI 与插话读取权限
  node src/cli.js send-test [--only id,id]     让每个（或指定的）发言者往群里发一张测试卡片
  node src/cli.js watch [--interval 30]        监听讨论群，收到「/讨论 <议题>」「/脑洞 <题目>」就自动开讨论
  node src/cli.js repos                        列出登记的仓库和组，以及各仓库当前的分支与改动
  node src/cli.js followup [--run 12] "<问题>"   追问一场讨论（默认最近一场）：主席判断直接回答还是重新讨论
  node src/cli.js doc <编号> [--mock]          给还没有主文档的旧讨论补写一份（主席写、主笔核对；不发群）
  node src/cli.js web [--port 8790] [--mock]   本地网页：看全部讨论、插话、追问；发起方案讨论 / 脑洞风暴（不发群）和作品打磨
  node src/cli.js knowledge                    列出知识来源：目录、索引、文档数
  node src/cli.js tools                        列出数据工具：local/tools 里的命令行工具和登记的 MCP 服务
  node src/cli.js tools call <工具> 参数=值 …   不经过模型直接执行一个命令行工具，看它返回给模型的内容
  node src/cli.js tools try "<问题>" [--model sonnet]  让模型带着全部数据工具和知识回答一个问题，端到端检查

选项：
  --config <文件>     配置文件，默认 ./config.json
  --mode <模式>       decision（方案讨论）| brainstorm（脑洞风暴），覆盖配置
  --rounds <n|auto>   总轮数（含第 1 轮）。auto：评审都没有新意见就结束，最多 maxRounds 轮（默认 20）
  --dry-run           不发到 Lark，只在终端打印卡片内容（仍会调用模型）
  --mock              不调用模型，用假回答演练整个流程（可与 --dry-run 一起用）
  --no-interject      本次不读取群里的插话
  --repos <列表>      讨论前先由调研员读这些仓库：别名或组名，逗号分隔，@ 后写分支，例如 fission,pricing@develop
                      不写时调研员从全部登记的仓库里按议题定位；--repos none 不读代码
  -h, --help          显示帮助

本地记录写在 runs/<时间>-<议题>/：transcript.md 与 events.jsonl；讨论的结论在 主文档.md（追问后更新同一份）。`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', default: 'config.json' },
      mode: { type: 'string' },
      rounds: { type: 'string' },
      'topic-file': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      mock: { type: 'boolean', default: false },
      'no-interject': { type: 'boolean', default: false },
      only: { type: 'string' },
      interval: { type: 'string' },
      repos: { type: 'string' },
      run: { type: 'string' },
      port: { type: 'string' },
      model: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return 0;
  }

  loadDotEnv(path.join(ROOT, '.env'));
  loadDotEnv(path.resolve('.env'));

  const rawCfg = loadConfig(path.resolve(values.config));
  const cfg = normalizeConfig(rawCfg, {
    mode: values.mode,
    rounds: values.rounds === undefined ? undefined : values.rounds === 'auto' ? 'auto' : Number(values.rounds),
  });

  switch (command) {
    case 'discuss': return discuss(cfg, values, rest);
    case 'check': return check(cfg);
    case 'send-test': return sendTest(cfg, values.only);
    case 'watch': return watch(rawCfg, cfg, values);
    case 'repos': return listRepos(cfg);
    case 'web': return web(cfg, values);
    case 'knowledge': return listKnowledge(cfg);
    case 'tools': {
      const [sub, ...args] = rest;
      if (!sub || sub === 'list') return listTools(cfg);
      if (sub === 'call') return callTool(cfg, args[0], args.slice(1));
      if (sub === 'try') {
        if (!args.join(' ').trim()) {
          console.error('缺少问题：tools try "<问题>"');
          return 2;
        }
        return tryTools(cfg, args.join(' '), { model: values.model });
      }
      console.error(`未知的 tools 子命令 ${sub}：list | call | try`);
      return 2;
    }
    case 'followup': {
      const question = rest.join(' ');
      if (!question.trim()) {
        console.error('缺少问题：followup [--run 12] "<问题>"');
        return 2;
      }
      await followUpOne(cfg, { question, number: values.run, dryRun: values['dry-run'], mock: values.mock, interject: !values['no-interject'] });
      return 0;
    }
    case 'doc': {
      const number = Number(rest[0]?.replace(/^#/, ''));
      if (!number) {
        console.error('缺少讨论编号：doc <编号>，例如 doc 7');
        return 2;
      }
      await docOne(cfg, { number, mock: values.mock });
      return 0;
    }
    default:
      console.error(`未知命令 ${command}\n\n${HELP}`);
      return 2;
  }
}


async function discuss(cfg, values, rest) {
  const topic = values['topic-file'] ? fs.readFileSync(path.resolve(values['topic-file']), 'utf8') : rest.join(' ');
  if (!topic.trim()) {
    console.error('缺少议题：discuss "<议题>" 或 --topic-file <文件>');
    return 2;
  }
  await runOne(cfg, { topic, dryRun: values['dry-run'], mock: values.mock, interject: !values['no-interject'], repos: values.repos });
  return 0;
}

/** 监听讨论群里的 /讨论、/脑洞 指令，自动发起讨论。 */
async function watch(rawCfg, cfg, values) {
  const ij = cfg.lark.interjection;
  const w = cfg.lark.watch ?? {};
  const chatId = w.chatId ?? ij.chatId;
  const allowFrom = w.allowFrom ?? ij.allowFrom ?? [];
  const triggers = w.triggers ?? DEFAULT_TRIGGERS;
  if (!/^oc_/.test(chatId ?? '')) throw new ConfigError('watch 需要讨论群的 chatId：在 config.json 的 lark.interjection.chatId（或 lark.watch.chatId）填写');
  if (!allowFrom.length) throw new ConfigError('watch 需要 allowFrom（允许发起讨论的 open_id），避免群里任何人都能触发模型调用');
  const intervalMs = values.interval ? Number(values.interval) * 1000 : (w.intervalMs ?? 30000);

  fs.mkdirSync(path.join(ROOT, 'runs'), { recursive: true });
  const release = acquireLock(path.join(ROOT, 'runs', '.watch.pid'));

  // runs/.watch.state.json：给 klook-console 等外部页面看的运行状态
  const stateFile = path.join(ROOT, 'runs', '.watch.state.json');
  const state = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    chatId,
    intervalMs,
    triggers: Object.keys(triggers),
    dryRun: Boolean(values['dry-run']),
    mock: Boolean(values.mock),
    phase: 'starting',
    stopping: false,
    current: null,
    queued: 0,
    lastPollAt: null,
    lastError: null,
    lastJob: null,
  };
  const writeState = (patch = {}) => {
    Object.assign(state, patch, { updatedAt: new Date().toISOString() });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, stateFile);
  };
  writeState();

  let stopping = false;
  let wake = null; // 空闲等待时收到停止信号，立即醒来退出
  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wake = () => { clearTimeout(t); resolve(); };
  });
  const stop = () => {
    if (stopping) {
      try { fs.unlinkSync(stateFile); } catch { /* 已清理 */ }
      process.exit(130);
    }
    stopping = true;
    writeState({ stopping: true });
    log(state.phase === 'running'
      ? '收到停止信号：当前讨论结束后退出（再发一次停止信号立即退出）'
      : '收到停止信号，正在退出');
    wake?.();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const chairHook = createLarkPublisher(cfg);
  const notify = async ({ title, body }) => {
    if (values['dry-run']) return log(`[通知] ${title}\n${body}`);
    await chairHook.post({ speaker: cfg.chair, title, body });
  };

  cleanupSessions(cfg);
  const reader = createInterjectionReader({ chatId, allowFrom, since: new Date() });
  log(`开始监听群 ${chatId}，每 ${Math.round(intervalMs / 1000)}s 读一次；指令：${Object.keys(triggers).join('、')}${values['dry-run'] ? '（dry-run：讨论只打印到终端）' : ''}。Ctrl+C 停止。`);
  try {
    await watchLoop({
      reader,
      triggers,
      intervalMs,
      log,
      notify,
      shouldStop: () => stopping,
      sleep,
      onState: (patch) => writeState(patch),
      help: availableRepos(cfg),
      runOne: (job) => {
        if (job.mode === 'followup') {
          return followUpOne(normalizeConfig(rawCfg), { question: job.topic, number: job.target, dryRun: values['dry-run'], mock: values.mock, triggers });
        }
        const jobCfg = normalizeConfig(rawCfg, { mode: job.mode, rounds: job.rounds ?? (values.rounds === undefined ? undefined : values.rounds === 'auto' ? 'auto' : Number(values.rounds)) });
        return runOne(jobCfg, { topic: job.topic, dryRun: values['dry-run'], mock: values.mock, triggers, repos: job.repos });
      },
    });
  } finally {
    try { fs.unlinkSync(stateFile); } catch { /* 已清理 */ }
    release();
  }
  log('已停止监听');
  return 0;
}

/** 本地打磨网页：一直运行，Ctrl+C 停止。 */
async function web(cfg, values) {
  const { createWebApp, startWebServer } = await import('./web/server.js');
  const port = values.port ? Number(values.port) : cfg.web.port;
  const app = createWebApp({ cfg, mock: values.mock });
  cleanupSessions(cfg);
  const server = await startWebServer(app, { host: cfg.web.host, port, log });
  log(`墨稿接口：${cfg.novel.baseUrl}${values.mock ? '（mock：不调用模型）' : ''}。Ctrl+C 停止。`);
  await new Promise((resolve) => {
    const stop = () => {
      if (!app.idle()) log('还有打磨在进行，现在退出会中断它（再按一次 Ctrl+C 强制退出）');
      server.close(resolve);
      process.once('SIGINT', () => process.exit(130));
      if (app.idle()) resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

async function check(cfg) {
  let ok = true;
  const line = (good, text) => {
    if (!good) ok = false;
    console.log(`${good ? '✅' : '❌'} ${text}`);
  };

  console.log(`模式 ${cfg.mode}，${cfg.adaptive ? `自动轮数，最多 ${cfg.rounds} 轮` : `${cfg.rounds} 轮`}，参与者 ${cfg.participants.map((p) => p.id).join(', ')}，主席 ${cfg.chair.id}`);
  for (const s of [...cfg.participants, cfg.chair]) {
    const hook = resolveWebhook(s);
    line(Boolean(hook), `${s.id}（${s.name} · ${s.role}，${s.color}）webhook ${hook ? maskUrl(hook.url) : `未设置（${s.webhook?.urlEnv ?? '缺少 webhook.urlEnv'}）`}${hook && !hook.secret ? '，⚠️ 没有签名密钥' : ''}`);
  }

  const usesClaude = [...cfg.participants, cfg.chair].some((s) => (cfg.providers[s.provider]?.type ?? s.provider) === 'claude-cli');
  if (usesClaude) {
    try {
      const v = execFileSync(cfg.providers['claude-cli']?.bin ?? 'claude', ['--version'], { encoding: 'utf8' }).trim();
      line(true, `claude CLI ${v}`);
    } catch {
      line(false, '找不到 claude CLI');
    }
  }

  for (const [alias, r] of Object.entries(cfg.repos)) {
    if (!fs.existsSync(r.path)) line(false, `仓库 ${alias} 的目录不存在：${r.path}`);
  }
  for (const d of [...Object.values(cfg.repos), ...Object.values(cfg.repoGroups)].flatMap((x) => x.docs ?? [])) {
    if (!fs.existsSync(d)) line(false, `参考资料不存在：${d}`);
  }
  if (Object.keys(cfg.repos).length) {
    console.log(`ℹ️  登记了 ${Object.keys(cfg.repos).length} 个仓库、${Object.keys(cfg.repoGroups).length} 个组，调研员 ${cfg.research.provider} / ${cfg.research.model}${cfg.research.maxBudgetUsd ? `，单次预算 $${cfg.research.maxBudgetUsd}` : '，不限费用'}`);
  }

  const ij = cfg.lark.interjection;
  if (ij.enabled) {
    try {
      const out = execFileSync(process.env.LARK_CLI_BIN || 'lark-cli', ['auth', 'check', '--scope', 'im:message.group_msg:get_as_user'], { encoding: 'utf8' });
      line(JSON.parse(out).ok === true, `lark-cli 用户身份可读取群消息（插话群 ${ij.chatId}）`);
    } catch (err) {
      line(false, `lark-cli 检查失败：${err.message.split('\n')[0]}`);
    }
  } else {
    console.log('ℹ️  插话读取未开启（lark.interjection.enabled = false）');
  }
  return ok ? 0 : 1;
}

function listRepos(cfg) {
  const { repos, groups } = availableRepos(cfg);
  if (!repos.length) {
    console.log('还没有登记仓库：在 config.json 里加 repos 和 repoGroups，见 config.example.json');
    return 0;
  }
  for (const g of groups) {
    const grp = cfg.repoGroups[g];
    console.log(`组 ${g}${grp.description ? `（${grp.description}）` : ''}：${grp.repos.join('、')}`);
    for (const d of grp.docs ?? []) console.log(`  参考资料 ${d}`);
  }
  console.log('');
  for (const alias of repos) {
    try {
      const code = prepareRepos(resolveRepos(cfg, [{ name: alias }]));
      console.log(`✅ ${describeRepo(code.repos[0])}`);
      code.cleanup();
    } catch (err) {
      console.log(`❌ ${alias}：${err.message}`);
    }
  }
  return 0;
}

async function sendTest(cfg, only) {
  let failed = 0;
  const wanted = only ? new Set(only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const speakers = [...cfg.participants, cfg.chair].filter((s) => !wanted || wanted.has(s.id));
  if (wanted && speakers.length !== wanted.size) {
    console.error(`--only 里有不存在的发言者 id，可用：${[...cfg.participants, cfg.chair].map((s) => s.id).join(', ')}`);
    return 2;
  }
  for (const s of speakers) {
    const hook = resolveWebhook(s);
    if (!hook) {
      console.log(`❌ ${s.id}：没有 webhook，跳过`);
      failed += 1;
      continue;
    }
    const { card } = buildCardWithinLimit({
      title: `${s.name}${s.role ? ` · ${s.role}` : ''}`,
      subtitle: 'ai-storm 测试消息',
      color: s.color,
      body: `我是 **${s.name}**，负责${s.role || '发言'}。看到这张卡片说明 webhook 和签名都配置正确。`,
      footer: `${s.provider}${s.model ? ` / ${s.model}` : ''}`,
    });
    try {
      await sendCard(hook, card);
      console.log(`✅ ${s.id} 已发送`);
    } catch (err) {
      failed += 1;
      console.log(`❌ ${s.id}：${err.message}`);
    }
    await new Promise((r) => setTimeout(r, cfg.lark.minIntervalMs));
  }
  return failed ? 1 : 0;
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(err instanceof ConfigError ? err.message : `出错了：${err.stack ?? err.message}`);
    process.exitCode = 1;
  });
