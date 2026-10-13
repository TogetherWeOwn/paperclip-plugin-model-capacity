/**
 * Burn horizon (pure): pace each account to an expected provider "free reset"
 * instead of only to its regular weekly reset, so quota is as close to spent
 * as possible when a free reset lands.
 *
 * Today every account paces linearly to its regular resetsAt. Providers
 * (OpenAI/Codex, Meta, ...) also restore quota out of band ("free resets",
 * goodwill/banked restores): you only benefit from one if the account is
 * already used up when it hits. The burn target is therefore to reach ~100%
 * used by min(regular reset, H), where H is a hazard-based horizon:
 *
 *   H = lastFreeResetAt + Q_q(residual gaps)
 *
 * Q_q is the q-quantile of (gap - since) over past inter-arrival gaps longer
 * than `since` (time elapsed since the last free reset). Conditioning on
 * survival self-corrects: when no reset arrives, H slides out toward the
 * regular reset and the allowance relaxes back to linear pace. Deterministic
 * inputs only: lastAt + history arrive on the feed (host-cached, >=1h), the
 * quantile lives in config.
 *
 * Backtest on 53 Codex free resets (2025-09-17..2026-10-13, codex-reset.com):
 *   q=0.25 (H~2.0d): 42/52 resets arrive with <10% left, 38/52 weeks starve ~3.2d
 *   q=0.50 (H~4.0d): 27/52 resets arrive with <10% left, 25/52 weeks starve ~2.5d
 *   q=0.75 (H~8.0d): ~linear pace (H mostly past the 7d window: no-op)
 * Default q=0.5. The horizon is an ALLOWANCE, not a mandate: no demand means
 * no burn, so starvation only follows real work that quota would have served
 * anyway. The 5h guard, exhaustion floor and review reserve are untouched.
 *
 * Generic across providers: {provider: {lastAtMs, gapsMs[]}} comes from the
 * feed (Codex seeded from codex-reset.com, every provider from the host's own
 * restore ledger). A provider with no data reads as "no horizon": bit-for-bit
 * today's linear behavior. An unknown regular reset reads as no horizon too
 * (no linear baseline to clamp a burn rate against). enabled:false is the
 * kill switch.
 */

export const DEFAULT_BURN_HORIZON = Object.freeze({
  /** Kill switch: false restores linear-to-regular-reset pacing bit-for-bit. */
  enabled: true,
  /** Quantile of the residual time-to-next-free-reset (0..1). */
  quantile: 0.5,
  /** The burn rate never exceeds this multiple of the linear rate. */
  maxBurnFactor: 3,
  /** Minimum past gaps before a horizon is trusted (fewer reads as no data). */
  minHistory: 3,
  /** Per-provider quantile overrides, e.g. { codex: 0.25 }. */
  providerQuantiles: Object.freeze({}),
});

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** Config knobs coerced to valid values; anything invalid reads as the default. */
export function normalizeBurnHorizon(raw) {
  const r = raw != null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const q = r.quantile;
  const f = r.maxBurnFactor;
  const m = r.minHistory;
  const pq = r.providerQuantiles;
  const cleanOverrides = {};
  if (pq != null && typeof pq === 'object' && !Array.isArray(pq)) {
    for (const [k, v] of Object.entries(pq)) {
      if (typeof k === 'string' && k && typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1) {
        cleanOverrides[k] = v;
      }
    }
  }
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_BURN_HORIZON.enabled,
    quantile: typeof q === 'number' && Number.isFinite(q) && q > 0 && q < 1
      ? q : DEFAULT_BURN_HORIZON.quantile,
    maxBurnFactor: typeof f === 'number' && Number.isFinite(f) && f >= 1
      ? f : DEFAULT_BURN_HORIZON.maxBurnFactor,
    minHistory: Number.isInteger(m) && m >= 1 ? m : DEFAULT_BURN_HORIZON.minHistory,
    providerQuantiles: cleanOverrides,
  };
}

/**
 * q-quantile of the residual gaps (gap - sinceMs) over past gaps longer than
 * sinceMs. gapsMs need not be sorted. Returns ms, or null when no gap outlives
 * `since` (overdue: hold linear pace, never force an infinite rate).
 */
export function residualQuantileMs(gapsMs, sinceMs, q) {
  const since = Math.max(0, sinceMs ?? 0);
  const qq = typeof q === 'number' && Number.isFinite(q) && q > 0 && q < 1 ? q : 0.5;
  const residuals = (gapsMs ?? [])
    .filter((g) => finite(g) && g > 0 && g > since)
    .map((g) => g - since)
    .sort((a, b) => a - b);
  if (residuals.length === 0) return null;
  return residuals[Math.min(residuals.length - 1, Math.floor(qq * residuals.length))];
}

/**
 * Effective pace horizon end for one account, or null for "no horizon"
 * (caller keeps the regular reset: fail open, today's behavior).
 *
 * feed: { lastAtMs, gapsMs[] } | null (this account's provider entry).
 * resetAtMs must be a positive finite timestamp: with no regular reset
 * there is no linear baseline to clamp against, so an unknown reset reads
 * as an unknown horizon (null) and the caller keeps its nulls.
 * Returns { horizonMs, horizonHours, quantile, gaps } with horizonMs clamped
 * so the implied burn rate stays within maxBurnFactor x linear.
 */
export function burnHorizon({ nowMs, resetAtMs = null, feed = null, cfg = null }) {
  const c = normalizeBurnHorizon(cfg?.enabled !== undefined || cfg?.quantile !== undefined ||
    cfg?.maxBurnFactor !== undefined || cfg?.minHistory !== undefined ||
    cfg?.providerQuantiles !== undefined ? cfg : (cfg ?? {}));
  if (c.enabled !== true) return null;
  if (!finite(resetAtMs) || !(resetAtMs > 0)) return null;
  const gaps = Array.isArray(feed?.gapsMs) ? feed.gapsMs.filter((g) => finite(g) && g > 0) : [];
  const lastAt = finite(feed?.lastAtMs) ? feed.lastAtMs : null;
  if (lastAt == null || gaps.length < c.minHistory) return null;
  const since = Math.max(0, (nowMs ?? Date.now()) - lastAt);
  const q = finite(cfg?.providerQuantiles?.[feed?.provider]) &&
    cfg.providerQuantiles[feed.provider] > 0 && cfg.providerQuantiles[feed.provider] < 1
    ? cfg.providerQuantiles[feed.provider] : c.quantile;
  const residual = residualQuantileMs(gaps, since, q);
  if (residual == null) return null;
  let horizon = lastAt + since + residual;
  if (horizon >= resetAtMs) return null; // regular reset binds first: no-op
  // Clamp to maxBurnFactor x linear: never burn faster than
  // remaining / (regularHours / maxBurnFactor).
  const regularHours = Math.max((resetAtMs - (nowMs ?? Date.now())) / 3600000, 0);
  if (regularHours > 0) {
    horizon = Math.max(horizon, (nowMs ?? Date.now()) + (regularHours / c.maxBurnFactor) * 3600000);
    if (horizon >= resetAtMs) return null;
  }
  if (!(horizon > (nowMs ?? Date.now()))) return null;
  return {
    horizonMs: horizon,
    horizonHours: horizon - (nowMs ?? Date.now()) > 0
      ? (horizon - (nowMs ?? Date.now())) / 3600000 : 0,
    quantile: q,
    gaps: gaps.length,
  };
}
