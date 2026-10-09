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

/**
 * accounts: [{ accountId, remainingPct (0-1), hoursToReset,
 *   burnPerRunPct (anchor fallback), measuredBurnPerRunPct (E, nullable),
 *   guardActive, healthy (false excludes the account with reason
 *   'excluded'; absent counts as healthy) }]
 */
export function computeConcurrencyTarget({ accounts, meanRunDurationHours, demandFactor = 1, maxTotal = 75 } = {}) {
  const D = meanRunDurationHours ?? DEFAULT_CONCURRENCY.meanRunDurationHours;
  const list = accounts ?? [];
  // Guard decides slots (zero), not knowledge: a guard-capped account with a
  // measured E still counts as calibrated, so an all-guarded fleet reads
  // target 0 (shed everything) instead of weak/null (recommend nothing).
  const anyMeasured = list.some(a => a.measuredBurnPerRunPct > 0);
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
    const burn = measured > 0 ? measured : a.burnPerRunPct;
    if (!(burn > 0)) {
      return {
        accountId: a.accountId, slots: 0, runsPerHour: 0, capped: true, reason: 'uncalibrated', calibrated: false,
        measuredBurnPerRunPct: null, burnPerRunPct: a.burnPerRunPct ?? null, runsInWindow: a.runsInWindow ?? null,
      };
    }
    const runsPerHour = needPerHour / burn;
    const calibrated = measured > 0;
    return {
      accountId: a.accountId, slots: runsPerHour * D, runsPerHour, capped: false,
      reason: calibrated ? 'ok' : 'anchor-fallback', calibrated,
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
  const measuredCount = perAccount.filter(a => a.calibrated).length;
  const raw = perAccount.reduce((sum, a) => sum + a.slots, 0) * demandFactor;
  const target = Math.min(raw, maxTotal);
  return {
    target, raw, maxTotal, demandFactor, meanRunDurationHours: D,
    calibration: measuredCount === perAccount.filter(a => !a.capped).length ? 'measured' : 'partial',
    perAccount,
  };
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
