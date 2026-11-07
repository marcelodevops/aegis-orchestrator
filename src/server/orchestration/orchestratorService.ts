/**
 * Aegis Orchestrator - Authoritative Orchestration & Autonomy Service
 * 
 * Manages:
 * 1. Kahn's DAG cycle detection and topological scheduling
 * 2. Server-enforced task state machine and dependency gating
 * 3. Worker execution rate-limits and concurrency limits
 * 4. Truthful integration status (explicit not_configured states)
 */

import { storage } from '../storage/db.js';
import { getSecret } from '../security/secrets.js';

export interface SchedulingOrderResult {
  hasCycle: boolean;
  order: string[]; // task IDs in dependency order
  cycleNodes?: string[];
}

export interface WorkerConcurrencyState {
  agentId: string;
  activeRunsCount: number;
  maxConcurrentRuns: number;
  tokensConsumedLastMinute: number;
  maxTokensPerMinute: number;
}

export class OrchestratorService {
  private static activeRunsMap: Map<string, number> = new Map();
  private static tokenUsageMap: Map<string, { count: number; resetAt: number }> = new Map();

  /**
   * Kahn's Algorithm for DAG topological sort and cycle detection.
   */
  public static computeExecutionOrder(tasks: any[]): SchedulingOrderResult {
    const inDegree: Map<string, number> = new Map();
    const adj: Map<string, string[]> = new Map();
    const taskMap: Map<string, any> = new Map();

    for (const t of tasks) {
      taskMap.set(t.id, t);
      taskMap.set(t.key, t);
      inDegree.set(t.id, 0);
      adj.set(t.id, []);
    }

    // Populate edges: dependency -> task
    for (const t of tasks) {
      const deps: string[] = t.dependencies || [];
      for (const depId of deps) {
        // Resolve either ID or Key
        const parentTask = taskMap.get(depId);
        if (parentTask && parentTask.id !== t.id) {
          adj.get(parentTask.id)?.push(t.id);
          inDegree.set(t.id, (inDegree.get(t.id) || 0) + 1);
        }
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) {
        queue.push(id);
      }
    }

    const order: string[] = [];
    while (queue.length > 0) {
      const u = queue.shift()!;
      order.push(u);

      const neighbors = adj.get(u) || [];
      for (const v of neighbors) {
        const nextDeg = (inDegree.get(v) || 0) - 1;
        inDegree.set(v, nextDeg);
        if (nextDeg === 0) {
          queue.push(v);
        }
      }
    }

    if (order.length !== tasks.length) {
      const cycleNodes = tasks.filter((t) => (inDegree.get(t.id) || 0) > 0).map((t) => t.key);
      return {
        hasCycle: true,
        order: [],
        cycleNodes,
      };
    }

    return {
      hasCycle: false,
      order,
    };
  }

  /**
   * Evaluates if a task's dependencies are all satisfied (done status).
   */
  public static areDependenciesSatisfied(taskId: string): { satisfied: boolean; unmetDeps: string[] } {
    const task = storage.getTaskById(taskId);
    if (!task) return { satisfied: false, unmetDeps: ['Task not found'] };

    const deps: string[] = task.dependencies || [];
    const unmetDeps: string[] = [];

    for (const depRef of deps) {
      const parent = storage.getTaskById(depRef);
      if (!parent || parent.status !== 'done') {
        unmetDeps.push(parent ? parent.key : depRef);
      }
    }

    return {
      satisfied: unmetDeps.length === 0,
      unmetDeps,
    };
  }

  /**
   * Validates and executes a task state transition with server revision checks.
   */
  public static transitionTaskStatus(
    taskId: string,
    targetStatus: string,
    expectedVersion?: number,
    actor = 'system'
  ): { success: boolean; task?: any; error?: string } {
    const task = storage.getTaskById(taskId);
    if (!task) {
      return { success: false, error: `Task not found: ${taskId}` };
    }

    const allowedTransitions: Record<string, string[]> = {
      backlog: ['todo', 'cancelled'],
      todo: ['in_progress', 'blocked', 'cancelled'],
      in_progress: ['review', 'blocked', 'todo', 'cancelled'],
      review: ['done', 'in_progress', 'blocked'],
      blocked: ['todo', 'in_progress', 'cancelled'],
      done: ['todo'], // reopening allowed if rejected
      cancelled: ['backlog', 'todo'],
    };

    const validNext = allowedTransitions[task.status] || [];
    if (!validNext.includes(targetStatus)) {
      return {
        success: false,
        error: `Illegal state transition: Cannot move task from '${task.status}' to '${targetStatus}'. Allowed: [${validNext.join(', ')}]`,
      };
    }

    // Dependency check for in_progress or done
    if (['in_progress', 'done'].includes(targetStatus)) {
      const depCheck = this.areDependenciesSatisfied(task.id);
      if (!depCheck.satisfied) {
        return {
          success: false,
          error: `Blocked by dependencies: Cannot move to '${targetStatus}' until prerequisites [${depCheck.unmetDeps.join(', ')}] are Done.`,
        };
      }
    }

    // Strict acceptance gate for 'done': Must have passing criteria evidence
    if (targetStatus === 'done') {
      const criteria = storage.getCriteriaForTask(task.id);
      if (criteria.length > 0) {
        const unpassed = criteria.filter((c) => c.status !== 'passed');
        if (unpassed.length > 0) {
          return {
            success: false,
            error: `Acceptance gate rejected: ${unpassed.length} criteria have not passed independent verification.`,
          };
        }
      }
    }

    return storage.updateTaskWithRevision(task.id, expectedVersion ?? task.version, { status: targetStatus }, actor);
  }

  /**
   * Concurrency and rate limit check for worker agent.
   */
  public static checkWorkerCapacity(agentId: string, maxConcurrent = 3, maxTokensPerMin = 100000): { allowed: boolean; reason?: string } {
    const currentActive = this.activeRunsMap.get(agentId) || 0;
    if (currentActive >= maxConcurrent) {
      return {
        allowed: false,
        reason: `Agent ${agentId} is at maximum concurrent execution capacity (${currentActive}/${maxConcurrent})`,
      };
    }

    const now = Date.now();
    const tokenRecord = this.tokenUsageMap.get(agentId) || { count: 0, resetAt: now + 60000 };
    if (now > tokenRecord.resetAt) {
      tokenRecord.count = 0;
      tokenRecord.resetAt = now + 60000;
      this.tokenUsageMap.set(agentId, tokenRecord);
    }

    if (tokenRecord.count >= maxTokensPerMin) {
      return {
        allowed: false,
        reason: `Agent ${agentId} exceeded rate limit of ${maxTokensPerMin} tokens/min`,
      };
    }

    return { allowed: true };
  }

  /**
   * Truthful Integration Status: inspects real credentials in secrets table.
   */
  public static getIntegrationsStatus(): {
    jira: { configured: boolean; status: 'connected' | 'not_configured'; host?: string };
    slack: { configured: boolean; status: 'connected' | 'not_configured'; channel?: string };
  } {
    const jiraSecret = getSecret('jira');
    const slackSecret = getSecret('slack');

    const jiraConfigured = Boolean(jiraSecret && jiraSecret.apiToken && jiraSecret.host);
    const slackConfigured = Boolean(slackSecret && slackSecret.botToken && slackSecret.channel);

    return {
      jira: {
        configured: jiraConfigured,
        status: jiraConfigured ? 'connected' : 'not_configured',
        host: jiraConfigured ? jiraSecret?.host : undefined,
      },
      slack: {
        configured: slackConfigured,
        status: slackConfigured ? 'connected' : 'not_configured',
        channel: slackConfigured ? slackSecret?.channel : undefined,
      },
    };
  }
}

export function detectCyclesInDag(tasks: any[]): { hasCycle: boolean; cycleNodes: string[] } {
  const res = OrchestratorService.computeExecutionOrder(tasks);
  return {
    hasCycle: res.hasCycle,
    cycleNodes: res.cycleNodes || [],
  };
}

export function topologicalSortTasks(tasks: any[]): { success: boolean; sortedTasks?: any[]; error?: string } {
  const res = OrchestratorService.computeExecutionOrder(tasks);
  if (res.hasCycle) {
    return {
      success: false,
      error: `Cycle detected in dependency DAG involving nodes: ${(res.cycleNodes || []).join(', ')}`,
    };
  }
  const taskMap = new Map<string, any>();
  for (const t of tasks) taskMap.set(t.id, t);
  const sortedTasks = res.order.map((id) => taskMap.get(id)).filter(Boolean);
  return {
    success: true,
    sortedTasks,
  };
}
