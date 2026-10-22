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
 * Input entries: [{ armId, family?, cost, priceIn, priceOut }].
 * Returns a Map armId -> { C, estimated } with C null only when no measured
 * cost exists anywhere (entries plus opts.medianPool).
 *
 * Median backstop (2026-10-22): a refresh can drop cost AND prices for a
 * whole family, leaving no profile input at all. A null-cost arm never gets
 * a ladder rung, so the family's lanes empty. Arms with no usable prices
 * take the median measured cost of their own family, else the fleet median,
 * flagged estimated -- a scored, served arm never leaves the ladder only
 * because its cost is null. opts.medianPool carries extra entries (same
 * shape) that widen the median pools without appearing in the output; the
 * caller passes the fleet's served arms so one family's gap never strands
 * a lane that serves only that family.
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

export function fillCosts(entries, opts = {}) {
  const out = new Map();
  const profile = costProfile(entries);
  // One arm, one vote: the caller widens the pool with fleet arms that
  // include the account's own entries, so dedupe by armId (entries win).
  const seen = new Set();
  const pool = [];
  for (const e of [...(entries ?? []), ...(opts.medianPool ?? [])]) {
    const id = e?.armId;
    if (typeof id === 'string') {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    pool.push(e);
  }
  const measuredByFamily = new Map();
  const measuredAll = [];
  for (const e of pool) {
    const cost = positive(e?.cost);
    if (cost == null) continue;
    measuredAll.push(cost);
    const fam = typeof e?.family === 'string' ? e.family : null;
    if (fam) {
      if (!measuredByFamily.has(fam)) measuredByFamily.set(fam, []);
      measuredByFamily.get(fam).push(cost);
    }
  }
  const fleetMedian = median(measuredAll);
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
      continue;
    }
    const fam = typeof e?.family === 'string' ? e.family : null;
    const familyMedian = fam ? median(measuredByFamily.get(fam) ?? []) : null;
    const fallback = familyMedian ?? fleetMedian;
    if (fallback != null) {
      out.set(e.armId, { C: fallback, estimated: true });
    } else {
      out.set(e.armId, { C: null, estimated: false });
    }
  }
  return out;
}
