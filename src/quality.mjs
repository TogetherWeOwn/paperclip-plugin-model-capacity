/**
 * Quality composite Q: z-scored AA metrics with null-renormalization.
 *
 * Q(m) = sum(w_k * z_k(m)) / sum(w_k) over the metrics non-null for m.
 * Missing metrics are excluded and weights renormalized -- never imputed
 * as zero, so new arms with incomplete coverage are not punished for
 * simply being unmeasured.
 *
 * Default weights follow the research design with the SWE-bench proxy
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

/** Metrics where a higher raw value means worse quality. */
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
