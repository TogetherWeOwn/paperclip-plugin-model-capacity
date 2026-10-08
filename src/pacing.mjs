/**
 * Per-account pacing controller (pure transitions; state lives in ctx.state).
 *
 * v0.1.3 is RATE-based: the error is e = measuredRate - requiredRate
 * (weekly fraction per hour), where the measured rate comes from successive
 * lane readings and the required rate is remaining/hoursToReset. Position
 * (used vs linear target) is only a tie-break while no measured rate
 * exists yet. A position-only controller climbs when quota merely *looks*
 * behind even while the current burn already overshoots what's needed --
 * the rate form cannot make that mistake. Deadband is ±15% relative with
 * an absolute floor; the 5h guard still overrides everything because the
 * 5h window binds before the weekly one.
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
  /** Rate mode: hold while |measured - required| is within this fraction of required. */
  rateDeadbandRel: 0.15,
  /** Absolute floor for the rate deadband, fraction/hour (covers ~exhausted windows). */
  rateMinDeadbandPerHour: 0.005,
  /** Utilization history window for the measured rate. */
  rateWindowMin: 60,
  /** Minimum history span before a measured rate is trusted (~10-15 min after install). */
  rateMinSpanMin: 10,
});

/** Utilization history knobs (module constants; operator knobs in DEFAULT_PACING). */
export const RATE_HISTORY_KEEP_MS = 90 * 60 * 1000;
export const RATE_HISTORY_CAP = 120;

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

/**
 * Append a utilization reading to per-account history. Returns a fresh
 * array: sorted, pruned to the keep window, capped by count. Pure (the
 * worker persists the result in plugin state).
 */
export function appendUtilReading(history, { atMs, usedPct }, nowMs = Date.now()) {
  const keepFrom = nowMs - RATE_HISTORY_KEEP_MS;
  const next = [...(history ?? []), { atMs, usedPct }]
    .filter(p => Number.isFinite(p?.atMs) && Number.isFinite(p?.usedPct) && p.atMs >= keepFrom && p.atMs <= nowMs + 60000)
    .sort((a, b) => a.atMs - b.atMs);
  return next.slice(-RATE_HISTORY_CAP);
}

/**
 * Measured burn rate over the trailing window: (newest - oldest used in
 * window) / hours. Returns { ratePerHour, spanMs, points } or null when
 * fewer than 2 in-window points span the minimum span. Counter resets in
 * the lane data (provider restarts the week early) show as negative
 * deltas and are rejected, not trusted.
 */
export function measuredRatePerHour(history, nowMs = Date.now(), windowMin = 60, minSpanMin = 20) {
  const from = nowMs - windowMin * 60000;
  const pts = (history ?? []).filter(p => p.atMs >= from && p.atMs <= nowMs + 60000);
  if (pts.length < 2) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const spanMs = last.atMs - first.atMs;
  if (spanMs < minSpanMin * 60000) return null;
  const delta = last.usedPct - first.usedPct;
  if (!(delta >= 0)) return null;
  return { ratePerHour: delta / (spanMs / 3600000), spanMs, points: pts.length };
}

/** Required burn rate: remaining weekly fraction per hour to land ~100% at reset. */
export function requiredRatePerHour({ remainingPct, hoursToReset }) {
  if (!(remainingPct > 0) || !(hoursToReset > 0)) return 0;
  return remainingPct / hoursToReset;
}

/**
 * Rate-mode controller tick. Same state, actions, guard, and cooldown as
 * stepController; only the error differs:
 * - measured known: e = measured - required, deadband ±rateDeadbandRel
 *   relative (absolute floor rateMinDeadbandPerHour);
 * - measured unknown: e = positionError with the absolute deadband.
 * Reasons always name the rates so the shadow log shows the controller's
 * actual inputs.
 */
export function stepRateController(state, reading, nowMs, cfg = DEFAULT_PACING, ceiling = Number.POSITIVE_INFINITY) {
  const c = { ...DEFAULT_PACING, ...cfg };
  const floor = c.floorRung;
  const top = Math.max(floor, Math.min(ceiling, Number.isFinite(ceiling) ? ceiling : Number.MAX_SAFE_INTEGER));
  const pointer = Math.min(Math.max(state.pointer ?? floor, floor), top);
  const fiveHour = reading.fiveHourUsedPct;
  const keepStamp = state.lastMoveAtMs ?? nowMs;

  if (fiveHour != null && fiveHour >= c.guardHigh) {
    return {
      pointer: floor, lastMoveAtMs: nowMs, guardActive: true, action: 'floor-guard',
      reason: `5h at ${Math.round(fiveHour * 100)}% >= guard ${Math.round(c.guardHigh * 100)}%: floor rung, shed load`,
    };
  }
  if (state.guardActive) {
    if (fiveHour != null && fiveHour >= c.guardRejoin) {
      return { pointer: floor, lastMoveAtMs: keepStamp, guardActive: true, action: 'hold-guard', reason: '5h guard still active' };
    }
    return { pointer: floor, lastMoveAtMs: keepStamp, guardActive: false, action: 'rejoin', reason: '5h recovered: rejoin at floor' };
  }

  const measured = reading.measuredRatePerHour;
  const required = reading.requiredRatePerHour ?? 0;
  let e;
  let band;
  let basis;
  if (measured != null && Number.isFinite(measured)) {
    e = measured - required;
    band = Math.max(c.rateDeadbandRel * Math.max(required, 0), c.rateMinDeadbandPerHour);
    basis = `rate ${(measured * 100).toFixed(2)}%/h vs required ${(required * 100).toFixed(2)}%/h`;
  } else {
    e = reading.positionError ?? 0;
    band = c.deadband;
    basis = `no measured rate yet: position ${(e * 100).toFixed(1)}%`;
  }
  if (Math.abs(e) <= band) {
    return { pointer, lastMoveAtMs: keepStamp, guardActive: false, action: 'hold', reason: `${basis}: inside deadband` };
  }
  if (nowMs - (state.lastMoveAtMs ?? 0) < c.cooldownMs) {
    return { pointer, lastMoveAtMs: keepStamp, guardActive: false, action: 'hold-cooldown', reason: `${basis}: rung move inside cooldown` };
  }
  if (e < 0 && pointer < top) {
    return { pointer: pointer + 1, lastMoveAtMs: nowMs, guardActive: false, action: 'climb', reason: `${basis}: burning too slowly, climb one rung` };
  }
  if (e > 0 && pointer > floor) {
    return { pointer: pointer - 1, lastMoveAtMs: nowMs, guardActive: false, action: 'descend', reason: `${basis}: burning too fast, descend one rung` };
  }
  return { pointer, lastMoveAtMs: keepStamp, guardActive: false, action: 'hold-limit', reason: `${basis}: at floor/ceiling bound` };
}

/** Serve runs from accounts ordered earliest reset first, largest remainder first. */
export function orderAccounts(accounts) {
  return [...accounts].sort((a, b) => {
    const t = (a.resetAtMs ?? Number.MAX_SAFE_INTEGER) - (b.resetAtMs ?? Number.MAX_SAFE_INTEGER);
    if (t !== 0) return t;
    return (b.remainingPct ?? 0) - (a.remainingPct ?? 0);
  });
}
