/**
 * EEE benchmark prior (Phase 2): a secondary quality signal beside AA.
 *
 * Pure and deterministic: no clock, no network, no randomness. Same input
 * always yields the same output. All time inputs (evalDate, builtAt) arrive
 * as data; "now" is never read here -- callers pass an explicit reference
 * timestamp so tests and ticks agree bit-for-bit.
 *
 * Source: the derived artifact the weekly host job publishes on the lane
 * endpoint (`eee-scores.json`: { version, snapshotSha, builtAt, scores }).
 * scores keys are "<normalized model id>(<effort>)" with the same id rules
 * the arm mapper uses; each arm carries per-benchmark rows
 * { score, se, ciLow, ciHigh, n, evalDate, harness, firstParty }.
 *
 * Composite (research §3):
 *   Q_eee(m) = sum(w_k * z_k(m) * r_k(m)) / sum(w_k * r_k(m))
 * over the metrics non-null for m (null-renormalization, never zero-fill).
 * z_k is the z-score across the arms in the current scored set, same
 * convention as quality.mjs. r_k(m) is the reliability weight
 * 1/(1+(SE/scale)^2) with scale = cross-arm std of that metric; rows
 * without uncertainty get r = 0.7.
 *
 * Per-row adjustments (multiplicative, research §3/§7):
 * - staleness decay on evalDate: full weight <= 90 days, exponential decay
 *   with a 120-day half-life after, floor 0.25; undated rows x 0.7.
 * - first-party rows x eeeFirstPartyDiscount (default 0.5).
 * - harness mismatch (row harness names an agent family different from the
 *   arm's own family agent) x 0.7.
 * - a TB `high` row may inform the max arm at x 0.5 (one-way borrowing);
 *   any other effort mismatch is excluded, never borrowed.
 *
 * Blend: Q(m) = (1-alpha) * Q_aa(m) + alpha * Q_eee(m), alpha = 0.25 for
 * doer arms and 0.10 for thinker arms (configurable).
 *
 * CI rung gate (research §5): a newcomer displaces an incumbent's rung only
 * when |Δ| > 1.96 * sqrt(SE1^2 + SE2^2) on the shared TB4 comparison; rows
 * without SE keep today's exact behavior (pin unless strictly dominated).
 */

export const EEE_VERSION = 1;

/** Derived metric -> weight. Sums to 1; AA anchor fields keep it grounded. */
export const DEFAULT_EEE_WEIGHTS = Object.freeze({
  tb4: 0.35,
  bfcl: 0.15,
  sweVerified: 0.1,
  hle: 0.1,
  aaCoding: 0.1,
  aaIntel: 0.15,
  vals: 0.05,
});

export const DEFAULT_EEE_BLEND_DOER = 0.25;
export const DEFAULT_EEE_BLEND_THINKER = 0.1;
export const DEFAULT_EEE_MAX_AGE_DAYS = 7;
export const DEFAULT_EEE_FIRST_PARTY_DISCOUNT = 0.5;
export const DEFAULT_EEE_DECAY_HALF_LIFE_DAYS = 120;
export const DEFAULT_EEE_NO_SE_RELIABILITY = 0.7;

const DAY_MS = 24 * 3600 * 1000;
const FULL_WEIGHT_DAYS = 90;
const DECAY_FLOOR = 0.25;
const UNDATED_DISCOUNT = 0.7;
const HARNESS_MISMATCH_DISCOUNT = 0.7;
const HIGH_TO_MAX_BORROW = 0.5;

/** Vendor agent family for harness-mismatch detection. */
function agentFamilyOf(harness) {
  if (typeof harness !== 'string') return null;
  const h = harness.toLowerCase();
  if (h.includes('claude')) return 'claude';
  if (h.includes('codex')) return 'codex';
  if (h.includes('grok')) return 'grok';
  if (h.includes('muse')) return 'muse';
  return 'other';
}

/** Arm model id -> vendor agent family (same family rules as arms.mjs). */
function armFamilyOf(model) {
  if (typeof model !== 'string') return null;
  const m = model.toLowerCase();
  if (m.startsWith('claude-') || m.includes('fable')) return 'claude';
  if (m.includes('sol') || m.includes('luna') || m.includes('astra') || m.includes('terra') || m.includes('oss')) return 'codex';
  if (m.includes('muse')) return 'muse';
  if (m.includes('grok')) return 'grok';
  return 'other';
}

function parseTimeMs(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * Normalize an EEE derived key or raw model id with the plugin's id rules:
 * provider-prefix strip, trailing [1m] and (effort) decoration strip, BFCL
 * -fc/-prompt harness-tag strip. Returns the bare id or null.
 */
export function normalizeEeeId(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let bare = raw.includes('/') ? raw.slice(raw.indexOf('/') + 1) : raw;
  if (bare.endsWith('[1m]')) bare = bare.slice(0, -4);
  // Strip a trailing "(effort)" decoration ONLY when the paren content is a
  // known effort label: model ids themselves may contain dots/parens
  // (e.g. gpt-6.1-sol, claude-opus-4-5-20251101), so a blind lastIndexOf('(')
  // strip would eat dotted ids like "muse-spark-1.3(xhigh)" -> "muse-spark-1".
  const paren = /\(([a-z]+)\)$/.exec(bare);
  if (paren) {
    if (new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).has(paren[1])) {
      bare = bare.slice(0, bare.length - paren[0].length);
    } else {
      return null;
    }
  }
  bare = bare.toLowerCase().replace(/-fc(?=-|$)/g, '').replace(/-prompt(?=-|$)/g, '');
  bare = bare.replace(/-+/g, '-').replace(/^-|-$/g, '');
  // Keep dots: dotted CLIProxy ids (gpt-6.1-sol) and dotted EEE bare ids
  // (muse-spark-1.3) must survive normalization so both sides join.
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(bare)) return null;
  return bare.length > 0 ? bare : null;
}

/**
 * EEE derived key -> arm binding. Keys are "<bare id>(<effort>)"; the bare
 * part follows normalizeEeeId. Effort suffixes outside the known set map to
 * max (the AA mirror's base slot is max). Returns { model, effort } or null.
 */
export function eeeKeyToArm(key) {
  if (typeof key !== 'string') return null;
  const m = /^(.*)\(([a-z]+)\)$/.exec(key);
  const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  if (m) {
    const model = normalizeEeeId(m[1]);
    if (!model) return null;
    return { model, effort: EFFORTS.has(m[2]) ? m[2] : 'max' };
  }
  const model = normalizeEeeId(key);
  return model ? { model, effort: 'max' } : null;
}

/** Alias form for joining derived keys to arm models across sources: the TB
 * harness emits dotted ids (opus-5.5) while the AA mirror emits dashed,
 * prefixed ids (claude-opus-5-5) for the same model. Lowercase, dots->dashes,
 * leading claude- stripped. Distinct models stay distinct (opus-5 vs
 * opus-5-5); same-model spellings merge. */
function aliasBare(bare) {
  return String(bare ?? '').toLowerCase().replace(/\./g, '-').replace(/^claude-/, '');
}

/** Split a derived scores key into { bare, keyEffort } (keyEffort null when
 * the key carries no parens). */
function splitScoresKey(key) {
  const m = /^(.*)\(([a-z]+)\)$/.exec(key);
  if (m) return { bare: m[1], keyEffort: m[2] };
  return { bare: key, keyEffort: null };
}

function rowRecency(row) {
  return { t: parseTimeMs(row?.evalDate) ?? -1, n: typeof row?.n === 'number' ? row.n : -1 };
}

function reliabilityWeight(se, scale, noSeReliability = DEFAULT_EEE_NO_SE_RELIABILITY) {
  if (typeof se !== 'number' || !Number.isFinite(se) || se < 0) return noSeReliability;
  if (!(scale > 0)) return noSeReliability;
  const t = se / scale;
  return 1 / (1 + t * t);
}

function stalenessWeight(evalDate, nowMs, halfLifeDays = DEFAULT_EEE_DECAY_HALF_LIFE_DAYS) {
  const at = parseTimeMs(evalDate);
  if (at == null || !Number.isFinite(nowMs)) return UNDATED_DISCOUNT;
  const ageDays = (nowMs - at) / DAY_MS;
  if (ageDays <= FULL_WEIGHT_DAYS) return 1;
  const hl = halfLifeDays > 0 ? halfLifeDays : DEFAULT_EEE_DECAY_HALF_LIFE_DAYS;
  const decayed = Math.pow(0.5, (ageDays - FULL_WEIGHT_DAYS) / hl);
  return Math.max(DECAY_FLOOR, decayed);
}

/**
 * Effective row weight: reliability x staleness x first-party x harness.
 * Returns { weight, row, metric } or null when the row cannot inform the arm
 * (effort mismatch other than high->max borrowing).
 */
function rowWeight(metric, row, armEffort, armModel, nowMs, opts = {}) {
  const firstPartyDiscount = opts.firstPartyDiscount ?? DEFAULT_EEE_FIRST_PARTY_DISCOUNT;
  const halfLifeDays = opts.decayHalfLifeDays ?? DEFAULT_EEE_DECAY_HALF_LIFE_DAYS;
  const rowEffort = typeof row?.effort === 'string' ? row.effort : 'max';
  let borrow = 1;
  if (rowEffort !== armEffort) {
    // One-way borrowing: a `high` row weakly informs the max arm. Any other
    // mismatch (including max informing high) is excluded.
    if (!(rowEffort === 'high' && armEffort === 'max')) return null;
    borrow = HIGH_TO_MAX_BORROW;
  }
  const score = typeof row?.score === 'number' && Number.isFinite(row.score) ? row.score : null;
  if (score == null) return null;
  let w = reliabilityWeight(row.se, opts.scales?.[metric]);
  w *= stalenessWeight(row.evalDate, nowMs, halfLifeDays);
  if (row.firstParty === true) w *= firstPartyDiscount;
  const rowFam = agentFamilyOf(row.harness);
  const armFam = armFamilyOf(armModel);
  if (rowFam != null && armFam != null && rowFam !== 'other' && armFam !== 'other' && rowFam !== armFam) {
    w *= HARNESS_MISMATCH_DISCOUNT;
  }
  return { weight: w * borrow, row, metric };
}

function meanStd(values) {
  const n = values.length;
  if (n === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, std: Math.sqrt(variance) };
}

/**
 * Score arms on the EEE prior. arms: [{ armId, model, effort }] (armId is
 * the ladder arm id, e.g. an AA slug; model is the bare CLIProxy id).
 * eeeScores: the derived `scores` map. nowMs: explicit reference time.
 * Returns a Map armId -> { Qeee, coverage, detail } where detail maps metric
 * -> { score, weight }. Arms with no informing row get Qeee null (never 0).
 */
export function computeEeeComposite(arms, eeeScores, {
  weights = DEFAULT_EEE_WEIGHTS,
  nowMs = Date.now(),
  firstPartyDiscount = DEFAULT_EEE_FIRST_PARTY_DISCOUNT,
  decayHalfLifeDays = DEFAULT_EEE_DECAY_HALF_LIFE_DAYS,
} = {}) {
  const out = new Map();
  if (!eeeScores || typeof eeeScores !== 'object') {
    for (const a of arms ?? []) out.set(a.armId, { Qeee: null, coverage: 0, detail: {} });
    return out;
  }
  const metrics = Object.keys(weights).filter(k => weights[k] > 0);
  // Collect informing rows per metric across the scored set.
  const byMetricRows = new Map(metrics.map(m => [m, []]));
  const perArm = new Map();
  for (const arm of arms ?? []) {
    const model = normalizeEeeId(arm?.model);
    const effort = arm?.effort ?? 'max';
    const rows = [];
    if (model) {
      // Gather every informing row for this model across alias spellings:
      // exact "<bare>(<effort>)" key, bare key without parens, dotted/dashed
      // and claude-prefixed variants of the same model (aliasBare), plus the
      // one-way high->max borrow for max arms. Per metric, an exact-effort
      // row beats a borrowed one; ties break by latest evalDate, then n.
      const want = aliasBare(model);
      const best = new Map();
      for (const key of Object.keys(eeeScores)) {
        const { bare, keyEffort } = splitScoresKey(key);
        if (aliasBare(normalizeEeeId(bare) ?? bare) !== want) continue;
        const bucket = eeeScores[key];
        const benchmarks = bucket?.benchmarks;
        if (!benchmarks || typeof benchmarks !== 'object') continue;
        let borrowed = false;
        let useEffort = effort;
        if (keyEffort == null) {
          useEffort = effort;
        } else if (keyEffort === effort) {
          useEffort = effort;
        } else if (effort === 'max' && keyEffort === 'high') {
          useEffort = 'high';
          borrowed = true;
        } else {
          continue;
        }
        for (const m of metrics) {
          const src = benchmarks[m];
          if (src == null) continue;
          const cur = best.get(m);
          const rec = rowRecency(src);
          const curRec = cur ? rowRecency(cur.src) : null;
          const wins = !cur
            || (cur.borrowed && !borrowed)
            || (cur.borrowed === borrowed && (rec.t > curRec.t || (rec.t === curRec.t && rec.n > curRec.n)));
          if (wins) best.set(m, { src, useEffort, borrowed });
        }
      }
      for (const m of metrics) {
        const found = best.get(m);
        if (found) rows.push({ metric: m, row: { effort: found.useEffort, ...found.src } });
      }
    }
    perArm.set(arm.armId, rows);
    for (const r of rows) byMetricRows.get(r.metric).push(r.row.score);
  }
  const stats = new Map();
  for (const m of metrics) {
    const vals = (byMetricRows.get(m) ?? []).filter(v => typeof v === 'number' && Number.isFinite(v));
    stats.set(m, { ...meanStd(vals), values: vals });
  }
  const supportWeight = metrics
    .filter(m => (byMetricRows.get(m) ?? []).length > 0)
    .reduce((a, m) => a + weights[m], 0);
  for (const arm of arms ?? []) {
    const rows = perArm.get(arm.armId) ?? [];
    let num = 0;
    let den = 0;
    const detail = {};
    for (const { metric, row } of rows) {
      const s = stats.get(metric);
      let z = 0;
      if (s && s.std > 0) z = (row.score - s.mean) / s.std;
      const rw = rowWeight(metric, row, arm?.effort ?? 'max', arm?.model, nowMs,
        { firstPartyDiscount, decayHalfLifeDays, scales: Object.fromEntries([...stats].map(([k, v]) => [k, v?.std ?? 0])) });
      if (!rw || !(rw.weight > 0)) continue;
      num += weights[metric] * z * rw.weight;
      den += weights[metric] * rw.weight;
      detail[metric] = {
        score: row.score,
        se: typeof row.se === 'number' && Number.isFinite(row.se) && row.se >= 0 ? row.se : null,
        weight: rw.weight,
      };
    }
    if (!(den > 0)) {
      out.set(arm.armId, { Qeee: null, coverage: 0, detail: {} });
      continue;
    }
    out.set(arm.armId, { Qeee: num / den, coverage: supportWeight > 0 ? den / supportWeight : 0, detail });
  }
  return out;
}

/** Blend AA and EEE composites: Q = (1-alpha) * Qaa + alpha * Qeee. */
export function blendQ(qAa, qEee, alpha) {
  if (qAa == null) return null;
  if (qEee == null) return qAa;
  const a = typeof alpha === 'number' && Number.isFinite(alpha) ? Math.min(Math.max(alpha, 0), 1) : 0;
  return (1 - a) * qAa + a * qEee;
}

/** Alpha by role: doers lean on the agentic-coding prior more than thinkers. */
export function blendAlphaForRole(role, { doer = DEFAULT_EEE_BLEND_DOER, thinker = DEFAULT_EEE_BLEND_THINKER } = {}) {
  return role === 'thinker' ? thinker : doer;
}

/**
 * Freshness gate: the artifact is usable only when builtAt is within
 * maxAgeDays of nowMs. Missing/unparseable builtAt (or a version mismatch)
 * means AA-only mode -- the caller must not change any score.
 */
export function eeeUsable(artifact, { nowMs = Date.now(), maxAgeDays = DEFAULT_EEE_MAX_AGE_DAYS } = {}) {
  if (!artifact || typeof artifact !== 'object') return false;
  if (artifact.version !== EEE_VERSION) return false;
  const built = parseTimeMs(artifact.builtAt);
  if (built == null || !Number.isFinite(nowMs)) return false;
  if (nowMs < built) return false;
  return (nowMs - built) / DAY_MS <= maxAgeDays;
}

/**
 * CI-overlap rung gate (research §5): the challenger displaces the incumbent
 * only when |Δ| > 1.96 * sqrt(SE1^2 + SE2^2) on the shared comparison
 * metric. Either SE missing -> today's behavior (strict dominance decides,
 * handled by the ladder pinning; this gate abstains by returning true).
 */
export function ciGateAllowsReorder(challengerSe, incumbentSe, delta) {
  if (typeof delta !== 'number' || !Number.isFinite(delta)) return false;
  const a = typeof challengerSe === 'number' && Number.isFinite(challengerSe) && challengerSe >= 0 ? challengerSe : null;
  const b = typeof incumbentSe === 'number' && Number.isFinite(incumbentSe) && incumbentSe >= 0 ? incumbentSe : null;
  if (a == null || b == null) return true;
  return Math.abs(delta) > 1.96 * Math.sqrt(a * a + b * b);
}

/**
 * Gate datum for the rung-level CI rule (research §5): the comparison-metric
 * row (tb4, the highest-weight benchmark) behind one arm's Q_eee, or null
 * when the arm has no usable row there. A null se means "no error model" --
 * the ladder then keeps today's exact behavior for that pair.
 */
export const EEE_GATE_METRIC = 'tb4';
export function eeeGateDatum(eeeEntry) {
  const d = eeeEntry?.detail?.[EEE_GATE_METRIC];
  if (!d || typeof d.score !== 'number' || !Number.isFinite(d.score)) return null;
  return {
    score: d.score,
    se: typeof d.se === 'number' && Number.isFinite(d.se) && d.se >= 0 ? d.se : null,
  };
}

/**
 * Phase 3 display prior per trial family: Beta(a0, b0) with mean = scaled
 * Q_eee and strength 5 pseudo-runs. mean01 maps Q_eee (z units) into (0,1)
 * via the logistic; the family prior uses the mean Q_eee of its arms.
 * Display-only: no graduation behavior changes.
 */
export function eeeFamilyPrior(qEeeValues) {
  const vals = (qEeeValues ?? []).filter(v => typeof v === 'number' && Number.isFinite(v));
  if (vals.length === 0) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const mean01 = 1 / (1 + Math.exp(-mean));
  const strength = 5;
  return { a0: mean01 * strength, b0: (1 - mean01) * strength, mean01, arms: vals.length };
}
