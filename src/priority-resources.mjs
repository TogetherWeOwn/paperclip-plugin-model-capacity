// Resource-aware priority is used only for the opt-in multi-account allocator.
// Bound discrete pool search and flow augmentations independently of backlog.
const MAX_WORK = 8192;
const SEARCH_LIMIT = Symbol('priority-resource-search-limit');

/** Fractional account flow inside ONE pool; each requested run still costs 1. */
function coversPool(needs, idsByAgent, accountLeft, pacedLeft, poolLeft, burn, step,
  { hardHeld, rawPacedLeft, agentPacedLeft }) {
  const required = [...needs.values()].reduce((sum, n) => sum + n, 0);
  if (required > poolLeft) return false;
  const ids = [...new Set([...needs.keys()].flatMap(i => idsByAgent.get(i)))];
  const graph = Array.from({ length: needs.size * 2 + ids.length + 4 }, () => []);
  const source = graph.length - 4, paced = source + 1, rawPaced = source + 2, sink = source + 3;
  const add = (from, to, cap) => {
    const forward = { to, cap, reverse: graph[to].length };
    graph[from].push(forward);
    graph[to].push({ to: from, cap: 0, reverse: graph[from].length - 1 });
  };
  const accountNodes = new Map(ids.map((id, i) => [id, needs.size * 2 + i]));
  let index = 0;
  for (const [i, n] of needs) {
    const localPaced = needs.size + index;
    add(source, index, n);
    add(index, localPaced, Math.min(n, agentPacedLeft.get(i) ?? n));
    for (const id of idsByAgent.get(i)) add(burn.has(id) ? index : localPaced, accountNodes.get(id), n);
    index++;
  }
  for (const id of ids) add(accountNodes.get(id), burn.has(id) ? sink : hardHeld.has(id) ? paced : rawPaced, accountLeft.get(id) ?? 0);
  // Only restored accounts bypass the raw budget. Ordinary account flow can
  // never borrow another role's exception, including during rematching.
  add(rawPaced, paced, rawPacedLeft);
  add(paced, sink, pacedLeft);
  let flow = 0;
  while (flow < required) {
    step();
    const previous = new Map([[source, null]]), queue = [source];
    for (let pos = 0; pos < queue.length && !previous.has(sink); pos++) {
      const from = queue[pos];
      for (const [edgeIndex, edge] of graph[from].entries()) {
        if (!(edge.cap > 0) || previous.has(edge.to)) continue;
        previous.set(edge.to, [from, edgeIndex]);
        queue.push(edge.to);
      }
    }
    if (!previous.has(sink)) return false;
    let amount = required - flow;
    for (let to = sink; to !== source;) {
      const [from, edgeIndex] = previous.get(to);
      amount = Math.min(amount, graph[from][edgeIndex].cap);
      to = from;
    }
    for (let to = sink; to !== source;) {
      const [from, edgeIndex] = previous.get(to), edge = graph[from][edgeIndex];
      edge.cap -= amount;
      graph[to][edge.reverse].cap += amount;
      to = from;
    }
    flow += amount;
  }
  return true;
}

/**
 * Weighted whole-slot quanta, with a fresh funding plan before every grant.
 * Account flow rematches flexible consumers; integer per-agent pool counts
 * prevent fractions in unrelated provider pools from manufacturing a run.
 * A search limit retains only the already-proved feasible prefix and reports it.
 */
export function allocatePriorityResourceSlots({ rows, available, noHeadroomIds, admissions,
  accountPool, accountLeft, poolLeft, pacedLeft, burn, hardHeld = new Set(),
  rawPacedLeft = pacedLeft, agentPacedLeft = new Map() }) {
  const extras = rows.map(() => 0);
  const limits = rows.map(row => noHeadroomIds.has(row.agentId) ? row.queued : Math.max(row.queued, 1));
  const weights = rows.map(row => (row.queued + 1) * (row.queued > 0 ? row.allocationWeight : 1));
  const blocked = new Set(), byPool = new Map(), fitCache = new Map(), choices = new Map();
  let work = 0;
  const step = () => { if (++work > MAX_WORK) throw SEARCH_LIMIT; };
  for (const [i, row] of rows.entries()) {
    if (!noHeadroomIds.has(row.agentId)) continue;
    for (const id of admissions.get(row.agentId) ?? []) {
      const pool = accountPool.get(id);
      if (!(accountLeft.get(id) > 0) || !(poolLeft.get(pool) >= 1)) continue;
      if (!byPool.has(pool)) byPool.set(pool, new Map());
      const members = byPool.get(pool);
      if (!members.has(i)) members.set(i, []);
      members.get(i).push(id);
    }
  }
  const fits = (pool, needs) => {
    const key = JSON.stringify([pool, [...needs].filter(([, n]) => n > 0).sort(([a], [b]) => a - b)]);
    if (fitCache.has(key)) return fitCache.get(key);
    step();
    const result = coversPool(new Map([...needs].filter(([, n]) => n > 0)), byPool.get(pool),
      accountLeft, pacedLeft.get(pool) ?? 0, poolLeft.get(pool) ?? 0, burn, step,
      { hardHeld, rawPacedLeft: rawPacedLeft.get(pool) ?? 0,
        agentPacedLeft: new Map([...needs.keys()].map(i => [i, agentPacedLeft.get(rows[i].agentId)?.get(pool) ?? Infinity])) });
    fitCache.set(key, result);
    return result;
  };
  const choicesOf = i => {
    if (!choices.has(i)) choices.set(i, [...byPool.keys()].filter(pool =>
      byPool.get(pool).has(i) && fits(pool, new Map([[i, 1]]))).sort());
    return choices.get(i);
  };
  const feasible = requested => {
    const assigned = new Map([...byPool.keys()].map(pool => [pool, new Map()]));
    const flexible = [];
    for (const [i, n] of requested.entries()) {
      if (!(n > 0) || !noHeadroomIds.has(rows[i].agentId)) continue;
      const pools = choicesOf(i);
      if (pools.length === 0) return false;
      if (pools.length === 1) assigned.get(pools[0]).set(i, n);
      else flexible.push({ i, n, pools });
    }
    // Most deployments use a single pool: solve its complete subset matching
    // in one flow instead of searching one placement per running-slot quantum.
    for (const [pool, needs] of assigned) if (needs.size > 0 && !fits(pool, needs)) return false;
    flexible.sort((a, b) => a.pools.length - b.pools.length
      || (admissions.get(rows[a.i].agentId)?.length ?? 0) - (admissions.get(rows[b.i].agentId)?.length ?? 0)
      || rows[a.i].agentId.localeCompare(rows[b.i].agentId));
    const search = pos => {
      step();
      if (pos === flexible.length) return true;
      const { i, n, pools } = flexible[pos];
      const maxima = pools.map(pool => {
        const needs = assigned.get(pool);
        const used = [...needs.values()].reduce((sum, value) => sum + value, 0);
        let low = 0, high = Math.min(n, Math.max(0, Math.floor(poolLeft.get(pool)) - used));
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          needs.set(i, mid);
          if (fits(pool, needs)) low = mid;
          else high = mid - 1;
        }
        needs.delete(i);
        return low;
      });
      const distribute = (index, remaining) => {
        step();
        if (index === pools.length) return remaining === 0 && search(pos + 1);
        const tail = maxima.slice(index + 1).reduce((sum, value) => sum + value, 0);
        const needs = assigned.get(pools[index]);
        for (let n = Math.min(remaining, maxima[index]); n >= Math.max(0, remaining - tail); n--) {
          if (n > 0) needs.set(i, n);
          else needs.delete(i);
          if (distribute(index + 1, remaining - n)) return true;
        }
        needs.delete(i);
        return false;
      };
      return distribute(0, n);
    };
    return search(0);
  };
  try {
    while (available > 0) {
      step();
      // D'Hondt weighted quanta compete at the actual resource bottleneck,
      // not in input/demand order after an oversized tentative fleet split.
      const candidates = rows.map((_, i) => i).filter(i => extras[i] < limits[i] && !blocked.has(i))
        .sort((a, b) => weights[b] / (extras[b] + 1) - weights[a] / (extras[a] + 1)
          || rows[a].agentId.localeCompare(rows[b].agentId));
      let granted = false;
      for (const i of candidates) {
        const requested = extras.slice();
        requested[i]++;
        if (noHeadroomIds.has(rows[i].agentId) && !feasible(requested)) {
          blocked.add(i); // A genuinely infeasible vector cannot improve as demand grows.
          continue;
        }
        extras[i]++;
        available--;
        granted = true;
        break;
      }
      if (!granted) break;
    }
  } catch (error) {
    if (error !== SEARCH_LIMIT) throw error;
    return { extras, resourceStatus: 'search-limited' };
  }
  return { extras };
}
