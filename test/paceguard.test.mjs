import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PACE_GUARD, normalizePaceGuard, paceGuardPools } from '../src/paceguard.mjs';
import { orderAccountsForRun, orderAccountsWithPacing } from '../src/select.mjs';

// A lane view as the order functions see it: pooled in-flight, the lane's
// target share (runs/hour) and its plan position (weekly used minus the
// linear plan; positive = ahead).
const lane = (accountId, partial = {}) => ({
  accountId, pool: 'claude', health: 'healthy', headroomPct: 0.8, resetAtMs: 1000,
  targetShare: 10, inFlight: 0, planAhead: 0.1, ...partial,
});
const PACING = { enabled: true, marginPct: 0.02, meanRunDurationHours: 0.2 };
const run = (views, pacing = PACING) => orderAccountsWithPacing(views, { pacing });
const ids = (r) => r.order.map(v => v.accountId);

test('defaults: on, 2% margin, a retry interval longer than the host retry budget needs', () => {
  assert.deepEqual({ ...DEFAULT_PACE_GUARD }, { enabled: true, marginPct: 0.02, retryAfterMs: 300000 });
});

test('normalizePaceGuard coerces garbage back to the defaults and keeps valid values', () => {
  assert.deepEqual(normalizePaceGuard(undefined), { ...DEFAULT_PACE_GUARD });
  assert.deepEqual(normalizePaceGuard({ enabled: 'yes', marginPct: -1, retryAfterMs: 5 }), { ...DEFAULT_PACE_GUARD });
  assert.deepEqual(normalizePaceGuard({ enabled: false, marginPct: 0.05, retryAfterMs: 120000 }),
    { enabled: false, marginPct: 0.05, retryAfterMs: 120000 });
  assert.equal(normalizePaceGuard({ marginPct: 0 }).marginPct, 0, 'a zero margin is valid');
});

test('an ahead pool is capped at ceil(paced slots): below the cap it serves, at the cap it drops out', () => {
  // targetShare 12/h x 0.2h = 2.4 slots, so the cap is 3.
  const r2 = run([lane('claude:1', { targetShare: 12, inFlight: 2 })]);
  assert.deepEqual(ids(r2), ['claude:1']);
  assert.deepEqual(r2.paced, []);
  const r3 = run([lane('claude:1', { targetShare: 12, inFlight: 3 })]);
  assert.deepEqual(ids(r3), []);
  assert.equal(r3.paced.length, 1);
  assert.equal(r3.paced[0].pool, 'claude');
  assert.equal(r3.paced[0].cap, 3);
  assert.equal(r3.paced[0].inFlight, 3);
});

test('the cap is at least 1: an ahead pool with nothing in flight still serves one run', () => {
  // 1/h x 0.2h = 0.2 slots: ceil is 1, and the floor is 1 either way.
  assert.deepEqual(ids(run([lane('claude:1', { targetShare: 1, inFlight: 0 })])), ['claude:1']);
  const held = run([lane('claude:1', { targetShare: 1, inFlight: 1 })]);
  assert.deepEqual(ids(held), []);
  assert.equal(held.paced[0].cap, 1);
  // Even a vanishing share, or none at all (0 slots), keeps the floor of 1.
  assert.deepEqual(ids(run([lane('claude:1', { targetShare: 0.0001, inFlight: 0 })])), ['claude:1']);
  const zero = run([lane('claude:1', { targetShare: 0, inFlight: 0 })]);
  assert.deepEqual(ids(zero), ['claude:1']);
  assert.equal(zero.pools[0].cap, 1);
});

test('an exact integer of slots is not rounded up by float noise', () => {
  // 10/h x 0.2h = 2 slots exactly (0.2 x 10 = 2.0000000000000004 is not a third slot).
  const r = run([lane('claude:1', { targetShare: 10.000000000000002, inFlight: 2 })]);
  assert.equal(r.paced[0].cap, 2);
});

test('a pool that is not ahead is never paced, however much is in flight', () => {
  for (const planAhead of [0.02, 0.0, -0.3]) {
    const r = run([lane('claude:1', { planAhead, targetShare: 1, inFlight: 50 })]);
    assert.deepEqual(ids(r), ['claude:1'], `planAhead ${planAhead} is within the margin`);
    assert.deepEqual(r.paced, []);
  }
  // Just over the margin is ahead.
  assert.deepEqual(ids(run([lane('claude:1', { planAhead: 0.0201, targetShare: 1, inFlight: 1 })])), []);
});

test('a zero margin treats any lead on plan as ahead', () => {
  const pacing = { ...PACING, marginPct: 0 };
  assert.deepEqual(ids(run([lane('claude:1', { planAhead: 0.0001, targetShare: 1, inFlight: 1 })], pacing)), []);
  assert.deepEqual(ids(run([lane('claude:1', { planAhead: 0, targetShare: 1, inFlight: 1 })], pacing)), ['claude:1']);
});

test('unknown plan position, unknown share, or reactive lanes fail open', () => {
  assert.deepEqual(ids(run([lane('claude:1', { planAhead: null, inFlight: 50 })])), ['claude:1']);
  assert.deepEqual(ids(run([lane('claude:1', { planAhead: undefined, inFlight: 50 })])), ['claude:1']);
  assert.deepEqual(ids(run([lane('claude:1', { targetShare: null, inFlight: 50 })])), ['claude:1']);
  assert.deepEqual(ids(run([lane('muse:1', { pool: 'muse', meter: 'reactive', planAhead: 0.5, inFlight: 50 })])), ['muse:1']);
});

test('each lane is judged on its own plan position; the cap sums per-lane allowances (0.2.53)', () => {
  // Lane 2 is far ahead, lane 1 far behind. Lane 1's full fair share is
  // max(1, 3/h x 0.2h) = 1, lane 2 contributes its 0.6 slots: cap ceil(1.6) = 2.
  // With 9 in flight only the ahead lane is held; the behind lane serves.
  const mixed = run([
    lane('claude:1', { planAhead: -0.4, targetShare: 3, inFlight: 9 }),
    lane('claude:2', { planAhead: 0.3, targetShare: 3, inFlight: 9 }),
  ]);
  assert.deepEqual(ids(mixed), ['claude:1']);
  assert.equal(mixed.paced[0].state, 'lanes-paced');
  assert.equal(mixed.paced[0].paced, false);
  assert.deepEqual(mixed.paced[0].pacedAccountIds, ['claude:2']);
  assert.equal(mixed.paced[0].cap, 2);
  // Below the cap nothing is held, even with the ahead lane in the pool.
  const under = run([
    lane('claude:1', { planAhead: -0.2, targetShare: 3, inFlight: 1 }),
    lane('claude:2', { planAhead: 0.3, targetShare: 3, inFlight: 1 }),
  ]);
  assert.deepEqual(ids(under).sort(), ['claude:1', 'claude:2']);
  assert.equal(under.pools[0].state, 'ahead');
  // Every lane ahead: the pool is paced whole, cap ceil(sum slots) as before.
  const ahead = run([
    lane('claude:1', { planAhead: 0.2, targetShare: 3, inFlight: 2 }),
    lane('claude:2', { planAhead: 0.3, targetShare: 3, inFlight: 2 }),
  ]);
  assert.deepEqual(ids(ahead), []);
  assert.equal(ahead.paced[0].cap, 2);
  assert.equal(ahead.paced[0].paced, true);
  assert.ok(Math.abs(ahead.paced[0].planAhead - 0.25) < 1e-9);
  assert.ok(Math.abs(ahead.paced[0].pacedSlots - 1.2) < 1e-9);
  assert.equal(ahead.paced[0].lanes, 2);
});

test('claude example: a spent lane no longer caps a lane far behind its own plan at one run', () => {
  // claude-lane-3 at 99% used (ahead of plan), claude-lane-4 at 11% used
  // with 4.6 days left (elapsed 2.4/7 = 0.343 -> 23 points behind plan).
  // The old mean (+0.30 ahead) capped the pool at ceil(0.1 + 0.8) = 1 and,
  // with one run in flight, held BOTH lanes.
  const elapsed = 2.4 / 7;
  const views = [
    lane('claude:claude-lane-3', { planAhead: 0.99 - elapsed, targetShare: 0.5, inFlight: 2, headroomPct: 0.4 }),
    lane('claude:claude-lane-4', { planAhead: 0.11 - elapsed, targetShare: 4, inFlight: 2 }),
  ];
  const old = run(views.map(v => ({ ...v, inFlight: 1 })));
  assert.ok(ids(old).includes('claude:claude-lane-4'), 'one run in flight: lane 4 serves');
  const r = run(views);
  assert.deepEqual(ids(r), ['claude:claude-lane-4']);
  const pool = r.pools[0];
  // allowance: lane-3 0.5 x 0.2 = 0.1; lane-4 max(1, 0.8) = 1 -> cap 2.
  assert.equal(pool.cap, 2);
  assert.deepEqual(pool.pacedAccountIds, ['claude:claude-lane-3']);
  const l4 = pool.laneVerdicts.find(l => l.accountId === 'claude:claude-lane-4');
  assert.equal(l4.ahead, false);
  assert.equal(l4.paced, false);
  // Lane 4 keeps serving however many runs the pool has in flight.
  const busy = run(views.map(v => ({ ...v, inFlight: 7 })));
  assert.deepEqual(ids(busy), ['claude:claude-lane-4']);
});

test('single-lane pools are unchanged by the per-lane guard', () => {
  const one = (partial) => run([lane('codex:1', { pool: 'codex', targetShare: 3, ...partial })]);
  const a = one({ planAhead: 0.1, inFlight: 1 });
  assert.equal(a.pools[0].cap, 1);
  assert.deepEqual(ids(a), []);
  assert.equal(a.pools[0].state, 'paced');
  assert.equal(a.pools[0].laneVerdicts, undefined);
  const b = one({ planAhead: -0.1, inFlight: 50 });
  assert.deepEqual(ids(b), ['codex:1']);
  assert.equal(b.pools[0].state, 'on-plan');
});

test('a pool with any lane of unknown position or share is not measured: it fails open', () => {
  // Leaving the unknown lane out would size the cap from the other lane alone
  // and throttle a pool whose real capacity is not known.
  const unknownBoth = run([
    lane('claude:1', { planAhead: 0.2, targetShare: 4, inFlight: 9 }),
    lane('claude:2', { planAhead: null, targetShare: null, inFlight: 9 }),
  ]);
  assert.deepEqual(ids(unknownBoth), ['claude:1', 'claude:2']);
  assert.equal(unknownBoth.pools[0].state, 'not-measured');
  const unknownShare = run([
    lane('claude:1', { planAhead: 0.2, targetShare: 4, inFlight: 9 }),
    lane('claude:2', { planAhead: 0.2, targetShare: null, inFlight: 9 }),
  ]);
  assert.deepEqual(ids(unknownShare), ['claude:1', 'claude:2']);
  const unknownPosition = run([
    lane('claude:1', { planAhead: 0.2, targetShare: 4, inFlight: 9 }),
    lane('claude:2', { planAhead: undefined, targetShare: 4, inFlight: 9 }),
  ]);
  assert.deepEqual(ids(unknownPosition), ['claude:1', 'claude:2']);
});

test('a pool mixing in a reactive lane is not paced (its in-flight count cannot be judged)', () => {
  const r = run([
    lane('claude:1', { planAhead: 0.4, targetShare: 1, inFlight: 9 }),
    lane('claude:2', { meter: 'reactive', planAhead: null, targetShare: null, inFlight: 9 }),
  ]);
  assert.deepEqual(ids(r), ['claude:1', 'claude:2']);
});

test('only the paced pool drops out; other pools keep serving in their usual order', () => {
  const r = run([
    lane('claude:1', { pool: 'claude', targetShare: 1, inFlight: 4, planAhead: 0.3 }),
    lane('codex:1', { pool: 'codex', targetShare: 5, inFlight: 0, planAhead: -0.1, resetAtMs: 2000 }),
    lane('muse:1', { pool: 'muse', targetShare: 5, inFlight: 0, planAhead: 0.0, resetAtMs: 3000 }),
  ]);
  assert.deepEqual(ids(r), ['codex:1', 'muse:1']);
  assert.deepEqual(r.paced.map(p => p.pool), ['claude']);
  assert.equal(r.pools.length, 3, 'every pool is reported with its state');
  assert.deepEqual(r.pools.map(p => [p.pool, p.state]).sort(),
    [['claude', 'paced'], ['codex', 'on-plan'], ['muse', 'on-plan']]);
});

test('an ahead pool under its cap reports ahead, not paced', () => {
  const r = run([lane('claude:1', { targetShare: 12, inFlight: 1 })]);
  assert.equal(r.pools[0].state, 'ahead');
  assert.equal(r.pools[0].paced, false);
  assert.equal(r.pools[0].cap, 3);
});

test('lanes that did not qualify (unhealthy, no headroom) do not count toward the pool', () => {
  // The unhealthy lane is very far ahead and would flip the mean; it is out.
  const r = run([
    lane('claude:1', { planAhead: -0.05, targetShare: 1, inFlight: 5 }),
    lane('claude:2', { planAhead: 0.9, health: 'exhausted' }),
    lane('claude:3', { planAhead: 0.9, headroomPct: 0.01 }),
  ]);
  assert.deepEqual(ids(r), ['claude:1']);
  assert.deepEqual(r.paced, []);
});

test('disabled, or no pacing option at all, restores the old ordering exactly', () => {
  const views = [
    lane('claude:1', { targetShare: 1, inFlight: 9, planAhead: 0.5 }),
    lane('codex:1', { pool: 'codex', targetShare: 5, inFlight: 0, planAhead: -0.1, resetAtMs: 2000 }),
  ];
  const old = orderAccountsForRun(views).map(v => v.accountId);
  assert.deepEqual(ids(orderAccountsWithPacing(views, {})), old);
  assert.deepEqual(ids(orderAccountsWithPacing(views, { pacing: null })), old);
  const off = orderAccountsWithPacing(views, { pacing: { ...PACING, enabled: false } });
  assert.deepEqual(ids(off), old);
  assert.deepEqual(off.paced, []);
  assert.deepEqual(orderAccountsForRun(views, { pacing: PACING }).map(v => v.accountId), ['codex:1'],
    'orderAccountsForRun keeps its signature and applies the guard when asked');
});

test('without a run-duration the slots are unknowable, so nothing is paced', () => {
  const r = run([lane('claude:1', { targetShare: 1, inFlight: 9 })], { enabled: true, marginPct: 0.02 });
  assert.deepEqual(ids(r), ['claude:1']);
});

test('paceGuardPools reports state per pool and is pure over its input', () => {
  const views = [lane('claude:1', { targetShare: 12, inFlight: 3 })];
  const frozen = JSON.stringify(views);
  const pools = paceGuardPools(views, { pacing: PACING, poolKeyOf: v => `pool:${v.pool}` });
  assert.equal(pools.length, 1);
  assert.equal(pools[0].paced, true);
  assert.equal(JSON.stringify(views), frozen);
});

test('a held lane never enters the order, but still counts toward its pool verdict', () => {
  const r = run([
    lane('devin:a', { pool: 'devin', planAhead: 0, targetShare: 0.5, inFlight: 0 }),
    lane('devin:b', { pool: 'devin', planAhead: 0, targetShare: 0.5, inFlight: 0, held: true }),
  ]);
  assert.deepEqual(ids(r), ['devin:a']);
});

test('a held lane is a pool member: its own lead paces only itself, never an on-plan sibling', () => {
  // Pool mean (0 + 0.1) / 2 = 0.05 used to hold the on-plan routable lane
  // through the held lane's lead. Per lane, devin:a is on plan and serves;
  // devin:b (ahead) is the lane held at the cap (max(1, 1) + 1 = 2).
  const r = run([
    lane('devin:a', { pool: 'devin', planAhead: 0, targetShare: 1, inFlight: 2 }),
    lane('devin:b', { pool: 'devin', planAhead: 0.1, targetShare: 1, inFlight: 2, held: true }),
  ], { ...PACING, meanRunDurationHours: 1 });
  assert.deepEqual(ids(r), ['devin:a']);
  assert.deepEqual(r.paced.map(p => p.pacedAccountIds), [['devin:b']]);
});

test('measured rate above required shrinks an ahead lane\'s slots by required/measured', () => {
  // Live shape 2026-10-21: two paced Meta lanes, each estimated at ~1.75 slots,
  // but measured at 2.1%/h against 0.55%/h required (review runs cost more than
  // the per-run estimate). The cap follows the real burn: 2 x 1.75 x 0.262 = 0.92 -> 1.
  const meta = (id, over = {}) => lane(id, {
    pool: 'meta', targetShare: 8.75, planAhead: 0.04, inFlight: 1,
    measuredRatePerHour: 0.021, requiredRatePerHour: 0.0055, ...over,
  });
  const held = run([meta('meta:4'), meta('meta:7')]);
  assert.equal(held.pools[0].cap, 1);
  assert.deepEqual(ids(held), []);
  const v = held.pools[0].laneVerdicts[0];
  assert.ok(Math.abs(v.rateCorrection - 0.0055 / 0.021) < 1e-9);

  // Without measurements (or measured within plan) the estimate stands: cap 4.
  const est = run([meta('meta:4', { measuredRatePerHour: null }), meta('meta:7', { measuredRatePerHour: 0.005 })]);
  assert.equal(est.pools[0].cap, 4);
  assert.equal(est.pools[0].laneVerdicts[0].rateCorrection, undefined);
});

test('rate correction never touches a lane on or behind plan, and is floored', async () => {
  const { rateCorrection, MIN_RATE_CORRECTION } = await import('../src/paceguard.mjs');
  // Behind plan: full fair share, even when burning fast (catch-up is allowed).
  const behind = run([lane('claude:4', { targetShare: 10, planAhead: -0.09, inFlight: 3,
    measuredRatePerHour: 0.04, requiredRatePerHour: 0.0068 })]);
  assert.equal(behind.pools[0].cap, 2);
  assert.deepEqual(ids(behind), ['claude:4']);
  assert.equal(rateCorrection({ measuredRatePerHour: 10, requiredRatePerHour: 0.01 }), MIN_RATE_CORRECTION);
  assert.equal(rateCorrection({ measuredRatePerHour: 0.01, requiredRatePerHour: 0 }), 1);
  assert.equal(rateCorrection({ measuredRatePerHour: NaN, requiredRatePerHour: 0.01 }), 1);
  assert.equal(rateCorrection({}), 1);
});
