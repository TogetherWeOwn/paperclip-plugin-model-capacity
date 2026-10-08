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
 * it. Returns a fresh rung list with pinned positions applied, then
 * renumbered 0..n in cost order so rung indices stay contiguous.
 */
export function pinRungs(freshRungs, previousRungs) {
  const prevByArm = new Map((previousRungs ?? []).map(r => [r.armId, r]));
  if (prevByArm.size === 0) return freshRungs;
  const freshByArm = new Map(freshRungs.map(r => [r.armId, r]));
  const newcomers = freshRungs.filter(r => !prevByArm.has(r.armId));
  const adjusted = freshRungs.map(r => {
    const prev = prevByArm.get(r.armId);
    if (!prev) return r;
    const displaced = newcomers.some(n => strictlyDominates(n, r));
    if (!displaced) return { ...r, rung: Math.min(prev.rung, freshRungs.length - 1) };
    return r;
  });
  // Renumber contiguously by (pinned rung, cost): pinned rungs win ties.
  const ordered = [...adjusted].sort((a, b) => (a.rung - b.rung) || (a.C - b.C));
  return ordered.map((r, rung) => ({ ...r, rung }));
}

/** Full ladder build for one account: filter, pin against previous, cap. */
export function buildLadder(entries, previousRungs = []) {
  const { rungs, dominated, dropped } = paretoFilter(entries);
  const pinned = pinRungs(rungs, previousRungs);
  return { rungs: pinned, dominated, dropped };
}
