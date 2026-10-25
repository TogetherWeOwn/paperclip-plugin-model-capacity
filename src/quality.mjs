/**
 * Quality composite Q: z-scored AA metrics with null-renormalization.
 *
 * Q(m) = sum(w_k * z_k(m)) / sum(w_k) over the metrics non-null for m.
 * Missing metrics are excluded and weights renormalized -- never imputed
 * as zero, so new arms with incomplete coverage are not punished for
 * simply being unmeasured.
 *
 * This legacy scorer is retained for off/shadow routing compatibility. Its
 * Omniscience negation and cross-version fallbacks are NOT the schema used
 * by the role-aware scorer below.
 *
 * Historical weights follow the research design with the SWE-bench proxy
 * folded into terminal-bench and scicode (no curated proxy table is
 * maintained). v0.1.2 adds hle at .10 with the existing weights scaled
 * x0.9 so the sum stays 1: terminalBench .36, scicode .18, tau2 .09,
 * apexAgents .09, intelligenceIndex .09, hle .10, omniscience .045
 * (negated: it is a hallucination penalty term), lcr .045.
 * The terminal-bench metric reads Hard, falling back to V40 then V21, so
 * free-tier rows that only carry V40 still score. All weights are
 * operator-configurable.
 */

export const DEFAULT_WEIGHTS = Object.freeze({
  terminalBench: 0.36,
  scicode: 0.18,
  tau2: 0.09,
  apexAgents: 0.09,
  intelligenceIndex: 0.09,
  hle: 0.1,
  omniscience: 0.045,
  lcr: 0.045,
});

/** Metric -> candidate AA row fields, first non-null wins. */
export const METRIC_SOURCES = Object.freeze({
  terminalBench: ['terminalbenchHard', 'terminalbenchV40', 'terminalbenchV21'],
  scicode: ['scicode'],
  tau2: ['tau2', 'tauBanking'],
  apexAgents: ['apexAgents'],
  intelligenceIndex: ['intelligenceIndex'],
  hle: ['hle'],
  omniscience: ['omniscience'],
  lcr: ['lcr'],
});

/** Historical negations, retained only in the legacy scorer. */
export const NEGATED_METRICS = new Set(['omniscience']);

function metricValue(row, metric) {
  for (const field of METRIC_SOURCES[metric] ?? []) {
    const v = row?.[field];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function meanStd(values) {
  const n = values.length;
  if (n === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, std: Math.sqrt(variance) };
}

/**
 * Score every arm. Returns [{ armId, Q, coverage }] where coverage is the
 * fraction of weight present for the arm against the COMMON SUPPORT: the
 * metrics actually measured on at least one arm in this set. A free-tier
 * gap that hits every arm (e.g. no apexAgents anywhere) shrinks the
 * denominator instead of pushing every arm under the ladder's coverage
 * bar. Arms with no usable metric at all get Q null (ladder-ineligible,
 * not zero). Call once per account arm set so the support is the
 * account's own.
 */
export function computeComposite(arms, weights = DEFAULT_WEIGHTS) {
  const metrics = Object.keys(weights).filter(k => weights[k] > 0 && METRIC_SOURCES[k]);
  const stats = new Map();
  const supported = [];
  for (const metric of metrics) {
    const values = arms.map(a => metricValue(a.row, metric)).filter(v => v != null);
    if (values.length === 0) continue;
    supported.push(metric);
    stats.set(metric, meanStd(values));
  }
  const supportWeight = supported.reduce((a, m) => a + weights[m], 0);
  return arms.map(arm => {
    let num = 0;
    let present = 0;
    for (const metric of supported) {
      const v = metricValue(arm.row, metric);
      if (v == null) continue;
      const s = stats.get(metric);
      let z = 0;
      if (s && s.std > 0) {
        z = (v - s.mean) / s.std;
        if (NEGATED_METRICS.has(metric)) z = -z;
      }
      num += weights[metric] * z;
      present += weights[metric];
    }
    if (present <= 0) return { armId: arm.armId, Q: null, coverage: 0 };
    return { armId: arm.armId, Q: num / present, coverage: supportWeight > 0 ? present / supportWeight : 0 };
  });
}

// Role ranking is deliberately separate from the legacy composite above:
// mode=off/shadow must not silently change existing routing distributions.
// Source/units verified against the public leaderboard and intelligence-
// benchmarking methodology. Headline Omniscience ranges [-100,100]; its
// non-hallucination component is a fraction [0,1], NOT a hallucination rate.
const metric = (source, version, group, { min = 0, max = 1, aggregate = false, category = 'scored' } = {}) =>
  Object.freeze({ source, direction: 'higher', units: max === 1 ? 'fraction' : 'index', min, max,
    version, group, aggregate, category });
const registry = {
  terminalbenchV40: metric('terminalbenchV40', 'Terminal-Bench 4.0', 'coding'),
  terminalbenchV21: metric('terminalbenchV21', 'Terminal-Bench 2.1', 'coding-legacy', { category: 'legacy' }),
  terminalbenchHard: metric('terminalbenchHard', 'Terminal-Bench Hard (legacy)', 'coding-legacy', { category: 'legacy' }),
  scicode: metric('scicode', 'SciCode (source snapshot harness)', 'coding'),
  codingIndex: metric('codingIndex', 'legacy API coding index; not Coding Agent Index v2', 'coding', { max: 100, aggregate: true }),
  intelligenceIndex: metric('intelligenceIndex', 'Intelligence Index (source snapshot version)', 'intelligence', { max: 100, aggregate: true }),
  hle: metric('hle', 'HLE (source snapshot grader)', 'reasoning'),
  gpqa: metric('gpqa', 'GPQA Diamond (legacy)', 'reasoning', { category: 'legacy' }),
  critpt: metric('critpt', 'CritPt (source snapshot)', 'reasoning'),
  lcr: metric('lcr', 'AA-LCR (source snapshot)', 'long-context'),
  ifbench: metric('ifbench', 'IFBench (source snapshot)', 'instruction'),
  gdpvalNormalized: metric('gdpvalNormalized', 'GDPval normalized (source snapshot)', 'agent'),
  tau2: metric('tau2', 'tau2 (legacy, not Banking)', 'tool-use', { category: 'legacy' }),
  tauBanking: metric('tauBanking', 'Banking (source snapshot)', 'banking'),
  apexAgents: metric('apexAgents', 'APEX Agents (source snapshot)', 'agent'),
  itbenchSre: metric('itbenchSre', 'ITBench SRE (source snapshot)', 'ops'),
  analystAgent: metric('analystAgent', 'AnalystAgent (source snapshot)', 'agent'),
  mmmuPro: metric('mmmuPro', 'MMMU Pro (source snapshot)', 'multimodal'),
  omniscience: metric('omniscience', 'AA-Omniscience headline', 'reliability', { min: -100, max: 100 }),
  omniscienceAccuracy: metric('omniscienceAccuracy', 'AA-Omniscience accuracy', 'reliability'),
  omniscienceNonHallucination: metric('omniscienceNonHallucination', 'AA-Omniscience 1 - hallucination rate', 'reliability'),
};
// Every numeric observation already ingested has a declared disposition.
// Aliases below describe the SAME version, not cross-version fallbacks.
registry.terminalBench40 = { ...registry.terminalbenchV40, source: 'terminalBench40', category: 'diagnostic-only' };
registry.terminalBench21 = { ...registry.terminalbenchV21, source: 'terminalBench21', category: 'diagnostic-only' };
for (const source of ['intelligenceIndexCostPerTask', 'price1mInputTokens', 'price1mOutputTokens', 'cacheHitPrice', 'cacheWritePrice']) {
  registry[source] = { source, direction: 'lower', units: 'USD', min: 0, max: Infinity, version: 'source snapshot', group: 'cost', aggregate: false, category: 'cost-related' };
}
registry.contextWindowTokens = { source: 'contextWindowTokens', direction: 'higher', units: 'tokens', min: 1, max: Infinity,
  version: 'source snapshot', group: 'context', aggregate: false, category: 'feasibility-related' };
for (const source of ['medianOutputTokensPerSecond', 'outputTokensPerSecondP5', 'outputTokensPerSecondP25',
  'outputTokensPerSecondP75', 'outputTokensPerSecondP95', 'percentile05OutputTokensPerSecond',
  'quartile25OutputTokensPerSecond', 'quartile75OutputTokensPerSecond', 'percentile95OutputTokensPerSecond',
  'percentile05TimeToFirstTokenSeconds', 'quartile25TimeToFirstTokenSeconds', 'quartile75TimeToFirstTokenSeconds',
  'percentile95TimeToFirstTokenSeconds', 'medianTimeToFirstTokenSeconds', 'medianTimeToFirstAnswerTokenSeconds',
  'medianEndToEndResponseTimeSeconds', 'medianReasoningTimeSeconds']) {
  registry[source] = { source, direction: source.includes('OutputTokens') ? 'higher' : 'lower',
    units: source.includes('OutputTokens') ? 'tokens/second' : 'seconds', min: 0, max: Infinity,
    version: 'source snapshot', group: 'latency', aggregate: false, category: 'latency-related' };
}
export const METRIC_REGISTRY = Object.freeze(Object.fromEntries(Object.entries(registry).map(([k, v]) => [k, Object.freeze(v)])));

export const DEFAULT_ROLE_METRIC_WEIGHTS = Object.freeze({
  doer: Object.freeze({ terminalbenchV40: .45, scicode: .15, lcr: .15, ifbench: .15, omniscienceNonHallucination: .10 }),
  reviewer: Object.freeze({ terminalbenchV40: .25, hle: .20, lcr: .20, ifbench: .20, omniscienceNonHallucination: .15 }),
  thinker: Object.freeze({ hle: .25, gpqa: .15, critpt: .15, gdpvalNormalized: .15, lcr: .15, ifbench: .10, omniscienceNonHallucination: .05 }),
  other: Object.freeze({ terminalbenchV40: .45, scicode: .15, lcr: .15, ifbench: .15, omniscienceNonHallucination: .10 }),
});

export function validateMetricWeights(weights) {
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) return ['profile must be a metric-weight object'];
  const errors = [];
  let total = 0;
  for (const [key, value] of Object.entries(weights)) {
    if (!Number.isFinite(value) || value < 0) errors.push(`${key}: weight must be finite and nonnegative`);
    if (value > 0) {
      total += value;
      if (!METRIC_REGISTRY[key] || !['scored', 'legacy'].includes(METRIC_REGISTRY[key].category)) errors.push(`${key}: unsupported quality metric`);
    }
  }
  if (!(total > 0) || !Number.isFinite(total)) errors.push('profile must have a finite positive total weight');
  const keys = Object.keys(weights).filter(k => weights[k] > 0);
  // Broad index plus its components double counts evidence. Coding index
  // schema is legacy/unknown: never claim it is current agentic coding.
  if (keys.includes('intelligenceIndex') && keys.some(k => !['intelligenceIndex', 'ifbench', 'itbenchSre', 'mmmuPro', 'analystAgent', 'apexAgents', 'codingIndex', 'tau2'].includes(k))) errors.push('intelligenceIndex conflicts with component evidence');
  if (keys.includes('codingIndex') && keys.some(k => ['terminalbenchV40', 'terminalbenchV21', 'terminalbenchHard', 'scicode'].includes(k))) errors.push('codingIndex conflicts with coding component evidence');
  if (keys.includes('omniscience') && keys.some(k => ['omniscienceAccuracy', 'omniscienceNonHallucination'].includes(k))) errors.push('omniscience conflicts with its components');
  return errors;
}

export function metricObservation(row, key) {
  const m = METRIC_REGISTRY[key];
  const raw = m ? row?.[m.source] : null;
  if (raw == null) return { value: null, reason: 'missing' };
  if (!Number.isFinite(raw) || raw < m.min || raw > m.max) return { value: null, reason: 'invalid-observation' };
  return { value: raw, reason: null };
}

/** Profile coverage is absolute as well as common-support relative. Nulls
 * never become zeroes. Population may differ from the scored account; the
 * fleet caller deduplicates model-effort identity before normalization. */
export function computeRoleComposite(arms, weights, { population = arms } = {}) {
  const errors = validateMetricWeights(weights);
  if (errors.length) throw new Error(errors.join('; '));
  const metrics = Object.keys(weights).filter(k => weights[k] > 0);
  const stats = new Map(metrics.map(k => [k, meanStd(population.map(a => metricObservation(a.row, k).value).filter(v => v != null))]));
  const total = metrics.reduce((n, k) => n + weights[k], 0);
  const support = metrics.reduce((n, k) => n + (stats.get(k) ? weights[k] : 0), 0);
  return arms.map(arm => {
    let num = 0, present = 0, observedWeight = 0;
    const components = Object.fromEntries(metrics.map(key => {
      const observation = metricObservation(arm.row, key);
      if (observation.value != null) observedWeight += weights[key];
      const s = stats.get(key);
      const z = observation.value == null || !s ? null : s.std > 0 ? (observation.value - s.mean) / s.std : 0;
      if (z != null) { num += weights[key] * z; present += weights[key]; }
      return [key, { ...observation, z, weight: weights[key], version: METRIC_REGISTRY[key].version,
        observedAt: arm.row?.fieldObservedAt?.[key] ?? null, source: arm.row?.fieldSources?.[key] ?? 'aa-snapshot' }];
    }));
    return { armId: arm.armId, Q: present > 0 ? num / present : null, coverage: support > 0 ? present / support : 0,
      absoluteCoverage: observedWeight / total, components };
  });
}
