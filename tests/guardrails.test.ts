/**
 * Aegis Orchestrator - Guardrails & Delivery Fail-Closed Regression Suite
 * 
 * Tests the ACTUAL application delivery and coordinator handlers using
 * isolated temporary disk directories (fs.mkdtempSync).
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { storage } from '../src/server/storage/db.js';
import { coordinator } from '../src/server/coordinator.js';
import { handleRepositoryDispatch, isPathContained } from '../src/server/deliveryHandler.js';
import { calculateAgentLoad } from '../src/services/workloadBalancer.js';
import { computeCanonicalCandidateDigest } from '../src/server/verification/acceptanceEngine.js';

console.log('=== RUNNING AEGIS GUARDRAILS & LIVE DELIVERY REGRESSION SUITE ===\n');

let passedTests = 0;
let totalTests = 0;

async function runTest(name: string, fn: () => void | Promise<void>) {
  totalTests++;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      await result;
    }
    passedTests++;
    console.log(`✔ [PASS] ${name}`);
  } catch (err: any) {
    console.error(`✘ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

async function executeSuite() {
  // Temporary directory fixture for live tests
  const testBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-guardrails-'));

  const aeg104Task = {
    id: 'task-104',
    key: 'AEG-104',
    title: 'Implement AI-Driven Workload Balancing',
    status: 'done' as const,
    subtasks: [
      { id: 'st-10', title: 'Load percentage calculation', completed: true },
      { id: 'st-11', title: 'Gemini optimizer prompt', completed: true },
      { id: 'st-12', title: 'Algorithmic rebalancing', completed: true },
    ],
    dependencies: [],
    deliverables: ['deliverable artifact'],
  };

  // Ensure task exists in coordinator state for delivery verification
  const existingIndex = coordinator.getState().tasks.findIndex((t) => t.key === 'AEG-104');
  if (existingIndex >= 0) {
    coordinator.getState().tasks[existingIndex] = { ...aeg104Task } as any;
  } else {
    coordinator.getState().tasks.push({ ...aeg104Task } as any);
  }

  // --- 1. EVIDENCE MAPPING TESTS ---
  await runTest('Worker execution maps criteria strictly to passing test assertions (rejects unverified subtasks)', async () => {
    const testTask = {
      id: 'task-104',
      key: 'AEG-104',
      title: 'Implement AI-Driven Workload Balancing',
      status: 'in_progress',
      subtasks: [
        { id: 'st-10', title: 'Load calculation', completed: false },
        { id: 'st-11', title: 'Optimizer prompt', completed: false },
        { id: 'st-12', title: 'Rebalancing algorithm', completed: false },
        { id: 'st-fake', title: 'Unverified fictitious criterion', completed: false },
      ],
    };
    const agent = { id: 'agent-arch', name: 'Nexus-7', role: 'Architect' };
    const res = await coordinator.executeWorkerStep(testTask as any, agent as any);

    assert.ok(res.subtasksCompleted.includes('st-10'), 'st-10 must be verified');
    assert.ok(res.subtasksCompleted.includes('st-11'), 'st-11 must be verified');
    assert.ok(res.subtasksCompleted.includes('st-12'), 'st-12 must be verified');
    assert.strictEqual(
      res.subtasksCompleted.includes('st-fake'),
      false,
      'st-fake must NOT be completed without verified evidence'
    );
  });

  await runTest('Unimplemented tasks fail-closed with blocked: true', async () => {
    const unimplTask = {
      id: 'task-999',
      key: 'AEG-999',
      title: 'Unimplemented task',
      status: 'todo',
      subtasks: [],
    };
    const agent = { id: 'agent-be', name: 'Kaelen Dev', role: 'Backend' };

    let blocked = false;
    try {
      await coordinator.executeWorkerStep(unimplTask as any, agent as any);
    } catch (err: any) {
      blocked = err.message.includes('Execution blocked: No capable worker connected');
    }
    assert.strictEqual(blocked, true, 'Unimplemented task must fail closed');
  });

  // --- 2. QUALITY GATE PREREQUISITE TESTS ---
  await runTest('Quality gate rejects Done transition if upstream dependencies are not done', () => {
    const blockedTask = {
      id: 'task-dep-check',
      key: 'AEG-DEP-CHECK',
      title: 'Blocked task',
      status: 'review' as const,
      dependencies: ['task-unmet-upstream'],
      subtasks: [{ id: 's1', title: 'Subtask', completed: true }],
      deliverables: ['artifact'],
    };

    coordinator.getState().tasks.push({
      id: 'task-unmet-upstream',
      key: 'AEG-UPSTREAM',
      title: 'Upstream task',
      status: 'in_progress',
      dependencies: [],
      subtasks: [],
    } as any);

    const verification = coordinator.verifyTaskQualityGates(blockedTask as any);
    assert.strictEqual(verification.passed, false, 'Must fail when dependency is in_progress');

    // Clean up transient test task
    coordinator.getState().tasks = coordinator.getState().tasks.filter((t) => t.id !== 'task-unmet-upstream');
  });

  await runTest('Server-owned lifecycle blocks unverified transitions at every entry stage', () => {
    // 1. Block transition to in_progress if dependencies are incomplete
    const taskBlockedByDeps = {
      id: 'task-stage-block-1',
      key: 'AEG-BLOCK-1',
      title: 'Blocked In Progress',
      status: 'todo' as const,
      dependencies: ['task-unmet-upstream'],
      subtasks: [],
      deliverables: [],
    };
    coordinator.getState().tasks.push(taskBlockedByDeps as any);

    const resInProg = coordinator.transitionTaskStatus('task-stage-block-1', 'in_progress');
    assert.strictEqual(resInProg.success, false, 'Must reject transition to in_progress when dependencies unmet');
    assert.ok(resInProg.error?.includes('Blocked by unfinished upstream dependencies'));

    // 2. Block transition to review if no real code artifact in workspace
    const taskMissingArtifact = {
      id: 'task-stage-block-2',
      key: 'AEG-NO-ARTIFACT',
      title: 'Missing Artifact',
      status: 'in_progress' as const,
      dependencies: [],
      subtasks: [],
      deliverables: [],
    };
    coordinator.getState().tasks.push(taskMissingArtifact as any);

    const resReview = coordinator.transitionTaskStatus('task-stage-block-2', 'review');
    assert.strictEqual(resReview.success, false, 'Must reject transition to review without real code artifact');
    assert.ok(resReview.error?.includes('No physical code artifact produced by worker'));

    // 3. Block transition to done if criteria or quality gates fail
    const resDone = coordinator.transitionTaskStatus('task-stage-block-2', 'done');
    assert.strictEqual(resDone.success, false, 'Must reject transition to done when quality gates fail');

    // Clean up transient test tasks from coordinator state
    coordinator.getState().tasks = coordinator.getState().tasks.filter(
      (t) => !['task-unmet-upstream', 'task-stage-block-1', 'task-stage-block-2'].includes(t.id)
    );
    coordinator.saveStateToDisk();
  });

  // --- 3. REAL CODING WORKER ASSIGNMENT & END-TO-END TRIAL TESTS ---
  await runTest('Real coding worker implements non-generic logic + spec tests + unified diff in isolated workspace', async () => {
    const newAssignment = {
      id: 'task-106-test',
      key: 'AEG-106',
      title: 'Construct Interactive DAG Dependency Diagram',
      status: 'in_progress' as const,
      dependencies: ['task-101'],
      subtasks: [
        { id: 'st-16', title: 'Topological sort and node level assignment', completed: false },
        { id: 'st-17', title: 'Cycle detection and deadlock prevention', completed: false },
        { id: 'st-18', title: 'Critical path analysis and bottleneck latency', completed: false },
      ],
      deliverables: [],
    };
    const agent = { id: 'agent-fe', name: 'Lyra UI', role: 'Frontend Architect' };

    const workerRes = await coordinator.executeWorkerStep(newAssignment as any, agent as any);
    assert.strictEqual(workerRes.subtasksCompleted.length, 3, 'Must complete all 3 criteria with passing assertions');
    assert.ok(workerRes.diff.includes('--- a/'), 'Must generate unified diff header');
    assert.ok(workerRes.diff.includes('function topologicalSort'), 'Must include topologicalSort in diff');
    assert.ok(workerRes.diff.includes('function detectCycles'), 'Must include detectCycles in diff');
    assert.ok(workerRes.diff.includes('function computeCriticalPath'), 'Must include computeCriticalPath in diff');
    assert.ok(fs.existsSync(path.resolve(process.cwd(), 'workspace/AEG-106/implementation.js')), 'Must exist in isolated workspace');
  });

  await runTest('End-to-End Trial: Worker takes bounded change, catches deliberate defect, rejects Done, corrects on feedback, and accepts only corrected result', async () => {
    const trial = await coordinator.runWorkerTrial();

    assert.strictEqual(trial.success, true, 'Trial must succeed');
    assert.strictEqual(trial.step1_dispatch.status, 'in_progress', 'Step 1 must dispatch to in_progress');
    assert.ok(trial.step2_initialDiff.includes('DELIBERATE DEFECT ACTIVE'), 'Step 2 must produce initial diff with deliberate defect');
    assert.strictEqual(trial.step3_defectCheck.defectDetected, true, 'Step 3 must detect deliberate defect');
    assert.strictEqual(trial.step4_blockedTransitionAttempt.blocked, true, 'Step 4 must block Done transition with HTTP 422');
    assert.strictEqual(trial.step4_blockedTransitionAttempt.status, 422, 'Step 4 must return HTTP 422');
    assert.ok(trial.step5_correctionDispatch.defectFeedback.includes('Fix: Clean acyclic DAG'), 'Step 5 must feed defect back to worker');
    assert.ok(trial.step6_correctedDiff.includes('recStack'), 'Step 6 must produce corrected diff with DFS cycle detection');
    assert.strictEqual(trial.step7_independentVerification.passed, true, 'Step 7 independent checks must pass 100%');
    assert.strictEqual(trial.step8_acceptedResult.status, 'done', 'Step 8 must accept task into Done');
  });

  // --- 4. ACTUAL DELIVERY HANDLER TESTS (LIVE DISPATCH & TEMP DIRS) ---
  await runTest('Actual delivery handler rejects Git branch delivery fail-closed when directory is not a git repo (HTTP 400, blocked: true)', async () => {
    const res = await handleRepositoryDispatch({
      action: 'deliver',
      repoConfig: {
        type: 'local_directory',
        localPath: testBaseDir,
        localWriteMode: 'git_branch',
      },
      task: aeg104Task,
    });

    assert.strictEqual(res.status, 400, 'Must return HTTP 400 for non-git directory');
    assert.strictEqual(res.body.blocked, true, 'Must return blocked: true');
    assert.ok(res.body.error.includes('not an initialized Git repository'));
  });

  await runTest('Actual delivery handler executes isolated Git branch delivery on verified repository with passing evidence', async () => {
    const gitRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-git-repo-'));
    try {
      // Initialize real git repo
      spawnSync('git', ['init'], { cwd: gitRepoDir });
      spawnSync('git', ['config', 'user.name', 'Aegis Test'], { cwd: gitRepoDir });
      spawnSync('git', ['config', 'user.email', 'test@aegis.local'], { cwd: gitRepoDir });
      // Create initial commit
      fs.writeFileSync(path.join(gitRepoDir, 'README.md'), '# Test Base Repo\n', 'utf8');
      spawnSync('git', ['add', '.'], { cwd: gitRepoDir });
      spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: gitRepoDir });

      // Compute real canonical candidate digest for AEG-104 delivery artifact
      const sourceArtifact = path.resolve(process.cwd(), '.aegis_artifacts/AEG-104/implementation.js');
      const tempStage = fs.mkdtempSync(path.join(os.tmpdir(), 'aeg104-stage-'));
      const targetSub = path.join(tempStage, 'src/services');
      fs.mkdirSync(targetSub, { recursive: true });
      fs.copyFileSync(sourceArtifact, path.join(targetSub, 'AEG-104_Service.js'));
      const realCandidateHash = computeCanonicalCandidateDigest(tempStage);
      fs.rmSync(tempStage, { recursive: true, force: true });

      // Record passing evidence in SQLite for AEG-104 and set accepted candidate hash
      storage.updateTaskWithRevision(aeg104Task.id, storage.getTaskById(aeg104Task.id).version, {
        acceptedCandidateHash: realCandidateHash,
      });
      for (const crit of storage.getCriteriaForTask(aeg104Task.id)) {
        storage.recordEvidence({
          taskId: aeg104Task.id,
          criterionId: crit.id,
          candidateHash: realCandidateHash,
          verifierName: 'unit_test_verifier',
          requirementsVersion: 1,
          outcome: 'passed',
        });
      }

      const res = await handleRepositoryDispatch({
        action: 'deliver',
        repoConfig: {
          type: 'local_directory',
          localPath: gitRepoDir,
          localWriteMode: 'git_branch',
          branchPrefix: 'aegis-test/',
        },
        task: aeg104Task,
      });

      assert.strictEqual(res.status, 200, 'Must deliver successfully to git branch');
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.commitHash, 'Must return real commit hash');
      assert.ok(res.body.branchName.includes('aegis-test/'), 'Must return created branch name');
    } finally {
      fs.rmSync(gitRepoDir, { recursive: true, force: true });
    }
  });

  await runTest('Actual delivery handler rejects unconfigured remote Git PR delivery fail-closed (blocked: true)', async () => {
    const res = await handleRepositoryDispatch({
      action: 'create_pr',
      repoConfig: {
        type: 'remote_git',
        repoUrl: 'https://github.com/acme/app',
      },
      task: aeg104Task,
    });

    assert.strictEqual(res.status, 400, 'Must return HTTP 400 for unconfigured remote Git delivery');
    assert.strictEqual(res.body.blocked, true, 'Must return blocked: true');
    assert.ok(res.body.error.includes('remote_git_not_configured'));
  });

  await runTest('Actual delivery handler blocks prefix-based path traversal (/tmp/project-other prefix attack)', async () => {
    // Sibling directory trap: target starts with base path prefix, but is outside base directory
    const siblingDir = testBaseDir + '-other';

    // Verify helper calculation
    assert.strictEqual(isPathContained(testBaseDir, siblingDir), false, 'Prefix match must not count as contained');

    const res = await handleRepositoryDispatch({
      action: 'deliver',
      repoConfig: {
        type: 'local_directory',
        localPath: testBaseDir,
        targetDirectory: '../' + path.basename(testBaseDir) + '-other',
        localWriteMode: 'patch_export',
      },
      task: aeg104Task,
    });

    assert.strictEqual(res.status, 400, 'Must return HTTP 400 for path traversal');
    assert.strictEqual(res.body.blocked, true);
    assert.ok(res.body.error.includes('Path traversal outside destination directory is forbidden'));
    assert.strictEqual(fs.existsSync(siblingDir), false, 'Must not create or write into sibling directory');
  });

  await runTest('Actual delivery handler blocks symlink path traversal escaping destination directory', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-outside-'));
    const symlinkPath = path.join(testBaseDir, 'escape_link');

    try {
      fs.symlinkSync(outsideDir, symlinkPath, 'dir');
    } catch {}

    if (fs.existsSync(symlinkPath)) {
      assert.strictEqual(isPathContained(testBaseDir, path.join(symlinkPath, 'target_file')), false, 'Symlink outside must not be contained');

      const res = await handleRepositoryDispatch({
        action: 'deliver',
        repoConfig: {
          type: 'local_directory',
          localPath: testBaseDir,
          targetDirectory: 'escape_link/sub',
          localWriteMode: 'patch_export',
        },
        task: aeg104Task,
      });

      assert.strictEqual(res.status, 400, 'Must reject symlink traversal with HTTP 400');
      assert.strictEqual(res.body.blocked, true);
    }
  });

  await runTest('Actual delivery handler protects existing destination files from direct overwrite (HTTP 409, blocked: true)', async () => {
    const directDestDir = path.join(testBaseDir, 'existing_protect');
    fs.mkdirSync(directDestDir, { recursive: true });
    const targetFile = path.join(directDestDir, 'AEG-104_Service.js');
    const originalContent = '// DO NOT OVERWRITE - PREVIOUS CODEBASE IMPLEMENTATION';
    fs.writeFileSync(targetFile, originalContent, 'utf-8');

    const res = await handleRepositoryDispatch({
      action: 'deliver',
      repoConfig: {
        type: 'local_directory',
        localPath: testBaseDir,
        targetDirectory: 'existing_protect',
        localWriteMode: 'direct_write',
      },
      task: aeg104Task,
      allowOverwrite: false,
    });

    assert.strictEqual(res.status, 409, 'Must return HTTP 409 conflict when file already exists');
    assert.strictEqual(res.body.blocked, true);
    assert.ok(res.body.error.includes('already exists'));

    // Assert file was NOT overwritten
    const contentAfter = fs.readFileSync(targetFile, 'utf-8');
    assert.strictEqual(contentAfter, originalContent, 'Existing file content must remain unchanged');
  });

  await runTest('Actual delivery handler rejects unknown delivery modes fail-closed without fallthrough (HTTP 400)', async () => {
    const res = await handleRepositoryDispatch({
      action: 'deliver',
      repoConfig: {
        type: 'local_directory',
        localPath: testBaseDir,
        targetDirectory: 'safe_dest',
        localWriteMode: 'arbitrary_mode_unsupported',
      },
      task: aeg104Task,
    });

    assert.strictEqual(res.status, 400, 'Must return HTTP 400 for unknown delivery mode');
    assert.strictEqual(res.body.blocked, true);
    assert.ok(res.body.error.includes('Unknown or unsupported delivery mode'));
    assert.strictEqual(fs.existsSync(path.join(testBaseDir, 'safe_dest/AEG-104_Service.js')), false, 'Must not fall through to direct write');
  });

  await runTest('Actual delivery handler executes safe patch export and creates valid physical patch on disk', async () => {
    const res = await handleRepositoryDispatch({
      action: 'deliver',
      repoConfig: {
        type: 'local_directory',
        localPath: testBaseDir,
        targetDirectory: 'patches_output',
        localWriteMode: 'patch_export',
      },
      task: aeg104Task,
    });

    assert.strictEqual(res.status, 200, 'Must return HTTP 200 for successful patch export');
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.targetFilePath, 'Must return targetFilePath');

    // Verify physical file on disk
    const diskPath = res.body.targetFilePath;
    assert.ok(fs.existsSync(diskPath), `Physical patch file must exist at ${diskPath}`);

    const patchText = fs.readFileSync(diskPath, 'utf-8');
    assert.ok(patchText.startsWith('--- a/patches_output/AEG-104_Service.js'), 'Must contain unified diff source header');
    assert.ok(patchText.includes('+++ b/patches_output/AEG-104_Service.js'), 'Must contain unified diff dest header');
    assert.ok(patchText.includes('@@ -0,0 +1,'), 'Must contain hunk line header');
    assert.ok(patchText.includes('+function calculateAgentLoad'), 'Must contain delivered implementation lines');
  });

  await runTest('Actual delivery handler fails closed when target task is missing from sprint state', async () => {
    const res = await handleRepositoryDispatch({
      action: 'deliver',
      repoConfig: {
        type: 'local_directory',
        localPath: testBaseDir,
        localWriteMode: 'patch_export',
      },
      task: { key: 'AEG-NONEXISTENT' },
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.blocked, true);
    assert.ok(res.body.error.includes('not found in sprint state'));
  });

  await runTest('Actual delivery handler fails closed when task quality gates have not passed', async () => {
    const unaccepted = {
      id: 'task-unaccepted-deliv',
      key: 'AEG-UNACC',
      title: 'Unaccepted task',
      status: 'todo' as const,
      dependencies: [],
      subtasks: [{ id: 'u1', title: 'Incomplete subtask', completed: false }],
      deliverables: [],
    };
    coordinator.getState().tasks.push(unaccepted as any);

    const res = await handleRepositoryDispatch({
      action: 'deliver',
      repoConfig: {
        type: 'local_directory',
        localPath: testBaseDir,
        localWriteMode: 'patch_export',
      },
      task: unaccepted,
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.blocked, true);
    assert.ok(res.body.error.includes('failed quality gate acceptance'));
  });

  // Clean up fixture
  try {
    fs.rmSync(testBaseDir, { recursive: true, force: true });
  } catch {}

  console.log(`\n=== REGRESSION SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED CLEANLY ===`);
}

executeSuite().catch((e) => {
  console.error(e);
  process.exit(1);
});
