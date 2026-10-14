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

/**
 * Pre-step guard prediction: the post-step guard flag cannot be diffed before
 * the step that sets it, so predict from this tick's 5h reading against the
 * previous guard state. Mirrors the controller exactly (trip at guardHigh,
 * hold at >= guardRejoin, release below it -- including release on a missing
 * reading while guarded, which the controller treats as rejoin).
 */
export function predictGuard(prevGuardActive, fiveHourUsed, { guardHigh = 0.8, guardRejoin = 0.5 } = {}) {
  const hi = finite(guardHigh) ? guardHigh : 0.8;
  const rejoin = finite(guardRejoin) ? guardRejoin : 0.5;
  if (prevGuardActive === true) {
    if (fiveHourUsed == null) return false;
    return fiveHourUsed >= rejoin;
  }
  if (fiveHourUsed == null) return false;
  return fiveHourUsed >= hi;
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
export function diffCapacityFeed(prev, curr, { nowMs = Date.now(), firstTick = false } = {}) {
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
      // First tick seeds the key without waking the fleet: every id is new
      // to an empty store, so none of them is a real upward transition.
      if (!firstTick) upwardIds.add(id);
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
    // Health recovery is upward; newly unhealthy is downward. Unknown health
    // (null/absent reading) is neither: only an explicitly non-healthy
    // previous state recovers, and only an explicitly non-healthy current
    // state is a loss.
    if (p.health != null && !isHealthy(p) && isHealthy(c)) upwardIds.add(id);
    if (isHealthy(p) && c.health != null && !isHealthy(c)) downwardIds.add(id);
    // Weekly reset: a large drop WITH a forward reset, or a collapse toward
    // zero on the same window (provider restarts early). A mid-window
    // restatement (large drop, same reset, still well above zero) is meter
    // noise, not a reset; an epsilon drop with a reset shift is a re-parse.
    const pu = p.weeklyUsed;
    const cu = c.weeklyUsed;
    const pr = p.resetAtMs;
    const cr = c.resetAtMs;
    const resetForward = finite(pr) && finite(cr) && cr > pr + 3600000;
    // Collapse toward zero on the same window reads as an early provider
    // restart (a deliberate bet: extreme same-window restatements are rarer
    // than early restarts). A reset with real burn behind it drops well over
    // 5 points, so the 5pt-with-shift arm covers every genuine reset.
    const collapseToZero = finite(pu) && finite(cu) && pu >= 0.4 && cu <= 0.1;
    const dropWithShift = finite(pu) && finite(cu) && resetForward && cu + 0.05 < pu;
    if (collapseToZero || dropWithShift) upwardIds.add(id);
    // Free-reset arrival surfaces as a fresh burn horizon upstream; the feed
    // carries it as burnHorizonMs appearing on the account row.
    if (p.burnHorizonMs == null && c.burnHorizonMs != null) upwardIds.add(id);
  }

  const shouldBypassCooldown = (id) => upwardIds.has(id);
  // First tick only seeds: report the ids but raise no wake and no bypass.
  if (firstTick) {
    return {
      added: added.sort(),
      removed: removed.sort(),
      upwardIds: new Set(),
      downwardIds: new Set(),
      shouldBypassCooldown: () => false,
      changed: false,
    };
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    upwardIds,
    downwardIds,
    shouldBypassCooldown,
    changed: added.length > 0 || removed.length > 0 || upwardIds.size > 0 || downwardIds.size > 0,
  };
}
