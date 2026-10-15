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
  let aligned = false;
  if (spans.every(Boolean) && spans.length > 0) {
    const start = Math.max(...spans.map(s => s.fromMs));
    const end = Math.min(...spans.map(s => s.toMs));
    aligned = start - Math.min(...spans.map(s => s.fromMs)) <= ALIGNMENT_MS
      && Math.max(...spans.map(s => s.toMs)) - end <= ALIGNMENT_MS;
    const runs = aligned && end > start ? runsBetween(start, end) : 0;
    const requests = spans.reduce((n, s) => n + s.requests, 0);
    if (runs > 0 && requests > 0) requestsPerRun = requests / runs;
  }
  // Run conversion is only valid for a meter on the same counter span. A
  // reset trims that meter alone, so use the prior until its windows align.
  const sameSpan = (sample, u) => sample && u && sample.fromMs === u.fromMs && sample.toMs === u.toMs;
  const allWeeklyAligned = aligned && [...weekly.entries()].every(([k, s]) => !s || sameSpan(s, usage.get(k)));
  const baseline = requestsPerRun > 0 && medianWeekly > 0 && allWeeklyAligned
    ? medianWeekly * requestsPerRun : groupBurnPerRunPct;
  const out = new Map();
  for (const k of memberKeys) {
    const w = weekly.get(k);
    const f = fiveHour.get(k);
    const selected = w ?? f;
    const e = estimate(selected, w ? medianWeekly : medianFiveHour);
    const prior = groupBurnPerRunPct > 0 ? groupBurnPerRunPct : null;
    if (!e || !(baseline > 0)) {
      out.set(k, { source: 'group-prior', burnPerRunPct: prior, capacityWeight: 1, confidence: 0,
        attributedRuns: null, fiveHourBurnPerRunPct: null });
      continue;
    }
    // 5h relative weights are expressed against the WEEKLY prior. The
    // absolute 5h E, when available, is separately named for burst ceilings.
    const weeklyBaseline = w ? baseline : prior;
    if (!(weeklyBaseline > 0)) {
      out.set(k, { source: 'group-prior', burnPerRunPct: null, capacityWeight: 1, confidence: 0,
        attributedRuns: null, fiveHourBurnPerRunPct: null });
      continue;
    }
    const attributedRuns = requestsPerRun > 0 && sameSpan(selected, usage.get(k))
      ? selected.requests / requestsPerRun : null;
    out.set(k, { ...e, source: w ? 'account-weekly' : 'account-five-hour',
      burnPerRunPct: weeklyBaseline / e.capacityWeight,
      groupMedianBurnPerRunPct: weeklyBaseline,
      attributedRuns,
      fiveHourBurnPerRunPct: requestsPerRun > 0 && sameSpan(f, usage.get(k)) ? f.burnPerRequest * requestsPerRun : null,
    });
  }
  return out;
}
