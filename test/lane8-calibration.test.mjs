import test from 'node:test';
import assert from 'node:assert/strict';
import { appendAccountUsage, calibrateAccounts, MIN_ATTRIBUTED_RUNS, MAX_BASELINE_FACTOR } from '../src/calibration.mjs';
import { computeConcurrencyTarget } from '../src/concurrency.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

// 2026-10-22 10:06Z: target C* fell 11.6 -> 6.4 and the Reviewer cap 11 -> 5.
// Nothing changed in supply; one lane's calibration jumped. meta:meta-lane-8
// (+meta6, paced, not burn) read calibrationSource account-weekly with
// attributedRuns 0.51 and confidence 0.25. Its burnPerRunPct came out 0.0117
// against a groupMedianBurnPerRunPct (account-weekly baseline) of 0.0099,
// while the other Meta lanes used the group prior 0.0004 -- lane 8 priced
// ~29x higher. Its slots fell 3.83 -> 0.14 though its measured rate (1.03%/h)
// was close to required (0.88%/h); its weekly meter moved one quantum
// (0.24 -> 0.25). Cross-check: burn lane 5 runs ~15 in flight at ~3%/h,
// ~0.04% per run, so the prior was right and the baseline was not.
//
// Cause: baseline = medianWeekly x requestsPerRun, with requestsPerRun =
// (requests across all Meta lanes) / runsBetween (ledger runs in the group).
// Meta requests that never reach the ledger (kept, reviewerRouting, shadow
// and non-Paperclip callers) inflate requestsPerRun ~25x, and one quantum on
// 0.5 runs was accepted at confidence 0.25.
const NOW = Date.parse('2026-10-22T10:06:00Z');
const MIN = 60000;
const reading = (atMs, requests, used, five = 0.1) => ({
  signalsAtMs: atMs,
  weekly: { utilization: used, resetsAtMs: NOW + 4 * 86400000 },
  fiveHour: { utilization: five, resetsAtMs: NOW + 5 * 3600000 },
  usage: { observedAtMs: atMs, epoch: 'keeper-1', requests },
});
const historyOf = (points) => points.reduce((h, a) => appendAccountUsage(h, a, NOW), []);
// Incident shape: lane 8 moves one quantum on 50 requests; siblings are flat
// (no weekly sample) but contribute their counters to requestsPerRun. Ten
// ledger runs over ~1000 requests inflate requestsPerRun to ~100.
const incidentHistories = () => ({
  'meta:lane-4': historyOf([reading(NOW - 30 * MIN, 100, 0.20), reading(NOW, 417, 0.20)]),
  'meta:lane-5': historyOf([reading(NOW - 30 * MIN, 100, 0.30), reading(NOW, 417, 0.30)]),
  'meta:lane-7': historyOf([reading(NOW - 30 * MIN, 100, 0.18), reading(NOW, 416, 0.18)]),
  'meta:lane-8': historyOf([reading(NOW - 30 * MIN, 100, 0.24), reading(NOW, 150, 0.25)]),
});
const incidentCalibrate = (histories = incidentHistories(), prior = 0.0004) => calibrateAccounts({
  memberKeys: Object.keys(histories), historyOf: k => histories[k],
  groupBurnPerRunPct: prior, runsBetween: () => 10, nowMs: NOW,
});

test('guards are exported at their documented floors', () => {
  assert.equal(MIN_ATTRIBUTED_RUNS, 10);
  assert.equal(MAX_BASELINE_FACTOR, 4);
});

test('incident replay: one quantum on half a run keeps the group prior', () => {
  const result = incidentCalibrate();
  const lane8 = result.get('meta:lane-8');
  assert.equal(lane8.source, 'group-prior');
  assert.equal(lane8.burnPerRunPct, 0.0004);
  assert.equal(lane8.capacityWeight, 1);
  assert.equal(lane8.attributedRuns, null);
  assert.equal(lane8.rejectionReason, 'low-attributed-runs');
  assert.ok(Math.abs(lane8.attemptedAttributedRuns - 0.5) < 0.05);
  // Siblings never had a sample; they name the missing evidence too.
  for (const k of ['meta:lane-4', 'meta:lane-5', 'meta:lane-7']) {
    assert.equal(result.get(k).source, 'group-prior');
    assert.equal(result.get(k).rejectionReason, 'no-evidence');
  }
});

test('incident replay: the baseline 50x the prior is named as unattributed requests', () => {
  const lane8 = incidentCalibrate().get('meta:lane-8');
  assert.equal(lane8.requestsPerRun, 100);
  assert.equal(lane8.calibrationRuns, 10);
  assert.equal(lane8.calibrationRequests, 1000);
  // 1 - prior/baseline = 1 - 0.0004/0.02 = 0.98: 98% of the counted requests
  // never reached the ledger as runs.
  assert.ok(Math.abs(lane8.unattributedRequestShare - 0.98) < 1e-9);
  assert.ok(Math.abs(lane8.attemptedBaseline - 0.02) < 1e-9);
});

test('baseline guard: enough runs but a 25x baseline still keeps the prior', () => {
  // Siblings burn 0.0004 per request (median); lane 8 serves 1000 requests for
  // its quantum (10 attributed runs, clearing the floor) while requestsPerRun
  // stays inflated at 100, so the baseline lands 100x the prior.
  const scaled = {
    'meta:lane-4': historyOf([reading(NOW - 30 * MIN, 100, 0.20), reading(NOW, 200, 0.24)]),
    'meta:lane-5': historyOf([reading(NOW - 30 * MIN, 100, 0.30), reading(NOW, 200, 0.34)]),
    'meta:lane-7': historyOf([reading(NOW - 30 * MIN, 100, 0.18), reading(NOW, 200, 0.22)]),
    'meta:lane-8': historyOf([reading(NOW - 30 * MIN, 100, 0.24), reading(NOW, 1100, 0.25)]),
  };
  const scaledResult = calibrateAccounts({
    memberKeys: Object.keys(scaled), historyOf: k => scaled[k],
    groupBurnPerRunPct: 0.0004, runsBetween: () => 13, nowMs: NOW,
  });
  const s8 = scaledResult.get('meta:lane-8');
  assert.ok(s8.attemptedAttributedRuns >= 10);
  assert.equal(s8.source, 'group-prior');
  assert.equal(s8.rejectionReason, 'baseline-out-of-bounds');
  assert.ok(s8.attemptedBaseline / 0.0004 > 4);
});

test('healthy evidence still prices: enough runs and an agreeing baseline', () => {
  // Ten ledger runs per member: 400 requests over requestsPerRun 4 = 100
  // runs, baseline 0.0016 within 4x of the 0.004 prior.
  const mk = (burn) => historyOf([
    reading(NOW - 30 * MIN, 100, 0.10), reading(NOW, 500, 0.10 + burn),
  ]);
  const result = calibrateAccounts({
    memberKeys: ['a', 'b', 'large'], historyOf: k => mk(k === 'large' ? 0.01 : 0.04),
    groupBurnPerRunPct: 0.001, runsBetween: () => 300, nowMs: NOW,
  });
  const large = result.get('large');
  assert.equal(large.source, 'account-weekly');
  assert.equal(large.rejectionReason, null);
  assert.ok(large.attributedRuns >= 10);
  assert.ok(large.capacityWeight > 1);
});

test('incident replay: lane 8 slots stay within 25% of the pre-jump value', () => {
  // Pre-jump: lane 8 on the 0.0004 prior with 76% remaining over ~96h.
  const pre = computeConcurrencyTarget({
    accounts: [{ accountId: 'meta:lane-8', remainingPct: 0.76, hoursToReset: 96,
      burnPerRunPct: 0.0004, measuredBurnPerRunPct: 0.0004 }],
    meanRunDurationHours: 0.186,
  });
  // Post-fix replay: the rejected sample keeps the 0.0004 prior (75%
  // remaining after the quantum); without the guard the lane would price at
  // ~0.02 and collapse to ~2% of its slots.
  const fixed = incidentCalibrate().get('meta:lane-8');
  assert.equal(fixed.burnPerRunPct, 0.0004);
  const post = computeConcurrencyTarget({
    accounts: [{ accountId: 'meta:lane-8', remainingPct: 0.75, hoursToReset: 95.9,
      burnPerRunPct: 0.0004, measuredBurnPerRunPct: fixed.burnPerRunPct }],
    meanRunDurationHours: 0.186,
  });
  const preSlots = pre.perAccount[0].slots;
  const postSlots = post.perAccount[0].slots;
  assert.ok(Math.abs(postSlots - preSlots) / preSlots < 0.25,
    `slots ${postSlots} within 25% of pre-jump ${preSlots}`);
  // The guard is what holds the line: the unguarded baseline reprices 50x.
  assert.ok(fixed.attemptedBaseline / fixed.burnPerRunPct > 25);
});

test('capacity view names the source, the runs and the rejection reason per lane', async () => {
  const T0 = Date.parse('2026-10-22T09:00:00Z');
  const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
  const skey = stateKey => JSON.stringify({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey });
  const state = new Map();
  const jobs = new Map();
  const handlers = new Map();
  let now = T0;
  let step = 0;
  // Four Meta lanes sharing one model: lane 8 moves one quantum on tick 1
  // while two ledger runs face 400 counted requests, so its sample lands at
  // half a run and the guard holds it on the prior.
  const accounts = () => ['lane-4', 'lane-5', 'lane-7', 'lane-8'].map(k => ({
    lane: k, provider: 'meta', accountKey: k, health: 'healthy', models: ['muse-spark-1.3-contributor'],
    weekly: { used: (k === 'lane-8' ? 0.24 : 0.20) + (k === 'lane-8' ? step * 0.01 : 0),
      resetsAt: new Date(T0 + 96 * 3600000).toISOString() },
    fiveHour: { used: 0.1, resetsAt: new Date(T0 + 5 * 3600000).toISOString() },
    observedAt: new Date(now).toISOString(), quality: 'live',
    usage: { observedAt: new Date(now).toISOString(), epoch: 'keeper-1', requests: 100 + step * 100 },
  }));
  const config = { cliproxy: { laneKeySecretRef: SECRET }, reviewReserve: { enabled: false } };
  const io = {
    config: { get: async () => config },
    state: { get: async k => state.get(JSON.stringify(k)) ?? null, set: async (k, v) => state.set(JSON.stringify(k), v) },
    secrets: { resolve: async () => 'fixture' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness({ observedAt: new Date(now).toISOString(), accounts: accounts() }, now) }) },
    agents: { get: async () => ({ adapterType: 'claude-code' }) },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (k, fn) => jobs.set(k, fn) },
    events: { on: (k, fn) => handlers.set(k, fn) },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  await plugin.setup(io);
  state.set(skey('aa-snapshot-v1'), { fetchedAt: new Date(now).toISOString(), rows: [{ slug: 'muse-spark-1-3-xhigh',
    intelligenceIndex: 60, intelligenceIndexCostPerTask: 20, price1mInputTokens: 2, price1mOutputTokens: 8 }], duplicateSlugs: [] });
  await plugin.onConfigChanged(config, { companyId: 'acme' });
  const tick = async (i) => {
    now = T0 + i * 5 * MIN;
    step = i;
    if (i > 0) for (let n = 0; n < 2; n++) {
      await handlers.get('agent.run.started')({ companyId: 'acme', entityId: `lane8-${i}-${n}`,
        payload: { run: { agentId: 'eng', model: 'muse-spark-1.3-contributor' } },
        occurredAt: new Date(now - (n + 1) * 1000).toISOString() });
    }
    await jobs.get('shadow-tick')({});
    return (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body;
  };
  // Six ticks (30 min) let the pooled prior calibrate; two runs per tick keep
  // lane 8 under the attributed-runs floor throughout.
  let cap;
  for (let i = 0; i <= 6; i++) cap = await tick(i);
  const lane8 = cap.accounts.find(a => a.accountId === 'meta:lane-8');
  assert.equal(lane8.calibrationSource, 'group-prior');
  assert.equal(lane8.calibrationRejectionReason, 'low-attributed-runs');
  assert.ok(lane8.attemptedAttributedRuns != null && lane8.attemptedAttributedRuns < 10);
  assert.ok(lane8.unattributedRequestShare != null && lane8.unattributedRequestShare > 0.5);
  // The group carries the same request scale for the pool-level view.
  const group = Object.values(cap.calibrationGroups ?? {}).find(g => g.members === 4);
  assert.ok(group, 'pooled Meta group is reported');
  assert.ok(group.requestsPerRun > 0);
  assert.ok(group.unattributedRequestShare > 0.5);
});

test('guard rejection drops the stale individual estimate instead of carrying it', async () => {
  const T0 = Date.parse('2026-10-22T09:00:00Z');
  const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
  const skey = stateKey => JSON.stringify({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey });
  const state = new Map();
  const jobs = new Map();
  const handlers = new Map();
  let now = T0;
  let step = 0;
  // Same incident shape as the view test: lane 8 moves one quantum while two
  // ledger runs face 400 counted requests, so every sample is guard-rejected.
  const accounts = () => ['lane-4', 'lane-5', 'lane-7', 'lane-8'].map(k => ({
    lane: k, provider: 'meta', accountKey: k, health: 'healthy', models: ['muse-spark-1.3-contributor'],
    weekly: { used: (k === 'lane-8' ? 0.24 : 0.20) + (k === 'lane-8' ? step * 0.01 : 0),
      resetsAt: new Date(T0 + 96 * 3600000).toISOString() },
    fiveHour: { used: 0.1, resetsAt: new Date(T0 + 5 * 3600000).toISOString() },
    observedAt: new Date(now).toISOString(), quality: 'live',
    usage: { observedAt: new Date(now).toISOString(), epoch: 'keeper-1', requests: 100 + step * 100 },
  }));
  const config = { cliproxy: { laneKeySecretRef: SECRET }, reviewReserve: { enabled: false } };
  const io = {
    config: { get: async () => config },
    state: { get: async k => state.get(JSON.stringify(k)) ?? null, set: async (k, v) => state.set(JSON.stringify(k), v) },
    secrets: { resolve: async () => 'fixture' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness({ observedAt: new Date(now).toISOString(), accounts: accounts() }, now) }) },
    agents: { get: async () => ({ adapterType: 'claude-code' }) },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (k, fn) => jobs.set(k, fn) },
    events: { on: (k, fn) => handlers.set(k, fn) },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  await plugin.setup(io);
  state.set(skey('aa-snapshot-v1'), { fetchedAt: new Date(now).toISOString(), rows: [{ slug: 'muse-spark-1-3-xhigh',
    intelligenceIndex: 60, intelligenceIndexCostPerTask: 20, price1mInputTokens: 2, price1mOutputTokens: 8 }], duplicateSlugs: [] });
  await plugin.onConfigChanged(config, { companyId: 'acme' });
  const tick = async (i) => {
    now = T0 + i * 5 * MIN;
    step = i;
    if (i > 0) for (let n = 0; n < 2; n++) {
      await handlers.get('agent.run.started')({ companyId: 'acme', entityId: `lane8-carry-${i}-${n}`,
        payload: { run: { agentId: 'eng', model: 'muse-spark-1.3-contributor' } },
        occurredAt: new Date(now - (n + 1) * 1000).toISOString() });
    }
    await jobs.get('shadow-tick')({});
    return (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body;
  };
  for (let i = 0; i <= 6; i++) await tick(i);
  // Seed the incident estimate as the persisted individual knowledge: the same
  // epoch, fresh within the 6h stale window, so the old carry would keep it.
  const smooth = state.get(skey('smoothing-v1'));
  assert.ok(smooth, 'smoothing state persists after warmup ticks');
  state.set(skey('smoothing-v1'), {
    ...smooth,
    accountE: {
      ...(smooth.accountE ?? {}),
      'meta:lane-8': { source: 'account-weekly', burnPerRunPct: 0.0117, capacityWeight: 0.034,
        confidence: 0.25, attributedRuns: 0.51, groupMedianBurnPerRunPct: 0.0099,
        fiveHourBurnPerRunPct: null, rejectionReason: null,
        attemptedAttributedRuns: null, attemptedBaseline: null,
        epoch: 'keeper-1', atMs: now },
    },
  });
  const cap = await tick(7);
  const lane8 = cap.accounts.find(a => a.accountId === 'meta:lane-8');
  assert.equal(lane8.calibrationRejectionReason, 'low-attributed-runs');
  assert.equal(lane8.calibrationSource, 'group-prior');
  assert.ok(Math.abs(lane8.effectiveBurnPerRunPct - 0.0117) > 0.005,
    `rejected sample reprices off the prior, not the stale 0.0117 (got ${lane8.effectiveBurnPerRunPct})`);
  // The priced burn is the pooled prior, not the seeded individual estimate.
  assert.ok(Math.abs(lane8.effectiveBurnPerRunPct - lane8.groupMedianBurnPerRunPct) < 1e-9);
  // The stale estimate is not re-persisted: the next tick has nothing to carry.
  const after = state.get(skey('smoothing-v1'));
  assert.ok(!Object.hasOwn(after?.accountE ?? {}, 'meta:lane-8'), 'guard rejection clears the persisted estimate');
});
