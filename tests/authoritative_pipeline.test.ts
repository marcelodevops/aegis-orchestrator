/**
 * Aegis Orchestrator - 19 Authoritative Pipeline & Security Regression Tests
 * 
 * Verifies end-to-end security, state machine, sandbox, evidence, and delivery guardrails:
 * 1. Real HTTP Express unauthenticated mutation rejection (HTTP 401)
 * 2. Missing verifier fail-closed (blocked/failed acceptance)
 * 3. Client-provided completion flag cannot forge acceptance
 * 4. Missing provider rejection (provider_not_configured, no fixture fallback in prod)
 * 5. Worker failure/timeout/budget exhaustion propagation with pre-existing files
 * 6. Real database close and reopen verifying ACID persistence
 * 7. Real HTTP revision conflict & lifecycle protection (missing version, stale version, status mutation)
 * 8. Cycle/missing dependency transition rejection
 * 9. Real grandchild process termination verification (grandchild PID does not survive)
 * 10. Real host file access blocking via sandbox (reading readable sentinel outside workspace fails with ERR_ACCESS_DENIED)
 * 11. Requirements change invalidating prior acceptance
 * 12. Verified content delivery (recomputed canonical digest rejects altered files despite claimed matching hash)
 * 13. Patch verification failure (corrupted patch fails git apply --check)
 * 14. Branch conflict handling (existing branch handled cleanly)
 * 15. Restart interrupted run recovery (in-flight runs marked interrupted)
 * 16. Sandbox fail-closed check (unshare unavailable fails closed with execution_runtime_unavailable)
 * 17. Sandbox network isolation check (network access blocked inside sandbox)
 * 18. Verifier independence check (worker process.exit(0) cannot defeat trusted suite)
 * 19. Remote Git delivery (truthful blocked result when unconfigured, successful delivery to test remote)
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { StorageEngine, storage } from '../src/server/storage/db.js';
import { verifyTaskAcceptance, computeCanonicalCandidateDigest } from '../src/server/verification/acceptanceEngine.js';
import { runBoundedCorrectionLoop } from '../src/server/orchestration/correctionLoop.js';
import { OrchestratorService } from '../src/server/orchestration/orchestratorService.js';
import { GitDeliveryService, materializeCandidateToWorktree } from '../src/server/delivery/gitDeliveryService.js';
import { 
  runInSandbox, 
  isNodePermissionSupported, 
  setUnshareSupportedForTesting, 
  isUnshareSupported 
} from '../src/server/execution/sandboxRuntime.js';
import { CodingWorker } from '../src/server/codingWorker.js';
import { getOrGenerateAuthToken } from '../src/server/security/auth.js';
import { coordinator, getAegisDataDir } from '../src/server/coordinator.js';

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
  console.log('\n=== RUNNING 22 CRITICAL AUTHORITATIVE PIPELINE REGRESSION TESTS ===\n');

  const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-auth-pipe-'));
  const testDataDir = path.join(testTempDir, 'data');
  const testDbPath = path.join(testDataDir, 'aegis_test.db');
  const testStatePath = path.join(testDataDir, 'aegis_state.json');

  // Enforce isolated storage and state roots for the entire test suite
  process.env.AEGIS_DATA_DIR = testDataDir;
  process.env.AEGIS_DB_PATH = testDbPath;
  process.env.AEGIS_STATE_PATH = testStatePath;

  fs.mkdirSync(testDataDir, { recursive: true });
  StorageEngine.resetInstance(testDbPath);
  coordinator.resetState(testStatePath);

  const authToken = getOrGenerateAuthToken();

  // --- TEST 1: Real HTTP unauthenticated mutation rejection (HTTP 401) ---
  await runTest('1. Real HTTP unauthenticated mutation is rejected with HTTP 401', async () => {
    // Make actual HTTP fetch against the live Express server without auth token
    const res = await fetch('http://localhost:3000/api/orchestrate/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daemonRunning: false }),
    });

    assert.strictEqual(res.status, 401, 'Unauthenticated mutation must return HTTP 401');
    const data = await res.json();
    assert.ok(data?.error?.includes('Unauthorized'), 'Response must explain authentication requirement');

    // Authenticated request should pass authentication
    const authRes = await fetch('http://localhost:3000/api/orchestrate/state', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Aegis-Auth-Token': authToken,
      },
      body: JSON.stringify({ daemonRunning: false }),
    });

    assert.notStrictEqual(authRes.status, 401, 'Authenticated mutation must not return HTTP 401');
  });

  // --- TEST 2: Missing verifier fail-closed ---
  await runTest('2. Missing verifier produces fail-closed blocked acceptance (no --version/syntax fallbacks)', async () => {
    const taskId = `task-unv-${Date.now()}`;
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

  // --- TEST 5: Worker failure/timeout/budget exhaustion propagation with pre-existing files ---
  await runTest('5. Worker failure propagates to blocked status and is never masked by pre-existing workspace files', async () => {
    const taskId = `task-outcome-${Date.now()}`;
    const taskDir = path.join(testTempDir, 'preexisting-workspace');
    fs.mkdirSync(taskDir, { recursive: true });

    // Plant pre-existing valid files in workspace
    fs.writeFileSync(path.join(taskDir, 'implementation.js'), 'module.exports = { valid: true };');
    fs.writeFileSync(path.join(taskDir, 'spec.test.js'), 'process.exit(0);');

    storage.insertTask({
      id: taskId,
      key: `AEG-FAIL-${Date.now().toString().slice(-4)}`,
      title: 'Failed worker task',
      description: 'Tests status propagation',
      status: 'in_progress',
      subtasks: [
        {
          id: `crit-f-${Date.now()}`,
          title: 'Must pass',
          verificationMethod: 'trusted_test',
        },
      ],
    });

    const failedAdapter = {
      name: 'FailingWorker',
      executeTask: async () => ({
        status: 'failed' as const,
        error: 'Execution failed: Model generation timed out or crashed',
        diff: '',
        tokensUsed: 50,
        turnsUsed: 1,
        modifiedFiles: [],
        toolHistory: [],
        summary: 'Failed worker run',
      }),
    };

    const worker = new CodingWorker(testTempDir);
    const workerRes = await worker.executeAssignment(
      storage.getTaskById(taskId),
      { id: 'agent-1', name: 'Nexus', role: 'Dev', baseRole: 'Dev', avatar: '', model: 'test', providerType: 'gemini', status: 'idle', completedTasksCount: 0, velocity: 10, skills: [], communicationCount: 0 },
      { workspaceDir: taskDir, workerAdapter: failedAdapter }
    );

    assert.strictEqual(workerRes.success, false, 'Failed worker must return success: false');
    assert.strictEqual(workerRes.blocked, true, 'Failed worker must return blocked: true');

    const updatedTask = storage.getTaskById(taskId);
    assert.strictEqual(updatedTask.status, 'blocked', 'Task must be set to blocked status in database');
    assert.ok(updatedTask.lastAgentComment?.includes('Worker execution ended with failed'));
  });

  // --- TEST 6: Real database close and reopen verifying ACID persistence ---
  await runTest('6. Lifecycle state persists reliably across database close and fresh reconnect', () => {
    const testDbPath = path.join(testTempDir, 'acid_test.db');
    
    // Open connection 1
    const db1 = new DatabaseSync(testDbPath);
    db1.exec('PRAGMA journal_mode = WAL;');
    db1.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
    `);

    db1.prepare('INSERT INTO tasks (id, key, title, status, version) VALUES (?, ?, ?, ?, ?)').run(
      'task-acid-1',
      'AEG-ACID',
      'ACID Test Task',
      'in_progress',
      1
    );

    // Update with revision
    const update = db1.prepare('UPDATE tasks SET status = ?, version = version + 1 WHERE id = ? AND version = ?').run(
      'review',
      'task-acid-1',
      1
    );
    assert.strictEqual(update.changes, 1);

    // Close connection 1 completely
    db1.close();

    // Open connection 2 from fresh process/context
    const db2 = new DatabaseSync(testDbPath);
    const row: any = db2.prepare('SELECT * FROM tasks WHERE id = ?').get('task-acid-1');
    db2.close();

    assert.ok(row, 'Task record must exist after db reopen');
    assert.strictEqual(row.status, 'review', 'Status transition must persist across reopen');
    assert.strictEqual(row.version, 2, 'Version increment must persist across reopen');
  });

  // --- TEST 7: Real HTTP revision conflict and lifecycle protection ---
  await runTest('7. Real HTTP API rejects missing version, stale revisions, and unauthorized status edits with HTTP 409', async () => {
    const targetTaskId = 'task-102'; // AEG-102
    const currentTask = storage.getTaskById(targetTaskId);
    assert.ok(currentTask, 'Task AEG-102 must exist');

    // 1. Missing version on existing task -> HTTP 409
    const missingVerRes = await fetch('http://localhost:3000/api/orchestrate/state', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Aegis-Auth-Token': authToken,
      },
      body: JSON.stringify({
        tasks: [{ id: targetTaskId, key: currentTask.key, title: 'Updated Without Version' }],
      }),
    });
    assert.strictEqual(missingVerRes.status, 409, 'Missing version on existing task must return HTTP 409');
    const missingData = await missingVerRes.json();
    assert.ok(missingData.error?.includes('Revision required'), 'Error must specify revision required');

    // 2. Stale version (version mismatch) -> HTTP 409
    const staleVerRes = await fetch('http://localhost:3000/api/orchestrate/state', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Aegis-Auth-Token': authToken,
      },
      body: JSON.stringify({
        tasks: [{ id: targetTaskId, key: currentTask.key, version: 9999, title: 'Stale Update' }],
      }),
    });
    assert.strictEqual(staleVerRes.status, 409, 'Stale version must return HTTP 409');
    const staleData = await staleVerRes.json();
    assert.ok(staleData.error?.includes('Stale write conflict'), 'Error must specify stale write conflict');

    // 3. Status mutation attempt through generic edit route -> HTTP 409
    const statusMutationRes = await fetch('http://localhost:3000/api/orchestrate/state', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Aegis-Auth-Token': authToken,
      },
      body: JSON.stringify({
        tasks: [{ id: targetTaskId, key: currentTask.key, version: currentTask.version, status: 'done' }],
      }),
    });
    assert.strictEqual(statusMutationRes.status, 409, 'Status mutation via generic route must return HTTP 409');
    const statusData = await statusMutationRes.json();
    assert.ok(statusData.error?.includes('Illegal status mutation'), 'Error must reject illegal status mutation');
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

    const transRes = OrchestratorService.transitionTaskStatus(mainTaskId, 'in_progress');
    assert.strictEqual(transRes.success, false, 'Cannot transition to in_progress when dependency is unfinished');
    assert.ok(transRes.error?.includes('Blocked by dependencies'));

    const illegalTrans = OrchestratorService.transitionTaskStatus(mainTaskId, 'done');
    assert.strictEqual(illegalTrans.success, false, 'Cannot transition directly from todo to done');
    assert.ok(illegalTrans.error?.includes('Illegal state transition'));
  });

  // --- TEST 9: Real grandchild process termination verification ---
  await runTest('9. Process tree termination cleanly eliminates child and grandchild OS processes upon timeout', async () => {
    const pidFile = path.join(testTempDir, 'grandchild.pid');
    
    // Subprocess script spawns a grandchild process, writes PID to file, and loops
    const script = `
      const { spawn } = require('child_process');
      const fs = require('fs');
      const gc = spawn('sleep', ['60']);
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));
      setInterval(() => {}, 500);
    `;

    const sandboxRes = await runInSandbox({
      command: 'node',
      args: ['-e', script],
      workspacePath: testTempDir,
      allowChildProcess: true,
      timeoutMs: 1200,
    });

    assert.strictEqual(sandboxRes.timedOut, true, 'Sandbox run must time out');

    // Give OS a moment to complete signal handling
    await new Promise((r) => setTimeout(r, 600));

    // Verify grandchild PID was killed and no longer exists in OS process table
    if (fs.existsSync(pidFile)) {
      const gcPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      assert.ok(!isNaN(gcPid) && gcPid > 0, 'Grandchild PID must be valid');

      let processExists = true;
      try {
        process.kill(gcPid, 0); // Signal 0 checks process existence without killing
      } catch (e: any) {
        if (e.code === 'ESRCH') {
          processExists = false;
        }
      }
      assert.strictEqual(processExists, false, `Grandchild process (PID ${gcPid}) must NOT survive after sandbox termination`);
    }
  });

  // --- TEST 10: Real host file access blocking via sandbox ---
  await runTest('10. Host file access outside workspace is blocked with ERR_ACCESS_DENIED', async () => {
    if (!isNodePermissionSupported()) {
      console.log('Note: Node permission model not supported in this runtime environment, skipping permission flag assertion');
      return;
    }

    // Create a real sentinel file in host temp directory (outside candidate workspace)
    const sentinelFile = path.join(os.tmpdir(), `aegis-sentinel-${Date.now()}.txt`);
    fs.writeFileSync(sentinelFile, 'SECRET_HOST_CREDENTIAL_DATA');

    try {
      const script = `
        const fs = require('fs');
        try {
          fs.readFileSync(${JSON.stringify(sentinelFile)});
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

      assert.strictEqual(result.exitCode, 42, 'Access to host sentinel file must be denied');
      assert.ok(
        result.stderr.includes('ERR_ACCESS_DENIED'),
        `Sandbox must enforce Node permission model (received: ${result.stderr})`
      );
    } finally {
      try {
        if (fs.existsSync(sentinelFile)) fs.unlinkSync(sentinelFile);
      } catch {}
    }
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

    const vResult = await verifyTaskAcceptance({ taskId: reqTaskId, workspacePath: taskDir });
    assert.strictEqual(vResult.allPassed, true);

    const taskBefore = storage.getTaskById(reqTaskId);
    assert.ok(taskBefore.acceptedCandidateHash, 'Candidate hash must be set upon acceptance');
    assert.strictEqual(taskBefore.requirementsVersion, 1);

    // Requirements change invalidates acceptance
    const invalidated = storage.invalidateTaskAcceptance(reqTaskId, 'Product specification updated with new constraints');
    assert.strictEqual(invalidated.requirementsVersion, 2, 'Requirements version must increment');
    assert.strictEqual(invalidated.acceptedCandidateHash, undefined, 'Accepted candidate hash must be cleared');
    assert.strictEqual(invalidated.subtasks[0].completed, false, 'Criteria must be reset to pending');
  });

  // --- TEST 12: Verified content delivery rejects tampered files despite claimed matching hash ---
  await runTest('12. Delivery recomputes canonical digest and rejects altered file contents despite matching claimed hash', async () => {
    const gitRepoDir = path.join(testTempDir, 'tamper-git-repo');
    fs.mkdirSync(gitRepoDir, { recursive: true });
    spawnSync('git', ['init'], { cwd: gitRepoDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: gitRepoDir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitRepoDir });
    fs.writeFileSync(path.join(gitRepoDir, 'README.md'), '# Base\n');
    spawnSync('git', ['add', '.'], { cwd: gitRepoDir });
    spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: gitRepoDir });

    const tamperTaskId = `task-tamper-${Date.now()}`;
    const legitHash = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

    storage.insertTask({
      id: tamperTaskId,
      key: `AEG-TAMPER-${Date.now().toString().slice(-4)}`,
      title: 'Tamper test',
      status: 'review',
      acceptedCandidateHash: legitHash,
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

    storage.recordEvidence({
      taskId: tamperTaskId,
      candidateHash: legitHash,
      verifierName: 'test_verifier',
      requirementsVersion: 1,
      outcome: 'passed',
    });

    // Caller claims the exact matching hash legitHash, but passes altered/tampered file contents
    const delivRes = await GitDeliveryService.deliverToBranch(tamperTaskId, {
      repoPath: gitRepoDir,
      branchName: 'feature-tampered',
      commitMessage: 'Tampered delivery attempt',
      candidateHash: legitHash, // Matching claimed hash!
      filesToCommit: [{ relPath: 'src/hack.js', content: 'malicious altered code' }],
    });

    assert.strictEqual(delivRes.success, false, 'Delivery must be rejected when recomputed digest does not match accepted hash');
    assert.ok(
      delivRes.error?.includes('Content digest mismatch') || delivRes.error?.includes('Candidate hash mismatch'),
      `Delivery must report digest mismatch (received: ${delivRes.error})`
    );
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

    const conflictTaskId = `task-conflict-${Date.now()}`;
    const critId = `c-conf-${Date.now()}`;

    // Create candidate staging to compute canonical hash
    const stageDir = path.join(testTempDir, 'conf-stage');
    fs.mkdirSync(stageDir, { recursive: true });
    fs.writeFileSync(path.join(stageDir, 'file.txt'), 'Updated\n');
    const hash = computeCanonicalCandidateDigest(stageDir);

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

    const inFlightRun = storage.createRun({
      taskId: interTaskId,
      agentId: 'agent-inter',
      status: 'running',
      workspacePath: testTempDir,
    });

    assert.strictEqual(inFlightRun.status, 'running');

    const recoveredCount = storage.recoverInterruptedRunsOnBoot();
    assert.ok(recoveredCount >= 1, 'At least 1 in-flight run must be recovered');

    const recoveredRun = storage.getRunById(inFlightRun.id);
    assert.strictEqual(recoveredRun.status, 'interrupted', 'Run must be transitioned to interrupted');
    assert.ok(recoveredRun.error?.includes('interrupted by server restart') || recoveredRun.error?.includes('in-flight'));

    const taskAfter = storage.getTaskById(interTaskId);
    assert.strictEqual(taskAfter.status, 'blocked', 'In-progress task must be moved to blocked');
  });

  // --- TEST 16: Sandbox fail-closed availability check ---
  await runTest('16. Sandbox fails closed when unshare network namespace isolation is unavailable', async () => {
    setUnshareSupportedForTesting(false);
    try {
      const res = await runInSandbox({
        command: 'node',
        args: ['-e', 'process.exit(0)'],
        workspacePath: testTempDir,
        allowNetwork: false,
      });

      assert.strictEqual(res.exitCode, -1);
      assert.strictEqual(res.errorCode, 'execution_runtime_unavailable');
      assert.ok(res.error?.includes('Network namespace isolation unavailable'));
    } finally {
      setUnshareSupportedForTesting(null);
    }
  });

  // --- TEST 17: Sandbox network isolation check ---
  await runTest('17. Untrusted candidate execution has no host network access inside sandbox', async () => {
    if (!isUnshareSupported()) {
      console.log('Note: unshare is not supported, skipping active network isolation check');
      return;
    }

    const script = `
      const http = require('http');
      const req = http.get('http://1.1.1.1:80', (res) => {
        process.stdout.write('CONNECTED');
        process.exit(0);
      });
      req.on('error', (err) => {
        process.stderr.write('NETWORK_BLOCKED: ' + (err.code || err.message));
        process.exit(77);
      });
      req.setTimeout(2000, () => {
        req.destroy();
        process.stderr.write('TIMEOUT_BLOCKED');
        process.exit(77);
      });
    `;

    const res = await runInSandbox({
      command: 'node',
      args: ['-e', script],
      workspacePath: testTempDir,
      allowNetwork: false,
      timeoutMs: 4000,
    });

    assert.strictEqual(res.exitCode, 77, 'Network request inside sandbox must be blocked');
    assert.ok(!res.stdout.includes('CONNECTED'), 'Must not connect to network');
  });

  // --- TEST 18: Verifier independence check ---
  await runTest('18. Worker process.exit(0) mock cannot defeat independent server-owned trusted suite', async () => {
    const indepTaskId = `task-indep-${Date.now()}`;
    const wsDir = path.join(testTempDir, 'indep-workspace');
    fs.mkdirSync(wsDir, { recursive: true });

    // Worker implements candidate code that violates specification:
    fs.writeFileSync(path.join(wsDir, 'implementation.cjs'), 'module.exports = { isSecure: false };');

    // Worker attempts to forge a test in its own workspace that immediately exits 0!
    fs.writeFileSync(path.join(wsDir, 'spec.test.cjs'), 'process.exit(0);');

    // Server-owned trusted test script outside the worker workspace
    const trustedDir = path.resolve(getAegisDataDir(), 'trusted_suites', indepTaskId);
    fs.mkdirSync(trustedDir, { recursive: true });
    const trustedScript = path.join(trustedDir, 'crit-indep.test.cjs');
    fs.writeFileSync(trustedScript, `
      const assert = require('assert');
      const candidate = require('${path.join(wsDir, 'implementation.cjs')}');
      assert.strictEqual(candidate.isSecure, true, 'Candidate must be secure!');
    `);

    try {
      storage.insertTask({
        id: indepTaskId,
        key: `AEG-INDEP-${Date.now().toString().slice(-4)}`,
        title: 'Independent check task',
        status: 'in_progress',
        subtasks: [
          {
            id: 'crit-indep',
            title: 'Verify security property',
            verificationMethod: 'trusted_test',
            verificationSpec: { trustedScriptPath: trustedScript },
          },
        ],
      });

      const evalRes = await verifyTaskAcceptance({
        taskId: indepTaskId,
        workspacePath: wsDir,
      });

      assert.strictEqual(evalRes.allPassed, false, 'Acceptance must fail because trusted check caught defect');
      assert.strictEqual(evalRes.results[0].passed, false);
      assert.ok(
        evalRes.results[0].failureReason?.includes('Candidate must be secure') ||
        evalRes.results[0].failureReason?.includes('AssertionError'),
        'Failure reason must reflect independent verifier assertion failure'
      );
    } finally {
      try {
        if (fs.existsSync(trustedDir)) fs.rmSync(trustedDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // --- TEST 19: Remote Git delivery ---
  await runTest('19. Remote Git delivery returns truthful blocked when unconfigured, delivers to test remote', async () => {
    const remTaskId = `task-rem-${Date.now()}`;
    const wsDir = path.join(testTempDir, 'rem-workspace');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'implementation.js'), 'module.exports = { rem: true };\n');
    const hash = computeCanonicalCandidateDigest(wsDir);

    storage.insertTask({
      id: remTaskId,
      key: `AEG-REM-${Date.now().toString().slice(-4)}`,
      title: 'Remote delivery task',
      status: 'review',
      acceptedCandidateHash: hash,
      requirementsVersion: 1,
      subtasks: [{ id: 'c-rem', title: 'Remote test', verificationMethod: 'trusted_test' }],
    });

    storage.recordEvidence({
      taskId: remTaskId,
      criterionId: 'c-rem',
      candidateHash: hash,
      verifierName: 'verifier',
      requirementsVersion: 1,
      outcome: 'passed',
    });

    // 1. Unconfigured remote URL / missing auth token -> fail closed with blocked: true
    const unconfRes = await GitDeliveryService.deliverToRemote(remTaskId, {
      repoUrl: 'https://github.com/acme/private-repo.git',
      branchName: 'aegis/remote-test',
      apiToken: '', // Unconfigured!
    });
    assert.strictEqual(unconfRes.success, false);
    assert.strictEqual(unconfRes.blocked, true);
    assert.ok(unconfRes.error?.includes('remote_git_not_configured'));

    // 2. Deliver to real test bare remote via branch_push
    const bareRemoteDir = path.join(testTempDir, 'test-remote.git');
    spawnSync('git', ['init', '--bare', bareRemoteDir]);

    // Snapshot candidate to server candidates store
    const candDir = path.resolve(getAegisDataDir(), 'candidates', remTaskId, hash);
    fs.mkdirSync(candDir, { recursive: true });
    fs.writeFileSync(path.join(candDir, 'implementation.js'), 'module.exports = { rem: true };\n');

    // Seed bare remote with initial commit on main
    const seedDir = path.join(testTempDir, 'seed');
    spawnSync('git', ['init', '-b', 'main', seedDir]);
    spawnSync('git', ['config', 'user.name', 'Seed'], { cwd: seedDir });
    spawnSync('git', ['config', 'user.email', 'seed@example.com'], { cwd: seedDir });
    fs.writeFileSync(path.join(seedDir, 'README.md'), '# Seed\n');
    spawnSync('git', ['add', '.'], { cwd: seedDir });
    spawnSync('git', ['commit', '-m', 'Initial seed'], { cwd: seedDir });
    spawnSync('git', ['remote', 'add', 'origin', bareRemoteDir], { cwd: seedDir });
    const pushRes = spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: seedDir });
    assert.strictEqual(pushRes.status, 0, `Seed push to bare remote must succeed: ${pushRes.stderr}`);

    const headRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: seedDir, encoding: 'utf8' });
    const seedBaseCommit = headRes.stdout.trim();
    const curTask = storage.getTaskById(remTaskId);
    storage.updateTaskWithRevision(remTaskId, curTask.version, {
      acceptedBaseCommit: seedBaseCommit,
    });

    // Update evidence with baseCommit
    storage.recordEvidence({
      taskId: remTaskId,
      criterionId: 'c-rem',
      baseCommit: seedBaseCommit,
      candidateHash: hash,
      verifierName: 'verifier',
      requirementsVersion: 1,
      outcome: 'passed',
    });

    const remoteDelivRes = await GitDeliveryService.deliverToRemote(remTaskId, {
      repoUrl: bareRemoteDir,
      branchName: 'aegis/remote-feature',
      commitMessage: 'Verified remote delivery',
      deliveryMode: 'branch_push',
    });

    assert.strictEqual(remoteDelivRes.success, true, `Remote delivery must succeed: ${remoteDelivRes.error}`);
    assert.ok(remoteDelivRes.commitHash, 'Must generate valid commit hash');
    assert.strictEqual(remoteDelivRes.prUrl, undefined, 'Must not fabricate PR URL for branch_push');

    // Verify branch exists in the bare remote
    const checkHeads = spawnSync('git', ['ls-remote', '--heads', bareRemoteDir, 'aegis/remote-feature'], { encoding: 'utf8' });
    assert.ok(checkHeads.stdout.includes('refs/heads/aegis/remote-feature'), 'Delivered branch must exist on remote');

    // 3. PR creation on remote fails closed without token and does not invent fake PRs
    const prUnauthRes = await GitDeliveryService.deliverToRemote(remTaskId, {
      repoUrl: 'https://github.com/acme-org/repo.git',
      branchName: 'aegis/remote-pr-check',
      deliveryMode: 'pull_request',
    });
    assert.strictEqual(prUnauthRes.success, false, 'PR delivery without token must fail');
    assert.strictEqual(prUnauthRes.blocked, true, 'PR delivery without token must be blocked');
    assert.ok(prUnauthRes.error?.includes('API token'), 'Error must explicitly require API token');
  });

  // --- TEST 20: Symlink sensitivity in candidate tree digest ---
  await runTest('20. Canonical candidate digest incorporates symlinks and detects symlink mutations', async () => {
    const symlinkDir = path.join(testTempDir, 'symlink-test-tree');
    fs.mkdirSync(path.join(symlinkDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(symlinkDir, 'src/target-a.js'), 'console.log("target A");\n');
    fs.writeFileSync(path.join(symlinkDir, 'src/target-b.js'), 'console.log("target B");\n');

    const digestBase = computeCanonicalCandidateDigest(symlinkDir);

    // Create a symlink pointing to target-a.js
    const symlinkPath = path.join(symlinkDir, 'src/link.js');
    fs.symlinkSync('target-a.js', symlinkPath);

    const digestWithSymlinkA = computeCanonicalCandidateDigest(symlinkDir);
    assert.notStrictEqual(digestWithSymlinkA, digestBase, 'Digest must change when a symlink is added');

    // Retarget symlink to target-b.js
    fs.unlinkSync(symlinkPath);
    fs.symlinkSync('target-b.js', symlinkPath);

    const digestWithSymlinkB = computeCanonicalCandidateDigest(symlinkDir);
    assert.notStrictEqual(digestWithSymlinkB, digestWithSymlinkA, 'Digest must change when symlink target changes');
  });

  // --- TEST 21: Rejection of worker-writable workspace test fallbacks ---
  await runTest('21. Acceptance engine rejects worker-writable workspace tests when no server-owned suite exists', async () => {
    const rogueTaskId = `task-rogue-${Date.now()}`;
    const rogueCritId = `crit-rogue-${Date.now()}`;
    const rogueWs = path.join(testTempDir, 'rogue-ws');
    fs.mkdirSync(rogueWs, { recursive: true });

    // Worker creates a passing test in its own workspace to try certifying acceptance
    fs.writeFileSync(path.join(rogueWs, 'spec.test.cjs'), 'console.log("PASS"); process.exit(0);');
    fs.writeFileSync(path.join(rogueWs, 'index.js'), 'module.exports = {};');

    storage.insertTask({
      id: rogueTaskId,
      key: `ROGUE-1`,
      title: 'Untrusted Task',
      description: 'Attempting to pass via workspace test',
      status: 'todo',
      priority: 'medium',
      assignedAgentId: 'agent-dev',
      estimatedHours: 1,
      spentHours: 0,
      dependencies: [],
      subtasks: [{ id: rogueCritId, title: 'Rogue criterion', verificationMethod: 'trusted_test' }],
    });

    storage.insertCriterion({
      id: rogueCritId,
      taskId: rogueTaskId,
      title: 'Rogue criterion',
      verificationMethod: 'trusted_test',
      status: 'pending',
    });

    // Run verification - NO trusted suite installed in data/trusted_suites/
    const verdict = await verifyTaskAcceptance({
      taskId: rogueTaskId,
      workspacePath: rogueWs,
    });

    assert.strictEqual(verdict.allPassed, false, 'Acceptance must be rejected');
    assert.ok(!storage.getTaskById(rogueTaskId).acceptedCandidateHash, 'acceptedCandidateHash must remain null');
    assert.ok(verdict.results[0].failureReason?.includes('No server-owned trusted suite'), 'Must explicitly fail closed');
  });

  // --- TEST 22: Remote delivery fails closed when candidate snapshot is missing ---
  await runTest('22. Remote delivery fails closed when server-owned snapshot is missing (no workspace fallback)', async () => {
    const missingSnapTaskId = `task-nosnap-${Date.now()}`;
    const fakeHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    storage.insertTask({
      id: missingSnapTaskId,
      key: 'NOSNAP-1',
      title: 'Task without snapshot',
      description: 'Snapshot was deleted or never stored',
      status: 'review',
      priority: 'high',
      assignedAgentId: 'agent-dev',
      estimatedHours: 2,
      spentHours: 0,
      dependencies: [],
      acceptedCandidateHash: fakeHash,
      acceptedBaseCommit: '1234567890abcdef1234567890abcdef12345678',
      subtasks: [],
    });

    // Create a mutable workspace with files to test if deliverToRemote would fall back to it
    const mutableWs = path.resolve(process.cwd(), 'workspace', 'NOSNAP-1');
    fs.mkdirSync(mutableWs, { recursive: true });
    fs.writeFileSync(path.join(mutableWs, 'rogue.js'), 'module.exports = "unverified workspace code";');

    try {
      const delivRes = await GitDeliveryService.deliverToRemote(missingSnapTaskId, {
        repoUrl: 'https://github.com/acme/repo.git',
        branchName: 'aegis/nosnap-test',
        deliveryMode: 'branch_push',
        apiToken: 'fake-token',
      });

      assert.strictEqual(delivRes.success, false, 'Delivery must fail when snapshot is missing');
      assert.strictEqual(delivRes.blocked, true, 'Delivery must be blocked');
      assert.ok(
        delivRes.error?.includes('No server-owned candidate snapshot found'),
        `Error must specify missing candidate snapshot (got: ${delivRes.error})`
      );
    } finally {
      try {
        fs.rmSync(mutableWs, { recursive: true, force: true });
      } catch {}
    }
  });

  // --- TEST 23: Model failure cannot trigger scripted repair ---
  await runTest('23. Model failure cannot trigger scripted repair or fallback implementations', async () => {
    const taskId = `task-fail-model-${Date.now()}`;
    const ws = path.join(testTempDir, 'fail-model-ws');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'src.js'), '// broken code\nmodule.exports = null;\n');

    storage.insertTask({
      id: taskId,
      key: `FAIL-MOD-1`,
      title: 'Failing Model Task',
      description: 'Model produces broken code',
      status: 'in_progress',
      subtasks: [{ id: `crit-fm-1`, title: 'Must export valid object', verificationMethod: 'trusted_test' }],
    });

    storage.insertCriterion({
      id: `crit-fm-1`,
      taskId,
      title: 'Must export valid object',
      verificationMethod: 'trusted_test',
      status: 'pending',
    });

    // Install server-owned spec that requires module.exports to be an object with foo
    const trustedDir = path.resolve(getAegisDataDir(), 'trusted_suites', taskId);
    fs.mkdirSync(trustedDir, { recursive: true });
    fs.writeFileSync(path.join(trustedDir, 'spec.test.cjs'), `
      const assert = require('assert');
      const mod = require('${path.join(ws, 'src.js')}');
      assert.ok(mod && typeof mod.foo === 'string', 'mod.foo must be string');
      process.exit(0);
    `);

    // Verify candidate
    const verdict = await verifyTaskAcceptance({ taskId, workspacePath: ws });
    assert.strictEqual(verdict.allPassed, false, 'Acceptance must fail on broken model candidate');

    // Confirm that no scripted repair has modified the workspace
    const content = fs.readFileSync(path.join(ws, 'src.js'), 'utf8');
    assert.strictEqual(content, '// broken code\nmodule.exports = null;\n', 'Workspace must not have hardcoded repair injected');
    assert.ok(!storage.getTaskById(taskId).acceptedCandidateHash, 'acceptedCandidateHash must remain null');
  });

  // --- TEST 24: Exhausted correction budgets cannot become successful evaluation ---
  await runTest('24. Exhausted correction budgets cannot become successful evaluation', async () => {
    const taskId = `task-budget-${Date.now()}`;
    const ws = path.join(testTempDir, 'budget-ws');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'app.js'), 'module.exports = false;');

    storage.insertTask({
      id: taskId,
      key: `BUDGET-1`,
      title: 'Budget Exhaustion Test',
      description: 'Task with exhausted attempts',
      status: 'in_progress',
      subtasks: [{ id: `crit-bd-1`, title: 'Must return true', verificationMethod: 'trusted_test' }],
    });

    storage.insertCriterion({
      id: `crit-bd-1`,
      taskId,
      title: 'Must return true',
      verificationMethod: 'trusted_test',
      status: 'pending',
    });

    const trustedDir = path.resolve(getAegisDataDir(), 'trusted_suites', taskId);
    fs.mkdirSync(trustedDir, { recursive: true });
    fs.writeFileSync(path.join(trustedDir, 'spec.test.cjs'), `
      const assert = require('assert');
      const res = require('${path.join(ws, 'app.js')}');
      assert.strictEqual(res, true);
      process.exit(0);
    `);

    // Run bounded correction loop with maxAttempts = 1 and worker returning non-solution
    const dummyWorker = {
      executeTask: async () => ({
        status: 'completed' as const,
        summary: 'attempted fix but failed',
        modifiedFiles: ['app.js'],
        turnsUsed: 1,
        tokensUsed: 0,
        toolHistory: [],
      }),
    };

    const result = await runBoundedCorrectionLoop(
      taskId,
      'agent-dev',
      dummyWorker,
      {
        workspacePath: ws,
        maxAttempts: 1,
      }
    );

    assert.strictEqual(result.accepted, false, 'Exhausted loop must return accepted: false');
    assert.strictEqual(result.attemptsUsed, 1, 'Attempts must match maxAttempts budget');
    const taskAfter = storage.getTaskById(taskId);
    assert.ok(!taskAfter.acceptedCandidateHash, 'Task candidate hash must remain empty');
    assert.notStrictEqual(taskAfter.status, 'done', 'Task must NOT be marked done');
  });

  // --- TEST 25: Tampered snapshot contents are rejected even when directory and claimed hash are unchanged ---
  await runTest('25. Tampered snapshot contents are rejected even when directory and claimed hash are unchanged', async () => {
    const taskId = `task-tamper-${Date.now()}`;
    const ws = path.join(testTempDir, 'tamper-ws');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'valid.js'), 'console.log("valid candidate");\n');

    storage.insertTask({
      id: taskId,
      key: `TAMPER-1`,
      title: 'Tamper Snapshot Test',
      status: 'in_progress',
      subtasks: [{ id: `crit-tmp-1`, title: 'Must exist', verificationMethod: 'trusted_test' }],
    });

    storage.insertCriterion({
      id: `crit-tmp-1`,
      taskId,
      title: 'Must exist',
      verificationMethod: 'trusted_test',
      status: 'pending',
    });

    const trustedDir = path.resolve(getAegisDataDir(), 'trusted_suites', taskId);
    fs.mkdirSync(trustedDir, { recursive: true });
    fs.writeFileSync(path.join(trustedDir, 'spec.test.cjs'), `process.exit(0);`);

    // Legitimate acceptance creates snapshot
    const acceptRes = await verifyTaskAcceptance({
      taskId,
      baseCommit: '1234567890abcdef1234567890abcdef12345678',
      workspacePath: ws,
    });
    assert.strictEqual(acceptRes.allPassed, true);
    const originalHash = acceptRes.candidateHash;

    const snapshotDir = path.resolve(getAegisDataDir(), 'candidates', taskId, originalHash);
    assert.ok(fs.existsSync(snapshotDir), 'Snapshot directory must exist');

    // Tamper with file INSIDE snapshot directory without renaming directory or changing task.acceptedCandidateHash
    fs.writeFileSync(path.join(snapshotDir, 'valid.js'), 'console.log("TAMPERED CONTENT IN SNAPSHOT");\n');

    // Attempt delivery to remote
    const delivRes = await GitDeliveryService.deliverToRemote(taskId, {
      repoUrl: 'https://github.com/acme/repo.git',
      branchName: 'aegis/tamper-test',
      deliveryMode: 'branch_push',
      apiToken: 'test-token',
    });

    assert.strictEqual(delivRes.success, false, 'Delivery must fail on tampered snapshot');
    assert.strictEqual(delivRes.blocked, true, 'Delivery must be blocked');
    assert.ok(delivRes.error?.includes('Candidate snapshot tampering detected'), `Must detect tampering: ${delivRes.error}`);
  });

  // --- TEST 26: Missing or stale evidence blocks remote delivery ---
  await runTest('26. Missing or stale evidence blocks remote delivery', async () => {
    const taskId = `task-stale-${Date.now()}`;
    const ws = path.join(testTempDir, 'stale-ws');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'app.js'), 'console.log("ok");');

    storage.insertTask({
      id: taskId,
      key: `STALE-1`,
      title: 'Stale Evidence Test',
      status: 'in_progress',
      subtasks: [
        { id: `crit-st-1`, title: 'Crit 1', verificationMethod: 'trusted_test' },
        { id: `crit-st-2`, title: 'Crit 2', verificationMethod: 'trusted_test' },
      ],
    });

    storage.insertCriterion({ id: `crit-st-1`, taskId, title: 'Crit 1', verificationMethod: 'trusted_test', status: 'pending' });
    storage.insertCriterion({ id: `crit-st-2`, taskId, title: 'Crit 2', verificationMethod: 'trusted_test', status: 'pending' });

    const trustedDir = path.resolve(getAegisDataDir(), 'trusted_suites', taskId);
    fs.mkdirSync(trustedDir, { recursive: true });
    fs.writeFileSync(path.join(trustedDir, 'spec.test.cjs'), `process.exit(0);`);

    const acceptRes = await verifyTaskAcceptance({
      taskId,
      baseCommit: '1234567890abcdef1234567890abcdef12345678',
      workspacePath: ws,
    });
    assert.strictEqual(acceptRes.allPassed, true);

    // Bump requirements_version on task to make evidence stale
    const currentTask = storage.getTaskById(taskId);
    storage.updateTaskWithRevision(taskId, currentTask.version, {
      requirementsVersion: 2, // was 1 during acceptance
    });

    // Attempt delivery to remote
    const delivRes = await GitDeliveryService.deliverToRemote(taskId, {
      repoUrl: 'https://github.com/acme/repo.git',
      branchName: 'aegis/stale-test',
      deliveryMode: 'branch_push',
      apiToken: 'test-token',
    });

    assert.strictEqual(delivRes.success, false, 'Delivery must fail on stale evidence');
    assert.strictEqual(delivRes.blocked, true, 'Delivery must be blocked');
    assert.ok(delivRes.error?.includes('is stale'), `Must report stale evidence: ${delivRes.error}`);
  });

  // --- TEST 27: Materialization preserves binary bytes, executable modes, symlinks, and deletions ---
  await runTest('27. Materialization preserves binary bytes, executable modes, symlinks, and deletions', async () => {
    const srcTree = path.join(testTempDir, 'mat-src');
    const targetWt = path.join(testTempDir, 'mat-wt');
    fs.mkdirSync(srcTree, { recursive: true });
    fs.mkdirSync(targetWt, { recursive: true });

    // Initialize git repo in targetWt so git ls-files works for baseline deletions
    spawnSync('git', ['init'], { cwd: targetWt });
    spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: targetWt });
    spawnSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: targetWt });

    // Track a baseline file that SHOULD BE DELETED by candidate materialization
    fs.writeFileSync(path.join(targetWt, 'obsolete.txt'), 'to be deleted\n');
    spawnSync('git', ['add', '.'], { cwd: targetWt });
    spawnSync('git', ['commit', '-m', 'Baseline'], { cwd: targetWt });

    // 1. Raw binary bytes
    const binaryData = crypto.randomBytes(512);
    fs.writeFileSync(path.join(srcTree, 'binary.dat'), binaryData);

    // 2. Executable script (mode 0755)
    fs.writeFileSync(path.join(srcTree, 'script.sh'), '#!/bin/sh\necho "hello"\n');
    fs.chmodSync(path.join(srcTree, 'script.sh'), 0o755);

    // 3. Normal file (mode 0644)
    fs.writeFileSync(path.join(srcTree, 'normal.txt'), 'hello world\n');
    fs.chmodSync(path.join(srcTree, 'normal.txt'), 0o644);

    // 4. Symbolic link
    fs.symlinkSync('normal.txt', path.join(srcTree, 'link-to-normal.txt'));

    // Materialize into worktree
    const matRes = await materializeCandidateToWorktree(srcTree, targetWt);
    assert.strictEqual(matRes.success, true, `Materialization must succeed: ${matRes.error}`);

    // Verify binary bytes
    const readBinary = fs.readFileSync(path.join(targetWt, 'binary.dat'));
    assert.strictEqual(Buffer.compare(binaryData, readBinary), 0, 'Binary bytes must match exactly');

    // Verify executable mode (0755)
    const scriptStat = fs.statSync(path.join(targetWt, 'script.sh'));
    assert.ok((scriptStat.mode & 0o111) !== 0, 'Executable bit must be preserved');

    // Verify normal file mode (0644)
    const normalStat = fs.statSync(path.join(targetWt, 'normal.txt'));
    assert.strictEqual((normalStat.mode & 0o111) === 0, true, 'Normal file must not be executable');

    // Verify symlink
    const linkLstat = fs.lstatSync(path.join(targetWt, 'link-to-normal.txt'));
    assert.ok(linkLstat.isSymbolicLink(), 'Target must be a symbolic link');
    assert.strictEqual(fs.readlinkSync(path.join(targetWt, 'link-to-normal.txt')), 'normal.txt');

    // Verify deletion relative to baseline: obsolete.txt must be removed!
    assert.strictEqual(fs.existsSync(path.join(targetWt, 'obsolete.txt')), false, 'Obsolete file must be deleted');
  });

  // --- TEST 28: The committed and remotely published tree equals the accepted tree ---
  await runTest('28. The committed and remotely published tree equals the accepted tree', async () => {
    const treeWs = path.join(testTempDir, 'tree-ws');
    const repoDir = path.join(testTempDir, 'tree-repo');
    fs.mkdirSync(path.join(treeWs, 'src'), { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });

    spawnSync('git', ['init'], { cwd: repoDir });
    spawnSync('git', ['config', 'user.name', 'Author'], { cwd: repoDir });
    spawnSync('git', ['config', 'user.email', 'author@example.com'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Base Repo\n');
    spawnSync('git', ['add', '.'], { cwd: repoDir });
    spawnSync('git', ['commit', '-m', 'Initial'], { cwd: repoDir });
    const headRes = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' });
    const baseCommit = headRes.stdout.trim();

    // Prepare candidate files in workspace
    fs.writeFileSync(path.join(treeWs, 'src/math.js'), 'module.exports = { add: (a, b) => a + b };\n');
    fs.writeFileSync(path.join(treeWs, 'README.md'), '# Base Repo with Math\n');

    const expectedTreeHash = computeCanonicalCandidateDigest(treeWs);

    const taskId = `task-tree-${Date.now()}`;
    storage.insertTask({
      id: taskId,
      key: `TREE-1`,
      title: 'Tree Equality Task',
      status: 'in_progress',
      subtasks: [{ id: `crit-tr-1`, title: 'Crit 1', verificationMethod: 'trusted_test' }],
    });
    storage.insertCriterion({ id: `crit-tr-1`, taskId, title: 'Crit 1', verificationMethod: 'trusted_test', status: 'pending' });

    const trustedDir = path.resolve(getAegisDataDir(), 'trusted_suites', taskId);
    fs.mkdirSync(trustedDir, { recursive: true });
    fs.writeFileSync(path.join(trustedDir, 'spec.test.cjs'), `process.exit(0);`);

    const acceptRes = await verifyTaskAcceptance({ taskId, baseCommit, workspacePath: treeWs });
    assert.strictEqual(acceptRes.allPassed, true);
    assert.strictEqual(acceptRes.candidateHash, expectedTreeHash);

    // Deliver to local branch
    const branchName = 'aegis/tree-test-branch';
    const delivRes = await GitDeliveryService.deliverToBranch(taskId, {
      repoPath: repoDir,
      branchName,
      commitMessage: 'Verify committed tree equals accepted candidate',
      candidateHash: expectedTreeHash,
    });
    assert.strictEqual(delivRes.success, true);

    // Checkout the delivered branch in repoDir and verify tree hash
    spawnSync('git', ['checkout', branchName], { cwd: repoDir });
    const committedTreeHash = computeCanonicalCandidateDigest(repoDir);
    assert.strictEqual(committedTreeHash, expectedTreeHash, 'Committed tree hash must match accepted tree hash exactly');
  });

  // --- TEST 29: Base drift invalidates delivery authorization ---
  await runTest('29. Base drift invalidates delivery authorization', async () => {
    const driftRepo = path.join(testTempDir, 'drift-repo');
    const driftBare = path.join(testTempDir, 'drift-bare.git');
    const driftWs = path.join(testTempDir, 'drift-ws');
    fs.mkdirSync(driftRepo, { recursive: true });
    fs.mkdirSync(driftWs, { recursive: true });

    spawnSync('git', ['init', '-b', 'main'], { cwd: driftRepo });
    spawnSync('git', ['config', 'user.name', 'Author'], { cwd: driftRepo });
    spawnSync('git', ['config', 'user.email', 'author@example.com'], { cwd: driftRepo });
    fs.writeFileSync(path.join(driftRepo, 'file.txt'), 'v1\n');
    spawnSync('git', ['add', '.'], { cwd: driftRepo });
    spawnSync('git', ['commit', '-m', 'Commit C1'], { cwd: driftRepo });

    const c1Res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: driftRepo, encoding: 'utf8' });
    const c1Commit = c1Res.stdout.trim();

    spawnSync('git', ['init', '--bare', driftBare]);
    spawnSync('git', ['remote', 'add', 'origin', driftBare], { cwd: driftRepo });
    spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: driftRepo });

    // Accept candidate against C1 base commit
    fs.writeFileSync(path.join(driftWs, 'file.txt'), 'v1-candidate\n');
    const taskId = `task-drift-${Date.now()}`;
    storage.insertTask({
      id: taskId,
      key: `DRIFT-1`,
      title: 'Drift Test',
      status: 'in_progress',
      subtasks: [{ id: `crit-df-1`, title: 'Crit 1', verificationMethod: 'trusted_test' }],
    });
    storage.insertCriterion({ id: `crit-df-1`, taskId, title: 'Crit 1', verificationMethod: 'trusted_test', status: 'pending' });

    const trustedDir = path.resolve(getAegisDataDir(), 'trusted_suites', taskId);
    fs.mkdirSync(trustedDir, { recursive: true });
    fs.writeFileSync(path.join(trustedDir, 'spec.test.cjs'), `process.exit(0);`);

    const acceptRes = await verifyTaskAcceptance({ taskId, baseCommit: c1Commit, workspacePath: driftWs });
    assert.strictEqual(acceptRes.allPassed, true);

    // ADVANCE remote repository default branch to Commit C2 (simulating upstream change)
    fs.writeFileSync(path.join(driftRepo, 'drift.txt'), 'new work pushed upstream\n');
    spawnSync('git', ['add', '.'], { cwd: driftRepo });
    spawnSync('git', ['commit', '-m', 'Commit C2 (upstream advance)'], { cwd: driftRepo });
    spawnSync('git', ['push', 'origin', 'main'], { cwd: driftRepo });

    // Attempt remote delivery
    const remoteRes = await GitDeliveryService.deliverToRemote(taskId, {
      repoUrl: driftBare,
      branchName: 'aegis/drift-branch',
      deliveryMode: 'branch_push',
    });

    assert.strictEqual(remoteRes.success, false, 'Delivery must fail when remote base has drifted');
    assert.strictEqual(remoteRes.blocked, true, 'Delivery must be blocked');
    assert.strictEqual(remoteRes.branchPublished, false, 'Branch must not be published on drifted base');
    assert.ok(remoteRes.error?.includes('Remote base drift detected'), `Must report base drift: ${remoteRes.error}`);
  });

  // --- TEST 30: PR failure after branch publication can be retried without duplicate publication or fabricated success ---
  await runTest('30. PR failure after branch publication can be retried without duplicate publication or fabricated success', async () => {
    const prRepo = path.join(testTempDir, 'pr-repo');
    const prBare = path.join(testTempDir, 'pr-bare.git');
    const prWs = path.join(testTempDir, 'pr-ws');
    fs.mkdirSync(prRepo, { recursive: true });
    fs.mkdirSync(prWs, { recursive: true });

    spawnSync('git', ['init', '-b', 'main'], { cwd: prRepo });
    spawnSync('git', ['config', 'user.name', 'Author'], { cwd: prRepo });
    spawnSync('git', ['config', 'user.email', 'author@example.com'], { cwd: prRepo });
    fs.writeFileSync(path.join(prRepo, 'README.md'), '# PR Repo\n');
    spawnSync('git', ['add', '.'], { cwd: prRepo });
    spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: prRepo });
    const rev = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: prRepo, encoding: 'utf8' }).stdout.trim();

    spawnSync('git', ['init', '--bare', prBare]);
    spawnSync('git', ['remote', 'add', 'origin', prBare], { cwd: prRepo });
    spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: prRepo });

    fs.writeFileSync(path.join(prWs, 'feature.js'), 'module.exports = "feature";\n');
    const taskId = `task-pr-retry-${Date.now()}`;
    storage.insertTask({
      id: taskId,
      key: `PR-RETRY-1`,
      title: 'PR Retry Test',
      status: 'in_progress',
      subtasks: [{ id: `crit-pr-1`, title: 'Crit 1', verificationMethod: 'trusted_test' }],
    });
    storage.insertCriterion({ id: `crit-pr-1`, taskId, title: 'Crit 1', verificationMethod: 'trusted_test', status: 'pending' });

    const trustedDir = path.resolve(getAegisDataDir(), 'trusted_suites', taskId);
    fs.mkdirSync(trustedDir, { recursive: true });
    fs.writeFileSync(path.join(trustedDir, 'spec.test.cjs'), `process.exit(0);`);

    const acceptRes = await verifyTaskAcceptance({ taskId, baseCommit: rev, workspacePath: prWs });
    assert.strictEqual(acceptRes.allPassed, true);

    const branchName = 'aegis/pr-retry-branch';

    // 1. Deliver to remote via branch_push to simulate branch publication
    const pubRes = await GitDeliveryService.deliverToRemote(taskId, {
      repoUrl: prBare,
      branchName,
      deliveryMode: 'branch_push',
    });
    assert.strictEqual(pubRes.success, true);
    assert.strictEqual(pubRes.branchPublished, true);

    // 2. Retry remote delivery with deliveryMode: 'pull_request' on bare remote
    const retryRes = await GitDeliveryService.deliverToRemote(taskId, {
      repoUrl: prBare,
      branchName,
      deliveryMode: 'pull_request',
    });

    // Reuses the verified published branch, does not fail with branch conflict, and truthfully reports unsupported PR platform
    assert.strictEqual(retryRes.branchPublished, true, 'Branch was already published and reused');
    assert.strictEqual(retryRes.prCreated, false, 'PR was not created');
    assert.strictEqual(retryRes.prUrl, undefined, 'Must not invent fake PR URL');
    assert.ok(!retryRes.error?.includes('Remote branch conflict'), 'Must reuse existing branch without branch conflict error');
  });

  // --- TEST 31: Evaluation uses actual lifecycle commands and cannot directly bypass acceptance ---
  await runTest('31. Evaluation uses actual lifecycle commands and cannot directly bypass acceptance', () => {
    const taskId = `task-life-${Date.now()}`;
    const unverifiedTask = {
      id: taskId,
      key: `LIFE-1`,
      title: 'Lifecycle Bypass Attempt',
      status: 'in_progress' as const,
      subtasks: [{ id: `crit-lf-1`, title: 'Unverified subtask', completed: false }],
      dependencies: [],
      deliverables: [],
    };
    coordinator.getState().tasks.push(unverifiedTask as any);

    // Attempt direct transition to 'done' without passing acceptance quality gates
    const transRes = coordinator.transitionTaskStatus(taskId, 'done');
    assert.strictEqual(transRes.success, false, 'Transition to done must be rejected');
    assert.ok(transRes.error?.includes('Quality gates failed'), 'Must fail quality gates');
    assert.notStrictEqual(coordinator.getState().tasks.find((t) => t.id === taskId)?.status, 'done');
  });

  // --- TEST 32: Test execution leaves production state unchanged ---
  await runTest('32. Test execution leaves production state unchanged', () => {
    // 1. Capture production tasks and state
    const prodTasksBefore = storage.getAllTasks().map((t: any) => t.id).sort();

    // 2. Spin up an isolated temporary database for test execution
    const tempDb = path.join(os.tmpdir(), `test-isolated-${Date.now()}.db`);
    StorageEngine.resetInstance(tempDb);

    // 3. Perform arbitrary state mutations in isolated database
    storage.insertTask({
      id: `task-temp-only-${Date.now()}`,
      key: `TEMP-1`,
      title: 'Temporary Task',
      status: 'in_progress',
      subtasks: [],
    });
    assert.strictEqual(storage.getAllTasks().length, 1);
    assert.strictEqual(storage.getTaskByKey('TEMP-1')?.id.startsWith('task-temp-only-'), true);

    // 4. Reset back to production database
    StorageEngine.resetInstance();

    // 5. Verify production DB contains none of the temporary records and task list is completely unchanged
    const prodTasksAfter = storage.getAllTasks().map((t: any) => t.id).sort();
    assert.deepStrictEqual(prodTasksAfter, prodTasksBefore, 'Production tasks list must be completely unchanged');
    assert.strictEqual(storage.getTaskByKey('TEMP-1'), null);
  });

  // --- TEST 33: Explicit null in updateTaskWithRevision clears acceptedCandidateHash and acceptedBaseCommit ---
  await runTest('33. Explicit null in updateTaskWithRevision clears acceptedCandidateHash and acceptedBaseCommit', () => {
    const taskId = `task-clear-acceptance-${Date.now()}`;
    const initialHash = 'a'.repeat(64);
    const initialBase = 'b'.repeat(40);

    storage.insertTask({
      id: taskId,
      key: `CLR-1`,
      title: 'Clear Acceptance Test',
      status: 'review',
      acceptedCandidateHash: initialHash,
      acceptedBaseCommit: initialBase,
      subtasks: [],
    });

    const inserted = storage.getTaskById(taskId);
    assert.strictEqual(inserted.acceptedCandidateHash, initialHash);
    assert.strictEqual(inserted.acceptedBaseCommit, initialBase);

    // Update with revision passing explicit nulls
    const updateRes = storage.updateTaskWithRevision(taskId, inserted.version, {
      acceptedCandidateHash: null,
      acceptedBaseCommit: null,
      status: 'in_progress',
    });

    assert.strictEqual(updateRes.success, true);
    const updated = storage.getTaskById(taskId);
    assert.strictEqual(updated.acceptedCandidateHash, undefined, 'acceptedCandidateHash must be cleared (null/undefined)');
    assert.strictEqual(updated.acceptedBaseCommit, undefined, 'acceptedBaseCommit must be cleared (null/undefined)');
    assert.strictEqual(updated.status, 'in_progress');
  });

  // --- TEST 34: Remote delivery fails closed when accepted base commit is missing or remote branch is missing ---
  await runTest('34. Remote delivery fails closed when acceptedBaseCommit is missing or remote branch is missing', async () => {
    const taskId = `task-remote-failclosed-${Date.now()}`;
    const hash = 'c'.repeat(64);

    storage.insertTask({
      id: taskId,
      key: `RFC-1`,
      title: 'Remote Fail Closed Test',
      status: 'in_progress',
      acceptedCandidateHash: hash,
      // acceptedBaseCommit deliberately omitted!
      subtasks: [{ id: `crit-rfc-1`, title: 'Crit 1', verificationMethod: 'trusted_test' }],
    });
    storage.insertCriterion({ id: `crit-rfc-1`, taskId, title: 'Crit 1', verificationMethod: 'trusted_test', status: 'pending' });

    // Create candidate snapshot directory
    const snapDir = path.resolve(getAegisDataDir(), 'candidates', taskId, hash);
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'index.js'), 'console.log("hello");\n');
    const computedHash = computeCanonicalCandidateDigest(snapDir);
    const finalSnapDir = path.resolve(getAegisDataDir(), 'candidates', taskId, computedHash);
    fs.renameSync(snapDir, finalSnapDir);

    // Update task with real computed hash
    const taskCurrent = storage.getTaskById(taskId);
    storage.updateTaskWithRevision(taskId, taskCurrent.version, {
      acceptedCandidateHash: computedHash,
    });

    storage.recordEvidence({
      taskId,
      criterionId: `crit-rfc-1`,
      candidateHash: computedHash,
      verifierName: 'test_verifier',
      outcome: 'passed',
    });

    try {
      // 1. Missing acceptedBaseCommit must fail closed
      const res1 = await GitDeliveryService.deliverToRemote(taskId, {
        repoUrl: 'https://github.com/acme/repo.git',
        branchName: 'aegis/rfc-test',
        deliveryMode: 'branch_push',
        apiToken: 'fake-token',
      });
      assert.strictEqual(res1.success, false);
      assert.strictEqual(res1.blocked, true);
      assert.ok(res1.error?.includes('accepted base commit'), `Error must mention missing accepted base commit: ${res1.error}`);

      // Now set acceptedBaseCommit to dummy commit and test missing remote branch on real bare git repo
      const bareRepo = path.join(testTempDir, `bare-empty-${Date.now()}.git`);
      spawnSync('git', ['init', '--bare', bareRepo]);

      const t2 = storage.getTaskById(taskId);
      storage.updateTaskWithRevision(taskId, t2.version, {
        acceptedBaseCommit: 'd'.repeat(40),
      });

      // Remote query to empty bare repo will fail because defaultBranch 'main' does not exist
      const res2 = await GitDeliveryService.deliverToRemote(taskId, {
        repoUrl: bareRepo,
        branchName: 'aegis/rfc-test',
        defaultBranch: 'main',
        deliveryMode: 'branch_push',
      });
      assert.strictEqual(res2.success, false);
      assert.strictEqual(res2.blocked, true);
      assert.ok(
        res2.error?.includes('no heads') || res2.error?.includes('does not exist'),
        `Error must report missing remote branch: ${res2.error}`
      );
    } finally {
      if (fs.existsSync(finalSnapDir)) fs.rmSync(path.dirname(finalSnapDir), { recursive: true, force: true });
    }
  });

  // --- TEST 35: Verifier version mismatch blocks delivery ---
  await runTest('35. Verifier version mismatch blocks delivery', async () => {
    const taskId = `task-vver-${Date.now()}`;
    const hash = 'e'.repeat(64);
    const baseCommit = 'f'.repeat(40);

    storage.insertTask({
      id: taskId,
      key: `VVER-1`,
      title: 'Verifier Version Test',
      status: 'in_progress',
      acceptedCandidateHash: hash,
      acceptedBaseCommit: baseCommit,
      subtasks: [],
    });

    // Insert criterion with expected verifierVersion '2.0.0'
    storage.insertCriterion({
      id: `crit-vver-1`,
      taskId,
      title: 'Crit VVER',
      verificationMethod: 'trusted_test',
      verificationSpec: { verifierVersion: '2.0.0' },
      status: 'pending',
    });

    // Create candidate snapshot directory
    const snapDir = path.resolve(getAegisDataDir(), 'candidates', taskId, hash);
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'file.js'), 'export const a = 1;\n');
    const realHash = computeCanonicalCandidateDigest(snapDir);
    const finalSnapDir = path.resolve(getAegisDataDir(), 'candidates', taskId, realHash);
    fs.renameSync(snapDir, finalSnapDir);

    const taskCurrent = storage.getTaskById(taskId);
    storage.updateTaskWithRevision(taskId, taskCurrent.version, {
      acceptedCandidateHash: realHash,
      acceptedBaseCommit: baseCommit,
    });

    // Record evidence with default verifierVersion '1.0.0' (mismatched with expected '2.0.0')
    storage.recordEvidence({
      taskId,
      criterionId: `crit-vver-1`,
      baseCommit,
      candidateHash: realHash,
      verifierName: 'suite_v1',
      verifierVersion: '1.0.0', // Mismatch!
      outcome: 'passed',
    });

    try {
      const delivRes = await GitDeliveryService.deliverToBranch(taskId, {
        repoPath: testTempDir,
        branchName: 'aegis/vver-test',
        commitMessage: 'Test verifier version',
      });

      assert.strictEqual(delivRes.success, false);
      assert.ok(delivRes.error?.includes('verifier version mismatch'), `Error must report verifier version mismatch: ${delivRes.error}`);
    } finally {
      if (fs.existsSync(finalSnapDir)) fs.rmSync(path.dirname(finalSnapDir), { recursive: true, force: true });
    }
  });

  // --- TEST 36: Candidate snapshots and evidence ledger satisfy coordinator quality gates ---
  await runTest('36. Candidate snapshots and evidence ledger satisfy coordinator quality gates natively', () => {
    const taskId = `task-unified-${Date.now()}`;
    const taskKey = `UNIF-${Date.now().toString().slice(-4)}`;

    coordinator.updateState({
      tasks: [
        {
          id: taskId,
          key: taskKey,
          title: 'Unified Lifecycle Task',
          status: 'in_progress',
          priority: 'medium',
          assignedAgentId: 'agent-dev',
          estimatedHours: 2,
          spentHours: 0,
          dependencies: [],
          subtasks: [{ id: `crit-unif-1`, title: 'Must export answer', verificationMethod: 'trusted_test' }],
        } as any,
      ],
    });

    storage.insertCriterion({
      id: `crit-unif-1`,
      taskId,
      title: 'Must export answer',
      verificationMethod: 'trusted_test',
      status: 'pending',
    });

    // Candidate snapshot
    const snapDir = path.resolve(getAegisDataDir(), 'candidates', taskId, 'snap-hash-1234');
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'index.js'), 'module.exports = { answer: 42 };\n');
    const digest = computeCanonicalCandidateDigest(snapDir);
    const finalSnapDir = path.resolve(getAegisDataDir(), 'candidates', taskId, digest);
    fs.renameSync(snapDir, finalSnapDir);

    const taskCurrent = storage.getTaskById(taskId);
    storage.updateTaskWithRevision(taskId, taskCurrent.version, {
      acceptedCandidateHash: digest,
      acceptedBaseCommit: '1234567890abcdef1234567890abcdef12345678',
    });

    storage.recordEvidence({
      taskId,
      criterionId: `crit-unif-1`,
      baseCommit: '1234567890abcdef1234567890abcdef12345678',
      candidateHash: digest,
      verifierName: 'trusted_check',
      verifierVersion: '1.0.0',
      outcome: 'passed',
    });

    try {
      // Transition to review and done via coordinator directly (NO workspace/<taskKey>/ copy!)
      const revRes = coordinator.transitionTaskStatus(taskId, 'review');
      assert.strictEqual(revRes.success, true, `Transition to review must succeed: ${revRes.error}`);

      const doneRes = coordinator.transitionTaskStatus(taskId, 'done');
      assert.strictEqual(doneRes.success, true, `Transition to done must succeed: ${doneRes.error}`);
      assert.strictEqual(doneRes.task?.status, 'done');
    } finally {
      if (fs.existsSync(finalSnapDir)) fs.rmSync(path.dirname(finalSnapDir), { recursive: true, force: true });
    }
  });

  // --- TEST 37: Absent verifier-version fails closed in delivery ---
  await runTest('37. Absent verifier-version in evidence fails closed in Git delivery', async () => {
    const taskId = `task-absver-${Date.now()}`;
    const taskKey = `ABSVER-${Date.now().toString().slice(-4)}`;

    coordinator.updateState({
      tasks: [
        {
          id: taskId,
          key: taskKey,
          title: 'Absent Verifier Version Task',
          status: 'in_progress',
          priority: 'medium',
          assignedAgentId: 'agent-dev',
          estimatedHours: 2,
          spentHours: 0,
          dependencies: [],
          subtasks: [{ id: `crit-absver-1`, title: 'Must export answer', verificationMethod: 'trusted_test' }],
        } as any,
      ],
    });

    storage.insertCriterion({
      id: `crit-absver-1`,
      taskId,
      title: 'Must export answer',
      verificationMethod: 'trusted_test',
      status: 'passed',
    });

    const snapDir = path.resolve(getAegisDataDir(), 'candidates', taskId, 'temp-snap');
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'index.js'), 'module.exports = { answer: 100 };\n');
    const digest = computeCanonicalCandidateDigest(snapDir);
    const finalSnapDir = path.resolve(getAegisDataDir(), 'candidates', taskId, digest);
    fs.renameSync(snapDir, finalSnapDir);

    const taskCurrent = storage.getTaskById(taskId);
    storage.updateTaskWithRevision(taskId, taskCurrent.version, {
      acceptedCandidateHash: digest,
      acceptedBaseCommit: '1234567890abcdef1234567890abcdef12345678',
    });

    // Directly insert evidence with verifier_version = NULL
    const evId = `ev-absver-${Date.now()}`;
    (storage as any).db.prepare(`
      INSERT INTO evidence (
        id, run_id, task_id, criterion_id, base_commit, candidate_hash,
        verifier_name, verifier_version, requirements_version, exit_code, outcome, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evId, null, taskId, `crit-absver-1`, '1234567890abcdef1234567890abcdef12345678', digest,
      'test_verifier', null, 1, 0, 'passed', new Date().toISOString()
    );

    try {
      const delivRes = await GitDeliveryService.deliverToBranch(taskId, {
        repoPath: testTempDir,
        branchName: 'aegis/absver-test',
        commitMessage: 'Test absent verifier version',
      });

      assert.strictEqual(delivRes.success, false, 'Delivery must be rejected when verifier_version is absent');
      assert.ok(delivRes.error?.includes('verifier version mismatch'), `Error must mention verifier version: ${delivRes.error}`);
    } finally {
      if (fs.existsSync(finalSnapDir)) fs.rmSync(path.dirname(finalSnapDir), { recursive: true, force: true });
    }
  });

  // --- TEST 38: Unified coordinator quality gates strictly reject legacy unverified paths ---
  await runTest('38. Coordinator quality gates strictly reject legacy unverified tasks (missing snapshot or absent evidence)', () => {
    const taskId = `task-legacy-block-${Date.now()}`;
    const taskKey = `LGCY-${Date.now().toString().slice(-4)}`;

    // Create a task that has subtasks marked completed: true, but NO acceptedCandidateHash
    coordinator.updateState({
      tasks: [
        {
          id: taskId,
          key: taskKey,
          title: 'Legacy Bypass Task',
          status: 'in_progress',
          priority: 'high',
          assignedAgentId: 'agent-dev',
          estimatedHours: 4,
          spentHours: 0,
          dependencies: [],
          subtasks: [
            { id: `crit-lgcy-1`, title: 'Worker marked completed', completed: true },
          ],
        } as any,
      ],
    });

    storage.insertCriterion({
      id: `crit-lgcy-1`,
      taskId,
      title: 'Worker marked completed',
      verificationMethod: 'trusted_test',
      status: 'pending',
    });

    // Quality gate check directly
    const taskInCoord = coordinator.getState().tasks.find((t) => t.id === taskId);
    assert.ok(taskInCoord);
    const vRes = coordinator.verifyTaskQualityGates(taskInCoord);
    assert.strictEqual(vRes.passed, false, 'Quality gates must fail closed without accepted candidate hash');
    const critCheck = vRes.checks.find((c) => c.rule === 'Acceptance Criteria Certified in Ledger');
    assert.strictEqual(critCheck?.passed, false);
    assert.ok(critCheck?.detail.includes('no accepted candidate digest'));

    // Transition directly to done must fail
    const doneAttempt = coordinator.transitionTaskStatus(taskId, 'done');
    assert.strictEqual(doneAttempt.success, false, 'Transition to done must be rejected');
  });

  // --- TEST 39: Status transitions persist transactionally to SQLite and survive coordinator restart ---
  await runTest('39. Status transitions persist transactionally to SQLite and remain consistent across reads and restarts', () => {
    const taskId = `task-persist-test-${Date.now()}`;
    const taskKey = `PRST-${Date.now().toString().slice(-4)}`;

    // Create a valid candidate snapshot on disk
    const dummySrcDir = path.join(testTempDir, `candidate_persist_${Date.now()}`);
    fs.mkdirSync(dummySrcDir, { recursive: true });
    fs.writeFileSync(path.join(dummySrcDir, 'index.js'), 'export const ready = true;\n', 'utf-8');

    const expectedHash = computeCanonicalCandidateDigest(dummySrcDir);
    const candidateStoreDir = path.resolve(getAegisDataDir(), 'candidates', taskId, expectedHash);
    fs.mkdirSync(candidateStoreDir, { recursive: true });
    fs.writeFileSync(path.join(candidateStoreDir, 'index.js'), 'export const ready = true;\n', 'utf-8');

    try {
      // 1. Insert task into SQLite
      storage.insertTask({
        id: taskId,
        key: taskKey,
        title: 'Authoritative Persistence Task',
        status: 'in_progress',
        priority: 'high',
        assignedAgentId: 'agent-dev',
        estimatedHours: 4,
        spentHours: 0,
        dependencies: [],
        subtasks: [],
        acceptedCandidateHash: expectedHash,
        requirementsVersion: 1,
      });

      const critId = `crit-persist-${Date.now()}`;
      storage.insertCriterion({
        id: critId,
        taskId,
        title: 'Persistence Acceptance Criteria',
        verificationMethod: 'trusted_test',
        verificationSpec: { expectedVerifierVersion: '1.0.0' },
        status: 'passed',
      });

      // Insert passing evidence
      const evId = `ev-persist-${Date.now()}`;
      (storage as any).db.prepare(`
        INSERT INTO evidence (
          id, run_id, task_id, criterion_id, base_commit, candidate_hash,
          verifier_name, verifier_version, requirements_version, exit_code, outcome, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        evId,
        null,
        taskId,
        critId,
        null,
        expectedHash,
        'trusted_test',
        '1.0.0',
        1,
        0,
        'passed',
        new Date().toISOString()
      );

      // Reload coordinator tasks from SQLite
      coordinator.getState(); // triggers reload from SQLite

      // 2. Transition from in_progress to review
      const reviewTransition = coordinator.transitionTaskStatus(taskId, 'review');
      assert.strictEqual(reviewTransition.success, true, `Review transition should succeed: ${reviewTransition.error}`);
      assert.strictEqual(reviewTransition.task?.status, 'review');

      // Verify SQLite state immediately
      let dbTask = storage.getTaskById(taskId);
      assert.strictEqual(dbTask?.status, 'review', 'SQLite must immediately reflect review status');

      // Verify coordinator in-memory read
      let coordTask = coordinator.getState().tasks.find((t) => t.id === taskId);
      assert.strictEqual(coordTask?.status, 'review', 'Coordinator read must reflect review status');

      // 3. Transition from review to done
      const doneTransition = coordinator.transitionTaskStatus(taskId, 'done');
      assert.strictEqual(doneTransition.success, true, `Done transition should succeed: ${doneTransition.error}`);
      assert.strictEqual(doneTransition.task?.status, 'done');

      // Verify SQLite state immediately
      dbTask = storage.getTaskById(taskId);
      assert.strictEqual(dbTask?.status, 'done', 'SQLite must immediately reflect done status');

      // Verify coordinator in-memory read
      coordTask = coordinator.getState().tasks.find((t) => t.id === taskId);
      assert.strictEqual(coordTask?.status, 'done', 'Coordinator read must reflect done status');

      // 4. Simulate application restart by reloading coordinator state
      coordinator.resetState();
      const restartedTasks = coordinator.getState().tasks;
      const restartedTask = restartedTasks.find((t) => t.id === taskId);
      assert.ok(restartedTask, 'Task must exist after coordinator restart');
      assert.strictEqual(restartedTask?.status, 'done', 'Status must remain done after application restart');
    } finally {
      if (fs.existsSync(candidateStoreDir)) fs.rmSync(path.dirname(candidateStoreDir), { recursive: true, force: true });
    }
  });

  // Cleanup: Strictly restricted to the temporary directory fixture created for this run
  try {
    delete process.env.AEGIS_DATA_DIR;
    delete process.env.AEGIS_DB_PATH;
    delete process.env.AEGIS_STATE_PATH;
    StorageEngine.resetInstance();
    coordinator.resetState();
    fs.rmSync(testTempDir, { recursive: true, force: true });
  } catch {}

  console.log(`\n=== ALL 39 CRITICAL PIPELINE TESTS PASSED CLEANLY: ${passedTests}/${totalTests} ===\n`);
}

executeSuite().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
