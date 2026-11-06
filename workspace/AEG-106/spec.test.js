/**
 * Independent Unit Test Suite for AEG-106
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
if (typeof passCriterion === 'function') passCriterion('st-16');

// 2. Test Criterion 2: Cycle detection
const cycleResClean = detectCycles(sampleNodes);
// CRITICAL CHECK: Clean acyclic DAG must NOT report cycles
assert.strictEqual(cycleResClean.hasCycle, false, 'Clean linear DAG must NOT have a cycle');

const cycleResCyclic = detectCycles(cyclicalNodes);
assert.strictEqual(cycleResCyclic.hasCycle, true, 'Cyclical DAG must be detected');
if (typeof passCriterion === 'function') passCriterion('st-17');

// 3. Test Criterion 3: Critical path computation
const cp = computeCriticalPath(sampleNodes);
assert.strictEqual(cp.totalHours, 18, 'Total hours must be 4 + 6 + 8 = 18 hours');
assert.deepStrictEqual(cp.criticalChain, ['task-A', 'task-B', 'task-C'], 'Critical path must follow dependency chain');
if (typeof passCriterion === 'function') passCriterion('st-18');
