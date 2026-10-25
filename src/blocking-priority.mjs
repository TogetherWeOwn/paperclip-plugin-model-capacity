/** Optional native issue-relation weighting for scarce NEW run slots. */
export const MAX_BLOCKING_FAN_OUT = 100;
const OPEN = new Set(['backlog', 'todo', 'in_progress', 'in_review', 'blocked']);
const READY = new Set(['todo', 'in_progress']);
const PRIORITY = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });

/**
 * Build a company-scoped graph from issues.read payloads, never descriptions or
 * parent links. The SDK makes relation fields optional: absent is NOT empty.
 * Require one complete edge direction, otherwise callers use the legacy split.
 */
export function buildBlockingPriorities(issues) {
  const rows = new Map();
  for (const issue of issues) {
    if (issue && OPEN.has(issue.status) && typeof issue.id === 'string') rows.set(issue.id, issue);
  }
  const open = [...rows.values()];
  const directions = ['blockedBy', 'blocks'].filter(direction => open.every(issue =>
    Array.isArray(issue[direction]) && issue[direction].every(relation =>
      relation != null && typeof relation.id === 'string' && relation.id.length > 0)));
  if (open.length === 0 || directions.length === 0) throw new Error('issue-relations-unavailable');
  const graphFor = direction => {
    const graph = new Map(open.map(issue => [issue.id, new Set()]));
    for (const issue of open) {
      for (const relation of issue[direction]) {
        if (!rows.has(relation.id)) continue; // Only readable, open cards count.
        const from = direction === 'blockedBy' ? relation.id : issue.id;
        const to = direction === 'blockedBy' ? issue.id : relation.id;
        graph.get(from).add(to);
      }
    }
    return graph;
  };
  const edges = graphFor(directions[0]);
  if (directions.length === 2) {
    const reverse = graphFor(directions[1]);
    for (const [id, children] of edges) {
      const other = reverse.get(id);
      if (children.size !== other.size || [...children].some(child => !other.has(child))) {
        throw new Error('issue-relations-inconsistent');
      }
    }
  }
  const roots = new Map();
  for (const issue of open) {
    if (!READY.has(issue.status) || typeof issue.assigneeAgentId !== 'string') continue;
    if (!roots.has(issue.assigneeAgentId)) roots.set(issue.assigneeAgentId, []);
    roots.get(issue.assigneeAgentId).push(issue);
  }
  const priorities = new Map();
  for (const [agentId, assigned] of roots) {
    // Union descendants across the agent's ready cards. Seed roots as visited
    // so diamonds, duplicate edges and cycles never inflate the fan-out.
    const seen = new Set(assigned.map(issue => issue.id));
    const pending = assigned.map(issue => issue.id);
    let blockingFanOut = 0;
    while (pending.length > 0 && blockingFanOut < MAX_BLOCKING_FAN_OUT) {
      for (const child of edges.get(pending.pop()) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        pending.push(child);
        blockingFanOut += 1;
        if (blockingFanOut >= MAX_BLOCKING_FAN_OUT) break;
      }
    }
    let cardPriority = 'low';
    for (const issue of assigned) {
      const candidate = Object.hasOwn(PRIORITY, issue.priority) ? issue.priority : 'medium';
      if (PRIORITY[candidate] > PRIORITY[cardPriority]) cardPriority = candidate;
    }
    priorities.set(agentId, {
      blockingFanOut, cardPriority, weight: (1 + blockingFanOut) * PRIORITY[cardPriority],
    });
  }
  return priorities;
}
