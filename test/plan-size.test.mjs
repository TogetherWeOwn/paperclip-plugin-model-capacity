import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCalibrationGroups,
  pooledBurnPerRun,
  perAccountRawBurn,
  capacityWeights,
  boundBurnPerRun,
  PLAN_SIZE,
} from '../src/pools.mjs';
import { orderAccountsForRun } from '../src/select.mjs';
import { computeConcurrencyTarget } from '../src/concurrency.mjs';
import { createModelCapacityPlugin, orderCapacityWeight } from '../src/plugin.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

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

test('round-robin: skewed picks do not move even-split burns', () => {
  // True burns 0.001/0.00025 with N=40 round-robin runs (each lane burns 20):
  // deltas 0.02/0.005. Weighted spreading skews the hook picks 8/32, but the
  // meter still moves N/width per lane -- the even share recovers the true
  // burns whatever the picks are. Dividing by the pick count (the old bug)
  // reads 0.0025/0.000156 (2.5x/0.6x) and runs to the clamps.
  const keys = ['small', 'big'];
  const hists = new Map([
    ['small', history(0.24, 0.26, NOW - 60 * MIN, NOW)],
    ['big', history(0.10, 0.105, NOW - 60 * MIN, NOW)],
  ]);
  const picks = { small: 8, big: 32 };
  const groupRuns = 40;
  const raw = perAccountRawBurn({
    memberKeys: keys,
    historyOf: (k) => hists.get(k),
    spanMsOf: () => 60 * MIN,
    runsInSpanFor: () => groupRuns / keys.length,
    nowMs: NOW,
  });
  assert.ok(Math.abs(raw.get('small') - 0.001) < 1e-9, `small: ${raw.get('small')}`);
  assert.ok(Math.abs(raw.get('big') - 0.00025) < 1e-9, `big: ${raw.get('big')}`);
  // The old pick-count normalization drifts: pin that this test catches it.
  assert.equal(0.02 / picks.small, 0.0025);
  assert.ok((0.02 / picks.small) / 0.001 > 2, 'pick-count inflates the small lane');
  assert.ok((0.005 / picks.big) / 0.00025 < 0.7, 'pick-count deflates the big lane');
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

test('solo lanes keep their own burn: no cross-provider clamp', () => {
  // A single-member group's median is its own burn, so the group-median bound
  // is vacuous -- weight 1, burn unchanged. An expensive provider's lane
  // (0.01553, ~15x a 0.001 median elsewhere) is never clamped to 4x another
  // provider's median; burns are fractions of each lane's OWN weekly quota.
  const solo = boundBurnPerRun({ 'claude:lane': 0.01553 }, ['claude:lane']);
  assert.equal(solo.burns.get('claude:lane'), 0.01553);
  assert.equal(solo.weights.get('claude:lane'), 1);
  // A thin solo sample is still bounded only to its own group median
  // (vacuous for width 1), never to a cross-group reference.
  const thin = boundBurnPerRun({ 'codex:lane': 0.00001 }, ['codex:lane']);
  assert.equal(thin.burns.get('codex:lane'), 0.00001);
  assert.equal(thin.weights.get('codex:lane'), 1);
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

// Shadow-tick wiring: two Meta lanes sharing one model individualize to
// their own even-split burns (picks differ from burn: all 20 runs record on
// lane-1 while CLIProxy round-robins), solos keep their own meters with no
// cross-provider clamp, and every downstream surface (effectiveBurn,
// targetShare, C* slots, capacityWeight, persisted E_indiv) follows the
// individualized burn. A second phase with skewed enforced picks proves the
// even split holds while the picks move.
const PT0 = Date.parse('2026-10-10T12:00:00Z');
const PSECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const PAA_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
const paaRows = () => ([
  { slug: 'muse-spark-1-3-xhigh', intelligenceIndex: 60, intelligenceIndexCostPerTask: 20, price1mInputTokens: 2, price1mOutputTokens: 8 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 66, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
  { slug: 'gpt-oss-120b', intelligenceIndex: 33, intelligenceIndexCostPerTask: 4, price1mInputTokens: 0.1, price1mOutputTokens: 0.4 },
]);
const planLane = (o, now) => ({
  lane: o.lane, provider: o.provider, accountKey: o.key, health: o.health ?? 'healthy', models: o.models,
  weekly: { used: o.weekly, resetsAt: new Date(PT0 + 4 * 24 * 60 * MIN).toISOString() },
  fiveHour: { used: o.fiveHour ?? 0.1, resetsAt: new Date(now + 4 * 60 * MIN).toISOString() },
  observedAt: new Date(now).toISOString(), quality: 'live',
});
const planFleet = ({ now, small, big, claude, codex, guardSolos = false }) => ([
  planLane({ lane: 'meta-small', provider: 'meta', key: 'meta-small', models: ['muse-spark-1.3-contributor'], weekly: small }, now),
  planLane({ lane: 'meta-big', provider: 'meta', key: 'meta-big', models: ['muse-spark-1.3-contributor'], weekly: big }, now),
  planLane({ lane: 'claude-1', provider: 'claude', key: 'claude-1', models: ['claude-sonnet-5-5'], weekly: claude, fiveHour: guardSolos ? 0.9 : 0.1 }, now),
  planLane({ lane: 'codex-1', provider: 'codex', key: 'codex-1', models: ['gpt-5-3'], weekly: codex, fiveHour: guardSolos ? 0.9 : 0.1 }, now),
]);
const pStarted = (runId, atMs, agentId, model) => ({
  type: 'agent.run.started', companyId: 'acme', entityId: runId,
  payload: { run: { agentId, model } }, occurredAt: new Date(atMs).toISOString(),
});
const pFinished = (runId, atMs, agentId = 'eng') => ({
  type: 'agent.run.finished', companyId: 'acme', entityId: runId,
  payload: { run: { agentId } }, occurredAt: new Date(atMs).toISOString(),
});
const pHookParams = (runId) => ({
  runId, companyId: 'acme', agentId: 'eng', issueId: null,
  adapterType: 'claude-code', invocationSource: 'test', wakeReason: null,
  agentDefaultModel: null, previous: null, issueOverrideModel: null,
  deadlineMs: 1500,
});
function planDrive({ config = {} } = {}) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = (k) => JSON.stringify(k);
  let now = PT0;
  let accounts = [];
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: PSECRET } }) },
    state: { get: async (k) => store.get(skey(k)) ?? null, set: async (k, v) => { store.set(skey(k), v); } },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness({ observedAt: new Date(now).toISOString(), accounts }, now) }) },
    agents: { get: async () => ({ adapterType: 'claude-code' }) },
    issues: {
      get: async () => null,
      list: async ({ status } = {}) => (status === 'todo' ? [{ id: 'i1', assigneeAgentId: 'eng', status: 'todo' }] : []),
    },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return {
    store,
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(PAA_KEY), { fetchedAt: new Date(PT0).toISOString(), rows: paaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    step: async ({ at, fleet, fire = [] }) => {
      now = at;
      accounts = fleet;
      for (const e of fire) await handlers.get(e.type)(e);
      await jobs.get('shadow-tick')({});
    },
    hook: (runId) => plugin.onResolveRunModel(pHookParams(runId)),
    capacity: async () => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body,
    shadow: async () => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'shadow', query: { limit: 500 } })).body,
    setNow: (t) => { now = t; },
  };
}

test('plan-size shadow tick: even-split individualization drives shares, slots, weights and persists', async () => {
  const d = planDrive({ config: { enforce: true } });
  await d.setup();
  // 20 Meta runs (all record on lane-1 while the meter round-robins), 4
  // Claude runs (expensive solo, delta 0.062 over 4 runs = 0.0155/run) and 4
  // Codex runs (delta 0.004 over 4 runs = 0.001/run).
  const metaRuns = Array.from({ length: 20 }, (_, i) => `ps-${i}`);
  const claudeRuns = Array.from({ length: 4 }, (_, i) => `pc-${i}`);
  const codexRuns = Array.from({ length: 4 }, (_, i) => `px-${i}`);
  // Flat meters until the final reading so the first sample jumps at once
  // (no EWMA lag): T0 and T0+12 read the same, T0+24 carries the full delta.
  await d.step({
    at: PT0, fleet: planFleet({ now: PT0, small: 0.29, big: 0.2975, claude: 0.20, codex: 0.10 }),
  });
  await d.step({
    at: PT0 + 12 * MIN,
    fleet: planFleet({ now: PT0 + 12 * MIN, small: 0.29, big: 0.2975, claude: 0.20, codex: 0.10 }),
    fire: [
      ...metaRuns.map((id, i) => pStarted(id, PT0 + 1 * MIN + i * 30 * 1000, 'eng', 'muse-spark-1.3-contributor')),
      ...claudeRuns.map((id, i) => pStarted(id, PT0 + 2 * MIN + i * MIN, 'eng', 'claude-sonnet-5-5')),
      ...codexRuns.map((id, i) => pStarted(id, PT0 + 3 * MIN + i * MIN, 'eng', 'gpt-5-3')),
    ],
  });
  await d.step({
    at: PT0 + 24 * MIN,
    fleet: planFleet({ now: PT0 + 24 * MIN, small: 0.30, big: 0.30, claude: 0.262, codex: 0.104 }),
    fire: [
      ...metaRuns.map((id) => pFinished(id, PT0 + 24 * MIN)),
      ...claudeRuns.map((id) => pFinished(id, PT0 + 24 * MIN)),
      ...codexRuns.map((id) => pFinished(id, PT0 + 24 * MIN)),
    ],
  });
  const cap = await d.capacity();
  const byId = new Map(cap.accounts.map((a) => [a.accountId, a]));
  const small = byId.get('meta:meta-small');
  const big = byId.get('meta:meta-big');
  const claude = byId.get('claude:claude-1');
  const codex = byId.get('codex:codex-1');
  assert.ok(small && big && claude && codex, 'all four lanes present');
  // Same calibration group for the Meta pair, solos alone.
  assert.equal(small.calibrationGroup, big.calibrationGroup, 'meta pair shares one group');
  assert.notEqual(claude.calibrationGroup, small.calibrationGroup);
  // Even-split burns: 0.01/10 and 0.0025/10, whatever the recorded lane.
  // First sample jumps at once (no EWMA lag), so the figures are exact.
  assert.ok(small.burnIndividualized === true && big.burnIndividualized === true, 'both meta lanes individualized');
  assert.ok(Math.abs(small.effectiveBurnPerRunPct - 0.001) < 1e-9, `small burn ${small.effectiveBurnPerRunPct}`);
  assert.ok(Math.abs(big.effectiveBurnPerRunPct - 0.00025) < 1e-9, `big burn ${big.effectiveBurnPerRunPct}`);
  assert.ok(Math.abs((big.effectiveBurnPerRunPct / small.effectiveBurnPerRunPct) - 0.25) < 1e-9, 'big burns ~1/4 per run');
  // Weights: median/small ~1, median/big ~4 (median of [0.001, 0.00025] = 0.000625).
  assert.ok(Math.abs((small.capacityWeight ?? 1) - 0.625) < 0.15, `small weight ${small.capacityWeight}`);
  assert.ok(Math.abs((big.capacityWeight ?? 1) - 2.5) < 0.5, `big weight ${big.capacityWeight}`);
  assert.ok((big.capacityWeight ?? 0) > (small.capacityWeight ?? 0) * 3, 'big weighs ~4x small');
  // TargetShare and C* follow the individualized burn (~4x for the big lane).
  assert.ok(small.targetShare != null && big.targetShare != null);
  assert.ok((big.targetShare / small.targetShare) > 3 && (big.targetShare / small.targetShare) < 5, `share ratio ${big.targetShare}/${small.targetShare}`);
  const perAcc = new Map(cap.perAccount.map((r) => [r.accountId, r]));
  assert.ok(perAcc.get('meta:meta-big').slots / perAcc.get('meta:meta-small').slots > 3, 'C* slots ~4x for the big lane');
  assert.equal(perAcc.get('meta:meta-big').capacityWeight, big.capacityWeight, 'select view carries the weight');
  assert.equal(perAcc.get('meta:meta-big').burnIndividualized, true);
  // Solos keep their own meters: expensive Claude is never clamped to 4x the
  // cross-group median, and /capacity groups agree with per-account burns.
  assert.ok(Math.abs(claude.effectiveBurnPerRunPct - 0.0155) < 1e-9, `claude solo ${claude.effectiveBurnPerRunPct} keeps its own burn`);
  assert.ok(Math.abs(codex.effectiveBurnPerRunPct - 0.001) < 1e-9, `codex solo ${codex.effectiveBurnPerRunPct}`);
  const claudeGroup = cap.calibrationGroups[claude.calibrationGroup];
  assert.ok(claudeGroup, 'solo group reported');
  assert.ok(Math.abs((claudeGroup.burnPerRunPct ?? 0) - claude.effectiveBurnPerRunPct) < 1e-9, 'solo group burn matches per-account (no clamp contradiction)');
  // E_indiv persists in smoothing state (mutant c: dropping it must fail).
  const smoothing = d.store.get(JSON.stringify({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'smoothing-v1' }));
  assert.ok(smoothing && smoothing.E_indiv && smoothing.E_indiv['meta:meta-big'] != null, 'E_indiv carried over');
  assert.ok(Math.abs(smoothing.E_indiv['meta:meta-big'].value - 0.00025) < 1e-9, 'persisted big E_indiv');
  // Carry-over tick with flat meters and no new runs keeps the wiring.
  await d.step({
    at: PT0 + 30 * MIN,
    fleet: planFleet({ now: PT0 + 30 * MIN, small: 0.30, big: 0.30, claude: 0.262, codex: 0.104 }),
  });
  const cap2 = await d.capacity();
  const byId2 = new Map(cap2.accounts.map((a) => [a.accountId, a]));
  assert.equal(byId2.get('meta:meta-big').burnIndividualized, true, 'E_indiv survives a flat tick');
  assert.ok(Math.abs(byId2.get('meta:meta-big').effectiveBurnPerRunPct - 0.00025) / 0.00025 < 0.1, 'flat tick keeps big burn');
  // Skewed enforced picks must not move the even-split burns: guard the solos
  // so hook decisions land on the Meta pair, with meters reflecting
  // round-robin actual burn (each lane burns N/width=15 runs: total deltas
  // 0.015/0.00375 over 30 group runs). Old pick-count logic reads
  // 0.015/12 and 0.00375/18 (1.25x/0.83x) once the 10 picks skew 2/8.
  const skewRuns = Array.from({ length: 10 }, (_, i) => `ps2-${i}`);
  await d.step({
    at: PT0 + 36 * MIN,
    fleet: planFleet({ now: PT0 + 36 * MIN, small: 0.305, big: 0.30125, claude: 0.262, codex: 0.104, guardSolos: true }),
    fire: skewRuns.map((id) => pStarted(id, PT0 + 36 * MIN, 'eng', 'muse-spark-1.3-contributor')),
  });
  for (const id of skewRuns) {
    const out = await d.hook(id);
    assert.equal(out.kind, 'decide', `hook decides ${id}`);
  }
  await d.step({
    at: PT0 + 37 * MIN,
    fleet: planFleet({ now: PT0 + 37 * MIN, small: 0.305, big: 0.30125, claude: 0.262, codex: 0.104, guardSolos: true }),
  });
  const cap3 = await d.capacity();
  const byId3 = new Map(cap3.accounts.map((a) => [a.accountId, a]));
  const small3 = byId3.get('meta:meta-small');
  const big3 = byId3.get('meta:meta-big');
  // Tight enough to fail the old pick-count wiring (6%/4% drift) while the
  // even split holds (samples equal prev, so smoothing holds exact).
  assert.ok(Math.abs(small3.effectiveBurnPerRunPct - 0.001) / 0.001 < 0.02, `skewed picks keep small burn ${small3.effectiveBurnPerRunPct}`);
  assert.ok(Math.abs(big3.effectiveBurnPerRunPct - 0.00025) / 0.00025 < 0.02, `skewed picks keep big burn ${big3.effectiveBurnPerRunPct}`);
  // Hook decisions land on the Meta pair (solos guarded). The weighted ~4x
  // spread itself is pinned by the demand-free test below, where need ties
  // and the weight is the decider (here demand bands dominate, so the split
  // is not weight-sensitive).
  const shadow = await d.shadow();
  const byRun = new Map((shadow.entries ?? []).map((e) => [e.runId, e]));
  const picks = skewRuns.map((id) => byRun.get(id)?.accountId);
  assert.equal(
    picks.filter((a) => a === 'meta:meta-big' || a === 'meta:meta-small').length,
    skewRuns.length,
    `all skew picks land on the meta pair: ${picks.join(',')}`,
  );
});

test('unhealthy lane out of rotation does not inflate live lanes burn', async () => {
  // 3 uniform Meta lanes, true burn 0.001/run, 30 runs over 24 min, meta-c
  // unhealthy with a flat meter. Live lanes each burn N/W_active = 15 runs
  // (deltas 0.015); dividing by N/W = 10 reads 0.0015 (1.5x), dividing by
  // the live width restores 0.001.
  const trioFleet = ({ now, a, b, c, cHealth = 'unhealthy' }) => ([
    planLane({ lane: 'meta-a', provider: 'meta', key: 'meta-a', models: ['muse-spark-1.3-contributor'], weekly: a }, now),
    planLane({ lane: 'meta-b', provider: 'meta', key: 'meta-b', models: ['muse-spark-1.3-contributor'], weekly: b }, now),
    planLane({ lane: 'meta-c', provider: 'meta', key: 'meta-c', health: cHealth, models: ['muse-spark-1.3-contributor'], weekly: c }, now),
  ]);
  const d = planDrive({ config: { enforce: true } });
  await d.setup();
  const runs = Array.from({ length: 30 }, (_, i) => `tu-${i}`);
  await d.step({ at: PT0, fleet: trioFleet({ now: PT0, a: 0.29, b: 0.29, c: 0.29 }) });
  await d.step({
    at: PT0 + 12 * MIN,
    fleet: trioFleet({ now: PT0 + 12 * MIN, a: 0.29, b: 0.29, c: 0.29 }),
    fire: runs.map((id, i) => pStarted(id, PT0 + 1 * MIN + i * 20 * 1000, 'eng', 'muse-spark-1.3-contributor')),
  });
  await d.step({
    at: PT0 + 24 * MIN,
    fleet: trioFleet({ now: PT0 + 24 * MIN, a: 0.305, b: 0.305, c: 0.29 }),
    fire: runs.map((id) => pFinished(id, PT0 + 24 * MIN)),
  });
  const cap = await d.capacity();
  const byId = new Map(cap.accounts.map((a) => [a.accountId, a]));
  const a = byId.get('meta:meta-a');
  const b = byId.get('meta:meta-b');
  const c = byId.get('meta:meta-c');
  assert.ok(a && b && c, 'all three lanes present');
  assert.equal(a.calibrationGroup, b.calibrationGroup, 'trio shares one group');
  assert.equal(c.calibrationGroup, a.calibrationGroup, 'down lane in same group');
  assert.ok(a.burnIndividualized === true && b.burnIndividualized === true, 'live lanes individualized');
  assert.ok(Math.abs(a.effectiveBurnPerRunPct - 0.001) < 1e-9, `live lane a burn ${a.effectiveBurnPerRunPct} (bug reads 0.0015)`);
  assert.ok(Math.abs(b.effectiveBurnPerRunPct - 0.001) < 1e-9, `live lane b burn ${b.effectiveBurnPerRunPct} (bug reads 0.0015)`);
  // Down lane has no delta: inherits the pooled group figure, never an
  // inflated per-lane figure.
  assert.ok(c.burnIndividualized !== true, 'flat down lane does not individualize');
});

test('orderCapacityWeight passes the lane weight through (call-site pin)', async () => {
  // Both orderAccountsWithPacing call sites in plugin.mjs (the tick shadow
  // path and the hook live view) must pass the lane's capacityWeight through
  // -- forcing either input to `capacityWeight: 1` spreads picks evenly
  // instead of ~4x to a 4x plan. The helper is the single place the default
  // lives; mutating it to return 1 fails the assertions below, and bypassing
  // it at either call site fails the source pin.
  assert.equal(orderCapacityWeight({ capacityWeight: 2.5 }), 2.5);
  assert.equal(orderCapacityWeight({ capacityWeight: 0.625 }), 0.625);
  assert.equal(orderCapacityWeight({}), 1, 'absent reads as 1');
  assert.equal(orderCapacityWeight(null), 1, 'null reads as 1');
  assert.equal(orderCapacityWeight({ capacityWeight: null }), 1, 'null weight reads as 1');
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/plugin.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('capacityWeight: orderCapacityWeight(v)'), 'tick shadow path uses the helper');
  assert.ok(src.includes('capacityWeight: orderCapacityWeight(view)'), 'hook live view uses the helper');
});

test('plugin weights spread lane selection ~4x when need ties', async () => {
  // End-to-end contract for the call-site wiring: calibrate the Meta pair
  // (small 0.001, big 0.00025, weights ~0.625/~2.5), then feed those REAL
  // plugin weights into orderAccountsForRun with tied need (same band,
  // same pool, null rates) so the weight-normalized lane load decides. With
  // the plugin weights the picks spread ~8/2; with the call-site mutant
  // (`capacityWeight: 1`) they spread ~evenly -- so this fails the mutant
  // while the unit test above pins the helper itself.
  const d = planDrive({ config: { enforce: true } });
  await d.setup();
  const metaRuns = Array.from({ length: 20 }, (_, i) => `pw-${i}`);
  await d.step({
    at: PT0, fleet: planFleet({ now: PT0, small: 0.29, big: 0.2975, claude: 0.20, codex: 0.10 }),
  });
  await d.step({
    at: PT0 + 12 * MIN,
    fleet: planFleet({ now: PT0 + 12 * MIN, small: 0.29, big: 0.2975, claude: 0.20, codex: 0.10 }),
    fire: metaRuns.map((id, i) => pStarted(id, PT0 + 1 * MIN + i * 30 * 1000, 'eng', 'muse-spark-1.3-contributor')),
  });
  await d.step({
    at: PT0 + 24 * MIN,
    fleet: planFleet({ now: PT0 + 24 * MIN, small: 0.30, big: 0.30, claude: 0.20, codex: 0.10 }),
    fire: metaRuns.map((id) => pFinished(id, PT0 + 24 * MIN)),
  });
  const cap = await d.capacity();
  const byId = new Map(cap.accounts.map((a) => [a.accountId, a]));
  const small = byId.get('meta:meta-small');
  const big = byId.get('meta:meta-big');
  assert.ok(small && big, 'meta pair present');
  const wSmall = orderCapacityWeight(small);
  const wBig = orderCapacityWeight(big);
  assert.ok(Math.abs(wSmall - 0.625) < 0.15, `small weight ${wSmall}`);
  assert.ok(Math.abs(wBig - 2.5) < 0.5, `big weight ${wBig}`);
  // Tied need: same pool, null rates (band 0, deficit 0), high headroom, so
  // only the weight-normalized lane load orders the pair.
  const tiedView = (id, weight, laneInFlight) => ({
    accountId: id, pool: 'meta', targetShare: 10, inFlight: 0, laneInFlight,
    capacityWeight: weight, health: 'healthy', headroomPct: 0.9,
    measuredRatePerHour: null, requiredRatePerHour: null,
  });
  const spread = (wS, wB) => {
    const load = { small: 0, big: 0 };
    for (let i = 0; i < 10; i++) {
      const [w] = orderAccountsForRun([
        tiedView('meta:meta-small', wS, load.small),
        tiedView('meta:meta-big', wB, load.big),
      ], {});
      if (w.accountId === 'meta:meta-big') load.big += 1; else load.small += 1;
    }
    return load;
  };
  const weighted = spread(wSmall, wBig);
  assert.ok(weighted.big >= 7 && weighted.small <= 3, `plugin weights spread ~4x: ${JSON.stringify(weighted)}`);
  const unweighted = spread(1, 1);
  assert.ok(Math.abs(unweighted.big - unweighted.small) <= 2, `forced 1 spreads evenly: ${JSON.stringify(unweighted)}`);
  assert.ok(weighted.big - weighted.small >= 4, 'weight is the decider, not a tie-break');
});
