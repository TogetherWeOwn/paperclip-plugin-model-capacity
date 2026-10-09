/**
 * Cost fallback for arms whose `intelligenceIndexCostPerTask` is null.
 *
 * The free API omits cost for many rows, but the leaderboard carries
 * per-million-token input/output prices. Estimate:
 *
 *   profile = median over arms that have BOTH cost and prices of
 *             cost / (priceIn + priceOut)      // effective MTok per task
 *   estimate = profile * (priceIn + priceOut)
 *
 * This assumes one common task token profile across arms -- coarse, but
 * strictly better than dropping priced arms from every ladder. Estimates
 * are flagged (`estimated: true`) so the shadow log shows which rung
 * costs are measured and which are inferred.
 *
 * Input entries: [{ armId, cost, priceIn, priceOut }].
 * Returns a Map armId -> { C, estimated } with C null only when neither a
 * measured cost nor usable prices exist.
 */

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function positive(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** Effective MTok-per-task profile from arms that have cost AND prices. */
export function costProfile(entries) {
  const ratios = [];
  for (const e of entries ?? []) {
    const cost = positive(e?.cost);
    const pin = positive(e?.priceIn);
    const pout = positive(e?.priceOut);
    if (cost == null || pin == null || pout == null) continue;
    ratios.push(cost / (pin + pout));
  }
  return median(ratios);
}

export function fillCosts(entries) {
  const out = new Map();
  const profile = costProfile(entries);
  for (const e of entries ?? []) {
    const cost = positive(e?.cost);
    if (cost != null) {
      out.set(e.armId, { C: cost, estimated: false });
      continue;
    }
    const pin = positive(e?.priceIn);
    const pout = positive(e?.priceOut);
    if (profile != null && pin != null && pout != null) {
      out.set(e.armId, { C: profile * (pin + pout), estimated: true });
    } else {
      out.set(e.armId, { C: null, estimated: false });
    }
  }
  return out;
}
