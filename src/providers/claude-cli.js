import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 通过本机已登录的 Claude Code CLI 调用模型：claude -p。
 * 默认无工具，在固定的空目录（~/.cache/ai-storm/claude）里运行，避免读到某个项目的 CLAUDE.md。
 *
 * 调研员调用时传 tools（只读工具）与 addDirs：用 --restricted 运行，不加载用户和项目的设置与 Hook，
 * 去掉 Bash 等能执行命令的工具，文件工具只能读 addDirs 里的目录。
 *
 * 会话：传 session（{ id, turns }）时，第一次用 --session-id 开一条会话，之后用 --resume 接着聊，
 * 模型记得自己之前说过的话。Claude Code 按工作目录存会话（claudeSessionFile），所以工作目录要固定，
 * 讨论结束几天后追问也能接上；过了保留期由 state.js 的 expireOldSessions 删除。
 * 不传 session 时不保存会话（调研员、主席）。
 *
 * 费用：续接会话时 total_cost_usd 是会话累计值，见 callCost。
 */
/** CLI 报出的服务端临时故障：API 5xx、529 过载、连接中断。这类错误重试一次通常就好。 */
const TRANSIENT = /API Error:?\s*5\d\d|\b(?:500|502|503|504|529)\b|overloaded|Internal server error|ECONNRESET|ETIMEDOUT|socket hang up/i;
const retryable = (err) => Object.assign(err, { retryable: true });

export const DEFAULT_CLAUDE_CWD = path.join(os.homedir(), '.cache', 'ai-storm', 'claude');

/** Claude Code 存会话的位置：~/.claude/projects/<工作目录真实路径，非字母数字换成「-」>/<id>.jsonl */
export function claudeSessionFile(cwd, id) {
  const real = fs.existsSync(cwd) ? fs.realpathSync(cwd) : cwd;
  return path.join(os.homedir(), '.claude', 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
}

export function createClaudeCliProvider(spec, { spawnImpl = spawn } = {}) {
  const bin = spec.bin ?? 'claude';
  const timeoutMs = spec.timeoutMs ?? 600000;
  const cwd = spec.cwd ?? DEFAULT_CLAUDE_CWD;
  fs.mkdirSync(cwd, { recursive: true });

  return {
    name: spec.name ?? 'claude-cli',
    cwd,
    async complete({ model, system, prompt, effort, tools, addDirs, maxBudgetUsd, timeoutMs: callTimeoutMs, session }) {
      const args = [
        '-p',
        '--output-format', 'json',
        '--strict-mcp-config',
      ];
      if (session?.id) {
        args.push(...(session.turns?.length ? ['--resume', session.id] : ['--session-id', session.id]));
      } else {
        args.push('--no-session-persistence');
      }
      if (tools?.length) {
        args.push('--restricted', '--tools', tools.join(','), '--allowedTools', tools.join(','));
        for (const d of addDirs ?? []) args.push('--add-dir', d);
      } else {
        args.push('--tools', '');
      }
      if (maxBudgetUsd) args.push('--max-budget-usd', String(maxBudgetUsd));
      if (model) args.push('--model', model);
      if (system) args.push('--system-prompt', system);
      const eff = effort ?? spec.effort;
      if (eff) args.push('--effort', eff);

      const started = Date.now();
      const limit = callTimeoutMs ?? timeoutMs;
      const { stdout, stderr, code, timedOut } = await run(spawnImpl, bin, args, prompt, { cwd, timeoutMs: limit });
      if (timedOut) throw retryable(new Error(`claude CLI 超时（${Math.round(limit / 1000)}s）`));
      const parsed = parseResult(stdout);
      if (!parsed) {
        const err = new Error(`claude CLI 退出码 ${code}，输出无法解析：${(stderr || stdout).slice(0, 500)}`);
        throw TRANSIENT.test(stderr || stdout) ? retryable(err) : err;
      }
      if (parsed.subtype === 'error_max_budget_usd') {
        throw new Error(`claude CLI 超出单次预算 $${maxBudgetUsd}（已用 $${(parsed.total_cost_usd ?? 0).toFixed(2)}），可以调大 research.maxBudgetUsd`);
      }
      if (parsed.is_error || parsed.subtype !== 'success') {
        const err = new Error(`claude CLI 返回错误：${String(parsed.result ?? parsed.subtype).slice(0, 500)}`);
        throw TRANSIENT.test(String(parsed.result ?? '')) ? retryable(err) : err;
      }
      const usage = parsed.usage ?? {};
      // modelUsage 里有别名解析后的真实模型、上下文窗口与费用；取用量最大的那一项
      const mu = Object.entries(parsed.modelUsage ?? {})
        .sort(([, a], [, b]) => (b.outputTokens ?? 0) - (a.outputTokens ?? 0))[0];
      return {
        text: String(parsed.result ?? '').trim(),
        model: mu?.[0] ?? model ?? 'default',
        durationMs: parsed.duration_ms ?? Date.now() - started,
        usage: {
          inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        },
        contextWindow: mu?.[1]?.contextWindow ?? spec.contextWindow,
        costUsd: callCost(parsed.total_cost_usd, session),
        turns: parsed.num_turns,
      };
    },
  };
}

/**
 * 本次调用的费用。--resume 接着聊时，CLI 返回的 total_cost_usd 是整条会话到现在的累计值，
 * 所以记下会话上次的累计值（session.cliCostUsd，随 state.json 保存），本次只算差值。
 * 续接一条没记过累计值的旧会话时无法求差，返回 undefined，由调用方按配置价格估算。
 */
export function callCost(total, session) {
  if (typeof total !== 'number') return undefined;
  if (!session) return total;
  const resumed = Boolean(session.turns?.length);
  const before = session.cliCostUsd;
  session.cliCostUsd = total;
  if (!resumed) return total;
  if (typeof before !== 'number') return undefined;
  // 累计值变小说明 CLI 没按会话累计（例如换了版本），这时 total 就是本次费用
  return total >= before ? Math.round((total - before) * 1e6) / 1e6 : total;
}

function parseResult(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    // 兼容输出为事件数组的版本：取最后一个 result 事件
    if (Array.isArray(value)) return value.filter((e) => e?.type === 'result').at(-1) ?? null;
    return value;
  } catch {
    return null;
  }
}

function run(spawnImpl, bin, args, input, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(bin, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`找不到 ${bin}，确认已安装 Claude Code CLI 并在 PATH 上`) : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.stdin.end(input ?? '');
  });
}
