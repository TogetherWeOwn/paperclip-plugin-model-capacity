/** Pure resource/accepted-output accounting. No collector, model calls, cash
 * inference, or connection to quota burn. Native attributed outcomes are not
 * available to this plugin yet, so the router never enables this estimator. */
export const DEFAULT_TASK_CALIBRATION = Object.freeze({ enabled: false, windowDays: 7,
  minClosedTasks: 30, minAcceptedTasks: 10, priorTasks: 30, maxRelativeCiHalfWidth: .5 });
const finiteNonnegative = v => Number.isFinite(v) && v >= 0;
const COHORT_FIELDS = ['model', 'effort', 'endpoint', 'pricingVersion', 'role', 'taskClass', 'contextClass'];

/** USD-equivalent resource use under verified endpoint pricing. Output often
 * includes reasoning; charge separate reasoning only when explicitly disjoint. */
export function resourceCost(usage, prices) {
  if (prices?.verified !== true || !usage || !finiteNonnegative(usage.reasoningTokens ?? 0)) return null;
  let cost = 0;
  for (const [tokens, price] of [['freshInputTokens', 'freshInputPerMillion'], ['cacheReadTokens', 'cacheReadPerMillion'],
    ['cacheWriteTokens', 'cacheWritePerMillion'], ['outputTokens', 'outputPerMillion']]) {
    const n = usage[tokens] ?? (tokens === 'cacheWriteTokens' ? 0 : null);
    if (!finiteNonnegative(n) || (n > 0 && !finiteNonnegative(prices[price]))) return null;
    cost += n === 0 ? 0 : n * prices[price] / 1e6;
  }
  if ((usage.reasoningTokens ?? 0) > 0 && usage.reasoningIncludedInOutput !== true) {
    if (usage.reasoningIncludedInOutput !== false || !finiteNonnegative(prices.reasoningPerMillion)) return null;
    cost += usage.reasoningTokens * prices.reasoningPerMillion / 1e6;
  }
  return Number.isFinite(cost) ? cost : null;
}

const sameCohort = (a, b) => COHORT_FIELDS.every(k => typeof a?.[k] === 'string' && a[k].length > 0 && a[k] === b?.[k]);

/** Episode-level ratio estimator: P/A, not success-only cost or a second retry
 * multiplier. Duplicate receipts/events must agree, otherwise refuse evidence.
 * Pending work is censored; rejected/abandoned closed episodes keep their cost. */
export function calibrateTaskCost({ episodes = [], cohort, nowMs, aaProxy, config = DEFAULT_TASK_CALIBRATION } = {}) {
  const cfg = { ...DEFAULT_TASK_CALIBRATION, ...config };
  const reasons = new Set();
  if (!COHORT_FIELDS.every(k => typeof cohort?.[k] === 'string' && cohort[k].length > 0)) reasons.add('unresolved-cohort');
  const seen = new Map(), attemptsSeen = new Map(), samples = [];
  let pendingTasks = 0, attempts = 0;
  for (const e of episodes) {
    if (!sameCohort(e?.cohort, cohort)) continue;
    if (typeof e.episodeId !== 'string' || !e.episodeId) { reasons.add('unresolved-attribution'); continue; }
    if (seen.has(e.episodeId)) {
      if (JSON.stringify(seen.get(e.episodeId)) !== JSON.stringify(e)) reasons.add('conflicting-episode');
      continue;
    }
    seen.set(e.episodeId, e);
    if (!e.closed) { pendingTasks++; continue; }
    if (!Number.isFinite(e.closedAtMs) || e.closedAtMs > nowMs) { reasons.add('invalid-episode-time'); continue; }
    if (nowMs - e.closedAtMs > cfg.windowDays * 86400000) continue;
    if (e.attributionComplete !== true) reasons.add('unresolved-attribution');
    if (e.acceptanceVerified !== true || e.observationWindowComplete !== true
      || !['accepted', 'rejected', 'abandoned'].includes(e.acceptance)) reasons.add('unverified-acceptance');
    let cost = 0;
    if (!Array.isArray(e.attempts) || e.attempts.length === 0) reasons.add('incomplete-cost-coverage');
    for (const a of e.attempts ?? []) {
      if (typeof a?.attemptId !== 'string' || !a.attemptId) { reasons.add('unresolved-attribution'); continue; }
      if (attemptsSeen.has(a.attemptId)) {
        const prev = attemptsSeen.get(a.attemptId);
        if (prev.episodeId !== e.episodeId || JSON.stringify(prev.attempt) !== JSON.stringify(a)) reasons.add('conflicting-attempt');
        continue;
      }
      attemptsSeen.set(a.attemptId, { episodeId: e.episodeId, attempt: a });
      attempts++;
      if (a.identityVerified !== true || (a.cohort && !sameCohort(a.cohort, cohort))) reasons.add('unresolved-attribution');
      if (a.usageComplete !== true || a.pricingVerified !== true || !finiteNonnegative(a.resourceCostUsd)) reasons.add('incomplete-cost-coverage');
      else cost += a.resourceCostUsd;
    }
    samples.push({ X: cost, Y: e.acceptance === 'accepted' ? 1 : 0 });
  }
  const n = samples.length, A = samples.reduce((v, s) => v + s.Y, 0), P = samples.reduce((v, s) => v + s.X, 0);
  if (n < cfg.minClosedTasks) reasons.add('insufficient-closed-tasks');
  if (A < cfg.minAcceptedTasks) reasons.add('insufficient-accepted-tasks');
  if (A === 0) reasons.add('no-accepted-outcomes');
  if (!(Number.isFinite(aaProxy) && aaProxy > 0)) reasons.add('missing-aa-proxy');
  if (!Number.isFinite(P)) reasons.add('nonfinite-resource-cost');
  const complete = !['unresolved-cohort', 'unresolved-attribution', 'incomplete-cost-coverage', 'unverified-acceptance',
    'conflicting-episode', 'conflicting-attempt', 'invalid-episode-time', 'nonfinite-resource-cost'].some(r => reasons.has(r));
  const r = complete && A > 0 ? P / A : null;
  let relativeCiHalfWidth = null;
  if (r > 0 && n > 1) {
    const residuals = samples.map(s => s.X - r * s.Y);
    const mean = residuals.reduce((v, x) => v + x, 0) / n;
    const variance = residuals.reduce((v, x) => v + (x - mean) ** 2, 0) / (n - 1);
    const se = Math.sqrt(variance / (n * (A / n) ** 2));
    relativeCiHalfWidth = 1.96 * se / r;
  }
  if (relativeCiHalfWidth == null || relativeCiHalfWidth > cfg.maxRelativeCiHalfWidth) reasons.add('uncertainty-too-wide');
  const ready = reasons.size === 0;
  const w = n / (n + cfg.priorTasks);
  return { ready, reasons: [...reasons], closedTasks: n, acceptedTasks: A, pendingTasks, attempts,
    knownResourceCost: P, totalResourceCost: complete ? P : null, observedPerAcceptedTask: r, perAttempt: complete && attempts > 0 ? P / attempts : null,
    attemptsPerAcceptedTask: complete && A > 0 ? attempts / A : null,
    tokenProfileMultiplier: complete && attempts > 0 && aaProxy > 0 ? P / attempts / aaProxy : null,
    relativeCiHalfWidth, weight: w,
    estimatedApiEquivalentPerAcceptedTask: ready ? (1 - w) * aaProxy + w * r : null,
    cashUsdPerAcceptedTask: null };
}

/** Common cost basis for comparisons. Never compare a calibrated estimate on
 * one candidate with an uncalibrated proxy on another, or null with zero. */
export function compareTaskCosts(a, b) {
  const calibrated = a?.calibration?.ready === true && b?.calibration?.ready === true
    && typeof a?.calibration?.comparisonBasis === 'string'
    && a.calibration.comparisonBasis === b.calibration.comparisonBasis;
  const key = calibrated ? 'estimatedApiEquivalentPerAcceptedTask' : 'taskCostProxy';
  const x = a?.[key], y = b?.[key];
  if (!finiteNonnegative(x) || !finiteNonnegative(y)) return 0;
  return x - y;
}
