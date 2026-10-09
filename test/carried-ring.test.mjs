import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';

// Startup/upgrade reconciliation: ring entries carried in persisted state
// (older versions, missed terminal events, pre-install runs) count only
// when their run is verifiably non-terminal in the current feed.
// Unverifiable entries count 0. Entries decided live by this worker are
// trusted. Fails on pre-fix code (ghosts inflate the pools).

const TICK = Date.parse('2026-10-08T23:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
const RING_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'shadow-ring-v1' };
const RUNS_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'runs-v1' };

const aaRow = (slug, extra = {}) => ({
  slug, intelligenceIndex: 55, intelligenceIndexCostPerTask: 10,
  price1mInputTokens: 1, price1mOutputTokens: 4, ...extra,
});
const baseAa = () => ([
  aaRow('claude-opus-5-5'),
  aaRow('claude-sonnet-5-5-high'),
  aaRow('claude-haiku-5-5-xhigh'),
  aaRow('claude-haiku-5-5'),
  aaRow('kimi-k3'),
  aaRow('gemini-2-5-flash'),
]);

const kimiLane = (key) => ({
  lane: `kimi-${key}`, provider: 'kimi', accountKey: key,
  health: 'healthy', meter: 'reactive', pool: null,
  models: ['kimi-k3-256k'],
  weekly: { used: null, resetsAt: null },
  fiveHour: { used: null, resetsAt: null },
  observedAt: '2026-10-08T22:59:00Z', quality: 'reactive',
});

const ringEntry = (runId, at) => ({
  runId, agentId: 'agent-9',
  wouldModel: 'kimi-k3-256k(default)',
  account: 'kimi:k1', accountId: 'kimi:k1', rung: 0,
  trial: false, family: 'kimi', reason: 'seed', at,
});

function drive({ config = {}, laneAccounts = [], agentGets = {}, aa = baseAa(), ringSeed = null, runsSeed = null }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = TICK;
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET, ...(config.cliproxy ?? {}) } }) },
    state: {
      get: async k => store.get(skey(k)) ?? null,
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => ({ observedAt: new Date(now).toISOString(), accounts: laneAccounts }) }) },
    agents: { get: async (arg) => agentGets[arg?.agentId] ?? null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now });
  return {
    setNow: (ms) => { now = ms; },
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: aa, duplicateSlugs: [] });
      if (ringSeed) store.set(skey(RING_STATE_KEY), ringSeed);
      if (runsSeed) store.set(skey(RUNS_STATE_KEY), runsSeed);
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: () => jobs.get('shadow-tick')({}),
    hook: (runId, extra = {}) => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId: 'agent-9', issueId: null,
      adapterType: null, invocationSource: 'test', wakeReason: null,
      agentDefaultModel: null, previous: null, issueOverrideModel: null,
      deadlineMs: 1500, ...extra,
    }),
    fire: (e) => handlers.get(e.type)(e),
    api: (routeKey) => plugin.onApiRequest({ companyId: 'acme', routeKey }),
  };
}

const started = (runId, atMs) => ({
  type: 'agent.run.started', companyId: 'acme', entityId: runId,
  payload: { run: { agentId: 'agent-9', adapterType: 'claude-code' } },
  occurredAt: new Date(atMs).toISOString(),
});

test('carried ghosts verify against the feed or count 0', async () => {
  // Simulates a worker starting with persisted ring state from an older
  // version: three ghost entries (fresh, R4-aged, ancient) plus one entry
  // for a run the persisted feed still shows as running. Pre-fix the two
  // horizon-fresh ghosts inflate the pools (stale filter keeps them, clamp
  // bound includes them); post-fix only the verifiable run counts.
  const d = drive({
    laneAccounts: [kimiLane('k1')],
    ringSeed: [
      ringEntry('ghost-recent', TICK - 30 * 60000),
      ringEntry('ghost-mid', TICK - 70 * 60000),
      ringEntry('ghost-ancient', TICK - 3 * 3600000),
      ringEntry('run-live', TICK - 30 * 60000),
    ],
    runsSeed: [
      { runId: 'run-live', agentId: 'agent-9', status: 'running', at: TICK - 30 * 60000 },
    ],
  });
  await d.setup();
  await d.tick();
  const capacity = await d.api('capacity');
  assert.deepEqual(capacity.body.inFlightByPool, { kimi: 1 });
  assert.deepEqual(capacity.body.inFlightByAccount, { 'kimi:k1': 1 });
  assert.equal(capacity.body.reconciledRingDropped, 3);
  assert.equal(capacity.body.staleInFlightDropped, 0);
  assert.equal(capacity.body.clampedInFlightDropped, 0);
  const shadow = await d.api('shadow');
  const ids = shadow.body.entries.map(e => e.runId);
  assert.ok(ids.includes('run-live'));
  assert.ok(!ids.includes('ghost-recent') && !ids.includes('ghost-mid') && !ids.includes('ghost-ancient'));
  // Reconciliation runs once: the next tick reports zero and counts hold.
  await d.tick();
  const again = await d.api('capacity');
  assert.equal(again.body.reconciledRingDropped, 0);
  assert.deepEqual(again.body.inFlightByAccount, { 'kimi:k1': 1 });
});

test('entries decided live by this worker are trusted, not reconciled away', async () => {
  const d = drive({
    config: { enforce: true, trials: { maxInFlightPerFamily: 10 } },
    laneAccounts: [kimiLane('k1')],
    agentGets: { 'agent-9': { adapterType: 'claude-code' } },
  });
  await d.setup();
  await d.tick();
  const out = await d.hook('run-a', { adapterType: 'claude-code' });
  assert.equal(out.kind, 'decide');
  await d.fire(started('run-a', TICK + 1000));
  await d.tick();
  const capacity = await d.api('capacity');
  assert.deepEqual(capacity.body.inFlightByAccount, { 'kimi:k1': 1 });
  assert.equal(capacity.body.reconciledRingDropped, 0);
});
