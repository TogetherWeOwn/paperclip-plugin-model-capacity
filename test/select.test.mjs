import test from 'node:test';
import assert from 'node:assert/strict';
import { deficitOf, isOverBurning, orderAccountsForRun } from '../src/select.mjs';

const view = (accountId, partial = {}) => ({
  accountId, resetAtMs: null, headroomPct: 0.9,
  measuredRatePerHour: null, requiredRatePerHour: null, ...partial,
});

test('deficit is normalized shortfall; unknown rates score zero', () => {
  assert.ok(Math.abs(deficitOf(view('a', { measuredRatePerHour: 0.008, requiredRatePerHour: 0.017 })) - (0.009 / 0.017)) < 1e-9);
  assert.equal(deficitOf(view('b', { measuredRatePerHour: null, requiredRatePerHour: 0.017 })), 0);
  assert.equal(deficitOf(view('c', { measuredRatePerHour: 0.02, requiredRatePerHour: null })), 0);
});

test('live fleet: over-burning lane-1 sorts last, earliest reset breaks the tie', () => {
  // Live right now: lane-1 measured 2.2%/h vs required 1.7%/h (ahead);
  // lane-2 required 1.34%/h; codex-lane-1 required 0.48%/h (both unmeasured).
  const order = orderAccountsForRun([
    view('claude:claude-lane-1', { resetAtMs: 3000, headroomPct: 0.9, measuredRatePerHour: 0.022, requiredRatePerHour: 0.017 }),
    view('claude:claude-lane-2', { resetAtMs: 2000, headroomPct: 0.8, measuredRatePerHour: null, requiredRatePerHour: 0.0134 }),
    view('codex:codex-lane-1', { resetAtMs: 1000, headroomPct: 0.85, measuredRatePerHour: null, requiredRatePerHour: 0.0048 }),
  ]).map(v => v.accountId);
  // lane-1 burns 0.022 > 0.017 x 1.15 = 0.01955: excluded from the margin.
  // lane-2 and codex tie at deficit 0; earliest reset (codex) wins.
  assert.deepEqual(order, ['codex:codex-lane-1', 'claude:claude-lane-2', 'claude:claude-lane-1']);
});

test('earliest reset is only a tie-break: a hungrier account wins despite a later reset', () => {
  const order = orderAccountsForRun([
    view('a', { resetAtMs: 1000, headroomPct: 0.9, measuredRatePerHour: 0.016, requiredRatePerHour: 0.017 }),
    view('b', { resetAtMs: 9000, headroomPct: 0.9, measuredRatePerHour: 0.002, requiredRatePerHour: 0.017 }),
  ]).map(v => v.accountId);
  assert.deepEqual(order, ['b', 'a']);
});

test('unknown headroom never qualifies; thin headroom below reserve is out', () => {
  const order = orderAccountsForRun([
    view('known', { resetAtMs: 1000, headroomPct: 0.5, measuredRatePerHour: null, requiredRatePerHour: 0.01 }),
    view('null-5h', { resetAtMs: 500, headroomPct: null, measuredRatePerHour: null, requiredRatePerHour: 0.05 }),
    view('thin', { resetAtMs: 100, headroomPct: 0.04, measuredRatePerHour: null, requiredRatePerHour: 0.05 }),
  ]).map(v => v.accountId);
  assert.deepEqual(order, ['known']);
});

test('over-burning is the only pool when nothing else qualifies', () => {
  const order = orderAccountsForRun([
    view('hot', { resetAtMs: 1000, headroomPct: 0.9, measuredRatePerHour: 0.03, requiredRatePerHour: 0.017 }),
  ]).map(v => v.accountId);
  assert.deepEqual(order, ['hot']);
  assert.equal(isOverBurning(view('x', { measuredRatePerHour: 0.022, requiredRatePerHour: 0.017 })), true);
  assert.equal(isOverBurning(view('x', { measuredRatePerHour: null, requiredRatePerHour: 0.017 })), false);
});
