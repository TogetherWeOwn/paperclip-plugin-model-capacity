/**
 * Capacity-change events (pure): diff the lane feed between ticks so UPWARD
 * transitions recompute immediately (no cooldown rung delay) while DOWNWARD
 * transitions keep today's debounce.
 *
 * Upward (auto-heal fast path): new account id, weekly reset (used drops with
 * a forward reset), free-reset burn-horizon arrival, guard end
 * (guardActive true->false), health recovery (non-healthy -> healthy).
 * Downward (debounced): removals, newly unhealthy/exhausted accounts, guard
 * starts. Health flaps unknown->healthy count as recovery only when the
 * previous state was explicitly non-healthy; unknown->healthy on a brand-new
 * id is already covered by the added rule.
 *
 * Warmup: rate estimates from < 60 min of history are not trusted. The tick
 * keeps burnHorizon/linear (position) pacing until the span clears the floor.
 */

export const WARMUP_MIN_SPAN_MS = 60 * 60 * 1000;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

export function isWarmupSpan(spanMs) {
  if (!finite(spanMs)) return true;
  return spanMs < WARMUP_MIN_SPAN_MS;
}

const idOf = (a) => (a != null && typeof a.accountId === 'string' ? a.accountId : null);

function isHealthy(a) {
  return a?.health === 'healthy';
}

/**
 * Diff previous vs current account snapshots.
 * prev/curr: [{ accountId, weeklyUsed, resetAtMs, guardActive, health }].
 * Returns { added, removed, upwardIds:Set, downwardIds:Set,
 *   shouldBypassCooldown(id), changed }.
 */
export function diffCapacityFeed(prev, curr, { nowMs = Date.now() } = {}) {
  void nowMs;
  const prevById = new Map();
  for (const a of prev ?? []) {
    const id = idOf(a);
    if (id != null && !prevById.has(id)) prevById.set(id, a);
  }
  const currById = new Map();
  for (const a of curr ?? []) {
    const id = idOf(a);
    if (id != null && !currById.has(id)) currById.set(id, a);
  }
  const added = [];
  const removed = [];
  const upwardIds = new Set();
  const downwardIds = new Set();

  for (const id of currById.keys()) {
    if (!prevById.has(id)) {
      added.push(id);
      upwardIds.add(id);
    }
  }
  for (const id of prevById.keys()) {
    if (!currById.has(id)) {
      removed.push(id);
      downwardIds.add(id);
    }
  }
  for (const [id, c] of currById) {
    const p = prevById.get(id);
    if (p == null) continue;
    // Guard end is upward; guard start is downward (debounced).
    if (p.guardActive === true && c.guardActive !== true) upwardIds.add(id);
    if (p.guardActive !== true && c.guardActive === true) downwardIds.add(id);
    // Health recovery is upward; newly unhealthy is downward.
    if (!isHealthy(p) && isHealthy(c)) upwardIds.add(id);
    if (isHealthy(p) && !isHealthy(c)) downwardIds.add(id);
    // Weekly reset: used drops a lot while the reset moves forward, or used
    // collapses toward zero on the same window (provider restarts early).
    const pu = p.weeklyUsed;
    const cu = c.weeklyUsed;
    if (finite(pu) && finite(cu) && cu + 0.3 < pu) upwardIds.add(id);
    const pr = p.resetAtMs;
    const cr = c.resetAtMs;
    if (finite(pr) && finite(cr) && cr > pr + 3600000 && finite(pu) && finite(cu) && cu < pu) {
      upwardIds.add(id);
    }
    // Free-reset arrival surfaces as a fresh burn horizon upstream; the feed
    // carries it as burnHorizonMs appearing on the account row.
    if (p.burnHorizonMs == null && c.burnHorizonMs != null) upwardIds.add(id);
  }

  const shouldBypassCooldown = (id) => upwardIds.has(id);
  return {
    added: added.sort(),
    removed: removed.sort(),
    upwardIds,
    downwardIds,
    shouldBypassCooldown,
    changed: added.length > 0 || removed.length > 0 || upwardIds.size > 0 || downwardIds.size > 0,
  };
}
