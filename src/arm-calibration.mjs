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
 * Stable arm key (model+effort) for one ledger record. The routed armId (and
 * the decided effort) outrank observed reality only for an enforced hook
 * decision -- or a shadow pick the observed model confirms (modelMatch): a
 * non-enforced shadow/event-time pick is a routing guess, not observed burn
 * (see calibrationAccount in ledger.mjs). Otherwise the key derives from the
 * model that actually ran (actualModel, else eventModel -- never wouldModel),
 * and unknown or pending models yield no key (they bucket as unattributed).
 */
export function armKeyOfRecord(r) {
  if (r == null || typeof r !== 'object') return null;
  const useDecision = r.enforced === true || r.modelMatch === true;
  const armId = useDecision && typeof r.armId === 'string' && r.armId.length > 0 ? r.armId : null;
  if (armId != null) {
    // Classic routed ids already encode effort; a pending run may name no
    // model yet, so the model is only needed for the effort suffix.
    const modelForEffort = canonicalModelName(r.actualModel)
      ?? canonicalModelName(r.wouldModel)
      ?? canonicalModelName(r.eventModel)
      ?? null;
    const decidedEffort = typeof r.effort === 'string' && EFFORTS.has(r.effort) ? r.effort : null;
    const effort = decidedEffort
      ?? effortOfDecorated(r.actualModel)
      ?? effortOfDecorated(r.eventModel)
      ?? effortOfDecorated(r.wouldModel)
      ?? (modelForEffort != null ? dynamicEffort(modelForEffort) : null);
    if (effort != null && !armId.endsWith(`-${effort}`)) return `${armId}:${effort}`;
    return armId;
  }
  if (useDecision) {
    // Enforced (or model-confirmed) record without an arm id: the decided
    // model is trustworthy.
    const model = canonicalModelName(r.actualModel)
      ?? canonicalModelName(r.wouldModel)
      ?? canonicalModelName(r.eventModel)
      ?? null;
    if (model == null || model === 'unknown') return null;
    const decidedEffort = typeof r.effort === 'string' && EFFORTS.has(r.effort) ? r.effort : null;
    const effort = decidedEffort
      ?? effortOfDecorated(r.actualModel)
      ?? effortOfDecorated(r.eventModel)
      ?? effortOfDecorated(r.wouldModel)
      ?? dynamicEffort(model);
    if (effort != null && !model.endsWith(`-${effort}`)) return `${model}:${effort}`;
    return model;
  }
  // Non-enforced guess: key by what actually ran, with the effort parsed
  // from the observed model -- never the decided arm or effort.
  const observed = canonicalModelName(r.actualModel)
    ?? canonicalModelName(r.eventModel)
    ?? null;
  if (observed == null || observed === 'unknown') return null;
  const effort = effortOfDecorated(r.actualModel)
    ?? effortOfDecorated(r.eventModel)
    ?? dynamicEffort(observed);
  if (effort != null && !observed.endsWith(`-${effort}`)) return `${observed}:${effort}`;
  return observed;
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

/**
 * Re-base a fresh counter-backed (account-weekly) estimate onto the
 * mix-priced group baseline. The 90-minute counter window still spans the OLD
 * mix, so scale by priced/pooled (clamped 8x either way) and move the baseline
 * with it; the capacity weight scales inversely so weight stays consistent
 * with the new burn. Non-weekly samples and missing scales pass through
 * untouched.
 */
export function rebaseSampleToMix(sample, { priced = null, pooled = null } = {}) {
  if (sample?.source !== 'account-weekly') return sample;
  const burn = positive(sample.burnPerRunPct);
  const p = positive(priced);
  const q = positive(pooled);
  if (burn == null || p == null || q == null) return sample;
  if (!Number.isFinite(sample.capacityWeight)) return sample;
  const s = clamp(p / q, 1 / 8, 8);
  return {
    ...sample,
    burnPerRunPct: burn * s,
    capacityWeight: sample.capacityWeight / s,
    groupMedianBurnPerRunPct: p,
  };
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
 * reprices at once instead of inheriting the old arm's burn. The anchor
 * scale derives from arms carrying both a measurement and an anchor, so the
 * caller must supply measurement-era anchors for measured arms (the tick
 * records them on its armE entries -- current ladders may no longer serve
 * the old mix). Null when nothing usable exists (no mix, no pooled burn,
 * no measured arm).
 */
export function effectiveBurnForMix({ armE = {}, mixShares = {}, pooledBurn = null, anchorByArm = {} } = {}) {
  const entries = Object.entries(mixShares ?? {}).filter(([, s]) => s > 0);
  const total = entries.reduce((s, [, x]) => s + x, 0);
  if (!(total > 0)) return null;
  const pooled = positive(pooledBurn);
  // Anchor scale from the arms that produced the pooled measurement (arms
  // with both a measurement in armE and an anchor in anchorByArm), NOT the
  // pool's whole arm universe: pooled prices the OLD mix, so an unmeasured
  // arm's prior must rescale pooled by its anchor relative to the measured
  // arms' anchors. Consulting only armE keys also ignores alias duplication
  // in anchorByArm (one arm indexed under several equivalent keys). With no
  // measured arm, fall back to pooled directly.
  const anchorScale = (() => {
    const scales = [];
    for (const [a, v] of Object.entries(armE ?? {})) {
      const m = positive(v);
      const anchor = positive(anchorByArm?.[a]);
      if (m != null && anchor != null && anchor > 0) scales.push(m / anchor);
    }
    if (scales.length === 0) return null;
    return scales.reduce((s, v) => s + v, 0) / scales.length;
  })();
  let num = 0;
  let priced = 0;
  for (const [a, s] of entries) {
    const measured = positive(armE[a]);
    let e = measured;
    if (e == null && pooled != null) {
      const anchor = positive(anchorByArm[a]);
      if (anchor != null && anchorScale != null && anchorScale > 0) e = anchor * anchorScale;
      else e = pooled;
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
