import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';

// The SDK contract for ctx reads is positional --
// PluginIssuesClient.get(issueId, companyId) /
// PluginAgentsClient.get(agentId, companyId). The object params form belongs
// to the lower-level host-client layer: passed to ctx it lands in the id
// slot, companyId arrives undefined, and the host logs "companyId is
// required" on EVERY lookup (v0.1.14 prod: ~70/10min). These fakes mimic
// the host exactly, and the call counts below pin the single-call shape:
// the old object-first+retry wrapper needed 2 calls per lookup.

const TICK = Date.parse('2026-10-08T23:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };

const aaRows = () => ([
  { slug: 'claude-opus-5-5', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
  { slug: 'claude-haiku-5-5-xhigh', intelligenceIndex: 53, intelligenceIndexCostPerTask: 8, price1mInputTokens: 1, price1mOutputTokens: 4 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
]);

test('sdk reads pass companyId positionally, exactly once per lookup', async () => {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = TICK;
  const issueCalls = [];
  const agentCalls = [];
  const errors = [];
  const fake = {
    config: { get: async () => ({ cliproxy: { laneKeySecretRef: SECRET } }) },
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
          accounts: [{
            lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy',
            weekly: { used: 0.3, resetsAt: '2026-10-15T22:59:00Z' },
            fiveHour: { used: 0.1, resetsAt: '2026-10-09T03:59:00Z' },
            observedAt: new Date(now).toISOString(), quality: 'live',
          }],
        }),
      }),
    },
    agents: {
      get: async (agentId, companyId) => {
        agentCalls.push([agentId, companyId]);
        if (typeof agentId !== 'string' || typeof companyId !== 'string') {
          throw new Error('companyId is required for this operation');
        }
        return agentId === 'agent-9'
          ? { adapterType: 'claude', adapterConfig: { model: 'claude-sonnet-5-5' } }
          : null;
      },
    },
    issues: {
      get: async (issueId, companyId) => {
        issueCalls.push([issueId, companyId]);
        if (typeof issueId !== 'string' || typeof companyId !== 'string') {
          throw new Error('companyId is required for this operation');
        }
        return {};
      },
      list: async () => [],
    },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error: (...a) => { errors.push(a); } },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  await plugin.setup(fake);
  store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: aaRows(), duplicateSlugs: [] });
  await plugin.onConfigChanged({}, { companyId: 'acme' });
  await handlers.get('agent.run.started')({
    type: 'agent.run.started', companyId: 'acme', entityId: 'run-1',
    payload: { run: { agentId: 'agent-9', issueId: 'iss-1' } },
    occurredAt: new Date(TICK - 5 * 60000).toISOString(),
  });
  await jobs.get('shadow-tick')({});
  // One issue lookup (per-tick cache) + one agent lookup for the actual
  // model plus one for the adapter gate (separate cache): single calls, no
  // failed first attempts, companyId on every call.
  assert.equal(issueCalls.length, 1);
  assert.equal(agentCalls.length, 2);
  for (const [, companyId] of [...issueCalls, ...agentCalls]) {
    assert.equal(companyId, 'acme');
  }
  assert.deepEqual(errors.filter(([m]) => String(m).includes('read failed')), []);
  const shadow = await plugin.onApiRequest({ companyId: 'acme', routeKey: 'shadow' });
  const entry = shadow.body.entries.find(e => e.runId === 'run-1');
  assert.ok(entry, 'run-1 decided');
  assert.equal(entry.actualModel, 'claude-sonnet-5-5');
  assert.equal(entry.actualModelSource, 'agent-config');
});
