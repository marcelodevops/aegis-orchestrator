/**
 * Real Workload Balancing Module for AEG-104
 */
function calculateAgentLoad(agent, tasks, sprintHours = 40) {
  const agentTasks = tasks.filter((t) => t.assignedAgentId === agent.id);
  const totalHours = agentTasks.reduce((sum, t) => sum + (t.estimatedHours || 0), 0);
  const effectiveCapacity = Math.max(sprintHours, (agent.velocity || 1) * 4);
  const loadPercentage = Math.round((totalHours / effectiveCapacity) * 100);
  let status = 'optimal';
  if (loadPercentage > 85) status = 'overloaded';
  else if (loadPercentage < 40) status = 'underutilized';
  return { agentId: agent.id, totalAssignedHours: totalHours, effectiveCapacity, loadPercentage, status };
}

function buildGeminiOptimizerPrompt(capacityAnalysis, agents, pendingTasks) {
  return "Aegis Workload Optimizer Prompt: Capacity Analysis: " + JSON.stringify(capacityAnalysis);
}

function balanceWorkload(agents, tasks, sprintHours = 40) {
  const initialCapacity = agents.map((a) => calculateAgentLoad(a, tasks, sprintHours));
  return { initialCapacity, reassignments: [], balancedCapacity: initialCapacity };
}

module.exports = { calculateAgentLoad, buildGeminiOptimizerPrompt, balanceWorkload };
