import test from 'node:test';
import assert from 'node:assert/strict';
import { computeConcurrencyTarget, distributeCaps, distributeWeightedCaps, DEFAULT_CONCURRENCY } from '../src/concurrency.mjs';

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('fleet mean run duration is the measured 0.186h', () => {
  assert.equal(DEFAULT_CONCURRENCY.meanRunDurationHours, 0.186);
});

test('worked example: required rate over measured E, times duration', () => {
  // Claude-A: 55% left, 72h to reset, measured E 0.05%/run.
  // Codex: 80% left, 48h, measured E 0.278%/run. D = 20min.
  const out = computeConcurrencyTarget({
    accounts: [
      { accountId: 'claude:1', remainingPct: 0.55, hoursToReset: 72, burnPerRunPct: 0.0005, measuredBurnPerRunPct: 0.0005, guardActive: false },
      { accountId: 'codex:1', remainingPct: 0.8, hoursToReset: 48, burnPerRunPct: 0.00278, measuredBurnPerRunPct: 0.00278, guardActive: false },
    ],
    meanRunDurationHours: 1 / 3,
    maxTotal: 75,
  });
  const claude = out.perAccount.find(a => a.accountId === 'claude:1');
  const codex = out.perAccount.find(a => a.accountId === 'codex:1');
  // (0.55/72)/0.0005 = 15.28 runs/h x 1/3h = 5.09 slots.
  assert.ok(approx(claude.runsPerHour, 15.2777, 0.01));
  assert.ok(approx(claude.slots, 5.0926, 0.01));
  // (0.80/48)/0.00278 = 5.99 runs/h x 1/3h = 2.00 slots.
  assert.ok(approx(codex.runsPerHour, 5.9952, 0.01));
  assert.ok(approx(out.target, 7.09, 0.02));
  assert.equal(out.calibration, 'measured');
});

test('weak calibration: no measured E means no target and no caps', () => {
  const out = computeConcurrencyTarget({
    accounts: [
      { accountId: 'a', remainingPct: 0.5, hoursToReset: 72, burnPerRunPct: 0.001, guardActive: false },
      { accountId: 'b', remainingPct: 0.5, hoursToReset: 72, burnPerRunPct: null, guardActive: false },
    ],
    meanRunDurationHours: 0.186,
    maxTotal: 75,
  });
  assert.equal(out.calibration, 'weak');
  assert.equal(out.target, null);
  assert.deepEqual(out.perAccount.map(a => a.reason).sort(), ['anchor-fallback', 'uncalibrated']);
});

test('partial calibration: measured accounts lead, anchor fills flagged gaps', () => {
  const out = computeConcurrencyTarget({
    accounts: [
      { accountId: 'a', remainingPct: 0.5, hoursToReset: 72, burnPerRunPct: 0.001, measuredBurnPerRunPct: 0.002, guardActive: false },
      { accountId: 'b', remainingPct: 0.5, hoursToReset: 72, burnPerRunPct: 0.001, guardActive: false },
    ],
    meanRunDurationHours: 0.186,
    maxTotal: 75,
  });
  assert.equal(out.calibration, 'partial');
  assert.ok(out.target > 0);
  assert.deepEqual(out.perAccount.map(a => a.reason).sort(), ['anchor-fallback', 'ok']);
});

test('guard-capped accounts contribute zero', () => {
  const out = computeConcurrencyTarget({
    accounts: [
      { accountId: 'a', remainingPct: 0.5, hoursToReset: 72, burnPerRunPct: 0.001, measuredBurnPerRunPct: 0.001, guardActive: true },
    ],
    meanRunDurationHours: 0.186,
    maxTotal: 75,
  });
  assert.equal(out.target, 0);
  assert.equal(out.perAccount[0].reason, '5h-guard');
});

test('hard ceiling binds; distribution spreads whole slots', () => {
  const out = computeConcurrencyTarget({
    accounts: [{ accountId: 'a', remainingPct: 1, hoursToReset: 1, burnPerRunPct: 0.0001, measuredBurnPerRunPct: 0.0001, guardActive: false }],
    meanRunDurationHours: 1,
    maxTotal: 75,
  });
  assert.equal(out.target, 75);
  const caps = distributeCaps(7, ['agent-c', 'agent-a', 'agent-b']);
  assert.deepEqual(caps, [
    { agentId: 'agent-a', maxConcurrentRuns: 3 },
    { agentId: 'agent-b', maxConcurrentRuns: 2 },
    { agentId: 'agent-c', maxConcurrentRuns: 2 },
  ]);
  assert.deepEqual(distributeCaps(0, ['x']), []);
});

test('weighted spread: floor 1 per active agent, largest remainder by queued', () => {
  // Total 7 over queues 5/2/1: floors take 3, remainder 4 splits 3/1/0.
  const caps = distributeWeightedCaps(7, [
    { agentId: 'a', queued: 5 },
    { agentId: 'b', queued: 2 },
    { agentId: 'c', queued: 1 },
  ]);
  assert.deepEqual(caps, [
    { agentId: 'a', maxConcurrentRuns: 4 },
    { agentId: 'b', maxConcurrentRuns: 2 },
    { agentId: 'c', maxConcurrentRuns: 1 },
  ]);
  assert.equal(caps.reduce((s, c) => s + c.maxConcurrentRuns, 0), 7);
});

test('weighted spread: short total grows to fit floors; idle agents excluded', () => {
  // Target 2 across 3 active agents: floors win, total becomes 3.
  assert.deepEqual(
    distributeWeightedCaps(2, [
      { agentId: 'a', queued: 4 },
      { agentId: 'b', queued: 1 },
      { agentId: 'c', queued: 1 },
      { agentId: 'idle', queued: 0 },
    ]).map(c => c.maxConcurrentRuns),
    [1, 1, 1],
  );
});

test('weighted spread: never exceeds maxTotal; shed target zeroes actives', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ agentId: `a${i}`, queued: i + 1 }));
  const capped = distributeWeightedCaps(1000, many, 5);
  assert.equal(capped.length, 5);
  assert.ok(capped.every(c => c.maxConcurrentRuns === 1));
  assert.deepEqual(
    distributeWeightedCaps(0, [{ agentId: 'a', queued: 3 }]),
    [{ agentId: 'a', maxConcurrentRuns: 0 }],
  );
  assert.deepEqual(distributeWeightedCaps(9, []), []);
  assert.deepEqual(distributeWeightedCaps(null, [{ agentId: 'a', queued: 1 }]), []);
});
