/**
 * Tick-level arm-aware calibration: an expensive-to-cheap arm switch must
 * reprice the pool within one tick of ledger evidence (C2) and segment
 * old-mix estimates at once without dropping a calibrated pool (C3), while
 * run-count noise around even mixes segments nothing (hysteresis).
 *
 * Drives the real shadow tick end to end (not the pure helpers). Phases are
 * >60min apart so the 60-minute run-mix window isolates each phase, while
 * Keeper counters stay monotonic so counter spans bridge phases the way
 * production windows do. Meter movement reflects arm burn: cheap runs move
 * meters ~7x less than expensive runs, and the cost anchors say the same
 * (AA costs 70 vs 10), so the anchor prior reprices an unmeasured cheap arm
 * on the first switch tick with no new meter sample.
 *
 * Runs fire in the minutes BEFORE each tick instant: spans ending at the tick
 * then contain the phase's runs (a run stamped exactly at the tick instant
 * falls outside `at <= toMs` and halves the run count).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const T0 = Date.parse('2026-10-16T12:00:00Z');
const MIN = 60 * 1000;
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_SKEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
const aaRows = () => ([
  { slug: 'muse-spark-1-3-xhigh', intelligenceIndex: 60, intelligenceIndexCostPerTask: 10, price1mInputTokens: 2, price1mOutputTokens: 8 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 66, intelligenceIndexCostPerTask: 70, price1mInputTokens: 3, price1mOutputTokens: 15 },
  // Reference arm for cost anchors (the plugin prices anchor burn off this
  // row; without it every anchor is null and the prior path stays dark).
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 5, price1mInputTokens: 1, price1mOutputTokens: 4 },
]);

const EXPENSIVE = 'claude-sonnet-5-5';
const CHEAP = 'muse-spark-1.3-contributor';

const lane = (o, now) => ({
  lane: o.lane, provider: 'meta', accountKey: o.lane, health: 'healthy', models: o.models,
  weekly: { used: o.weekly, resetsAt: new Date(T0 + 4 * 24 * 60 * MIN).toISOString() },
  fiveHour: { used: 0.1, resetsAt: new Date(now + 4 * 60 * MIN).toISOString() },
  observedAt: new Date(now).toISOString(), quality: 'live',
  usage: { observedAt: new Date(now).toISOString(), epoch: 'keeper-1', requests: o.requests },
});

const startedEvt = (runId, atMs, agentId, model, provider = null) => ({
  type: 'agent.run.started', companyId: 'acme', entityId: runId,
  payload: { run: { agentId, model, ...(provider ? { provider } : {}) } },
  occurredAt: new Date(atMs).toISOString(),
});
// Runs land in the minutes before the tick instant so in-tick spans count them.
const runsFor = (prefix, model, atMs, n, provider = null) =>
  Array.from({ length: n }, (_, i) => startedEvt(`${prefix}-${i}`, atMs - (n - i) * MIN, 'eng', model, provider));

function drive() {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = T0;
  let accounts = [];
  const config = {
    cliproxy: { laneKeySecretRef: SECRET },
    reviewReserve: { enabled: false },
  };
  const io = {
    config: { get: async () => ({ ...config }) },
    state: { get: async k => store.get(skey(k)) ?? null, set: async (k, v) => { store.set(skey(k), v); } },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness({ observedAt: new Date(now).toISOString(), accounts }, now) }) },
    agents: { get: async () => ({ adapterType: 'claude-code' }) },
    issues: { list: async () => [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return {
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_SKEY), { fetchedAt: new Date(T0).toISOString(), rows: aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    step: async ({ at, lanes, fire = [] }) => {
      now = at;
      accounts = lanes.map(l => lane(l, now));
      for (const e of fire) await handlers.get(e.type)(e);
      await jobs.get('shadow-tick')({});
    },
    // Fire run events at `at` with no tick: the live view published by the
    // previous tick is still fresh, so the event-time shadow path decides.
    fireAt: async (at, events) => {
      now = at;
      for (const e of events) await handlers.get(e.type)(e);
    },
    capacity: async () => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body,
    shadow: async () => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'shadow' })).body,
  };
}

const metaGroup = (cap) => {
  const rows = cap.perAccount.filter(a => a.accountId.startsWith('meta:'));
  const gid = rows[0].calibrationGroup;
  assert.ok(rows.every(r => r.calibrationGroup === gid), 'one meta group');
  return { rows, gid, group: cap.calibrationGroups[gid] };
};
const meanMeasured = (rows) => rows.reduce((s, r) => s + r.measuredBurnPerRunPct, 0) / rows.length;
const meanSlots = (rows) => rows.reduce((s, r) => s + r.slots, 0) / rows.length;

// Requests stay monotonic across the whole scenario (Keeper counters only
// move forward); `req` is the absolute counter value at each tick.
const Lanes = {
  exp: (weekly, req) => ([
    { lane: 'meta-lane-1', weekly, models: [EXPENSIVE], requests: req },
    { lane: 'meta-lane-2', weekly, models: [EXPENSIVE], requests: req },
  ]),
  cheap: (weekly, req) => ([
    { lane: 'meta-lane-1', weekly, models: [CHEAP], requests: req },
    { lane: 'meta-lane-2', weekly, models: [CHEAP], requests: req },
  ]),
  both: (weekly, req) => ([
    { lane: 'meta-lane-1', weekly, models: [EXPENSIVE, CHEAP], requests: req },
    { lane: 'meta-lane-2', weekly, models: [EXPENSIVE, CHEAP], requests: req },
  ]),
};

test('expensive-to-cheap switch reprices within one tick and segments old-mix estimates', async () => {
  const d = drive();
  await d.setup();
  // Phase 1: expensive arm only, meters moving +0.04/tick/lane.
  await d.step({ at: T0, lanes: Lanes.exp(0.24, 100) });
  await d.step({ at: T0 + 12 * MIN, lanes: Lanes.exp(0.28, 200), fire: runsFor('exp1', EXPENSIVE, T0 + 12 * MIN, 12) });
  await d.step({ at: T0 + 24 * MIN, lanes: Lanes.exp(0.32, 300), fire: runsFor('exp2', EXPENSIVE, T0 + 24 * MIN, 12) });
  let cap = await d.capacity();
  let { rows, group } = metaGroup(cap);
  assert.ok(group.dominantArm != null && group.dominantArm.includes('sonnet'), `phase-1 dom keys the executed arm: ${group.dominantArm}`);
  assert.equal(rows.every(r => r.calibrated), true, 'phase-1 pool calibrated');
  const E1 = meanMeasured(rows);
  const slots1 = meanSlots(rows);
  assert.ok(E1 > 0 && slots1 >= 0, 'phase-1 burn and slots read out');

  // Phase 2 (SWITCH): cheap arm only. Cheap runs move meters +0.012/tick/lane
  // (~1 quantum: 12 runs at ~1/7th the expensive burn). The first switch tick
  // carries ledger evidence but no fresh pooled sample yet, so the anchor
  // prior (7x cheaper) must reprice the unmeasured cheap arm at once.
  const t3 = T0 + 99 * MIN;
  await d.step({ at: t3, lanes: Lanes.cheap(0.332, 400), fire: runsFor('cheap1', CHEAP, t3, 12) });
  cap = await d.capacity();
  ({ rows, group } = metaGroup(cap));
  assert.equal(group.armMixReset, true, 'switch tick segments the old mix');
  assert.ok(group.dominantArm != null && group.dominantArm.includes('spark'), `switch-tick dom keys the cheap arm: ${group.dominantArm}`);
  assert.equal(rows.every(r => r.calibrated), true, 'switch tick keeps the pool calibrated (no uncalibrated drop)');
  const E3 = meanMeasured(rows);
  assert.ok(E3 < E1 * 0.75, `burn reprices within one tick of ledger evidence: ${E1} -> ${E3}`);
  assert.ok(meanSlots(rows) > slots1 * 2, `slots rise within one tick: ${slots1} -> ${meanSlots(rows)}`);
  // Counter-backed lanes track the mix-priced group instead of waiting out
  // the 90-minute counter window.
  for (const r of rows) {
    const ratio = r.measuredBurnPerRunPct / group.burnPerRunPct;
    assert.ok(ratio > 0.5 && ratio < 2, `${r.accountId} tracks the mix price: ${r.measuredBurnPerRunPct} vs ${group.burnPerRunPct}`);
  }

  // Meters keep moving on the cheap arm: the pool converges and holds.
  await d.step({ at: t3 + 12 * MIN, lanes: Lanes.cheap(0.344, 500), fire: runsFor('cheap2', CHEAP, t3 + 12 * MIN, 12) });
  await d.step({ at: t3 + 24 * MIN, lanes: Lanes.cheap(0.356, 600), fire: runsFor('cheap3', CHEAP, t3 + 24 * MIN, 12) });
  cap = await d.capacity();
  ({ rows, group } = metaGroup(cap));
  assert.equal(rows.every(r => r.calibrated), true, 'pool stays calibrated on the cheap arm');
  const E5 = meanMeasured(rows);
  assert.ok(E5 < E1 * 0.75, `cheap price holds: ${E1} -> ${E5}`);

  // Phase 3: cheap arm, FLAT meters -> the cheap price persists with no new
  // quanta and no reset flapping.
  const t6 = t3 + 99 * MIN;
  await d.step({ at: t6, lanes: Lanes.cheap(0.356, 700) });
  await d.step({ at: t6 + 12 * MIN, lanes: Lanes.cheap(0.356, 800), fire: runsFor('cheap4', CHEAP, t6 + 12 * MIN, 12) });
  cap = await d.capacity();
  ({ rows, group } = metaGroup(cap));
  assert.equal(rows.every(r => r.calibrated), true, 'flat-meter ticks stay calibrated');
  assert.equal(group.armMixReset, false, 'no reset without a mix change');
  const E7 = meanMeasured(rows);
  assert.ok(Math.abs(E7 - E5) / E5 < 0.5, `cheap price persists without meter quanta: ${E5} -> ${E7}`);
});

test('counter-lane rebase persists until the counter window rolls past the switch', async () => {
  // Overlapping windows: the switch lands 70min after the last expensive
  // phase so the 60-minute run-mix window isolates the cheap arm while the
  // 90-minute Keeper counter window still spans old-mix runs. The rebase must
  // hold on the tick AFTER the switch, not just the switch tick.
  const d = drive();
  await d.setup();
  await d.step({ at: T0, lanes: Lanes.exp(0.24, 100) });
  await d.step({ at: T0 + 12 * MIN, lanes: Lanes.exp(0.28, 200), fire: runsFor('exp1', EXPENSIVE, T0 + 12 * MIN, 12) });
  await d.step({ at: T0 + 24 * MIN, lanes: Lanes.exp(0.32, 300), fire: runsFor('exp2', EXPENSIVE, T0 + 24 * MIN, 12) });
  let cap = await d.capacity();
  let { rows } = metaGroup(cap);
  const E1 = meanMeasured(rows);

  const t3 = T0 + 94 * MIN;
  await d.step({ at: t3, lanes: Lanes.cheap(0.332, 400), fire: runsFor('cheap1', CHEAP, t3, 12) });
  cap = await d.capacity();
  let g = metaGroup(cap);
  assert.equal(g.group.armMixReset, true, 'switch tick segments the old mix');
  const switchSlots = meanSlots(g.rows);
  for (const r of g.rows) {
    const ratio = r.measuredBurnPerRunPct / g.group.burnPerRunPct;
    assert.ok(ratio > 0.5 && ratio < 2, `switch tick ${r.accountId} tracks the mix price`);
  }

  // Next tick, 12 minutes later: the counter window still spans the expensive
  // phase, so a one-tick rebase would snap back to the old-mix value here.
  await d.step({ at: t3 + 12 * MIN, lanes: Lanes.cheap(0.344, 500), fire: runsFor('cheap2', CHEAP, t3 + 12 * MIN, 12) });
  cap = await d.capacity();
  g = metaGroup(cap);
  assert.ok(E1 > 0, 'phase-1 burn reads out');
  for (const r of g.rows) {
    const ratio = r.measuredBurnPerRunPct / g.group.burnPerRunPct;
    assert.ok(ratio > 0.5 && ratio < 2,
      `tick-after-switch ${r.accountId} still tracks the mix price: ${r.measuredBurnPerRunPct} vs ${g.group.burnPerRunPct}`);
  }
  // No snap back to the old-mix window value: the pool stays repriced cheap
  // (meter quanta add noise, so slots may swing -- but they must not collapse
  // to the ~20% level the one-tick bug produced).
  const Enext = meanMeasured(g.rows);
  assert.ok(Enext < E1 * 0.75, `pool stays repriced the tick after the switch: ${E1} -> ${Enext}`);
  assert.ok(meanSlots(g.rows) > switchSlots * 0.4,
    `slots hold the tick after the switch: ${switchSlots} -> ${meanSlots(g.rows)}`);
});

test('near-even mix does not flap the epoch or reset smoothing', async () => {
  const d = drive();
  await d.setup();
  await d.step({ at: T0, lanes: Lanes.cheap(0.24, 100) });
  await d.step({ at: T0 + 12 * MIN, lanes: Lanes.cheap(0.252, 200), fire: runsFor('cheap1', CHEAP, T0 + 12 * MIN, 12) });
  await d.step({ at: T0 + 24 * MIN, lanes: Lanes.cheap(0.264, 300), fire: runsFor('cheap2', CHEAP, T0 + 24 * MIN, 12) });
  let cap = await d.capacity();
  const prev = metaGroup(cap).group;
  assert.ok(prev.dominantArm != null && prev.dominantArm.includes('spark'), `cheap dom first: ${prev.dominantArm}`);
  // 6 expensive vs 5 cheap: the dominant arm tips but holds only a 55% share
  // (run-count noise, not an arm switch) -> no segmentation.
  const t3 = T0 + 99 * MIN;
  await d.step({
    at: t3, lanes: Lanes.both(0.264, 400),
    fire: [...runsFor('mix-e', EXPENSIVE, t3, 6), ...runsFor('mix-c', CHEAP, t3 + 6 * MIN, 5)],
  });
  cap = await d.capacity();
  const { rows, group } = metaGroup(cap);
  assert.equal(group.armMixReset, false, 'near-even mix does not segment');
  assert.equal(rows.every(r => r.calibrated), true, 'no uncalibrated drop on noise');
});

test('burn attributes to the executed model, not a shadow routing guess', async () => {
  const d = drive();
  await d.setup();
  // No lane serves the expensive model: routing can only guess the cheap arm
  // while every run actually executes expensive. Runs fire 60s after the
  // setup tick so the live view is fresh and the event-time shadow path
  // records its (mismatched) guess before the next tick backfills reality.
  const lanes = (weekly, req) => ([
    { lane: 'meta-lane-1', weekly, models: [CHEAP], requests: req },
    { lane: 'meta-lane-2', weekly, models: [CHEAP], requests: req },
  ]);
  await d.step({ at: T0, lanes: lanes(0.24, 100) });
  const t1 = T0 + 12 * MIN;
  const fired = Array.from({ length: 12 }, (_, i) =>
    startedEvt(`real-exp-${i}`, T0 + 60 * 1000 + i * 1000, 'eng', EXPENSIVE, 'meta'));
  await d.fireAt(T0 + 60 * 1000, fired);
  await d.step({ at: t1, lanes: lanes(0.24, 100) });
  const cap = await d.capacity();
  const { group } = metaGroup(cap);
  assert.equal(group.dominantArm, 'claude-sonnet-5-5:max', `mix follows the executed model: ${group.dominantArm}`);
  assert.deepEqual(group.armBurnPerRunPct ?? {}, {}, 'no burn attributed to the guessed arm');
  // The trap was really set: the shadow view carries cheap-arm guesses for
  // runs that executed expensive.
  const shadow = await d.shadow();
  const entries = JSON.stringify(shadow);
  assert.ok(entries.includes('spark'), `shadow holds the mismatched guess: ${entries.slice(0, 300)}`);
});
