
const assert = require('assert');
const testAgent = { id: 'a1', name: 'Agent 1' };
const testTasks = [
  { id: 't1', assignedAgentId: 'a1', estimatedHours: 20, status: 'in_progress' }
];

const load = calculateAgentLoad(testAgent, testTasks, 40);
assert.strictEqual(load.loadPercentage, 50);
assert.strictEqual(load.status, 'balanced');
if (typeof passCriterion === 'function') passCriterion('st-10');

assert.strictEqual(calculateAgentLoad(testAgent, [{ assignedAgentId: 'a1', estimatedHours: 36 }], 40).status, 'overloaded');
if (typeof passCriterion === 'function') passCriterion('st-11');

const agents = [{ id: 'a1' }, { id: 'a2' }];
const heavyTasks = [{ id: 't1', assignedAgentId: 'a1', estimatedHours: 36, status: 'in_progress' }];
const res = balanceWorkload(agents, heavyTasks, 40);
assert.ok(res.assignments.length > 0);
if (typeof passCriterion === 'function') passCriterion('st-12');
