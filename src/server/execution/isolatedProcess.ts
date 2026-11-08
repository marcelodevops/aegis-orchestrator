/**
 * Aegis Orchestrator - Subprocess Execution Isolation
 * 
 * Executes commands out-of-process via child_process.spawn with:
 * 1. Strict argument arrays (no shell interpretation/injection)
 * 2. Execution deadlines with escalation (SIGTERM -> SIGKILL)
 * 3. Scrubbed environment variables (no leak of API keys or auth tokens)
 * 4. Output buffer capping
 */

import { spawn } from 'child_process';

export interface ProcessRunOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  maxBufferBytes?: number;
}

export interface ProcessRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

import os from 'os';
import path from 'path';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BUFFER = 1024 * 512; // 512 KB

// Strict allowlist: ONLY permitted system variables are forwarded
const ALLOWED_ENV_VARS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TZ',
];

export async function runIsolatedProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  const {
    command,
    args,
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = {},
    maxBufferBytes = DEFAULT_MAX_BUFFER,
  } = options;

  // Build minimal, scrubbed environment from strict allowlist
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: cwd, // Confine HOME to target workspace
    TMPDIR: os.tmpdir(),
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
    NODE_ENV: 'test',
    AEGIS_ISOLATED: '1',
  };

  for (const key of ALLOWED_ENV_VARS) {
    if (process.env[key] !== undefined && safeEnv[key] === undefined) {
      safeEnv[key] = process.env[key];
    }
  }

  // Merge explicitly provided caller variables (never inheriting server secrets)
  for (const [k, v] of Object.entries(env)) {
    if (ALLOWED_ENV_VARS.includes(k) || k.startsWith('AEGIS_') || k === 'NODE_ENV' || k === 'GIT_INDEX_FILE') {
      safeEnv[k] = v;
    }
  }

  const startTime = Date.now();
  let stdoutData = '';
  let stderrData = '';
  let timedOut = false;

  return new Promise<ProcessRunResult>((resolve) => {
    let child: any;
    let timer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    try {
      child = spawn(command, args, {
        cwd,
        env: safeEnv,
        shell: false, // Disallow shell evaluation
        detached: true, // Process group leader to enable whole-tree termination
      });
    } catch (err: any) {
      return resolve({
        exitCode: -1,
        stdout: '',
        stderr: err.message,
        timedOut: false,
        durationMs: Date.now() - startTime,
        error: `Failed to spawn process: ${err.message}`,
      });
    }

    // Helper to terminate entire process tree via process group
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

    // Set timeout handler
    timer = setTimeout(() => {
      timedOut = true;
      try {
        killProcessTree('SIGTERM');
        // Give 1000ms for graceful shutdown, else SIGKILL entire process group
        killTimer = setTimeout(() => {
          killProcessTree('SIGKILL');
        }, 1000);
      } catch {}
    }, timeoutMs);

    child.stdout?.on('data', (data: Buffer) => {
      if (stdoutData.length < maxBufferBytes) {
        stdoutData += data.toString('utf8');
        if (stdoutData.length > maxBufferBytes) {
          stdoutData = stdoutData.slice(0, maxBufferBytes) + '\n[Truncated: stdout buffer limit exceeded]';
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      if (stderrData.length < maxBufferBytes) {
        stderrData += data.toString('utf8');
        if (stderrData.length > maxBufferBytes) {
          stderrData = stderrData.slice(0, maxBufferBytes) + '\n[Truncated: stderr buffer limit exceeded]';
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
        error: timedOut ? `Execution exceeded deadline of ${timeoutMs}ms` : undefined,
      });
    });
  });
}
