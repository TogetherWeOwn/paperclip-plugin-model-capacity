/**
 * Fleet concurrency target from burn need (Little's law).
 *
 * Per account: runs/hour that must be sustained to land at ~100% exactly
 * at reset is needPerHour / burnPerRun, where needPerHour = remaining / hours
 * to reset and burnPerRun (E_a[mix]) is the measured weekly % one run
 * consumes at the account's current rung mix, recalibrated from CLIProxy
 * usage deltas. Concurrent slots = runs/hour x mean run duration D.
 *
 * Guard-capped accounts contribute zero (their load is shed, not grown);
 * the total is capped by the 5h guard, host pressure (applied by the
 * caller as a derate), and a configured hard ceiling.
 */

export const DEFAULT_CONCURRENCY = Object.freeze({
  maxTotal: 75,
  meanRunDurationHours: 1 / 3,
  demandFactor: 1,
});

/**
 * accounts: [{ accountId, remainingPct (0-1), hoursToReset,
 *   burnPerRunPct, guardActive }]
 */
export function computeConcurrencyTarget({ accounts, meanRunDurationHours, demandFactor = 1, maxTotal = 75 } = {}) {
  const D = meanRunDurationHours ?? DEFAULT_CONCURRENCY.meanRunDurationHours;
  const perAccount = (accounts ?? []).map(a => {
    if (a.guardActive) {
      return { accountId: a.accountId, slots: 0, runsPerHour: 0, capped: true, reason: '5h-guard' };
    }
    const needPerHour = a.hoursToReset > 0 ? a.remainingPct / a.hoursToReset : 0;
    const burn = a.burnPerRunPct;
    if (!(burn > 0)) {
      return { accountId: a.accountId, slots: 0, runsPerHour: 0, capped: true, reason: 'uncalibrated' };
    }
    const runsPerHour = needPerHour / burn;
    return { accountId: a.accountId, slots: runsPerHour * D, runsPerHour, capped: false, reason: 'ok' };
  });
  const raw = perAccount.reduce((sum, a) => sum + a.slots, 0) * demandFactor;
  const target = Math.min(raw, maxTotal);
  return { target, raw, maxTotal, demandFactor, meanRunDurationHours: D, perAccount };
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
