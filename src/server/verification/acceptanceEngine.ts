/**
 * Aegis Orchestrator - Independent Acceptance Engine & Evidence Ledger
 * 
 * Verifies candidate implementations against explicit criteria using
 * independent, out-of-process checks in an enforced sandbox runtime.
 * Binds immutable evidence records to canonical candidate workspace digests.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { storage } from '../storage/db.js';
import { runInSandbox } from '../execution/sandboxRuntime.js';
import { assertPathContained } from '../execution/pathContainment.js';
import { getAegisDataDir } from '../coordinator.js';

export interface CriterionVerificationSpec {
  command?: string;
  args?: string[];
  expectedFile?: string;
  expectedContentPattern?: string;
  timeoutMs?: number;
  trustedScriptPath?: string;
}

export interface CriterionCheckResult {
  criterionId: string;
  title: string;
  passed: boolean;
  evidenceId: string;
  verifierName: string;
  stdout?: string;
  stderr?: string;
  failureReason?: string;
}

export interface AcceptanceEvaluationResult {
  allPassed: boolean;
  candidateHash: string;
  results: CriterionCheckResult[];
}

/**
 * Computes deterministic SHA-256 canonical digest of candidate workspace.
 * Sorts relative paths, includes file mode, size, and content.
 */
export function computeWorkspaceTreeHash(workspacePath: string): string {
  const hash = crypto.createHash('sha256');

  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === '.sandbox_scratch' ||
        entry.name === 'candidate_metadata.json' ||
        entry.name === '.aegis_metadata.json'
      ) {
        continue;
      }

      const full = path.join(dir, entry.name);
      const rel = path.relative(workspacePath, full);

      if (entry.isSocket() || entry.isFIFO() || entry.isCharacterDevice() || entry.isBlockDevice()) {
        throw new Error(`Unsupported file type in candidate workspace at: ${rel}`);
      }

      if (entry.isSymbolicLink()) {
        try {
          const linkTarget = fs.readlinkSync(full);
          hash.update(rel);
          hash.update('\0symlink\0');
          hash.update('0120000');
          hash.update('\0');
          hash.update(linkTarget);
          hash.update('\0');
        } catch (e: any) {
          throw new Error(`Failed to read symlink ${rel}: ${e.message}`);
        }
      } else if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          const stats = fs.statSync(full);
          const isExecutable = (stats.mode & 0o111) !== 0;
          const gitMode = isExecutable ? '0100755' : '0100644';
          const content = fs.readFileSync(full); // Raw binary buffer

          hash.update(rel);
          hash.update('\0file\0');
          hash.update(gitMode);
          hash.update('\0');
          hash.update(String(stats.size));
          hash.update('\0');
          hash.update(content);
        } catch (e: any) {
          throw new Error(`Failed to read file ${rel}: ${e.message}`);
        }
      }
    }
  };

  walk(workspacePath);
  return hash.digest('hex');
}

export const computeCanonicalCandidateDigest = computeWorkspaceTreeHash;

/**
 * Runs independent verification for all criteria of a task against the workspace.
 */
export async function verifyTaskAcceptance(params: {
  taskId: string;
  task?: any;
  runId?: string;
  baseCommit?: string;
  workspacePath: string;
}): Promise<AcceptanceEvaluationResult> {
  const { taskId, task: providedTask, runId, baseCommit, workspacePath } = params;
  let task = storage.getTaskById(taskId);
  if (!task && providedTask) {
    storage.insertTask(providedTask);
    task = storage.getTaskById(taskId);
  }
  if (!task) {
    throw new Error(`Cannot verify acceptance: task not found ${taskId}`);
  }

  const criteria = storage.getCriteriaForTask(task.id);
  const candidateHash = computeWorkspaceTreeHash(workspacePath);
  const results: CriterionCheckResult[] = [];
  let allPassed = true;

  if (criteria.length === 0) {
    // If no explicit criteria defined, fail closed: task cannot be accepted without defined criteria
    const evId = storage.recordEvidence({
      runId,
      taskId: task.id,
      candidateHash,
      verifierName: 'aegis_quality_gate',
      outcome: 'failed',
      failureReason: 'No acceptance criteria configured for task. Autonomous acceptance requires explicit criteria.',
    });
    return {
      allPassed: false,
      candidateHash,
      results: [
        {
          criterionId: 'none',
          title: 'Configured Acceptance Criteria',
          passed: false,
          evidenceId: evId,
          verifierName: 'aegis_quality_gate',
          failureReason: 'No acceptance criteria configured for task.',
        },
      ],
    };
  }

  for (const crit of criteria) {
    const spec: CriterionVerificationSpec = crit.verificationSpec || {};
    let passed = false;
    let stdout = '';
    let stderr = '';
    let failureReason: string | undefined;
    let verifierName = crit.verificationMethod || 'trusted_test';

    if (crit.verificationMethod === 'file_presence') {
      verifierName = 'file_presence_verifier';
      const targetRel = spec.expectedFile || crit.title;
      const check = assertPathContained(targetRel, workspacePath);
      if (!check.valid) {
        passed = false;
        failureReason = `Security path violation: ${check.error}`;
      } else if (!fs.existsSync(check.resolvedPath)) {
        passed = false;
        failureReason = `Expected file does not exist: ${targetRel}`;
      } else {
        const stats = fs.statSync(check.resolvedPath);
        if (stats.size === 0) {
          passed = false;
          failureReason = `Expected file is empty: ${targetRel}`;
        } else if (spec.expectedContentPattern) {
          const content = fs.readFileSync(check.resolvedPath, 'utf8');
          const reg = new RegExp(spec.expectedContentPattern);
          if (!reg.test(content)) {
            passed = false;
            failureReason = `File content did not match pattern /${spec.expectedContentPattern}/`;
          } else {
            passed = true;
          }
        } else {
          passed = true;
        }
      }
    } else {
      // Default: trusted test command executed in sandbox runtime
      verifierName = 'sandboxed_acceptance_verifier';
      const command = spec.command || 'node';
      let args = spec.args;
      const trustedReadPaths: string[] = [];

      // Check for server-owned trusted suite outside workspace
      const trustedSuitesRoot = path.resolve(getAegisDataDir(), 'trusted_suites');
      const serverTrustedById = path.resolve(trustedSuitesRoot, task.id, `${crit.id}.test.cjs`);
      const serverTrustedByKey = path.resolve(trustedSuitesRoot, task.key, `${crit.id}.test.cjs`);
      const serverIdSuite = path.resolve(trustedSuitesRoot, task.id, 'spec.test.cjs');
      const serverKeySuite = path.resolve(trustedSuitesRoot, task.key, 'spec.test.cjs');

      if (spec.trustedScriptPath && fs.existsSync(spec.trustedScriptPath)) {
        args = [spec.trustedScriptPath, crit.id];
        trustedReadPaths.push(spec.trustedScriptPath);
      } else if (fs.existsSync(serverTrustedById)) {
        args = [serverTrustedById, crit.id];
        trustedReadPaths.push(serverTrustedById);
      } else if (fs.existsSync(serverTrustedByKey)) {
        args = [serverTrustedByKey, crit.id];
        trustedReadPaths.push(serverTrustedByKey);
      } else if (fs.existsSync(serverIdSuite)) {
        args = [serverIdSuite, crit.id];
        trustedReadPaths.push(serverIdSuite);
      } else if (fs.existsSync(serverKeySuite)) {
        args = [serverKeySuite, crit.id];
        trustedReadPaths.push(serverKeySuite);
      } else if (!args || args.length === 0) {
        // FAIL CLOSED: Never trust worker-writable workspace tests! Acceptance requires an authoritative, server-owned verifier.
        passed = false;
        failureReason = `Acceptance blocked: No server-owned trusted suite found in data/trusted_suites/ for task ${task.key} (${task.id}). Verification cannot fall back to worker-writable workspace files or shell substitutions.`;
      }

      if (args && args.length > 0) {
        const procRes = await runInSandbox({
          command,
          args,
          workspacePath,
          allowFsRead: trustedReadPaths,
          timeoutMs: spec.timeoutMs || 20000,
          allowNetwork: false,
        });

        stdout = procRes.stdout;
        stderr = procRes.stderr;
        passed = procRes.exitCode === 0 && !procRes.timedOut;

        if (!passed) {
          failureReason = procRes.timedOut
            ? `Verifier timed out after ${spec.timeoutMs || 20000}ms`
            : (procRes.error || `Process exited with code ${procRes.exitCode}. Error output: ${stderr.slice(0, 300)}`);
        }
      }
    }

    if (!passed) {
      allPassed = false;
      storage.updateCriterionStatus(crit.id, 'failed');
    } else {
      storage.updateCriterionStatus(crit.id, 'passed');
    }

    const evId = storage.recordEvidence({
      runId,
      taskId: task.id,
      criterionId: crit.id,
      baseCommit,
      candidateHash,
      verifierName,
      requirementsVersion: task.requirementsVersion || 1,
      command: spec.command ? `${spec.command} ${(spec.args || []).join(' ')}` : undefined,
      exitCode: passed ? 0 : 1,
      stdout,
      stderr,
      outcome: passed ? 'passed' : 'failed',
      failureReason,
    });

    results.push({
      criterionId: crit.id,
      title: crit.title,
      passed,
      evidenceId: evId,
      verifierName,
      stdout,
      stderr,
      failureReason,
    });
  }

  // Store immutable accepted candidate snapshot upon acceptance
  if (allPassed) {
    try {
      const candidatesRoot = path.resolve(getAegisDataDir(), 'candidates');
      const taskCandidatesDir = path.resolve(candidatesRoot, task.id);
      const candidateSnapshotDir = path.join(taskCandidatesDir, candidateHash);
      if (!fs.existsSync(candidateSnapshotDir)) {
        fs.mkdirSync(candidateSnapshotDir, { recursive: true });
        fs.cpSync(workspacePath, candidateSnapshotDir, {
          recursive: true,
          filter: (src) => {
            const base = path.basename(src);
            return (
              base !== '.git' &&
              base !== 'node_modules' &&
              base !== 'dist' &&
              base !== '.sandbox_scratch' &&
              base !== '.aegis_metadata.json' &&
              base !== 'candidate_metadata.json'
            );
          },
        });
      }

      // Recompute digest of snapshot to guarantee fidelity and immutability
      const snapshotDigest = computeWorkspaceTreeHash(candidateSnapshotDir);
      if (snapshotDigest !== candidateHash) {
        throw new Error(`Snapshot verification failed: digest mismatch (${snapshotDigest} != ${candidateHash})`);
      }

      // Store metadata outside candidate snapshot tree so the tree remains pure
      const metaPath = path.join(taskCandidatesDir, `${candidateHash}.meta.json`);
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          taskId: task.id,
          taskKey: task.key,
          candidateHash,
          acceptedAt: new Date().toISOString(),
          baseCommit: baseCommit || null,
          requirementsVersion: task.requirementsVersion || 1,
        }, null, 2),
        'utf8'
      );
    } catch (snapshotErr: any) {
      console.warn('Failed to snapshot accepted candidate:', snapshotErr);
      allPassed = false;
      storage.recordEvidence({
        runId,
        taskId: task.id,
        criterionId: criteria[0]?.id || 'crit-snapshot',
        baseCommit,
        candidateHash,
        verifierName: 'immutable_snapshot_verifier',
        requirementsVersion: task.requirementsVersion || 1,
        exitCode: 1,
        outcome: 'failed',
        failureReason: `Snapshot creation/verification failed: ${snapshotErr.message}`,
      });
    }
  }

  // Update task acceptedCandidateHash upon verification verdict
  const currentTask = storage.getTaskById(task.id);
  if (currentTask) {
    storage.updateTaskWithRevision(currentTask.id, currentTask.version, {
      acceptedCandidateHash: allPassed ? candidateHash : null,
      acceptedBaseCommit: allPassed ? (baseCommit || null) : null,
    });
  }

  return {
    allPassed,
    candidateHash,
    results,
  };
}
