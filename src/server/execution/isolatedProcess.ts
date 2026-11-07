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

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BUFFER = 1024 * 512; // 512 KB

const BLOCKED_ENV_VARS = [
  'GEMINI_API_KEY',
  'AEGIS_AUTH_TOKEN',
  'JIRA_API_TOKEN',
  'SLACK_BOT_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'SECRET',
  'AWS_SECRET_ACCESS_KEY',
  'DATABASE_URL',
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

  // Build scrubbed environment
  const safeEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!BLOCKED_ENV_VARS.some((blocked) => key.toUpperCase().includes(blocked))) {
      safeEnv[key] = value;
    }
  }

  // Merge custom caller environment (also scrubbed)
  for (const [k, v] of Object.entries(env)) {
    if (!BLOCKED_ENV_VARS.some((blocked) => k.toUpperCase().includes(blocked))) {
      safeEnv[k] = v;
    }
  }

  // Set default safe execution vars
  safeEnv.NODE_ENV = safeEnv.NODE_ENV || 'test';
  safeEnv.AEGIS_ISOLATED = '1';

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
        detached: false,
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

    // Set timeout handler
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
        // Give 1.5 seconds for graceful shutdown, else SIGKILL
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
        }, 1500);
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
