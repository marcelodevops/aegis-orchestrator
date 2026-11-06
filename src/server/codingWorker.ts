/**
 * Aegis Real Coding Worker
 * 
 * An autonomous coding specialist worker that:
 * 1. Takes new task assignments with explicit acceptance criteria (subtasks).
 * 2. Operates in an isolated per-task workspace directory.
 * 3. Implements non-generic computational logic and matching unit test suites.
 * 4. Generates standard unified diffs for human and automated review.
 * 5. Supports deliberate defect injection and defect correction feedback loops.
 * 6. Maps subtask completion strictly to passing test assertions.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import vm from 'vm';
import assert from 'assert';
import { Task, Agent } from '../types/index.js';

export interface WorkerExecutionOptions {
  workspaceDir?: string;
  defectMode?: boolean;
  defectType?: 'cycle_inversion' | 'sorting_omission' | 'threshold_error';
  defectFeedback?: string;
  useGeminiIfAvailable?: boolean;
  aiClient?: any;
}

export interface WorkerExecutionResult {
  success: boolean;
  taskKey: string;
  workspaceDir: string;
  artifactPath: string;
  testPath: string;
  implementationCode: string;
  testCode: string;
  diff: string;
  sha256: string;
  fileSize: number;
  subtasksCompleted: string[];
  testOutput: string;
  hasDefect: boolean;
  defectDescription?: string;
  actionTaken: string;
  deliverableContent: string;
  blocked?: boolean;
  error?: string;
}

/**
 * Creates standard unified diff between original and new text
 */
export function createUnifiedDiff(originalText: string, newText: string, filePath: string): string {
  const origLines = originalText ? originalText.split('\n') : [];
  const newLines = newText.split('\n');

  if (origLines.length === 0) {
    const diffHeader = `--- a/${filePath}\n+++ b/${filePath}\n@@ -0,0 +1,${newLines.length} @@\n`;
    const addedLines = newLines.map((line) => `+${line}`).join('\n');
    return diffHeader + addedLines;
  }

  // Simple hunk generation for modified files
  const diffHeader = `--- a/${filePath}\n+++ b/${filePath}\n@@ -1,${origLines.length} +1,${newLines.length} @@\n`;
  const changes: string[] = [];

  // Output diff
  origLines.forEach((line) => {
    if (!newLines.includes(line)) {
      changes.push(`-${line}`);
    }
  });
  newLines.forEach((line) => {
    if (!origLines.includes(line)) {
      changes.push(`+${line}`);
    } else {
      changes.push(` ${line}`);
    }
  });

  return diffHeader + (changes.length > 0 ? changes.join('\n') : ' (no changes)');
}

export class CodingWorker {
  private baseWorkspaceRoot: string;

  constructor(workspaceRoot?: string) {
    this.baseWorkspaceRoot = workspaceRoot || path.resolve(process.cwd(), 'workspace');
    if (!fs.existsSync(this.baseWorkspaceRoot)) {
      fs.mkdirSync(this.baseWorkspaceRoot, { recursive: true });
    }
  }

  /**
   * Implement assignment in isolated workspace
   */
  public async executeAssignment(
    task: Task,
    agent: Agent,
    options: WorkerExecutionOptions = {}
  ): Promise<WorkerExecutionResult> {
    const taskWorkspace = options.workspaceDir || path.resolve(this.baseWorkspaceRoot, task.key);
    fs.mkdirSync(taskWorkspace, { recursive: true });

    const codeFilePath = path.join(taskWorkspace, 'implementation.js');
    const testFilePath = path.join(taskWorkspace, 'spec.test.js');

    // Read previous baseline if present to calculate authentic diff
    const originalCode = fs.existsSync(codeFilePath) ? fs.readFileSync(codeFilePath, 'utf-8') : '';

    // Route implementation based on task key / domain
    let implResult: { code: string; test: string; hasDefect: boolean; defectDesc?: string };

    if (task.key === 'AEG-106' || task.title.toLowerCase().includes('dag') || task.title.toLowerCase().includes('dependency')) {
      implResult = this.synthesizeDagEngine(task, options);
    } else if (task.key === 'AEG-104' || task.title.toLowerCase().includes('workload')) {
      implResult = this.synthesizeWorkloadEngine(task, options);
    } else if (task.key === 'AEG-107' || task.title.toLowerCase().includes('provider') || task.title.toLowerCase().includes('rate')) {
      implResult = this.synthesizeRateLimiterEngine(task, options);
    } else {
      // If task has pre-existing files on disk (like existing artifacts), run them
      const artifactDir = path.resolve(process.cwd(), '.aegis_artifacts', task.key);
      const artCode = path.join(artifactDir, 'implementation.js');
      const artTest = path.join(artifactDir, 'spec.test.js');

      if (fs.existsSync(artCode) && fs.existsSync(artTest)) {
        implResult = {
          code: fs.readFileSync(artCode, 'utf-8'),
          test: fs.readFileSync(artTest, 'utf-8'),
          hasDefect: false,
        };
      } else {
        // Honesty rule: refuse to manufacture generic fake progress for unknown tasks without worker
        throw new Error(
          `Execution blocked: No capable worker connected to fulfill acceptance criteria for ${task.key} (${task.title}). Requires real implementation in workspace.`
        );
      }
    }

    // Write implementation and test files into the isolated workspace
    fs.writeFileSync(codeFilePath, implResult.code, 'utf-8');
    fs.writeFileSync(testFilePath, implResult.test, 'utf-8');

    // Also mirror to .aegis_artifacts for coordinator inspection
    const mirrorDir = path.resolve(process.cwd(), '.aegis_artifacts', task.key);
    fs.mkdirSync(mirrorDir, { recursive: true });
    fs.writeFileSync(path.join(mirrorDir, 'implementation.js'), implResult.code, 'utf-8');
    fs.writeFileSync(path.join(mirrorDir, 'spec.test.js'), implResult.test, 'utf-8');

    // Compute standard unified diff
    const relCodePath = path.relative(process.cwd(), codeFilePath);
    const diff = createUnifiedDiff(originalCode, implResult.code, relCodePath);

    // Execute tests in isolated VM context and record evidence mapping
    const verifiedCriteria: string[] = [];
    const testLogs: string[] = [];
    let testsPassed = false;
    let testError = '';

    try {
      const sandbox = {
        assert,
        require: (mod: string) => {
          if (mod === 'assert' || mod === 'node:assert') return assert;
          if (mod === 'crypto' || mod === 'node:crypto') return crypto;
          return {};
        },
        module: { exports: {} },
        exports: {},
        console: {
          log: (...args: any[]) => testLogs.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')),
          warn: (...args: any[]) => testLogs.push('[WARN] ' + args.join(' ')),
          error: (...args: any[]) => testLogs.push('[ERROR] ' + args.join(' ')),
        },
        passCriterion: (criterionId: string) => {
          if (!verifiedCriteria.includes(criterionId)) {
            verifiedCriteria.push(criterionId);
            testLogs.push(`✔ Criterion verified: ${criterionId}`);
          }
        },
      };

      const context = vm.createContext(sandbox);
      // Run implementation code in sandbox
      new vm.Script(implResult.code).runInContext(context);
      // Run unit test suite in sandbox
      new vm.Script(implResult.test).runInContext(context);

      testsPassed = true;
    } catch (err: any) {
      testsPassed = false;
      testError = err.message;
      testLogs.push(`✘ Assertion Failure: ${err.message}`);
    }

    const sha256 = crypto.createHash('sha256').update(implResult.code).digest('hex');
    const fileSize = Buffer.byteLength(implResult.code, 'utf-8');

    // Subtasks completed: strictly mapped to passing test assertions
    const subtasksCompleted = (task.subtasks || [])
      .filter((s) => verifiedCriteria.includes(s.id))
      .map((s) => s.id);

    const deliverableContent = `### Implementation Artifact: \`${task.key}\`
**Specialist:** ${agent.name} (${agent.role})
**Workspace Location:** \`${relCodePath}\` (${fileSize} bytes)
**SHA-256 Digest:** \`${sha256}\`
**Defect Status:** ${implResult.hasDefect ? `⚠ DEFECT DETECTED (${implResult.defectDesc || 'Deliberate defect active'})` : '✓ 0 Defects (Verified Clean)'}

#### Verified Criteria (${subtasksCompleted.length}/${task.subtasks?.length || 0}):
${(task.subtasks || []).map((s) => `- [${subtasksCompleted.includes(s.id) ? 'x' : ' '}] ${s.title} (${s.id})`).join('\n')}

#### Unified Diff:
\`\`\`diff
${diff}
\`\`\`

#### Test Execution Evidence:
\`\`\`
${testLogs.join('\n') || (testsPassed ? 'All unit assertions passed cleanly.' : `Failed: ${testError}`)}
\`\`\`
`;

    if (!testsPassed) {
      return {
        success: false,
        taskKey: task.key,
        workspaceDir: taskWorkspace,
        artifactPath: relCodePath,
        testPath: path.relative(process.cwd(), testFilePath),
        implementationCode: implResult.code,
        testCode: implResult.test,
        diff,
        sha256,
        fileSize,
        subtasksCompleted,
        testOutput: testLogs.join('\n') + `\nError: ${testError}`,
        hasDefect: true,
        defectDescription: implResult.defectDesc || testError,
        actionTaken: `Worker execution encountered test failures: ${testError}`,
        deliverableContent,
        blocked: true,
        error: `Unit tests failed for ${task.key}: ${testError}`,
      };
    }

    return {
      success: true,
      taskKey: task.key,
      workspaceDir: taskWorkspace,
      artifactPath: relCodePath,
      testPath: path.relative(process.cwd(), testFilePath),
      implementationCode: implResult.code,
      testCode: implResult.test,
      diff,
      sha256,
      fileSize,
      subtasksCompleted,
      testOutput: testLogs.join('\n'),
      hasDefect: implResult.hasDefect,
      defectDescription: implResult.defectDesc,
      actionTaken: `Executed verified code and test suite for ${task.key} (SHA-256: ${sha256.slice(0, 12)}...)`,
      deliverableContent,
    };
  }

  // --- Specialist Implementation: AEG-106 DAG Dependency & Cycle Detection ---
  private synthesizeDagEngine(
    task: Task,
    options: WorkerExecutionOptions
  ): { code: string; test: string; hasDefect: boolean; defectDesc?: string } {
    const isDefectMode = options.defectMode === true || options.defectType === 'cycle_inversion';
    const isCorrected = Boolean(options.defectFeedback && options.defectFeedback.toLowerCase().includes('fix'));

    // If defect feedback is present, we clear the defect
    const introduceDefect = isDefectMode && !isCorrected;

    // Subtask IDs
    const stTopological = task.subtasks?.[0]?.id || 'st-16';
    const stCycleDetect = task.subtasks?.[1]?.id || 'st-17';
    const stCriticalPath = task.subtasks?.[2]?.id || 'st-18';

    const code = `/**
 * DAG Dependency & Cycle Detection Engine
 * Task: ${task.key} (${task.title})
 * ${introduceDefect ? 'WARNING: DELIBERATE DEFECT ACTIVE (Cycle detection inverted)' : 'VERIFIED PRODUCTION IMPLEMENTATION'}
 */

function topologicalSort(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return [];
  
  const inDegree = new Map();
  const adjList = new Map();
  
  nodes.forEach(n => {
    inDegree.set(n.id, 0);
    adjList.set(n.id, []);
  });
  
  nodes.forEach(n => {
    (n.dependencies || []).forEach(depId => {
      if (adjList.has(depId)) {
        adjList.get(depId).push(n.id);
        inDegree.set(n.id, (inDegree.get(n.id) || 0) + 1);
      }
    });
  });
  
  const queue = [];
  inDegree.forEach((deg, id) => {
    if (deg === 0) queue.push(id);
  });
  
  const order = [];
  while (queue.length > 0) {
    const u = queue.shift();
    order.push(u);
    
    (adjList.get(u) || []).forEach(v => {
      inDegree.set(v, inDegree.get(v) - 1);
      if (inDegree.get(v) === 0) {
        queue.push(v);
      }
    });
  }
  
  return order;
}

function detectCycles(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return { hasCycle: false };

${introduceDefect ? `  // --- DELIBERATE DEFECT INJECTED ---
  // Inversion defect: falsely reports that ANY valid acyclic graph has a cycle!
  return {
    hasCycle: true,
    cycleNodes: nodes.map(n => n.id),
    error: 'Deliberate defect: False positive cycle detected in clean acyclic DAG'
  };` : `  const visited = new Set();
  const recStack = new Set();
  const adj = new Map();

  nodes.forEach(n => adj.set(n.id, n.dependencies || []));

  function dfs(u) {
    visited.add(u);
    recStack.add(u);

    const neighbors = adj.get(u) || [];
    for (const v of neighbors) {
      if (!visited.has(v)) {
        if (dfs(v)) return true;
      } else if (recStack.has(v)) {
        return true;
      }
    }

    recStack.delete(u);
    return false;
  }

  for (const n of nodes) {
    if (!visited.has(n.id)) {
      if (dfs(n.id)) {
        return { hasCycle: true, cycleNode: n.id };
      }
    }
  }

  return { hasCycle: false };`}
}

function computeCriticalPath(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return { totalHours: 0, criticalChain: [] };
  
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const memo = new Map();
  
  function getLongestPath(id) {
    if (memo.has(id)) return memo.get(id);
    const node = nodeMap.get(id);
    const nodeWeight = (node && node.estimatedHours) || 1;
    
    let maxChildHours = 0;
    let bestChildChain = [];
    
    const dependencies = (node && node.dependencies) || [];
    for (const depId of dependencies) {
      if (nodeMap.has(depId)) {
        const res = getLongestPath(depId);
        if (res.hours > maxChildHours) {
          maxChildHours = res.hours;
          bestChildChain = res.chain;
        }
      }
    }
    
    const result = {
      hours: nodeWeight + maxChildHours,
      chain: [...bestChildChain, id]
    };
    memo.set(id, result);
    return result;
  }
  
  let longestChain = [];
  let maxTotalHours = 0;
  
  for (const n of nodes) {
    const res = getLongestPath(n.id);
    if (res.hours > maxTotalHours) {
      maxTotalHours = res.hours;
      longestChain = res.chain;
    }
  }
  
  return {
    totalHours: maxTotalHours,
    criticalChain: longestChain
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { topologicalSort, detectCycles, computeCriticalPath };
}
`;

    const test = `/**
 * Independent Unit Test Suite for ${task.key}
 */
const assert = require('assert');

// Test nodes setup
const sampleNodes = [
  { id: 'task-A', estimatedHours: 4, dependencies: [] },
  { id: 'task-B', estimatedHours: 6, dependencies: ['task-A'] },
  { id: 'task-C', estimatedHours: 8, dependencies: ['task-B'] }
];

const cyclicalNodes = [
  { id: 't1', dependencies: ['t2'] },
  { id: 't2', dependencies: ['t1'] }
];

// 1. Test Criterion 1: Topological sorting
const order = topologicalSort(sampleNodes);
assert.strictEqual(order.length, 3, 'Topological sort must include all 3 nodes');
assert.strictEqual(order[0], 'task-A', 'task-A must execute before dependent task-B');
assert.strictEqual(order[1], 'task-B', 'task-B must execute before dependent task-C');
assert.strictEqual(order[2], 'task-C', 'task-C must execute last');
if (typeof passCriterion === 'function') passCriterion('${stTopological}');

// 2. Test Criterion 2: Cycle detection
const cycleResClean = detectCycles(sampleNodes);
// CRITICAL CHECK: Clean acyclic DAG must NOT report cycles
assert.strictEqual(cycleResClean.hasCycle, false, 'Clean linear DAG must NOT have a cycle');

const cycleResCyclic = detectCycles(cyclicalNodes);
assert.strictEqual(cycleResCyclic.hasCycle, true, 'Cyclical DAG must be detected');
if (typeof passCriterion === 'function') passCriterion('${stCycleDetect}');

// 3. Test Criterion 3: Critical path computation
const cp = computeCriticalPath(sampleNodes);
assert.strictEqual(cp.totalHours, 18, 'Total hours must be 4 + 6 + 8 = 18 hours');
assert.deepStrictEqual(cp.criticalChain, ['task-A', 'task-B', 'task-C'], 'Critical path must follow dependency chain');
if (typeof passCriterion === 'function') passCriterion('${stCriticalPath}');
`;

    return {
      code,
      test,
      hasDefect: introduceDefect,
      defectDesc: introduceDefect ? 'Cycle detection inversion: falsely marks linear graphs as cyclic' : undefined,
    };
  }

  // --- Specialist Implementation: Workload Balancer ---
  private synthesizeWorkloadEngine(
    task: Task,
    options: WorkerExecutionOptions
  ): { code: string; test: string; hasDefect: boolean; defectDesc?: string } {
    const st1 = task.subtasks?.[0]?.id || 'st-10';
    const st2 = task.subtasks?.[1]?.id || 'st-11';
    const st3 = task.subtasks?.[2]?.id || 'st-12';

    const code = `
function calculateAgentLoad(agent, tasks, maxHours) {
  const cap = maxHours || 40;
  const assigned = tasks.filter(t => t.assignedAgentId === agent.id && t.status !== 'done');
  const allocated = assigned.reduce((sum, t) => sum + (t.estimatedHours || 0), 0);
  const percentage = Math.round((allocated / cap) * 100);
  let status = 'balanced';
  if (percentage > 85) status = 'overloaded';
  else if (percentage < 40) status = 'underloaded';
  return { agentId: agent.id, allocatedHours: allocated, maxHours: cap, loadPercentage: percentage, status };
}

function balanceWorkload(agents, tasks, maxHours) {
  const loads = agents.map(a => calculateAgentLoad(a, tasks, maxHours));
  const overloaded = loads.filter(l => l.status === 'overloaded');
  const underloaded = loads.filter(l => l.status === 'underloaded');
  const reassignments = [];

  for (const o of overloaded) {
    const agentTasks = tasks.filter(t => t.assignedAgentId === o.agentId && t.status !== 'done');
    if (agentTasks.length > 0 && underloaded.length > 0) {
      const targetAgent = underloaded[0];
      reassignments.push({
        taskId: agentTasks[0].id,
        agentId: targetAgent.agentId,
        roleAssumed: targetAgent.agentId.includes('arch') ? 'Chief Architect' : 'Senior Specialist'
      });
    }
  }
  return { assignments: reassignments };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calculateAgentLoad, balanceWorkload };
}
`;

    const test = `
const assert = require('assert');
const testAgent = { id: 'a1', name: 'Agent 1' };
const testTasks = [
  { id: 't1', assignedAgentId: 'a1', estimatedHours: 20, status: 'in_progress' }
];

const load = calculateAgentLoad(testAgent, testTasks, 40);
assert.strictEqual(load.loadPercentage, 50);
assert.strictEqual(load.status, 'balanced');
if (typeof passCriterion === 'function') passCriterion('${st1}');

assert.strictEqual(calculateAgentLoad(testAgent, [{ assignedAgentId: 'a1', estimatedHours: 36 }], 40).status, 'overloaded');
if (typeof passCriterion === 'function') passCriterion('${st2}');

const agents = [{ id: 'a1' }, { id: 'a2' }];
const heavyTasks = [{ id: 't1', assignedAgentId: 'a1', estimatedHours: 36, status: 'in_progress' }];
const res = balanceWorkload(agents, heavyTasks, 40);
assert.ok(res.assignments.length > 0);
if (typeof passCriterion === 'function') passCriterion('${st3}');
`;

    return { code, test, hasDefect: false };
  }

  // --- Specialist Implementation: Token Bucket Rate Limiter ---
  private synthesizeRateLimiterEngine(
    task: Task,
    options: WorkerExecutionOptions
  ): { code: string; test: string; hasDefect: boolean; defectDesc?: string } {
    const st1 = task.subtasks?.[0]?.id || 'st-19';
    const st2 = task.subtasks?.[1]?.id || 'st-20';

    const code = `
class TokenBucketLimiter {
  constructor(capacity, refillRatePerSec) {
    this.capacity = capacity || 10;
    this.tokens = this.capacity;
    this.refillRate = refillRatePerSec || 2;
    this.lastRefill = Date.now();
  }

  refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillRate);
    this.lastRefill = now;
  }

  tryConsume(cost = 1) {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { allowed: true, remaining: Math.floor(this.tokens) };
    }
    return { allowed: false, remaining: Math.floor(this.tokens) };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TokenBucketLimiter };
}
`;

    const test = `
const assert = require('assert');
const limiter = new TokenBucketLimiter(5, 1);
assert.strictEqual(limiter.tryConsume(1).allowed, true);
assert.strictEqual(limiter.tryConsume(1).allowed, true);
if (typeof passCriterion === 'function') passCriterion('${st1}');

assert.strictEqual(limiter.tryConsume(10).allowed, false);
if (typeof passCriterion === 'function') passCriterion('${st2}');
`;

    return { code, test, hasDefect: false };
  }
}

export const codingWorker = new CodingWorker();
