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
 * lanes: [{ planAhead (nullable), targetShare (nullable), inFlight (pooled),
 *   paceInFlight (optional override of inFlight for the cap check),
 *   meter/quality (reactive detection) }]
 * pacing: { enabled, marginPct, meanRunDurationHours } or null
 * Returns one entry per pool (`key` is the caller's poolKeyOf value):
 *   { key, pool, lanes, planAhead, pacedSlots, cap, inFlight, ahead, paced, state }
 * with state 'paced' | 'ahead' (over plan, under the cap) | 'on-plan' |
 * 'not-measured' (fail open) | 'off'.
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
  for (const [key, members] of groups) {
    const pool = members[0]?.pool ?? key;
    // paceInFlight, when given, is the pooled count without the run being
    // decided (callers whose inFlight still includes it); else inFlight.
    const inFlight = Math.max(0, ...members.map(v => {
      const n = finite(v.paceInFlight) ? v.paceInFlight : v.inFlight;
      return finite(n) ? n : 0;
    }));
    const entry = {
      key, pool, lanes: members.length, planAhead: null, pacedSlots: null, cap: null,
      inFlight, ahead: false, paced: false, state: enabled ? 'not-measured' : 'off',
    };
    out.push(entry);
    if (!enabled) continue;
    if (members.some(isReactiveAccount)) continue;
    // One lane of unknown position or share makes the whole pool unmeasured:
    // leaving it out would size the cap from the other lanes alone and
    // throttle a pool whose real capacity is not known.
    const positions = members.map(v => v.planAhead);
    const shares = members.map(v => v.targetShare);
    const hours = pacing.meanRunDurationHours;
    if (!positions.every(finite) || !shares.every(s => finite(s) && s >= 0) || !(finite(hours) && hours > 0)) continue;
    entry.planAhead = mean(positions);
    entry.pacedSlots = shares.reduce((s, x) => s + x, 0) * hours;
    // The epsilon keeps an exact integer of slots from rounding up on
    // float noise (0.2 x 10 is 2.0000000000000004).
    entry.cap = Math.max(1, Math.ceil(entry.pacedSlots - 1e-9));
    entry.ahead = entry.planAhead > pacing.marginPct;
    entry.paced = entry.ahead && inFlight >= entry.cap;
    entry.state = entry.paced ? 'paced' : entry.ahead ? 'ahead' : 'on-plan';
  }
  return out;
}
