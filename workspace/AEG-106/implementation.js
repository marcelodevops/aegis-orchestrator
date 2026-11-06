/**
 * DAG Dependency & Cycle Detection Engine
 * Task: AEG-106 (Construct Interactive DAG Dependency Diagram & Visual Progress Chart)
 * VERIFIED PRODUCTION IMPLEMENTATION
 */

function topologicalSort(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return [];
  
  const inDegree = new Map();
  const adjList = new Map();
  
  nodes.forEach(n => {
    inDegree.set(n.id, 0);
    adjList.set(n.id, []);
  });
  
  nodes.forEach(n => {
    (n.dependencies || []).forEach(depId => {
      if (adjList.has(depId)) {
        adjList.get(depId).push(n.id);
        inDegree.set(n.id, (inDegree.get(n.id) || 0) + 1);
      }
    });
  });
  
  const queue = [];
  inDegree.forEach((deg, id) => {
    if (deg === 0) queue.push(id);
  });
  
  const order = [];
  while (queue.length > 0) {
    const u = queue.shift();
    order.push(u);
    
    (adjList.get(u) || []).forEach(v => {
      inDegree.set(v, inDegree.get(v) - 1);
      if (inDegree.get(v) === 0) {
        queue.push(v);
      }
    });
  }
  
  return order;
}

function detectCycles(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return { hasCycle: false };

  const visited = new Set();
  const recStack = new Set();
  const adj = new Map();

  nodes.forEach(n => adj.set(n.id, n.dependencies || []));

  function dfs(u) {
    visited.add(u);
    recStack.add(u);

    const neighbors = adj.get(u) || [];
    for (const v of neighbors) {
      if (!visited.has(v)) {
        if (dfs(v)) return true;
      } else if (recStack.has(v)) {
        return true;
      }
    }

    recStack.delete(u);
    return false;
  }

  for (const n of nodes) {
    if (!visited.has(n.id)) {
      if (dfs(n.id)) {
        return { hasCycle: true, cycleNode: n.id };
      }
    }
  }

  return { hasCycle: false };
}

function computeCriticalPath(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return { totalHours: 0, criticalChain: [] };
  
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const memo = new Map();
  
  function getLongestPath(id) {
    if (memo.has(id)) return memo.get(id);
    const node = nodeMap.get(id);
    const nodeWeight = (node && node.estimatedHours) || 1;
    
    let maxChildHours = 0;
    let bestChildChain = [];
    
    const dependencies = (node && node.dependencies) || [];
    for (const depId of dependencies) {
      if (nodeMap.has(depId)) {
        const res = getLongestPath(depId);
        if (res.hours > maxChildHours) {
          maxChildHours = res.hours;
          bestChildChain = res.chain;
        }
      }
    }
    
    const result = {
      hours: nodeWeight + maxChildHours,
      chain: [...bestChildChain, id]
    };
    memo.set(id, result);
    return result;
  }
  
  let longestChain = [];
  let maxTotalHours = 0;
  
  for (const n of nodes) {
    const res = getLongestPath(n.id);
    if (res.hours > maxTotalHours) {
      maxTotalHours = res.hours;
      longestChain = res.chain;
    }
  }
  
  return {
    totalHours: maxTotalHours,
    criticalChain: longestChain
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { topologicalSort, detectCycles, computeCriticalPath };
}
