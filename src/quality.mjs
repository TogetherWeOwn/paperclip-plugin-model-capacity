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
 * maintained): terminalBench .40, scicode .20, tau2 .10, apexAgents .10,
 * intelligenceIndex .10, omniscience .05 (negated: it is a hallucination
 * penalty term), lcr .05. All weights are operator-configurable.
 */

export const DEFAULT_WEIGHTS = Object.freeze({
  terminalBench: 0.4,
  scicode: 0.2,
  tau2: 0.1,
  apexAgents: 0.1,
  intelligenceIndex: 0.1,
  omniscience: 0.05,
  lcr: 0.05,
});

/** Metric -> candidate AA row fields, first non-null wins. */
export const METRIC_SOURCES = Object.freeze({
  terminalBench: ['terminalbenchHard', 'terminalbenchV40', 'terminalbenchV21'],
  scicode: ['scicode'],
  tau2: ['tau2', 'tauBanking'],
  apexAgents: ['apexAgents'],
  intelligenceIndex: ['intelligenceIndex'],
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
 * fraction of configured weight present for the arm. Arms with no usable
 * metric at all get Q null (ladder-ineligible, not zero).
 */
export function computeComposite(arms, weights = DEFAULT_WEIGHTS) {
  const metrics = Object.keys(weights).filter(k => weights[k] > 0 && METRIC_SOURCES[k]);
  const stats = new Map();
  for (const metric of metrics) {
    const values = arms.map(a => metricValue(a.row, metric)).filter(v => v != null);
    stats.set(metric, meanStd(values));
  }
  const totalWeight = metrics.reduce((a, m) => a + weights[m], 0);
  return arms.map(arm => {
    let num = 0;
    let present = 0;
    for (const metric of metrics) {
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
    return { armId: arm.armId, Q: num / present, coverage: present / totalWeight };
  });
}
