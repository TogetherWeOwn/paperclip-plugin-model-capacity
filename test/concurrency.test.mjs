import test from 'node:test';
import assert from 'node:assert/strict';
import { computeConcurrencyTarget, distributeCaps } from '../src/concurrency.mjs';

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('worked example: burn need over burn per run, times duration', () => {
  // Claude-A: 55% left, 72h to reset, haiku-max anchor 0.05%/run.
  // Codex: 80% left, 48h, sol-class anchor 0.278%/run. D = 20min.
  const out = computeConcurrencyTarget({
    accounts: [
      { accountId: 'claude:1', remainingPct: 0.55, hoursToReset: 72, burnPerRunPct: 0.0005, guardActive: false },
      { accountId: 'codex:1', remainingPct: 0.8, hoursToReset: 48, burnPerRunPct: 0.00278, guardActive: false },
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
});

test('guard-capped and uncalibrated accounts contribute zero', () => {
  const out = computeConcurrencyTarget({
    accounts: [
      { accountId: 'a', remainingPct: 0.5, hoursToReset: 72, burnPerRunPct: 0.001, guardActive: true },
      { accountId: 'b', remainingPct: 0.5, hoursToReset: 72, burnPerRunPct: null, guardActive: false },
    ],
    meanRunDurationHours: 1 / 3,
    maxTotal: 75,
  });
  assert.equal(out.target, 0);
  assert.deepEqual(out.perAccount.map(a => a.reason).sort(), ['5h-guard', 'uncalibrated']);
});

test('hard ceiling binds; distribution spreads whole slots', () => {
  const out = computeConcurrencyTarget({
    accounts: [{ accountId: 'a', remainingPct: 1, hoursToReset: 1, burnPerRunPct: 0.0001, guardActive: false }],
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
