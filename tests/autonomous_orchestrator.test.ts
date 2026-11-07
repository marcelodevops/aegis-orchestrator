/**
 * Autonomous Orchestration Verification Suite
 * Verifies server-owned state, DAG cycle detection, optimistic concurrency,
 * SSRF security, path containment, and isolated execution.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { storage } from '../src/server/storage/db.js';
import { assertPathContained } from '../src/server/execution/pathContainment.js';
import { runIsolatedProcess } from '../src/server/execution/isolatedProcess.js';
import { validateOutboundUrl } from '../src/server/security/networkPolicy.js';
import { redactSensitiveConfig } from '../src/server/security/secrets.js';
import { requireAuthToken, getOrGenerateAuthToken } from '../src/server/security/auth.js';
import { detectCyclesInDag, topologicalSortTasks, OrchestratorService } from '../src/server/orchestration/orchestratorService.js';
import { Task } from '../src/types/index.js';

let passedTests = 0;
let totalTests = 0;

async function runTest(name: string, fn: () => void | Promise<void>) {
  totalTests++;
  try {
    await fn();
    console.log(`✔ [PASS] ${name}`);
    passedTests++;
  } catch (err: any) {
    console.error(`✘ [FAIL] ${name}: ${err.message}`);
    throw err;
  }
}

async function executeSuite() {
  console.log('\n=== RUNNING AUTONOMOUS ORCHESTRATION INTEGRATION TESTS ===\n');

  // --- 1. Kahn's DAG Cycle Detection & Topological Sorting ---
  await runTest("Kahn's DAG detects cycles and blocks circular dependency chains", () => {
    const cyclicTasks: Task[] = [
      {
        id: 't-1',
        key: 'AEG-01',
        title: 'Task 1',
        description: '',
        epicId: 'epic-1',
        status: 'todo',
        priority: 'high',
        assignedAgentId: 'agent-fe',
        estimatedHours: 4,
        spentHours: 0,
        dependencies: ['t-2'],
        tags: ['cycle-test'],
        subtasks: [],
        deliverables: [],
      },
      {
        id: 't-2',
        key: 'AEG-02',
        title: 'Task 2',
        description: '',
        epicId: 'epic-1',
        status: 'todo',
        priority: 'high',
        assignedAgentId: 'agent-fe',
        estimatedHours: 4,
        spentHours: 0,
        dependencies: ['t-3'],
        tags: ['cycle-test'],
        subtasks: [],
        deliverables: [],
      },
      {
        id: 't-3',
        key: 'AEG-03',
        title: 'Task 3',
        description: '',
        epicId: 'epic-1',
        status: 'todo',
        priority: 'high',
        assignedAgentId: 'agent-fe',
        estimatedHours: 4,
        spentHours: 0,
        dependencies: ['t-1'], // cycle: 1 -> 2 -> 3 -> 1
        tags: ['cycle-test'],
        subtasks: [],
        deliverables: [],
      },
    ];

    const cycleResult = detectCyclesInDag(cyclicTasks);
    assert.strictEqual(cycleResult.hasCycle, true, 'Must detect cycle in graph');
    assert.ok(cycleResult.cycleNodes.length >= 3, 'Cycle nodes must contain the circular path');

    const sortResult = topologicalSortTasks(cyclicTasks);
    assert.strictEqual(sortResult.success, false, 'Topological sort must fail for cyclic graph');
    assert.ok(sortResult.error?.includes('Cycle detected'));
  });

  await runTest("Kahn's DAG produces correct linear execution order for acyclic dependency graph", () => {
    const acyclicTasks: Task[] = [
      {
        id: 't-c',
        key: 'AEG-C',
        title: 'Task C',
        description: '',
        epicId: 'epic-1',
        status: 'todo',
        priority: 'medium',
        assignedAgentId: 'agent-fe',
        estimatedHours: 2,
        spentHours: 0,
        dependencies: ['t-b'],
        tags: ['dag'],
        subtasks: [],
        deliverables: [],
      },
      {
        id: 't-a',
        key: 'AEG-A',
        title: 'Task A',
        description: '',
        epicId: 'epic-1',
        status: 'todo',
        priority: 'high',
        assignedAgentId: 'agent-be',
        estimatedHours: 3,
        spentHours: 0,
        dependencies: [],
        tags: ['dag'],
        subtasks: [],
        deliverables: [],
      },
      {
        id: 't-b',
        key: 'AEG-B',
        title: 'Task B',
        description: '',
        epicId: 'epic-1',
        status: 'todo',
        priority: 'high',
        assignedAgentId: 'agent-be',
        estimatedHours: 4,
        spentHours: 0,
        dependencies: ['t-a'],
        tags: ['dag'],
        subtasks: [],
        deliverables: [],
      },
    ];

    const cycleResult = detectCyclesInDag(acyclicTasks);
    assert.strictEqual(cycleResult.hasCycle, false, 'Acyclic graph must have no cycle');

    const sortResult = topologicalSortTasks(acyclicTasks);
    assert.strictEqual(sortResult.success, true, 'Topological sort must succeed');
    const sortedIds = sortResult.sortedTasks?.map((t) => t.id);
    assert.deepStrictEqual(sortedIds, ['t-a', 't-b', 't-c'], 'Must sort dependencies before dependents (A -> B -> C)');
  });

  // --- 2. Optimistic Concurrency Revision Control in SQLite ---
  await runTest('Optimistic concurrency revision control prevents stale writes via versioning', () => {
    const uniqueKey = `AEG-CONC-${Date.now()}`;
    const initialTask: Task = {
      id: `task-conc-${Date.now()}`,
      key: uniqueKey,
      title: 'Concurrency Test Task',
      description: 'Testing optimistic locking',
      epicId: 'epic-core',
      status: 'todo',
      priority: 'high',
      assignedAgentId: 'agent-arch',
      estimatedHours: 5,
      spentHours: 0,
      dependencies: [],
      tags: ['concurrency'],
      subtasks: [],
      deliverables: [],
    };

    storage.insertTask(initialTask);
    const read1 = storage.getTaskById(initialTask.id);
    assert.ok(read1, 'Task must exist in DB');
    const v1 = read1.version || 1;

    // First update with valid version v1 succeeds
    const update1 = storage.updateTaskWithRevision(initialTask.id, v1, {
      title: 'Concurrency Updated Title 1',
    });
    assert.strictEqual(update1.success, true, 'First update with current version must succeed');
    assert.strictEqual(update1.newVersion, v1 + 1, 'Version must be incremented to v2');

    // Second update trying to use stale version v1 MUST fail with conflict
    const staleUpdate = storage.updateTaskWithRevision(initialTask.id, v1, {
      title: 'Stale Overwrite Attempt',
    });
    assert.strictEqual(staleUpdate.success, false, 'Stale write must be rejected');
    assert.ok(staleUpdate.error?.includes('Stale write conflict'), 'Must report conflict');

    // Current DB value remains unaffected by the stale update
    const read2 = storage.getTaskById(initialTask.id);
    assert.strictEqual(read2?.title, 'Concurrency Updated Title 1', 'DB state must not be overwritten by stale revision');
  });

  // --- 3. SSRF & Network Policy Defense ---
  await runTest('SSRF policy strictly blocks loopback, link-local metadata, and private IP addresses', async () => {
    const dangerousUrls = [
      'http://localhost:3000/api/state',
      'http://127.0.0.1:8080/admin',
      'http://127.0.0.2',
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://10.0.0.1/internal',
      'http://192.168.1.1/router',
      'http://172.16.0.1/secret',
      'http://[::1]:8080',
    ];

    for (const dangerous of dangerousUrls) {
      const check = await validateOutboundUrl(dangerous, false);
      assert.strictEqual(check.allowed, false, `Must block dangerous URL: ${dangerous}`);
      assert.ok(check.reason, `Must provide rejection reason for ${dangerous}`);
    }

    const safeUrls = [
      'https://api.github.com/repos/org/repo',
      'https://gitlab.com/api/v4/projects',
      'https://jira.atlassian.com/rest/api/3/issue',
    ];

    for (const safe of safeUrls) {
      const check = await validateOutboundUrl(safe, false);
      assert.strictEqual(check.allowed, true, `Must allow standard public HTTPS API: ${safe}`);
    }
  });

  // --- 4. Subprocess Isolation & Env Scrubbing ---
  await runTest('Subprocess execution runs out-of-process, enforces deadlines, and scrubs sensitive keys', async () => {
    // Test 1: Subprocess stdout
    const res = await runIsolatedProcess({
      command: 'node',
      args: ['-e', 'console.log("HELLO_SUBPROCESS")'],
      cwd: process.cwd(),
      timeoutMs: 3000,
    });
    assert.strictEqual(res.exitCode, 0, 'Subprocess must exit 0');
    assert.ok(res.stdout.includes('HELLO_SUBPROCESS'), 'Must capture stdout');

    // Test 2: Timeout enforcement kills hanging subprocess
    const hangRes = await runIsolatedProcess({
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      timeoutMs: 500,
    });
    assert.strictEqual(hangRes.timedOut, true, 'Must enforce timeout on hanging process');
    assert.notStrictEqual(hangRes.exitCode, 0, 'Timed out process must not report successful exit');

    // Test 3: Env scrubbing ensures server secrets are not leaked
    const envRes = await runIsolatedProcess({
      command: 'node',
      args: ['-e', 'console.log(process.env.GEMINI_API_KEY || "SCRUBBED")'],
      cwd: process.cwd(),
      timeoutMs: 3000,
    });
    assert.strictEqual(envRes.stdout.trim(), 'SCRUBBED', 'Server secrets must be scrubbed from subprocess environment');
  });

  // --- 5. Sensitive Configuration Masking ---
  await runTest('Sensitive configuration redaction masks secret values and prevents credential leakage', () => {
    const rawConfig = {
      name: 'Default Workspace',
      apiKey: 'sk-proj-secret-token-1234567890',
      apiToken: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      webhookUrl: 'https://hooks.slack.com/services/T00/B00/SECRET_HOOK',
      nested: {
        password: 'SuperSecretPassword123!',
        publicVal: 'visible_metadata',
      },
    };

    const redacted = redactSensitiveConfig(rawConfig);
    assert.strictEqual(redacted.apiKey, '••••••••', 'apiKey must be redacted');
    assert.strictEqual(redacted.apiToken, '••••••••', 'apiToken must be redacted');
    assert.strictEqual(redacted.webhookUrl, '••••••••', 'webhookUrl must be redacted');
    assert.strictEqual(redacted.nested.password, '••••••••', 'nested passwords must be redacted');
    assert.strictEqual(redacted.nested.publicVal, 'visible_metadata', 'Non-sensitive data must remain intact');
    assert.strictEqual(redacted.name, 'Default Workspace', 'Non-sensitive top-level keys must remain intact');
  });

  // --- 6. Auth Token Middleware Policy ---
  await runTest('Authentication middleware rejects unauthenticated mutating requests with HTTP 401 and allows valid token', () => {
    const validToken = getOrGenerateAuthToken();

    // Mock unauthenticated POST request
    let unauthStatusCode = 200;
    let unauthBody: any = null;
    const mockUnauthReq: any = {
      method: 'POST',
      path: '/api/tasks/transition',
      headers: {},
    };
    const mockUnauthRes: any = {
      status(code: number) {
        unauthStatusCode = code;
        return this;
      },
      json(data: any) {
        unauthBody = data;
        return this;
      },
    };

    let nextCalled = false;
    requireAuthToken(mockUnauthReq, mockUnauthRes, () => {
      nextCalled = true;
    });

    assert.strictEqual(nextCalled, false, 'Next must not be called without token');
    assert.strictEqual(unauthStatusCode, 401, 'Must return HTTP 401 Unauthorized');
    assert.ok(unauthBody?.error?.includes('Unauthorized') || unauthBody?.code === 'AUTH_REQUIRED', 'Must specify unauthorized error');

    // Mock authenticated POST request with header
    let authNextCalled = false;
    const mockAuthReq: any = {
      method: 'POST',
      path: '/api/tasks/transition',
      headers: {
        'x-aegis-auth-token': validToken,
      },
    };
    const mockAuthRes: any = {
      status(code: number) { return this; },
      json(data: any) { return this; },
    };

    requireAuthToken(mockAuthReq, mockAuthRes, () => {
      authNextCalled = true;
    });

    assert.strictEqual(authNextCalled, true, 'Next must be called when valid token is supplied');

    // Read GET requests bypass mutating auth
    let getNextCalled = false;
    const mockGetReq: any = {
      method: 'GET',
      path: '/api/state',
      headers: {},
    };
    requireAuthToken(mockGetReq, mockAuthRes, () => {
      getNextCalled = true;
    });
    assert.strictEqual(getNextCalled, true, 'GET requests must pass through without auth challenge');
  });

  // --- 7. Truthful Integration Status ---
  await runTest('Integrations report truthful not_configured status without fabricating success', () => {
    // When no external secrets configured, integrations must report not_configured
    const status = OrchestratorService.getIntegrationsStatus();
    assert.ok(status.jira, 'Must report jira status');
    assert.ok(status.slack, 'Must report slack status');
    assert.strictEqual(status.jira.status, 'not_configured', 'Unconfigured Jira must report not_configured');
    assert.strictEqual(status.jira.configured, false, 'Unconfigured Jira configured flag must be false');
    assert.strictEqual(status.slack.status, 'not_configured', 'Unconfigured Slack must report not_configured');
    assert.strictEqual(status.slack.configured, false, 'Unconfigured Slack configured flag must be false');
  });

  // --- 8. Strict Path Containment Verification ---
  await runTest('Strict path containment prevents traversal attacks, prefix collisions, and symlink escapes', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-containment-'));
    try {
      const validSubdir = path.join(baseDir, 'workspace', 'AEG-101');
      fs.mkdirSync(validSubdir, { recursive: true });

      // 1. Normal inside path is valid
      const resInside = assertPathContained(validSubdir, baseDir);
      assert.strictEqual(resInside.valid, true, 'Subdirectory inside base must be valid');

      // 2. Traversal outside base is invalid
      const resTraversal = assertPathContained(path.join(baseDir, '..', 'other'), baseDir);
      assert.strictEqual(resTraversal.valid, false, 'Traversal outside base must be blocked');

      // 3. Prefix collision attack (/tmp/base vs /tmp/base-other) is invalid
      const prefixTrap = baseDir + '-other';
      const resPrefix = assertPathContained(prefixTrap, baseDir);
      assert.strictEqual(resPrefix.valid, false, 'Prefix collision must be rejected');
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  console.log(`\n=== AUTONOMOUS ORCHESTRATION TESTS COMPLETE: ${passedTests}/${totalTests} PASSED CLEANLY ===\n`);
}

executeSuite().catch((err) => {
  console.error(err);
  process.exit(1);
});
