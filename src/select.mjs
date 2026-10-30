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
import { hasUsablePlanHeadroom } from './credits.mjs';
import { isFallbackOnlyView, nativeQualifiedModels } from './cross-account.mjs';
import { paceGuardPools } from './paceguard.mjs';
import { compareTaskCosts } from './task-cost.mjs';

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
 * Placement blend. Water-filling alone sends runs wherever
 * the most allowance is unspent, regardless of what the arm there can do:
 * 06:25-08:45Z two thirds of all runs went to Muse because Meta had the
 * most unspent allowance. Inside a need band the order is now
 *
 *   score = qualityWeight * placementQ + allowanceWeight * allowance
 *
 * where placementQ is the fleet-comparable quality (z-score) of the arm the
 * account would run for this role, and allowance is the pool's unspent
 * share on [-1, 1] (shortfall / max(1, pool target share)). The allowance
 * term spans at most 2 * allowanceWeight z-units, so unspent allowance
 * breaks ties between arms of similar quality and can never outbid a
 * quality gap wider than that. qualityWeight 0 (or no quality on any
 * candidate) restores the pure water-filling order.
 */
export const DEFAULT_PLACEMENT = Object.freeze({ qualityWeight: 1, allowanceWeight: 0.35 });

/** Unspent share of a pool's target on [-1, 1]. */
export function allowanceOf(shortfall, poolShare) {
  const denom = Math.max(1, Number.isFinite(poolShare) ? poolShare : 0);
  return Math.min(1, Math.max(-1, shortfall / denom));
}

/**
 * Order account views for one run.
 * views: [{ accountId, resetAtMs, headroomPct (0-1 or null),
 *   measuredRatePerHour (nullable), requiredRatePerHour (nullable),
 *   targetShare (nullable runs/hour; requiredRate / E),
 *   health ('healthy' to qualify), meter/quality (reactive detection),
 *   inFlight (running runs mapped to the account's pool PLUS decisions
 *   already made this tick -- callers re-sort per run with fresh counts),
 *   pool (optional: lanes that share one credential pool),
 *   laneInFlight (optional: this lane's own count, spreads decisions across
 *   a pool), placementQ (optional: fleet quality of the arm this account
 *   would run for the run's role),
 *   provider (optional: aggregator detection, e.g. 'devin'),
 *   models (optional: canonical-or-raw model ids served, for the
 *   aggregator fallback rule), fallbackOnly (optional precomputed
 *   aggregator fallback flag -- when absent and `models` is present it is
 *   derived: an aggregator serving only models a qualified native also
 *   serves), creditFallback (optional: credit-funded headroom, placed after
 *   plan headroom when `creditPriority: 'fallback'`), roleEligible (optional:
 *   whether the account can serve the current role), burn / burnFirst
 *   (optional: burn mode, and a burn account above its level floor) }]
 * Unhealthy accounts and metered accounts without headroom are dropped;
 * healthy reactive accounts qualify without headroom.
 *
 * Pools: lanes tagged with one `pool` are one placement candidate. Their
 * target shares sum and `inFlight` is the pooled count, so the shortfall is
 * the pool's (CLIProxy round-robins the lanes; comparing one lane's share
 * with the whole pool's in-flight made every wide pool look overfull).
 * Untagged views are their own pool, which is the old behavior.
 *
 * Sort: need band, then the placement blend (when quality is known), then
 * water-filling shortfall (largest first), then the lane with the fewest
 * in-flight, then deficit, then earliest reset, then accountId. With
 * creditPriority 'fallback', a qualified plan lane with usable headroom
 * sorts before every credit-funded lane; otherwise the prior ordering is preserved. Bands are
 * metered-behind (0), reactive (1), metered-ahead/over-burning (2), and
 * aggregator fallback-only (3, last). A fallback-only aggregator (Devin
 * serving only models a qualified native also serves; owner rule
 * 2026-09-17) loses to every need band; a Devin lane with a unique model
 * (swe-*, etc.) keeps band 1. Re-sorting with updated in-flight after every
 * decision is what spreads load: a static order re-used across runs herds
 * every decision onto the same winner.
 */
export function orderAccountsForRun(views, opts = {}) {
  return orderAccountsWithPacing(views, opts).order;
}

/**
 * orderAccountsForRun plus the pace guard (see paceguard.mjs): lanes of a
 * pool that is ahead of plan and already at its in-flight cap are dropped
 * from the order. Returns { order, paced, pools, reserveHeld }:
 *   order  the allocation order (same sort as before, paced pools removed)
 *   paced  the pools that were dropped, with the numbers that dropped them
 *   pools  every qualified pool's verdict (for reporting)
 *   reserveHeld  accounts the review reserve holds for non-review runs
 * opts.pacing = { enabled, marginPct, meanRunDurationHours } turns the guard
 * on; absent (null) it is off and `order` is exactly the old ordering. Views
 * may carry `planAhead` (weekly used minus the linear plan; null unknown) and
 * `held` (true: the lane may not route this pass; it still counts toward its
 * pool's verdict, so every pass sees the same pool membership).
 * Callers re-evaluate per run with fresh in-flight counts, so the cap
 * releases the moment a run finishes and the next call sees the lower count.
 *
 * opts.reviewReserve = { heldAccountIds, forReview }: the tick's review
 * reserve (see reviewreserve.mjs) holds named accounts for non-review runs,
 * so plugin-routed work leaves quota for the Reviewer. Review runs
 * (forReview true) see the unheld order; absent the option nothing is held.
 * opts.burnAccounts may supply the full burn inventory, including lanes not
 * eligible for this role, for pool pressure and burn identity only.
 */
export function orderAccountsWithPacing(views, { reservePct = 0.05, rateDeadbandRel = 0.15, placement = null, pacing = null, reviewReserve = null, creditPriority = 'fallback', taskRanking = null, burnAccounts = null } = {}) {
  const eligible = (views ?? []).filter(v => {
    if (v == null || v.health !== 'healthy') return false;
    if (isReactiveAccount(v)) return true;
    return v.headroomPct != null && v.headroomPct > reservePct;
  });
  const heldIds = new Set(reviewReserve?.heldAccountIds ?? []);
  const forReview = reviewReserve?.forReview === true;
  const reserveHeld = (!reviewReserve || forReview || heldIds.size === 0)
    ? []
    : eligible.filter(v => heldIds.has(v.accountId) && v.burn !== true);
  // Burn-mode accounts are never reserve-held: the operator asked for them
  // to spend as fast as possible, review or not.
  const reserveHeldIds = new Set(reserveHeld.map(v => v.accountId));
  const unheld = reserveHeld.length > 0 ? eligible.filter(v => !reserveHeldIds.has(v.accountId)) : eligible;
  const poolKeyOf = (v) => (v.pool != null ? `pool:${v.pool}` : `acct:${v.accountId}`);
  // The guard runs before ordering: a paced pool is not a candidate, so
  // placement scores and shortfalls below see only the pools that can serve.
  // The reserve hold applies first for the same reason: held accounts never
  // reach the guard or the sort for non-review runs.
  const verdicts = paceGuardPools(unheld, { pacing, poolKeyOf, burnAccounts });
  const taskEnforce = taskRanking?.mode === 'enforce';
  const routable = unheld.filter(v => !v.held && (!taskEnforce || (v.taskFeasible !== false && v.roleEligible !== false)));
  // Retained for consumers of the old diagnostics; weekly holds never suspend.
  const holdSuspendedAccountIds = [];
  // Per-lane verdicts: only the lanes the guard holds leave the order (a
  // lane behind its own plan keeps serving while an ahead sibling is held;
  // burn lanes are never held).
  const pacedVerdicts = verdicts.filter(p => (p.pacedAccountIds?.length ?? 0) > 0);
  const pacedIds = new Set(pacedVerdicts.flatMap(p => p.pacedAccountIds));
  const qualified = pacedIds.size > 0 ? routable.filter(v => v.burn === true || !pacedIds.has(v.accountId)) : routable;
  // Aggregator fallback (owner rule 2026-09-17): a Devin lane serving
  // only models a qualified native also serves sorts after every need band.
  // Views without a `models` list fail open (never fallback-only), so older
  // callers keep bit-identical behavior. An explicit boolean `fallbackOnly`
  // on the view wins over the derived check. Qualification is the gate alone,
  // matching the tick's duplicate set: the pace guard does not remove a native.
  const nativeModels = nativeQualifiedModels(eligible, reservePct);
  const fallbackOf = (v) => isFallbackOnlyView(v, nativeModels);
  const bandOf = (v) => {
    if (fallbackOf(v)) return 3;
    if (isReactiveAccount(v)) return 1;
    // Ahead-of-plan metered accounts sort with the over-burning: burning
    // quota against the plan loses to a reactive lane of unknown size.
    // Unknown-rate accounts score deficit 0 (not < 0), so they stay in band
    // 0: they prove neither need nor over-service.
    if (isOverBurning(v, rateDeadbandRel) || deficitOf(v) < 0) return 2;
    return 0;
  };
  const bandCmp = (a, b) => bandOf(a) - bandOf(b);
  const poolShare = new Map();
  const poolInFlight = new Map();
  for (const v of qualified) {
    const k = poolKeyOf(v);
    poolShare.set(k, (poolShare.get(k) ?? 0) + (v.targetShare != null && v.targetShare > 0 ? v.targetShare : 0));
    poolInFlight.set(k, Math.max(poolInFlight.get(k) ?? 0, v.inFlight ?? 0));
  }
  const shortfall = (v) => poolShare.get(poolKeyOf(v)) - poolInFlight.get(poolKeyOf(v));
  const qw = placement?.qualityWeight ?? 0;
  const aw = placement?.allowanceWeight ?? DEFAULT_PLACEMENT.allowanceWeight;
  const useQuality = qw > 0 && qualified.some(v => Number.isFinite(v.placementQ));
  const score = new Map();
  if (useQuality) {
    for (const v of qualified) {
      const q = Number.isFinite(v.placementQ) ? v.placementQ : 0;
      score.set(v, qw * q + aw * allowanceOf(shortfall(v), poolShare.get(poolKeyOf(v))));
    }
  }
  const hasPlanHeadroom = qualified.some(v => v.creditFallback !== true
    && v.roleEligible !== false && hasUsablePlanHeadroom(v, reservePct));
  // Burn mode first: an operator-flagged burn account wins every other
  // ordering key (eligibility, health and headroom were applied above, so
  // an exhausted burn account never reaches this sort). No burn flag on
  // any view leaves this key 0 and the order exactly as before.
  // Credits-only-after-plan still outranks burn: a burn account already on
  // credit fallback (plan spent) never jumps ahead of plan headroom.
  // A burn account above a level floor (burnFirst, see burnmode.mjs floors)
  // sorts before every other burn account: it can only spend what its bar
  // holds above the floor, and a regenerating bar nothing spends wastes its
  // regeneration once full. No burnFirst flag leaves the order unchanged.
  const burnRank = (v) => (v.burn === true ? (v.burnFirst === true ? 2 : 1) : 0);
  const order = [...qualified].sort((a, b) =>
    (creditPriority === 'fallback' && hasPlanHeadroom
      ? Number(a.creditFallback === true) - Number(b.creditFallback === true)
      : 0) ||
    (burnRank(b) - burnRank(a)) ||
    bandCmp(a, b) ||
    // Capability/admission happened before this sort. Surplus quality and
    // allowance cannot buy a pricier arm in the same operational bucket.
    (taskEnforce ? Number(b.freeCost === true) - Number(a.freeCost === true) : 0) ||
    (taskEnforce ? compareTaskCosts(a, b) : 0) ||
    (useQuality ? score.get(b) - score.get(a) : 0) ||
    (shortfall(b) - shortfall(a)) ||
    ((a.laneInFlight ?? 0) - (b.laneInFlight ?? 0)) ||
    (deficitOf(b) - deficitOf(a)) ||
    ((a.resetAtMs ?? Number.MAX_SAFE_INTEGER) - (b.resetAtMs ?? Number.MAX_SAFE_INTEGER)) ||
    (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0),
  );
  const pub = ({ key, ...rest }) => rest;
  const heldPub = reserveHeld.map(v => ({
    accountId: v.accountId, pool: v.pool ?? null, headroomPct: v.headroomPct ?? null,
  }));
  return { order, paced: pacedVerdicts.map(pub), pools: verdicts.map(pub), reserveHeld: heldPub, holdSuspendedAccountIds, rawPools: verdicts.map(pub) };
}
