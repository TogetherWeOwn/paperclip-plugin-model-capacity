/**
 * Per-account Pareto ladder.
 *
 * Survivors are arms no other arm beats on both quality (Q up) and cost
 * (C = intelligenceIndexCostPerTask down); the rest are dominated and
 * dropped. Sorted by cost ascending they form rungs L0 (cheapest) .. Ln
 * (best). Arms with coverage below 0.6 are ladder-eligible only up to one
 * rung above the cheapest, so unmeasured arms cannot jump to the top.
 *
 * Stability rule: a previously-selected arm keeps its rung unless a
 * strictly-dominating newcomer displaces it, so benchmark noise does not
 * flap the ladder between snapshots.
 */

export const LOW_COVERAGE_THRESHOLD = 0.6;
export const LOW_COVERAGE_MAX_RUNG = 1;

/**
 * Pareto filter + rung assignment. Input entries: [{ armId, Q, C,
 * coverage }]. Arms with null Q or C are dropped (reported, not scored).
 * Deterministic tie-break: Q desc, C asc, armId lexical.
 */
export function paretoFilter(entries) {
  const usable = (entries ?? []).filter(e => e.Q != null && e.C != null);
  const dropped = (entries ?? []).filter(e => e.Q == null || e.C == null).map(e => e.armId);
  const survivors = usable.filter(
    m => !usable.some(o => o !== m && o.Q >= m.Q && o.C <= m.C && (o.Q > m.Q || o.C < m.C)),
  );
  survivors.sort((a, b) => (b.Q - a.Q) || (a.C - b.C) || (a.armId < b.armId ? -1 : a.armId > b.armId ? 1 : 0));
  // Rungs run cheapest-first: re-sort survivors by cost ascending with the
  // same deterministic tie-breaks.
  const byCost = [...survivors].sort(
    (a, b) => (a.C - b.C) || (b.Q - a.Q) || (a.armId < b.armId ? -1 : a.armId > b.armId ? 1 : 0),
  );
  const rungs = byCost.map((arm, rung) => ({
    rung,
    armId: arm.armId,
    Q: arm.Q,
    C: arm.C,
    coverage: arm.coverage ?? 1,
    maxRung: (arm.coverage ?? 1) < LOW_COVERAGE_THRESHOLD ? LOW_COVERAGE_MAX_RUNG : byCost.length - 1,
  }));
  const dominated = usable.filter(u => !survivors.includes(u)).map(u => u.armId);
  return { rungs, dominated, dropped };
}

function strictlyDominates(a, b) {
  return a.Q >= b.Q && a.C <= b.C && (a.Q > b.Q || a.C < b.C);
}

/**
 * Stability pinning: keep each surviving incumbent's previous rung unless
 * a newcomer (present in fresh, absent from previous) strictly dominates
 * it. A pin is only honored while it keeps rungs ascending in C (hence in
 * Q -- pareto survivors with lower cost always score higher, so any cost
 * inversion is a quality inversion too). Cost refreshes move C under
 * pinned positions; every pin that would invert the order falls back to
 * the fresh rung, iterating to a fixed point (fresh order is always a
 * fixed point, so this terminates). Returns rungs renumbered 0..n.
 */
export function pinRungs(freshRungs, previousRungs) {
  const prevByArm = new Map((previousRungs ?? []).map(r => [r.armId, r]));
  if (prevByArm.size === 0) return freshRungs;
  const freshByArm = new Map(freshRungs.map(r => [r.armId, r]));
  const newcomers = freshRungs.filter(r => !prevByArm.has(r.armId));
  const finalRung = new Map();
  for (const r of freshRungs) {
    const prev = prevByArm.get(r.armId);
    const displaced = prev ? newcomers.some(n => strictlyDominates(n, r)) : false;
    finalRung.set(r.armId, (prev && !displaced) ? Math.min(prev.rung, freshRungs.length - 1) : r.rung);
  }
  const byFinal = () => [...freshRungs].sort(
    (a, b) => (finalRung.get(a.armId) - finalRung.get(b.armId)) || (a.C - b.C),
  );
  // Yield pinned arms back to fresh until C ascends. Each pass resets at
  // least one arm and pins are never re-applied, so this terminates in at
  // most n passes; all-fresh order is C-ascending by construction.
  for (let pass = 0; pass <= freshRungs.length; pass++) {
    let lastC = -Infinity;
    let bad = null;
    const prefix = [];
    for (const r of byFinal()) {
      prefix.push(r);
      if (r.C < lastC) {
        bad = prefix.filter(x => finalRung.get(x.armId) !== freshByArm.get(x.armId).rung);
        break;
      }
      lastC = r.C;
    }
    if (!bad || bad.length === 0) break;
    for (const x of bad) finalRung.set(x.armId, freshByArm.get(x.armId).rung);
  }
  return byFinal().map((r, rung) => ({ ...r, rung }));
}

/** Full ladder build for one account: filter, pin against previous, cap. */
export function buildLadder(entries, previousRungs = []) {
  const { rungs, dominated, dropped } = paretoFilter(entries);
  const pinned = pinRungs(rungs, previousRungs);
  return { rungs: pinned, dominated, dropped };
}
