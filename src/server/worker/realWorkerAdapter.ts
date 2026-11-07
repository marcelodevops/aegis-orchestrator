/**
 * Aegis Orchestrator - Repository-Aware Worker Adapter & Tool Loop
 * 
 * Provides an authoritative worker loop that receives:
 * 1. An authoritative task with explicit acceptance criteria.
 * 2. An approved target repository and base commit.
 * 3. A bounded workspace with enforced path containment.
 * 4. Bounded tools for repository inspection, code search, file updates, and test execution.
 * 5. Budget, execution-time, and turn limits.
 */

import path from 'path';
import fs from 'fs';
import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';
import { assertPathContained } from '../execution/pathContainment.js';
import { runIsolatedProcess } from '../execution/isolatedProcess.js';

export interface WorkerTaskContext {
  id: string;
  key: string;
  title: string;
  description: string;
  criteria: Array<{
    id: string;
    title: string;
    verificationMethod: string;
    verificationSpec?: any;
  }>;
  baseCommit?: string;
  workspacePath: string;
  tokenBudget?: number;
  maxTurns?: number;
  timeoutMs?: number;
}

export interface WorkerToolCallResult {
  tool: string;
  args: any;
  output: string;
  success: boolean;
}

export interface WorkerExecutionResult {
  status: 'completed' | 'failed' | 'budget_exhausted' | 'timed_out';
  tokensUsed: number;
  turnsUsed: number;
  modifiedFiles: string[];
  toolHistory: WorkerToolCallResult[];
  summary: string;
  error?: string;
}

export interface WorkerAdapter {
  executeTask(context: WorkerTaskContext): Promise<WorkerExecutionResult>;
}

/**
 * Worker Toolset Implementation
 */
export class WorkspaceToolExecutor {
  private workspacePath: string;
  public modifiedFiles: Set<string> = new Set();

  constructor(workspacePath: string) {
    this.workspacePath = path.resolve(workspacePath);
    if (!fs.existsSync(this.workspacePath)) {
      fs.mkdirSync(this.workspacePath, { recursive: true });
    }
  }

  public listDirectory(dirPath = '.'): { success: boolean; files?: string[]; error?: string } {
    const check = assertPathContained(dirPath, this.workspacePath);
    if (!check.valid) {
      return { success: false, error: check.error };
    }
    try {
      if (!fs.existsSync(check.resolvedPath)) {
        return { success: false, error: `Directory does not exist: ${dirPath}` };
      }
      const entries = fs.readdirSync(check.resolvedPath, { withFileTypes: true });
      const files = entries
        .filter((e) => !e.name.startsWith('.git') && e.name !== 'node_modules')
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return { success: true, files };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public inspectFile(filePath: string, startLine = 1, endLine = 500): { success: boolean; content?: string; totalLines?: number; error?: string } {
    const check = assertPathContained(filePath, this.workspacePath);
    if (!check.valid) {
      return { success: false, error: check.error };
    }
    try {
      if (!fs.existsSync(check.resolvedPath)) {
        return { success: false, error: `File not found: ${filePath}` };
      }
      const raw = fs.readFileSync(check.resolvedPath, 'utf8');
      const lines = raw.split('\n');
      const slice = lines.slice(Math.max(0, startLine - 1), endLine);
      const formatted = slice.map((line, idx) => `${startLine + idx}: ${line}`).join('\n');
      return { success: true, content: formatted, totalLines: lines.length };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public searchCode(query: string, maxMatches = 20): { success: boolean; matches?: Array<{ file: string; line: number; text: string }>; error?: string } {
    try {
      const matches: Array<{ file: string; line: number; text: string }> = [];
      const walk = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.git') || entry.name === 'node_modules' || entry.name === 'dist') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            try {
              const content = fs.readFileSync(full, 'utf8');
              const lines = content.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(query)) {
                  matches.push({
                    file: path.relative(this.workspacePath, full),
                    line: i + 1,
                    text: lines[i].trim(),
                  });
                  if (matches.length >= maxMatches) return;
                }
              }
            } catch {}
          }
        }
      };
      walk(this.workspacePath);
      return { success: true, matches };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public applyFileChange(filePath: string, newContent: string): { success: boolean; error?: string } {
    const check = assertPathContained(filePath, this.workspacePath);
    if (!check.valid) {
      return { success: false, error: check.error };
    }
    try {
      const parentDir = path.dirname(check.resolvedPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      fs.writeFileSync(check.resolvedPath, newContent, 'utf8');
      this.modifiedFiles.add(path.relative(this.workspacePath, check.resolvedPath));
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public async runValidationTest(cmd: string, args: string[] = []): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number | null }> {
    // Only allow safe test and build runners
    const allowedCommands = ['node', 'npm', 'npx', 'tsx'];
    const baseCmd = path.basename(cmd);
    if (!allowedCommands.includes(baseCmd)) {
      return {
        success: false,
        stdout: '',
        stderr: `Command '${cmd}' is not allowed in worker validation. Allowed: ${allowedCommands.join(', ')}`,
        exitCode: -1,
      };
    }

    const res = await runIsolatedProcess({
      command: cmd,
      args,
      cwd: this.workspacePath,
      timeoutMs: 15000,
    });

    return {
      success: res.exitCode === 0,
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
    };
  }
}

/**
 * Tool declarations for Gemini
 */
const workerToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'list_directory',
    description: 'Lists files in the workspace directory.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        dirPath: { type: Type.STRING, description: 'Relative path to directory, defaults to "."' },
      },
    },
  },
  {
    name: 'inspect_file',
    description: 'Reads contents of an existing file in the workspace.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        filePath: { type: Type.STRING, description: 'Relative path to the file.' },
        startLine: { type: Type.INTEGER, description: 'Starting line number (1-indexed)' },
        endLine: { type: Type.INTEGER, description: 'Ending line number' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'search_code',
    description: 'Searches for text or symbol in workspace files.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Search text' },
      },
      required: ['query'],
    },
  },
  {
    name: 'apply_file_change',
    description: 'Creates or completely overwrites a file in the workspace.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        filePath: { type: Type.STRING, description: 'Relative path to the file.' },
        newContent: { type: Type.STRING, description: 'The complete new content of the file.' },
      },
      required: ['filePath', 'newContent'],
    },
  },
  {
    name: 'run_validation_test',
    description: 'Runs an isolated validation test command in the workspace.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        cmd: { type: Type.STRING, description: 'Command to run (node, npm, npx, tsx)' },
        args: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Command arguments' },
      },
      required: ['cmd'],
    },
  },
];

/**
 * Real Gemini-backed Worker Adapter using @google/genai
 */
export class GeminiWorkerAdapter implements WorkerAdapter {
  private ai: GoogleGenAI;
  private modelName = 'gemini-3.8-flash';

  constructor(apiKey?: string) {
    const key = apiKey || process.env.GEMINI_API_KEY;
    this.ai = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }

  public async executeTask(context: WorkerTaskContext): Promise<WorkerExecutionResult> {
    const maxTurns = context.maxTurns || 12;
    const toolExecutor = new WorkspaceToolExecutor(context.workspacePath);
    const toolHistory: WorkerToolCallResult[] = [];
    let tokensUsed = 0;
    let turnsUsed = 0;

    const systemPrompt = `You are an expert autonomous software engineer working on task ${context.key}: "${context.title}".
Your goal is to inspect the workspace code, implement the required changes to fulfill all acceptance criteria, and verify your implementation.

Acceptance Criteria:
${context.criteria.map((c, i) => `${i + 1}. [${c.id}] ${c.title}`).join('\n')}

Workspace Rules:
1. Always inspect existing code first using list_directory, search_code, or inspect_file.
2. Implement clean, robust code using apply_file_change.
3. Validate your implementation using run_validation_test.
4. When finished, provide a clear summary of your changes.`;

    const chat = this.ai.chats.create({
      model: this.modelName,
      config: {
        systemInstruction: systemPrompt,
        tools: [{ functionDeclarations: workerToolDeclarations }],
      },
    });

    let currentPrompt = `Please start by inspecting the workspace and planning your implementation for ${context.key}.`;

    while (turnsUsed < maxTurns) {
      turnsUsed++;

      let response: any;
      try {
        response = await chat.sendMessage({ message: currentPrompt });
      } catch (err: any) {
        return {
          status: 'failed',
          tokensUsed,
          turnsUsed,
          modifiedFiles: Array.from(toolExecutor.modifiedFiles),
          toolHistory,
          summary: 'Worker execution failed during Gemini API call.',
          error: err.message,
        };
      }

      // Estimate tokens
      tokensUsed += response.usageMetadata?.totalTokenCount || 500;
      if (context.tokenBudget && tokensUsed > context.tokenBudget) {
        return {
          status: 'budget_exhausted',
          tokensUsed,
          turnsUsed,
          modifiedFiles: Array.from(toolExecutor.modifiedFiles),
          toolHistory,
          summary: 'Worker exceeded token budget limit.',
          error: `Exceeded token budget: ${tokensUsed} > ${context.tokenBudget}`,
        };
      }

      const functionCalls = response.functionCalls;
      if (!functionCalls || functionCalls.length === 0) {
        // Model finished tool calls and gave text summary
        return {
          status: 'completed',
          tokensUsed,
          turnsUsed,
          modifiedFiles: Array.from(toolExecutor.modifiedFiles),
          toolHistory,
          summary: response.text || 'Worker completed task implementation.',
        };
      }

      // Execute tool calls
      const toolOutputs: string[] = [];
      for (const fc of functionCalls) {
        const name = fc.name;
        const args = fc.args as any;

        let resultOutput = '';
        let success = true;

        if (name === 'list_directory') {
          const res = toolExecutor.listDirectory(args.dirPath);
          resultOutput = res.success ? JSON.stringify(res.files) : `Error: ${res.error}`;
          success = res.success;
        } else if (name === 'inspect_file') {
          const res = toolExecutor.inspectFile(args.filePath, args.startLine, args.endLine);
          resultOutput = res.success ? (res.content || '') : `Error: ${res.error}`;
          success = res.success;
        } else if (name === 'search_code') {
          const res = toolExecutor.searchCode(args.query);
          resultOutput = res.success ? JSON.stringify(res.matches) : `Error: ${res.error}`;
          success = res.success;
        } else if (name === 'apply_file_change') {
          const res = toolExecutor.applyFileChange(args.filePath, args.newContent);
          resultOutput = res.success ? `Successfully updated ${args.filePath}` : `Error: ${res.error}`;
          success = res.success;
        } else if (name === 'run_validation_test') {
          const res = await toolExecutor.runValidationTest(args.cmd, args.args || []);
          resultOutput = `Exit Code: ${res.exitCode}\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`;
          success = res.success;
        } else {
          resultOutput = `Unknown tool: ${name}`;
          success = false;
        }

        toolHistory.push({
          tool: name,
          args,
          output: resultOutput,
          success,
        });

        toolOutputs.push(`[Tool ${name} result]:\n${resultOutput}`);
      }

      currentPrompt = toolOutputs.join('\n\n');
    }

    return {
      status: 'budget_exhausted',
      tokensUsed,
      turnsUsed,
      modifiedFiles: Array.from(toolExecutor.modifiedFiles),
      toolHistory,
      summary: `Turn limit (${maxTurns}) reached without final model completion.`,
    };
  }
}

/**
 * Fixture Worker Provider for deterministic testing and reproducible end-to-end evaluation.
 * Allows injecting deliberate defects and simulating worker correction passes.
 */
export class FixtureWorkerAdapter implements WorkerAdapter {
  private customHandler?: (context: WorkerTaskContext, executor: WorkspaceToolExecutor) => Promise<string>;

  constructor(customHandler?: (context: WorkerTaskContext, executor: WorkspaceToolExecutor) => Promise<string>) {
    this.customHandler = customHandler;
  }

  public async executeTask(context: WorkerTaskContext): Promise<WorkerExecutionResult> {
    const executor = new WorkspaceToolExecutor(context.workspacePath);
    const toolHistory: WorkerToolCallResult[] = [];

    if (this.customHandler) {
      try {
        const summary = await this.customHandler(context, executor);
        return {
          status: 'completed',
          tokensUsed: 120,
          turnsUsed: 2,
          modifiedFiles: Array.from(executor.modifiedFiles),
          toolHistory,
          summary,
        };
      } catch (err: any) {
        return {
          status: 'failed',
          tokensUsed: 50,
          turnsUsed: 1,
          modifiedFiles: Array.from(executor.modifiedFiles),
          toolHistory,
          summary: 'Fixture execution failed',
          error: err.message,
        };
      }
    }

    // Default fixture action: inspect directory and report
    const listRes = executor.listDirectory();
    toolHistory.push({
      tool: 'list_directory',
      args: {},
      output: JSON.stringify(listRes.files),
      success: listRes.success,
    });

    return {
      status: 'completed',
      tokensUsed: 80,
      turnsUsed: 1,
      modifiedFiles: Array.from(executor.modifiedFiles),
      toolHistory,
      summary: `Fixture executed task ${context.key}`,
    };
  }
}
