/**
 * Per-account pacing controller (pure transitions; state lives in ctx.state).
 *
 * Each account tracks a rung pointer on its Pareto ladder against a linear
 * burn schedule: used% should reach ~100% exactly at reset. The schedule
 * error e = used - target; behind schedule (quota piling up) climbs a rung
 * or adds parallelism, ahead descends. Deadband plus a rung-move cooldown
 * keep the controller from oscillating; the 5h guard overrides everything
 * because the 5h window binds before the weekly one.
 */

export const DEFAULT_PACING = Object.freeze({
  /** No move while |e| is inside this fraction of the allowance. */
  deadband: 0.02,
  /** At most one rung move per account per this many ms. */
  cooldownMs: 10 * 60 * 1000,
  /** 5h used% at/above this pins the account to its floor rung. */
  guardHigh: 0.8,
  /** Guard releases when 5h used% drops below this. */
  guardRejoin: 0.5,
  floorRung: 0,
});

/** Linear-target schedule error: +ahead (overspent) / -behind. */
export function scheduleError({ usedPct, nowMs, periodStartMs, periodEndMs }) {
  if (!(periodEndMs > periodStartMs)) return 0;
  const elapsed = Math.min(Math.max(nowMs - periodStartMs, 0), periodEndMs - periodStartMs);
  return usedPct - elapsed / (periodEndMs - periodStartMs);
}

/**
 * One controller tick for one account.
 *
 * state: { pointer, lastMoveAtMs, guardActive }
 * reading: { weeklyUsedPct, fiveHourUsedPct, error }
 * ceiling: top rung the account may use (role ceiling applied by caller).
 */
export function stepController(state, reading, nowMs, cfg = DEFAULT_PACING, ceiling = Number.POSITIVE_INFINITY) {
  const c = { ...DEFAULT_PACING, ...cfg };
  const floor = c.floorRung;
  const top = Math.max(floor, Math.min(ceiling, Number.isFinite(ceiling) ? ceiling : Number.MAX_SAFE_INTEGER));
  const pointer = Math.min(Math.max(state.pointer ?? floor, floor), top);
  const fiveHour = reading.fiveHourUsedPct;

  if (fiveHour != null && fiveHour >= c.guardHigh) {
    return {
      pointer: floor,
      lastMoveAtMs: nowMs,
      guardActive: true,
      action: 'floor-guard',
      reason: `5h at ${Math.round(fiveHour * 100)}% >= guard ${Math.round(c.guardHigh * 100)}%: floor rung, shed load`,
    };
  }
  if (state.guardActive) {
    if (fiveHour != null && fiveHour >= c.guardRejoin) {
      return { pointer: floor, lastMoveAtMs: state.lastMoveAtMs ?? nowMs, guardActive: true, action: 'hold-guard', reason: '5h guard still active' };
    }
    return { pointer: floor, lastMoveAtMs: state.lastMoveAtMs ?? nowMs, guardActive: false, action: 'rejoin', reason: '5h recovered: rejoin at floor' };
  }

  const e = reading.error ?? 0;
  if (Math.abs(e) < c.deadband) {
    return { pointer, lastMoveAtMs: state.lastMoveAtMs ?? nowMs, guardActive: false, action: 'hold', reason: `error ${(e * 100).toFixed(1)}% inside deadband` };
  }
  if (nowMs - (state.lastMoveAtMs ?? 0) < c.cooldownMs) {
    return { pointer, lastMoveAtMs: state.lastMoveAtMs ?? nowMs, guardActive: false, action: 'hold-cooldown', reason: 'rung move inside cooldown' };
  }
  if (e < 0 && pointer < top) {
    return { pointer: pointer + 1, lastMoveAtMs: nowMs, guardActive: false, action: 'climb', reason: `behind schedule (${(e * 100).toFixed(1)}%): climb one rung` };
  }
  if (e > 0 && pointer > floor) {
    return { pointer: pointer - 1, lastMoveAtMs: nowMs, guardActive: false, action: 'descend', reason: `ahead of schedule (+${(e * 100).toFixed(1)}%): descend one rung` };
  }
  return { pointer, lastMoveAtMs: state.lastMoveAtMs ?? nowMs, guardActive: false, action: 'hold-limit', reason: 'at floor/ceiling bound' };
}

/** Serve runs from accounts ordered earliest reset first, largest remainder first. */
export function orderAccounts(accounts) {
  return [...accounts].sort((a, b) => {
    const t = (a.resetAtMs ?? Number.MAX_SAFE_INTEGER) - (b.resetAtMs ?? Number.MAX_SAFE_INTEGER);
    if (t !== 0) return t;
    return (b.remainingPct ?? 0) - (a.remainingPct ?? 0);
  });
}
