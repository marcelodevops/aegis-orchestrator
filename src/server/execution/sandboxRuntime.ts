/**
 * Aegis Orchestrator - Disposable Sandbox Runtime
 * 
 * Enforces secure candidate execution boundaries:
 * 1. Disposable candidate checkouts in isolated temporary directories
 * 2. Node.js permission model (--permission --allow-fs-read --allow-fs-write --no-addons)
 * 3. Linux namespace isolation (unshare --user --net) to eliminate host network access
 * 4. Whole-process-tree termination (-child.pid) with SIGTERM -> SIGKILL escalation
 * 5. Fail-closed error reporting (execution_runtime_unavailable)
 * 6. Isolated scratch temporary directory (never exposes host /tmp or host root)
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
  childPid?: number;
}

export interface DisposableSandbox {
  sandboxDir: string;
  cleanup: () => void;
}

const DEFAULT_TIMEOUT_MS = 25000;
const DEFAULT_MAX_BUFFER = 1024 * 512; // 512 KB

let unshareSupportedOverride: boolean | null = null;
let nodePermissionSupportedOverride: boolean | null = null;

export function setUnshareSupportedForTesting(val: boolean | null): void {
  unshareSupportedOverride = val;
}

export function setNodePermissionSupportedForTesting(val: boolean | null): void {
  nodePermissionSupportedOverride = val;
}

/**
 * Checks if 'unshare --user --net' is available in the host environment.
 */
export function isUnshareSupported(): boolean {
  if (unshareSupportedOverride !== null) return unshareSupportedOverride;
  try {
    const res = spawnSync('unshare', ['--user', '--net', 'echo', '1'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Checks if Node.js permission model (--permission) is available.
 */
export function isNodePermissionSupported(): boolean {
  if (nodePermissionSupportedOverride !== null) return nodePermissionSupportedOverride;
  try {
    const res = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '-e', 'process.exit(0)'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
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
 * Runs untrusted candidate code inside the strictly hardened sandbox runtime.
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

  // 1. Fail closed if Node permission model is not available
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

  // 2. Reject unsupported execution runners (only node is permitted for untrusted candidate code)
  const isNode = command === 'node' || command === process.execPath;
  if (!isNode) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: `Unsupported execution runner "${command}". Untrusted execution must run inside an enforced sandbox runner (node).`,
      timedOut: false,
      durationMs: 0,
      error: 'unsupported_execution_runner',
      errorCode: 'unsupported_execution_runner',
    };
  }

  // 3. Fail closed if network isolation is required but unshare is unavailable (never silently degrade!)
  if (!allowNetwork && !isUnshareSupported()) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: 'Network isolation is required for untrusted candidate execution, but unshare --user --net is unavailable in this environment.',
      timedOut: false,
      durationMs: 0,
      error: 'execution_runtime_unavailable: Network namespace isolation unavailable',
      errorCode: 'execution_runtime_unavailable',
    };
  }

  const resolvedWorkspace = path.resolve(workspacePath);

  // 4. Dedicated private scratch directory (never expose host /tmp or host root!)
  const privateScratchDir = path.join(resolvedWorkspace, '.sandbox_scratch');
  if (!fs.existsSync(privateScratchDir)) {
    fs.mkdirSync(privateScratchDir, { recursive: true });
  }

  // Prepare environment: strict minimal allowlist without host secrets or API keys
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: resolvedWorkspace,
    TMPDIR: privateScratchDir,
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

  // 5. Construct argument array with strict Node permission containment
  let finalCommand = process.execPath;
  let finalArgs: string[] = [
    '--permission',
    `--allow-fs-read=${resolvedWorkspace}`,
    `--allow-fs-read=${privateScratchDir}`,
  ];

  for (const r of allowFsRead) {
    finalArgs.push(`--allow-fs-read=${path.resolve(r)}`);
  }

  finalArgs.push(`--allow-fs-write=${resolvedWorkspace}`);
  finalArgs.push(`--allow-fs-write=${privateScratchDir}`);
  for (const w of allowFsWrite) {
    finalArgs.push(`--allow-fs-write=${path.resolve(w)}`);
  }

  finalArgs.push('--no-addons');
  if (options.allowChildProcess) {
    finalArgs.push('--allow-child-process');
  }
  finalArgs.push(...args);

  // 6. Wrap with unshare --user --net --pid --fork for full OS-level namespace boundary isolation
  if (!allowNetwork) {
    finalArgs = ['--user', '--net', '--pid', '--fork', '--', finalCommand, ...finalArgs];
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
      try {
        if (fs.existsSync(privateScratchDir)) fs.rmSync(privateScratchDir, { recursive: true, force: true });
      } catch {}
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

    const spawnedPid = child.pid;

    // Terminate whole process tree via negative PID process group and pkill
    const killProcessTree = (signal: NodeJS.Signals = 'SIGTERM') => {
      try {
        if (child?.pid) {
          try {
            process.kill(-child.pid, signal);
          } catch {}
          try {
            child.kill(signal);
          } catch {}
          try {
            spawnSync('pkill', [`-${signal === 'SIGKILL' ? '9' : '15'}`, '-P', String(child.pid)]);
          } catch {}
        }
      } catch {}
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
      try {
        if (fs.existsSync(privateScratchDir)) fs.rmSync(privateScratchDir, { recursive: true, force: true });
      } catch {}
      resolve({
        exitCode: -1,
        stdout: stdoutData,
        stderr: stderrData || err.message,
        timedOut,
        durationMs: Date.now() - startTime,
        error: err.message,
        errorCode: 'runtime_error',
        childPid: spawnedPid,
      });
    });

    child.on('close', (code: number | null) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      try {
        if (fs.existsSync(privateScratchDir)) fs.rmSync(privateScratchDir, { recursive: true, force: true });
      } catch {}
      resolve({
        exitCode: timedOut ? -1 : code,
        stdout: stdoutData,
        stderr: stderrData,
        timedOut,
        durationMs: Date.now() - startTime,
        error: timedOut ? `Execution timed out after ${timeoutMs}ms` : undefined,
        errorCode: timedOut ? 'timed_out' : undefined,
        childPid: spawnedPid,
      });
    });
  });
}

/**
 * Runs untrusted candidate code synchronously inside the strictly hardened sandbox runtime.
 */
export function runInSandboxSync(options: SandboxExecutionOptions): SandboxExecutionResult {
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

  // 1. Fail closed if Node permission model is not available
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

  // 2. Reject unsupported execution runners (only node is permitted for untrusted candidate code)
  const isNode = command === 'node' || command === process.execPath;
  if (!isNode) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: `Unsupported execution runner "${command}". Untrusted execution must run inside an enforced sandbox runner (node).`,
      timedOut: false,
      durationMs: 0,
      error: 'unsupported_execution_runner',
      errorCode: 'unsupported_execution_runner',
    };
  }

  // 3. Fail closed if network isolation is required but unshare is unavailable
  if (!allowNetwork && !isUnshareSupported()) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: 'Network isolation is required for untrusted candidate execution, but unshare --user --net is unavailable in this environment.',
      timedOut: false,
      durationMs: 0,
      error: 'execution_runtime_unavailable: Network namespace isolation unavailable',
      errorCode: 'execution_runtime_unavailable',
    };
  }

  const resolvedWorkspace = path.resolve(workspacePath);

  // 4. Dedicated private scratch directory
  const privateScratchDir = path.join(resolvedWorkspace, '.sandbox_scratch');
  if (!fs.existsSync(privateScratchDir)) {
    fs.mkdirSync(privateScratchDir, { recursive: true });
  }

  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: resolvedWorkspace,
    TMPDIR: privateScratchDir,
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

  let finalCommand = process.execPath;
  let finalArgs: string[] = [
    '--permission',
    `--allow-fs-read=${resolvedWorkspace}`,
    `--allow-fs-read=${privateScratchDir}`,
  ];

  for (const r of allowFsRead) {
    finalArgs.push(`--allow-fs-read=${path.resolve(r)}`);
  }

  finalArgs.push(`--allow-fs-write=${resolvedWorkspace}`);
  finalArgs.push(`--allow-fs-write=${privateScratchDir}`);
  for (const w of allowFsWrite) {
    finalArgs.push(`--allow-fs-write=${path.resolve(w)}`);
  }

  finalArgs.push('--no-addons');
  if (options.allowChildProcess) {
    finalArgs.push('--allow-child-process');
  }
  finalArgs.push(...args);

  if (!allowNetwork) {
    finalArgs = ['--user', '--net', '--pid', '--fork', '--', finalCommand, ...finalArgs];
    finalCommand = 'unshare';
  }

  const startTime = Date.now();
  let spawnResult;

  try {
    spawnResult = spawnSync(finalCommand, finalArgs, {
      cwd: resolvedWorkspace,
      env: safeEnv,
      timeout: timeoutMs,
      maxBuffer: maxBufferBytes,
      encoding: 'utf8',
    });
  } catch (err: any) {
    try {
      if (fs.existsSync(privateScratchDir)) fs.rmSync(privateScratchDir, { recursive: true, force: true });
    } catch {}
    return {
      exitCode: -1,
      stdout: '',
      stderr: err.message,
      timedOut: false,
      durationMs: Date.now() - startTime,
      error: `Failed to spawn process in sandbox: ${err.message}`,
      errorCode: 'spawn_failed',
    };
  } finally {
    try {
      if (fs.existsSync(privateScratchDir)) fs.rmSync(privateScratchDir, { recursive: true, force: true });
    } catch {}
  }

  const durationMs = Date.now() - startTime;
  const timedOut = Boolean(spawnResult.error && (spawnResult.error as any).code === 'ETIMEDOUT');
  const exitCode = timedOut ? -1 : spawnResult.status;

  return {
    exitCode,
    stdout: spawnResult.stdout || '',
    stderr: spawnResult.stderr || (spawnResult.error ? spawnResult.error.message : ''),
    timedOut,
    durationMs,
    error: timedOut ? `Execution timed out after ${timeoutMs}ms` : spawnResult.error?.message,
    errorCode: timedOut ? 'timed_out' : undefined,
    childPid: spawnResult.pid,
  };
}

