/**
 * Aegis Orchestrator - Bounded Correction Loop
 * 
 * Orchestrates worker implementation, independent verification, and bounded
 * correction rounds when tests fail. Feeds back actual verifier stdout/stderr
 * and enforces maximum retry budgets.
 */

import { storage } from '../storage/db.js';
import { WorkerAdapter, WorkerTaskContext } from '../worker/realWorkerAdapter.js';
import { verifyTaskAcceptance, AcceptanceEvaluationResult } from '../verification/acceptanceEngine.js';

export interface CorrectionLoopOptions {
  maxAttempts?: number;
  baseCommit?: string;
  workspacePath: string;
}

export interface CorrectionLoopResult {
  accepted: boolean;
  attemptsUsed: number;
  finalRunId: string;
  candidateHash: string;
  verification: AcceptanceEvaluationResult;
  diagnostics?: string;
}

export async function runBoundedCorrectionLoop(
  taskId: string,
  agentId: string,
  worker: WorkerAdapter,
  options: CorrectionLoopOptions
): Promise<CorrectionLoopResult> {
  const maxAttempts = options.maxAttempts || 3;
  const task = storage.getTaskById(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found in database`);
  }

  const criteria = storage.getCriteriaForTask(task.id);
  let attempt = 0;
  let lastVerification: AcceptanceEvaluationResult | null = null;
  let lastRunId = '';
  let diagnosticFeedback = '';

  while (attempt < maxAttempts) {
    attempt++;

    // Create execution run record in database
    const run = storage.createRun({
      taskId: task.id,
      agentId,
      status: 'running',
      baseCommit: options.baseCommit,
      workspacePath: options.workspacePath,
    });
    lastRunId = run.id;

    // Update task status to in_progress
    storage.updateTaskWithRevision(task.id, task.version, {
      status: 'in_progress',
      assignedAgentId: agentId,
      lastAgentComment: attempt === 1
        ? `Worker started initial implementation pass.`
        : `Worker started correction attempt ${attempt}/${maxAttempts} with feedback: ${diagnosticFeedback.slice(0, 100)}...`,
    });

    // Worker execution context
    const workerContext: WorkerTaskContext = {
      id: task.id,
      key: task.key,
      title: task.title,
      description: `${task.description}${
        diagnosticFeedback ? `\n\n--- PREVIOUS VERIFICATION FAILURES (Fix these): ---\n${diagnosticFeedback}` : ''
      }`,
      criteria,
      baseCommit: options.baseCommit,
      workspacePath: options.workspacePath,
      tokenBudget: 30000,
      maxTurns: 10,
    };

    // Execute worker tool loop
    const workerRes = await worker.executeTask(workerContext);

    if (workerRes.status === 'failed') {
      storage.updateRun(run.id, {
        status: 'failed',
        error: workerRes.error || 'Worker execution failed',
        tokensUsed: workerRes.tokensUsed,
      });

      storage.updateTaskWithRevision(task.id, storage.getTaskById(task.id).version, {
        status: 'blocked',
        lastAgentComment: `Worker failed on attempt ${attempt}: ${workerRes.error}`,
      });

      throw new Error(`Worker execution failed on attempt ${attempt}: ${workerRes.error}`);
    }

    // Run independent acceptance verification
    const verification = await verifyTaskAcceptance({
      taskId: task.id,
      runId: run.id,
      baseCommit: options.baseCommit,
      workspacePath: options.workspacePath,
    });

    lastVerification = verification;

    storage.updateRun(run.id, {
      candidateHash: verification.candidateHash,
      tokensUsed: workerRes.tokensUsed,
      status: verification.allPassed ? 'accepted' : 'rejected',
    });

    if (verification.allPassed) {
      // Transition task to review / done with server-enforced revision check
      const currentTask = storage.getTaskById(task.id);
      storage.updateTaskWithRevision(currentTask.id, currentTask.version, {
        status: 'review',
        lastAgentComment: `Independent acceptance gate passed on attempt ${attempt}. Candidate hash: ${verification.candidateHash.slice(0, 8)}`,
      });

      return {
        accepted: true,
        attemptsUsed: attempt,
        finalRunId: run.id,
        candidateHash: verification.candidateHash,
        verification,
      };
    }

    // Candidate rejected: assemble verified diagnostics from verifier stdout/stderr
    const failedCriteria = verification.results.filter((r) => !r.passed);
    diagnosticFeedback = failedCriteria
      .map(
        (f) =>
          `Criterion "${f.title}" failed:\nVerifier: ${f.verifierName}\nReason: ${f.failureReason || 'Non-zero exit'}\nStdout: ${
            f.stdout?.trim() || '(none)'
          }\nStderr: ${f.stderr?.trim() || '(none)'}`
      )
      .join('\n\n');
  }

  // Budget exhausted: lock task into blocked state
  const currentTask = storage.getTaskById(task.id);
  storage.updateTaskWithRevision(currentTask.id, currentTask.version, {
    status: 'blocked',
    lastAgentComment: `Correction budget exhausted (${maxAttempts} attempts). Work is blocked pending resolution.`,
  });

  return {
    accepted: false,
    attemptsUsed: attempt,
    finalRunId: lastRunId,
    candidateHash: lastVerification?.candidateHash || 'unknown',
    verification: lastVerification!,
    diagnostics: diagnosticFeedback,
  };
}
