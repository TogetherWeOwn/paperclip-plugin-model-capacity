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
