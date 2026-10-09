import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scheduleError, stepController, orderAccounts,
  appendUtilReading, measuredRatePerHour, requiredRatePerHour, stepRateController,
  DEFAULT_PACING,
} from '../src/pacing.mjs';

const T0 = Date.parse('2026-10-08T00:00:00Z');
const WEEK = 7 * 24 * 3600 * 1000;

test('schedule error is used minus linear target', () => {
  // Halfway through the week at 60% used => 10pts ahead.
  assert.ok(Math.abs(scheduleError({ usedPct: 0.6, nowMs: T0 + WEEK / 2, periodStartMs: T0, periodEndMs: T0 + WEEK }) - 0.1) < 1e-9);
  assert.ok(Math.abs(scheduleError({ usedPct: 0.2, nowMs: T0 + WEEK / 2, periodStartMs: T0, periodEndMs: T0 + WEEK }) + 0.3) < 1e-9);
});

test('deadband holds; behind climbs and ahead descends one rung', () => {
  const cfg = { deadband: 0.02, cooldownMs: 600000, guardHigh: 0.8, guardRejoin: 0.5, floorRung: 0 };
  const hold = stepController({ pointer: 1, lastMoveAtMs: 0, guardActive: false }, { error: 0.01, fiveHourUsedPct: 0.1 }, 10 * 600000, cfg, 4);
  assert.equal(hold.action, 'hold');
  const climb = stepController({ pointer: 1, lastMoveAtMs: 0, guardActive: false }, { error: -0.1, fiveHourUsedPct: 0.1 }, 10 * 600000, cfg, 4);
  assert.deepEqual([climb.action, climb.pointer], ['climb', 2]);
  const descend = stepController({ pointer: 2, lastMoveAtMs: 0, guardActive: false }, { error: 0.1, fiveHourUsedPct: 0.1 }, 10 * 600000, cfg, 4);
  assert.deepEqual([descend.action, descend.pointer], ['descend', 1]);
});

test('cooldown allows at most one rung per window; bounds hold', () => {
  const cfg = { deadband: 0.02, cooldownMs: 600000, guardHigh: 0.8, guardRejoin: 0.5, floorRung: 0 };
  const first = stepController({ pointer: 1, lastMoveAtMs: 1000000, guardActive: false }, { error: -0.2, fiveHourUsedPct: 0.1 }, 1000000 + 60000, cfg, 4);
  assert.equal(first.action, 'hold-cooldown');
  const atFloor = stepController({ pointer: 0, lastMoveAtMs: 0, guardActive: false }, { error: 0.2, fiveHourUsedPct: 0.1 }, 10 * 600000, cfg, 4);
  assert.equal(atFloor.action, 'hold-limit');
  const atCeil = stepController({ pointer: 4, lastMoveAtMs: 0, guardActive: false }, { error: -0.2, fiveHourUsedPct: 0.1 }, 10 * 600000, cfg, 4);
  assert.equal(atCeil.action, 'hold-limit');
});

test('5h guard floors and sheds; rejoin below the rejoin line', () => {
  const cfg = { deadband: 0.02, cooldownMs: 600000, guardHigh: 0.8, guardRejoin: 0.5, floorRung: 0 };
  const trip = stepController({ pointer: 3, lastMoveAtMs: 0, guardActive: false }, { error: -0.3, fiveHourUsedPct: 0.85 }, 5000, cfg, 4);
  assert.deepEqual([trip.action, trip.pointer, trip.guardActive], ['floor-guard', 0, true]);
  const held = stepController(trip, { error: -0.3, fiveHourUsedPct: 0.7 }, 6000, cfg, 4);
  assert.equal(held.action, 'hold-guard');
  const rejoined = stepController(held, { error: -0.3, fiveHourUsedPct: 0.4 }, 7000, cfg, 4);
  assert.deepEqual([rejoined.action, rejoined.guardActive], ['rejoin', false]);
});

test('history appends, sorts, prunes, and caps', () => {
  const now = T0 + 3600000;
  let h = appendUtilReading([], { atMs: now - 600000, usedPct: 0.3 }, now);
  h = appendUtilReading(h, { atMs: now - 1200000, usedPct: 0.29 }, now);
  assert.deepEqual(h.map(p => p.usedPct), [0.29, 0.3]);
  const stale = appendUtilReading(h, { atMs: now - 100 * 60000, usedPct: 0.1 }, now);
  assert.ok(stale.every(p => p.atMs > now - 100 * 60000));
  assert.equal(appendUtilReading(h, { atMs: now, usedPct: NaN }, now).length, h.length);
});

test('measured rate needs two points spanning the minimum span', () => {
  const now = T0 + 3600000;
  // 0.30 -> 0.356 over 60min = 5.6%/h across 7 points.
  let h = [];
  for (let i = 6; i >= 0; i--) h = appendUtilReading(h, { atMs: now - i * 600000, usedPct: 0.356 - i * (0.056 / 6) }, now);
  const m = measuredRatePerHour(h, now, 60, 20);
  assert.ok(Math.abs(m.ratePerHour - 0.056) < 1e-9);
  assert.equal(m.points, 7);
  assert.equal(measuredRatePerHour(h.slice(-1), now, 60, 20), null);
  assert.equal(measuredRatePerHour(h.slice(-2), now, 60, 20), null);
  // Counter reset (provider restarted the week) is rejected, not trusted.
  const reset = appendUtilReading(h, { atMs: now + 60000, usedPct: 0.01 }, now + 60000);
  assert.equal(measuredRatePerHour(reset, now + 60000, 60, 20), null);
});

test('required rate is remaining over hours to reset', () => {
  assert.ok(Math.abs(requiredRatePerHour({ remainingPct: 0.34, hoursToReset: 20 }) - 0.017) < 1e-9);
  assert.equal(requiredRatePerHour({ remainingPct: 0, hoursToReset: 20 }), 0);
  assert.equal(requiredRatePerHour({ remainingPct: 0.5, hoursToReset: 0 }), 0);
});

test('live case: position says climb but the rate says descend', () => {
  // claude-lane-1: 66% used with 88% elapsed => position error is
  // negative ("behind", climb). But it burns 5.6%/h against required
  // 1.7%/h, so climbing would blow the 5h window.
  const cfg = { deadband: 0.02, cooldownMs: 600000, guardHigh: 0.8, guardRejoin: 0.5, floorRung: 0, rateDeadbandRel: 0.15 };
  const reading = {
    measuredRatePerHour: 0.056, requiredRatePerHour: 0.017,
    positionError: -0.22, fiveHourUsedPct: 0.3,
  };
  const step = stepRateController({ pointer: 2, lastMoveAtMs: 0, guardActive: false }, reading, 10 * 600000, cfg, 5);
  assert.deepEqual([step.action, step.pointer], ['descend', 1]);
  assert.match(step.reason, /5\.60%\/h vs required 1\.70%\/h/);
});

test('rate deadband holds within +-15%; position breaks ties when unmeasured', () => {
  const cfg = { deadband: 0.02, cooldownMs: 600000, guardHigh: 0.8, guardRejoin: 0.5, floorRung: 0, rateDeadbandRel: 0.15 };
  const hold = stepRateController({ pointer: 2, lastMoveAtMs: 0, guardActive: false },
    { measuredRatePerHour: 0.018, requiredRatePerHour: 0.017, positionError: -0.2, fiveHourUsedPct: 0.1 }, 10 * 600000, cfg, 5);
  assert.equal(hold.action, 'hold');
  const tiebreak = stepRateController({ pointer: 2, lastMoveAtMs: 0, guardActive: false },
    { measuredRatePerHour: null, requiredRatePerHour: 0.017, positionError: -0.2, fiveHourUsedPct: 0.1 }, 10 * 600000, cfg, 5);
  assert.deepEqual([tiebreak.action, tiebreak.pointer], ['climb', 3]);
  assert.match(tiebreak.reason, /no measured rate yet/);
});

test('rate guard still floors on the 5h window', () => {
  const cfg = { deadband: 0.02, cooldownMs: 600000, guardHigh: 0.8, guardRejoin: 0.5, floorRung: 0, rateDeadbandRel: 0.15 };
  const step = stepRateController({ pointer: 4, lastMoveAtMs: 0, guardActive: false },
    { measuredRatePerHour: 0.001, requiredRatePerHour: 0.05, positionError: 0, fiveHourUsedPct: 0.9 }, 5000, cfg, 5);
  assert.deepEqual([step.action, step.pointer, step.guardActive], ['floor-guard', 0, true]);
});

test('position -> measured switch resets the cooldown so the pointer descends', () => {
  // Live lane-1: the position fallback climbed the pointer to rung 2, then
  // the measured rate arrived showing over-burn (2.5%/h vs required 1.7%/h).
  // A fallback move 1 min ago would normally block the correction for 9
  // more minutes; the switch bypasses it exactly once.
  const cfg = { ...DEFAULT_PACING };
  const now = 10 * 600000;
  const reading = {
    measuredRatePerHour: 0.025, requiredRatePerHour: 0.017,
    positionError: -0.2, fiveHourUsedPct: 0.1,
  };
  const switched = stepRateController(
    { pointer: 2, lastMoveAtMs: now - 60000, guardActive: false, rateBasis: 'position' },
    reading, now, cfg, 5);
  assert.deepEqual([switched.action, switched.pointer, switched.rateBasis], ['descend', 1, 'measured']);
  // Same inputs with no switch (already measured last tick): cooldown holds.
  const cooled = stepRateController(
    { pointer: 2, lastMoveAtMs: now - 60000, guardActive: false, rateBasis: 'measured' },
    reading, now, cfg, 5);
  assert.equal(cooled.action, 'hold-cooldown');
  assert.equal(cooled.rateBasis, 'measured');
  // And after the cooldown expires the descend happens without any switch.
  const later = stepRateController(
    { pointer: 2, lastMoveAtMs: now - 600000, guardActive: false, rateBasis: 'measured' },
    reading, now, cfg, 5);
  assert.deepEqual([later.action, later.pointer], ['descend', 1]);
});

test('accounts order earliest reset first, largest remainder first', () => {
  const ordered = orderAccounts([
    { accountId: 'b', resetAtMs: 2000, remainingPct: 0.1 },
    { accountId: 'a', resetAtMs: 1000, remainingPct: 0.1 },
    { accountId: 'c', resetAtMs: 1000, remainingPct: 0.5 },
  ]);
  assert.deepEqual(ordered.map(a => a.accountId), ['c', 'a', 'b']);
});

test('total stall reads as behind plan, never inside deadband', () => {
  // Live codex-lane-1: measured 0 vs required 0.49%/h read "inside deadband"
  // because the 0.5%/h absolute floor swallowed the whole required rate. A
  // stalled account (zero burn because it got no runs) is maximum deficit.
  const cfg = { ...DEFAULT_PACING };
  const now = 10 * 600000;
  const stalled = { measuredRatePerHour: 0, requiredRatePerHour: 0.0049, positionError: -0.05, fiveHourUsedPct: 0.1 };
  const step = stepRateController({ pointer: 1, lastMoveAtMs: 0, guardActive: false }, stalled, now, cfg, 5);
  assert.deepEqual([step.action, step.pointer], ['climb', 2]);
  assert.match(step.reason, /0\.00%\/h vs required 0\.49%\/h/);
  // At the ceiling the same stall reads behind-plan-but-bounded, not hold.
  const capped = stepRateController({ pointer: 5, lastMoveAtMs: 0, guardActive: false }, stalled, now, cfg, 5);
  assert.equal(capped.action, 'hold-limit');
  // Relative-only, no floor: measured 0.40 vs required 0.49 is an 18%
  // shortfall, outside +-15%, so it climbs too.
  const nicked = stepRateController({ pointer: 1, lastMoveAtMs: 0, guardActive: false },
    { measuredRatePerHour: 0.0040, requiredRatePerHour: 0.0049, positionError: -0.05, fiveHourUsedPct: 0.1 }, now, cfg, 5);
  assert.deepEqual([nicked.action, nicked.pointer], ['climb', 2]);
  // Exhausted window (nothing required) still holds: no deficit, no move.
  const done = stepRateController({ pointer: 1, lastMoveAtMs: 0, guardActive: false },
    { measuredRatePerHour: 0, requiredRatePerHour: 0, positionError: 0, fiveHourUsedPct: 0.1 }, now, cfg, 5);
  assert.equal(done.action, 'hold');
});
