import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCalibrationGroups,
  pooledBurnPerRun,
  perAccountRawBurn,
  capacityWeights,
  boundBurnPerRun,
  boundSoloBurn,
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
    runsInSpanFor: () => 10,
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
    runsInSpanFor: () => 10,
    nowMs: NOW,
  });
  const weights = capacityWeights(raw);
  for (let i = 0; i < 8; i++) {
    assert.ok(Math.abs(weights.get(memberKeys[i]) - 1) < 1e-9, `lane ${i}: ${weights.get(memberKeys[i])}`);
  }
  assert.ok(Math.abs(weights.get(memberKeys[8]) - 4) < 1e-6, `big: ${weights.get(memberKeys[8])}`);
});

test('weighted spread is a stable fixed point: exact burns at 4:1 traffic', () => {
  // Once the big lane serves 4x runs (8 vs 2 of 10), its delta is 4x larger
  // in absolute terms but per-run it is still 1/4: normalizing by the
  // lane's OWN runs recovers the same burns and weights instead of
  // collapsing them back to 1 (the even-share normalization did).
  const keys = ['small', 'big'];
  const hists = new Map([
    ['small', history(0.24, 0.243, NOW - 60 * MIN, NOW)],
    ['big', history(0.10, 0.103, NOW - 60 * MIN, NOW)],
  ]);
  const served = { small: 3, big: 12 };
  const raw = perAccountRawBurn({
    memberKeys: keys,
    historyOf: (k) => hists.get(k),
    spanMsOf: () => 60 * MIN,
    runsInSpanFor: (k) => served[k],
    nowMs: NOW,
  });
  assert.ok(Math.abs(raw.get('small') - 0.001) < 1e-9, `small: ${raw.get('small')}`);
  assert.ok(Math.abs(raw.get('big') - 0.00025) < 1e-9, `big: ${raw.get('big')}`);
  const weights = capacityWeights(raw);
  assert.ok(weights.get('big') / weights.get('small') > 3.9, `ratio holds: ${weights.get('big')}/${weights.get('small')}`);
});

test('minimal sample: lanes without enough runs keep no raw burn', () => {
  const { memberKeys, hists } = groupFixture();
  const raw = perAccountRawBurn({
    memberKeys,
    historyOf: (k) => hists.get(k),
    spanMsOf: () => 60 * MIN,
    // Only 2 lane runs observed: below the minimal sample.
    runsInSpanFor: () => 2,
    nowMs: NOW,
  });
  assert.equal(raw.size, 0, 'no lane individualizes on a thin sample');
  assert.ok(PLAN_SIZE.minRunsForIndiv >= 3, 'minimal sample stays small but non-trivial');
});

test('share-driving burns are bounded to the group median', () => {
  const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`m${i}`, 0.001]));
  const thin = boundBurnPerRun({ ...many, mint: 0.00001 }, [...Object.keys(many), 'mint']);
  assert.equal(thin.burns.get('mint'), 0.001 / 8, `floored: ${thin.burns.get('mint')}`);
  assert.equal(thin.weights.get('mint'), 8);
  const fat = boundBurnPerRun({ ...many, hog: 1.0 }, [...Object.keys(many), 'hog']);
  assert.equal(fat.burns.get('hog'), 0.001 * 4, `capped: ${fat.burns.get('hog')}`);
  assert.equal(fat.weights.get('hog'), 0.25);
  // A genuine 4x plan passes through untouched.
  const real = boundBurnPerRun({ ...many, big: 0.00025 }, [...Object.keys(many), 'big']);
  assert.equal(real.burns.get('big'), 0.00025);
  assert.equal(real.weights.get('big'), 4);
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
    runsInSpanFor: () => 10,
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

test('solo lanes clamp to the cross-group median, not their own burn', () => {
  // A single-member group's median is its own burn (bound vacuous): the
  // cross-group reference bounds it instead. Thin mint floored at M/8.
  const mint = boundSoloBurn(0.00001, 0.001);
  assert.equal(mint.burn, 0.001 / 8);
  assert.equal(mint.weight, 8);
  // Genuine 4x solo plan passes through.
  const real = boundSoloBurn(0.00025, 0.001);
  assert.equal(real.burn, 0.00025);
  assert.equal(real.weight, 4);
  // Unusable inputs yield null, never a guess.
  assert.equal(boundSoloBurn(null, 0.001), null);
  assert.equal(boundSoloBurn(0.001, null), null);
  assert.equal(boundSoloBurn(0, 0.001), null);
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
