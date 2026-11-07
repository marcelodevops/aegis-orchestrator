const assert = require('assert');
const { calculateAgentLoad, buildGeminiOptimizerPrompt, balanceWorkload } = require('./implementation.js');

const targetId = process.argv[2];

if (!targetId || targetId === 'st-10') {
  const load = calculateAgentLoad({ id: 'a1', velocity: 10 }, [{ assignedAgentId: 'a1', estimatedHours: 20 }], 40);
  assert.strictEqual(load.loadPercentage, 50, 'Load percentage must be 50%');
}

if (!targetId || targetId === 'st-11') {
  const prompt = buildGeminiOptimizerPrompt([], [{ id: 'a1', role: 'Dev' }], []);
  assert.ok(prompt.includes('Aegis Workload Optimizer Prompt'), 'Prompt must contain header');
}

if (!targetId || targetId === 'st-12') {
  const balanced = balanceWorkload([{ id: 'a1', velocity: 10, skills: ['ts'] }], [{ id: 't1', key: 'T1', assignedAgentId: 'a1', estimatedHours: 35 }]);
  assert.ok(Array.isArray(balanced.reassignments), 'Reassignments must be array');
}

if (targetId && !['st-10', 'st-11', 'st-12'].includes(targetId)) {
  console.error('Unknown criterion: ' + targetId);
  process.exit(1);
}

console.log('Passed assertions for criterion: ' + (targetId || 'all'));
