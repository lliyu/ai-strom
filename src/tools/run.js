import { spawn } from 'node:child_process';
import path from 'node:path';
import { buildArgs } from './manifest.js';

export const DEFAULT_TIMEOUT_SEC = 120;
export const DEFAULT_MAX_OUTPUT_CHARS = 20000;
const STDOUT_CAP = 2 * 1024 * 1024; // 读回的上限，超出的部分丢掉（照样记下总长度）
const STDERR_LINE_CHARS = 500;

/**
 * 执行一个命令行工具，返回给模型看的文字和一条调用记录。
 *
 * 约定（推荐，不强制）：stdout 是数据；stderr 第一行写实际执行的查询（补全后的条件），
 * 最后一行写结果摘要，例如 {"rows":100,"limit_reached":true}。这两行原样带给模型，
 * 让它知道查的是什么、结果全不全。退出码 0 是完成，其他是失败。
 */
export async function runCommandTool(tool, input, { timeoutSec, maxOutputChars, spawnImpl = spawn, env = process.env } = {}) {
  const started = Date.now();
  const args = buildArgs(tool, input);
  const limitSec = tool.timeoutSec ?? timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const maxChars = tool.maxOutputChars ?? maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const [program, ...fixed] = tool.command;
  // 相对路径的程序（./x.sh、bin/x）按工具目录解析；node、python 这类按 PATH 找
  const bin = program.includes('/') && !path.isAbsolute(program) ? path.resolve(tool.dir, program) : program;
  const res = await exec(spawnImpl, bin, [...fixed, ...args], { cwd: tool.dir, env, timeoutMs: limitSec * 1000 });
  const errLines = res.stderr.split('\n').map((l) => l.trimEnd()).filter(Boolean).map((l) => l.slice(0, STDERR_LINE_CHARS));
  const stderrHead = errLines[0] ?? '';
  const stderrTail = errLines.length > 1 ? errLines.at(-1) : '';
  const { text: body, truncated } = cut(res.stdout, maxChars);
  const ok = !res.timedOut && !res.spawnError && res.code === 0;
  const status = res.spawnError
    ? `无法启动：${res.spawnError}`
    : res.timedOut ? `超时（${limitSec}s），已中止；下面只有中止前的输出` : `退出码 ${res.code}${ok ? '' : '（失败）'}`;
  const notes = [
    `[工具 ${tool.id}] ${status}`,
    `stdout 共 ${res.stdoutChars} 字${truncated ? `，只给了前 ${body.length} 字（被截断，结果不完整；缩小范围再查）` : ''}${res.stdoutDropped ? '，读回时已丢掉超出 2MB 的部分' : ''}`,
    ...(stderrHead ? [`stderr 首行：${stderrHead}`] : []),
    ...(stderrTail ? [`stderr 末行：${stderrTail}`] : []),
  ];
  const text = `${body || '（stdout 为空）'}\n\n${notes.join('\n')}`;
  return {
    ok,
    text,
    record: {
      time: new Date(started).toISOString(),
      source: 'command',
      tool: tool.id,
      input,
      exitCode: res.code,
      ...(res.timedOut ? { timedOut: true } : {}),
      ...(res.spawnError ? { error: res.spawnError } : {}),
      durationMs: Date.now() - started,
      stdoutChars: res.stdoutChars,
      returnedChars: body.length,
      truncated,
      ...(stderrHead ? { stderrHead } : {}),
      ...(stderrTail ? { stderrTail } : {}),
    },
  };
}

/** 截到 max 字以内，尽量在行尾断开。 */
export function cut(text, max) {
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, max);
  const nl = head.lastIndexOf('\n');
  return { text: nl > max * 0.5 ? head.slice(0, nl) : head, truncated: true };
}

function exec(spawnImpl, bin, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ stdout: '', stderr: '', stdoutChars: 0, code: null, spawnError: err.message });
      return;
    }
    let stdout = '';
    let stdoutChars = 0;
    let stdoutDropped = false;
    let stderr = '';
    let timedOut = false;
    let done = false;
    const finish = (extra) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, stdoutChars, stdoutDropped, timedOut, ...extra });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, timeoutMs);
    child.stdout.setEncoding?.('utf8');
    child.stderr.setEncoding?.('utf8');
    child.stdout.on('data', (d) => {
      const s = String(d);
      stdoutChars += s.length;
      if (stdout.length < STDOUT_CAP) stdout += s.slice(0, STDOUT_CAP - stdout.length);
      else stdoutDropped = true;
    });
    child.stderr.on('data', (d) => {
      // stderr 只需要首行和末行：保留开头一段和最近一段
      stderr += String(d);
      if (stderr.length > 64 * 1024) stderr = `${stderr.slice(0, 8 * 1024)}\n${stderr.slice(-8 * 1024)}`;
    });
    child.on('error', (err) => finish({ code: null, spawnError: err.code === 'ENOENT' ? `找不到程序 ${bin}` : err.message }));
    child.on('close', (code) => finish({ code }));
  });
}
