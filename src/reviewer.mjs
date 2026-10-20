/**
 * Reviewer as a first-class role (pure): the plugin decides the Reviewer's
 * runnable capacity from qualified providers and exposes a hold/resume
 * signal the review gate reads. Supersedes the host reviewer_failover /
 * review-hold scripts.
 *
 * Qualification: reviewer.providers, else reviewReserve.providers when the
 * operator set it, else Claude only. Meta (or any other provider) counts
 * only after the operator opts it in through one of those lists -- the bar lives in
 * ops/analysis/wonder-reviewer-20261014/REPORT.md and
 * ops/analysis/codex-reviewer-20261013/REPORT.md. The allowlist IS the bar
 * in code: unlisted providers never serve reviews, whatever their headroom.
 *
 * Runnable capacity: qualified-provider accounts that are healthy, carry
 * headroom (or are reactive with no meter), and are reviewer-eligible
 * (non-trial arms the role can reach; the tick passes reviewerEligible per
 * account from role access). Slots are a coarse headroom-weighted count so
 * the gate can scale review parallelism; hold/resume is the binary signal.
 *
 * Demand-aware supply signal: when a provider holds large unused headroom
 * close to its reset (default >=30% with <120h to reset) while doers are
 * idle, surface it so supply (work generator / PR-finishing cards) scales up
 * instead of idling. Pure and advisory; the tick publishes it on /capacity.
 *
 * Doer-starvation wake: when the served target C* exceeds live doer runs by
 * a margin (default 4 runs) sustained for N minutes (default 10), emit a
 * wake so idle in_progress/todo cards on healthy-provider agents get woken.
 * Fleet runs/h would mask this (reviewer runs keep the fleet busy while
 * doers starve), so the gap is measured against live doer runs -- and the
 * supply signal reports per-provider live runs with an idle flag for the
 * same reason.
 */

import { hasHeadroom } from './cross-account.mjs';

export const DEFAULT_REVIEWER = Object.freeze({
  /** Providers whose accounts may serve review runs. */
  providers: Object.freeze(['claude']),
  /** Headroom fraction that counts as "large unused" for the supply signal. */
  supplyHeadroomPct: 0.30,
  /** Hours-to-reset under which unused headroom counts as "close to reset". */
  supplyHoursToReset: 120,
  /** C*-vs-live-doer gap (runs) that counts as doer starvation. */
  doerStarvationMarginRuns: 4,
  /** How long the gap must persist before the starvation wake fires. */
  doerStarvationSustainMs: 10 * 60 * 1000,
});

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * defaultProviders: the fallback when reviewer.providers is unset -- the
 * plugin passes reviewReserve.providers when the operator set it, so the
 * providers whose pace is reserved for reviews are the ones whose lanes
 * size reviewer capacity (Claude AND Meta when both are reserved). An
 * explicit reviewer.providers still wins; neither set reads ['claude'].
 */
export function normalizeReviewer(raw, { defaultProviders = null } = {}) {
  const d = DEFAULT_REVIEWER;
  const r = raw != null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const clean = (list) => (Array.isArray(list)
    ? [...new Set(list.filter((s) => typeof s === 'string' && s.length > 0).map((s) => s.toLowerCase()))]
    : null);
  const explicit = clean(r.providers);
  const fallback = clean(defaultProviders);
  const providers = explicit && explicit.length > 0 ? explicit : fallback;
  const headroom = finite(r.supplyHeadroomPct) && r.supplyHeadroomPct > 0 && r.supplyHeadroomPct <= 1
    ? r.supplyHeadroomPct : d.supplyHeadroomPct;
  const hours = finite(r.supplyHoursToReset) && r.supplyHoursToReset > 0 ? r.supplyHoursToReset : d.supplyHoursToReset;
  const margin = finite(r.doerStarvationMarginRuns) && r.doerStarvationMarginRuns > 0
    ? r.doerStarvationMarginRuns : d.doerStarvationMarginRuns;
  const sustain = finite(r.doerStarvationSustainMs) && r.doerStarvationSustainMs > 0
    ? r.doerStarvationSustainMs : d.doerStarvationSustainMs;
  return {
    providers: providers && providers.length > 0 ? providers : [...d.providers],
    supplyHeadroomPct: headroom,
    supplyHoursToReset: hours,
    doerStarvationMarginRuns: margin,
    doerStarvationSustainMs: sustain,
  };
}

/**
 * Reviewer runnable capacity from tick account views.
 * accounts: [{ accountId, provider, health, headroomPct, remainingPct,
 *   hoursToReset, reactive, reviewerEligible, action, guardActive }].
 * Only accounts the allocator itself would serve count: excluded (e.g.
 * weekly-exhausted) and guard-pinned accounts never resume reviews, and
 * metered headroom must clear the allocator's reserve (select.mjs
 * reservePct). Reactive lanes carry no meter and qualify on health alone,
 * matching the allocator.
 * Returns { providers, qualifiedAccountIds, slots, hold, resume, reason }.
 */
export function computeReviewerCapacity({ accounts, cfg = null, nowMs = Date.now() } = {}) {
  void nowMs;
  const c = normalizeReviewer(cfg);
  const qualified = new Set(c.providers);
  const ids = [];
  let slots = 0;
  for (const a of accounts ?? []) {
    if (a == null || typeof a.accountId !== 'string') continue;
    if (!qualified.has(String(a.provider ?? '').toLowerCase())) continue;
    if (a.health !== 'healthy') continue;
    if (a.action === 'excluded' || a.guardActive === true) continue;
    if (a.reviewerEligible === false) continue;
    const headroom = finite(a.headroomPct) ? a.headroomPct : (a.reactive === true ? 0.5 : null);
    if (a.reactive === true && !finite(a.headroomPct)) {
      // No meter to clear the reserve with: health alone decides.
    } else if (!hasHeadroom({ health: a.health, headroomPct: a.headroomPct })) {
      continue;
    }
    ids.push(a.accountId);
    slots += headroom;
  }
  ids.sort();
  const rounded = Math.round(slots * 100) / 100;
  if (ids.length === 0) {
    return {
      providers: c.providers,
      qualifiedAccountIds: [],
      slots: 0,
      hold: true,
      resume: false,
      reason: 'no qualified reviewer capacity: hold reviews until a qualified provider recovers',
    };
  }
  return {
    providers: c.providers,
    qualifiedAccountIds: ids,
    slots: rounded,
    hold: false,
    resume: true,
    reason: `reviewer runnable on ${ids.length} qualified account(s)`,
  };
}

/**
 * Demand-aware supply signal.
 * accounts: [{ provider, health, action, guardActive, remainingPct,
 *   hoursToReset, inFlight }];
 * doerIdle: bool.
 * Returns { providers: [{ provider, headroomPct, hoursToReset,
 *   qualifyingAccounts, liveRuns, idle, wake }], wake }.
 * Each account clears both bars on its own (healthy, servable, headroom
 * at/above the floor, reset inside the window) before it counts: one
 * account's headroom is never paired with another account's reset. Each
 * provider reports its live runs with an idle flag (null when liveness is
 * unknown) because fleet runs/h masks per-provider doer starvation: reviewer
 * traffic on one provider must not hide an idle healthy provider. A provider
 * wakes when it qualifies AND (fleet doers are idle OR it has zero live
 * runs with known liveness).
 */
export function computeSupplySignal({ accounts, doerIdle = false, cfg = null } = {}) {
  const c = normalizeReviewer(cfg);
  // Provider run census first, across every account regardless of
  // qualification: an excluded or guarded account's runs still burn the
  // provider's quota, and the idle flag must report the provider's real
  // load, not just its servable slice.
  const runsByProvider = new Map();
  for (const a of accounts ?? []) {
    if (a == null || typeof a.provider !== 'string' || !a.provider) continue;
    if (!finite(a.inFlight)) continue;
    const key = a.provider.toLowerCase();
    runsByProvider.set(key, (runsByProvider.get(key) ?? 0) + a.inFlight);
  }
  const byProvider = new Map();
  for (const a of accounts ?? []) {
    if (a == null || typeof a.provider !== 'string' || !a.provider) continue;
    if (a.health != null && a.health !== 'healthy') continue;
    if (a.action === 'excluded' || a.guardActive === true) continue;
    if (!(finite(a.remainingPct) && finite(a.hoursToReset))) continue;
    if (!(a.remainingPct >= c.supplyHeadroomPct)) continue;
    if (!(a.hoursToReset < c.supplyHoursToReset)) continue;
    const key = a.provider.toLowerCase();
    let e = byProvider.get(key);
    if (!e) {
      const census = runsByProvider.get(key);
      e = {
        provider: key, remaining: 0, n: 0, minHours: Infinity,
        liveRuns: census ?? 0, liveKnown: census != null,
      };
      byProvider.set(key, e);
    }
    e.remaining += Math.max(0, a.remainingPct);
    e.n += 1;
    if (a.hoursToReset < e.minHours) e.minHours = a.hoursToReset;
  }
  const providers = [];
  for (const e of byProvider.values()) {
    const headroomPct = Math.round((e.remaining / Math.max(1, e.n)) * 1000) / 1000;
    const hoursToReset = Math.round(e.minHours * 10) / 10;
    if (headroomPct >= c.supplyHeadroomPct && hoursToReset < c.supplyHoursToReset) {
      const idle = e.liveKnown ? e.liveRuns === 0 : null;
      providers.push({
        provider: e.provider,
        headroomPct,
        hoursToReset,
        qualifyingAccounts: e.n,
        liveRuns: e.liveKnown ? e.liveRuns : null,
        idle,
        wake: doerIdle === true || idle === true,
      });
    }
  }
  providers.sort((a, b) => (b.headroomPct - a.headroomPct) || (a.provider < b.provider ? -1 : 1));
  return { providers, wake: providers.some((p) => p.wake) };
}

/**
 * Doer-starvation wake (pure): the served target C* exceeds live doer runs
 * by a margin sustained over time, while doer work waits. sinceMs carries
 * the first starving tick (the caller persists it across ticks); the gap
 * closing resets it to null. doerDemand is the queued doer demand the tick
 * already computed: without waiting doer work there is nothing to wake,
 * however large the gap (C* absorbed by thinker runs, or an issues outage
 * zeroing demand, must not summon supply). A null/unmeasurable target never
 * wakes -- unknown capacity is not a supply signal.
 */
export function computeDoerStarvation({ target, liveDoerRuns, doerDemand = null, sinceMs = null, cfg = null, nowMs = Date.now() } = {}) {
  const c = normalizeReviewer(cfg);
  const margin = c.doerStarvationMarginRuns;
  const sustain = c.doerStarvationSustainMs;
  if (!(finite(target) && target > 0) || !finite(liveDoerRuns)) {
    return {
      target: finite(target) && target > 0 ? target : null,
      liveDoerRuns: finite(liveDoerRuns) ? liveDoerRuns : null,
      doerDemand: finite(doerDemand) ? doerDemand : null,
      gap: null, marginRuns: margin, sustainMs: sustain,
      starving: false, waiting: false, sinceMs: null, wake: false, unknown: true,
    };
  }
  const gap = Math.round(Math.max(0, target - liveDoerRuns) * 100) / 100;
  const starving = gap >= margin;
  const waiting = finite(doerDemand) && doerDemand > liveDoerRuns;
  const start = starving ? (finite(sinceMs) ? sinceMs : nowMs) : null;
  const wake = starving && waiting && start != null && nowMs - start >= sustain;
  return {
    target, liveDoerRuns,
    doerDemand: finite(doerDemand) ? doerDemand : null,
    gap, marginRuns: margin, sustainMs: sustain,
    starving, waiting, sinceMs: start, wake, unknown: false,
  };
}
