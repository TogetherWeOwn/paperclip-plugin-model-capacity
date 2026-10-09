/**
 * Deficit-based account selection (pure; used by the shadow tick, the
 * event-time shadow path, and the memory-only resolve hook alike, so
 * observation and enforcement agree).
 *
 * Eligibility first: health must read exactly 'healthy' (CISO rule --
 * unknown/unavailable/exhausted/degraded accounts never qualify), and
 * metered accounts need known 5h headroom above the reserve. Reactive
 * accounts (vendor publishes no meter: no weekly numbers at all) carry no
 * headroom signal; a healthy reactive account qualifies WITHOUT headroom.
 * This is deliberately different from the CISO unknown-headroom case (a
 * METERED account whose 5h signal is missing -- that stays excluded,
 * because a meter that should exist but doesn't means the reading, not
 * the quota, is broken).
 *
 * Ranking: the hungriest metered account first --
 *
 *   deficit = (requiredRate - measuredRate) / requiredRate
 *
 * (positive = behind schedule; negative = ahead). Unknown measured rates
 * score deficit 0: behind hungry accounts, ahead of over-served ones.
 * Earliest reset breaks ties; accountId breaks those. Reactive accounts
 * rank AFTER every metered account that is behind plan (they have no
 * required rate, so they cannot prove need) but BEFORE any metered
 * account that is ahead of plan (burning quota with no signal beats
 * burning quota against the plan): use-it-or-lose-it with unknown size.
 * Over-burning metered accounts sort last, so they get no new marginal
 * runs unless nothing else qualifies.
 */

import { isReactiveAccount } from './cliproxy.mjs';

/** Normalized burn deficit; 0 when either rate is unknown or required <= 0. */
export function deficitOf(view) {
  const measured = view?.measuredRatePerHour;
  const required = view?.requiredRatePerHour;
  if (measured == null || required == null || !(required > 0)) return 0;
  return (required - measured) / required;
}

/** True when the account burns above required x (1 + deadband). Unknown rates never count. */
export function isOverBurning(view, rateDeadbandRel = 0.15) {
  const measured = view?.measuredRatePerHour;
  const required = view?.requiredRatePerHour;
  if (measured == null || required == null || !(required > 0)) return false;
  return measured > required * (1 + rateDeadbandRel);
}

/**
 * Order account views for one run.
 * views: [{ accountId, resetAtMs, headroomPct (0-1 or null),
 *   measuredRatePerHour (nullable), requiredRatePerHour (nullable),
 *   health ('healthy' to qualify), meter/quality (reactive detection),
 *   inFlight (running runs, tie-break inside the reactive band) }]
 * Unhealthy accounts and metered accounts without headroom are dropped;
 * healthy reactive accounts qualify without headroom.
 */
export function orderAccountsForRun(views, { reservePct = 0.05, rateDeadbandRel = 0.15 } = {}) {
  const qualified = (views ?? []).filter(v => {
    if (v == null || v.health !== 'healthy') return false;
    if (isReactiveAccount(v)) return true;
    return v.headroomPct != null && v.headroomPct > reservePct;
  });
  const bandOf = (v) => {
    if (isReactiveAccount(v)) return 1;
    // Ahead-of-plan metered accounts sort with the over-burning: burning
    // quota against the plan loses to a reactive lane of unknown size.
    // Unknown-rate accounts score deficit 0 (not < 0), so they stay in band
    // 0: they prove neither need nor over-service.
    if (isOverBurning(v, rateDeadbandRel) || deficitOf(v) < 0) return 2;
    return 0;
  };
  const bandCmp = (a, b) => bandOf(a) - bandOf(b);
  return [...qualified].sort((a, b) =>
    bandCmp(a, b) ||
    (deficitOf(b) - deficitOf(a)) ||
    ((a.inFlight ?? 0) - (b.inFlight ?? 0)) ||
    ((a.resetAtMs ?? Number.MAX_SAFE_INTEGER) - (b.resetAtMs ?? Number.MAX_SAFE_INTEGER)) ||
    (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0),
  );
}
