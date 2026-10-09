import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { canonicalModelName } from '../src/arms.mjs';

// Claude Code CLI >= 2.1.291 runs claude-haiku-5-5 at contextWindow 200000
// and IGNORES CLAUDE_CODE_MAX_CONTEXT_TOKENS for claude-* ids (the
// autocompact-thrash cause). `model(effort)[1m]` makes the CLI strip [1m]
// and send `model(effort)`, which the API accepts at 1M for Haiku 5.5.
// Rule: the plugin emits `<model>(<effort>)[1m]` for claude_local /
// claude-code adapters when the arm's AA contextWindow >= 1M and the model
// id starts with `claude-`; MAX_CONTEXT_TOKENS is never set for claude-*
// (MAX_OUTPUT_TOKENS 64000 stays for Haiku). Run mapping normalizes [1m]
// (and the effort parens) away so decorated actuals still map to arms.

const TICK = Date.parse('2026-10-08T23:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
const MAX_CONTEXT = 'CLAUDE_CODE_MAX_CONTEXT_TOKENS';
const MAX_OUTPUT = 'CLAUDE_CODE_MAX_OUTPUT_TOKENS';

const aaRow = (slug, extra = {}) => ({
  slug, intelligenceIndex: 55, intelligenceIndexCostPerTask: 10,
  price1mInputTokens: 1, price1mOutputTokens: 4, ...extra,
});

const meteredLane = (provider, key, models) => ({
  lane: `${provider}-${key}`, provider, accountKey: key,
  health: 'healthy', meter: null, pool: null, models,
  weekly: { used: 0.3, resetsAt: '2026-10-15T22:59:00Z' },
  fiveHour: { used: 0.1, resetsAt: null },
  observedAt: '2026-10-08T22:59:00Z', quality: 'live',
});

const runEvent = (runId, atMs, extra = {}, type = 'agent.run.started') => ({
  type, companyId: 'acme', entityId: runId,
  payload: { run: { agentId: 'agent-9', ...extra } },
  occurredAt: new Date(atMs).toISOString(),
});

function drive({ config = {}, laneAccounts = [], agentGets = {}, aa = [] }) {
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

test('canonical names normalize the [1m] context suffix and effort parens away', () => {
  assert.equal(canonicalModelName('claude-haiku-5-5(max)[1m]'), 'claude-haiku-5-5');
  assert.equal(canonicalModelName('claude-haiku-5-5(max)'), 'claude-haiku-5-5');
  assert.equal(canonicalModelName('claude-haiku-5-5[1m]'), 'claude-haiku-5-5');
  assert.equal(canonicalModelName('claude-haiku-5-5'), 'claude-haiku-5-5');
  assert.equal(canonicalModelName('provider/claude-haiku-5-5(max)[1m]'), 'claude-haiku-5-5');
  assert.equal(canonicalModelName(null), null);
});

test('[1m] emit: 1M claude arm on a claude adapter emits model(effort)[1m] with no MAX_CONTEXT', async () => {
  const d = drive({
    config: { enforce: true },
    laneAccounts: [meteredLane('claude', 'c1', ['claude-haiku-5-5'])],
    agentGets: { 'agent-9': { adapterType: 'claude-code' } },
    aa: [aaRow('claude-haiku-5-5', { contextWindowTokens: 1000000 })],
  });
  await d.setup();
  await d.tick();
  const out = await d.hook('run-1m', { adapterType: 'claude-code' });
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, 'claude-haiku-5-5(max)[1m]');
  assert.equal(out.env[MAX_OUTPUT], '64000');
  assert.ok(!(MAX_CONTEXT in (out.env ?? {})), `MAX_CONTEXT must never ride claude-* ids: ${JSON.stringify(out.env)}`);
});

test('[1m] mapping: a decorated running actual maps to the serving account, not the family fallback', async () => {
  // Two lanes serve different haiku generations. Pre-fix the decorated
  // actual misses the direct match and the family fallback picks the FIRST
  // haiku lane (c-old). Post-fix it maps to the lane serving haiku-5-5.
  const d = drive({
    config: {},
    laneAccounts: [
      meteredLane('claude', 'c-old', ['claude-haiku-4-5']),
      meteredLane('claude', 'c-new', ['claude-haiku-5-5']),
    ],
  });
  await d.setup();
  await d.fire(runEvent('run-deco', TICK - 60000, { model: 'claude-haiku-5-5(max)[1m]' }));
  await d.tick();
  const capacity = await d.api('capacity');
  assert.deepEqual(capacity.body.inFlightByAccount, { 'claude:c-new': 1 });
  assert.equal(capacity.body.unmappedRuns, 0);
});

test('[1m] round-trip: decorated modelDecision matches the decorated would-be decision', async () => {
  const deco = 'claude-haiku-5-5(max)[1m]';
  const d = drive({
    config: {},
    laneAccounts: [meteredLane('claude', 'c1', ['claude-haiku-5-5'])],
    agentGets: { 'agent-9': { adapterType: 'claude-code' } },
    aa: [aaRow('claude-haiku-5-5', { contextWindowTokens: 1000000 })],
  });
  await d.setup();
  await d.fire(runEvent('run-rt', TICK - 60000, { adapterType: 'claude-code' }));
  await d.tick();
  let shadow = await d.api('shadow');
  let entry = shadow.body.entries.find(e => e.runId === 'run-rt');
  assert.equal(entry.wouldModel, deco);
  d.setNow(TICK + 30000);
  await d.fire({
    ...runEvent('run-rt', TICK + 30000, { adapterType: 'claude-code' }, 'agent.run.finished'),
    payload: { run: { agentId: 'agent-9' }, modelDecision: { model: deco } },
  });
  await d.tick();
  shadow = await d.api('shadow');
  entry = shadow.body.entries.find(e => e.runId === 'run-rt');
  assert.equal(entry.actualModel, deco);
  assert.equal(entry.modelMatch, true);
});
