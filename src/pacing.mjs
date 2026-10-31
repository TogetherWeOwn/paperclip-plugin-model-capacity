/**
 * Per-account pacing controller (pure transitions; state lives in ctx.state).
 *
 * v0.1.3 is RATE-based: the error is e = measuredRate - requiredRate
 * (weekly fraction per hour), where the measured rate comes from successive
 * lane readings and the required rate is remaining/hoursToReset. Position
 * (used vs linear target) is only a tie-break while no measured rate
 * exists yet. A position-only controller climbs when quota merely *looks*
 * behind even while the current burn already overshoots what's needed --
 * the rate form cannot make that mistake. Deadband is ±15% relative, with
 * no absolute floor (a floor swallows real shortfalls on small-required
 * accounts); the 5h guard still overrides everything because the
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
  /** Rate mode: hold while |measured - required| is within this fraction of required. Relative-only. */
  rateDeadbandRel: 0.15,
  /** Utilization history window for the measured rate. */
  rateWindowMin: 60,
  /** Minimum history span before a measured rate is trusted (~10-15 min after install). */
  rateMinSpanMin: 10,
  /**
   * Owner rule (2026-10-20): the cheapest capable model for the job, on every provider and account. Unused quota
   * is spent through throughput (more concurrent runs, see the fleet C*), never by climbing to pricier rungs.
   * False (default) pins the pointer to the floor (the role's cheapest eligible arm); true restores the
   * spend-driven climb.
   */
  climbForSpend: false,
});

/** Utilization history knobs (module constants; operator knobs in DEFAULT_PACING). */
export const RATE_HISTORY_KEEP_MS = 90 * 60 * 1000;
export const RATE_HISTORY_CAP = 120;

/** Linear-target schedule error: +ahead (overspent) / -behind. */
export function scheduleError({ usedPct, nowMs, periodStartMs, periodEndMs, targetUsedPct = 1 }) {
  if (!(periodEndMs > periodStartMs)) return 0;
  const elapsed = Math.min(Math.max(nowMs - periodStartMs, 0), periodEndMs - periodStartMs);
  return usedPct - targetUsedPct * elapsed / (periodEndMs - periodStartMs);
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

/**
 * Whole-percent meters (0.2.53). Vendor meters tick in whole percents, so a
 * 60-minute window over an account burning ~0.4%/h usually sees no tick and
 * reads 0.00%/h: the plugin then believed the pool was idle. A compact TICK
 * LOG per account (the readings where the meter value changed, kept 6h)
 * lets the rate extend back to the last observed tick.
 */
export const METER_QUANTUM = 0.01;
export const TICK_LOG_KEEP_MS = 6 * 3600 * 1000;
export const TICK_LOG_CAP = 64;

/**
 * Append a reading to the tick log. Only value changes are recorded:
 *   { atMs, usedPct, fromAtMs }   a tick (fromAtMs: last reading at the old value)
 *   { atMs, usedPct, seed: true } the first reading, or a counter reset
 *                                 (value went down): not a tick moment.
 * Entries older than the keep window are pruned except the newest one, so
 * the log always knows when the current value was first seen. Pure.
 */
export function appendTickLog(log, { atMs, usedPct }, nowMs = Date.now(), lastSeenAtMs = null) {
  if (!Number.isFinite(atMs) || !Number.isFinite(usedPct)) return Array.isArray(log) ? log : [];
  const cur = (Array.isArray(log) ? log : []).filter(e => Number.isFinite(e?.atMs) && Number.isFinite(e?.usedPct));
  const last = cur[cur.length - 1];
  let next = cur;
  if (last == null) {
    next = [{ atMs, usedPct, seed: true }];
  } else if (atMs > last.atMs && Math.abs(usedPct - last.usedPct) > 1e-9) {
    const entry = usedPct < last.usedPct
      ? { atMs, usedPct, seed: true }
      : { atMs, usedPct, fromAtMs: Number.isFinite(lastSeenAtMs) && lastSeenAtMs >= last.atMs && lastSeenAtMs < atMs ? lastSeenAtMs : last.atMs };
    next = [...cur, entry];
  }
  const keepFrom = nowMs - TICK_LOG_KEEP_MS;
  let firstKept = next.findIndex(e => e.atMs >= keepFrom);
  if (firstKept === -1) firstKept = next.length - 1;
  else if (firstKept > 0) firstKept -= 1; // keep the newest entry before the window
  return next.slice(Math.max(firstKept, next.length - TICK_LOG_CAP));
}

/**
 * Measured rate that survives whole-percent meters. When the trailing
 * window shows a positive rate it is returned unchanged; when utilization
 * did not change inside the window (rate exactly 0):
 *   - last tick within maxExtendMs (6h): the window extends back to that
 *     tick -- rate = delta / (now - fromAtMs), the delta of the tick over
 *     the span since the last reading at the old value -- bounded by
 *     quantum / (now - tickAt): less than one quantum burned since the tick;
 *   - no tick in that span while runs are in flight on the account: the
 *     bound quantum / max(time flat, maxExtendMs) -- never exactly 0;
 *   - otherwise the window's 0 stands (an idle account reads idle).
 * A null window rate (thin data) stays null. Returns the window shape plus
 * `basis` ('window' | 'tick-extended' | 'tick-bound').
 */
export function robustRatePerHour(history, nowMs = Date.now(), windowMin = 60, minSpanMin = 20, {
  tickLog = null, inFlight = 0, quantum = METER_QUANTUM, maxExtendMs = TICK_LOG_KEEP_MS,
} = {}) {
  const base = measuredRatePerHour(history, nowMs, windowMin, minSpanMin);
  if (base == null || !(base.ratePerHour === 0)) return base == null ? null : { ...base, basis: 'window' };
  const log = Array.isArray(tickLog) ? tickLog : [];
  const last = log[log.length - 1];
  const hour = 3600000;
  if (last != null && last.seed !== true && nowMs - last.atMs <= maxExtendMs && nowMs > last.atMs) {
    const prev = log[log.length - 2];
    const from = Number.isFinite(last.fromAtMs) ? last.fromAtMs : (prev?.atMs ?? last.atMs);
    const delta = prev != null ? last.usedPct - prev.usedPct : quantum;
    const sinceTick = nowMs - last.atMs;
    const extended = delta > 0 && nowMs > from ? delta / ((nowMs - from) / hour) : quantum / (sinceTick / hour);
    const bound = quantum / (sinceTick / hour);
    return { ratePerHour: Math.min(extended, bound), spanMs: nowMs - from, points: base.points, basis: 'tick-extended' };
  }
  if ((inFlight ?? 0) > 0) {
    const flatSince = last != null ? Math.min(last.atMs, nowMs - base.spanMs) : nowMs - base.spanMs;
    const flatMs = Math.max(nowMs - flatSince, maxExtendMs);
    return { ratePerHour: quantum / (flatMs / hour), spanMs: nowMs - flatSince, points: base.points, basis: 'tick-bound' };
  }
  return { ...base, basis: 'window' };
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
 *   relative, no floor -- so a total stall (|e| = required) and any real
 *   shortfall on a small-required account read as behind plan;
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

  // Basis is tracked through guard episodes too, so a guard that ends
  // after rates appear still counts as a position -> measured switch.
  const guardBasis = (reading.measuredRatePerHour != null && Number.isFinite(reading.measuredRatePerHour)) ? 'measured' : 'position';
  if (fiveHour != null && fiveHour >= c.guardHigh) {
    return {
      pointer: floor, lastMoveAtMs: nowMs, guardActive: true, rateBasis: guardBasis, action: 'floor-guard',
      reason: `5h at ${Math.round(fiveHour * 100)}% >= guard ${Math.round(c.guardHigh * 100)}%: floor rung, shed load`,
    };
  }
  if (state.guardActive) {
    if (fiveHour != null && fiveHour >= c.guardRejoin) {
      return { pointer: floor, lastMoveAtMs: keepStamp, guardActive: true, rateBasis: guardBasis, action: 'hold-guard', reason: '5h guard still active' };
    }
    return { pointer: floor, lastMoveAtMs: keepStamp, guardActive: false, rateBasis: guardBasis, action: 'rejoin', reason: '5h recovered: rejoin at floor' };
  }

  const measured = reading.measuredRatePerHour;
  const required = reading.requiredRatePerHour ?? 0;
  const measuredKnown = measured != null && Number.isFinite(measured);
  if (c.climbForSpend !== true) {
    const rb = measuredKnown ? 'measured' : 'position';
    return pointer > floor
      ? { pointer: floor, lastMoveAtMs: nowMs, guardActive: false, rateBasis: rb, action: 'cheapest',
        reason: 'cheapest capable rung (climbForSpend off): unused quota goes to throughput, not pricier models' }
      : { pointer: floor, lastMoveAtMs: keepStamp, guardActive: false, rateBasis: rb, action: 'hold-cheapest',
        reason: 'cheapest capable rung (climbForSpend off)' };
  }
  // Persisted basis ('measured' | 'position' | undefined on pre-0.2.1
  // state): when the basis switches from the position fallback to a real
  // measured rate, the cooldown resets so the correction a stale fallback
  // move made necessary is not delayed by that very move.
  const rateBasis = measuredKnown ? 'measured' : 'position';
  const basisSwitched = state.rateBasis === 'position' && rateBasis === 'measured';
  let e;
  let band;
  let basis;
  if (measuredKnown) {
    e = measured - required;
    // Relative-only: no absolute floor. A floor at 0.5%/h swallowed whole
    // required rates (live: measured 0 vs required 0.49%/h read "inside
    // deadband"); any real shortfall must read as deficit.
    band = c.rateDeadbandRel * Math.max(required, 0);
    basis = `rate ${(measured * 100).toFixed(2)}%/h vs required ${(required * 100).toFixed(2)}%/h`;
  } else {
    e = reading.positionError ?? 0;
    band = c.deadband;
    basis = `no measured rate yet: position ${(e * 100).toFixed(1)}%`;
  }
  if (Math.abs(e) <= band) {
    return { pointer, lastMoveAtMs: keepStamp, guardActive: false, rateBasis, action: 'hold', reason: `${basis}: inside deadband` };
  }
  if (!basisSwitched && nowMs - (state.lastMoveAtMs ?? 0) < c.cooldownMs) {
    return { pointer, lastMoveAtMs: keepStamp, guardActive: false, rateBasis, action: 'hold-cooldown', reason: `${basis}: rung move inside cooldown` };
  }
  if (e < 0 && pointer < top) {
    return { pointer: pointer + 1, lastMoveAtMs: nowMs, guardActive: false, rateBasis, action: 'climb', reason: `${basis}: burning too slowly, climb one rung` };
  }
  if (e > 0 && pointer > floor) {
    return { pointer: pointer - 1, lastMoveAtMs: nowMs, guardActive: false, rateBasis, action: 'descend', reason: `${basis}: burning too fast, descend one rung` };
  }
  return { pointer, lastMoveAtMs: keepStamp, guardActive: false, rateBasis, action: 'hold-limit', reason: `${basis}: at floor/ceiling bound` };
}

/** Serve runs from accounts ordered earliest reset first, largest remainder first. */
export function orderAccounts(accounts) {
  return [...accounts].sort((a, b) => {
    const t = (a.resetAtMs ?? Number.MAX_SAFE_INTEGER) - (b.resetAtMs ?? Number.MAX_SAFE_INTEGER);
    if (t !== 0) return t;
    return (b.remainingPct ?? 0) - (a.remainingPct ?? 0);
  });
}
