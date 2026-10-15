/**
 * Pooled-provider calibration.
 *
 * CLIProxy round-robins a provider's credentials: a run on a model that
 * several lanes serve burns ALL of those lanes' quota, but the run can only
 * be mapped to one of them (the first lane serving the model). Calibrating
 * per lane then divides one lane's weekly delta by every run on the pool
 * (E underestimated by roughly the pool width) and leaves the other lanes
 * with no runs at all (never calibrated, stuck on the anchor).
 *
 * Calibration therefore works on a GROUP: accounts of one provider that the
 * feed does not let us tell apart -- they serve a common model, or a lane's
 * model list is missing so attribution falls back to the provider. Lanes
 * serving disjoint models of one provider (an antigravity partner pool next
 * to a gemini lane) stay separate: the served model already identifies
 * them, and merging would dilute both.
 *
 * Group burn:  E_group = (sum over members of that member's weekly-used
 * delta over the span) / (runs started on any member in the span), in
 * "fraction of one lane's weekly quota per run". Every member shares it, so
 * summing per-lane runs/hour (need_a / E_group) over the pool gives the
 * pool's true sustainable run rate.
 */

import { canonicalModelName } from './arms.mjs';

/**
 * Plan-size aware calibration.
 *
 * Pooled E (above) is the group's average burn, which is exactly right for a
 * pool of equal plans -- but a $200 plan (~4x a standard plan) burns ~1/4 per
 * run, so sharing one E gives it the same share as every 1x lane and it idles
 * at ~1/4 of its capacity.
 *
 * Each member's own meter still reveals its own burn: E_raw(member) is the
 * member's weekly-used delta over its own span divided by the even share of
 * the group's runs in the span (group runs / width). CLIProxy round-robins a
 * calibration group's shared model across its lanes and the enforced hook
 * returns only model/effort/env, so a pick does not choose the credential
 * that burns -- each lane's meter moves for about N/width runs whatever the
 * picks are, and normalizing by the even share recovers each lane's own burn
 * while weighted spreading skews the picks. A lane
 * individualizes only on a minimal sample
 * (>= minRunsForIndiv lane runs over >= minSpanMs of history); until then it
 * inherits the group E with weight 1. Burns driving shares are bounded to
 * [median/8, median*4] (the weight clamp, applied to the burn itself), so one
 * thin sample cannot mint capacity -- the weight clamp alone never bound
 * targetShare or C*, which read the burn directly. Single-member groups are
 * never clamped against other providers: a solo lane's burn is already its
 * own meter over its own runs, in its own quota units.
 */

export const PLAN_SIZE = Object.freeze({
  /** Minimal lane-run sample before a lane individualizes (fast outlier path). */
  minRunsForIndiv: 3,
  /** Minimal member history span before a lane individualizes. */
  minSpanMs: 10 * 60 * 1000,
  /** Capacity weight clamps (median burn / lane burn). */
  weightMin: 0.25,
  weightMax: 8,
  /** Burns driving shares are bounded to [median/8, median*4]. */
  burnFloorDivisor: 8,
  burnCeilFactor: 4,
});

function medianFinite(values) {
  const v = (values ?? []).filter((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * One member's weekly-used delta over its own span, or null while it has
 * fewer than two in-span readings. Zero movement is a real reading (an idle
 * lane burns nothing); callers decide whether it individualizes.
 */
export function memberDelta(history, spanMs, nowMs) {
  if (!(spanMs > 0)) return null;
  const pts = (history ?? []).filter((p) => Number.isFinite(p?.atMs) && Number.isFinite(p?.usedPct)
    && nowMs - p.atMs <= spanMs && p.atMs <= nowMs + 60000);
  if (pts.length < 2) return null;
  const delta = pts[pts.length - 1].usedPct - pts[0].usedPct;
  if (!Number.isFinite(delta) || delta < 0) return null;
  return { delta, points: pts.length };
}

/**
 * Per-member raw burn for one calibration group.
 *   memberKeys: account keys in the group
 *   historyOf(key): [{ atMs, usedPct }] weekly-used readings, oldest first
 *   spanMsOf(key): measured-rate span for the key (null: no measured rate yet)
 *   runsInSpanFor(key, spanMs): even share of the group's runs in the span
 *     (group runs / width -- never the lane's pick count, which skews once
 *     weighted spreading works while the meter still moves N/width per lane).
 * Returns Map(key -> rawBurnPerRunPct) for members with a minimal sample:
 * a measured span of at least minSpanMs, a positive delta, and at least
 * minRunsForIndiv lane runs in that span. Members without a sample are
 * absent (they inherit the group E). Counter resets void that member only.
 */
export function perAccountRawBurn({
  memberKeys, historyOf, spanMsOf, runsInSpanFor, nowMs,
} = {}) {
  const out = new Map();
  for (const k of memberKeys ?? []) {
    const span = spanMsOf(k);
    if (!(span >= PLAN_SIZE.minSpanMs)) continue;
    const d = memberDelta(historyOf(k), span, nowMs);
    if (!d) continue;
    const n = runsInSpanFor(k, span);
    if (!(n >= PLAN_SIZE.minRunsForIndiv)) continue;
    if (!(d.delta > 0)) continue;
    const raw = d.delta / n;
    if (raw > 0 && Number.isFinite(raw)) out.set(k, raw);
  }
  return out;
}

/**
 * Bound burns to the group median before they drive shares: members of
 * `burns` outside [median/8, median*4] are clamped (a thin sample cannot mint
 * or destroy capacity through targetShare/C*, which read the burn directly,
 * not the weight). Returns { burns, weights, median }: burns is a Map of the
 * share-driving values, weights the clamped median/burn capacity weights.
 * Members absent from `burns` (or a null median) keep weight 1 and no bound
 * burn entry.
 */
export function boundBurnPerRun(burns, memberKeys = null) {
  const entries = burns instanceof Map ? [...burns.entries()] : Object.entries(burns ?? {});
  const keys = memberKeys ?? entries.map(([k]) => k);
  const median = medianFinite(entries.map(([, v]) => v));
  const out = new Map();
  const bounded = new Map();
  for (const k of keys) {
    const e = burns instanceof Map ? burns.get(k) : burns?.[k];
    if (!(e > 0) || median == null) {
      out.set(k, 1);
      continue;
    }
    const lo = median / PLAN_SIZE.burnFloorDivisor;
    const hi = median * PLAN_SIZE.burnCeilFactor;
    const b = Math.min(hi, Math.max(lo, e));
    bounded.set(k, b);
    out.set(k, Math.min(PLAN_SIZE.weightMax, Math.max(PLAN_SIZE.weightMin, median / b)));
  }
  return { burns: bounded, weights: out, median };
}

/**
 * Capacity weight per member: group median burn / lane burn, clamped to
 * [weightMin, weightMax]. A 4x plan (1/4 the burn) weighs ~4; uniform pools
 * weigh ~1. Members absent from the burn map weigh exactly 1 (inherit).
 */
export function capacityWeights(burnByAccount, memberKeys = null) {
  const entries = burnByAccount instanceof Map
    ? [...burnByAccount.entries()]
    : Object.entries(burnByAccount ?? {});
  const keys = memberKeys ?? entries.map(([k]) => k);
  const median = medianFinite(entries.map(([, v]) => v));
  const out = new Map();
  for (const k of keys) {
    const e = burnByAccount instanceof Map ? burnByAccount.get(k) : burnByAccount?.[k];
    if (!(e > 0) || median == null) {
      out.set(k, 1);
      continue;
    }
    const w = median / e;
    out.set(k, Math.min(PLAN_SIZE.weightMax, Math.max(PLAN_SIZE.weightMin, w)));
  }
  return out;
}

function find(parent, x) {
  while (parent.get(x) !== x) {
    parent.set(x, parent.get(parent.get(x)));
    x = parent.get(x);
  }
  return x;
}

/**
 * accounts: snapshot accounts ({ provider, models }); keys: the parallel
 * state keys. Returns { groupOf: Map(key -> groupId), members: Map(groupId
 * -> [key, ...]) }. A group id is its lexically-first member key, so it is
 * stable across ticks while membership holds.
 */
export function buildCalibrationGroups(accounts, keys) {
  const parent = new Map(keys.map(k => [k, k]));
  const union = (a, b) => {
    const ra = find(parent, a);
    const rb = find(parent, b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra); else parent.set(ra, rb);
  };
  const byProvider = new Map();
  for (let i = 0; i < keys.length; i++) {
    const p = String(accounts[i]?.provider ?? String(keys[i]).split(':')[0]).toLowerCase();
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p).push(i);
  }
  for (const idxs of byProvider.values()) {
    const modelSets = idxs.map(i => (Array.isArray(accounts[i]?.models)
      ? new Set(accounts[i].models.map(canonicalModelName).filter(Boolean))
      : null));
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        const a = modelSets[x];
        const b = modelSets[y];
        // A missing model list means provider-level attribution only: it
        // cannot be told apart from any sibling.
        const ambiguous = a == null || b == null || [...a].some(m => b.has(m));
        if (ambiguous) union(keys[idxs[x]], keys[idxs[y]]);
      }
    }
  }
  const groupOf = new Map();
  const members = new Map();
  for (const k of keys) {
    const g = find(parent, k);
    groupOf.set(k, g);
    if (!members.has(g)) members.set(g, []);
    members.get(g).push(k);
  }
  return { groupOf, members };
}

/**
 * Measured burn per run for one group, or null while unmeasurable.
 *   memberKeys: account keys in the group
 *   historyOf(key): [{ atMs, usedPct }] weekly-used readings, oldest first
 *   spanMsOf(key): measured-rate span for the key (null: no measured rate)
 *   runsInSpan(spanMs): runs started on ANY member within the span
 *   runsInSpanFor(key, spanMs): runs started on ONE member within the span
 *     (optional; without it a short-history member voids the sample, since
 *     its share of the run count cannot be proven empty)
 * The span is the shortest member span so every contributing member's delta
 * covers the same window the run count does. Members without a measured
 * rate contribute nothing; a counter reset (negative delta) on any member
 * voids the sample (see below). A member with fewer than two in-span
 * readings adds no burn delta but its served runs stay in the run count, so
 * any sum over the rest would understate E: the sample is void unless the
 * member served no runs in the span (then skipping it is exact).
 */
export function pooledBurnPerRun({ memberKeys, historyOf, spanMsOf, runsInSpan, runsInSpanFor = null, nowMs }) {
  const spans = memberKeys.map(spanMsOf).filter(s => s != null && s > 0);
  if (spans.length === 0) return null;
  const spanMs = Math.min(...spans);
  let delta = 0;
  let contributing = 0;
  const short = [];
  for (const k of memberKeys) {
    const inSpan = (historyOf(k) ?? []).filter(p => nowMs - p.atMs <= spanMs);
    if (inSpan.length < 2) {
      short.push(k);
      continue;
    }
    const d = inSpan[inSpan.length - 1].usedPct - inSpan[0].usedPct;
    // A falling counter is a weekly-window reset inside the span: that
    // lane's burn is unknowable, but the runs it served are still in the
    // run count, so any sum over the rest would understate E. No sample
    // this tick; the smoothed E carries over.
    if (d < 0) return null;
    if (d > 0) {
      delta += d;
      contributing += 1;
    }
  }
  const n = runsInSpan(spanMs);
  if (!(delta > 0) || !(n > 0)) return null;
  // A short-history member adds no burn delta but its served runs stay in
  // the run count, so any sum over the rest would understate E: the sample
  // is void unless the member served no runs in the span (then skipping it
  // is exact). Without per-member counts that cannot be proven, so void.
  for (const k of short) {
    const served = typeof runsInSpanFor === 'function' ? runsInSpanFor(k, spanMs) : null;
    if (!(served === 0)) return null;
  }
  return { burnPerRunPct: delta / n, deltaPct: delta, runs: n, spanMs, contributing, members: memberKeys.length };
}
