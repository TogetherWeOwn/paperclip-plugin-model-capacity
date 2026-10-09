import test from 'node:test';
import assert from 'node:assert/strict';
import { ewma, smoothValue, holdCaps, SMOOTHING_DEFAULTS } from '../src/smoothing.mjs';

// Live 12:05-12:56Z: target 28 -> 25 -> 20 -> 27.8 -> 11.8;
// one agent want 16 -> 13 -> 9 -> 6 -> 10 -> 9 -> 7 -> 8 -> 12.

const MIN = 60 * 1000;
const HALF = SMOOTHING_DEFAULTS.halfLifeMin * MIN;
const STALE = SMOOTHING_DEFAULTS.staleHours * 60 * MIN;
const opts = { halfLifeMs: HALF, staleMs: STALE };

test('EWMA weighs the previous value by 2^(-dt/halfLife)', () => {
  assert.equal(ewma(10, 20, 0, HALF), 10, 'no time passed: previous holds');
  assert.ok(Math.abs(ewma(10, 20, HALF, HALF) - 15) < 1e-9, 'one half-life: halfway');
  assert.ok(Math.abs(ewma(10, 20, 20 * HALF, HALF) - 20) < 1e-5, 'long gap: the new sample');
  assert.equal(ewma(null, 7, MIN, HALF), 7);
  assert.equal(ewma(7, null, MIN, HALF), 7);
  assert.equal(ewma(null, null, MIN, HALF), null);
  assert.equal(ewma(10, 20, -5 * MIN, HALF), 10, 'a clock step back never over-weights the sample');
});

test('smoothValue seeds, blends, keeps through a missing sample, then ages out', () => {
  const t0 = 1_750_000_000_000;
  let e = smoothValue(null, 0.004, t0, opts);
  assert.deepEqual(e, { value: 0.004, atMs: t0 });
  e = smoothValue(e, 0.008, t0 + HALF, opts);
  assert.ok(Math.abs(e.value - 0.006) < 1e-12);
  const kept = smoothValue(e, null, t0 + HALF + 10 * MIN, opts);
  assert.equal(kept.value, e.value);
  assert.equal(kept.atMs, e.atMs, 'a missing sample does not refresh the age');
  assert.equal(smoothValue(e, null, e.atMs + STALE + MIN, opts), null);
  // A stale entry restarts from the fresh sample instead of blending with it.
  assert.equal(smoothValue(e, 0.02, e.atMs + STALE + MIN, opts).value, 0.02);
  assert.equal(smoothValue(null, null, t0, opts), null);
});

test('a falling series can use a shorter half-life than a rising one', () => {
  const t0 = 1_750_000_000_000;
  const down = { halfLifeMs: HALF, downHalfLifeMs: HALF / 3, staleMs: STALE };
  const prev = { value: 28, atMs: t0 };
  // Falling to 6 over one 10-min step: previous weighs 2^(-10/10) = 0.5.
  const fall = smoothValue(prev, 6, t0 + 10 * MIN, down).value;
  assert.ok(Math.abs(fall - 17) < 1e-9, `fall ${fall}`);
  // The same step on the symmetric half-life lags much more.
  assert.ok(smoothValue(prev, 6, t0 + 10 * MIN, opts).value > fall + 3);
  // Rising keeps the long half-life.
  const rise = smoothValue({ value: 6, atMs: t0 }, 28, t0 + 10 * MIN, down).value;
  assert.ok(Math.abs(rise - ewma(6, 28, 10 * MIN, HALF)) < 1e-9);
});

test('the live target series swings far less once smoothed', () => {
  const raw = [28, 25, 20, 27.8, 11.8];
  let entry = null;
  const smoothed = raw.map((v, i) => {
    entry = smoothValue(entry, v, 1_750_000_000_000 + i * 10 * MIN, opts);
    return entry.value;
  });
  const maxStep = (xs) => Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i])));
  assert.ok(maxStep(smoothed) < maxStep(raw) * 0.6, `smoothed ${maxStep(smoothed)} vs raw ${maxStep(raw)}`);
  assert.ok(smoothed[4] > 11.8 + 3, 'one low sample does not collapse the target');
});

const entry = (agentId, allocated, extra = {}) => ({
  agentId, running: 0, queued: allocated, demand: allocated, allocated, maxConcurrentRuns: allocated,
  reason: 'full-demand', ...extra,
});

test('hysteresis: wants of one agent flap 16/13/9/6/10/9/7/8/12, served caps never undercut demand and fall slowly', () => {
  const wants = [16, 13, 9, 6, 10, 9, 7, 8, 12];
  let hold = {};
  const served = [];
  wants.forEach((w, i) => {
    const r = holdCaps([entry('agent-a', w)], hold, 1_750_000_000_000 + i * 5 * MIN, { ...opts, ceiling: 75 });
    hold = r.hold;
    served.push(r.entries[0].allocated);
  });
  // Never below the want (a cap under demand throttles real work).
  served.forEach((s, i) => assert.ok(s >= wants[i], `tick ${i}: served ${s} < want ${wants[i]}`));
  assert.equal(served[0], 16);
  // The 16 -> 13 -> 9 drop is spread instead of immediate.
  assert.ok(served[1] >= 13 && served[1] <= 16, `tick 1 lags the drop: ${served[1]}`);
  assert.ok(served[2] > 9, `tick 2 has not fallen to the want yet: ${served[2]}`);
  // Total variation shrinks.
  const tv = (xs) => xs.slice(1).reduce((s, x, i) => s + Math.abs(x - xs[i]), 0);
  assert.ok(tv(served) < tv(wants), `served TV ${tv(served)} vs raw TV ${tv(wants)}`);
});

test('increases pass at once, even straight after a decay', () => {
  let r = holdCaps([entry('a', 16)], {}, 0, { ...opts });
  r = holdCaps([entry('a', 6)], r.hold, 5 * MIN, { ...opts });
  assert.ok(r.entries[0].allocated > 6, 'decaying');
  r = holdCaps([entry('a', 20)], r.hold, 10 * MIN, { ...opts });
  assert.equal(r.entries[0].allocated, 20);
  assert.equal(r.entries[0].reason, 'full-demand');
});

test('a decay settles on the want (no permanent offset)', () => {
  let hold = {};
  let r = holdCaps([entry('a', 10)], hold, 0, { ...opts });
  hold = r.hold;
  for (let i = 1; i <= 40; i++) {
    r = holdCaps([entry('a', 4)], hold, i * 5 * MIN, { ...opts });
    hold = r.hold;
  }
  assert.equal(r.entries[0].allocated, 4);
});

test('hold reports reason held with the base allocation', () => {
  let r = holdCaps([entry('a', 12)], {}, 0, { ...opts });
  r = holdCaps([entry('a', 8)], r.hold, 5 * MIN, { ...opts });
  const e = r.entries[0];
  assert.equal(e.reason, 'held');
  assert.equal(e.baseAllocated, 8);
  assert.ok(e.allocated > 8 && e.allocated <= 12);
  assert.equal(e.maxConcurrentRuns, e.allocated);
});

test('shed regimes pass through: held caps never push the fleet over its split', () => {
  let r = holdCaps([entry('a', 12)], {}, 0, { ...opts });
  const shed = holdCaps([{ ...entry('a', 6), reason: 'proportional' }], r.hold, 5 * MIN, { ...opts });
  assert.equal(shed.entries[0].allocated, 6);
  assert.equal(shed.entries[0].reason, 'proportional');
});

test('running is a floor and the fleet ceiling is honored', () => {
  let r = holdCaps([entry('a', 12), entry('b', 12)], {}, 0, { ...opts, ceiling: 30 });
  assert.deepEqual(r.entries.map(e => e.allocated), [12, 12]);
  // Both wants fall to 2; holds would sum to ~22+, ceiling 20 forces give-back.
  r = holdCaps([entry('a', 2, { running: 2 }), entry('b', 2)], r.hold, 1 * MIN, { ...opts, ceiling: 20 });
  assert.ok(r.entries.reduce((s, e) => s + e.allocated, 0) <= 20);
  assert.ok(r.entries[0].allocated >= 2);
});

test('stale hold state is ignored; unknown agents are served as computed', () => {
  const r = holdCaps([entry('a', 3)], { a: { value: 20, atMs: 0 } }, STALE + MIN, { ...opts });
  assert.equal(r.entries[0].allocated, 3);
  const fresh = holdCaps([entry('new', 5)], { a: { value: 20, atMs: 0 } }, 1 * MIN, { ...opts });
  assert.equal(fresh.entries[0].allocated, 5);
});

test('agent ids that look like prototype keys are safe', () => {
  const r = holdCaps([entry('__proto__', 9)], {}, 0, { ...opts });
  assert.equal(r.entries[0].allocated, 9);
  assert.equal(Object.getPrototypeOf(r.hold), Object.prototype);
  assert.equal(Object.keys(r.hold).includes('__proto__'), true);
  const again = holdCaps([entry('__proto__', 4)], JSON.parse(JSON.stringify(r.hold)), 5 * MIN, { ...opts });
  assert.equal(again.entries[0].reason, 'held');
});
