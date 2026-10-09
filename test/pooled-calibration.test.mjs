import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCalibrationGroups, pooledBurnPerRun } from '../src/pools.mjs';

// CLIProxy spreads Muse traffic over all 8 Meta
// credentials, but the ledger records every Muse run on meta-lane-1.
// Per-lane calibration divided lane-1's delta by ALL runs (E ~8x low) and
// left the other 7 lanes without runs (never calibrated).

const MIN = 60 * 1000;
const NOW = 1_750_000_000_000;
const lane = (n, models = ['muse-spark-1.3']) => ({ provider: 'meta', models, accountId: `meta:meta-lane-${n}` });

test('same-provider lanes serving a common model form one calibration group', () => {
  const accounts = [lane(1), lane(2), lane(3), { provider: 'claude', models: ['claude-opus-5-5'] }];
  const keys = ['meta:meta-lane-1', 'meta:meta-lane-2', 'meta:meta-lane-3', 'claude:c1'];
  const { groupOf, members } = buildCalibrationGroups(accounts, keys);
  assert.equal(groupOf.get('meta:meta-lane-3'), 'meta:meta-lane-1');
  assert.equal(groupOf.get('claude:c1'), 'claude:c1');
  assert.deepEqual(members.get('meta:meta-lane-1'), ['meta:meta-lane-1', 'meta:meta-lane-2', 'meta:meta-lane-3']);
});

test('disjoint model sets of one provider stay separate; missing model lists merge', () => {
  const accounts = [
    { provider: 'antigravity', models: ['gpt-oss-120b'] },
    { provider: 'antigravity', models: ['gemini-2-5-flash'] },
    { provider: 'kimi', models: null },
    { provider: 'kimi', models: ['kimi-k3-256k'] },
    { provider: 'kimi', models: ['kimi-k3-256k'] },
  ];
  const keys = ['antigravity:a', 'antigravity:b', 'kimi:k1', 'kimi:k2', 'kimi:k3'];
  const { groupOf } = buildCalibrationGroups(accounts, keys);
  assert.notEqual(groupOf.get('antigravity:a'), groupOf.get('antigravity:b'));
  assert.equal(groupOf.get('kimi:k2'), groupOf.get('kimi:k1'));
  assert.equal(groupOf.get('kimi:k3'), groupOf.get('kimi:k1'));
});

test('model-id spelling variants (provider prefix, effort parens) still match', () => {
  const accounts = [
    { provider: 'meta', models: ['meta/muse-spark-1.3(high)'] },
    { provider: 'meta', models: ['muse-spark-1.3'] },
  ];
  const { groupOf } = buildCalibrationGroups(accounts, ['m1', 'm2']);
  assert.equal(groupOf.get('m1'), groupOf.get('m2'));
});

// 8 lanes, each burned 1.0 weekly points over the span while 13 runs were
// recorded (all on lane-1).
const history = (startPct, endPct) => [
  { atMs: NOW - 60 * MIN, usedPct: startPct },
  { atMs: NOW - 30 * MIN, usedPct: (startPct + endPct) / 2 },
  { atMs: NOW, usedPct: endPct },
];

test('pooled E sums every lane delta over every pool run (the 8x fix)', () => {
  const memberKeys = Array.from({ length: 8 }, (_, i) => `meta:meta-lane-${i + 1}`);
  const hist = new Map(memberKeys.map((k, i) => [k, history(0.24 + i * 0.001, 0.25 + i * 0.001)]));
  const pooled = pooledBurnPerRun({
    memberKeys, historyOf: k => hist.get(k), spanMsOf: () => 60 * MIN,
    runsInSpan: () => 13, nowMs: NOW,
  });
  assert.ok(Math.abs(pooled.burnPerRunPct - (8 * 0.01) / 13) < 1e-9, `E ${pooled.burnPerRunPct}`);
  assert.equal(pooled.contributing, 8);
  // The legacy per-lane figure for lane-1 was a single lane's delta over all
  // 13 runs -- one eighth of the pool figure.
  const lane1 = pooledBurnPerRun({
    memberKeys: [memberKeys[0]], historyOf: k => hist.get(k), spanMsOf: () => 60 * MIN,
    runsInSpan: () => 13, nowMs: NOW,
  });
  assert.ok(Math.abs(pooled.burnPerRunPct / lane1.burnPerRunPct - 8) < 1e-9);
});

test('unmeasurable inputs yield null, never a guessed E', () => {
  const base = { memberKeys: ['a', 'b'], historyOf: () => history(0.1, 0.2), spanMsOf: () => 60 * MIN, runsInSpan: () => 5, nowMs: NOW };
  assert.ok(pooledBurnPerRun(base));
  assert.equal(pooledBurnPerRun({ ...base, runsInSpan: () => 0 }), null, 'no runs');
  assert.equal(pooledBurnPerRun({ ...base, spanMsOf: () => null }), null, 'no measured span');
  assert.equal(pooledBurnPerRun({ ...base, historyOf: () => history(0.2, 0.2) }), null, 'no movement');
  assert.equal(pooledBurnPerRun({ ...base, historyOf: () => history(0.5, 0.1) }), null, 'counter reset only');
});

test('a lane with short history is left out, the rest still count', () => {
  const hists = { a: history(0.1, 0.2), b: history(0.3, 0.3), c: [{ atMs: NOW - 5 * MIN, usedPct: 0.3 }] };
  const pooled = pooledBurnPerRun({
    memberKeys: ['a', 'b', 'c'], historyOf: k => hists[k], spanMsOf: k => (k === 'c' ? null : 60 * MIN),
    runsInSpan: () => 10, nowMs: NOW,
  });
  assert.ok(Math.abs(pooled.burnPerRunPct - 0.1 / 10) < 1e-9);
  assert.equal(pooled.contributing, 1);
  assert.equal(pooled.members, 3);
});

test('a weekly-window reset on any member voids the sample (the runs it served stay in the count)', () => {
  // Lane b reset mid-span (0.9 -> 0.0). Summing only lane a over all 10 runs
  // would understate E by the share b served.
  const hists = { a: history(0.1, 0.2), b: history(0.9, 0.0) };
  const pooled = pooledBurnPerRun({
    memberKeys: ['a', 'b'], historyOf: k => hists[k], spanMsOf: () => 60 * MIN,
    runsInSpan: () => 10, nowMs: NOW,
  });
  assert.equal(pooled, null);
});

test('the span is the shortest member span so deltas and run counts share a window', () => {
  const seen = [];
  pooledBurnPerRun({
    memberKeys: ['a', 'b'], historyOf: () => history(0.1, 0.2),
    spanMsOf: k => (k === 'a' ? 60 * MIN : 20 * MIN),
    runsInSpan: (span) => { seen.push(span); return 4; }, nowMs: NOW,
  });
  assert.deepEqual(seen, [20 * MIN]);
});
