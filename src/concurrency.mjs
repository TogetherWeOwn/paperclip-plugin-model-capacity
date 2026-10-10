/**
 * Fleet concurrency target from MEASURED burn need (Little's law).
 *
 * C* = sum(requiredRate_a / E_a) x D: per account, the required weekly
 * fraction per hour divided by the measured weekly fraction one run
 * consumes (E_a, calibrated from lane usage deltas over runs that ran on
 * the account), times mean run duration D. Guard-capped accounts contribute
 * zero (their load is shed, not grown), as do unhealthy accounts (dead
 * quota is not sustainable concurrency); the total is capped by a
 * configured hard ceiling.
 *
 * Calibration discipline: E_a comes from measurement, never from the
 * cost-anchor estimate. Accounts without a measured E fall back to the
 * anchor burn (flagged) so a partially-calibrated fleet still recommends;
 * when NO account has a measured E the result is calibration 'weak' with
 * target null -- no caps are recommended until E is observed.
 */

export const DEFAULT_CONCURRENCY = Object.freeze({
  maxTotal: 75,
  meanRunDurationHours: 0.186,
  demandFactor: 1,
});

export const ROLES = Object.freeze(['doer', 'thinker', 'other']);

export function medianPositive(values) {
  const v = values.filter(x => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * accounts: [{ accountId, remainingPct (0-1), hoursToReset,
 *   burnPerRunPct (anchor fallback), measuredBurnPerRunPct (E, nullable),
 *   calibrationGroup (accounts sharing one measured E; defaults to the
 *   account), guardActive, healthy (false excludes the account with reason
 *   'excluded'; absent counts as healthy) }]
 *
 * Usable capacity, not raw quota: an account's slots only count for the
 * roles that can take work on it.
 *   roleAccess: { [accountId]: { doer|thinker|other: { eligible, trialOnly } } }
 *     -- roleLadderAccess() per role: family exclusions, the role's
 *     floor..ceiling rung window and trial-role gating already applied.
 *     Absent entries (or an absent map) count the account for every role.
 *   roleDemand: { doer, thinker, other } queued issues per role. It does NOT
 *     weight the target: the target is the sum of the slots of every account
 *     some role can use, which does not move with the queue (a share
 *     weighting discounted role-exclusive capacity by the OTHER roles'
 *     queues, so two disjoint pools both under deep queues read half
 *     of what they sustain). Demand instead yields `demandBound`: the most
 *     runs that could be in flight at once if each role runs only as many as
 *     it has queued issues (a bipartite max flow, exact by min cut over role
 *     subsets), PLUS the runs already in flight per role (`roleRunning`):
 *     /caps counts every running ledger run -- including runs on in_review
 *     issues, chat and heartbeat runs that no queued-issue count sees -- so
 *     a bound from queued issues alone can drop the served target below what
 *     is already running, and the allocator then sheds running-first and
 *     starts nothing new while capacity sits idle. The plugin applies it
 *     AFTER smoothing, so a queue surge lifts the served target at once
 *     instead of rising on the EWMA half-life.
 *     Null when demand is absent or all zero (idle or unreadable queue:
 *     count any capacity some role can use).
 *   roleRunning: { doer, thinker, other } runs already in flight per role.
 *     Absent (or all zero) reads exactly as today.
 *   trialSlotCap: a trial-only account sustains at most this many runs in
 *     flight (the trial cap), whatever its quota says.
 * Uncalibrated (anchor) burn estimates never dominate: an anchor-fallback
 * account's burn is floored at the median MEASURED per-run burn, so a
 * guessed-cheap anchor cannot mint more slots than a measured peer.
 */
export function computeConcurrencyTarget({
  accounts, meanRunDurationHours, demandFactor = 1, maxTotal = 75,
  roleAccess = null, roleDemand = null, roleRunning = null, trialSlotCap = 2,
} = {}) {
  const D = meanRunDurationHours ?? DEFAULT_CONCURRENCY.meanRunDurationHours;
  const list = accounts ?? [];
  // Guard decides slots (zero), not knowledge: a guard-capped account with a
  // measured E still counts as calibrated, so an all-guarded fleet reads
  // target 0 (shed everything) instead of weak/null (recommend nothing).
  const anyMeasured = list.some(a => a.measuredBurnPerRunPct > 0);
  // One measured E per calibration group (pool members share it): the
  // median is over distinct groups, so a wide pool cannot outvote the rest.
  const measuredByGroup = new Map();
  for (const a of list) {
    if (a.measuredBurnPerRunPct > 0) measuredByGroup.set(a.calibrationGroup ?? a.accountId, a.measuredBurnPerRunPct);
  }
  const medianMeasured = medianPositive([...measuredByGroup.values()]);
  const perAccount = list.map(a => {
    if (a.guardActive) {
      return {
        accountId: a.accountId, slots: 0, runsPerHour: 0, capped: true, reason: '5h-guard', calibrated: false,
        measuredBurnPerRunPct: a.measuredBurnPerRunPct > 0 ? a.measuredBurnPerRunPct : null,
        burnPerRunPct: null, runsInWindow: a.runsInWindow ?? null,
      };
    }
    // Unhealthy accounts allocate nothing, so their quota is not
    // sustainable concurrency: zero slots, same shape as the guard branch.
    if (a.healthy === false) {
      return {
        accountId: a.accountId, slots: 0, runsPerHour: 0, capped: true, reason: 'excluded', calibrated: false,
        measuredBurnPerRunPct: a.measuredBurnPerRunPct > 0 ? a.measuredBurnPerRunPct : null,
        burnPerRunPct: null, runsInWindow: a.runsInWindow ?? null,
      };
    }
    const needPerHour = a.hoursToReset > 0 ? a.remainingPct / a.hoursToReset : 0;
    const measured = a.measuredBurnPerRunPct;
    let burn = measured > 0 ? measured : a.burnPerRunPct;
    if (!(burn > 0)) {
      return {
        accountId: a.accountId, slots: 0, runsPerHour: 0, capped: true, reason: 'uncalibrated', calibrated: false,
        measuredBurnPerRunPct: null, burnPerRunPct: a.burnPerRunPct ?? null, runsInWindow: a.runsInWindow ?? null,
      };
    }
    const calibrated = measured > 0;
    const anchorCapped = !calibrated && medianMeasured != null && burn < medianMeasured;
    if (anchorCapped) burn = medianMeasured;
    const runsPerHour = needPerHour / burn;
    return {
      accountId: a.accountId, slots: runsPerHour * D, runsPerHour, capped: false,
      reason: calibrated ? 'ok' : 'anchor-fallback', calibrated,
      anchorCapped,
      measuredBurnPerRunPct: calibrated ? measured : null, burnPerRunPct: burn,
      runsInWindow: a.runsInWindow ?? null,
    };
  });
  if (!anyMeasured) {
    return {
      target: null, raw: 0, maxTotal, demandFactor, meanRunDurationHours: D,
      calibration: 'weak', perAccount,
    };
  }
  // Per-role usable capacity. A role's view of an account is its slots when
  // an arm is reachable, clipped to the trial cap when only trial arms are.
  const demand = {};
  let demandTotal = 0;
  for (const r of ROLES) {
    const d = Math.max(0, Number(roleDemand?.[r]) || 0);
    demand[r] = d;
    demandTotal += d;
  }
  const accessOf = (accountId, role) => {
    const entry = roleAccess?.[accountId];
    if (entry == null) return { eligible: true, trialOnly: false };
    return entry[role] ?? { eligible: false, trialOnly: false };
  };
  const roleSlots = Object.fromEntries(ROLES.map(r => [r, { slots: 0, accounts: 0 }]));
  for (const row of perAccount) {
    const eligibleRoles = ROLES.filter(r => accessOf(row.accountId, r).eligible);
    row.eligibleRoles = eligibleRoles;
    const weight = row.slots > 0 && eligibleRoles.length > 0 ? 1 : 0;
    // Trial-only: every eligible role can only reach trial arms.
    row.trialOnly = eligibleRoles.length > 0 && eligibleRoles.every(r => accessOf(row.accountId, r).trialOnly);
    let usable = row.slots * weight;
    if (row.trialOnly) usable = Math.min(usable, Math.max(0, trialSlotCap));
    row.usableSlots = usable;
    for (const r of eligibleRoles) {
      if (!(row.slots > 0)) continue;
      const cap = accessOf(row.accountId, r).trialOnly ? Math.max(0, trialSlotCap) : Infinity;
      roleSlots[r].slots += Math.min(row.slots, cap);
      roleSlots[r].accounts += 1;
    }
  }
  const measuredCount = perAccount.filter(a => a.calibrated).length;
  const slotsTotal = perAccount.reduce((sum, a) => sum + a.slots, 0) * demandFactor;
  const raw = perAccount.reduce((sum, a) => sum + a.usableSlots, 0) * demandFactor;
  const target = Math.min(raw, maxTotal);
  // In-flight runs join the bound's demand per role (never the target: the
  // target counts usable capacity, which does not move with the queue). A
  // queued-only bound can otherwise read below the running total and shed
  // work that already exists.
  const boundDemand = Object.fromEntries(ROLES.map(r => [
    r, demand[r] + Math.max(0, Number(roleRunning?.[r]) || 0),
  ]));
  const demandBound = demandTotal > 0 ? roleDemandBound(perAccount, boundDemand, demandFactor) : null;
  return {
    target, raw, slotsTotal, demandBound, maxTotal, demandFactor, meanRunDurationHours: D,
    medianMeasuredBurnPct: medianMeasured,
    roles: Object.fromEntries(ROLES.map(r => [r, { demand: demand[r], slots: roleSlots[r].slots, accounts: roleSlots[r].accounts }])),
    calibration: measuredCount === perAccount.filter(a => !a.capped).length ? 'measured' : 'partial',
    perAccount,
  };
}

/**
 * Most runs that can be in flight at once when role r runs at most demand[r]
 * and account a funds at most a.usableSlots x factor, an account serving only
 * its eligible roles. A transportation problem; by max-flow/min-cut it equals
 * the minimum over role subsets R of
 *   sum(demand[r], r in R) + sum(capacity of accounts with a role outside R).
 * Three roles make that eight subsets. Accounts with no eligible role add
 * nothing.
 */
export function roleDemandBound(rows, demand, factor = 1) {
  let best = Infinity;
  for (let mask = 0; mask < (1 << ROLES.length); mask++) {
    let cut = 0;
    ROLES.forEach((r, i) => { if (mask & (1 << i)) cut += demand[r]; });
    for (const row of rows) {
      if (!(row.usableSlots > 0)) continue;
      if ((row.eligibleRoles ?? []).some(r => !(mask & (1 << ROLES.indexOf(r))))) cut += row.usableSlots * factor;
    }
    if (cut < best) best = cut;
  }
  return best;
}

/**
 * Spread an integer slot target across agents weighted by queued work.
 *
 * demands: [{ agentId, queued }] (queued = assigned non-terminal issues).
 * Only agents with queued > 0 are active and each gets a floor of 1; the
 * remainder splits by largest remainder on queued weights. The total never
 * exceeds maxTotal; when more agents are active than fit, the top agents by
 * queued count keep 1 each. A null target (weak calibration, nothing
 * recommended) returns []. A non-positive target is an explicit shed:
 * every active agent gets 0.
 */
export function distributeWeightedCaps(target, demands, maxTotal = 75) {
  const active = (demands ?? [])
    .filter(d => d && typeof d.agentId === 'string' && d.agentId.length > 0 && (d.queued ?? 0) > 0)
    .sort((a, b) => (b.queued - a.queued) || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  if (active.length === 0) return [];
  const cap = Math.max(1, Math.floor(maxTotal));
  if (target == null) return [];
  if (!(target > 0)) return active.map(a => ({ agentId: a.agentId, maxConcurrentRuns: 0 }));
  // Floors first: the total grows to fit every active agent's floor of 1
  // (unless more agents are active than the ceiling allows).
  let total = Math.min(Math.max(Math.round(target), active.length), cap);
  if (active.length > cap) {
    return active.slice(0, cap).map(a => ({ agentId: a.agentId, maxConcurrentRuns: 1 }));
  }
  const queuedTotal = active.reduce((s, a) => s + a.queued, 0);
  let remainder = total - active.length;
  const extras = new Array(active.length).fill(0);
  if (remainder > 0 && queuedTotal > 0) {
    const frac = active.map((a, i) => ({ i, share: (remainder * a.queued) / queuedTotal }));
    const base = frac.map(f => Math.floor(f.share));
    let given = 0;
    for (let i = 0; i < base.length; i++) { extras[i] = base[i]; given += base[i]; }
    const order = frac
      .map((f, i) => ({ i, rest: f.share - base[i], queued: active[i].queued, id: active[i].agentId }))
      .sort((a, b) => (b.rest - a.rest) || (b.queued - a.queued) || (a.id < b.id ? -1 : 1));
    let left = remainder - given;
    for (const o of order) {
      if (left <= 0) break;
      extras[o.i] += 1;
      left -= 1;
    }
  }
  return active.map((a, i) => ({ agentId: a.agentId, maxConcurrentRuns: 1 + extras[i] }));
}

/**
 * Demand-aware per-agent caps. Demand is current, never historical:
 * demand = running + queued. Below the fleet target there is no throttle
 * pressure, so every agent covers its full demand (idlers keep running+1
 * headroom) -- a cap below running would throttle work that already exists
 * while the fleet idles -- but only while the want-sum fits the fleet
 * ceiling: a wider spike shares the ceiling out instead. Every shed is
 * running-first: each agent keeps its running count, then only the
 * remaining new slots split by demand share (largest remainder). Floors
 * therefore cannot overshoot the split (running is subtracted before
 * splitting, never floored after): at/above target the fleet starts
 * nothing new, and only pre-existing running can hold a total over the
 * split or ceiling. Reported as-is, never hidden.
 *
 * agents: [{ agentId, running, queued, overPace }].
 * Returns [{ agentId, demand, running, queued, allocated, maxConcurrentRuns,
 * reason }] with reason in full-demand | headroom | proportional |
 * floor-running | capped-ceiling. maxConcurrentRuns mirrors allocated for
 * the existing /caps consumer.
 */
export function allocateDemandCaps(target, agents, maxTotal = 75) {
  const list = (agents ?? [])
    .filter(a => a && typeof a.agentId === 'string' && a.agentId.length > 0)
    .map(a => ({
      agentId: a.agentId,
      running: Math.max(0, Math.floor(a.running ?? 0)),
      queued: Math.max(0, Math.floor(a.queued ?? 0)),
      overPace: a.overPace === true,
    }))
    .filter(a => a.running + a.queued > 0)
    .sort((x, y) => ((y.running + y.queued) - (x.running + x.queued)) || (x.agentId < y.agentId ? -1 : 1));
  if (list.length === 0 || target == null) return [];
  const ceiling = Math.max(1, Math.floor(maxTotal));
  const T = Math.max(0, Math.round(target));
  const totalRunning = list.reduce((s, a) => s + a.running, 0);
  const out = list.map(a => ({ ...a, demand: a.running + a.queued, allocated: 0, reason: 'proportional' }));
  // The ceiling never undercuts running: a cap below running is fiction.
  const applyCeiling = (e, computed, reason) => {
    if (computed <= ceiling) { e.allocated = computed; e.reason = reason; }
    else if (ceiling <= e.running) { e.allocated = e.running; e.reason = 'floor-running'; }
    else { e.allocated = ceiling; e.reason = 'capped-ceiling'; }
  };
  // Running-first shed shared by the at/above-target branch and the
  // below-target queue-spike fallback: every agent keeps its running count,
  // then only R = max(0, S - totalRunning) NEW slots split by demand share
  // (largest remainder). Subtracting running before splitting (instead of
  // flooring after) means floored agents never inflate the others' shares:
  // at/above target R = 0 and the fleet starts nothing new. S clamps to the
  // ceiling here (unconditional fleet bound, like the predecessor;
  // production C* arrives pre-clamped anyway); the per-agent ceiling in
  // applyCeiling stays as backstop. The old over-pace trim is retired: with
  // running subtracted first every trim candidate is already at running,
  // so there is nothing left to trim (and the below-target fallback skips
  // it per review). Only pre-existing running can hold a total over S.
  const shedProportionally = (S) => {
    S = Math.min(S, ceiling);
    const R = Math.max(0, S - totalRunning);
    // New slots follow UNSATISFIED demand (queued + 1 so an idle agent keeps
    // its running+1 headroom claim): weighting by full demand would let
    // already-held running outshout real queue, starving the agents that
    // actually wait while over-feeding agents past their own want.
    const needWeights = out.map(e => e.queued + 1);
    const needTotal = needWeights.reduce((s, w) => s + w, 0);
    const extras = needTotal > 0 ? largestRemainder(R, needWeights) : out.map(() => 0);
    out.forEach((e, i) => applyCeiling(e, e.running + extras[i], 'proportional'));
  };
  if (T <= 0) {
    // Explicit shed: hold running, start nothing.
    for (const e of out) { e.allocated = e.running; e.reason = 'floor-running'; }
  } else if (totalRunning < T) {
    const wants = out.map(e => Math.max(e.demand, e.running + 1));
    // A lone spike can still be capped per-agent under the ceiling (keeps
    // the capped-ceiling label); a fleet-wide spike sheds proportionally.
    const cappedWants = wants.map(w => Math.min(w, ceiling));
    if (cappedWants.reduce((s, w) => s + w, 0) <= ceiling) {
      out.forEach((e, i) => applyCeiling(e, wants[i], e.demand >= e.running + 1 ? 'full-demand' : 'headroom'));
    } else {
      // Fleet-wide queue spike: full demand would overshoot the fleet
      // ceiling, so share the CEILING out (not the target -- one more
      // queued item must never halve the fleet) instead of treating
      // maxTotal as per-agent. Running kept first, as above.
      shedProportionally(ceiling);
    }
  } else {
    shedProportionally(T);
  }
  return out.map(e => ({
    agentId: e.agentId, demand: e.demand, running: e.running, queued: e.queued,
    allocated: e.allocated, maxConcurrentRuns: e.allocated, reason: e.reason,
  }));
}

/**
 * Reserved per-agent floor: `min(demand, clamp(base + floor(queued /
 * perQueued), base, max))` with demand = running + queued. Config-only and
 * empty by default; the operator sets entries under `caps.reservedFloors`.
 * Returns null for a missing or invalid spec (the validator reports those;
 * the allocator ignores them), so an unset floor never moves a cap.
 */
export function computeReservedFloor(running, queued, spec) {
  const r = Math.max(0, Math.floor(running ?? 0));
  const q = Math.max(0, Math.floor(queued ?? 0));
  const base = spec?.base;
  const perQueued = spec?.perQueued;
  const max = spec?.max;
  if (!Number.isInteger(base) || base < 0) return null;
  if (!Number.isInteger(perQueued) || perQueued < 1) return null;
  if (!Number.isInteger(max) || max < base) return null;
  const clamped = Math.min(Math.max(base + Math.floor(q / perQueued), base), max);
  return Math.min(r + q, clamped);
}

/**
 * Apply reserved floors LAST: after allocateDemandCaps and after the
 * holdCaps hysteresis, so smoothing never takes a cap below a floor.
 *
 * entries: allocateDemandCaps()/holdCaps output. reservedFloors:
 * `{ [agentId]: { base, perQueued, max } }` (already sanitized; invalid
 * entries are ignored). blockedAgentIds: agents whose floor is suspended
 * while every arm they can use is breaker-open -- their cap holds where the
 * allocator put it (never below running), and the floor stays visible for
 * audit. Returns `{ entries, applied, floors }` where `applied` lists the
 * lifted agents and `floors` maps each configured agent to
 * `{ floor, applied, blocked }`.
 *
 * Floors win the ceiling: when floors push the sum over it, agents give back
 * only slots above their protection line (largest first, one slot at a
 * time) -- max(floor, running) for configured, non-suspended agents,
 * running for everyone else (a cap under running is fiction). Floored agents
 * are never cut below their floor; when even running plus floors hold the
 * total over the ceiling it reports as-is, like running does today.
 */
export function applyReservedFloors(entries, { reservedFloors = {}, ceiling = 75, blockedAgentIds = [] } = {}) {
  const list = (entries ?? []).map(e => ({ ...e }));
  const specs = new Map(Object.entries(reservedFloors ?? {}));
  const blocked = new Set(blockedAgentIds ?? []);
  const cap = Math.max(1, Math.floor(ceiling ?? 75));
  const applied = [];
  // Map accumulator, same '__proto__' discipline as the allocator above:
  // agentIds are host strings, and indexing a plain object with
  // '__proto__' would hit the prototype setter. fromEntries at the end
  // defines own data properties, so the snapshot reads back safely.
  const floorMap = new Map();
  for (const e of list) {
    if (typeof e.agentId !== 'string' || e.agentId.length === 0) continue;
    if (!specs.has(e.agentId)) continue;
    const floor = computeReservedFloor(e.running, e.queued, specs.get(e.agentId));
    if (floor == null) continue;
    const summary = { floor, applied: false, blocked: false };
    floorMap.set(e.agentId, summary);
    if (blocked.has(e.agentId)) {
      e.floor = floor;
      e.floorBlocked = true;
      summary.blocked = true;
      continue;
    }
    e.floor = floor;
    if (floor > e.allocated) {
      e.allocated = floor;
      e.maxConcurrentRuns = floor;
      e.reason = 'reserved-floor';
      applied.push(e.agentId);
      summary.applied = true;
    }
  }
  // Fleet bound: floors win. Every configured, non-suspended agent is
  // protected down to max(floor, running) -- not just the agents the floor
  // lifted (one already at or above its floor can otherwise be cut below
  // it) -- and every other agent down to its running count (a cap under
  // running is fiction). Only slots above that line are given back, largest
  // first, one slot at a time.
  const sum = () => list.reduce((s, e) => s + e.allocated, 0);
  const protectLine = (e) => {
    const summary = floorMap.get(e.agentId);
    const running = Math.max(0, Math.floor(e.running ?? 0));
    if (summary && !summary.blocked && summary.floor != null) return Math.max(summary.floor, running);
    return running;
  };
  let guard = list.length * 400;
  while (sum() > cap && guard-- > 0) {
    let best = -1;
    let bestNew = 0;
    for (let i = 0; i < list.length; i++) {
      const fresh = list[i].allocated - protectLine(list[i]);
      if (fresh > bestNew) { best = i; bestNew = fresh; }
    }
    if (best < 0) break;
    list[best].allocated -= 1;
    list[best].maxConcurrentRuns = list[best].allocated;
  }
  return { entries: list, applied, floors: Object.fromEntries(floorMap) };
}

/** Integer split of total by weights, largest remainder, index-stable. */
function largestRemainder(total, weights) {
  const wTotal = weights.reduce((s, w) => s + w, 0);
  if (wTotal <= 0) return weights.map(() => 0);
  const raw = weights.map(w => (total * w) / wTotal);
  const base = raw.map(Math.floor);
  let left = total - base.reduce((s, b) => s + b, 0);
  const extra = new Array(weights.length).fill(0);
  const order = raw
    .map((r, i) => ({ i, rest: r - base[i], w: weights[i] }))
    .sort((a, b) => (b.rest - a.rest) || (b.w - a.w) || (a.i - b.i));
  for (const o of order) {
    if (left <= 0) break;
    extra[o.i] += 1;
    left -= 1;
  }
  return base.map((b, i) => b + extra[i]);
}

/** Spread an integer slot target across agents with queued/ready work. */
export function distributeCaps(target, agentIds) {
  const ids = [...new Set(agentIds ?? [])].sort();
  if (ids.length === 0 || !(target > 0)) return [];
  const total = Math.max(1, Math.round(target));
  const base = Math.floor(total / ids.length);
  let remainder = total - base * ids.length;
  return ids.map(agentId => {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    return { agentId, maxConcurrentRuns: base + extra };
  });
}
