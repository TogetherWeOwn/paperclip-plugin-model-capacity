/**
 * Plan-size learning, independent of provider or plan names.
 *
 * A model-mapped lane is NOT credential attribution: CLIProxy may send that
 * run to any credential in its pool. Meter-aligned Keeper request counters
 * provide the missing attribution. Request shares turn pool ledger runs into
 * run equivalents, not a claim that one request equals one agent run.
 *
 * Meters are commonly quantized to 1 percentage point. One observed quantum
 * and >=4 requests admit a provisional estimate; four quanta remove the
 * group prior. Confidence is evidence, never a count of overlapping polls.
 */
import { medianPositive } from './concurrency.mjs';

const QUANTUM = 0.01;
const KEEP_MS = 90 * 60000;
const MAX_AGE_MS = 5 * 60000;
const ALIGNMENT_MS = 60000;
// One weekly quantum on half a run priced Meta lane 8 at 29x the group prior
// on 2026-10-22 (C* 11.6 -> 6.4): the Keeper request counters count every
// CLIProxy request, including runs outside the ledger (kept, reviewerRouting,
// shadow and non-Paperclip callers), while runsBetween counts only ledger
// runs, so requestsPerRun inflates and the baseline follows it. An
// account-weekly sample is therefore accepted only on enough attributed runs
// and only when its baseline agrees with the group prior within a bounded
// factor; otherwise the group prior is kept and the rejection is named.
export const MIN_ATTRIBUTED_RUNS = 10;
export const MAX_BASELINE_FACTOR = 4;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const validCounter = n => Number.isSafeInteger(n) && n >= 0;

/** Retain bounded, distinct meter/counter pairs; a counter restart starts over. */
export function appendAccountUsage(history, account, nowMs) {
  const u = account?.usage;
  let h = (history ?? []).filter(p => p.atMs >= nowMs - KEEP_MS && p.atMs <= nowMs);
  if (!u || !validCounter(u.requests) || typeof u.epoch !== 'string' || !u.epoch
    || !Number.isFinite(u.observedAtMs) || u.observedAtMs > nowMs
    || u.observedAtMs < nowMs - KEEP_MS || u.observedAtMs !== account.signalsAtMs) return h;
  const last = h.at(-1);
  if (last && u.observedAtMs <= last.atMs) return h;
  if (last && (last.epoch !== u.epoch || last.requests > u.requests)) h = [];
  return [...h, {
    atMs: u.observedAtMs, epoch: u.epoch, requests: u.requests,
    weekly: account.weekly?.utilization ?? null,
    weeklyReset: account.weekly?.resetsAtMs ?? null,
    fiveHour: account.fiveHour?.utilization ?? null,
    fiveHourReset: account.fiveHour?.resetsAtMs ?? null,
  }].slice(-120);
}

function span(history, nowMs, window = null) {
  const h = (history ?? []).filter(p => p.atMs >= nowMs - KEEP_MS && p.atMs <= nowMs);
  const last = h.at(-1);
  if (!last || nowMs - last.atMs > MAX_AGE_MS) return null;
  let from = 0;
  // A counter decrease OR reset-identity change invalidates the old window,
  // even when the new meter already rose above its old value between polls.
  for (let i = 1; i < h.length; i++) {
    if (h[i].epoch !== h[i - 1].epoch || h[i].requests < h[i - 1].requests
      || (window && (h[i][`${window}Reset`] !== h[i - 1][`${window}Reset`]
        || (h[i][window] != null && h[i - 1][window] != null && h[i][window] < h[i - 1][window])))) from = i;
  }
  const first = h.slice(from).find(p => window == null || Number.isFinite(p[window]));
  if (!first || last.atMs - first.atMs < 5 * 60000) return null;
  const requests = last.requests - first.requests;
  if (!(requests >= 0)) return null;
  const out = { fromMs: first.atMs, toMs: last.atMs, requests };
  if (!window) return out;
  if (!Number.isFinite(last[window])) return null;
  const deltaPct = last[window] - first[window];
  if (deltaPct + 1e-9 < QUANTUM || requests < 4) return null;
  return { ...out, deltaPct, burnPerRequest: deltaPct / requests, confidence: clamp(deltaPct / (4 * QUANTUM), 0, 1) };
}

function estimate(sample, median) {
  if (!sample || !(median > 0)) return null;
  // Geometric shrinkage respects multiplicative capacity ratios. A strong
  // low-burn outlier also gets a conservative upper-error-bound estimate on
  // its first quantum (delta + one quantum), rather than waiting 30 minutes
  // for the prior EWMA. Flat meters never enter this path.
  let burn = median ** (1 - sample.confidence) * sample.burnPerRequest ** sample.confidence;
  if (sample.burnPerRequest <= median * 0.5) {
    burn = Math.min(burn, (sample.deltaPct + QUANTUM) / sample.requests);
  }
  const capacityWeight = clamp(median / burn, 0.25, 8);
  return { capacityWeight, confidence: sample.confidence, deltaPct: sample.deltaPct };
}

/**
 * Return account E and relative weight, retaining the pooled prior when the
 * feed cannot attribute usage. Weekly and 5h fractions are NEVER mixed.
 * A 5h-only estimate supplies a relative weight against the weekly group
 * prior, not a pretend weekly measurement. Without a weekly prior it cannot
 * mint weekly capacity. Missing peer counters prevent absolute run conversion.
 */
export function calibrateAccounts({ memberKeys, historyOf, groupBurnPerRunPct, runsBetween, nowMs }) {
  const histories = new Map(memberKeys.map(k => [k, historyOf(k) ?? []]));
  const usage = new Map(memberKeys.map(k => [k, span(histories.get(k), nowMs)]));
  const weekly = new Map(memberKeys.map(k => [k, span(histories.get(k), nowMs, 'weekly')]));
  const fiveHour = new Map(memberKeys.map(k => [k, span(histories.get(k), nowMs, 'fiveHour')]));
  const medianWeekly = medianPositive([...weekly.values()].map(s => s?.burnPerRequest));
  const medianFiveHour = medianPositive([...fiveHour.values()].map(s => s?.burnPerRequest));
  const spans = [...usage.values()];
  let requestsPerRun = null;
  let calibrationRuns = 0;
  let calibrationRequests = 0;
  let aligned = false;
  if (spans.every(Boolean) && spans.length > 0) {
    const start = Math.max(...spans.map(s => s.fromMs));
    const end = Math.min(...spans.map(s => s.toMs));
    aligned = start - Math.min(...spans.map(s => s.fromMs)) <= ALIGNMENT_MS
      && Math.max(...spans.map(s => s.toMs)) - end <= ALIGNMENT_MS;
    const runs = aligned && end > start ? runsBetween(start, end) : 0;
    const requests = spans.reduce((n, s) => n + s.requests, 0);
    calibrationRuns = runs;
    calibrationRequests = requests;
    if (runs > 0 && requests > 0) requestsPerRun = requests / runs;
  }
  // Run conversion is only valid for a meter on the same counter span. A
  // reset trims that meter alone, so use the prior until its windows align.
  const sameSpan = (sample, u) => sample && u && sample.fromMs === u.fromMs && sample.toMs === u.toMs;
  const allWeeklyAligned = aligned && [...weekly.entries()].every(([k, s]) => !s || sameSpan(s, usage.get(k)));
  // Absolute per-account burn needs complete attribution: the baseline scale
  // (median per-request burn x requests per run) is only valid when every
  // peer's counters cover the same span the run count does. With a missing
  // or reset peer there is no run scale, so pricing a relative weight
  // against the pooled prior overstates capacity whenever request shares
  // are uneven (the prior is a per-pool-run average, not a per-request
  // scale). Fall back to the pooled prior for the whole group instead.
  const absoluteOk = requestsPerRun > 0 && medianWeekly > 0 && allWeeklyAligned;
  const baseline = absoluteOk ? medianWeekly * requestsPerRun : groupBurnPerRunPct;
  const prior = groupBurnPerRunPct > 0 ? groupBurnPerRunPct : null;
  // Unattributed request share: the Keeper counters count every CLIProxy
  // request, including runs outside the ledger, while runsBetween counts only
  // ledger runs. When the baseline (median per-request burn x measured
  // requests per run) exceeds the pooled prior, the excess is requests the
  // ledger never saw: 1 - prior/baseline. 0 when the two agree, null with no
  // scale to compare. An estimate from the prior, honestly labeled, not a
  // count of external callers the feed cannot see.
  const expectedRequestsPerRun = prior != null && medianWeekly > 0 ? prior / medianWeekly : null;
  const unattributedRequestShare = expectedRequestsPerRun != null && expectedRequestsPerRun > 0 && requestsPerRun > 0
    ? clamp(1 - expectedRequestsPerRun / requestsPerRun, 0, 1)
    : null;
  const diagnostics = { requestsPerRun, calibrationRuns, calibrationRequests, unattributedRequestShare };
  const out = new Map();
  const fallback = (k, reason, attemptedAttributedRuns = null, attemptedBaseline = null) => {
    out.set(k, { source: 'group-prior', burnPerRunPct: prior, capacityWeight: 1, confidence: 0,
      attributedRuns: null, fiveHourBurnPerRunPct: null,
      rejectionReason: reason, attemptedAttributedRuns, attemptedBaseline, ...diagnostics });
  };
  for (const k of memberKeys) {
    // Weekly evidence without a run scale falls back to the pooled prior,
    // never to a 5h-relative weight: the account measured its weekly burn,
    // so pricing it off the noisier window would invent precision. Accounts
    // with no weekly evidence keep the existing 5h-relative path.
    const wRaw = weekly.get(k);
    const w = absoluteOk ? wRaw : null;
    const f = wRaw ? null : fiveHour.get(k);
    const selected = w ?? f;
    const e = estimate(selected, w ? medianWeekly : medianFiveHour);
    if (!e || !(baseline > 0)) {
      const reason = !selected
        ? (wRaw && !absoluteOk ? 'no-run-scale' : 'no-evidence')
        : (!e ? 'no-median' : 'no-baseline');
      fallback(k, reason);
      continue;
    }
    // 5h relative weights are expressed against the WEEKLY prior. The
    // absolute 5h E, when available, is separately named for burst ceilings.
    const weeklyBaseline = w ? baseline : prior;
    if (!(weeklyBaseline > 0)) {
      out.set(k, { source: 'group-prior', burnPerRunPct: null, capacityWeight: 1, confidence: 0,
        attributedRuns: null, fiveHourBurnPerRunPct: null,
        rejectionReason: 'no-baseline', attemptedAttributedRuns: null, attemptedBaseline: null, ...diagnostics });
      continue;
    }
    const attributedRuns = requestsPerRun > 0 && sameSpan(selected, usage.get(k))
      ? selected.requests / requestsPerRun : null;
    // A weekly sample prices only on enough attributed runs and only when its
    // baseline agrees with the group prior within a bounded factor. One
    // quantum on half a run, or a baseline 25x the prior from unattributed
    // requests, keeps the prior instead of repricing the lane. The 5h path
    // prices against the prior itself, so only the weekly baseline is bounded.
    if (w) {
      if (!(attributedRuns != null && attributedRuns >= MIN_ATTRIBUTED_RUNS)) {
        fallback(k, 'low-attributed-runs', attributedRuns, weeklyBaseline);
        continue;
      }
      if (prior != null && (weeklyBaseline / prior > MAX_BASELINE_FACTOR || prior / weeklyBaseline > MAX_BASELINE_FACTOR)) {
        fallback(k, 'baseline-out-of-bounds', attributedRuns, weeklyBaseline);
        continue;
      }
    }
    out.set(k, { ...e, source: w ? 'account-weekly' : 'account-five-hour',
      burnPerRunPct: weeklyBaseline / e.capacityWeight,
      groupMedianBurnPerRunPct: weeklyBaseline,
      attributedRuns,
      fiveHourBurnPerRunPct: requestsPerRun > 0 && sameSpan(f, usage.get(k)) ? f.burnPerRequest * requestsPerRun : null,
      rejectionReason: null, attemptedAttributedRuns: null, attemptedBaseline: null, ...diagnostics,
    });
  }
  return out;
}
