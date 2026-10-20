import test from 'node:test';
import assert from 'node:assert/strict';
import { computeConcurrencyTarget, distributeCaps, distributeWeightedCaps, allocateKeptAndRoutedCaps, computeReservedFloor, applyReservedFloors, DEFAULT_CONCURRENCY } from '../src/concurrency.mjs';

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('kept agents spend the fleet target from their own paced pool', () => {
  const out = allocateKeptAndRoutedCaps({
    target: 20,
    maxTotal: 75,
    demandFactor: 1,
    agents: [
      { agentId: 'reviewer', running: 0, queued: 40 },
      { agentId: 'doer', running: 0, queued: 40 },
    ],
    keepAgentIds: ['reviewer'],
    keptByAgent: { reviewer: { accountId: 'meta:1' } },
    accounts: [{ accountId: 'meta:1', pool: 'meta' }, { accountId: 'codex:1', pool: 'codex' }],
    perAccount: [{ accountId: 'meta:1', slots: 12 }, { accountId: 'codex:1', slots: 30 }],
    pacePools: [{ pool: 'meta', cap: 4 }],
  });

  assert.equal(out.kept[0].maxConcurrentRuns, 4);
  assert.equal(out.routed[0].maxConcurrentRuns, 16);
  assert.equal(out.kept[0].maxConcurrentRuns + out.routed[0].maxConcurrentRuns, 20);
});

test('kept allocation never exceeds its fleet share when the target is below the pool cap', () => {
  const out = allocateKeptAndRoutedCaps({
    target: 3,
    maxTotal: 75,
    demandFactor: 1,
    agents: [
      { agentId: 'reviewer', running: 0, queued: 40 },
      { agentId: 'doer', running: 0, queued: 40 },
    ],
    keepAgentIds: ['reviewer'],
    keptByAgent: { reviewer: { accountId: 'meta:1' } },
    accounts: [{ accountId: 'meta:1', pool: 'meta' }, { accountId: 'codex:1', pool: 'codex' }],
    perAccount: [{ accountId: 'meta:1', slots: 12 }, { accountId: 'codex:1', slots: 30 }],
    pacePools: [{ pool: 'meta', cap: 4 }],
  });

  assert.ok(out.kept[0].maxConcurrentRuns <= 3,
    `kept Reviewer cap ${out.kept[0].maxConcurrentRuns} must not exceed its fleet share of 3`);
  const total = out.kept.reduce((s, e) => s + e.maxConcurrentRuns, 0)
    + out.routed.reduce((s, e) => s + e.maxConcurrentRuns, 0);
  assert.ok(total <= 3, `fleet total ${total} must not exceed the target of 3`);
});

test('shared-pool kept members split the pool ceiling instead of each holding it', () => {
  const out = allocateKeptAndRoutedCaps({
    target: 20,
    maxTotal: 75,
    agents: [
      { agentId: 'reviewer', running: 0, queued: 30 },
      { agentId: 'keeper2', running: 0, queued: 30 },
    ],
    keepAgentIds: ['reviewer', 'keeper2'],
    keptByAgent: { reviewer: { accountId: 'meta:1' }, keeper2: { accountId: 'meta:1' } },
    accounts: [{ accountId: 'meta:1', pool: 'meta' }, { accountId: 'codex:1', pool: 'codex' }],
    perAccount: [{ accountId: 'meta:1', slots: 12 }, { accountId: 'codex:1', slots: 30 }],
    pacePools: [{ pool: 'meta', cap: 4 }],
  });

  const byId = new Map([...out.kept, ...out.routed].map(e => [e.agentId, e]));
  assert.equal(byId.get('reviewer').maxConcurrentRuns, 2);
  assert.equal(byId.get('keeper2').maxConcurrentRuns, 2);
  // Each member's floor ceiling is its own share: a reserved floor of 3 for
  // either member is blocked (3 > 2) instead of stacking to 6 past the cap.
  assert.equal(out.keptCeilings.get('reviewer'), 2);
  assert.equal(out.keptCeilings.get('keeper2'), 2);
});

test('target-constrained shared pool splits headroom so floors cannot jointly exceed the cap', () => {
  const out = allocateKeptAndRoutedCaps({
    target: 2,
    maxTotal: 75,
    agents: [
      { agentId: 'keeperA', running: 0, queued: 10 },
      { agentId: 'keeperB', running: 0, queued: 10 },
    ],
    keepAgentIds: ['keeperA', 'keeperB'],
    keptByAgent: { keeperA: { accountId: 'meta:1' }, keeperB: { accountId: 'meta:1' } },
    accounts: [{ accountId: 'meta:1', pool: 'meta' }],
    perAccount: [{ accountId: 'meta:1', slots: 30 }],
    pacePools: [{ pool: 'meta', cap: 10 }],
  });

  // Under-allocated group (G=2 < C=10): each ceiling grants only an equal
  // headroom share, so the ceiling sum stays within the pace cap.
  const byId = new Map(out.kept.map(e => [e.agentId, e]));
  assert.equal(byId.get('keeperA').maxConcurrentRuns, 1);
  assert.equal(byId.get('keeperB').maxConcurrentRuns, 1);
  assert.equal(out.keptCeilings.get('keeperA'), 5);
  assert.equal(out.keptCeilings.get('keeperB'), 5);

  // Full floor chain, mirroring the /caps route: floors of 6 each are both
  // blocked (6 > 5) instead of stacking to 12 past the cap of 10.
  const blockedOf = (spec) => out.kept
    .filter(e => {
      const floor = computeReservedFloor(e.running, e.queued, spec);
      return floor != null && floor > out.keptCeilings.get(e.agentId);
    })
    .map(e => e.agentId);
  const overFloors = { keeperA: { base: 6, perQueued: 100, max: 6 }, keeperB: { base: 6, perQueued: 100, max: 6 } };
  assert.deepEqual(blockedOf(overFloors.keeperA).sort(), ['keeperA', 'keeperB']);
  const held = applyReservedFloors(out.kept, {
    reservedFloors: overFloors, ceiling: 75,
    blockedAgentIds: [...blockedOf(overFloors.keeperA)],
  });
  assert.equal(held.entries.reduce((s, e) => s + e.allocated, 0), 2);

  // A feasible combo still lifts: floors of 4 each fit the shared 10.
  const fitFloors = { keeperA: { base: 4, perQueued: 100, max: 4 }, keeperB: { base: 4, perQueued: 100, max: 4 } };
  assert.deepEqual(blockedOf(fitFloors.keeperA), []);
  const lifted = applyReservedFloors(out.kept, {
    reservedFloors: fitFloors, ceiling: 75, blockedAgentIds: [],
  });
  assert.equal(lifted.entries.reduce((s, e) => s + e.allocated, 0), 8);
});

test('breaker-exhausted kept account does not contribute pool capacity', () => {
  const out = allocateKeptAndRoutedCaps({
    target: 20,
    maxTotal: 75,
    agents: [{ agentId: 'reviewer', running: 0, queued: 32 }],
    keepAgentIds: ['reviewer'],
    keptByAgent: { reviewer: { accountId: 'meta:1' } },
    accounts: [{ accountId: 'meta:1', pool: 'meta' }],
    perAccount: [{ accountId: 'meta:1', slots: 12 }],
    unavailableAccountIds: ['meta:1'],
  });

  assert.equal(out.kept[0].maxConcurrentRuns, 0);
});

test('unresolved kept pool demand remains visible as zero capacity', () => {
  const out = allocateKeptAndRoutedCaps({
    target: 20,
    maxTotal: 75,
    agents: [
      { agentId: 'reviewer', running: 0, queued: 32 },
      { agentId: 'doer', running: 0, queued: 5 },
    ],
    keepAgentIds: ['reviewer'],
    keptByAgent: {},
  });

  assert.equal(out.kept[0].agentId, 'reviewer');
  assert.equal(out.kept[0].maxConcurrentRuns, 0);
  assert.equal(out.routed[0].agentId, 'doer');
  assert.equal(out.routed[0].maxConcurrentRuns, 5);
});

test('unresolved zero-cap kept demand does not shrink routed capacity', () => {
  const out = allocateKeptAndRoutedCaps({
    target: 60,
    maxTotal: 75,
    agents: [
      { agentId: 'reviewer', running: 0, queued: 32 },
      { agentId: 'doer', running: 0, queued: 70 },
    ],
    keepAgentIds: ['reviewer'],
    keptByAgent: {},
  });

  assert.equal(out.kept[0].maxConcurrentRuns, 0);
  assert.equal(out.routed[0].maxConcurrentRuns, 70);
});

test('kept-agent demand factor scales its pool capacity', () => {
  const out = allocateKeptAndRoutedCaps({
    target: 10,
    maxTotal: 20,
    demandFactor: 0.5,
    agents: [{ agentId: 'reviewer', running: 0, queued: 30 }],
    keepAgentIds: ['reviewer'],
    keptByAgent: { reviewer: { accountId: 'meta:1' } },
    accounts: [{ accountId: 'meta:1', pool: 'meta' }],
    perAccount: [{ accountId: 'meta:1', slots: 12 }],
  });

  assert.equal(out.kept[0].maxConcurrentRuns, 6);
});

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

test('unhealthy accounts contribute zero slots with reason excluded', () => {
  // Dead quota is not sustainable concurrency: an unavailable account with a
  // measured E still allocates nothing, and the target equals the healthy
  // accounts only. Fails pre-fix (healthy key ignored, dead quota in target).
  const out = computeConcurrencyTarget({
    accounts: [
      { accountId: 'a', remainingPct: 0.5, hoursToReset: 72, burnPerRunPct: 0.001, measuredBurnPerRunPct: 0.001, guardActive: false, healthy: true },
      { accountId: 'b', remainingPct: 0.5, hoursToReset: 72, burnPerRunPct: 0.001, measuredBurnPerRunPct: 0.001, guardActive: false, healthy: false },
    ],
    meanRunDurationHours: 0.186, maxTotal: 75,
  });
  const a = out.perAccount.find(x => x.accountId === 'a');
  const b = out.perAccount.find(x => x.accountId === 'b');
  assert.deepEqual([b.slots, b.runsPerHour, b.capped, b.reason], [0, 0, true, 'excluded']);
  assert.equal(out.target, a.slots);
  assert.ok(out.target > 0);
});
