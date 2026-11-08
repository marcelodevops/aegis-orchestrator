const assert = require('assert');
const path = require('path');
const implPath = path.resolve(process.cwd(), 'implementation.cjs');
const { detectCycles, topologicalSort, computeCriticalPath } = require(implPath);

const targetId = process.argv[2];

if (!targetId || targetId === 'st-16') {
  const order = topologicalSort(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']]);
  assert.deepStrictEqual(order, ['A', 'B', 'C'], 'Topological sort order must be correct');
}

if (!targetId || targetId === 'st-17') {
  const hasCycle = detectCycles(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']]);
  assert.strictEqual(hasCycle, false, 'Linear DAG must not have cycle');

  const cyclicDetected = detectCycles(['X', 'Y', 'Z'], [['X', 'Y'], ['Y', 'Z'], ['Z', 'X']]);
  assert.strictEqual(cyclicDetected, true, 'Cyclic graph must be detected');
}

if (!targetId || targetId === 'st-18') {
  const cp = computeCriticalPath(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']], { A: 2, B: 3, C: 4 });
  assert.strictEqual(cp.maxLatency, 9, 'Critical path latency must be 9');
}

if (targetId && !['st-16', 'st-17', 'st-18'].includes(targetId)) {
  console.error('Unknown criterion: ' + targetId);
  process.exit(1);
}

console.log('All assertions passed for criterion: ' + (targetId || 'all'));
process.exit(0);
