import test from 'node:test';
import assert from 'node:assert/strict';
import { appendAccountUsage, calibrateAccounts } from '../src/calibration.mjs';
import { parseLaneAccount } from '../src/cliproxy.mjs';

const NOW = Date.parse('2026-10-15T00:00:00Z');
const MIN = 60000;
const reading = (atMs, requests, used, extra = {}) => ({
  signalsAtMs: atMs,
  weekly: { utilization: used, resetsAtMs: NOW + 7 * 86400000 },
  fiveHour: { utilization: used, resetsAtMs: NOW + 5 * 3600000 },
  usage: { observedAtMs: atMs, epoch: 'keeper-1', requests }, ...extra,
});
const history = (burn, requests = 400, extra = {}) => [
  reading(NOW, 100, 0.1, extra), reading(NOW + 30 * MIN, 100 + requests, 0.1 + burn, extra),
].reduce((h, a) => appendAccountUsage(h, a, NOW + 30 * MIN), []);
const calibrate = (histories, prior = 0.004, nowMs = NOW + 30 * MIN) => calibrateAccounts({
  memberKeys: Object.keys(histories), historyOf: k => histories[k],
  groupBurnPerRunPct: prior, runsBetween: () => 400,
  nowMs,
});

test('usage parser requires real counter provenance and never substitutes missing counters with zero', () => {
  const a = parseLaneAccount({ provider: 'meta', lane: 'a', observedAt: new Date(NOW).toISOString(),
    usage: { observedAt: new Date(NOW).toISOString(), epoch: 'keeper-1', requests: 0 } }, NOW);
  assert.equal(a.usage.requests, 0);
  assert.equal(a.usage.observedAtMs, NOW);
  for (const usage of [null, {}, { epoch: 'e', requests: 2 }, { observedAt: new Date(NOW).toISOString(), requests: 2 },
    { observedAt: new Date(NOW).toISOString(), epoch: 'e', requests: -1 }]) {
    assert.equal(parseLaneAccount({ provider: 'meta', usage }, NOW).usage, null);
  }
});

for (const provider of ['meta', 'codex', 'claude', 'future-provider']) {
  test(`${provider}: own meter/request deltas individualize a 4x account, not the model-mapped first lane`, () => {
    const keys = ['one', 'two', 'three', 'large'].map(k => `${provider}:${k}`);
    const histories = Object.fromEntries(keys.map((k, i) => [k, history(i === 3 ? 0.04 : 0.16)]));
    const result = calibrate(histories);
    const standard = result.get(keys[0]);
    const large = result.get(keys[3]);
    assert.equal(large.source, 'account-weekly');
    assert.ok(Math.abs(large.capacityWeight - 4) < 1e-9);
    assert.ok(Math.abs(standard.burnPerRunPct / large.burnPerRunPct - 4) < 1e-9);
    assert.equal(large.confidence, 1);
    assert.equal(large.attributedRuns, 100);
  });
}

test('first quantized low-burn sample grants provisional weight; confidence grows with independent meter movement', () => {
  const early = calibrate({ a: history(0.04), b: history(0.04), large: history(0.01) });
  assert.ok(early.get('large').capacityWeight >= 1.9);
  assert.ok(early.get('large').capacityWeight < 4);
  assert.ok(early.get('large').confidence > 0 && early.get('large').confidence < 1);
  const late = calibrate({ a: history(0.16), b: history(0.16), large: history(0.04) });
  assert.ok(late.get('large').confidence > early.get('large').confidence);
  assert.ok(late.get('large').capacityWeight > early.get('large').capacityWeight);
});

test('request share prevents an idle 1x account being mistaken for a larger plan', () => {
  const r = calibrate({ a: history(0.16, 400), b: history(0.16, 400), idle: history(0.04, 100) });
  assert.ok(Math.abs(r.get('idle').capacityWeight - 1) < 1e-9);
});

test('sub-quantum, flat, stale and absent usage keep the group prior without infinite weights', () => {
  for (const h of [history(0), history(0.005), [], history(0.04, 0)]) {
    const r = calibrate({ a: history(0.04), b: history(0.04), new: h });
    assert.equal(r.get('new').capacityWeight, 1);
    assert.equal(r.get('new').source, 'group-prior');
  }
  const r = calibrate({ a: history(0.04) }, 0.004, NOW + 7 * 3600000);
  assert.equal(r.get('a').source, 'group-prior');
});

test('resets, missing samples and counter epochs never bridge incompatible readings', () => {
  for (const change of [
    { usage: { epoch: 'keeper-2', requests: 1000, observedAtMs: NOW + 30 * MIN } },
    { usage: { epoch: 'keeper-1', requests: 1, observedAtMs: NOW + 30 * MIN } },
    { weekly: { utilization: 0.3, resetsAtMs: NOW + 8 * 86400000 }, fiveHour: { utilization: null } },
    { weekly: { utilization: 0.05 }, fiveHour: { utilization: null } },
  ]) {
    const h = appendAccountUsage([], reading(NOW, 100, 0.1), NOW);
    const changed = appendAccountUsage(h, reading(NOW + 30 * MIN, 500, 0.14, change), NOW + 30 * MIN);
    assert.equal(calibrate({ a: changed }).get('a').source, 'group-prior');
  }
});

test('5h meter can infer relative weight, but never treats a 5h fraction as a weekly fraction', () => {
  const h = (burn) => [reading(NOW, 100, null, { fiveHour: { utilization: 0.1, resetsAtMs: NOW + 5 * 3600000 } }),
    reading(NOW + 30 * MIN, 500, null, { fiveHour: { utilization: 0.1 + burn, resetsAtMs: NOW + 5 * 3600000 } })]
    .reduce((acc, a) => appendAccountUsage(acc, a, NOW + 30 * MIN), []);
  const result = calibrate({ a: h(0.16), b: h(0.16), large: h(0.04) });
  assert.equal(result.get('large').source, 'account-five-hour');
  assert.ok(Math.abs(result.get('large').capacityWeight - 4) < 1e-9);
  assert.ok(Math.abs(result.get('large').burnPerRunPct - 0.001) < 1e-9);
  assert.equal(calibrate({ a: h(0.16) }, null).get('a').burnPerRunPct, null);
});

test('capacity weights are bounded for unusually large and small plans', () => {
  const r = calibrate({ a: history(0.04), b: history(0.04), tiny: history(0.8), huge: history(0.04, 80000) });
  assert.equal(r.get('tiny').capacityWeight, 0.25);
  assert.equal(r.get('huge').capacityWeight, 8);
});

test('a missing or reset peer counter keeps the pooled prior for the whole group (no relative pricing without a run scale)', () => {
  // Uneven request shares: large serves 700 of 1000 requests for one quantum.
  const full = { a: history(0.16, 100), b: history(0.16, 100), c: history(0.16, 100), large: history(0.01, 700) };
  const aligned = calibrate(full, 0.004);
  assert.equal(aligned.get('large').source, 'account-weekly');
  assert.ok(aligned.get('large').capacityWeight > 1);
  assert.equal(aligned.get('a').source, 'account-weekly');
  // A peer with a single stale point has no usage span: no run scale exists,
  // so pricing the others' relative weights against the pooled prior would
  // overstate the small accounts whenever shares are uneven.
  const staleC = [reading(NOW + 30 * MIN, 200, 0.26)]
    .reduce((h, a) => appendAccountUsage(h, a, NOW + 30 * MIN), []);
  const missing = calibrate({ ...full, c: staleC }, 0.004);
  for (const k of ['a', 'b', 'c', 'large']) {
    const e = missing.get(k);
    assert.equal(e.source, 'group-prior');
    assert.equal(e.capacityWeight, 1);
    assert.equal(e.burnPerRunPct, 0.004);
    assert.equal(e.attributedRuns, null);
  }
  // A mid-window counter reset trims the peer to a single post-reset point: same fallback.
  const resetC = [reading(NOW, 100, 0.1), reading(NOW + 30 * MIN, 800, 0.11,
    { usage: { epoch: 'keeper-2', requests: 800, observedAtMs: NOW + 30 * MIN } })]
    .reduce((h, a) => appendAccountUsage(h, a, NOW + 30 * MIN), []);
  const reset = calibrate({ ...full, c: resetC }, 0.004);
  for (const k of ['a', 'b', 'c', 'large']) {
    assert.equal(reset.get(k).source, 'group-prior');
    assert.equal(reset.get(k).capacityWeight, 1);
  }
});
