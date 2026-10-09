/**
 * Smoothing: the target and the per-agent caps swung with
 * the instantaneous queue and with one-tick burn measurements (target
 * 28 -> 25 -> 20 -> 27.8 -> 11.8 inside an hour; one agent want 16 -> 13 -> 9 ->
 * 6 -> 10). Pure helpers; the plugin owns the state.
 *
 *  - smoothValue: EWMA with a time half-life, for the measured burn E and
 *    the fleet target.
 *  - holdCaps: asymmetric hysteresis for per-agent wants. A cap below an
 *    agent's real demand throttles work that exists, so increases pass at
 *    once; decreases decay on the half-life. A cap above demand is
 *    harmless headroom, which is why lagging downward is safe.
 */

export const SMOOTHING_DEFAULTS = Object.freeze({
  /** Half-life of the burn/target EWMA and of the per-agent cap decay. */
  halfLifeMin: 30,
  /**
   * The served target falls faster than it rises: serving a target above the
   * sustainable rate over-admits (and burns quota ahead of plan), while a
   * target that lags upward only under-uses it for a while.
   */
  targetDownHalfLifeMin: 10,
  /** A smoothed value older than this (no fresh sample) is dropped. */
  staleHours: 6,
});

const decay = (dtMs, halfLifeMs) => {
  if (!(halfLifeMs > 0)) return 0;
  return 2 ** (-Math.max(0, dtMs) / halfLifeMs);
};

/** EWMA step: prev weighs 2^(-dt/halfLife); null sides fall through. */
export function ewma(prev, sample, dtMs, halfLifeMs) {
  if (!Number.isFinite(sample)) return Number.isFinite(prev) ? prev : null;
  if (!Number.isFinite(prev)) return sample;
  const w = decay(dtMs, halfLifeMs);
  return prev * w + sample * (1 - w);
}

/**
 * One smoothed series step. prevEntry: { value, atMs } | null.
 * Returns the next entry { value, atMs } (or null when there is nothing to
 * report). A null sample keeps the previous value without refreshing atMs,
 * so a series with no new measurement ages out after staleMs instead of
 * being served forever.
 */
export function smoothValue(prevEntry, sample, nowMs, { halfLifeMs, downHalfLifeMs = null, staleMs } = {}) {
  const fresh = prevEntry != null && Number.isFinite(prevEntry.value)
    && Number.isFinite(prevEntry.atMs) && nowMs - prevEntry.atMs <= staleMs;
  if (Number.isFinite(sample)) {
    // downHalfLifeMs (optional) gives a falling series its own, shorter
    // half-life: the previous value weighs less when the sample is below it.
    const hl = fresh && downHalfLifeMs != null && sample < prevEntry.value ? downHalfLifeMs : halfLifeMs;
    const value = fresh ? ewma(prevEntry.value, sample, nowMs - prevEntry.atMs, hl) : sample;
    return { value, atMs: nowMs };
  }
  return fresh ? { value: prevEntry.value, atMs: prevEntry.atMs } : null;
}

/**
 * Hysteresis over demand-following caps.
 *
 * entries: allocateDemandCaps() output ([{ agentId, running, allocated,
 *   reason, ... }]); prevHold: { [agentId]: { value, atMs } } (or Map);
 * ceiling: fleet bound on the sum.
 *
 * Only the demand-following regimes (reason full-demand | headroom) hold;
 * the shed regimes are bounded by the target and must not exceed it, so they
 * pass through. Increases pass immediately. A decrease decays from the
 * previously served cap toward the new want on the half-life, never below
 * the new want and never below `running` (a cap under running is fiction).
 * If holding pushes the fleet sum past the ceiling, the largest holds give
 * back first.
 *
 * Returns { entries, hold } where hold is the next state object.
 */
export function holdCaps(entries, prevHold, nowMs, { halfLifeMs, staleMs, ceiling = 75 } = {}) {
  const prev = prevHold instanceof Map ? prevHold : new Map(Object.entries(prevHold ?? {}));
  const out = (entries ?? []).map(e => ({ ...e }));
  // soft[i] is the unrounded decaying cap carried in state: rounding the
  // carried value each tick would stall the decay (a 5-min step moves
  // 8 -> 7.56, which rounds straight back to 8).
  const soft = out.map(e => {
    if (e.reason !== 'full-demand' && e.reason !== 'headroom') return e.allocated;
    const p = prev.get(e.agentId);
    if (!p || !Number.isFinite(p.value) || !Number.isFinite(p.atMs) || nowMs - p.atMs > staleMs) return e.allocated;
    if (e.allocated >= p.value) return e.allocated;
    return e.allocated + (p.value - e.allocated) * decay(nowMs - p.atMs, halfLifeMs);
  });
  const held = out.map((e, i) => Math.max(e.allocated, e.running, Math.round(soft[i])));
  // Fleet bound: give back the largest holds first, one slot at a time.
  const sum = () => held.reduce((s, v) => s + v, 0);
  let guard = held.length * 200;
  while (sum() > ceiling && guard-- > 0) {
    let best = -1;
    let bestExcess = 0;
    for (let i = 0; i < held.length; i++) {
      const floor = Math.max(out[i].allocated, out[i].running);
      const excess = held[i] - floor;
      if (excess > bestExcess) { best = i; bestExcess = excess; }
    }
    if (best < 0) break;
    held[best] -= 1;
  }
  const hold = new Map();
  out.forEach((e, i) => {
    if (held[i] !== e.allocated) {
      e.baseAllocated = e.allocated;
      e.allocated = held[i];
      e.maxConcurrentRuns = held[i];
      e.reason = 'held';
    }
    hold.set(e.agentId, { value: Math.min(soft[i], held[i] + 0.5), atMs: nowMs });
  });
  return { entries: out, hold: Object.fromEntries(hold) };
}
