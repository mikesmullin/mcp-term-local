#!/usr/bin/env bun
/**
 * MCP server: local terminal — real host bash for scripts + argv exec for
 * host binaries.
 *
 * No sandbox, no emulation: `bash` spawns the real `bash` on this machine
 * and `exec` spawns the program directly (no shell). Both run as the MCP
 * server's user against the real host filesystem.
 *
 * Env:
 *   MCP_TERM_CWD / MCP_TERM_JB_ROOT — default working directory for `bash`
 *     (CWD wins; JB_ROOT is a legacy alias kept so existing configs still
 *     resolve a root)
 *   MCP_TERM_PATH / MCP_TERM_ENV — extra environment, prepended over the host env
 *   MCP_TERM_ALLOW — comma-separated regexes (optional); the command line
 *     must match one of the patterns to run
 */
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { runMcpStdioServer, textResult } from './shared/mcp-stdio.mjs';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from './shared/truncate.mjs';

const DEFAULT_CWD = process.env.MCP_TERM_CWD
  ? resolve(process.env.MCP_TERM_CWD)
  : process.env.MCP_TERM_JB_ROOT
  ? resolve(process.env.MCP_TERM_JB_ROOT)
  : process.cwd();

/**
 * Extra env for bash / host exec (from agent coffee via MCP_TERM_PATH /
 * MCP_TERM_ENV), layered over the host environment.
 */
function parseTermEnv() {
  const out = {};
  if (process.env.MCP_TERM_PATH) out.PATH = process.env.MCP_TERM_PATH;
  const raw = process.env.MCP_TERM_ENV || '';
  if (raw.trim().startsWith('{')) {
    try {
      Object.assign(out, JSON.parse(raw));
    } catch {
      /* ignore */
    }
  } else if (raw) {
    for (const part of raw.split(/[\n,]/)) {
      const line = part.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      if (k && k !== 'PATH') out[k] = line.slice(eq + 1).trim();
    }
  }
  return out;
}

const TERM_ENV = parseTermEnv();

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Prepends `export KEY=…` lines so the script's own `bash` sees them —
 * still harmless on a real bash (a double export wins) and needed nowhere
 * else; kept so scripts can rely on TERM_ENV vars. */
function withEnvExports(script) {
  const keys = Object.keys(TERM_ENV);
  if (!keys.length) return script;
  const preamble = keys
    .map((k) => `export ${k}=${shellQuote(TERM_ENV[k])}`)
    .join('; ');
  return `${preamble}; ${script}`;
}

/** Active children for Stop */
const activeChildren = new Set();

export function abortAllTermLocal() {
  let n = 0;
  for (const c of [...activeChildren]) {
    try {
      c.kill('SIGTERM');
      n++;
    } catch {
      /* ignore */
    }
  }
  activeChildren.clear();
  return n;
}

const allowRaw = process.env.MCP_TERM_ALLOW || '';
const allowRules = allowRaw
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => new RegExp(s));

function checkAllow(commandLine) {
  if (allowRules.length === 0) return;
  if (!allowRules.some((re) => re.test(commandLine))) {
    throw new Error(`Command denied by MCP_TERM_ALLOW: ${commandLine}`);
  }
}

function createProgressEmitter(ctx) {
  if (!ctx?.notify || ctx.progressToken == null || ctx.progressToken === '') {
    return { push() {}, flush() {} };
  }
  let last = 0;
  let pending = null;
  let timer = null;
  const send = (output) => {
    ctx.notify('notifications/progress', {
      progressToken: ctx.progressToken,
      output,
    });
  };
  return {
    push(merged) {
      pending = merged;
      const now = Date.now();
      const wait = 250 - (now - last);
      if (wait <= 0) {
        last = now;
        pending = null;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        send(merged);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          if (pending != null) send(pending);
          pending = null;
        }, wait);
      }
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending != null) send(pending);
      pending = null;
    },
  };
}

function killChild(child) {
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 1000);
}

function runProcess(command, args, { cwd, env, track = false, timeoutSec, onChunk, signal } = {}) {
  return new Promise((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise({
        code: 130,
        merged: '',
        timedOut: false,
        aborted: true,
      });
      return;
    }
    const child = spawn(command, args, {
      cwd: cwd || DEFAULT_CWD,
      env: env || process.env,
      shell: false,
    });
    if (track) activeChildren.add(child);
    let merged = '';
    let timedOut = false;
    let aborted = false;
    let timer;
    const onAbort = () => {
      aborted = true;
      killChild(child);
    };
    if (timeoutSec && Number(timeoutSec) > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killChild(child);
      }, Number(timeoutSec) * 1000);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const done = (result) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (track) activeChildren.delete(child);
      resolvePromise(result);
    };
    const onData = (d) => {
      const s = d.toString();
      merged += s;
      onChunk?.(s, merged);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      done({
        code: 127,
        merged: merged + (err.message || String(err)),
        timedOut: false,
        aborted: false,
      });
    });
    child.on('close', (code, sig) => {
      const wasAbort =
        aborted || (!timedOut && (sig === 'SIGTERM' || sig === 'SIGKILL'));
      done({
        code: timedOut ? 124 : wasAbort ? 130 : (code ?? 0),
        merged,
        timedOut,
        aborted: wasAbort && !timedOut,
        timeoutSec: timedOut ? Number(timeoutSec) : undefined,
      });
    });
  });
}

async function spillFullOutput(fullText, jailRoot) {
  const bases = [];
  if (jailRoot) bases.push(join(jailRoot, '.angela', 'tmp'));
  bases.push(join(tmpdir(), 'angela-bash'));
  let lastErr;
  for (const dir of bases) {
    try {
      await mkdir(dir, { recursive: true });
      const path = join(dir, `bash-${Date.now()}-${process.pid}.txt`);
      await writeFile(path, fullText, 'utf8');
      return path;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('could not write full output');
}

async function formatShellOutput(merged, { jailRoot } = {}) {
  const truncation = truncateTail(merged);
  let text = truncation.content || '';
  let fullOutputPath = null;
  if (truncation.truncated) {
    try {
      fullOutputPath = await spillFullOutput(merged, jailRoot);
    } catch {
      fullOutputPath = null;
    }
    const startLine = truncation.totalLines - truncation.outputLines + 1;
    const endLine = truncation.totalLines;
    if (truncation.lastLinePartial) {
      text +=
        `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine}` +
        (fullOutputPath ? `. Full output: ${fullOutputPath}` : '') +
        `]`;
    } else if (truncation.truncatedBy === 'lines') {
      text +=
        `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}` +
        (fullOutputPath ? `. Full output: ${fullOutputPath}` : '') +
        `]`;
    } else {
      text +=
        `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} ` +
        `(${formatSize(DEFAULT_MAX_BYTES)} limit)` +
        (fullOutputPath ? `. Full output: ${fullOutputPath}` : '') +
        `]`;
    }
  }
  return { text, truncation, fullOutputPath };
}

function appendStatus(text, status) {
  return `${text ? `${text}\n\n` : ''}${status}`;
}

function finishShellResult(formatted, raw) {
  let text = formatted.text;
  if (raw.timedOut) {
    throw new Error(
      appendStatus(text, `Command timed out after ${raw.timeoutSec} seconds`),
    );
  }
  if (raw.aborted) {
    throw new Error(appendStatus(text, 'Command aborted'));
  }
  if (raw.code !== 0 && raw.code != null) {
    throw new Error(appendStatus(text || '(no output)', `Command exited with code ${raw.code}`));
  }
  return textResult(text || '(no output)');
}

/**
 * Real `bash -c <script>` on the host. The script runs in the MCP server's
 * user environment: full filesystem, real tools, real PATH (augmented by
 * TERM_ENV).
 */
async function runBash(script, { cwd, timeoutSec, onChunk, signal } = {}) {
  checkAllow(script);
  const body = withEnvExports(String(script));
  const workdir = cwd ? resolve(cwd) : DEFAULT_CWD;
  const env = { ...process.env, ...TERM_ENV };

  return runProcess('bash', ['-c', body], {
    cwd: workdir,
    env,
    track: true,
    timeoutSec,
    onChunk,
    signal,
  });
}

const tools = {
  bash: {
    description:
      `Run a real bash script on the host (full shell: pipes, redirects, builtins). ` +
      `Runs with the MCP server's user and the host filesystem, in MCP_TERM_CWD ` +
      `("${DEFAULT_CWD}") or the requested cwd. No sandbox, no write restrictions. ` +
      `Stdout and stderr are merged. Non-zero exit throws. Output is truncated to last ${DEFAULT_MAX_LINES} lines ` +
      `or ${DEFAULT_MAX_BYTES / 1024}KB. For a plain program with argv (no shell), use exec.`,
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Bash script' },
        cwd: { type: 'string', description: 'Optional working directory on the host' },
        timeout: { type: 'number', description: 'Timeout in seconds (optional)' },
      },
      required: ['script'],
    },
    async handler({ script, cwd, timeout }, ctx) {
      if (!script || !String(script).trim()) throw new Error('script required');
      const progress = createProgressEmitter(ctx);
      const raw = await runBash(String(script), {
        cwd,
        timeoutSec: timeout,
        onChunk: (_chunk, merged) => progress.push(merged),
        signal: ctx?.signal,
      });
      progress.flush();
      const workdir = cwd ? resolve(cwd) : DEFAULT_CWD;
      const formatted = await formatShellOutput(raw.merged, { jailRoot: workdir });
      return finishShellResult(formatted, raw);
    },
  },

  exec: {
    description:
      `Run a host program with argv (no shell). ` +
      `command is the program path or name (found via PATH), args is its argument list; ` +
      `to run a shell pipeline use bash. Real process on this machine. ` +
      `Stdout and stderr are merged. Non-zero exit throws. Output is truncated to last ${DEFAULT_MAX_LINES} lines ` +
      `or ${DEFAULT_MAX_BYTES / 1024}KB.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
        timeout: { type: 'number', description: 'Timeout in seconds (optional)' },
      },
      required: ['command'],
    },
    async handler({ command, args, cwd, timeout }, ctx) {
      if (!command) throw new Error('command required');
      const argv = Array.isArray(args) ? args.map(String) : [];
      const line = [command, ...argv].join(' ');
      checkAllow(line);
      const workdir = cwd ? resolve(cwd) : DEFAULT_CWD;
      const env = { ...process.env, ...TERM_ENV };
      const progress = createProgressEmitter(ctx);
      const raw = await runProcess(String(command), argv, {
        cwd: workdir,
        env,
        track: true,
        timeoutSec: timeout,
        onChunk: (_chunk, merged) => progress.push(merged),
        signal: ctx?.signal,
      });
      progress.flush();
      const formatted = await formatShellOutput(raw.merged, { jailRoot: workdir });
      return finishShellResult(formatted, raw);
    },
  },
};

process.stderr.write(
  `term-local: bash(root=${DEFAULT_CWD}) exec(host, no shell)` +
    (TERM_ENV.PATH ? ` path=${TERM_ENV.PATH.split(':').length}dirs` : '') +
    (process.env.MCP_TERM_ALLOW ? ' allowlist active' : '') +
    `\n`,
);

await runMcpStdioServer({ name: 'term-local', version: '0.2.1', tools });
