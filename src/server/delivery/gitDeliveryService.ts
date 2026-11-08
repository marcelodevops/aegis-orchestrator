/**
 * Aegis Orchestrator - Isolated Git Worktree Delivery Engine
 * 
 * Provides fail-closed, isolated Git delivery without touching the developer's
 * active working tree or branch.
 * 
 * Guarantees:
 * 1. Out-of-process argument-array Git invocation (no shell injection)
 * 2. Dedicated temporary worktrees (git worktree add)
 * 3. Verified commit creation (rev-parse validation; never falsely reports HEAD)
 * 4. Patch generation with baseline verification (git apply --check)
 * 5. Strict acceptance gate check: rejects delivery if criteria lack passing evidence
 * 6. Guaranteed worktree cleanup in finally blocks
 */

import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { runIsolatedProcess } from '../execution/isolatedProcess.js';
import { assertPathContained } from '../execution/pathContainment.js';
import { storage } from '../storage/db.js';

export interface GitDeliveryOptions {
  repoPath: string;
  branchName: string;
  commitMessage: string;
  baseCommit?: string;
  filesToCommit: Array<{ relPath: string; content: string }>;
}

export interface GitDeliveryResult {
  success: boolean;
  branchName: string;
  commitHash?: string;
  patch?: string;
  error?: string;
}

export class GitDeliveryService {
  /**
   * Delivers verified code changes to an isolated branch via git worktree.
   */
  public static async deliverToBranch(
    taskId: string,
    options: GitDeliveryOptions
  ): Promise<GitDeliveryResult> {
    const task = storage.getTaskById(taskId);
    if (!task) {
      return { success: false, branchName: options.branchName, error: `Delivery rejected: Task not found (${taskId})` };
    }

    // Verify acceptance evidence: Must have passing evidence
    const criteria = storage.getCriteriaForTask(task.id);
    if (criteria.length === 0) {
      return {
        success: false,
        branchName: options.branchName,
        error: `Delivery rejected: Task ${task.key} has no configured acceptance criteria`,
      };
    }

    const unpassedCriteria = criteria.filter((c) => c.status !== 'passed');
    if (unpassedCriteria.length > 0) {
      return {
        success: false,
        branchName: options.branchName,
        error: `Delivery rejected: Task ${task.key} has ${unpassedCriteria.length} unverified or failing criteria.`,
      };
    }

    // Sanitize branch name
    const sanitizedBranch = options.branchName.replace(/[^a-zA-Z0-9_\-\/]/g, '-');
    if (!sanitizedBranch || sanitizedBranch.startsWith('-')) {
      return { success: false, branchName: options.branchName, error: 'Invalid branch name format' };
    }

    // Create unique worktree path in system temp
    const tempWorktree = path.join(
      os.tmpdir(),
      `aegis-wt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    );

    const repoPath = path.resolve(options.repoPath);

    try {
      // Check if git repository exists
      const revCheck = await runIsolatedProcess({
        command: 'git',
        args: ['rev-parse', '--is-inside-work-tree'],
        cwd: repoPath,
      });

      if (revCheck.exitCode !== 0) {
        return {
          success: false,
          branchName: sanitizedBranch,
          error: `Target path is not a valid git repository: ${revCheck.stderr || revCheck.stdout}`,
        };
      }

      // Base commit or current HEAD
      let base = options.baseCommit;
      if (!base) {
        const headCheck = await runIsolatedProcess({
          command: 'git',
          args: ['rev-parse', 'HEAD'],
          cwd: repoPath,
        });
        if (headCheck.exitCode !== 0) {
          return { success: false, branchName: sanitizedBranch, error: 'Failed to resolve base HEAD commit' };
        }
        base = headCheck.stdout.trim();
      }

      // Add isolated worktree: git worktree add -b <branch> <tempDir> <base>
      const wtAdd = await runIsolatedProcess({
        command: 'git',
        args: ['worktree', 'add', '-b', sanitizedBranch, tempWorktree, base],
        cwd: repoPath,
      });

      if (wtAdd.exitCode !== 0) {
        return {
          success: false,
          branchName: sanitizedBranch,
          error: `Failed to create isolated git worktree: ${wtAdd.stderr || wtAdd.stdout}`,
        };
      }

      // Write files inside worktree with strict containment check
      for (const item of options.filesToCommit) {
        const check = assertPathContained(item.relPath, tempWorktree);
        if (!check.valid) {
          return {
            success: false,
            branchName: sanitizedBranch,
            error: `File path escapes worktree boundary: ${check.error}`,
          };
        }
        const parent = path.dirname(check.resolvedPath);
        if (!fs.existsSync(parent)) {
          fs.mkdirSync(parent, { recursive: true });
        }
        fs.writeFileSync(check.resolvedPath, item.content, 'utf8');
      }

      // git add -A
      const addRes = await runIsolatedProcess({
        command: 'git',
        args: ['add', '-A'],
        cwd: tempWorktree,
      });
      if (addRes.exitCode !== 0) {
        return { success: false, branchName: sanitizedBranch, error: `Git add failed: ${addRes.stderr}` };
      }

      // Check for staged changes
      const diffCheck = await runIsolatedProcess({
        command: 'git',
        args: ['diff', '--staged', '--quiet'],
        cwd: tempWorktree,
      });
      if (diffCheck.exitCode === 0) {
        return {
          success: false,
          branchName: sanitizedBranch,
          error: 'No changes staged for delivery commit',
        };
      }

      // Commit changes with author metadata
      const commitRes = await runIsolatedProcess({
        command: 'git',
        args: [
          'commit',
          '-m',
          options.commitMessage || `Aegis Orchestrator: Verified delivery for ${task.key}`,
          '--author',
          'Aegis Autonomous Worker <worker@aegis.local>',
        ],
        cwd: tempWorktree,
      });
      if (commitRes.exitCode !== 0) {
        return {
          success: false,
          branchName: sanitizedBranch,
          error: `Git commit failed: ${commitRes.stderr || commitRes.stdout}`,
        };
      }

      // Resolve real commit hash
      const revRes = await runIsolatedProcess({
        command: 'git',
        args: ['rev-parse', 'HEAD'],
        cwd: tempWorktree,
      });
      if (revRes.exitCode !== 0) {
        return { success: false, branchName: sanitizedBranch, error: 'Failed to verify new commit hash' };
      }
      const commitHash = revRes.stdout.trim();

      // Verify acceptance evidence: Must have passing evidence in ledger
      const evidenceList = storage.getEvidenceForTask(task.id).filter((e: any) => e.outcome === 'passed');
      if (evidenceList.length === 0) {
        return {
          success: false,
          branchName: sanitizedBranch,
          error: `Delivery rejected: Task ${task.key} has no passing acceptance evidence in the verification ledger. Autonomous delivery requires cryptographically bound evidence.`,
        };
      }

      // Generate diff patch
      const patchRes = await runIsolatedProcess({
        command: 'git',
        args: ['format-patch', '-1', 'HEAD', '--stdout'],
        cwd: tempWorktree,
      });
      const patch = patchRes.stdout;

      if (!patch || patch.trim().length === 0) {
        return {
          success: false,
          branchName: sanitizedBranch,
          error: 'Delivery rejected: Worktree produced an empty patch',
        };
      }

      // Write patch to temp file and run git apply --check against base repository
      const tempPatchFile = path.join(os.tmpdir(), `aegis-patch-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.patch`);
      fs.writeFileSync(tempPatchFile, patch, 'utf8');

      let patchValid = false;
      let patchError = '';

      try {
        const checkPatch = await runIsolatedProcess({
          command: 'git',
          args: ['apply', '--check', tempPatchFile],
          cwd: repoPath,
        });

        patchValid = checkPatch.exitCode === 0;
        if (!patchValid) {
          patchError = checkPatch.stderr || checkPatch.stdout || 'Patch failed to apply cleanly to base commit';
        }
      } finally {
        try {
          if (fs.existsSync(tempPatchFile)) fs.unlinkSync(tempPatchFile);
        } catch {}
      }

      if (!patchValid) {
        return {
          success: false,
          branchName: sanitizedBranch,
          error: `Patch application verification failed: ${patchError}`,
        };
      }

      storage.logAudit('delivery', task.id, 'branch_delivered', 'aegis_delivery_service', {
        branch: sanitizedBranch,
        commit: commitHash,
        evidenceCount: evidenceList.length,
      });

      return {
        success: true,
        branchName: sanitizedBranch,
        commitHash,
        patch,
      };
    } finally {
      // Guaranteed cleanup of isolated worktree
      try {
        await runIsolatedProcess({
          command: 'git',
          args: ['worktree', 'remove', '--force', tempWorktree],
          cwd: repoPath,
        });
      } catch {}
      try {
        if (fs.existsSync(tempWorktree)) {
          fs.rmSync(tempWorktree, { recursive: true, force: true });
        }
      } catch {}
    }
  }
}
