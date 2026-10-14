/**
 * Reviewer as a first-class role (pure): the plugin decides the Reviewer's
 * runnable capacity from qualified providers and exposes a hold/resume
 * signal the review gate reads. Supersedes the host reviewer_failover /
 * review-hold scripts.
 *
 * Qualification today: Claude only. Meta (or any other provider) counts only
 * after the operator opts it in via reviewer.providers -- the bar lives in
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
 */

import { hasHeadroom } from './cross-account.mjs';

export const DEFAULT_REVIEWER = Object.freeze({
  /** Providers whose accounts may serve review runs. */
  providers: Object.freeze(['claude']),
  /** Headroom fraction that counts as "large unused" for the supply signal. */
  supplyHeadroomPct: 0.30,
  /** Hours-to-reset under which unused headroom counts as "close to reset". */
  supplyHoursToReset: 120,
});

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

export function normalizeReviewer(raw) {
  const d = DEFAULT_REVIEWER;
  const r = raw != null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const providers = Array.isArray(r.providers)
    ? [...new Set(r.providers.filter((s) => typeof s === 'string' && s.length > 0).map((s) => s.toLowerCase()))]
    : null;
  const headroom = finite(r.supplyHeadroomPct) && r.supplyHeadroomPct > 0 && r.supplyHeadroomPct <= 1
    ? r.supplyHeadroomPct : d.supplyHeadroomPct;
  const hours = finite(r.supplyHoursToReset) && r.supplyHoursToReset > 0 ? r.supplyHoursToReset : d.supplyHoursToReset;
  return {
    providers: providers && providers.length > 0 ? providers : [...d.providers],
    supplyHeadroomPct: headroom,
    supplyHoursToReset: hours,
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
 * accounts: [{ provider, health, action, remainingPct, hoursToReset }];
 * doerIdle: bool.
 * Returns { providers: [{ provider, headroomPct, hoursToReset }], wake }.
 * Each account clears both bars on its own (healthy, not excluded, headroom
 * at/above the floor, reset inside the window) before it counts: one
 * account's headroom is never paired with another account's reset. Wake when
 * at least one provider has a passing account and doers are idle.
 */
export function computeSupplySignal({ accounts, doerIdle = false, cfg = null } = {}) {
  const c = normalizeReviewer(cfg);
  const byProvider = new Map();
  for (const a of accounts ?? []) {
    if (a == null || typeof a.provider !== 'string' || !a.provider) continue;
    if (a.health != null && a.health !== 'healthy') continue;
    if (a.action === 'excluded') continue;
    if (!(finite(a.remainingPct) && finite(a.hoursToReset))) continue;
    if (!(a.remainingPct >= c.supplyHeadroomPct)) continue;
    if (!(a.hoursToReset < c.supplyHoursToReset)) continue;
    const key = a.provider.toLowerCase();
    let e = byProvider.get(key);
    if (!e) { e = { provider: key, remaining: 0, n: 0, minHours: Infinity }; byProvider.set(key, e); }
    e.remaining += Math.max(0, a.remainingPct);
    e.n += 1;
    if (a.hoursToReset < e.minHours) e.minHours = a.hoursToReset;
  }
  const providers = [];
  for (const e of byProvider.values()) {
    const headroomPct = Math.round((e.remaining / Math.max(1, e.n)) * 1000) / 1000;
    const hoursToReset = Math.round(e.minHours * 10) / 10;
    if (headroomPct >= c.supplyHeadroomPct && hoursToReset < c.supplyHoursToReset) {
      providers.push({ provider: e.provider, headroomPct, hoursToReset });
    }
  }
  providers.sort((a, b) => (b.headroomPct - a.headroomPct) || (a.provider < b.provider ? -1 : 1));
  return { providers, wake: doerIdle === true && providers.length > 0 };
}
