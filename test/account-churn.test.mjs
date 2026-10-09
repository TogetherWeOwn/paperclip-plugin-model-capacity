import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';

// Owner requirement (blind-tested live): the plugin keeps working whatever
// accounts are in CLIProxy, and auto-detects added, removed and disabled
// accounts. Live: claude-lane-2 flipped to unavailable, got no decisions,
// and the target recomputed. These drive tests lock that in.

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

const lane = (provider, key, { models, used = 0.3, health = 'healthy' } = {}) => ({
  lane: `${provider}-${key}`, provider, accountKey: key,
  health, meter: null, pool: null, models,
  weekly: { used, resetsAt: '2026-10-15T22:59:00Z' },
  fiveHour: { used: 0.1, resetsAt: '2026-10-15T22:59:00Z' },
  quality: 'live',
});

function drive({ config = {}, lanes = [], agentGets = {}, aa = baseAa(), ringSeed = null, runsSeed = null }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = TICK;
  let currentLanes = lanes;
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET, ...(config.cliproxy ?? {}) } }) },
    state: {
      get: async k => store.get(skey(k)) ?? null,
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: {
      fetch: async () => ({
        status: 200,
        json: async () => ({
          observedAt: new Date(now).toISOString(),
          accounts: currentLanes.map(a => ({ ...a, observedAt: new Date(now).toISOString() })),
        }),
      }),
    },
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
    setLanes: (next) => { currentLanes = next; },
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

const started = (runId, atMs, model) => ({
  type: 'agent.run.started', companyId: 'acme', entityId: runId,
  payload: { run: { agentId: 'agent-9', adapterType: 'claude-code', model } },
  occurredAt: new Date(atMs).toISOString(),
});

const accountIdsOf = (capacity) => capacity.body.accounts.map(a => a.accountId).sort();

test('a vanished account gets no decisions and drops out of the report', async () => {
  const A = lane('alpha', 'a1', { models: ['claude-haiku-5-5'] });
  const B = lane('beta', 'b1', { models: ['claude-haiku-5-5'] });
  const d = drive({
    config: { enforce: true, trials: { maxInFlightPerFamily: 10 } },
    lanes: [A, B],
    agentGets: { 'agent-9': { adapterType: 'claude-code' } },
    ringSeed: [{
      runId: 'run-b', agentId: 'agent-9', wouldModel: 'claude-haiku-5-5(max)',
      account: 'beta:b1', accountId: 'beta:b1', rung: 1, trial: false,
      family: 'claude', reason: 'seed', at: TICK - 5 * 60000,
    }],
    runsSeed: [{ runId: 'run-b', agentId: 'agent-9', status: 'running', at: TICK - 5 * 60000 }],
  });
  await d.setup();
  await d.tick();
  // Beta disappears from the feed entirely between ticks (the clock moves
  // past the 45s lane cache so the tick refetches).
  d.setNow(TICK + 60000);
  d.setLanes([A]);
  await d.fire(started('run-1', TICK + 1000, 'claude-haiku-5-5'));
  await d.fire(started('run-2', TICK + 2000, 'claude-haiku-5-5'));
  await d.tick();
  const shadow = await d.api('shadow');
  const mine = shadow.body.entries.filter(e => e.runId === 'run-1' || e.runId === 'run-2');
  assert.equal(mine.length, 2);
  assert.ok(mine.every(e => e.accountId === 'alpha:a1'));
  const capacity = await d.api('capacity');
  assert.deepEqual(accountIdsOf(capacity), ['alpha:a1']);
  assert.deepEqual(capacity.body.perAccount.map(a => a.accountId), ['alpha:a1']);
});

test('the target recomputes when the last account disappears', async () => {
  const A = lane('alpha', 'a1', { models: ['claude-haiku-5-5'], used: 0.30 });
  const d = drive({ lanes: [A] });
  await d.setup();
  await d.tick();
  // Eleven minutes later the account burned a point and served a run:
  // calibrated, so the target is a number.
  d.setNow(TICK + 11 * 60000);
  d.setLanes([lane('alpha', 'a1', { models: ['claude-haiku-5-5'], used: 0.31 })]);
  await d.fire(started('run-t', TICK + 10 * 60000, 'claude-haiku-5-5'));
  await d.tick();
  const before = await d.api('capacity');
  assert.ok(before.body.target != null && before.body.target > 0);
  assert.deepEqual(before.body.perAccount.map(a => a.accountId), ['alpha:a1']);
  // Then the feed is empty: no crash, no target, and hooks decide nothing.
  d.setNow(TICK + 12 * 60000);
  d.setLanes([]);
  await d.tick();
  const after = await d.api('capacity');
  assert.deepEqual(after.body.perAccount, []);
  assert.equal(after.body.target, null);
  const hook = await d.hook('run-void', { adapterType: 'claude-code' });
  assert.notEqual(hook.kind, 'decide');
});

test('a brand-new account is eligible on the next tick with zero config', async () => {
  const A = lane('alpha', 'a1', { models: ['claude-haiku-5-5'] });
  const d = drive({
    config: { enforce: true, trials: { maxInFlightPerFamily: 10 } },
    lanes: [A],
    agentGets: { 'agent-9': { adapterType: 'claude-code' } },
  });
  await d.setup();
  await d.tick();
  // A new provider with new models appears; nothing else changes.
  const B = lane('nova', 'n1', { models: ['kimi-k3-256k'], used: 0.2 });
  d.setNow(TICK + 60000);
  d.setLanes([A, B]);
  await d.tick();
  const capacity = await d.api('capacity');
  assert.deepEqual(accountIdsOf(capacity), ['alpha:a1', 'nova:n1']);
  // It wins head: largest shortfall takes the first decision.
  for (let i = 0; i < 4; i++) {
    const out = await d.hook(`run-n${i}`, { adapterType: 'claude-code' });
    assert.equal(out.kind, 'decide');
    await d.fire(started(`run-n${i}`, TICK + 60000 + (i + 1) * 1000));
  }
  d.setNow(TICK + 120000);
  await d.tick();
  const shadow = await d.api('shadow');
  const mine = shadow.body.entries.filter(e => e.runId.startsWith('run-n'));
  assert.ok(mine.length >= 4);
  assert.ok(mine.some(e => e.accountId === 'nova:n1'));
});

test('healthy -> unavailable -> healthy freezes, excludes, and resumes', async () => {
  const d = drive({
    config: { enforce: true, trials: { maxInFlightPerFamily: 10 } },
    lanes: [lane('alpha', 'a1', { models: ['claude-haiku-5-5'] })],
    agentGets: { 'agent-9': { adapterType: 'claude-code' } },
  });
  await d.setup();
  await d.tick();
  const before = await d.api('capacity');
  const healthy = before.body.accounts.find(a => a.accountId === 'alpha:a1');
  // The feed marks it unavailable: no decisions, action excluded (never a
  // misleading hold-limit), pointer frozen.
  d.setNow(TICK + 60000);
  d.setLanes([lane('alpha', 'a1', { models: ['claude-haiku-5-5'], health: 'unavailable' })]);
  await d.tick();
  const during = await d.api('capacity');
  const away = during.body.accounts.find(a => a.accountId === 'alpha:a1');
  assert.equal(away.action, 'excluded');
  assert.match(away.reason, /unavailable/);
  assert.equal(away.pointer, healthy.pointer);
  const held = await d.hook('run-away', { adapterType: 'claude-code' });
  assert.notEqual(held.kind, 'decide');
  // And back: the controller resumes from the frozen pointer.
  d.setNow(TICK + 120000);
  d.setLanes([lane('alpha', 'a1', { models: ['claude-haiku-5-5'] })]);
  await d.tick();
  const after = await d.api('capacity');
  const back = after.body.accounts.find(a => a.accountId === 'alpha:a1');
  assert.notEqual(back.action, 'excluded');
  const out = await d.hook('run-back', { adapterType: 'claude-code' });
  assert.equal(out.kind, 'decide');
});

test('an unavailable account with readings contributes zero quota to the target', async () => {
  // The live regression: claude-lane-2 flipped to unavailable, got no
  // decisions, yet its measured quota stayed inside the target (target 32.3
  // with 27.6 sustainable). Post-fix the dead account reads slots 0 with
  // reason excluded and the target equals the healthy accounts only.
  const d = drive({
    lanes: [
      lane('alpha', 'a1', { models: ['claude-haiku-5-5'], used: 0.30 }),
      lane('beta', 'b1', { models: ['kimi-k3-256k'], used: 0.30 }),
    ],
  });
  await d.setup();
  await d.tick();
  // Eleven minutes later both burned a point and each served a run; beta is
  // now unavailable. Both calibrate, but only alpha allocates.
  d.setNow(TICK + 11 * 60000);
  d.setLanes([
    lane('alpha', 'a1', { models: ['claude-haiku-5-5'], used: 0.31 }),
    lane('beta', 'b1', { models: ['kimi-k3-256k'], used: 0.31, health: 'unavailable' }),
  ]);
  await d.fire(started('run-a', TICK + 10 * 60000, 'claude-haiku-5-5'));
  await d.fire(started('run-b', TICK + 10 * 60000, 'kimi-k3-256k'));
  await d.tick();
  const capacity = await d.api('capacity');
  const a = capacity.body.perAccount.find(x => x.accountId === 'alpha:a1');
  const b = capacity.body.perAccount.find(x => x.accountId === 'beta:b1');
  assert.ok(a.slots > 0);
  assert.deepEqual([b.slots, b.reason], [0, 'excluded']);
  assert.equal(capacity.body.target, a.slots);
  const bAction = capacity.body.accounts.find(x => x.accountId === 'beta:b1');
  assert.equal(bAction.action, 'excluded');
});
