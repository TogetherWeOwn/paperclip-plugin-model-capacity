import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleError, stepController, orderAccounts } from '../src/pacing.mjs';

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

test('accounts order earliest reset first, largest remainder first', () => {
  const ordered = orderAccounts([
    { accountId: 'b', resetAtMs: 2000, remainingPct: 0.1 },
    { accountId: 'a', resetAtMs: 1000, remainingPct: 0.1 },
    { accountId: 'c', resetAtMs: 1000, remainingPct: 0.5 },
  ]);
  assert.deepEqual(ordered.map(a => a.accountId), ['c', 'a', 'b']);
});
