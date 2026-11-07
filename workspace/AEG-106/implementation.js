/**
 * DAG Topological Sort & Cycle Detection Module
 * Author: Aegis Autonomous Worker (AEG-106)
 
 */

function detectCycles(nodes, edges) {
  // DFS cycle detection using visited & recStack tracking
  const visited = new Set();
  const recStack = new Set();
  const adj = new Map();
  for (const n of nodes) adj.set(n, []);
  for (const [u, v] of edges) {
    if (!adj.has(u)) adj.set(u, []);
    adj.get(u).push(v);
  }

  const dfs = (node) => {
    visited.add(node);
    recStack.add(node);
    for (const neighbor of adj.get(node) || []) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) return true;
      } else if (recStack.has(neighbor)) {
        return true;
      }
    }
    recStack.delete(node);
    return false;
  };

  for (const node of nodes) {
    if (!visited.has(node)) {
      if (dfs(node)) return true;
    }
  }
  return false;
}

function topologicalSort(nodes, edges) {
  if (detectCycles(nodes, edges)) {
    throw new Error("Cycle detected in DAG, topological sort impossible");
  }
  const inDegree = new Map();
  const adj = new Map();
  for (const n of nodes) {
    inDegree.set(n, 0);
    adj.set(n, []);
  }
  for (const [u, v] of edges) {
    inDegree.set(v, (inDegree.get(v) || 0) + 1);
    adj.get(u).push(v);
  }
  const queue = [];
  for (const [n, deg] of inDegree) {
    if (deg === 0) queue.push(n);
  }
  const order = [];
  while (queue.length > 0) {
    const u = queue.shift();
    order.push(u);
    for (const v of adj.get(u) || []) {
      inDegree.set(v, inDegree.get(v) - 1);
      if (inDegree.get(v) === 0) queue.push(v);
    }
  }
  return order;
}

function computeCriticalPath(nodes, edges, weights = {}) {
  const order = topologicalSort(nodes, edges);
  const dist = new Map();
  for (const n of nodes) dist.set(n, weights[n] || 1);
  for (const u of order) {
    const uDist = dist.get(u);
    for (const [from, to] of edges) {
      if (from === u) {
        const nextDist = uDist + (weights[to] || 1);
        if (nextDist > (dist.get(to) || 0)) {
          dist.set(to, nextDist);
        }
      }
    }
  }
  let maxPath = 0;
  for (const d of dist.values()) {
    if (d > maxPath) maxPath = d;
  }
  return { order, maxLatency: maxPath };
}

module.exports = { detectCycles, topologicalSort, computeCriticalPath };
