import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';

// Regression tests for the six Paperclip Review warnings on PR #8
// (hook + event-time run accounting). Each test fails on the pre-fix code.

const TICK = Date.parse('2026-10-08T23:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };

const aaRows = () => ([
  { slug: 'claude-opus-5-5', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
  { slug: 'claude-haiku-5-5-xhigh', intelligenceIndex: 53, intelligenceIndexCostPerTask: 8, price1mInputTokens: 1, price1mOutputTokens: 5 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
  { slug: 'kimi-k3', intelligenceIndex: 55, intelligenceIndexCostPerTask: 10, price1mInputTokens: 1, price1mOutputTokens: 4 },
  { slug: 'gemini-2-5-flash', intelligenceIndex: 54, intelligenceIndexCostPerTask: 5, price1mInputTokens: 1, price1mOutputTokens: 3 },
]);

const rawAcct = (o) => ({
  lane: o.lane, provider: o.provider, accountKey: o.key,
  health: 'healthy', meter: o.meter ?? null, pool: o.pool ?? null,
  models: o.models ?? null,
  weekly: { used: o.weekly ?? null, resetsAt: o.reset ?? null },
  fiveHour: { used: o.fiveHour ?? null, resetsAt: o.reset5 ?? null },
  observedAt: '2026-10-08T22:59:00Z', quality: o.quality ?? 'live',
});

const geminiMetered = () => rawAcct({
  lane: 'ag-1', provider: 'antigravity', key: 'g1',
  weekly: 0.3, reset: '2026-10-15T22:59:00Z', fiveHour: 0.1,
  models: ['gemini-2-5-flash'],
});

const kimiLane = (key) => rawAcct({
  lane: `kimi-${key}`, provider: 'kimi', key, meter: 'reactive', quality: 'reactive',
  models: ['kimi-k3-256k'],
});

const hookParams = (runId, extra = {}) => ({
  runId, companyId: 'acme', agentId: 'agent-9', issueId: null,
  adapterType: null, invocationSource: 'test', wakeReason: null,
  agentDefaultModel: null, previous: null, issueOverrideModel: null,
  deadlineMs: 1500, ...extra,
});

const runEvent = (runId, atMs, extra = {}, type = 'agent.run.started') => ({
  type, companyId: 'acme', entityId: runId,
  payload: { run: { agentId: 'agent-9', ...extra } },
  occurredAt: new Date(atMs).toISOString(),
});

function drive({ nowMs, config = {}, laneAccounts = [], agentGets = {} }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = nowMs;
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
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: () => jobs.get('shadow-tick')({}),
    fire: (e) => handlers.get(e.type)(e),
    hook: (runId, extra) => plugin.onResolveRunModel(hookParams(runId, extra)),
    api: (routeKey) => plugin.onApiRequest({ companyId: 'acme', routeKey }),
    killIo: () => {
      for (const k of ['config', 'state', 'secrets', 'http', 'agents', 'issues']) {
        io[k] = new Proxy({}, { get: () => { throw new Error(`io-forbidden:${k}`); } });
      }
    },
  };
}

test('finding 1: hook trial budgets are consumed between ticks (budget 2 -> 1 more, not 6)', async () => {
  // One metered gemini lane; the seed run's tick decision already holds one
  // trial slot, so exactly one of six hook bursts may decide.
  const d = drive({
    nowMs: TICK, config: { enforce: true },
    laneAccounts: [geminiMetered()],
    agentGets: { 'agent-9': { adapterType: 'claude_local' } },
  });
  await d.setup();
  await d.fire(runEvent('run-seed', TICK - 60000));
  await d.tick();
  d.killIo();
  const outs = [];
  for (let i = 0; i < 6; i++) outs.push(await d.hook(`run-h${i}`));
  const decides = outs.filter(o => o.kind === 'decide');
  // Pre-fix: all 6 decide against a budget of 2. Post-fix: the seed holds
  // one slot, so exactly one hook burst fits.
  assert.equal(decides.length, 1);
  assert.equal(decides[0].model, 'gemini-2-5-flash');
  for (const o of outs.filter(o => o.kind !== 'decide')) assert.equal(o.kind, 'defer');
});

test('finding 1b: tick consumes trial budgets within the loop (6 candidates, budget 2 -> 2 trials)', async () => {
  const d = drive({
    nowMs: TICK, config: {},
    laneAccounts: [geminiMetered()],
    agentGets: { 'agent-9': { adapterType: 'claude_local' } },
  });
  await d.setup();
  for (let i = 0; i < 6; i++) await d.fire(runEvent(`run-c${i}`, TICK - 60000));
  await d.tick();
  const shadow = await d.api('shadow');
  const trials = shadow.body.entries.filter(e => e.trial === true);
  // Pre-fix: 6 trial entries against maxInFlightPerFamily 2. Post-fix: 2.
  assert.equal(trials.length, 2);
  const capacity = await d.api('capacity');
  assert.ok(capacity.body.shadow.skippedNoDecision >= 4);
});

test('finding 2: hook-decided run counts once after it starts (no pendingEnforced + pendingShadow double)', async () => {
  const d = drive({
    nowMs: TICK, config: { enforce: true },
    laneAccounts: [kimiLane('k1')],
  });
  await d.setup();
  await d.tick();
  d.killIo();
  const first = await d.hook('run-x0', { adapterType: 'claude-code' });
  assert.equal(first.kind, 'decide');
  // The hook-decided run starts: pre-fix this queues a second (shadow)
  // entry for the same runId and the next hook defers. Post-fix the
  // event-time path skips already-queued runIds and the run counts once.
  await d.fire(runEvent('run-x0', TICK + 1000, { adapterType: 'claude-code' }));
  const second = await d.hook('run-x1', { adapterType: 'claude-code' });
  assert.equal(second.kind, 'decide');
});

test('finding 3: reactive cap is per account, not per pool (two kimi lanes -> 4 hook decides)', async () => {
  // Family budget raised to 4 so only the per-account cap binds: each lane
  // holds 2, all four hook bursts fit iff the cap counts per account.
  const d = drive({
    nowMs: TICK, config: { enforce: true, trials: { maxInFlightPerFamily: 4 } },
    laneAccounts: [kimiLane('k1'), kimiLane('k2')],
  });
  await d.setup();
  await d.tick();
  d.killIo();
  const outs = [];
  for (let i = 0; i < 4; i++) outs.push(await d.hook(`run-k${i}`, { adapterType: 'claude-code' }));
  // Pre-fix: decide, decide, defer, defer (pool of 2 vs cap 2). Post-fix:
  // each lane holds 2, all four decide.
  assert.deepEqual(outs.map(o => o.kind), ['decide', 'decide', 'decide', 'decide']);
  const counts = {};
  for (const o of outs) counts[o.reason.match(/on (\S+)/)?.[1] ?? '?'] = (counts[o.reason.match(/on (\S+)/)?.[1] ?? '?'] ?? 0) + 1;
  assert.deepEqual(Object.values(counts).sort(), [2, 2]);
});
