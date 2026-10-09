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
 * Ranking is water-filling inside need bands. Bands come first (they encode
 * proven need): metered-behind-plan (band 0), then reactive (band 1: no
 * required rate, so it cannot prove need, but use-it-or-lose-it with
 * unknown size still beats burning quota against the plan), then
 * metered-ahead-of-plan and over-burning (band 2, last). Inside a band the
 * hungriest SHORTFALL wins --
 *
 *   shortfall = targetShare - inFlight,  targetShare = requiredRate / E
 *
 * (same term as the per-account C* concurrency target; proportions match
 * because every share scales by the same mean run duration). Each decision
 * lands on the largest shortfall, so sequential decisions spread across
 * accounts in proportion to their target shares instead of herding onto one
 * argmax winner. Unknown targets count as 0, so unknown-rate accounts
 * spread idle-first. Remaining ties break by deficit --
 *
 *   deficit = (requiredRate - measuredRate) / requiredRate
 *
 * (positive = behind schedule; negative = ahead; unknown rates score 0) --
 * then earliest reset, then accountId.
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
 * Water-filling shortfall: target share minus in-flight runs. The target
 * share is requiredRate / E (runs/hour the account can sustain; proportions
 * match the per-account C* concurrency targets, which scale every share by
 * the same mean run duration). Null/unknown targets count as 0, so
 * unknown-rate and reactive accounts spread idle-first.
 */
export function shortfallOf(view) {
  const t = view?.targetShare;
  const target = (t != null && t > 0) ? t : 0;
  return target - (view?.inFlight ?? 0);
}

/**
 * Order account views for one run.
 * views: [{ accountId, resetAtMs, headroomPct (0-1 or null),
 *   measuredRatePerHour (nullable), requiredRatePerHour (nullable),
 *   targetShare (nullable runs/hour; requiredRate / E),
 *   health ('healthy' to qualify), meter/quality (reactive detection),
 *   inFlight (running runs mapped to the account's pool PLUS decisions
 *   already made this tick -- callers re-sort per run with fresh counts) }]
 * Unhealthy accounts and metered accounts without headroom are dropped;
 * healthy reactive accounts qualify without headroom.
 *
 * Sort: need band, then water-filling shortfall (largest first), then
 * deficit, then earliest reset, then accountId. Re-sorting with updated
 * in-flight after every decision is what spreads load: a static order
 * re-used across runs herds every decision onto the same winner.
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
    (shortfallOf(b) - shortfallOf(a)) ||
    (deficitOf(b) - deficitOf(a)) ||
    ((a.resetAtMs ?? Number.MAX_SAFE_INTEGER) - (b.resetAtMs ?? Number.MAX_SAFE_INTEGER)) ||
    (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0),
  );
}
