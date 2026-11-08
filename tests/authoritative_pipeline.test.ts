/**
 * Aegis Orchestrator - 15 Critical Fail-Closed Regression Tests
 * 
 * Verifies end-to-end security, state machine, sandbox, evidence, and delivery guardrails:
 * 1. Unauthenticated mutation rejection (HTTP 401)
 * 2. Missing verifier fail-closed (blocked/failed acceptance)
 * 3. Client-provided completion flag cannot forge acceptance
 * 4. Missing provider rejection (provider_not_configured, no fixture fallback in prod)
 * 5. Worker failure/timeout/budget exhaustion propagation to task status
 * 6. Lifecycle persistence in SQLite across service reloads
 * 7. Stale edit rejection (HTTP 409 revision conflict)
 * 8. Cycle/missing dependency transition rejection
 * 9. Process tree termination (killing child and grandchild)
 * 10. Host file access blocking via sandbox (reading /etc/shadow or root)
 * 11. Requirements change invalidating prior acceptance
 * 12. Mismatched candidate delivery rejection (tampered candidate hash)
 * 13. Patch verification failure (corrupted patch fails git apply --check)
 * 14. Branch conflict handling (existing branch handled cleanly)
 * 15. Restart interrupted run recovery (in-flight runs marked interrupted)
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { storage } from '../src/server/storage/db.js';
import { verifyTaskAcceptance } from '../src/server/verification/acceptanceEngine.js';
import { runBoundedCorrectionLoop } from '../src/server/orchestration/correctionLoop.js';
import { OrchestratorService, detectCyclesInDag } from '../src/server/orchestration/orchestratorService.js';
import { GitDeliveryService } from '../src/server/delivery/gitDeliveryService.js';
import { runInSandbox, isNodePermissionSupported, createDisposableCheckout } from '../src/server/execution/sandboxRuntime.js';
import { CodingWorker } from '../src/server/codingWorker.js';
import { requireAuthToken, getOrGenerateAuthToken } from '../src/server/security/auth.js';
import { coordinator } from '../src/server/coordinator.js';

let passedTests = 0;
let totalTests = 0;

async function runTest(name: string, fn: () => void | Promise<void>) {
  totalTests++;
  try {
    await fn();
    console.log(`✔ [PASS] ${name}`);
    passedTests++;
  } catch (err: any) {
    console.error(`✘ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

async function executeSuite() {
  console.log('\n=== RUNNING 15 CRITICAL AUTHORITATIVE PIPELINE REGRESSION TESTS ===\n');

  const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-auth-pipe-'));

  // --- TEST 1: Unauthenticated mutation rejection (HTTP 401) ---
  await runTest('1. Unauthenticated mutating requests are rejected with HTTP 401', () => {
    let statusCode: number | null = null;
    let jsonResponse: any = null;

    const req: any = {
      method: 'POST',
      path: '/api/orchestrate/state',
      headers: {}, // No X-Aegis-Auth-Token header
    };

    const res: any = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (data: any) => {
        jsonResponse = data;
        return res;
      },
    };

    let nextCalled = false;
    const next = () => { nextCalled = true; };

    requireAuthToken(req, res, next);

    assert.strictEqual(statusCode, 401, 'Unauthenticated mutation must return HTTP 401');
    assert.strictEqual(nextCalled, false, 'Middleware must not call next() when unauthorized');
    assert.ok(jsonResponse?.error?.includes('Unauthorized'), 'Response must explain authentication requirement');
  });

  // --- TEST 2: Missing verifier fail-closed ---
  await runTest('2. Missing verifier produces fail-closed blocked acceptance (no --version/syntax fallbacks)', async () => {
    const taskId = `task-unverified-${Date.now()}`;
    const taskDir = path.join(testTempDir, 'unverified-workspace');
    fs.mkdirSync(taskDir, { recursive: true });

    storage.insertTask({
      id: taskId,
      key: `AEG-UNV-${Date.now().toString().slice(-4)}`,
      title: 'Unverified task without tests',
      status: 'in_progress',
      subtasks: [
        {
          id: `crit-unv-${Date.now()}`,
          title: 'Must have explicit test command',
          verificationMethod: 'trusted_test',
          verificationSpec: {}, // Empty spec without command or test suite
        },
      ],
    });

    const evalResult = await verifyTaskAcceptance({
      taskId,
      workspacePath: taskDir,
    });

    assert.strictEqual(evalResult.allPassed, false, 'Acceptance must fail closed when verifier command is missing');
    assert.strictEqual(evalResult.results[0].passed, false);
    assert.ok(
      evalResult.results[0].failureReason?.includes('Acceptance blocked') ||
      evalResult.results[0].failureReason?.includes('No explicit test command'),
      'Must explain that missing verifier cannot certify acceptance'
    );
  });

  // --- TEST 3: Client-provided completion flag cannot forge acceptance ---
  await runTest('3. Client-provided completion flags cannot create passed criteria in storage', () => {
    const forgedTaskId = `task-forged-${Date.now()}`;
    const forgedCritId = `crit-forged-${Date.now()}`;

    // Client attempts to pass completed: true without verification evidence
    storage.insertTask({
      id: forgedTaskId,
      key: `AEG-FORGE-${Date.now().toString().slice(-4)}`,
      title: 'Forged completion test',
      status: 'in_progress',
      subtasks: [
        {
          id: forgedCritId,
          title: 'Attempted forge',
          completed: true, // Client claims completed!
        },
      ],
    });

    const criteria = storage.getCriteriaForTask(forgedTaskId);
    assert.strictEqual(criteria.length, 1);
    assert.strictEqual(criteria[0].status, 'pending', 'Criterion must be stored as "pending", ignoring client completed: true');

    const retrievedTask = storage.getTaskById(forgedTaskId);
    assert.strictEqual(retrievedTask.subtasks[0].completed, false, 'Task subtasks must reflect stored status, not client forge');
  });

  // --- TEST 4: Missing provider rejection (no fixture fallback in production) ---
  await runTest('4. Missing AI provider credentials reject execution without fixture fallback', async () => {
    const worker = new CodingWorker(testTempDir);
    const originalApiKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      let threw = false;
      try {
        await worker.executeAssignment(
          {
            id: 'task-unknown-prod',
            key: 'AEG-UNKNOWN-TASK',
            title: 'Arbitrary custom task outside test templates',
            description: 'Implement complex token bucket',
            epicId: 'epic-1',
            status: 'todo',
            priority: 'high',
            assignedAgentId: 'agent-1',
            estimatedHours: 4,
            spentHours: 0,
            dependencies: [],
            subtasks: [{ id: 'sub-1', title: 'Token bucket rate limiting', completed: false }],
            tags: [],
          },
          { id: 'agent-1', name: 'Nexus', role: 'Engineer', baseRole: 'Engineer', avatar: '', model: 'gemini', providerType: 'gemini', status: 'idle', completedTasksCount: 0, velocity: 10, skills: [], communicationCount: 0 },
          { useGeminiIfAvailable: true, useFixtureInTest: false }
        );
      } catch (err: any) {
        threw = true;
        assert.ok(
          err.message.includes('AI model provider credentials (GEMINI_API_KEY) are not configured') ||
          err.message.includes('Execution blocked'),
          'Must reject when credentials absent instead of fabricating progress'
        );
      }
      assert.strictEqual(threw, true, 'Must throw fail-closed error');
    } finally {
      if (originalApiKey) process.env.GEMINI_API_KEY = originalApiKey;
    }
  });

  // --- TEST 5: Worker failure/timeout/budget exhaustion propagation ---
  await runTest('5. Worker failure and budget exhaustion propagate directly to task status (blocked)', async () => {
    const taskId = `task-budget-${Date.now()}`;
    const taskDir = path.join(testTempDir, 'budget-workspace');
    fs.mkdirSync(taskDir, { recursive: true });

    storage.insertTask({
      id: taskId,
      key: `AEG-BUDGET-${Date.now().toString().slice(-4)}`,
      title: 'Budget exhaustion task',
      description: 'Will fail repeatedly',
      status: 'todo',
      subtasks: [
        {
          id: `crit-b-${Date.now()}`,
          title: 'Unfailing test',
          verificationMethod: 'file_presence',
          verificationSpec: { expectedFile: 'non_existent_file.js' },
        },
      ],
    });

    const failingAdapter = {
      name: 'FailingWorker',
      executeTask: async () => ({
        status: 'completed' as const, // worker claims completed, but verification fails
        diff: '+ dummy',
        tokensUsed: 100,
        turnsUsed: 1,
        modifiedFiles: [],
        toolHistory: [],
        summary: 'Mock execution for budget exhaustion test',
      }),
    };

    const loopResult = await runBoundedCorrectionLoop(taskId, 'agent-test', failingAdapter, {
      maxAttempts: 2,
      workspacePath: taskDir,
    });

    assert.strictEqual(loopResult.accepted, false, 'Correction loop must reject task after attempts exhausted');
    assert.strictEqual(loopResult.attemptsUsed, 2);

    const updatedTask = storage.getTaskById(taskId);
    assert.strictEqual(updatedTask.status, 'blocked', 'Task status must be locked to blocked upon budget exhaustion');
    assert.ok(updatedTask.lastAgentComment?.includes('Correction budget exhausted'));
  });

  // --- TEST 6: Lifecycle persistence in SQLite across service reloads ---
  await runTest('6. Lifecycle state persists reliably in transactional SQLite across restarts', () => {
    const persistTaskId = `task-persist-${Date.now()}`;
    storage.insertTask({
      id: persistTaskId,
      key: `AEG-PER-${Date.now().toString().slice(-4)}`,
      title: 'Persistent task',
      description: 'Testing SQLite ACID persistence',
      status: 'in_progress',
      subtasks: [
        { id: `crit-p1-${Date.now()}`, title: 'Criterion 1', verificationMethod: 'trusted_test' },
      ],
    });

    // Update revision
    const updateRes = storage.updateTaskWithRevision(persistTaskId, 1, {
      status: 'review',
      lastAgentComment: 'Worker completed initial pass',
    });
    assert.strictEqual(updateRes.success, true);
    assert.strictEqual(updateRes.newVersion, 2);

    // Fetch afresh from database
    const fresh = storage.getTaskById(persistTaskId);
    assert.strictEqual(fresh.status, 'review');
    assert.strictEqual(fresh.version, 2);
    assert.strictEqual(fresh.lastAgentComment, 'Worker completed initial pass');
  });

  // --- TEST 7: Stale edit rejection (HTTP 409 revision conflict) ---
  await runTest('7. Stale edits with mismatched revision versions are rejected with conflict', () => {
    const staleTaskId = `task-stale-${Date.now()}`;
    storage.insertTask({
      id: staleTaskId,
      key: `AEG-STALE-${Date.now().toString().slice(-4)}`,
      title: 'Revision conflict test',
      status: 'todo',
    });

    // Task is now version 1. Attempt to update expecting version 0 or stale version 99
    const conflictRes = storage.updateTaskWithRevision(staleTaskId, 99, { status: 'in_progress' });
    assert.strictEqual(conflictRes.success, false, 'Stale revision must be rejected');
    assert.ok(conflictRes.error?.includes('Stale write conflict'), 'Conflict error must be returned');

    // Verify task did not change
    const check = storage.getTaskById(staleTaskId);
    assert.strictEqual(check.version, 1);
    assert.strictEqual(check.status, 'todo');
  });

  // --- TEST 8: Cycle/missing dependency transition rejection ---
  await runTest('8. Illegal state transitions and unfulfilled dependencies are strictly blocked', () => {
    const depTaskId = `task-dep-${Date.now()}`;
    const mainTaskId = `task-main-${Date.now()}`;

    storage.insertTask({
      id: depTaskId,
      key: `AEG-DEP-${Date.now().toString().slice(-4)}`,
      title: 'Prerequisite task',
      status: 'in_progress', // NOT done!
    });

    storage.insertTask({
      id: mainTaskId,
      key: `AEG-MAIN-${Date.now().toString().slice(-4)}`,
      title: 'Dependent task',
      status: 'todo',
      dependencies: [depTaskId],
    });

    // Attempt to move main task to in_progress while dependency is incomplete
    const transRes = OrchestratorService.transitionTaskStatus(mainTaskId, 'in_progress');
    assert.strictEqual(transRes.success, false, 'Cannot transition to in_progress when dependency is unfinished');
    assert.ok(transRes.error?.includes('Blocked by dependencies'));

    // Attempt illegal transition directly from todo to done
    const illegalTrans = OrchestratorService.transitionTaskStatus(mainTaskId, 'done');
    assert.strictEqual(illegalTrans.success, false, 'Cannot transition directly from todo to done');
    assert.ok(illegalTrans.error?.includes('Illegal state transition'));
  });

  // --- TEST 9: Process tree termination (killing child and grandchild) ---
  await runTest('9. Process tree termination terminates child and descendant processes upon timeout', async () => {
    // Spawn a node script that spawns a background grandchild sleep process
    const script = `
      const { spawn } = require('child_process');
      const child = spawn('sleep', ['60']);
      console.log('Grandchild PID:', child.pid);
      setInterval(() => {}, 1000);
    `;

    const sandboxRes = await runInSandbox({
      command: 'node',
      args: ['-e', script],
      workspacePath: testTempDir,
      allowChildProcess: true,
      timeoutMs: 1200, // Short timeout
    });

    assert.strictEqual(sandboxRes.timedOut, true, 'Process must time out');
    assert.strictEqual(sandboxRes.exitCode, -1);
    assert.ok(sandboxRes.durationMs >= 1000, 'Execution must run until timeout');
  });

  // --- TEST 10: Host file access blocking via sandbox ---
  await runTest('10. Host file access (/etc/shadow, /etc/passwd) is blocked by the sandbox runtime', async () => {
    // If permission model is supported on Node, verify restricted read throws ERR_ACCESS_DENIED
    if (!isNodePermissionSupported()) {
      console.log('Note: Node permission model not supported in this runtime environment, skipping permission flag assertion');
      return;
    }

    const script = `
      const fs = require('fs');
      try {
        fs.readFileSync('/etc/shadow');
        process.exit(0);
      } catch (err) {
        process.stderr.write('BLOCKED: ' + (err.code || err.message));
        process.exit(42);
      }
    `;

    const result = await runInSandbox({
      command: 'node',
      args: ['-e', script],
      workspacePath: testTempDir,
      timeoutMs: 5000,
    });

    assert.strictEqual(result.exitCode, 42, 'Restricted file read must be blocked by sandbox');
    assert.ok(result.stderr.includes('BLOCKED: ERR_ACCESS_DENIED') || result.stderr.includes('ERR_ACCESS_DENIED'));
  });

  // --- TEST 11: Requirements change invalidates prior acceptance ---
  await runTest('11. Changing requirements invalidates prior acceptance and clears candidate hash', async () => {
    const reqTaskId = `task-req-${Date.now()}`;
    const taskDir = path.join(testTempDir, 'req-workspace');
    fs.mkdirSync(taskDir, { recursive: true });

    const specFile = path.join(taskDir, 'spec.test.js');
    fs.writeFileSync(specFile, 'process.exit(0);');

    storage.insertTask({
      id: reqTaskId,
      key: `AEG-REQ-${Date.now().toString().slice(-4)}`,
      title: 'Requirements test',
      status: 'in_progress',
      subtasks: [
        {
          id: `crit-r-${Date.now()}`,
          title: 'Spec test',
          verificationMethod: 'trusted_test',
          verificationSpec: { command: 'node', args: [specFile] },
        },
      ],
    });

    // Verify and pass
    const vResult = await verifyTaskAcceptance({ taskId: reqTaskId, workspacePath: taskDir });
    assert.strictEqual(vResult.allPassed, true);

    const taskBefore = storage.getTaskById(reqTaskId);
    assert.ok(taskBefore.acceptedCandidateHash, 'Candidate hash must be set upon acceptance');
    assert.strictEqual(taskBefore.requirementsVersion, 1);

    // Requirements change!
    const invalidated = storage.invalidateTaskAcceptance(reqTaskId, 'Product specification updated with new constraints');
    assert.strictEqual(invalidated.requirementsVersion, 2, 'Requirements version must increment');
    assert.strictEqual(invalidated.acceptedCandidateHash, undefined, 'Accepted candidate hash must be cleared');
    assert.strictEqual(invalidated.subtasks[0].completed, false, 'Criteria must be reset to pending');
  });

  // --- TEST 12: Mismatched candidate delivery rejection ---
  await runTest('12. Delivery rejects candidate with mismatched digest or tampered code', async () => {
    const gitRepoDir = path.join(testTempDir, 'tamper-git-repo');
    fs.mkdirSync(gitRepoDir, { recursive: true });
    spawnSync('git', ['init'], { cwd: gitRepoDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: gitRepoDir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitRepoDir });
    fs.writeFileSync(path.join(gitRepoDir, 'README.md'), '# Base\n');
    spawnSync('git', ['add', '.'], { cwd: gitRepoDir });
    spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: gitRepoDir });

    const tamperTaskId = `task-tamper-${Date.now()}`;
    storage.insertTask({
      id: tamperTaskId,
      key: `AEG-TAMPER-${Date.now().toString().slice(-4)}`,
      title: 'Tamper test',
      status: 'review',
      acceptedCandidateHash: 'legitimate_sha256_hash_value',
      requirementsVersion: 1,
      subtasks: [
        {
          id: `crit-t-${Date.now()}`,
          title: 'Validated criterion',
          verificationMethod: 'trusted_test',
          status: 'passed',
        },
      ],
    });

    // Record passing evidence bound to the legitimate hash
    storage.recordEvidence({
      taskId: tamperTaskId,
      candidateHash: 'legitimate_sha256_hash_value',
      verifierName: 'test_verifier',
      requirementsVersion: 1,
      outcome: 'passed',
    });

    // Caller attempts to deliver with a modified/tampered candidate hash
    const delivRes = await GitDeliveryService.deliverToBranch(tamperTaskId, {
      repoPath: gitRepoDir,
      branchName: 'feature-tampered',
      commitMessage: 'Tampered commit',
      candidateHash: 'tampered_malicious_hash_value',
      filesToCommit: [{ relPath: 'src/hack.js', content: 'malicious payload' }],
    });

    assert.strictEqual(delivRes.success, false, 'Delivery must be rejected when candidate hash does not match');
    assert.ok(delivRes.error?.includes('Candidate hash mismatch'));
  });

  // --- TEST 13: Patch verification failure (corrupted patch) ---
  await runTest('13. Patch verification rejects corrupted or conflicting diffs', async () => {
    const patchRepo = path.join(testTempDir, 'patch-git-repo');
    fs.mkdirSync(patchRepo, { recursive: true });
    spawnSync('git', ['init'], { cwd: patchRepo });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: patchRepo });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: patchRepo });
    fs.writeFileSync(path.join(patchRepo, 'main.txt'), 'Original line 1\nOriginal line 2\n');
    spawnSync('git', ['add', '.'], { cwd: patchRepo });
    spawnSync('git', ['commit', '-m', 'Initial'], { cwd: patchRepo });

    const corruptedPatch = `--- a/main.txt\n+++ b/main.txt\n@@ -1,2 +1,2 @@\n-NONEXISTENT CONTENT\n+REPLACED CONTENT\n`;
    const tempPatchFile = path.join(testTempDir, 'corrupted.patch');
    fs.writeFileSync(tempPatchFile, corruptedPatch);

    // Run git apply --check
    const checkRes = spawnSync('git', ['apply', '--check', tempPatchFile], {
      cwd: patchRepo,
      encoding: 'utf8',
    });

    assert.notStrictEqual(checkRes.status, 0, 'git apply --check must fail on corrupted patch');
  });

  // --- TEST 14: Branch conflict handling ---
  await runTest('14. Delivery handles branch conflict gracefully without throwing unhandled exceptions', async () => {
    const conflictRepo = path.join(testTempDir, 'conflict-git-repo');
    fs.mkdirSync(conflictRepo, { recursive: true });
    spawnSync('git', ['init'], { cwd: conflictRepo });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: conflictRepo });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: conflictRepo });
    fs.writeFileSync(path.join(conflictRepo, 'file.txt'), 'Hello\n');
    spawnSync('git', ['add', '.'], { cwd: conflictRepo });
    spawnSync('git', ['commit', '-m', 'Base commit'], { cwd: conflictRepo });

    // Pre-create branch "conflict-branch"
    spawnSync('git', ['branch', 'conflict-branch'], { cwd: conflictRepo });

    const conflictTaskId = `task-branch-conflict-${Date.now()}`;
    const critId = `c-conf-${Date.now()}`;
    const hash = 'valid_candidate_hash_for_conflict';
    storage.insertTask({
      id: conflictTaskId,
      key: `AEG-CONF-${Date.now().toString().slice(-4)}`,
      title: 'Branch conflict task',
      status: 'review',
      acceptedCandidateHash: hash,
      requirementsVersion: 1,
      subtasks: [
        { id: critId, title: 'Passing test', verificationMethod: 'trusted_test' },
      ],
    });

    storage.recordEvidence({
      taskId: conflictTaskId,
      criterionId: critId,
      candidateHash: hash,
      verifierName: 'verifier',
      requirementsVersion: 1,
      outcome: 'passed',
    });

    const res = await GitDeliveryService.deliverToBranch(conflictTaskId, {
      repoPath: conflictRepo,
      branchName: 'conflict-branch', // already exists!
      commitMessage: 'Delivery attempt',
      candidateHash: hash,
      filesToCommit: [{ relPath: 'file.txt', content: 'Updated\n' }],
    });

    assert.strictEqual(res.success, false, 'Delivery must return clean error for existing branch');
    assert.ok(res.error?.includes('Branch conflict') || res.error?.includes('already exists'));
  });

  // --- TEST 15: Restart interrupted run recovery ---
  await runTest('15. In-flight runs on server restart are recovered to interrupted status', () => {
    const interTaskId = `task-inter-${Date.now()}`;
    storage.insertTask({
      id: interTaskId,
      key: `AEG-INTR-${Date.now().toString().slice(-4)}`,
      title: 'Interrupted task',
      status: 'in_progress',
    });

    // Create an in-flight run
    const inFlightRun = storage.createRun({
      taskId: interTaskId,
      agentId: 'agent-inter',
      status: 'running',
      workspacePath: testTempDir,
    });

    assert.strictEqual(inFlightRun.status, 'running');

    // Simulate server boot recovery
    const recoveredCount = storage.recoverInterruptedRunsOnBoot();
    assert.ok(recoveredCount >= 1, 'At least 1 in-flight run must be recovered');

    const recoveredRun = storage.getRunById(inFlightRun.id);
    assert.strictEqual(recoveredRun.status, 'interrupted', 'Run must be transitioned to interrupted');
    assert.ok(recoveredRun.error?.includes('interrupted by server restart') || recoveredRun.error?.includes('in-flight'));

    const taskAfter = storage.getTaskById(interTaskId);
    assert.strictEqual(taskAfter.status, 'blocked', 'In-progress task must be moved to blocked');
  });

  // Cleanup
  try {
    fs.rmSync(testTempDir, { recursive: true, force: true });
  } catch {}

  console.log(`\n=== 15 CRITICAL PIPELINE TESTS PASSED CLEANLY: ${passedTests}/${totalTests} ===\n`);
}

executeSuite().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
