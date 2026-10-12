/**
 * Review reserve (pure): the demand-driven share of a reserved provider's
 * pace held back for review runs. Native port of the host stopgap
 * (ops/model-capacity/review_reserve.py, owner 2026-10-12), whose backtest on
 * 72h of our own data starved reviews 9 of 47 hours, versus 14 for a plain
 * rolling average and 38 for a fixed 50% (RESERVE-DECISION.md).
 *
 * Per closed hourly bucket over the trailing window:
 *   review burn = SUM over review-agent runs attributed to the account of
 *     burnPerRunPct (tier-adjusted while contextCaps.tierAffectsQuota holds)
 * review rate  = APF-style demand envelope: mean + 1 stdev over envWindowH
 *   hours, applied instantly on rises, decaying on envHalfLifeH
 * backlog rate = queued review runs x measured % per review run / drainH
 * need         = review rate + backlog rate
 * capacity     = SUM over the provider's accounts below 99% weekly of
 *   remaining% / hours-to-reset (live feed)
 * reserve      = clamp(need / capacity, rMin, rMax)
 *
 * Kueue-style lending (capacity-scheduler elasticity): with no review run
 * waiting the reserve is lent to other work (R = floor); it is reclaimed
 * through admission as soon as one appears. Runs are never cancelled --
 * the reserve only gates admission of non-review runs.
 *
 * A reserved-provider account whose weekly OR 5h use sits above its scaled
 * allowance (elapsed + margin) x (1 - R) is HELD for non-review runs. The
 * hold releases per window in the last releaseWeeklyH before a weekly reset
 * (24h) and the last release5hMin before a 5h reset (45 min), so unused
 * quota is not wasted. Review runs (agentIds, default roles.keepAgentIds)
 * and pinned agents bypass the hold: the hook answers keep for keepAgentIds
 * before admission, and callers pass forReview past the hold filter.
 *
 * Pure functions only: same input always yields the same output; no clock
 * (nowMs is a parameter), no network. The plugin owns the persisted state
 * (hour buckets + envelope + runs rate) and supplies ledger-derived events.
 */

export const REVIEW_RESERVE_STATE_KEY = 'review-reserve-v1';

export const DEFAULT_REVIEW_RESERVE = Object.freeze({
  /** Master switch. False restores pre-reserve admission bit-for-bit. */
  enabled: true,
  /** Providers whose pace carries a review reserve (normally [claude]). */
  providers: Object.freeze(['claude']),
  /**
   * Review-agent ids. Null (default) resolves to roles.keepAgentIds, so the
   * agents the operator pins for review are exactly the ones the reserve
   * protects. Extra ids may be listed explicitly.
   */
  agentIds: null,
  /** Closed hourly burn buckets carried in plugin state (bounded). */
  windowH: 6,
  /** Demand-envelope window: trailing closed hours for mean + 1 stdev. */
  envWindowH: 3,
  /** Envelope decay half-life (hours): rises apply instantly, falls decay. */
  envHalfLifeH: 3,
  /** Backlog drain horizon (hours): queued x per-run % spread over this. */
  drainH: 8,
  /** Reserve floor (= lent value) and cap, as fractions of pace. */
  rMin: 0.10,
  rMax: 0.95,
  /** Weekly hold releases this many hours before the weekly reset. */
  releaseWeeklyH: 24,
  /** 5h hold releases this many minutes before the 5h reset. */
  release5hMin: 45,
  /** Pace margin on the weekly allowance (mirrors the feed pace guard). */
  marginW: 0.10,
  /** Pace margin on the 5h allowance (mirrors the feed pace guard). */
  margin5h: 0.15,
  /** Weekly used fraction at/above which an account leaves capacity. */
  exhaustedPct: 0.99,
  /** Minimum runs/h before a measured per-run % is trusted. */
  minRunsPerH: 0.1,
  /** Runs-rate EWMA half-life (hours) for the measured % per review run. */
  runsHalfLifeH: 6,
});

const HOUR_MS = 3600000;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const numOr = (v, d) => (finite(v) ? v : d);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export const bucketHourStart = (atMs) => Math.floor(atMs / HOUR_MS) * HOUR_MS;

/**
 * Config knobs coerced to valid values; anything invalid reads as the
 * default. agentIds null/empty resolves to the operator's keepAgentIds.
 */
export function normalizeReviewReserve(raw, { keepAgentIds = [] } = {}) {
  const d = DEFAULT_REVIEW_RESERVE;
  const r = raw != null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const keep = [...new Set((Array.isArray(keepAgentIds) ? keepAgentIds : []).filter(s => typeof s === 'string' && s.length > 0))];
  const ids = Array.isArray(r.agentIds)
    ? [...new Set(r.agentIds.filter(s => typeof s === 'string' && s.length > 0))]
    : null;
  const providers = Array.isArray(r.providers)
    ? [...new Set(r.providers.filter(s => typeof s === 'string' && s.length > 0).map(s => s.toLowerCase()))]
    : null;
  const pos = (v, fb) => (finite(v) && v > 0 ? v : fb);
  const frac = (v, fb) => (finite(v) && v >= 0 && v <= 1 ? v : fb);
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    providers: providers && providers.length > 0 ? providers : [...d.providers],
    agentIds: ids && ids.length > 0 ? ids : keep,
    windowH: Number.isInteger(r.windowH) && r.windowH >= 1 && r.windowH <= 48 ? r.windowH : d.windowH,
    envWindowH: Number.isInteger(r.envWindowH) && r.envWindowH >= 1 && r.envWindowH <= 48 ? r.envWindowH : d.envWindowH,
    envHalfLifeH: pos(r.envHalfLifeH, d.envHalfLifeH),
    drainH: pos(r.drainH, d.drainH),
    rMin: frac(r.rMin, d.rMin),
    rMax: frac(r.rMax ?? (r.rMin != null && r.rMin > d.rMax ? null : d.rMax), d.rMax),
    releaseWeeklyH: pos(r.releaseWeeklyH, d.releaseWeeklyH),
    release5hMin: pos(r.release5hMin, d.release5hMin),
    marginW: frac(r.marginW, d.marginW),
    margin5h: frac(r.margin5h, d.margin5h),
    exhaustedPct: finite(r.exhaustedPct) && r.exhaustedPct > 0 && r.exhaustedPct <= 1 ? r.exhaustedPct : d.exhaustedPct,
    minRunsPerH: pos(r.minRunsPerH, d.minRunsPerH),
    runsHalfLifeH: pos(r.runsHalfLifeH, d.runsHalfLifeH),
  };
}

/**
 * Fold review-burn events into closed hourly buckets. events:
 * [{ atMs, accountId, burnPct }] (burnPct in quota-% units, tier-adjusted by
 * the caller via burnPerRunPct). Returns fresh buckets, oldest first,
 * pruned to windowH closed hours plus the current partial hour. Pure: the
 * caller persists the result.
 */
export function foldReviewEvents(buckets, events, nowMs, { windowH = DEFAULT_REVIEW_RESERVE.windowH } = {}) {
  const win = Number.isInteger(windowH) && windowH >= 1 ? windowH : DEFAULT_REVIEW_RESERVE.windowH;
  const byHour = new Map();
  for (const b of buckets ?? []) {
    if (!b || !finite(b.atMs)) continue;
    byHour.set(bucketHourStart(b.atMs), {
      atMs: bucketHourStart(b.atMs),
      burn: { ...(b.burn ?? {}) },
      runs: { ...(b.runs ?? {}) },
    });
  }
  for (const e of events ?? []) {
    if (!e || !finite(e.atMs) || typeof e.accountId !== 'string' || !finite(e.burnPct)) continue;
    const h = bucketHourStart(e.atMs);
    let b = byHour.get(h);
    if (!b) {
      b = { atMs: h, burn: {}, runs: {} };
      byHour.set(h, b);
    }
    b.burn[e.accountId] = (b.burn[e.accountId] ?? 0) + Math.max(0, e.burnPct);
    b.runs[e.accountId] = (b.runs[e.accountId] ?? 0) + 1;
  }
  const cutoff = bucketHourStart(nowMs) - win * HOUR_MS;
  return [...byHour.values()]
    .filter(b => b.atMs >= cutoff)
    .sort((a, b) => a.atMs - b.atMs);
}

/**
 * Trailing closed-hour burn totals (quota %/h), oldest first, at most
 * envWindowH entries. The partial current hour is excluded: an unfinished
 * hour understates the rate and would sag the reserve mid-burst.
 */
export function hourlyBurnTotals(buckets, nowMs, { envWindowH = DEFAULT_REVIEW_RESERVE.envWindowH } = {}) {
  const win = Number.isInteger(envWindowH) && envWindowH >= 1 ? envWindowH : DEFAULT_REVIEW_RESERVE.envWindowH;
  const current = bucketHourStart(nowMs);
  const closed = (buckets ?? [])
    .filter(b => b && finite(b.atMs) && bucketHourStart(b.atMs) < current)
    .sort((a, b) => a.atMs - b.atMs)
    .slice(-win);
  return closed.map(b => Object.values(b.burn ?? {}).reduce((s, v) => s + (finite(v) ? v : 0), 0));
}

/** Demand envelope sample: mean + 1 stdev; null when nothing is measured. */
export function envelopeSample(totals) {
  const xs = (totals ?? []).filter(finite);
  if (xs.length === 0) return null;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
  return mean + sd;
}

/**
 * Envelope step: rises apply instantly, falls decay on the half-life. prev:
 * { value, atMs } | null. A null sample (no closed hours yet) still ages
 * the carried value so a burst does not hold the reserve forever.
 */
export function stepEnvelope(prev, sample, nowMs, halfLifeMs) {
  const hl = finite(halfLifeMs) && halfLifeMs > 0 ? halfLifeMs : DEFAULT_REVIEW_RESERVE.envHalfLifeH * HOUR_MS;
  const decayed = prev != null && finite(prev.value) && finite(prev.atMs)
    ? prev.value * 2 ** (-Math.max(0, nowMs - prev.atMs) / hl)
    : 0;
  const value = finite(sample) ? Math.max(sample, decayed) : decayed;
  return { value, atMs: nowMs };
}

/** Review-runs-per-hour EWMA step (measured % per review run needs it). */
export function runsRateStep(prev, samplePerH, nowMs, halfLifeMs) {
  const hl = finite(halfLifeMs) && halfLifeMs > 0 ? halfLifeMs : DEFAULT_REVIEW_RESERVE.runsHalfLifeH * HOUR_MS;
  if (!finite(samplePerH)) {
    return prev != null && finite(prev.value) && finite(prev.atMs)
      ? { value: prev.value, atMs: prev.atMs }
      : { value: 0, atMs: nowMs };
  }
  if (prev == null || !finite(prev.value) || !finite(prev.atMs)) return { value: samplePerH, atMs: nowMs };
  const w = 2 ** (-Math.max(0, nowMs - prev.atMs) / hl);
  return { value: prev.value * w + samplePerH * (1 - w), atMs: nowMs };
}

/**
 * Reserve from need and sustainable capacity. Returns { reserve, lent }.
 * No review waiting: lent at the floor (reclaimed through admission as soon
 * as one queues). No measurable capacity: fail closed at the cap so reviews
 * keep their share rather than racing unreserved work to zero.
 */
export function reserveFor({ need, capacity, queued, rMin = 0.10, rMax = 0.95 }) {
  const lo = finite(rMin) ? rMin : 0.10;
  const hi = finite(rMax) ? rMax : 0.95;
  const q = finite(queued) ? queued : 0;
  if (!(q > 0)) return { reserve: lo, lent: true };
  const cap = finite(capacity) ? capacity : 0;
  const n = finite(need) ? Math.max(0, need) : 0;
  if (!(cap > 0)) return { reserve: hi, lent: false };
  return { reserve: clamp(n / cap, lo, hi), lent: false };
}

/**
 * Weekly/5h allowance hold for one account (non-review runs only; review
 * runs bypass). Allowance mirrors the feed pace guard: (elapsed + margin) x
 * (1 - R) per window, released in the last releaseWeeklyH / release5hMin
 * before each reset. Unknown position on a window never holds (fail open --
 * the unknown-headroom rule already excludes unreadable meters).
 * Returns { held, window: 'weekly' | 'five-hour' | null, released }.
 */
export function accountHeld({
  weeklyUsed, weeklyElapsed, hoursToWeeklyReset,
  fiveHourUsed, fiveHourElapsed, hoursTo5hReset,
  reserve,
}, cfg = DEFAULT_REVIEW_RESERVE) {
  const c = { ...DEFAULT_REVIEW_RESERVE, ...(cfg ?? {}) };
  const R = finite(reserve) ? clamp(reserve, 0, 1) : 0;
  if (!(R > 0)) return { held: false, window: null, released: false };
  const relW = finite(hoursToWeeklyReset) && hoursToWeeklyReset <= c.releaseWeeklyH;
  const rel5 = finite(hoursTo5hReset) && hoursTo5hReset <= c.release5hMin / 60;
  if (finite(weeklyUsed) && finite(weeklyElapsed)) {
    const elapsed = clamp(weeklyElapsed, 0, 1);
    const allowed = Math.min(1, (elapsed + c.marginW) * (1 - R));
    if (!relW && weeklyUsed > allowed) return { held: true, window: 'weekly', released: false };
  }
  if (finite(fiveHourUsed) && finite(fiveHourElapsed)) {
    const elapsed5 = clamp(fiveHourElapsed, 0, 1);
    const allowed5 = Math.min(1, (elapsed5 + c.margin5h) * (1 - R));
    if (!rel5 && fiveHourUsed > allowed5) return { held: true, window: 'five-hour', released: false };
  }
  return { held: false, window: null, released: relW || rel5 };
}

/**
 * Review-burn events from the run ledger since lastFoldMs. A review-agent
 * record contributes its start (startedAt ?? decidedAt) once, with the
 * caller's burn for its arm on its attributed account -- the tick passes
 * burnPerRunPct, which prices the context-tier multiplier while
 * contextCaps.tierAffectsQuota holds (default true), so Haiku 5.5 long
 * sessions burn at their tier price here too. Terminal records count: their
 * quota burned whether or not they are still running.
 */
export function reviewEventsFromLedger(ledger, { agentIds = [], burnOf = null, sinceMs = 0 } = {}) {
  const set = new Set((agentIds ?? []).filter(s => typeof s === 'string'));
  if (set.size === 0 || typeof burnOf !== 'function') return [];
  const out = [];
  for (const r of (ledger ?? new Map()).values()) {
    if (r == null || !set.has(r.agentId)) continue;
    const atMs = r.startedAt ?? r.decidedAt ?? null;
    if (!finite(atMs) || !(atMs > sinceMs)) continue;
    const accountId = r.decidedAccount ?? r.actualAccount ?? null;
    if (typeof accountId !== 'string' || accountId.length === 0) continue;
    const burnPct = burnOf(r.armId, accountId);
    if (!finite(burnPct) || !(burnPct > 0)) continue;
    out.push({ atMs, accountId, burnPct });
  }
  return out;
}

/**
 * Waiting review runs: non-terminal, verified review-agent records, as
 * { byAccount, unattributed }. A just-claimed review run has no account
 * attribution yet (the host claims before the hook decides); unattributed
 * demand counts toward every reserved provider -- the safe direction, since
 * a waiting review reclaims the reserve through admission on its next retry.
 * The reserve is lent only when both are empty; executing reviews count as
 * waiting, since more reviews usually follow a burst.
 */
export function queuedReviewsByAccount(ledger, { agentIds = [] } = {}) {
  const set = new Set((agentIds ?? []).filter(s => typeof s === 'string'));
  const out = { byAccount: {}, unattributed: 0 };
  if (set.size === 0) return out;
  for (const r of (ledger ?? new Map()).values()) {
    if (r == null || !set.has(r.agentId)) continue;
    if (r.unverified === true) continue;
    if (r.status === 'finished' || r.status === 'failed' || r.status === 'cancelled') continue;
    const accountId = r.decidedAccount ?? r.actualAccount ?? null;
    if (typeof accountId !== 'string' || accountId.length === 0) {
      out.unattributed += 1;
      continue;
    }
    out.byAccount[accountId] = (out.byAccount[accountId] ?? 0) + 1;
  }
  return out;
}

/** Review starts in the trailing 60 minutes (runs/hour rate sample). */
export function trailingHourRuns(buckets, nowMs) {
  const from = nowMs - HOUR_MS;
  let n = 0;
  for (const b of buckets ?? []) {
    if (!b || !finite(b.atMs)) continue;
    const hStart = bucketHourStart(b.atMs);
    const overlap = Math.max(0, Math.min(hStart + HOUR_MS, nowMs) - Math.max(hStart, from));
    if (overlap <= 0) continue;
    const total = Object.values(b.runs ?? {}).reduce((s, v) => s + (finite(v) ? v : 0), 0);
    n += total * (overlap / HOUR_MS);
  }
  return n;
}

/**
 * One provider's reserve verdict from tick inputs. accounts:
 * [{ accountId, provider, weeklyUsed, weeklyElapsed, hoursToWeeklyReset,
 *    fiveHourUsed, fiveHourElapsed, hoursTo5hReset }] (elapsed 0..1, resets
 * in hours; nulls read as unknown). events: review-burn events since the
 * last fold [{ atMs, accountId, burnPct }]. queuedByAccount: waiting review
 * runs per account (non-terminal review-agent ledger records attributed by
 * the caller). state: { buckets, envelope, runsRate, lastFoldMs } | null.
 *
 * Returns { provider, reserve, lent, needPctPerH, reviewRatePctPerH,
 * backlogRatePctPerH, capacityPctPerH, queuedReviews, reviewRunsPerH,
 * pctPerReviewRun, heldAccountIds, accounts: [{ accountId, usedPct,
 * hoursToReset, held, window }], state }.
 */
export function computeProviderReserve({
  provider, accounts, state, nowMs, cfg = DEFAULT_REVIEW_RESERVE,
  events = [], queuedByAccount = {},
}) {
  const c = { ...DEFAULT_REVIEW_RESERVE, ...(cfg ?? {}) };
  const own = (accounts ?? []).filter(a => a != null && String(a.provider ?? '').toLowerCase() === String(provider).toLowerCase());
  const prev = state ?? { buckets: [], envelope: null, runsRate: null, lastFoldMs: null };
  const buckets = foldReviewEvents(prev.buckets, events, nowMs, c);
  const totals = hourlyBurnTotals(buckets, nowMs, c);
  const envelope = stepEnvelope(prev.envelope, envelopeSample(totals), nowMs, c.envHalfLifeH * HOUR_MS);
  const reviewRate = Math.max(0, envelope.value);
  // Measured % per review run: review rate over the EWMA of the trailing
  // hourly review-start rate (same buckets, so a burst and its runs agree).
  const runsRate = runsRateStep(prev.runsRate, trailingHourRuns(buckets, nowMs), nowMs, c.runsHalfLifeH * HOUR_MS);
  const perRun = runsRate.value > c.minRunsPerH && reviewRate > 0 ? reviewRate / runsRate.value : 0;
  // queuedByAccount: { byAccount, unattributed } from
  // queuedReviewsByAccount (a plain per-account map is accepted too).
  const qb = queuedByAccount?.byAccount ?? queuedByAccount ?? {};
  const unattributed = Math.max(0, Math.floor(numOr(queuedByAccount?.unattributed, 0)));
  let queued = unattributed;
  for (const a of own) queued += Math.max(0, Math.floor(numOr(qb[a.accountId], 0)));
  const backlogRate = queued * perRun / c.drainH;
  const need = reviewRate + backlogRate;
  let capacity = 0;
  for (const a of own) {
    if (!finite(a.weeklyUsed) || !finite(a.hoursToWeeklyReset)) continue;
    if (a.weeklyUsed >= c.exhaustedPct) continue;
    capacity += Math.max(0, 1 - a.weeklyUsed) * 100 / Math.max(a.hoursToWeeklyReset, 1 / 60);
  }
  const { reserve, lent } = reserveFor({ need, capacity, queued, rMin: c.rMin, rMax: c.rMax });
  // Lent reserve holds nothing: with no review waiting the whole pace is
  // lent to other work (R sits at the floor as the published number only).
  // The hold returns through admission the moment a review queues.
  const holdR = lent ? 0 : reserve;
  const heldAccountIds = [];
  const accountRows = own.map(a => {
    const verdict = accountHeld({
      weeklyUsed: a.weeklyUsed, weeklyElapsed: a.weeklyElapsed, hoursToWeeklyReset: a.hoursToWeeklyReset,
      fiveHourUsed: a.fiveHourUsed, fiveHourElapsed: a.fiveHourElapsed, hoursTo5hReset: a.hoursTo5hReset,
      reserve: holdR,
    }, c);
    if (verdict.held) heldAccountIds.push(a.accountId);
    return {
      accountId: a.accountId,
      usedPct: finite(a.weeklyUsed) ? Math.round(a.weeklyUsed * 1000) / 10 : null,
      hoursToReset: finite(a.hoursToWeeklyReset) ? Math.round(a.hoursToWeeklyReset * 10) / 10 : null,
      held: verdict.held,
      window: verdict.window,
    };
  });
  return {
    provider,
    reserve: Math.round(reserve * 1000) / 1000,
    lent,
    needPctPerH: Math.round(need * 1000) / 1000,
    reviewRatePctPerH: Math.round(reviewRate * 1000) / 1000,
    backlogRatePctPerH: Math.round(backlogRate * 1000) / 1000,
    capacityPctPerH: Math.round(capacity * 1000) / 1000,
    queuedReviews: queued,
    reviewRunsPerH: Math.round(runsRate.value * 100) / 100,
    pctPerReviewRun: Math.round(perRun * 10000) / 10000,
    heldAccountIds,
    accounts: accountRows,
    state: { buckets, envelope, runsRate, lastFoldMs: nowMs },
  };
}
