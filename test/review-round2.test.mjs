import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin, validateConfigShape, resolveConfig } from '../src/plugin.mjs';
import { DEFAULT_ACCOUNTS_PATH } from '../src/cliproxy.mjs';

// Regression tests for Paperclip Review round 2 on ca2956a (3 regressions +
// 1 gap). Each test mirrors the reviewer's probe and fails on the pre-fix
// code. The drive is imperative (setNow/tick/hook/fire) to cover multi-tick
// event orders the one-shot drive cannot express.

const TICK = Date.parse('2026-10-08T23:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };

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

const rawAcct = (o) => ({
  lane: o.lane, provider: o.provider, accountKey: o.key,
  health: 'healthy', meter: o.meter ?? null, pool: o.pool ?? null,
  models: o.models ?? null,
  weekly: { used: o.weekly ?? null, resetsAt: o.reset ?? null },
  fiveHour: { used: o.fiveHour ?? null, resetsAt: o.reset5 ?? null },
  observedAt: '2026-10-08T22:59:00Z', quality: o.quality ?? 'live',
});

const kimiLane = (key) => rawAcct({
  lane: `kimi-${key}`, provider: 'kimi', key, meter: 'reactive', quality: 'reactive',
  models: ['kimi-k3-256k'],
});

const meteredLane = (provider, key, models) => rawAcct({
  lane: `${provider}-${key}`, provider, key,
  weekly: 0.3, reset: '2026-10-15T22:59:00Z', fiveHour: 0.1,
  models,
});

const runEvent = (runId, atMs, extra = {}, type = 'agent.run.started') => ({
  type, companyId: 'acme', entityId: runId,
  payload: { run: { agentId: 'agent-9', ...extra } },
  occurredAt: new Date(atMs).toISOString(),
});

function drive({ config = {}, laneAccounts = [], agentGets = {}, aa = baseAa() }) {
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
  const plugin = createModelCapacityPlugin({ clock: () => now });
  return {
    setNow: (ms) => { now = ms; },
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: aa, duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: () => jobs.get('shadow-tick')({}),
    fire: (e) => handlers.get(e.type)(e),
    hook: (runId, extra = {}) => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId: 'agent-9', issueId: null,
      adapterType: null, invocationSource: 'test', wakeReason: null,
      agentDefaultModel: null, previous: null, issueOverrideModel: null,
      deadlineMs: 1500, ...extra,
    }),
    api: (routeKey) => plugin.onApiRequest({ companyId: 'acme', routeKey }),
  };
}

test('R1: enforce-mode per-account cap holds across ticks (decided runs count until terminal)', async () => {
  // Reviewer probe: one kimi lane, cap 2, enforce on. Each round hooks 3
  // runs, starts the decided ones, ticks. Family budget raised to 10 so only
  // the per-account cap binds. Pre-fix the cap resets every tick (enforced
  // runs carry no model, the queue is cleared) and the pool grows 2/4/6.
  const d = drive({
    config: { enforce: true, trials: { maxInFlightPerFamily: 10 } },
    laneAccounts: [kimiLane('k1')],
    agentGets: { 'agent-9': { adapterType: 'claude-code' } },
  });
  await d.setup();
  const kinds = [];
  for (let round = 0; round < 3; round++) {
    const t = TICK + round * 30000;
    d.setNow(t);
    if (round > 0) await d.tick();
    else await d.tick();
    for (let i = 0; i < 3; i++) {
      const out = await d.hook(`run-r${round}c${i}`, { adapterType: 'claude-code' });
      kinds.push(out.kind);
      if (out.kind === 'decide') await d.fire(runEvent(`run-r${round}c${i}`, t + 1000, { adapterType: 'claude-code' }));
    }
  }
  d.setNow(TICK + 90000);
  await d.tick();
  // Round 1 takes both slots; rounds 2-3 defer everything: the lane holds 2.
  assert.deepEqual(kinds.slice(0, 3), ['decide', 'decide', 'defer']);
  assert.deepEqual(kinds.slice(3), ['defer', 'defer', 'defer', 'defer', 'defer', 'defer']);
  const capacity = await d.api('capacity');
  assert.deepEqual(capacity.body.inFlightByPool, { kimi: 2 });
  assert.deepEqual(capacity.body.inFlightByAccount, { 'kimi:k1': 2 });
  const shadow = await d.api('shadow');
  assert.equal(shadow.body.entries.filter(e => e.enforced === true && e.accountId === 'kimi:k1').length, 2);
});

test('R1-with-model: enforce cap holds when the agent has a configured model (no backfill reset)', async () => {
  // Review round 4 finding (2): with an agent-config model mapping to the
  // agent's usual (here degraded, ineligible) account, the backfill mapped
  // each enforced run to its usual account and countedRunning skipped the
  // decided entry -- the per-account cap reset every tick and 6 runs were
  // decided onto k1 over a cap of 2. Post-fix attribution is decided-first:
  // the decision always outranks the agent-config guess.
  const degraded = { ...meteredLane('claude', 'c1', ['claude-haiku-5-5']), health: 'degraded' };
  const d = drive({
    config: { enforce: true, trials: { maxInFlightPerFamily: 10 } },
    laneAccounts: [kimiLane('k1'), degraded],
    agentGets: {
      'agent-9': {
        adapterType: 'claude-code',
        adapterConfig: { model: 'claude-haiku-5-5' },
      },
    },
  });
  await d.setup();
  const kinds = [];
  for (let round = 0; round < 3; round++) {
    const t = TICK + round * 30000;
    d.setNow(t);
    await d.tick();
    for (let i = 0; i < 3; i++) {
      const out = await d.hook(`run-m${round}c${i}`, { adapterType: 'claude-code' });
      kinds.push(out.kind);
      if (out.kind === 'decide') await d.fire(runEvent(`run-m${round}c${i}`, t + 1000, { adapterType: 'claude-code' }));
    }
  }
  d.setNow(TICK + 90000);
  await d.tick();
  // Same shape as R1: the lane holds 2 across ticks, nothing leaks onto
  // the agent-config account.
  assert.deepEqual(kinds.slice(0, 3), ['decide', 'decide', 'defer']);
  assert.deepEqual(kinds.slice(3), ['defer', 'defer', 'defer', 'defer', 'defer', 'defer']);
  const capacity = await d.api('capacity');
  assert.deepEqual(capacity.body.inFlightByPool, { kimi: 2 });
  assert.deepEqual(capacity.body.inFlightByAccount, { 'kimi:k1': 2 });
  const shadow = await d.api('shadow');
  assert.equal(shadow.body.entries.filter(e => e.enforced === true && e.accountId === 'kimi:k1').length, 2);
});

test('R2: host event order (started before hook) does not spend the run own slot', async () => {
  // heartbeat.ts publishes agent.run.started at claim, before the model hook
  // resolves. Pre-fix the run's own event-time shadow entry counts against
  // it in the cap and budget: decide, defer. Post-fix: decide, decide.
  const d = drive({
    config: { enforce: true, trials: { maxInFlightPerFamily: 10 } },
    laneAccounts: [kimiLane('k1')],
    agentGets: { 'agent-9': { adapterType: 'claude-code' } },
  });
  await d.setup();
  await d.tick();
  await d.fire(runEvent('run-x0', TICK + 1000, { adapterType: 'claude-code' }));
  const first = await d.hook('run-x0', { adapterType: 'claude-code' });
  assert.equal(first.kind, 'decide');
  await d.fire(runEvent('run-x1', TICK + 2000, { adapterType: 'claude-code' }));
  const second = await d.hook('run-x1', { adapterType: 'claude-code' });
  assert.equal(second.kind, 'decide');
});

test('R3a: mapped-model candidates still water-fill (no herd onto one lane)', async () => {
  // Three equal metered lanes, 10 running candidates whose model maps to an
  // account. Pre-fix the double-count guard eats all pending pressure and
  // all 10 land on one lane; the prior head split them across lanes.
  const d = drive({
    config: {},
    laneAccounts: [
      meteredLane('alpha', 'a1', ['claude-haiku-5-5']),
      meteredLane('beta', 'a2', ['claude-haiku-5-5']),
      meteredLane('gamma', 'a3', ['claude-haiku-5-5']),
    ],
  });
  await d.setup();
  for (let i = 0; i < 10; i++) {
    await d.fire(runEvent(`run-m${i}`, TICK - 60000, { model: 'claude-haiku-5-5' }));
  }
  await d.tick();
  const shadow = await d.api('shadow');
  const perAccount = {};
  for (const e of shadow.body.entries) perAccount[e.accountId] = (perAccount[e.accountId] ?? 0) + 1;
  assert.equal(shadow.body.entries.length, 10);
  // Spread restored (pre-fix: all 10 on beta:a2): decided pressure moves off
  // the mapped pool onto the decided one, so the order keeps re-sorting.
  assert.deepEqual(perAccount, { 'alpha:a1': 3, 'beta:a2': 4, 'gamma:a3': 3 });
});

test('R3b: reactive burst bound holds for mapped-model candidates (kimi takes 2 of 8)', async () => {
  // Kimi k1 plus a degraded claude lane (ineligible, so kimi wins the order
  // while the candidates stay mapped by model). Family budget raised so only
  // the per-account cap binds. Pre-fix all 8 shadow-decide onto kimi:k1;
  // the prior head allowed 2.
  const degraded = { ...meteredLane('claude', 'c1', ['claude-haiku-5-5']), health: 'degraded' };
  const d = drive({
    config: { trials: { maxInFlightPerFamily: 10 } },
    laneAccounts: [kimiLane('k1'), degraded],
  });
  await d.setup();
  for (let i = 0; i < 8; i++) {
    await d.fire(runEvent(`run-h${i}`, TICK - 60000, { model: 'claude-haiku-5-5', adapterType: 'claude-code' }));
  }
  await d.tick();
  const shadow = await d.api('shadow');
  const kimiEntries = shadow.body.entries.filter(e => e.accountId === 'kimi:k1');
  assert.equal(kimiEntries.length, 2);
  for (const e of kimiEntries) assert.equal(e.trial, true);
});

test('R5: lane feed path is pinned like baseUrl (lane-key redirect closed)', () => {
  assert.ok(validateConfigShape({ cliproxy: { accountsPath: '/evil.json' } }).length > 0);
  assert.deepEqual(validateConfigShape({ cliproxy: { accountsPath: DEFAULT_ACCOUNTS_PATH } }), []);
  assert.equal(resolveConfig({ cliproxy: { accountsPath: '/evil.json' } }).cliproxy.accountsPath, DEFAULT_ACCOUNTS_PATH);
  assert.equal(resolveConfig({}).cliproxy.accountsPath, DEFAULT_ACCOUNTS_PATH);
});

test('R4: runs older than the rate window keep their pool pressure while unfinished', async () => {
  // A hook-decided kimi run started 70 minutes ago and still running, ticks
  // every minute. Pre-fix the clamp (bound = running runs inside the 60-min
  // window) drops it: pools {} with clamped 1. Post-fix the bound covers
  // non-terminal ring carry inside the stale horizon.
  const t0 = TICK - 70 * 60000;
  const d = drive({
    config: { enforce: true },
    laneAccounts: [kimiLane('k1')],
    agentGets: { 'agent-9': { adapterType: 'claude-code' } },
  });
  d.setNow(t0);
  await d.setup();
  await d.tick();
  const decided = await d.hook('run-long', { adapterType: 'claude-code' });
  assert.equal(decided.kind, 'decide');
  await d.fire(runEvent('run-long', t0 + 1000, { adapterType: 'claude-code' }));
  for (let m = 1; m <= 70; m++) {
    d.setNow(t0 + m * 60000);
    await d.tick();
  }
  const capacity = await d.api('capacity');
  assert.deepEqual(capacity.body.inFlightByPool, { kimi: 1 });
  assert.equal(capacity.body.clampedInFlightDropped, 0);
  assert.equal(capacity.body.staleInFlightDropped, 0);
  assert.deepEqual(capacity.body.inFlightByAccount, { 'kimi:k1': 1 });
});
