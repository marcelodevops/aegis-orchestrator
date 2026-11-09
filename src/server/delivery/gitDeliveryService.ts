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
import { computeCanonicalCandidateDigest } from '../verification/acceptanceEngine.js';
import { getAegisDataDir } from '../coordinator.js';

export interface GitDeliveryOptions {
  repoPath: string;
  branchName: string;
  commitMessage: string;
  baseCommit?: string;
  candidateHash?: string;
  filesToCommit?: Array<{ relPath: string; content: string }>;
}

export interface GitDeliveryResult {
  success: boolean;
  branchName: string;
  commitHash?: string;
  patch?: string;
  error?: string;
}

export interface RemoteDeliveryOptions {
  repoUrl: string;
  branchName: string;
  commitMessage?: string;
  targetDirectory?: string;
  defaultBranch?: string;
  apiToken?: string;
  deliveryMode?: string;
}

export interface RemoteDeliveryResult {
  success: boolean;
  blocked?: boolean;
  branchPublished?: boolean;
  prCreated?: boolean;
  branchName?: string;
  commitHash?: string;
  prUrl?: string;
  prNumber?: number;
  patch?: string;
  error?: string;
}

/**
 * Preserves raw binary bytes, Git modes (0100644, 0100755), symlinks,
 * and deletions relative to baseline without relocating paths.
 */
export async function materializeCandidateToWorktree(
  sourceDir: string,
  worktreeDir: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // 1. Delete files in worktree that do not exist in candidate (deletion relative to baseline)
    const trackedRes = await runIsolatedProcess({
      command: 'git',
      args: ['ls-files'],
      cwd: worktreeDir,
    });
    if (trackedRes.exitCode === 0) {
      const trackedFiles = trackedRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const rel of trackedFiles) {
        const sourcePath = path.join(sourceDir, rel);
        if (!fs.existsSync(sourcePath) && !fs.lstatSync(sourcePath, { throwIfNoEntry: false })) {
          const wtPath = path.join(worktreeDir, rel);
          if (fs.existsSync(wtPath) || fs.lstatSync(wtPath, { throwIfNoEntry: false })) {
            fs.rmSync(wtPath, { force: true, recursive: true });
          }
        }
      }
    }

    // 2. Walk source candidate and copy every entry with exact types and permissions
    const walk = (currentDir: string) => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
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

        const fullSrc = path.join(currentDir, entry.name);
        const rel = path.relative(sourceDir, fullSrc);
        const fullDest = path.join(worktreeDir, rel);

        const check = assertPathContained(rel, worktreeDir);
        if (!check.valid) {
          throw new Error(`File path escapes worktree boundary: ${check.error}`);
        }

        if (entry.isSocket() || entry.isFIFO() || entry.isCharacterDevice() || entry.isBlockDevice()) {
          throw new Error(`Unsupported file type in candidate at: ${rel}`);
        }

        if (entry.isDirectory()) {
          if (!fs.existsSync(fullDest)) {
            fs.mkdirSync(fullDest, { recursive: true });
          }
          walk(fullSrc);
        } else if (entry.isSymbolicLink()) {
          const linkTarget = fs.readlinkSync(fullSrc);
          const parent = path.dirname(fullDest);
          if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
          if (fs.existsSync(fullDest) || fs.lstatSync(fullDest, { throwIfNoEntry: false })) {
            fs.rmSync(fullDest, { force: true, recursive: true });
          }
          fs.symlinkSync(linkTarget, fullDest);
        } else if (entry.isFile()) {
          const parent = path.dirname(fullDest);
          if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
          if (fs.existsSync(fullDest) || fs.lstatSync(fullDest, { throwIfNoEntry: false })) {
            fs.rmSync(fullDest, { force: true, recursive: true });
          }
          // Preserve raw binary bytes
          const rawBuffer = fs.readFileSync(fullSrc);
          fs.writeFileSync(fullDest, rawBuffer);
          const srcStat = fs.statSync(fullSrc);
          const isExecutable = (srcStat.mode & 0o111) !== 0;
          fs.chmodSync(fullDest, isExecutable ? 0o755 : 0o644);
        }
      }
    };

    walk(sourceDir);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
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

    // Verify acceptance evidence: Must have passing evidence and active accepted candidate hash
    if (!task.acceptedCandidateHash) {
      return {
        success: false,
        branchName: options.branchName,
        error: `Delivery rejected: Task ${task.key} has not been verified and accepted by the independent quality gate`,
      };
    }

    // Verify caller-provided hash against accepted candidate hash
    if (options.candidateHash && options.candidateHash !== task.acceptedCandidateHash) {
      return {
        success: false,
        branchName: options.branchName,
        error: `Delivery rejected: Candidate hash mismatch (${options.candidateHash} != ${task.acceptedCandidateHash}). Candidate was altered after acceptance.`,
      };
    }

    // Recompute canonical candidate digest from actual contents and metadata
    let verifiedFilesToCommit: Array<{ relPath: string; content: string }> = [];
    const snapshotDir = path.resolve(getAegisDataDir(), 'candidates', task.id, task.acceptedCandidateHash);

    if (options.filesToCommit && options.filesToCommit.length > 0) {
      const tempStaging = path.join(os.tmpdir(), `aegis-stage-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
      try {
        fs.mkdirSync(tempStaging, { recursive: true });
        for (const f of options.filesToCommit) {
          const check = assertPathContained(f.relPath, tempStaging);
          if (!check.valid) {
            return {
              success: false,
              branchName: options.branchName,
              error: `Delivery rejected: Staged file path escapes boundary: ${check.error}`,
            };
          }
          const p = path.dirname(check.resolvedPath);
          if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
          fs.writeFileSync(check.resolvedPath, f.content, 'utf8');
        }

        const recomputedDigest = computeCanonicalCandidateDigest(tempStaging);
        if (recomputedDigest !== task.acceptedCandidateHash) {
          return {
            success: false,
            branchName: options.branchName,
            error: `Delivery rejected: Content digest mismatch (${recomputedDigest} != ${task.acceptedCandidateHash}). Supplied files do not match accepted candidate hash.`,
          };
        }
        verifiedFilesToCommit = options.filesToCommit;
      } finally {
        try {
          if (fs.existsSync(tempStaging)) fs.rmSync(tempStaging, { recursive: true, force: true });
        } catch {}
      }
    } else {
      // Deliver from server-owned candidate snapshot
      if (!fs.existsSync(snapshotDir)) {
        return {
          success: false,
          branchName: options.branchName,
          error: `Delivery rejected: No server-owned candidate snapshot found for ${task.key} at ${snapshotDir}`,
        };
      }

      const walkSnapshot = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            walkSnapshot(full);
          } else if (e.isFile() && e.name !== 'candidate_metadata.json') {
            const rel = path.relative(snapshotDir, full);
            const content = fs.readFileSync(full, 'utf8');
            verifiedFilesToCommit.push({ relPath: rel, content });
          }
        }
      };
      walkSnapshot(snapshotDir);
    }

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

    // Verify evidence bound to accepted candidate hash and current requirements_version
    const evidenceList = storage.getEvidenceForCandidate(task.id, task.acceptedCandidateHash).filter((e: any) => e.outcome === 'passed');
    if (evidenceList.length === 0) {
      return {
        success: false,
        branchName: options.branchName,
        error: `Delivery rejected: Task ${task.key} has no passing acceptance evidence bound to candidate hash ${task.acceptedCandidateHash.slice(0, 10)}.`,
      };
    }

    for (const crit of criteria) {
      const critEv = evidenceList.find((e: any) => e.criterion_id === crit.id);
      if (!critEv) {
        return {
          success: false,
          branchName: options.branchName,
          error: `Delivery rejected: Criterion "${crit.title}" has no passing evidence bound to candidate ${task.acceptedCandidateHash.slice(0, 10)}.`,
        };
      }
      if (critEv.requirements_version !== task.requirementsVersion) {
        return {
          success: false,
          branchName: options.branchName,
          error: `Delivery rejected: Evidence for criterion "${crit.title}" is stale (requirements version mismatch). Re-verification required.`,
        };
      }
      if (task.acceptedBaseCommit && critEv.base_commit && critEv.base_commit !== task.acceptedBaseCommit) {
        return {
          success: false,
          branchName: options.branchName,
          error: `Delivery rejected: Evidence for criterion "${crit.title}" base commit mismatch (${critEv.base_commit} != ${task.acceptedBaseCommit}).`,
        };
      }
      const expectedVerifierVersion = crit.verificationSpec?.expectedVerifierVersion || crit.verificationSpec?.verifierVersion || '1.0.0';
      if (!critEv.verifier_version || critEv.verifier_version !== expectedVerifierVersion) {
        return {
          success: false,
          branchName: options.branchName,
          error: `Delivery rejected: Evidence for criterion "${crit.title}" verifier version mismatch (${critEv.verifier_version || 'absent'} != ${expectedVerifierVersion}). Re-verification required.`,
        };
      }
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
        const isConflict = (wtAdd.stderr || wtAdd.stdout).includes('already exists');
        return {
          success: false,
          branchName: sanitizedBranch,
          error: isConflict
            ? `Branch conflict: A branch named '${sanitizedBranch}' already exists in repository`
            : `Failed to create isolated git worktree: ${wtAdd.stderr || wtAdd.stdout}`,
        };
      }

      // Materialize files into worktree
      if (!options.filesToCommit || options.filesToCommit.length === 0) {
        const matRes = await materializeCandidateToWorktree(snapshotDir, tempWorktree);
        if (!matRes.success) {
          return {
            success: false,
            branchName: sanitizedBranch,
            error: `Materialization failed: ${matRes.error}`,
          };
        }
        const wtDigest = computeCanonicalCandidateDigest(tempWorktree);
        if (wtDigest !== task.acceptedCandidateHash) {
          return {
            success: false,
            branchName: sanitizedBranch,
            error: `Delivery rejected: Materialized worktree digest mismatch (${wtDigest} != ${task.acceptedCandidateHash})`,
          };
        }
      } else {
        for (const item of verifiedFilesToCommit) {
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

  /**
   * Delivers verified code changes to a configured remote Git repository.
   * Fails closed with blocked: true if remote or credentials are not configured.
   */
  public static async deliverToRemote(
    taskId: string,
    options: RemoteDeliveryOptions
  ): Promise<RemoteDeliveryResult> {
    const task = storage.getTaskById(taskId);
    if (!task) {
      return { success: false, blocked: true, branchPublished: false, prCreated: false, error: `Delivery rejected: Task not found (${taskId})` };
    }

    const { repoUrl, branchName, commitMessage, defaultBranch = 'main', apiToken, deliveryMode = 'pull_request' } = options;

    if (!repoUrl || repoUrl.trim() === '') {
      return {
        success: false,
        blocked: true,
        branchPublished: false,
        prCreated: false,
        error: 'remote_git_not_configured: Remote repository URL is required for remote delivery.',
      };
    }

    const isHttpRemote = repoUrl.startsWith('http://') || repoUrl.startsWith('https://');
    if (isHttpRemote && (!apiToken || apiToken.includes('••••') || apiToken.trim() === '')) {
      return {
        success: false,
        blocked: true,
        branchPublished: false,
        prCreated: false,
        error: 'remote_git_not_configured: Remote publication requires a verified API token with repository write permissions.',
      };
    }

    const sanitizedBranch = (branchName || `aegis/${task.key.toLowerCase()}`).replace(/[^a-zA-Z0-9_\-\/]/g, '-');
    if (!sanitizedBranch || sanitizedBranch.startsWith('-')) {
      return { success: false, blocked: true, branchPublished: false, prCreated: false, error: 'Invalid branch name format' };
    }

    if (!task.acceptedCandidateHash) {
      return {
        success: false,
        blocked: true,
        branchPublished: false,
        prCreated: false,
        branchName: sanitizedBranch,
        error: `Delivery blocked: Task ${task.key} has no accepted candidate hash. Delivery requires verified acceptance.`,
      };
    }

    if (!task.acceptedBaseCommit) {
      return {
        success: false,
        blocked: true,
        branchPublished: false,
        prCreated: false,
        branchName: sanitizedBranch,
        error: `Delivery blocked: Task ${task.key} has no accepted base commit recorded. Remote delivery requires a verified base commit to prevent base drift.`,
      };
    }

    // 1. Deliver files strictly from server-owned candidate snapshot (NO workspace fallback)
    const snapshotDir = path.resolve(getAegisDataDir(), 'candidates', task.id, task.acceptedCandidateHash);
    if (!fs.existsSync(snapshotDir)) {
      return {
        success: false,
        blocked: true,
        branchPublished: false,
        prCreated: false,
        branchName: sanitizedBranch,
        error: `Delivery blocked: No server-owned candidate snapshot found for task ${task.id} (candidateHash: ${task.acceptedCandidateHash}). Delivery must source from verified immutable snapshots, not mutable workspaces.`,
      };
    }

    // 2. Recompute snapshot canonical digest to guarantee candidate was not tampered with
    const snapshotDigest = computeCanonicalCandidateDigest(snapshotDir);
    if (snapshotDigest !== task.acceptedCandidateHash) {
      return {
        success: false,
        blocked: true,
        branchPublished: false,
        prCreated: false,
        branchName: sanitizedBranch,
        error: `Delivery blocked: Candidate snapshot tampering detected! Recomputed digest (${snapshotDigest}) does not match accepted digest (${task.acceptedCandidateHash}).`,
      };
    }

    // 3. Strict verification evidence validation: Every criterion must have passing, un-stale evidence
    const criteria = storage.getCriteriaForTask(task.id);
    if (criteria.length === 0) {
      return {
        success: false,
        blocked: true,
        branchPublished: false,
        prCreated: false,
        branchName: sanitizedBranch,
        error: `Delivery blocked: Task ${task.key} has no configured acceptance criteria`,
      };
    }

    const evidenceList = storage.getEvidenceForCandidate(task.id, task.acceptedCandidateHash).filter((e: any) => e.outcome === 'passed');
    for (const crit of criteria) {
      const critEv = evidenceList.find((e: any) => e.criterion_id === crit.id);
      if (!critEv) {
        return {
          success: false,
          blocked: true,
          branchPublished: false,
          prCreated: false,
          branchName: sanitizedBranch,
          error: `Delivery blocked: Missing passing evidence for criterion "${crit.title}" bound to candidate ${task.acceptedCandidateHash.slice(0, 10)}.`,
        };
      }
      if (critEv.requirements_version !== task.requirementsVersion) {
        return {
          success: false,
          blocked: true,
          branchPublished: false,
          prCreated: false,
          branchName: sanitizedBranch,
          error: `Delivery blocked: Evidence for criterion "${crit.title}" is stale (requirements version mismatch: ${critEv.requirements_version} != ${task.requirementsVersion}). Re-verification required.`,
        };
      }
      if (task.acceptedBaseCommit && critEv.base_commit && critEv.base_commit !== task.acceptedBaseCommit) {
        return {
          success: false,
          blocked: true,
          branchPublished: false,
          prCreated: false,
          branchName: sanitizedBranch,
          error: `Delivery blocked: Evidence for criterion "${crit.title}" has base commit mismatch (${critEv.base_commit} != ${task.acceptedBaseCommit}).`,
        };
      }
      const expectedVerifierVersion = crit.verificationSpec?.expectedVerifierVersion || crit.verificationSpec?.verifierVersion || '1.0.0';
      if (!critEv.verifier_version || critEv.verifier_version !== expectedVerifierVersion) {
        return {
          success: false,
          blocked: true,
          branchPublished: false,
          prCreated: false,
          branchName: sanitizedBranch,
          error: `Delivery blocked: Evidence for criterion "${crit.title}" verifier version mismatch (${critEv.verifier_version || 'absent'} != ${expectedVerifierVersion}). Re-verification required.`,
        };
      }
    }

    const tempRemoteWork = path.join(os.tmpdir(), `aegis-remote-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);

    try {
      fs.mkdirSync(tempRemoteWork, { recursive: true });

      // Determine clone/push URL with auth
      let authenticatedUrl = repoUrl;
      if (isHttpRemote && apiToken) {
        authenticatedUrl = repoUrl.replace('https://', `https://${apiToken}@`);
      }

      // 4. Validate remote base drift before publication (fail closed)
      const lsRemoteBase = await runIsolatedProcess({
        command: 'git',
        args: ['ls-remote', '--heads', authenticatedUrl],
        cwd: tempRemoteWork,
      });

      if (lsRemoteBase.exitCode !== 0) {
        return {
          success: false,
          blocked: true,
          branchPublished: false,
          prCreated: false,
          branchName: sanitizedBranch,
          error: `Delivery blocked: Failed to query remote base repository references: ${lsRemoteBase.stderr || lsRemoteBase.stdout || 'git ls-remote failed'}.`,
        };
      }

      if (!lsRemoteBase.stdout || lsRemoteBase.stdout.trim().length === 0) {
        return {
          success: false,
          blocked: true,
          branchPublished: false,
          prCreated: false,
          branchName: sanitizedBranch,
          error: `Delivery blocked: Remote repository has no heads or default branch.`,
        };
      }

      const match = lsRemoteBase.stdout.match(new RegExp(`^([a-f0-9]{40})\\s+refs/heads/${defaultBranch}`, 'm'));
      const remoteBaseCommit = match ? match[1] : null;
      if (!remoteBaseCommit) {
        return {
          success: false,
          blocked: true,
          branchPublished: false,
          prCreated: false,
          branchName: sanitizedBranch,
          error: `Delivery blocked: Remote base branch 'refs/heads/${defaultBranch}' does not exist on remote repository.`,
        };
      }

      if (remoteBaseCommit !== task.acceptedBaseCommit) {
        return {
          success: false,
          blocked: true,
          branchPublished: false,
          prCreated: false,
          branchName: sanitizedBranch,
          error: `Delivery blocked: Remote base drift detected. Remote ${defaultBranch} HEAD (${remoteBaseCommit.slice(0, 8)}) does not match accepted base commit (${task.acceptedBaseCommit.slice(0, 8)}). Re-verification against latest remote base is required.`,
        };
      }

      // 5. Remote branch publication & retryability check
      const lsRemoteBranch = await runIsolatedProcess({
        command: 'git',
        args: ['ls-remote', '--heads', authenticatedUrl, sanitizedBranch],
        cwd: tempRemoteWork,
      });

      let alreadyPublished = false;
      let commitHash: string | undefined;

      if (lsRemoteBranch.exitCode === 0 && lsRemoteBranch.stdout.includes(`refs/heads/${sanitizedBranch}`)) {
        const match = lsRemoteBranch.stdout.match(new RegExp(`^([a-f0-9]{40})\\s+refs/heads/${sanitizedBranch}`, 'm'));
        const existingBranchCommit = match ? match[1] : null;

        // Check if existing remote branch already contains the verified candidate
        const checkBranchRes = await runIsolatedProcess({
          command: 'git',
          args: ['clone', '--depth', '1', '-b', sanitizedBranch, authenticatedUrl, tempRemoteWork],
          cwd: path.dirname(tempRemoteWork),
        });

        if (checkBranchRes.exitCode === 0) {
          const branchDigest = computeCanonicalCandidateDigest(tempRemoteWork);
          if (branchDigest === task.acceptedCandidateHash) {
            alreadyPublished = true;
            commitHash = existingBranchCommit || undefined;
          }
        }

        if (!alreadyPublished) {
          return {
            success: false,
            blocked: true,
            branchPublished: false,
            prCreated: false,
            branchName: sanitizedBranch,
            error: `Remote branch conflict: Branch '${sanitizedBranch}' already exists on remote repository with conflicting contents`,
          };
        }
      }

      if (!alreadyPublished) {
        // Clone default base branch (fail closed without fallback clone)
        const cloneRes = await runIsolatedProcess({
          command: 'git',
          args: ['clone', '--depth', '1', '-b', defaultBranch, authenticatedUrl, tempRemoteWork],
          cwd: path.dirname(tempRemoteWork),
        });

        if (cloneRes.exitCode !== 0) {
          return {
            success: false,
            blocked: true,
            branchPublished: false,
            prCreated: false,
            branchName: sanitizedBranch,
            error: `Delivery blocked: Failed to clone remote branch '${defaultBranch}': ${cloneRes.stderr || cloneRes.stdout}`,
          };
        }

        // Create new delivery branch
        const checkoutRes = await runIsolatedProcess({
          command: 'git',
          args: ['checkout', '-b', sanitizedBranch],
          cwd: tempRemoteWork,
        });
        if (checkoutRes.exitCode !== 0) {
          return { success: false, blocked: true, branchPublished: false, prCreated: false, error: `Git checkout failed: ${checkoutRes.stderr}` };
        }

        // Materialize candidate files preserving binary bytes, modes, symlinks, and deletions
        const matRes = await materializeCandidateToWorktree(snapshotDir, tempRemoteWork);
        if (!matRes.success) {
          return {
            success: false,
            blocked: true,
            branchPublished: false,
            prCreated: false,
            error: `Candidate materialization failed: ${matRes.error}`,
          };
        }

        // Verify pre-commit tree matches accepted candidate
        const preCommitDigest = computeCanonicalCandidateDigest(tempRemoteWork);
        if (preCommitDigest !== task.acceptedCandidateHash) {
          return {
            success: false,
            blocked: true,
            branchPublished: false,
            prCreated: false,
            error: `Materialization tree digest mismatch (${preCommitDigest} != ${task.acceptedCandidateHash})`,
          };
        }

        // Configure git identity and add, commit, push
        await runIsolatedProcess({ command: 'git', args: ['config', 'user.name', 'Aegis Autonomous Worker'], cwd: tempRemoteWork });
        await runIsolatedProcess({ command: 'git', args: ['config', 'user.email', 'worker@aegis.local'], cwd: tempRemoteWork });
        await runIsolatedProcess({ command: 'git', args: ['add', '-A'], cwd: tempRemoteWork });

        const commitRes = await runIsolatedProcess({
          command: 'git',
          args: [
            'commit',
            '-m',
            commitMessage || `Aegis Orchestrator: Verified delivery for ${task.key}`,
            '--author',
            'Aegis Autonomous Worker <worker@aegis.local>',
          ],
          cwd: tempRemoteWork,
          env: {
            GIT_COMMITTER_NAME: 'Aegis Autonomous Worker',
            GIT_COMMITTER_EMAIL: 'worker@aegis.local',
            GIT_AUTHOR_NAME: 'Aegis Autonomous Worker',
            GIT_AUTHOR_EMAIL: 'worker@aegis.local',
          },
        });

        if (commitRes.exitCode !== 0) {
          return { success: false, blocked: true, branchPublished: false, prCreated: false, error: `Git commit failed: ${commitRes.stderr}` };
        }

        const revRes = await runIsolatedProcess({
          command: 'git',
          args: ['rev-parse', 'HEAD'],
          cwd: tempRemoteWork,
        });
        commitHash = revRes.stdout.trim();

        const pushRes = await runIsolatedProcess({
          command: 'git',
          args: ['push', 'origin', sanitizedBranch],
          cwd: tempRemoteWork,
        });

        if (pushRes.exitCode !== 0) {
          return { success: false, blocked: true, branchPublished: false, prCreated: false, error: `Git push failed: ${pushRes.stderr || pushRes.stdout}` };
        }

        alreadyPublished = true;
      }

      // At this point, branch publication was successful
      const branchPublished = true;
      let prUrl: string | undefined;
      let prNumber: number | undefined;
      let prCreated = false;

      // 6. Pull Request Handling (truthful, retryable, recover on 422)
      if (deliveryMode === 'pull_request') {
        const token = apiToken || process.env.GITHUB_TOKEN || process.env.GITLAB_TOKEN;
        const cleanUrl = repoUrl.trim();
        const match = cleanUrl.match(/(?:github\.com\/|gitlab\.com\/|^)([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(?:\.git)?/);
        const owner = match ? match[1] : null;
        const repo = match ? match[2].replace(/\.git$/, '') : null;
        const isGitHub = cleanUrl.includes('github.com');
        const isGitLab = cleanUrl.includes('gitlab.com');

        if (!token) {
          return {
            success: false,
            blocked: true,
            branchPublished: true,
            prCreated: false,
            branchName: sanitizedBranch,
            commitHash,
            error: `Pull request creation blocked: deliveryMode is 'pull_request', but no API token was provided (apiToken / GITHUB_TOKEN / GITLAB_TOKEN). The verified branch '${sanitizedBranch}' was published to remote, but PR creation requires valid platform credentials.`,
          };
        }

        if (isGitHub && owner && repo) {
          try {
            const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json',
                'User-Agent': 'Aegis-Orchestrator',
              },
              body: JSON.stringify({
                title: commitMessage || `Aegis Orchestrator: Verified delivery for ${task.key}`,
                head: sanitizedBranch,
                base: defaultBranch || 'main',
                body: `Automated Pull Request generated by Aegis Orchestrator for task ${task.key}: "${task.title}".\n\n- Accepted Candidate Digest: \`${task.acceptedCandidateHash}\`\n- Requirements Version: ${task.requirementsVersion || 1}`,
              }),
            });

            if (!prRes.ok) {
              const errBody = await prRes.text();
              // Idempotent recovery if PR already exists
              if (prRes.status === 422 || errBody.toLowerCase().includes('already exists')) {
                try {
                  const searchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${sanitizedBranch}&state=open`, {
                    headers: {
                      'Authorization': `Bearer ${token}`,
                      'Accept': 'application/vnd.github+json',
                      'User-Agent': 'Aegis-Orchestrator',
                    },
                  });
                  if (searchRes.ok) {
                    const searchData = (await searchRes.json()) as any[];
                    if (Array.isArray(searchData) && searchData.length > 0) {
                      prUrl = searchData[0].html_url;
                      prNumber = searchData[0].number;
                      prCreated = true;
                    }
                  }
                } catch {}
              }

              if (!prCreated) {
                return {
                  success: false,
                  blocked: true,
                  branchPublished: true,
                  prCreated: false,
                  branchName: sanitizedBranch,
                  commitHash,
                  error: `GitHub PR creation failed (HTTP ${prRes.status}): ${errBody}`,
                };
              }
            } else {
              const prData = (await prRes.json()) as any;
              prUrl = prData.html_url;
              prNumber = prData.number;
              prCreated = true;
            }
          } catch (fetchErr: any) {
            return {
              success: false,
              blocked: true,
              branchPublished: true,
              prCreated: false,
              branchName: sanitizedBranch,
              commitHash,
              error: `GitHub PR request failed: ${fetchErr.message}`,
            };
          }
        } else if (isGitLab && owner && repo) {
          try {
            const projectPath = encodeURIComponent(`${owner}/${repo}`);
            const mrRes = await fetch(`https://gitlab.com/api/v4/projects/${projectPath}/merge_requests`, {
              method: 'POST',
              headers: {
                'PRIVATE-TOKEN': token,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                source_branch: sanitizedBranch,
                target_branch: defaultBranch || 'main',
                title: commitMessage || `Aegis Orchestrator: Verified delivery for ${task.key}`,
                description: `Automated Merge Request generated by Aegis Orchestrator for task ${task.key}: "${task.title}".\n\n- Accepted Candidate Digest: \`${task.acceptedCandidateHash}\``,
              }),
            });

            if (!mrRes.ok) {
              const errBody = await mrRes.text();
              if (mrRes.status === 409 || errBody.toLowerCase().includes('already exists')) {
                try {
                  const searchRes = await fetch(`https://gitlab.com/api/v4/projects/${projectPath}/merge_requests?source_branch=${sanitizedBranch}&state=opened`, {
                    headers: { 'PRIVATE-TOKEN': token },
                  });
                  if (searchRes.ok) {
                    const mrList = (await searchRes.json()) as any[];
                    if (Array.isArray(mrList) && mrList.length > 0) {
                      prUrl = mrList[0].web_url;
                      prNumber = mrList[0].iid;
                      prCreated = true;
                    }
                  }
                } catch {}
              }

              if (!prCreated) {
                return {
                  success: false,
                  blocked: true,
                  branchPublished: true,
                  prCreated: false,
                  branchName: sanitizedBranch,
                  commitHash,
                  error: `GitLab MR creation failed (HTTP ${mrRes.status}): ${errBody}`,
                };
              }
            } else {
              const mrData = (await mrRes.json()) as any;
              prUrl = mrData.web_url;
              prNumber = mrData.iid;
              prCreated = true;
            }
          } catch (fetchErr: any) {
            return {
              success: false,
              blocked: true,
              branchPublished: true,
              prCreated: false,
              branchName: sanitizedBranch,
              commitHash,
              error: `GitLab MR request failed: ${fetchErr.message}`,
            };
          }
        } else {
          return {
            success: false,
            blocked: true,
            branchPublished: true,
            prCreated: false,
            branchName: sanitizedBranch,
            commitHash,
            error: `Pull request creation is unsupported on remote '${repoUrl}'. Only GitHub and GitLab remotes support automated pull requests. Use deliveryMode 'branch_push' to publish branches without PR creation.`,
          };
        }
      }

      storage.logAudit('delivery', task.id, 'remote_delivered', 'aegis_delivery_service', {
        repoUrl,
        branch: sanitizedBranch,
        commit: commitHash,
        prUrl,
      });

      return {
        success: true,
        branchPublished: true,
        prCreated,
        branchName: sanitizedBranch,
        commitHash,
        prUrl,
        prNumber,
      };
    } finally {
      try {
        if (fs.existsSync(tempRemoteWork)) fs.rmSync(tempRemoteWork, { recursive: true, force: true });
      } catch {}
    }
  }
}
