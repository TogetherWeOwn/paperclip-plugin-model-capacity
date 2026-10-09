/**
 * Context pricing tiers: models whose price per request rises past a prompt
 * length threshold (whole_request: the whole request reprices; excess_only:
 * only tokens past the threshold do).
 *
 * Live feed (same accounts.json body as the lanes): `modelStats`
 * { observedAt, windowHours, thresholds, models: { <normalized id>:
 * { requests, promptTokens: { p10, p50, p90, p99 }, fractionOver: { "<T>": f },
 * cacheReadShare, meanOutputTokens } } } and `pricingTiers`
 * [ { family, match: [regex], vendor, tiers:
 * [ { overPromptTokens, appliesTo, countsCached, multiplier: { input,
 * output, cacheRead, cacheWrite }, pricesPerMTok } ], base,
 * contextWindow, status, source, verifiedAt } ].
 *
 * Effective cost per arm: C_eff = AA costPerTask x E[multiplier], where the
 * expectation blends the tier's per-component multipliers by cost share
 * (prompt split into fresh input vs cache reads via cacheReadShare, plus
 * mean output tokens, weighted by per-MTok prices) and by the measured
 * over-threshold probability. Models with a tier but no measured stats use
 * the fleet baseline (median E over measured models -- never the cheap
 * tier); with nothing measured at all, the tier's own max multiplier.
 * Unverified tiers apply but are flagged (tierSource `unverified`). No
 * matching tier: multiplier 1, source `none`.
 *
 * Context caps vs tiers: a compact window just under the threshold
 * (T - 32k max, 20k below that the auto-compact watermark) is emitted ONLY
 * when feasible (p10 < 0.6 x T). Infeasible tiers -- e.g. Haiku, whose
 * sessions start at ~118k against a 100k cliff -- get NO cap: capping
 * cannot keep them under the cliff, it only burns context. A matched tier
 * that is feasible IS the "threshold requires it" exception that permits
 * sub-250k windows (Sol's 240k). Pure functions only: same input always
 * yields the same output; no clock, no network.
 */

import { canonicalModelName } from './arms.mjs';

/** Safety margin under a price cliff for the compact window. */
export const TIER_CAP_MARGIN_TOKENS = 32000;
/** Auto-compact watermark sits this far under the tier-derived max. */
export const TIER_COMPACT_HEADROOM_TOKENS = 20000;
/** Feasibility gate: p10 must sit this far under the threshold. */
export const TIER_FEASIBILITY_RATIO = 0.6;
/** Windows under this are sub-floor: only a feasible tier permits them. */
export const MIN_CONTEXT_CAP_TOKENS = 250000;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Feed matching key for a model id: provider-prefix, (effort) and [1m]
 * decorations stripped (canonicalModelName), lowercased for case-insensitive
 * tier regexes. Null when the id carries nothing matchable.
 */
export function tierModelKey(model) {
  const canon = canonicalModelName(model);
  if (!canon) return null;
  const lower = canon.toLowerCase();
  return lower.length > 0 ? lower : null;
}

/** First pricing-tier entry with any valid regex matching the key. */
export function matchPricingTier(modelKey, pricingTiers) {
  if (!modelKey) return null;
  for (const entry of pricingTiers ?? []) {
    for (const src of entry?.match ?? []) {
      if (typeof src !== 'string' || src.length === 0) continue;
      let hit = false;
      try {
        hit = new RegExp(src).test(modelKey);
      } catch {
        continue; // invalid regex never matches; feed bug, not a crash
      }
      if (hit) return entry;
    }
  }
  return null;
}

/** Stats row for a model key; the feed keys models by normalized id. */
export function modelStatsFor(modelKey, modelStats) {
  const row = modelStats?.models?.[modelKey];
  if (!row || typeof row !== 'object') return null;
  return row;
}

function promptQuantile(stats, q) {
  return num(stats?.promptTokens?.[q]);
}

function typicalPrompt(stats) {
  return promptQuantile(stats, 'p50') ?? promptQuantile(stats, 'p90') ?? promptQuantile(stats, 'p10');
}

/**
 * Measured P(prompt > T), stepwise-linear over the feed's fractionOver
 * points. Below the smallest measured threshold every request is over
 * (1.0, conservative). Null when the threshold sits ABOVE the largest knot
 * or the feed carries no usable points: that ground is unmeasured, and the
 * caller must estimate from quantiles (below) or fall back -- never assume
 * zero over the cliff.
 */
export function overFractionAt(stats, threshold) {
  const frac = stats?.fractionOver;
  if (!frac || typeof frac !== 'object') return null;
  const points = Object.entries(frac)
    .map(([k, v]) => [Number(k), Number(v)])
    .filter(([t, f]) => Number.isFinite(t) && Number.isFinite(f));
  if (points.length === 0) return null;
  points.sort((a, b) => a[0] - b[0]);
  // Strict bounds: an exact hit on a measured threshold returns the MEASURED
  // fraction (the loop below interpolates knots exactly); only unmeasured
  // ground outside the observed range assumes an extreme.
  if (threshold < points[0][0]) return 1.0;
  const last = points[points.length - 1];
  if (threshold > last[0]) return null; // uncovered: unmeasured, not zero
  for (let i = 0; i < points.length - 1; i++) {
    const [t0, f0] = points[i];
    const [t1, f1] = points[i + 1];
    if (threshold >= t0 && threshold <= t1) {
      const w = (threshold - t0) / (t1 - t0);
      return Math.min(1, Math.max(0, f0 + w * (f1 - f0)));
    }
  }
  return last[1];
}

/**
 * Sorted fractionOver knots, or null when the feed carries none.
 * Exported for the quantile estimator below.
 */
export function fractionKnots(stats) {
  const frac = stats?.fractionOver;
  if (!frac || typeof frac !== 'object') return null;
  const points = Object.entries(frac)
    .map(([k, v]) => [Number(k), Number(v)])
    .filter(([t, f]) => Number.isFinite(t) && Number.isFinite(f));
  if (points.length === 0) return null;
  return points.sort((a, b) => a[0] - b[0]);
}

/**
 * Quantile estimate of P(prompt > T) for thresholds the knots do not cover.
 * 0 only when even p99 sits under the cliff; at least 0.9 when p10 already
 * clears it; linear between p10 and p99 otherwise. Null when the stats row
 * carries no quantiles at all. share scales the quantiles down for
 * countsCached=false tiers (cached tokens do not count: compare the raw
 * threshold against uncached quantiles).
 */
export function quantileOverShare(stats, threshold, share = 0) {
  const s = Math.min(1, Math.max(0, num(share) ?? 0));
  const q10 = promptQuantile(stats, 'p10');
  const q99 = promptQuantile(stats, 'p99');
  if (q10 == null || q99 == null) return null;
  const u10 = q10 * (1 - s);
  const u99 = q99 * (1 - s);
  if (u99 < threshold) return 0;
  if (u10 > threshold) return 0.9;
  if (!(u99 > u10)) return u99 >= threshold ? 0.9 : 0;
  return Math.min(1, Math.max(0, (u99 - threshold) / (u99 - u10)));
}

/**
 * P(prompt > T): knots first (compared at the EFFECTIVE threshold, since
 * knots measure full prompts), quantile estimate for uncovered ground
 * (compared at the RAW threshold against uncached quantiles), null when
 * nothing is measured. share is the cache-read share for
 * countsCached=false tiers (0 otherwise).
 */
export function overShareAt(stats, tEff, tRaw = tEff, share = 0) {
  const knots = fractionKnots(stats);
  if (knots && tEff <= knots[knots.length - 1][0]) {
    return overFractionAt(stats, tEff);
  }
  return quantileOverShare(stats, tRaw, share);
}

/**
 * Cost-share-blended tier multiplier: each priced component (fresh input,
 * cache reads, cache writes, output) contributes its price x tokens weight
 * times its multiplier. Prompt splits into cache reads via cacheReadShare;
 * cache-write volume is unmeasured, so that component carries no weight.
 * Components without a price are excluded from both sides. Zero total
 * weight (no prices, no tokens) falls back to the tier's max multiplier --
 * never the cheap assumption. Null when the tier names no multiplier.
 */
export function blendedMultiplier(tier, stats, priceBook) {
  const m = tier?.multiplier;
  if (!m || typeof m !== 'object') return null;
  const mult = {
    input: num(m.input),
    output: num(m.output),
    cacheRead: num(m.cacheRead),
    cacheWrite: num(m.cacheWrite),
  };
  if (Object.values(mult).every(v => v == null)) return null;
  const price = {
    input: num(priceBook?.input),
    output: num(priceBook?.output),
    cacheRead: num(priceBook?.cacheRead),
    cacheWrite: num(priceBook?.cacheWrite),
  };
  const prompt = typicalPrompt(stats) ?? 0;
  const readShare = Math.min(1, Math.max(0, num(stats?.cacheReadShare) ?? 0));
  const outputTokens = Math.max(0, num(stats?.meanOutputTokens) ?? 0);
  const tokens = {
    input: Math.max(0, prompt * (1 - readShare)),
    output: outputTokens,
    cacheRead: Math.max(0, prompt * readShare),
    cacheWrite: 0,
  };
  let weighted = 0;
  let weight = 0;
  for (const k of Object.keys(tokens)) {
    if (mult[k] == null || price[k] == null) continue;
    weighted += tokens[k] * price[k] * mult[k];
    weight += tokens[k] * price[k];
  }
  if (!(weight > 0)) {
    // No priced volume to blend over: assume the worst named multiplier.
    return Math.max(...Object.values(mult).filter(v => v != null));
  }
  return weighted / weight;
}

/** Effective threshold when cached tokens do not count toward the cliff. */
function effectiveThreshold(tier, stats) {
  const t = num(tier?.overPromptTokens);
  if (t == null) return null;
  if (tier?.countsCached === false) {
    const readShare = Math.min(1, Math.max(0, num(stats?.cacheReadShare) ?? 0));
    if (readShare >= 1) return null;
    // A request is over iff full_prompt x (1 - share) > T.
    return t / (1 - readShare);
  }
  return t;
}

/**
 * E[multiplier] core over resolved rows
 * [{ over, tRaw, share, blend, appliesTo }]: over is the effective threshold
 * (scaled up when cached tokens do not count), tRaw the feed threshold, and
 * share the cache-read share for countsCached=false tiers (0 otherwise).
 * whole_request bands: P(T_i <= prompt < T_{i+1}) pays that band's blend;
 * below the first threshold pays 1.0. A band with no computable blend pays
 * the max named multiplier (never the cheap assumption). excess_only rows
 * in a mixed list price their whole band at blend (conservative); a pure
 * excess_only list uses the p50/p90 excess-share approximation below.
 * Any row whose over-share is UNKNOWN (no knots cover it, no quantiles to
 * estimate from) voids the whole expectation -- null, so the caller falls
 * back to the baseline or the tier max. Missing data never prices at 1.0.
 */
function expectFromRows(rows, stats) {
  const valid = (rows ?? []).filter(r => r?.over != null);
  if (valid.length === 0) return null;
  const blends = valid.map(r => r.blend).filter(b => b != null);
  // No computable blend anywhere: no expectation (the caller falls back to
  // the fleet baseline, never 1.0).
  if (blends.length === 0) return null;
  const overs = valid.map(r => overShareAt(stats, r.over, r.tRaw ?? r.over, r.share ?? 0));
  if (overs.some(o => o == null)) return null;
  if (valid.some(r => (r.appliesTo ?? 'whole_request') === 'whole_request')) {
    const priceOf = (r) => r.blend ?? Math.max(...blends, 1);
    let exp = 1 - overs[0]; // under the first cliff: 1.0x
    for (let i = 0; i < valid.length; i++) {
      const overHi = i + 1 < valid.length ? overs[i + 1] : 0;
      exp += Math.max(0, overs[i] - overHi) * priceOf(valid[i]);
    }
    return exp;
  }
  // Pure excess_only: premium share ~= over-fraction x typical excess /
  // typical total (p50/p90 approximation), summed over tiers and capped at
  // the max named multiplier.
  const p50 = typicalPrompt(stats);
  const p90 = promptQuantile(stats, 'p90') ?? p50 ?? 0;
  if (blends.length === 0 || !(p50 > 0)) return null;
  let premium = 0;
  for (let i = 0; i < valid.length; i++) {
    const r = valid[i];
    if (r.blend == null) continue;
    premium += Math.min(1, overs[i] * (Math.max(0, p90 - r.over) / p50)) * (r.blend - 1);
  }
  return Math.min(Math.max(...blends), 1 + Math.max(0, premium));
}

/**
 * E[multiplier] for one matched tier list. blendOf(tier) resolves the
 * tier's price book (uniform or per-tier). stats == null (no measured row)
 * yields null: the caller substitutes the fleet baseline, never 1.0.
 */
export function expectedMultiplier(tiers, stats, priceBook, blendOf = null) {
  const list = (tiers ?? []).filter(t => num(t?.overPromptTokens) != null);
  if (list.length === 0 || stats == null) return null;
  const sorted = [...list].sort((a, b) => a.overPromptTokens - b.overPromptTokens);
  return expectFromRows(sorted.map(t => ({
    over: effectiveThreshold(t, stats),
    tRaw: num(t?.overPromptTokens),
    share: t?.countsCached === false
      ? Math.min(1, Math.max(0, num(stats?.cacheReadShare) ?? 0))
      : 0,
    blend: (blendOf ?? ((x) => blendedMultiplier(x, stats, priceBook)))(t),
    appliesTo: t?.appliesTo ?? 'whole_request',
  })), stats);
}


/** Median of finite values; null when empty. */
export function median(values) {
  const finite = (values ?? []).filter(v => typeof v === 'number' && Number.isFinite(v));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Worst named multiplier across a tier list (the no-data assumption). */
export function maxTierMultiplier(tiers, stats, priceBook) {
  const blends = (tiers ?? []).map(t => blendedMultiplier(t, stats ?? null, priceBook));
  const finite = blends.filter(b => b != null);
  return finite.length > 0 ? Math.max(...finite) : null;
}

/**
 * Full tier costing for one arm. Returns { costBase, costMultiplier,
 * costEffective, tierSource, statsRequests, tierThreshold, tierAppliesTo }.
 * tierSource: verified | unverified | none. baseline is the fleet median E
 * over measured models (null when nothing is measured: the tier's own max
 * multiplier applies). Missing stats never yield 1.0 on a matched tier.
 */
export function armTierCost({ model, costBase, pricingTiers, modelStats, baseline = null }) {
  const key = tierModelKey(model);
  const entry = matchPricingTier(key, pricingTiers);
  const stats = modelStatsFor(key, modelStats);
  const statsRequests = Math.max(0, Math.floor(num(stats?.requests) ?? 0));
  if (!entry) {
    return {
      costBase, costMultiplier: 1, costEffective: costBase,
      tierSource: 'none', statsRequests,
      tierThreshold: null, tierAppliesTo: null,
    };
  }
  const tiers = Array.isArray(entry.tiers) ? entry.tiers : [];
  // Each tier blends against its own book (tier prices, else entry base).
  const blendOf = (t) => blendedMultiplier(t, stats, t?.pricesPerMTok ?? entry?.base ?? null);
  let exp = expectedMultiplier(tiers, stats, null, blendOf);
  if (exp == null) {
    // Unmeasured but tiered: the fleet baseline, clamped into this tier's
    // own [1, max] range. The baseline is other models' median -- applying
    // it raw can price a model above its worst case and knock it off every
    // ladder on a cost it cannot incur.
    const maxMult = maxTierMultiplier(tiers, null, entry?.base);
    const worst = maxMult ?? baseline ?? 1;
    exp = baseline == null ? worst : Math.min(Math.max(baseline, 1), worst);
  }
  const tierSource = entry?.status === 'verified' ? 'verified' : 'unverified';
  const firstT = [...tiers].sort((a, b) => (a?.overPromptTokens ?? 0) - (b?.overPromptTokens ?? 0))[0];
  return {
    costBase,
    costMultiplier: exp,
    costEffective: costBase != null ? costBase * exp : null,
    tierSource,
    statsRequests,
    tierThreshold: num(firstT?.overPromptTokens),
    tierAppliesTo: firstT?.appliesTo ?? 'whole_request',
  };
}

/**
 * Feasibility-gated compact window for a matched tier list: p10 must sit
 * below 0.6 x the (lowest) threshold, else null -- NEVER cap when
 * infeasible. Feasible: { maxTokens: T - 32k, autoCompactTokens: T - 52k }.
 * A feasible tier IS the exception permitting sub-250k windows.
 */
export function tierContextCap(tiers, stats) {
  const list = (tiers ?? []).filter(t => num(t?.overPromptTokens) != null);
  if (list.length === 0 || stats == null) return null;
  const t = Math.min(...list.map(x => x.overPromptTokens));
  const p10 = promptQuantile(stats, 'p10');
  if (p10 == null || !(p10 < TIER_FEASIBILITY_RATIO * t)) return null;
  return {
    maxTokens: Math.floor(t - TIER_CAP_MARGIN_TOKENS),
    autoCompactTokens: Math.floor(t - TIER_CAP_MARGIN_TOKENS - TIER_COMPACT_HEADROOM_TOKENS),
  };
}

/**
 * Per-model caps from per-arm tier matches, keyed by tierModelKey(model):
 * the most constraining (min maxTokens) cap wins per model. Caps MUST stay
 * per model -- families group unrelated models (every gemini/gemma id maps
 * to 'gemini', both gpt-6-luna ids to 'luna'), so a family-keyed cap leaks
 * one model's compact window onto untiered siblings. Arms without a
 * feasible cap contribute nothing.
 */
export function tierCapsByModel(armCaps) {
  const out = {};
  for (const { model, cap } of armCaps ?? []) {
    const key = tierModelKey(model);
    if (!key || !cap || !(cap.maxTokens > 0)) continue;
    const cur = out[key];
    if (!cur || cap.maxTokens < cur.maxTokens) out[key] = { ...cap };
  }
  return out;
}

/**
 * Fleet baseline E[multiplier]: median expectation over models that match a
 * tier AND carry measured stats. Null when nothing is measured (the caller
 * then assumes the tier's own max multiplier). Never the cheap tier.
 */
export function fleetBaselineForModels(models, pricingTiers, modelStats) {
  const exps = [];
  for (const model of models ?? []) {
    const key = tierModelKey(model);
    const entry = matchPricingTier(key, pricingTiers);
    const stats = modelStatsFor(key, modelStats);
    if (!entry || !stats) continue;
    const tiers = Array.isArray(entry.tiers) ? entry.tiers : [];
    const exp = expectedMultiplier(tiers, stats, null,
      (t) => blendedMultiplier(t, stats, t?.pricesPerMTok ?? entry?.base ?? null));
    if (exp != null) exps.push(exp);
  }
  return median(exps);
}

/** Feasibility-gated compact window for one arm's matched tier, if any. */
export function armTierCap({ model, pricingTiers, modelStats }) {
  const key = tierModelKey(model);
  const entry = matchPricingTier(key, pricingTiers);
  if (!entry) return null;
  return tierContextCap(Array.isArray(entry.tiers) ? entry.tiers : [], modelStatsFor(key, modelStats));
}
