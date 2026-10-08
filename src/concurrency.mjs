/**
 * Fleet concurrency target from MEASURED burn need (Little's law).
 *
 * C* = sum(requiredRate_a / E_a) x D: per account, the required weekly
 * fraction per hour divided by the measured weekly fraction one run
 * consumes (E_a, calibrated from lane usage deltas over runs that ran on
 * the account), times mean run duration D. Guard-capped accounts contribute
 * zero (their load is shed, not grown); the total is capped by a
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
 *   guardActive }]
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
