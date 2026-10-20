/**
 * Whole-percent meters (0.2.53): a 60-minute window over an account burning
 * ~0.4%/h usually sees no meter tick and used to read 0.00%/h. The tick log
 * extends the window back to the last observed tick (up to 6h), bounded by
 * one quantum over the time since that tick, and a flat meter never reads
 * exactly 0 while runs are in flight.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendTickLog, robustRatePerHour, measuredRatePerHour, appendUtilReading,
  METER_QUANTUM, TICK_LOG_KEEP_MS, TICK_LOG_CAP,
} from '../src/pacing.mjs';

const T0 = Date.parse('2026-10-20T00:00:00Z');
const MIN = 60000;
const HOUR = 60 * MIN;

// Simulate a true burn of `ratePerHour` read every `stepMin` minutes by a
// meter that reports floor(used / quantum) * quantum.
function simulate({ startUsed = 0.4, ratePerHour = 0.004, hours = 6, stepMin = 1 }) {
  let history = [];
  let log = [];
  let now = T0;
  for (let m = 0; m <= hours * 60; m += stepMin) {
    now = T0 + m * MIN;
    const used = Math.floor((startUsed + ratePerHour * (m / 60)) / METER_QUANTUM + 1e-9) * METER_QUANTUM;
    const lastSeen = history.length > 0 ? history[history.length - 1].atMs : null;
    history = appendUtilReading(history, { atMs: now, usedPct: used }, now);
    log = appendTickLog(log, { atMs: now, usedPct: used }, now, lastSeen);
  }
  return { history, log, now };
}

test('tick log: seeds once, records only changes with the last reading at the old value', () => {
  let log = appendTickLog([], { atMs: T0, usedPct: 0.4 }, T0);
  assert.deepEqual(log, [{ atMs: T0, usedPct: 0.4, seed: true }]);
  log = appendTickLog(log, { atMs: T0 + MIN, usedPct: 0.4 }, T0 + MIN, T0);
  assert.equal(log.length, 1);
  log = appendTickLog(log, { atMs: T0 + 2 * MIN, usedPct: 0.41 }, T0 + 2 * MIN, T0 + MIN);
  assert.deepEqual(log[1], { atMs: T0 + 2 * MIN, usedPct: 0.41, fromAtMs: T0 + MIN });
  // A counter reset (value went down) is a new seed, never a negative tick.
  log = appendTickLog(log, { atMs: T0 + 3 * MIN, usedPct: 0.02 }, T0 + 3 * MIN, T0 + 2 * MIN);
  assert.equal(log[2].seed, true);
});

test('tick log: keeps 6h plus the newest older entry, capped', () => {
  let log = [];
  for (let i = 0; i < 10; i++) log = appendTickLog(log, { atMs: T0 + i * HOUR, usedPct: 0.01 * i }, T0 + i * HOUR);
  const now = T0 + 9 * HOUR;
  assert.ok(log.every((e, i) => i === 0 || e.atMs >= now - TICK_LOG_KEEP_MS));
  assert.ok(log[0].atMs < now - TICK_LOG_KEEP_MS || log[0].atMs === now - TICK_LOG_KEEP_MS);
  let big = [];
  for (let i = 0; i < 200; i++) big = appendTickLog(big, { atMs: T0 + i * MIN, usedPct: 0.001 * i }, T0 + i * MIN);
  assert.equal(big.length, TICK_LOG_CAP);
  // A flat meter for longer than the keep window keeps its last entry.
  const flat = appendTickLog([{ atMs: T0, usedPct: 0.5, seed: true }], { atMs: T0 + 8 * HOUR, usedPct: 0.5 }, T0 + 8 * HOUR);
  assert.deepEqual(flat, [{ atMs: T0, usedPct: 0.5, seed: true }]);
});

test('0.4%/h on a whole-percent meter: the 60-min window reads 0, the robust rate reads the real burn', () => {
  // 0.4%/h ticks every 2.5h. Stop 100 min after a tick: the window is flat.
  const { history, log, now } = simulate({ startUsed: 0.4, ratePerHour: 0.004, hours: 5 + 100 / 60 });
  const plain = measuredRatePerHour(history, now, 60, 10);
  assert.equal(plain.ratePerHour, 0, 'the old window reads the account as idle');
  const robust = robustRatePerHour(history, now, 60, 10, { tickLog: log });
  assert.equal(robust.basis, 'tick-extended');
  assert.ok(robust.ratePerHour > 0);
  // Extended back to the last tick (100 min ago), bounded by one quantum
  // over that time: 0.6%/h, the same order as the true 0.4%/h.
  assert.ok(robust.ratePerHour <= METER_QUANTUM / (100 / 60) + 1e-12);
  assert.ok(robust.ratePerHour > 0.004 && robust.ratePerHour < 0.007, `rate ${robust.ratePerHour}`);
  // The estimate decays as the meter stays flat: 4h after the tick it reads
  // one quantum over the 241 min since the last reading at the old value.
  const later = robustRatePerHour(history, now + 140 * MIN, 60, 10, { tickLog: log });
  // (history window is stale by then: rebuild a flat window at the later time)
  const flatHist = [{ atMs: now + 80 * MIN, usedPct: history.at(-1).usedPct }, { atMs: now + 140 * MIN, usedPct: history.at(-1).usedPct }];
  const decayed = robustRatePerHour(flatHist, now + 140 * MIN, 60, 10, { tickLog: log });
  assert.equal(later, null, 'no in-window data stays unknown, never invented');
  assert.ok(Math.abs(decayed.ratePerHour - METER_QUANTUM / (241 / 60)) < 1e-6, `rate ${decayed.ratePerHour}`);
  assert.ok(decayed.ratePerHour <= METER_QUANTUM / 4 + 1e-12, 'bounded by one quantum over 4h');
});

test('a positive window rate is returned unchanged; thin data stays null', () => {
  const h = [{ atMs: T0, usedPct: 0.1 }, { atMs: T0 + 30 * MIN, usedPct: 0.12 }];
  const r = robustRatePerHour(h, T0 + 30 * MIN, 60, 10, { tickLog: [] , inFlight: 3 });
  assert.equal(r.basis, 'window');
  assert.ok(Math.abs(r.ratePerHour - 0.04) < 1e-12);
  assert.equal(robustRatePerHour(h.slice(0, 1), T0, 60, 10, { inFlight: 3 }), null);
});

test('never exactly 0 while runs are in flight; an idle flat account may read 0', () => {
  const h = [{ atMs: T0, usedPct: 0.3 }, { atMs: T0 + 50 * MIN, usedPct: 0.3 }];
  const log = [{ atMs: T0 - 8 * HOUR, usedPct: 0.3, seed: true }];
  const idle = robustRatePerHour(h, T0 + 50 * MIN, 60, 10, { tickLog: log, inFlight: 0 });
  assert.equal(idle.ratePerHour, 0);
  const busy = robustRatePerHour(h, T0 + 50 * MIN, 60, 10, { tickLog: log, inFlight: 2 });
  assert.equal(busy.basis, 'tick-bound');
  assert.ok(busy.ratePerHour > 0);
  // Flat for 8h50m: under one quantum in that time.
  assert.ok(busy.ratePerHour <= METER_QUANTUM / 6);
  // No tick log at all (fresh install) with runs in flight: still positive.
  const fresh = robustRatePerHour(h, T0 + 50 * MIN, 60, 10, { inFlight: 1 });
  assert.ok(fresh.ratePerHour > 0);
  // A tick older than 6h is no evidence: in flight reads the bound, idle 0.
  const oldTick = [{ atMs: T0 - 9 * HOUR, usedPct: 0.29, seed: true }, { atMs: T0 - 7 * HOUR, usedPct: 0.3, fromAtMs: T0 - 7 * HOUR - MIN }];
  assert.equal(robustRatePerHour(h, T0 + 50 * MIN, 60, 10, { tickLog: oldTick }).ratePerHour, 0);
  assert.equal(robustRatePerHour(h, T0 + 50 * MIN, 60, 10, { tickLog: oldTick, inFlight: 1 }).basis, 'tick-bound');
});
