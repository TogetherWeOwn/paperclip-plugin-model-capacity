/**
 * Arm-aware burn calibration: burn per run is measured per arm
 * (model+effort) per calibration pool, not per account.
 *
 * A pooled meter delta prices the runs that produced it. The ledger knows
 * each run's arm (decision armId, else the resolved model), so a pooled
 * sample splits across the arms that ran in its span by responsibility:
 * each arm's prior burn times its run count, scaled to the observed delta.
 * A pure-span sample (one arm ran) measures that arm exactly.
 *
 * Pricing then follows the CURRENT run mix, not the mix that produced the
 * last meter quantum: when doers switch arms, the effective burn reprices
 * on the first tick the ledger shows the new mix. Arms never measured get
 * an anchor-ratio prior (cost-model relative burn), never the old arm's
 * average -- a switch to a cheaper arm must not wait for meter quanta.
 *
 * Pure functions only; the tick owns smoothing, persistence and the
 * mix-epoch segmentation (see plugin.mjs).
 */
import {
  canonicalModelName,
  dynamicEffort,
  EFFORT_ORDER,
} from './arms.mjs';

const EFFORTS = new Set(EFFORT_ORDER);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Effort from a decorated `model(effort)[1m]` string, else null. */
function effortOfDecorated(model) {
  if (typeof model !== 'string') return null;
  const m = /\(([A-Za-z]+)\)(?:\[1m\])?$/.exec(model);
  return m && EFFORTS.has(m[1]) ? m[1] : null;
}

/**
 * Stable arm key (model+effort) for one ledger record. Prefers the routed
 * armId (classic ids already encode effort); otherwise the canonical model
 * plus the recorded, decorated, or family-default effort.
 */
export function armKeyOfRecord(r) {
  if (r == null || typeof r !== 'object') return null;
  const armId = typeof r.armId === 'string' && r.armId.length > 0 ? r.armId : null;
  const model = canonicalModelName(r.actualModel)
    ?? canonicalModelName(r.wouldModel)
    ?? canonicalModelName(r.eventModel)
    ?? null;
  const effort = (typeof r.effort === 'string' && EFFORTS.has(r.effort) ? r.effort : null)
    ?? effortOfDecorated(r.wouldModel)
    ?? effortOfDecorated(r.actualModel)
    ?? (model != null ? dynamicEffort(model) : null);
  const base = armId ?? model;
  if (base == null) return null;
  if (effort != null && !base.endsWith(`-${effort}`)) return `${base}:${effort}`;
  return base;
}

/**
 * Arm key for runs whose arm is unknowable (no decision, no model): they
 * still burned quota, so they price as their own segment rather than
 * vanishing from the denominator.
 */
export const UNATTRIBUTED_ARM = 'unattributed';

/**
 * Count records per arm key. Records without an arm key are skipped, unless
 * `unattributed` names a bucket for them (the tick always buckets: an
 * arm-less run in a meter span must hold its share of the delta).
 */
export function countRunsByArm(records, { unattributed = null } = {}) {
  const out = {};
  for (const r of records ?? []) {
    const k = armKeyOfRecord(r) ?? unattributed;
    if (k == null) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

/**
 * Split one pooled meter sample across the arms that ran in its span.
 *   deltaPct: pooled meter delta over the span (fraction of one lane quota)
 *   runsByArm: { [armKey]: runs started in the span }
 *   priorByArm: measured per-arm burn so far (absolute scale)
 *   anchorByArm: cost-model relative burn per arm (ladder burnPerRunPct)
 *
 * Each arm's prior (measured, else the sample average scaled by its anchor
 * ratio, else the sample average) times its run count sets its
 * responsibility; the observed delta scales all priors by one factor, so a
 * pure-span sample measures its arm exactly. Arms with no runs get no
 * sample. Per-update moves clamp to 8x either way of the sample average so
 * one noisy quantum cannot teleport an arm.
 */
export function attributeArmBurn({ deltaPct, runsByArm, priorByArm = {}, anchorByArm = {} } = {}) {
  const runs = runsByArm ?? {};
  const arms = Object.keys(runs).filter(a => runs[a] > 0);
  const total = arms.reduce((s, a) => s + runs[a], 0);
  if (!(deltaPct > 0) || !(total > 0)) return {};
  const sampleAvg = deltaPct / total;
  const anchorAvg = (() => {
    let num = 0;
    let den = 0;
    for (const a of arms) {
      const c = positive(anchorByArm[a]);
      if (c == null) continue;
      num += runs[a] * c;
      den += runs[a];
    }
    return den > 0 ? num / den : null;
  })();
  const priors = {};
  for (const a of arms) {
    const measured = positive(priorByArm[a]);
    if (measured != null) {
      priors[a] = measured;
      continue;
    }
    const anchor = positive(anchorByArm[a]);
    priors[a] = anchor != null && anchorAvg != null && anchorAvg > 0
      ? sampleAvg * (anchor / anchorAvg)
      : sampleAvg;
  }
  const predicted = arms.reduce((s, a) => s + runs[a] * priors[a], 0);
  const scale = predicted > 0 ? deltaPct / predicted : 1;
  const out = {};
  for (const a of arms) {
    out[a] = clamp(priors[a] * scale, sampleAvg / 8, sampleAvg * 8);
  }
  return out;
}

/** Highest-share arm of a mix (share-weighted { [armKey]: share }); ties break lexically. */
export function dominantArm(mixShares) {
  let best = null;
  let bestShare = 0;
  for (const [arm, share] of Object.entries(mixShares ?? {})) {
    if (!(share > 0)) continue;
    if (share > bestShare || (share === bestShare && (best == null || arm < best))) {
      best = arm;
      bestShare = share;
    }
  }
  return best;
}

/**
 * Effective burn for the CURRENT run mix from per-arm measured burn.
 *   armE: { [armKey]: smoothed measured burn }
 *   mixShares: { [armKey]: share of recent runs }
 *   pooledBurn: smoothed pooled burn (fallback scale for unmeasured arms)
 *   anchorByArm: cost-model relative burn per arm
 *
 * Measured arms price at measurement. Unmeasured arms price at the pooled
 * scale times their anchor ratio -- so a first-time switch to a cheaper arm
 * reprices at once instead of inheriting the old arm's burn. Null when
 * nothing usable exists (no mix, no pooled burn, no measured arm).
 */
export function effectiveBurnForMix({ armE = {}, mixShares = {}, pooledBurn = null, anchorByArm = {} } = {}) {
  const entries = Object.entries(mixShares ?? {}).filter(([, s]) => s > 0);
  const total = entries.reduce((s, [, x]) => s + x, 0);
  if (!(total > 0)) return null;
  const pooled = positive(pooledBurn);
  // The anchor average is over the pool's whole known arm universe, NOT the
  // current mix: a single-arm mix averaged over itself would always ratio to
  // 1 and inherit the old arm's burn. The universe average keeps an
  // unmeasured arm's prior honest relative to the pool it prices.
  const anchorAvg = (() => {
    const vals = Object.values(anchorByArm ?? {}).map(positive).filter(v => v != null);
    if (vals.length === 0) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  })();
  let num = 0;
  let priced = 0;
  for (const [a, s] of entries) {
    const measured = positive(armE[a]);
    let e = measured;
    if (e == null && pooled != null) {
      const anchor = positive(anchorByArm[a]);
      e = anchor != null && anchorAvg != null && anchorAvg > 0
        ? pooled * (anchor / anchorAvg)
        : pooled;
    }
    if (e == null) continue;
    num += (s / total) * e;
    priced += s / total;
  }
  if (!(priced > 0)) return null;
  // Mix arms that price nothing (no measurement, no pooled scale) must not
  // dilute the arms that do: renormalize over the priced share.
  return num / priced;
}
