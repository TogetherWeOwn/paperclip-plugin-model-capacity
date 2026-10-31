import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

export const NOW = Date.parse('2026-10-30T12:00:00Z');
export const HOUR = 3600000;
export const OPUS = 'claude-opus-5-5';
export const SONNET = 'claude-sonnet-5-5';
export const WONDER = 'muse-wonder-full-1.0-contributor';
const REF = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const key = stateKey => ({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey });
const metrics = { terminalbenchV40: .9, scicode: .9, lcr: .9, ifbench: .9,
  omniscienceNonHallucination: .9, hle: .9, gpqa: .9, critpt: .9, gdpvalNormalized: .9 };
export const rows = () => [
  { slug: OPUS, intelligenceIndex: 62, intelligenceIndexCostPerTask: 30,
    price1mInputTokens: 5, price1mOutputTokens: 25, ...metrics },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 18,
    price1mInputTokens: 3, price1mOutputTokens: 15, ...metrics },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7,
    price1mInputTokens: 1, price1mOutputTokens: 4, ...metrics },
  { slug: 'gemini-2-5-flash', intelligenceIndex: 54, intelligenceIndexCostPerTask: 5,
    price1mInputTokens: 1, price1mOutputTokens: 3, ...metrics },
];

export const lane = (accountKey, used = .3, hoursLeft = 84, extra = {}) => ({
  lane: accountKey, provider: 'claude', accountKey, health: 'healthy', models: [OPUS],
  weekly: { used, resetsAt: new Date(NOW + hoursLeft * HOUR).toISOString() },
  fiveHour: { used: .1, resetsAt: new Date(NOW + 4 * HOUR).toISOString() },
  observedAt: new Date(NOW).toISOString(), quality: 'live', ...extra,
});
export const policy = (provider = 'claude', model = OPUS, effort = 'high') => ({ provider, model, effort });
export const config = (mode = 'enforce') => ({
  enforce: true, taskRanking: { mode }, credentialReadiness: { enforce: true },
  concurrency: { maxTotal: 8, meanRunDurationHours: .2 },
  roles: { keepAgentIds: ['fixed', 'review'], doerAgentIds: ['doer', 'fixed', 'review'],
    minQuality: { doer: null, thinker: null, other: null }, thinkerFloorRung: 0,
    outcomeGate: { enabled: false } },
  reviewReserve: { enabled: false, agentIds: ['review'], providers: ['claude', 'meta'] },
  reviewerRouting: { agentIds: ['review'], arms: [policy()] },
});

// Only the external feed/SDK IO is synthetic. Ticks, admission, hook decisions,
// persisted facts, running attribution and both public capacity APIs are real.
export async function drive({ raw = config(), accounts = [lane('one')], aaRows = rows(),
  demand = [{ agentId: 'fixed', queued: 8 }, { agentId: 'review', queued: 8 }], agents = {} } = {}) {
  const store = new Map(), jobs = new Map(), events = new Map(), liveViews = new Map();
  let now = NOW, feed = accounts, failed = false, current = raw, plugin;
  const io = {
    config: { get: async () => ({ ...current, cliproxy: { laneKeySecretRef: REF } }) },
    state: { get: async k => store.get(JSON.stringify(k)) ?? null,
      set: async (k, value) => { store.set(JSON.stringify(k), value); } },
    secrets: { resolve: async () => 'synthetic-not-a-credential' },
    http: { fetch: async url => {
      assert.match(url, /\/telemetry\/cliproxy\/live\/accounts\.json$/);
      if (failed) throw new Error('synthetic-refresh-failed');
      return { status: 200, json: async () => withSyntheticReadiness({
        observedAt: new Date(now).toISOString(), accounts: feed,
      }, now, { emitted: ['devin/swe-2'] }) };
    } },
    agents: { get: async id => agents[id] ?? null, getQueuedRunCounts: async () => demand },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (name, fn) => jobs.set(name, fn) },
    events: { on: (name, fn) => events.set(name, fn) },
    logger: { info() {}, error() {}, warn() {} },
  };
  const setup = async () => {
    plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false, liveViews });
    await plugin.setup(io);
    await plugin.onConfigChanged(current, { companyId: 'acme' });
  };
  store.set(JSON.stringify(key('aa-snapshot-v1')), {
    fetchedAt: new Date(now).toISOString(), rows: aaRows, duplicateSlugs: [],
  });
  await setup();
  const api = async routeKey => {
    const response = await plugin.onApiRequest({ companyId: 'acme', routeKey });
    assert.equal(response.status, 200);
    return response.body;
  };
  return {
    raw, store, liveViews, now: () => now,
    setNow: value => { now = value; },
    setAccounts: value => { feed = value.map(entry => ({ ...entry, observedAt: new Date(now).toISOString() })); },
    failRefresh: () => { failed = true; },
    configure: async value => { current = value; await plugin.onConfigChanged(value, { companyId: 'acme' }); },
    restart: setup,
    tick: () => jobs.get('quota-refresh')({ companyId: 'acme' }),
    api, capacity: () => api('capacity'), caps: () => api('caps'), shadow: () => api('shadow'),
    snapshot: () => store.get(JSON.stringify(key('capacity-v1'))),
    seedSnapshot: value => store.set(JSON.stringify(key('capacity-v1')), value),
    size: (bindings = {}, slots = 8) => {
      // Isolate the allocation contract, without forging pace/admission facts.
      const snapshot = store.get(JSON.stringify(key('capacity-v1')));
      snapshot.target = 8; snapshot.calibration = 'measured';
      for (const row of snapshot.perAccount) row.slots = slots;
      Object.assign(snapshot.keptByAgent, bindings);
    },
    hook: (runId, extra = {}) => plugin.onResolveRunModel({ runId, companyId: 'acme',
      agentId: 'doer', issueId: null, adapterType: 'claude-code', invocationSource: 'test',
      agentDefaultModel: null, issueOverrideModel: null, previous: null, deadlineMs: 1500, ...extra }),
    fireEvent: event => events.get(event.type)(event),
    fire: (runId, agentId, fields = {}, type = 'agent.run.started') => events.get(type)({
      type, companyId: 'acme', entityId: runId, occurredAt: new Date(now).toISOString(),
      payload: { run: { agentId, provider: 'claude', ...fields } },
    }),
  };
}

export const agent = (body, id) => {
  const row = body.agents.find(row => row.agentId === id);
  assert.ok(row, `visible demand for ${id}`);
  assert.equal(row.maxConcurrentRuns, row.allocated);
  return row;
};
export const assertDeferred = decision => {
  assert.equal(decision.kind, 'defer', JSON.stringify(decision));
  assert.ok(Number.isFinite(decision.retryAfterMs) && decision.retryAfterMs > 0
    && decision.retryAfterMs <= 600000, 'hold uses the existing bounded retry mechanism');
  assert.equal(decision.model, undefined, 'defer must not carry a default/fallback emission');
  assert.equal(decision.effort, undefined);
};
