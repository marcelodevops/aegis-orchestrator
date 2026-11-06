
function calculateAgentLoad(agent, tasks, maxHours) {
  const cap = maxHours || 40;
  const assigned = tasks.filter(t => t.assignedAgentId === agent.id && t.status !== 'done');
  const allocated = assigned.reduce((sum, t) => sum + (t.estimatedHours || 0), 0);
  const percentage = Math.round((allocated / cap) * 100);
  let status = 'balanced';
  if (percentage > 85) status = 'overloaded';
  else if (percentage < 40) status = 'underloaded';
  return { agentId: agent.id, allocatedHours: allocated, maxHours: cap, loadPercentage: percentage, status };
}

function balanceWorkload(agents, tasks, maxHours) {
  const loads = agents.map(a => calculateAgentLoad(a, tasks, maxHours));
  const overloaded = loads.filter(l => l.status === 'overloaded');
  const underloaded = loads.filter(l => l.status === 'underloaded');
  const reassignments = [];

  for (const o of overloaded) {
    const agentTasks = tasks.filter(t => t.assignedAgentId === o.agentId && t.status !== 'done');
    if (agentTasks.length > 0 && underloaded.length > 0) {
      const targetAgent = underloaded[0];
      reassignments.push({
        taskId: agentTasks[0].id,
        agentId: targetAgent.agentId,
        roleAssumed: targetAgent.agentId.includes('arch') ? 'Chief Architect' : 'Senior Specialist'
      });
    }
  }
  return { assignments: reassignments };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calculateAgentLoad, balanceWorkload };
}
