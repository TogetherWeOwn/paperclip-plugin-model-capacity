/**
 * Pace guard (pure): a hard in-flight cap for a provider pool that has spent
 * ahead of its linear weekly plan.
 *
 * Ordering alone never stops spend. `orderAccountsForRun` sorts an ahead
 * account into the last need band, but when every account that can serve a
 * run is ahead it still picks one, so a fleet ahead of plan keeps burning
 * (a Claude lane went 78% to 90% in two hours). The guard adds the missing
 * brake. Per pool (lanes that share one credential bucket, so in-flight
 * pressure is real only at the pool):
 *
 *   ahead  = mean(weeklyUsed - elapsedFraction) over the pool's lanes > margin
 *   slots  = sum over lanes of targetShare x meanRunDurationHours
 *            (the same term as the per-account concurrency target)
 *   cap    = max(1, ceil(slots))
 *
 * A pool that is ahead and already has `cap` runs in flight is PACED: its
 * lanes leave the allocation order, so the run goes to another pool or, when
 * every pool is paced, is deferred. Below the cap, or when not ahead, the
 * guard changes nothing.
 *
 * Fail open: a pool with any lane of unknown plan position or share, whose
 * lanes include a reactive (unmetered) account, or that has no run duration
 * to convert shares into slots is never paced; the existing caps apply. The
 * minimum of 1 in flight keeps a lightly-ahead account serving instead of
 * stalling it; the price is that a deeply-ahead account (slots below 1) can
 * spend above plan until its headroom reserve takes it out.
 */

import { isReactiveAccount } from './cliproxy.mjs';

export const DEFAULT_PACE_GUARD = Object.freeze({
  enabled: true,
  /** Lead on the linear plan (fraction of the weekly quota) tolerated before the cap applies. */
  marginPct: 0.02,
  /**
   * Retry hint when the hook defers because every pool is paced. Longer than
   * the plain no-headroom retry: the host abandons a run after a fixed number
   * of deferrals, and a slot frees on the scale of a run (minutes), not a tick.
   */
  retryAfterMs: 300000,
});

/** Config knobs coerced to valid values; anything invalid reads as the default. */
export function normalizePaceGuard(raw) {
  const r = raw != null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const margin = r.marginPct;
  const retry = r.retryAfterMs;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_PACE_GUARD.enabled,
    marginPct: typeof margin === 'number' && Number.isFinite(margin) && margin >= 0 && margin <= 1
      ? margin : DEFAULT_PACE_GUARD.marginPct,
    retryAfterMs: Number.isInteger(retry) && retry >= 1000 ? retry : DEFAULT_PACE_GUARD.retryAfterMs,
  };
}

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * Per-pool verdicts over the QUALIFIED lanes (the caller has already dropped
 * unhealthy lanes and metered lanes without headroom).
 *
 * lanes: [{ accountId, planAhead (nullable), targetShare (nullable),
 *   inFlight (pooled), laneInFlight (optional, this lane's own count),
 *   paceInFlight (optional override of inFlight for the cap check),
 *   burn (optional: burn-mode lane, never paced or counted),
 *   meter/quality (reactive detection) }]
 * pacing: { enabled, marginPct, meanRunDurationHours } or null
 * Returns one entry per pool (`key` is the caller's poolKeyOf value):
 *   { key, pool, lanes, planAhead, pacedSlots, cap, inFlight, ahead, paced,
 *     state, pacedAccountIds, burnAccountIds, laneVerdicts }
 * with state 'paced' (every metered lane held) | 'lanes-paced' (ahead lanes
 * held, behind-plan lanes still serve) | 'ahead' (over plan, under the cap) |
 * 'on-plan' | 'burn' (every lane is in burn mode: unpaced) |
 * 'not-measured' (fail open) | 'off'.
 *
 * Per-lane plan (0.2.53): the pool used to be judged on the MEAN plan
 * position of its lanes, so one spent lane (claude-lane-3 at 99%) hid a lane
 * far behind its own plan (claude-lane-4 at 11% with 4.6 days left) and the
 * whole pool capped at one run. Now each lane is judged on its OWN position:
 *
 *   laneSlots_i = targetShare_i x meanRunDurationHours
 *   allowance_i = laneSlots_i            (lane ahead of its plan)
 *               = max(1, laneSlots_i)    (lane on or behind plan: full fair share)
 *   cap         = max(1, ceil(sum allowance_i))
 *
 * Only lanes ahead of their own plan are held once the pool's in-flight
 * count reaches the cap; a lane behind its plan is never throttled by other
 * lanes' over-use. A single-lane pool reads exactly as before (one lane:
 * ahead -> cap max(1, ceil(slots)); on plan -> never paced).
 *
 * Burn mode: lanes flagged `burn` leave the aggregation entirely (their
 * position, share and own in-flight count) and are never held. A pool whose
 * every lane burns is unpaced (cap null, state 'burn').
 */
export function paceGuardPools(lanes, { pacing = null, poolKeyOf } = {}) {
  const groups = new Map();
  for (const v of lanes ?? []) {
    const k = poolKeyOf(v);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(v);
  }
  const enabled = pacing?.enabled === true;
  const out = [];
  for (const [key, all] of groups) {
    const pool = all[0]?.pool ?? key;
    const burners = all.filter(v => v?.burn === true);
    const members = burners.length > 0 ? all.filter(v => v?.burn !== true) : all;
    // paceInFlight, when given, is the pooled count without the run being
    // decided (callers whose inFlight still includes it); else inFlight.
    const pooled = Math.max(0, ...all.map(v => {
      const n = finite(v.paceInFlight) ? v.paceInFlight : v.inFlight;
      return finite(n) ? n : 0;
    }));
    // Burn lanes' own runs are theirs to spend: they never count against
    // the cap of the lanes that still pace.
    const burnInFlight = burners.reduce((s, v) => s + (finite(v.laneInFlight) && v.laneInFlight > 0 ? v.laneInFlight : 0), 0);
    const inFlight = Math.max(0, pooled - burnInFlight);
    const entry = {
      key, pool, lanes: all.length, planAhead: null, pacedSlots: null, cap: null,
      inFlight, ahead: false, paced: false, state: enabled ? 'not-measured' : 'off',
      pacedAccountIds: [],
    };
    if (burners.length > 0) {
      entry.burnAccountIds = burners.map(v => v.accountId);
      entry.burnInFlight = burnInFlight;
    }
    out.push(entry);
    if (!enabled) continue;
    if (members.length === 0) { entry.state = 'burn'; continue; }
    if (members.some(isReactiveAccount)) continue;
    // One lane of unknown position or share makes the whole pool unmeasured:
    // leaving it out would size the cap from the other lanes alone and
    // throttle a pool whose real capacity is not known.
    const positions = members.map(v => v.planAhead);
    const shares = members.map(v => v.targetShare);
    const hours = pacing.meanRunDurationHours;
    if (!positions.every(finite) || !shares.every(s => finite(s) && s >= 0) || !(finite(hours) && hours > 0)) continue;
    const laneVerdicts = members.map(v => {
      const slots = v.targetShare * hours;
      const ahead = v.planAhead > pacing.marginPct;
      return { accountId: v.accountId, planAhead: v.planAhead, pacedSlots: slots, allowance: ahead ? slots : Math.max(1, slots), ahead, paced: false };
    });
    entry.planAhead = mean(positions);
    entry.pacedSlots = shares.reduce((s, x) => s + x, 0) * hours;
    const single = members.length === 1;
    const allowance = single ? entry.pacedSlots : laneVerdicts.reduce((s, l) => s + l.allowance, 0);
    // The epsilon keeps an exact integer of slots from rounding up on
    // float noise (0.2 x 10 is 2.0000000000000004).
    entry.cap = Math.max(1, Math.ceil(allowance - 1e-9));
    entry.ahead = laneVerdicts.some(l => l.ahead);
    const atCap = inFlight >= entry.cap;
    if (entry.ahead && atCap) {
      for (const l of laneVerdicts) if (l.ahead) l.paced = true;
    }
    entry.pacedAccountIds = laneVerdicts.filter(l => l.paced).map(l => l.accountId);
    entry.paced = entry.pacedAccountIds.length > 0 && entry.pacedAccountIds.length === members.length;
    if (!single) entry.laneVerdicts = laneVerdicts;
    entry.state = entry.paced ? 'paced'
      : entry.pacedAccountIds.length > 0 ? 'lanes-paced'
        : entry.ahead ? 'ahead' : 'on-plan';
  }
  return out;
}
