import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCalibrationGroups,
  pooledBurnPerRun,
  perAccountRawBurn,
  capacityWeights,
  PLAN_SIZE,
} from '../src/pools.mjs';
import { orderAccountsForRun } from '../src/select.mjs';
import { computeConcurrencyTarget } from '../src/concurrency.mjs';

// A $200 Meta plan (~4x a standard plan) shares a calibration group with
// eight standard lanes. Its meter moves ~1/4 per run, so its burn per run is
// ~1/4 and its sustainable share is ~4x. Lanes are counted by weight, never
// equally.

const MIN = 60 * 1000;
const NOW = 1_750_000_000_000;

// Even traffic spread: 10 runs per lane in the span, 90 group runs.
const history = (startPct, endPct, at0, at1) => [
  { atMs: at0, usedPct: startPct },
  { atMs: at1, usedPct: endPct },
];

const groupFixture = () => {
  const memberKeys = Array.from({ length: 9 }, (_, i) => `meta:lane-${i + 1}`);
  // Eight standard lanes burn 0.01 (1.0 weekly point) each; the big lane
  // burns 0.0025 over the same 10 runs.
  const hists = new Map();
  for (let i = 0; i < 8; i++) {
    hists.set(memberKeys[i], history(0.24, 0.25, NOW - 60 * MIN, NOW));
  }
  hists.set(memberKeys[8], history(0.10, 0.1025, NOW - 60 * MIN, NOW));
  return { memberKeys, hists };
};

test('per-account raw burn recovers each lane burn under even spread', () => {
  const { memberKeys, hists } = groupFixture();
  const raw = perAccountRawBurn({
    memberKeys,
    historyOf: (k) => hists.get(k),
    spanMsOf: () => 60 * MIN,
    runsInSpan: () => 90,
    nowMs: NOW,
  });
  assert.equal(raw.size, 9);
  for (let i = 0; i < 8; i++) {
    assert.ok(Math.abs(raw.get(memberKeys[i]) - 0.001) < 1e-9, `lane ${i}: ${raw.get(memberKeys[i])}`);
  }
  assert.ok(Math.abs(raw.get(memberKeys[8]) - 0.00025) < 1e-9, `big: ${raw.get(memberKeys[8])}`);
});

test('capacity weights scale the big lane ~4x relative to the group median', () => {
  const { memberKeys, hists } = groupFixture();
  const raw = perAccountRawBurn({
    memberKeys,
    historyOf: (k) => hists.get(k),
    spanMsOf: () => 60 * MIN,
    runsInSpan: () => 90,
    nowMs: NOW,
  });
  const weights = capacityWeights(raw);
  for (let i = 0; i < 8; i++) {
    assert.ok(Math.abs(weights.get(memberKeys[i]) - 1) < 1e-9, `lane ${i}: ${weights.get(memberKeys[i])}`);
  }
  assert.ok(Math.abs(weights.get(memberKeys[8]) - 4) < 1e-6, `big: ${weights.get(memberKeys[8])}`);
});

test('minimal sample: lanes without enough runs keep no raw burn', () => {
  const { memberKeys, hists } = groupFixture();
  const raw = perAccountRawBurn({
    memberKeys,
    historyOf: (k) => hists.get(k),
    spanMsOf: () => 60 * MIN,
    // Only 2 group runs observed: below the minimal sample.
    runsInSpan: () => 2,
    nowMs: NOW,
  });
  assert.equal(raw.size, 0, 'no lane individualizes on a thin sample');
  assert.ok(PLAN_SIZE.minRunsForIndiv >= 3, 'minimal sample stays small but non-trivial');
});

test('weights clamp instead of exploding on noisy meters', () => {
  const raw = new Map([['a', 0.001], ['b', 0.001], ['c', 1e-9]]);
  const weights = capacityWeights(raw);
  assert.ok(weights.get('c') <= PLAN_SIZE.weightMax, `clamped: ${weights.get('c')}`);
  const raw2 = new Map([['a', 0.001], ['b', 0.001], ['c', 1.0]]);
  const weights2 = capacityWeights(raw2);
  assert.ok(weights2.get('c') >= PLAN_SIZE.weightMin, `clamped: ${weights2.get('c')}`);
});

test('uniform pools keep weight ~1 (pooled behavior unchanged)', () => {
  const keys = ['m1', 'm2', 'm3'];
  const hists = new Map(keys.map((k) => [k, history(0.24, 0.25, NOW - 60 * MIN, NOW)]));
  const raw = perAccountRawBurn({
    memberKeys: keys,
    historyOf: (k) => hists.get(k),
    spanMsOf: () => 60 * MIN,
    runsInSpan: () => 30,
    nowMs: NOW,
  });
  const weights = capacityWeights(raw);
  for (const k of keys) {
    assert.ok(Math.abs(weights.get(k) - 1) < 1e-9, `${k}: ${weights.get(k)}`);
  }
  // And the pooled figure matches each lane figure when uniform.
  const pooled = pooledBurnPerRun({
    memberKeys: keys, historyOf: (k) => hists.get(k), spanMsOf: () => 60 * MIN,
    runsInSpan: () => 30, nowMs: NOW,
  });
  assert.ok(Math.abs(pooled.burnPerRunPct - raw.get('m1')) < 1e-9);
});

const view = (accountId, partial = {}) => ({
  accountId, resetAtMs: null, headroomPct: 0.9, health: 'healthy',
  measuredRatePerHour: null, requiredRatePerHour: null, inFlight: 0, ...partial,
});

test('inside a pool the weighted least-loaded lane wins (~4x share for the big lane)', () => {
  // Same pool shortfall for every lane (pooled in-flight 0); the big lane
  // carries weight 4, so 4 in flight on it reads like 1 elsewhere.
  const lanes = [
    view('meta:lane-1', { pool: 'meta', targetShare: 1, inFlight: 0, laneInFlight: 1, capacityWeight: 1 }),
    view('meta:lane-big', { pool: 'meta', targetShare: 4, inFlight: 0, laneInFlight: 4, capacityWeight: 4 }),
  ];
  const [first] = orderAccountsForRun(lanes, {});
  // Normalized loads tie (1/1 == 4/4): deterministic tie-break, no crash, and
  // crucially the big lane is NOT ordered after the small one merely for
  // holding more runs.
  assert.ok(['meta:lane-1', 'meta:lane-big'].includes(first.accountId));
  const lanes2 = [
    view('meta:lane-1', { pool: 'meta', targetShare: 1, inFlight: 0, laneInFlight: 1, capacityWeight: 1 }),
    view('meta:lane-big', { pool: 'meta', targetShare: 4, inFlight: 0, laneInFlight: 3, capacityWeight: 4 }),
  ];
  assert.equal(orderAccountsForRun(lanes2, {})[0].accountId, 'meta:lane-big');
});

test('sequential weighted picks spread ~4:1 to the big lane', () => {
  const load = { small: 0, big: 0 };
  const picks = [];
  for (let i = 0; i < 10; i++) {
    const [w] = orderAccountsForRun([
      view('small', { pool: 'meta', targetShare: 1, inFlight: 0, laneInFlight: load.small, capacityWeight: 1 }),
      view('big', { pool: 'meta', targetShare: 4, inFlight: 0, laneInFlight: load.big, capacityWeight: 4 }),
    ], {});
    load[w.accountId === 'big' ? 'big' : 'small'] += 1;
    picks.push(w.accountId);
  }
  assert.equal(load.big, 8, `weighted spread: ${JSON.stringify(load)} picks ${picks.join(',')}`);
  assert.equal(load.small, 2);
});

test('concurrency slots scale with per-account burn (~4x for the big lane)', () => {
  const out = computeConcurrencyTarget({
    accounts: [
      { accountId: 'meta:lane-1', remainingPct: 0.7, hoursToReset: 100, burnPerRunPct: 0.001, measuredBurnPerRunPct: 0.001 },
      { accountId: 'meta:lane-big', remainingPct: 0.7, hoursToReset: 100, burnPerRunPct: 0.001, measuredBurnPerRunPct: 0.00025 },
    ],
    meanRunDurationHours: 0.186,
  });
  const byId = new Map(out.perAccount.map((r) => [r.accountId, r]));
  const ratio = byId.get('meta:lane-big').slots / byId.get('meta:lane-1').slots;
  assert.ok(Math.abs(ratio - 4) < 1e-9, `slots ratio ${ratio}`);
});

test('single-lane groups (mixed codex/claude plans) already individualize', () => {
  // Disjoint models stay separate groups; each calibrates on its own meter.
  const accounts = [
    { provider: 'codex', models: ['gpt-5-3'] },
    { provider: 'codex', models: ['sora-2'] },
  ];
  const { groupOf } = buildCalibrationGroups(accounts, ['codex:plus', 'codex:pro']);
  assert.notEqual(groupOf.get('codex:plus'), groupOf.get('codex:pro'));
});
