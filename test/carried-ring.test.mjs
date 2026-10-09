import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';

// Startup/upgrade reconciliation under the ledger: legacy persisted runs and
// shadow-ring entries migrate into one record per runId. Restart reconcile
// only marks anchor-less or horizon-old records `unverified` (excluded from
// counting) -- it NEVER deletes. The per-tick persist trim DOES delete,
// but only dead weight (old terminal, old unverified, stale-horizon), so the
// persisted blob stays bounded while live shadow history, enforced flags,
// and terminal history survive restarts intact.

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

const ringEntry = (runId, at, extra = {}) => ({
  runId, agentId: 'agent-9',
  wouldModel: 'kimi-k3-256k(default)',
  account: 'kimi:k1', accountId: 'kimi:k1', rung: 0,
  trial: false, family: 'kimi', reason: 'seed', at, ...extra,
});

function drive({ config = {}, laneAccounts = [], agentGets = {}, aa = baseAa(), ringSeed = null, runsSeed = null, failOnSet = [] }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = TICK;
  let failKeys = failOnSet;
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET, ...(config.cliproxy ?? {}) } }) },
    state: {
      get: async k => store.get(skey(k)) ?? null,
      set: async (k, v) => {
        if (failKeys.some(s => skey(k).includes(s))) throw new Error('injected-persist-failure');
        store.set(skey(k), v);
      },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => ({ observedAt: new Date(now).toISOString(), accounts: laneAccounts }) }) },
    agents: {
      get: async (agentId, companyId) => {
        if (typeof agentId !== 'string' || typeof companyId !== 'string') {
          throw new Error('companyId is required for this operation');
        }
        return agentGets[agentId] ?? null;
      },
    },
    issues: {
      get: async (issueId, companyId) => {
        if (typeof issueId !== 'string' || typeof companyId !== 'string') {
          throw new Error('companyId is required for this operation');
        }
        return null;
      },
      list: async () => [],
    },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  let plugin = createModelCapacityPlugin({ clock: () => now });
  const wire = async () => {
    await plugin.setup(io);
    await plugin.onConfigChanged(config, { companyId: 'acme' });
  };
  return {
    setNow: (ms) => { now = ms; },
    setFailOnSet: (l) => { failKeys = l; },
    setup: async () => {
      await wire();
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: aa, duplicateSlugs: [] });
      if (ringSeed) store.set(skey(RING_STATE_KEY), ringSeed);
      if (runsSeed) store.set(skey(RUNS_STATE_KEY), runsSeed);
    },
    // Simulates a worker restart: fresh memory, same persisted store.
    restart: async () => {
      plugin = createModelCapacityPlugin({ clock: () => now });
      await wire();
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

test('carried decisions migrate into one record per runId; horizon-old ones are excluded, then trimmed', async () => {
  // A worker starting with legacy persisted state: three carried decisions
  // (fresh, R4-aged, ancient) plus a start for the live run. The ancient
  // anchor is past the 2h horizon, so reconcile marks it unverified and it
  // stops counting -- and the persist trim sheds it (dead weight), while the
  // shadow log keeps the three live entries.
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
  // Fresh carried decisions count (each runId exactly once -- the live
  // run's start and decision merged into one record); the ancient one is
  // age-excluded by reconcile, then shed by the persist trim.
  assert.deepEqual(capacity.body.inFlightByPool, { kimi: 3 });
  assert.deepEqual(capacity.body.inFlightByAccount, { 'kimi:k1': 3 });
  assert.equal(capacity.body.reconciledUnverified, 1);
  assert.equal(capacity.body.staleInFlightDropped, 1);
  assert.equal(capacity.body.clampedInFlightDropped, 0);
  const shadow = await d.api('shadow');
  const ids = shadow.body.entries.map(e => e.runId);
  assert.equal(shadow.body.entries.length, 3);
  assert.ok(ids.includes('run-live') && ids.includes('ghost-recent') && ids.includes('ghost-mid'));
  assert.ok(!ids.includes('ghost-ancient'), 'stale-horizon record trimmed from the persisted ledger');
  // Reconciliation is idempotent: the next tick marks nothing new and the
  // shadow log still holds every live entry.
  await d.tick();
  const again = await d.api('capacity');
  assert.equal(again.body.reconciledUnverified, 0);
  assert.deepEqual(again.body.inFlightByAccount, { 'kimi:k1': 3 });
  assert.equal((await d.api('shadow')).body.entries.length, 3);
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
  d.setNow(TICK + 1000);
  await d.tick();
  const capacity = await d.api('capacity');
  assert.deepEqual(capacity.body.inFlightByAccount, { 'kimi:k1': 1 });
  assert.equal(capacity.body.reconciledUnverified, 0);
});

test('a restart retains live shadow history, enforced flags, and in-flight (trim sheds only stale records)', async () => {
  // Finding (1): the old startup reconcile DELETED shadow history (GET
  // /shadow emptied on restart, the enforced flag was lost, long runs lost
  // in-flight). Post-fix the shadow log is an append-only view over ledger
  // records and a restart only re-marks, never removes; the persist trim
  // sheds only dead weight (here: the 3h-ancient carried entry).
  const d = drive({
    laneAccounts: [kimiLane('k1')],
    ringSeed: [
      ringEntry('ghost-recent', TICK - 30 * 60000, { enforced: true }),
      ringEntry('ghost-mid', TICK - 70 * 60000),
      ringEntry('ghost-ancient', TICK - 3 * 3600000),
      ringEntry('run-live', TICK - 30 * 60000, { enforced: true }),
    ],
    runsSeed: [
      { runId: 'run-live', agentId: 'agent-9', status: 'running', at: TICK - 30 * 60000 },
    ],
    failOnSet: ['ledger-v1'],
  });
  await d.setup();
  // A tick that dies before persisting leaves nothing usable on disk; the
  // next worker generation migrates from the legacy keys instead.
  await assert.rejects(d.tick());
  d.setFailOnSet([]);
  await d.restart();
  await d.tick();
  const capacity = await d.api('capacity');
  assert.deepEqual(capacity.body.inFlightByPool, { kimi: 3 });
  assert.deepEqual(capacity.body.inFlightByAccount, { 'kimi:k1': 3 });
  const shadow = await d.api('shadow');
  assert.equal(shadow.body.entries.length, 3);
  const byId = new Map(shadow.body.entries.map(e => [e.runId, e]));
  assert.equal(byId.get('ghost-recent').enforced, true);
  assert.equal(byId.get('run-live').enforced, true);
  assert.ok(!byId.has('ghost-ancient'), 'stale-horizon record trimmed, live history retained');
  // A clean restart with the ledger persisted keeps everything live too.
  await d.restart();
  await d.tick();
  assert.deepEqual((await d.api('capacity')).body.inFlightByAccount, { 'kimi:k1': 3 });
  assert.equal((await d.api('shadow')).body.entries.length, 3);
});
