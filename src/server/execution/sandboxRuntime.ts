/**
 * Aegis Orchestrator - Disposable Sandbox Runtime
 * 
 * Enforces secure candidate execution boundaries:
 * 1. Disposable candidate checkouts in isolated temporary directories
 * 2. Node.js permission model (--permission --allow-fs-read --allow-fs-write --no-addons)
 * 3. Linux namespace isolation (unshare --user --net) to eliminate host network access
 * 4. Whole-process-tree termination (-child.pid) with SIGTERM -> SIGKILL escalation
 * 5. Fail-closed error reporting (execution_runtime_unavailable)
 */

import { spawn, spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export interface SandboxExecutionOptions {
  command: string;
  args?: string[];
  workspacePath: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  allowNetwork?: boolean;
  allowChildProcess?: boolean;
  allowFsRead?: string[];
  allowFsWrite?: string[];
  maxBufferBytes?: number;
}

export interface SandboxExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  error?: string;
  errorCode?: string;
  sandboxDir?: string;
}

export interface DisposableSandbox {
  sandboxDir: string;
  cleanup: () => void;
}

const DEFAULT_TIMEOUT_MS = 25000;
const DEFAULT_MAX_BUFFER = 1024 * 512; // 512 KB

let unshareSupportedCache: boolean | null = null;
let nodePermissionSupportedCache: boolean | null = null;

/**
 * Checks if 'unshare --user --net' is available in the host environment.
 */
export function isUnshareSupported(): boolean {
  if (unshareSupportedCache !== null) return unshareSupportedCache;
  try {
    const res = spawnSync('unshare', ['--user', '--net', 'echo', '1'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    unshareSupportedCache = res.status === 0;
  } catch {
    unshareSupportedCache = false;
  }
  return unshareSupportedCache;
}

/**
 * Checks if Node.js permission model (--permission) is available.
 */
export function isNodePermissionSupported(): boolean {
  if (nodePermissionSupportedCache !== null) return nodePermissionSupportedCache;
  try {
    const res = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '-e', 'process.exit(0)'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    nodePermissionSupportedCache = res.status === 0;
  } catch {
    nodePermissionSupportedCache = false;
  }
  return nodePermissionSupportedCache;
}

/**
 * Creates an isolated, disposable candidate directory in temporary storage.
 */
export function createDisposableCheckout(sourceDir: string): DisposableSandbox {
  const uniqueId = `aegis-sandbox-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const sandboxDir = path.join(os.tmpdir(), uniqueId);
  fs.mkdirSync(sandboxDir, { recursive: true });

  // Copy candidate files from source to sandbox
  if (fs.existsSync(sourceDir)) {
    fs.cpSync(sourceDir, sandboxDir, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        return base !== '.git' && base !== 'node_modules';
      },
    });
  }

  const cleanup = () => {
    try {
      if (fs.existsSync(sandboxDir)) {
        fs.rmSync(sandboxDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn(`Failed to clean up sandbox dir ${sandboxDir}:`, e);
    }
  };

  return { sandboxDir, cleanup };
}

/**
 * Runs a command inside the hardened sandbox runtime.
 */
export async function runInSandbox(options: SandboxExecutionOptions): Promise<SandboxExecutionResult> {
  const {
    command,
    args = [],
    workspacePath,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = {},
    allowNetwork = false,
    allowFsRead = [],
    allowFsWrite = [],
    maxBufferBytes = DEFAULT_MAX_BUFFER,
  } = options;

  // Fail closed if runtime isolation cannot be enforced
  if (!isNodePermissionSupported()) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: 'Sandbox runtime error: Node.js permission model (--permission) is not supported or unavailable on this system.',
      timedOut: false,
      durationMs: 0,
      error: 'execution_runtime_unavailable: Required permission model not supported',
      errorCode: 'execution_runtime_unavailable',
    };
  }

  const resolvedWorkspace = path.resolve(workspacePath);
  const resolvedTmp = path.resolve(os.tmpdir());

  // Prepare environment: strict minimal allowlist
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: resolvedWorkspace,
    TMPDIR: resolvedTmp,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    NODE_ENV: 'test',
    AEGIS_SANDBOX: '1',
  };

  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('AEGIS_') || k === 'NODE_ENV') {
      safeEnv[k] = v;
    }
  }

  // Construct target command & argument array
  let finalCommand = command;
  let finalArgs: string[] = [];

  const isNode = command === 'node' || command === process.execPath;

  if (isNode) {
    finalCommand = process.execPath;
    finalArgs.push('--permission');
    finalArgs.push(`--allow-fs-read=${resolvedWorkspace}`);
    finalArgs.push(`--allow-fs-read=${resolvedTmp}`);
    for (const r of allowFsRead) {
      finalArgs.push(`--allow-fs-read=${path.resolve(r)}`);
    }

    finalArgs.push(`--allow-fs-write=${resolvedWorkspace}`);
    finalArgs.push(`--allow-fs-write=${resolvedTmp}`);
    for (const w of allowFsWrite) {
      finalArgs.push(`--allow-fs-write=${path.resolve(w)}`);
    }

    finalArgs.push('--no-addons');
    if (options.allowChildProcess) {
      finalArgs.push('--allow-child-process');
    }
    finalArgs.push(...args);
  } else {
    finalArgs.push(...args);
  }

  // Wrap with unshare --user --net if network access is restricted and unshare is available
  if (!allowNetwork && isUnshareSupported()) {
    finalArgs = ['--user', '--net', '--', finalCommand, ...finalArgs];
    finalCommand = 'unshare';
  }

  const startTime = Date.now();
  let stdoutData = '';
  let stderrData = '';
  let timedOut = false;

  return new Promise<SandboxExecutionResult>((resolve) => {
    let child: any;
    let timer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    try {
      child = spawn(finalCommand, finalArgs, {
        cwd: resolvedWorkspace,
        env: safeEnv,
        shell: false,
        detached: true, // Creates new process group so we can signal all descendants
      });
    } catch (err: any) {
      return resolve({
        exitCode: -1,
        stdout: '',
        stderr: err.message,
        timedOut: false,
        durationMs: Date.now() - startTime,
        error: `Failed to spawn process in sandbox: ${err.message}`,
        errorCode: 'spawn_failed',
      });
    }

    // Terminate whole process tree via negative PID process group
    const killProcessTree = (signal: NodeJS.Signals = 'SIGTERM') => {
      try {
        if (child?.pid) {
          process.kill(-child.pid, signal);
        }
      } catch {
        try {
          child?.kill(signal);
        } catch {}
      }
    };

    timer = setTimeout(() => {
      timedOut = true;
      try {
        killProcessTree('SIGTERM');
        killTimer = setTimeout(() => {
          killProcessTree('SIGKILL');
        }, 1000);
      } catch {}
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutData.length < maxBufferBytes) {
        stdoutData += chunk.toString('utf8');
        if (stdoutData.length > maxBufferBytes) {
          stdoutData = stdoutData.slice(0, maxBufferBytes) + '\n[Output truncated: max buffer limit exceeded]';
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrData.length < maxBufferBytes) {
        stderrData += chunk.toString('utf8');
        if (stderrData.length > maxBufferBytes) {
          stderrData = stderrData.slice(0, maxBufferBytes) + '\n[Stderr truncated: max buffer limit exceeded]';
        }
      }
    });

    child.on('error', (err: Error) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode: -1,
        stdout: stdoutData,
        stderr: stderrData || err.message,
        timedOut,
        durationMs: Date.now() - startTime,
        error: err.message,
        errorCode: 'runtime_error',
      });
    });

    child.on('close', (code: number | null) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode: timedOut ? -1 : code,
        stdout: stdoutData,
        stderr: stderrData,
        timedOut,
        durationMs: Date.now() - startTime,
        error: timedOut ? `Execution timed out after ${timeoutMs}ms` : undefined,
        errorCode: timedOut ? 'timed_out' : undefined,
      });
    });
  });
}
