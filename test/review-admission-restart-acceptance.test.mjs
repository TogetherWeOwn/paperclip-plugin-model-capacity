import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

// Produce admission with a REAL tick and reuse the serialized SDK state and clock.
// Restart cases never forge provenance. The numeric-only rejection case removes
// only the epoch from real producer evidence, retaining its generation.
const COMPANY = 'acme';
const START = Date.parse('2026-10-25T12:00:00Z');
const MINUTE = 60000;
const REF = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const config = (model = 'gpt-6.1-sol') => ({
  allocation: { blockingPriority: true },
  roles: { keepAgentIds: ['review'], doerAgentIds: ['worker'],
    minQuality: { doer: null, thinker: null, other: null }, outcomeGate: { enabled: false } },
  concurrency: { meanRunDurationHours: 1.1, maxTotal: 8 },
  reviewReserve: { enabled: false }, reviewDemand: { enabled: false },
  reviewerRouting: { agentIds: ['review'], arms: [{ provider: 'codex', model }] },
});
const keyOf = key => `${key.scopeId}/${key.stateKey}`;
const copy = value => value == null ? null : structuredClone(value);
const stateValue = (store, name) => copy(store.get(`${COMPANY}/${name}`));
const reviewer = body => {
  const row = body.agents.find(row => row.agentId === 'review');
  assert.ok(row, 'review heartbeat demand must remain visible');
  return row;
};
async function instance({ store, clock, used, raw = config() }) {
  const jobs = new Map();
  const events = new Map();
  let ticks = 0;
  let feedCalls = 0;
  const plugin = createModelCapacityPlugin({ clock, requirePinnedLaneHost: false });
  const io = {
    config: { get: async () => ({ ...raw, cliproxy: { laneKeySecretRef: REF } }) },
    state: {
      get: async key => copy(store.get(keyOf(key))),
      set: async (key, value) => { store.set(keyOf(key), copy(value)); },
    },
    secrets: { resolve: async () => 'synthetic-not-a-credential' },
    http: { fetch: async url => {
      assert.match(url, /\/telemetry\/cliproxy\/live\/accounts\.json$/);
      feedCalls++;
      return { status: 200, json: async () => withSyntheticReadiness({
        observedAt: new Date(clock()).toISOString(), accounts: [{
          lane: 'codex-a', provider: 'codex', accountKey: 'a', health: 'healthy', models: ['gpt-6.1-sol'],
          weekly: { used: used(), resetsAt: new Date(START + 120 * MINUTE).toISOString() },
          fiveHour: { used: 0.1, resetsAt: new Date(START + 240 * MINUTE).toISOString() },
          observedAt: new Date(clock()).toISOString(), quality: 'live',
        }],
      }, clock()) };
    } },
    agents: { get: async () => null, getQueuedRunCounts: async () => [{ agentId: 'review', queued: 5 }] },
    issues: { get: async () => null, list: async ({ companyId, status }) => {
      assert.equal(companyId, COMPANY);
      return status === 'todo' ? [{ id: 'review-ready', assigneeAgentId: 'review', status: 'todo', priority: 'high', blockedBy: [] }] : [];
    } },
    jobs: { register: (name, fn) => jobs.set(name, fn) },
    events: { on: (name, fn) => events.set(name, fn) }, logger: { info() {}, error() {} },
  };
  await plugin.setup(io);
  assert.deepEqual(await plugin.onValidateConfig(raw), { ok: true });
  await plugin.onConfigChanged(raw, { companyId: COMPANY });
  return {
    ticks: () => ticks, feedCalls: () => feedCalls,
    configure: next => plugin.onConfigChanged(next, { companyId: COMPANY }),
    tick: async () => { ticks++; return jobs.get('quota-refresh')({ companyId: COMPANY }); },
    event: (id, type) => events.get(type)({ type, companyId: COMPANY, entityId: id,
      occurredAt: new Date(clock()).toISOString(),
      payload: { run: { agentId: 'worker', provider: 'codex', model: 'gpt-6.1-sol' } } }),
    caps: async () => {
      const response = await plugin.onApiRequest({ companyId: COMPANY, routeKey: 'caps' });
      assert.equal(response.status, 200);
      assert.equal(response.body.capsError, undefined);
      assert.deepEqual(response.body.allocation, { blockingPriority: true });
      return response.body;
    },
  };
}
async function producedSnapshot() {
  const store = new Map();
  let now = START;
  let consumption = 0.3;
  store.set(`${COMPANY}/aa-snapshot-v1`, {
    fetchedAt: new Date(START).toISOString(), duplicateSlugs: [], rows: [{
      slug: 'gpt-6.1-sol', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30,
      price1mInputTokens: 5, price1mOutputTokens: 25,
    }],
  });
  const clock = () => now;
  const used = () => consumption;
  const a = await instance({ store, clock, used });
  await a.tick();
  now = START + 5 * MINUTE;
  for (let i = 0; i < 6; i++) await a.event(`calibration-${i}`, 'agent.run.started');
  now = START + 15 * MINUTE;
  for (let i = 0; i < 6; i++) await a.event(`calibration-${i}`, 'agent.run.finished');
  now = START + 30 * MINUTE;
  consumption = 0.328;
  await a.tick();
  const snapshot = stateValue(store, 'capacity-v1');
  assert.equal(snapshot.atMs, now, 'real producer must publish at the exact frozen clock');
  assert.notEqual(snapshot.calibration, 'weak', 'calibration must come from the synthetic run/meter history');
  assert.ok(snapshot.target > 0, `expected real usable capacity, got ${JSON.stringify(snapshot)}`);
  assert.deepEqual(snapshot.reviewerAccountIdsByAgent.review, ['codex:a'], 'real producer must admit the old arm');
  assert.ok(Object.hasOwn(snapshot, 'reviewAdmissionGeneration'), 'tick must persist its own admission generation');
  return { store, clock, used, a, snapshot };
}

test('same-process fresh producer snapshot authorizes real queued reviewer demand', async () => {
  const d = await producedSnapshot();
  const body = await d.a.caps();
  const row = reviewer(body);
  assert.equal(body.atMs, d.clock());
  assert.equal(row.queued, 5);
  assert.equal(row.running, 0);
  assert.ok(row.allocated > 0, 'a fresh same-process snapshot must actually grant, not fail closed unconditionally');
  assert.equal(row.maxConcurrentRuns, row.allocated);
});

test('restart before the next tick rejects previous-process admission despite a fresh identical clock', async () => {
  const d = await producedSnapshot();
  const b = await instance({ ...d, raw: config('gpt-6.1-sol-unserved') });
  assert.equal(b.ticks(), 0);
  assert.equal(b.feedCalls(), 0, 'startup must not silently replace the stored admission snapshot');
  const before = stateValue(d.store, 'capacity-v1');
  assert.deepEqual(before, d.snapshot);
  const body = await b.caps();
  const row = reviewer(body);
  assert.equal(body.atMs, d.snapshot.atMs, 'the stale snapshot is still within the normal age window');
  assert.equal(row.queued, 5, 'rejection must preserve visible demand');
  assert.equal(row.running, 0);
  assert.equal(row.allocated, 0, 'new config cannot start work on the old process\'s admitted account');
  assert.equal(row.maxConcurrentRuns, 0);
  assert.equal(b.ticks(), 0);
  assert.deepEqual(stateValue(d.store, 'capacity-v1'), before, 'caps must not rewrite producer evidence');
});

test('restart with unchanged config still requires its own fresh producer snapshot', async () => {
  const d = await producedSnapshot();
  const b = await instance(d);
  const row = reviewer(await b.caps());
  assert.equal(b.ticks(), 0);
  assert.equal(row.allocated, row.running, 'persisted admission belongs to the producing process, not just numeric counter 1');
});

test('same-process config invalidation rejects real previously-produced admission', async () => {
  const d = await producedSnapshot();
  assert.ok(reviewer(await d.a.caps()).allocated > 0);
  await d.a.configure(config('gpt-6.1-sol-unserved'));
  const row = reviewer(await d.a.caps());
  assert.equal(row.queued, 5);
  assert.equal(row.allocated, row.running);
});

test('restart with a new tick grants only freshly admitted capacity', async () => {
  const d = await producedSnapshot();
  const b = await instance(d);
  await b.tick();
  const fresh = stateValue(d.store, 'capacity-v1');
  assert.equal(b.ticks(), 1);
  assert.deepEqual(fresh.reviewerAccountIdsByAgent.review, ['codex:a']);
  assert.ok(fresh.target > 0);
  assert.ok(reviewer(await b.caps()).allocated > 0, 'a restarted instance can grant again after its own real tick');
});

test('restart new tick with an unserved arm publishes empty admissions and grants nothing', async () => {
  const d = await producedSnapshot();
  const b = await instance({ ...d, raw: config('gpt-6.1-sol-unserved') });
  await b.tick();
  assert.deepEqual(stateValue(d.store, 'capacity-v1').reviewerAccountIdsByAgent.review, []);
  const row = reviewer(await b.caps());
  assert.equal(row.allocated, row.running);
});

test('fresh numeric-only admission cannot grant helpers but same-instance producer provenance can', async () => {
  const d = await producedSnapshot();
  const control = reviewer(await d.a.caps());
  assert.equal(control.queued, 5);
  assert.equal(control.running, 0);
  assert.ok(control.allocated > 0, 'same-instance producer control must grant before testing rejection');

  const numericOnly = copy(d.snapshot);
  delete numericOnly.reviewAdmissionEpoch;
  assert.equal(typeof numericOnly.reviewAdmissionGeneration, 'number');
  assert.equal(numericOnly.atMs, d.clock(), 'numeric-only snapshot is fresh, not rejected for age');
  assert.deepEqual(numericOnly.reviewerAccountIdsByAgent.review, ['codex:a']);
  d.store.set(`${COMPANY}/capacity-v1`, numericOnly);
  const rejected = reviewer(await d.a.caps());
  assert.equal(rejected.queued, 5, 'rejected provenance must not erase reviewer demand');
  assert.equal(rejected.running, 0);
  assert.equal(rejected.allocated, rejected.running, 'a numeric generation without current-instance epoch cannot authorize helpers');
  assert.equal(rejected.maxConcurrentRuns, rejected.running);

  assert.equal(typeof d.snapshot.reviewAdmissionEpoch, 'string', 'real producer must publish its current instance epoch');
  assert.ok(d.snapshot.reviewAdmissionEpoch.length > 0);
  d.store.set(`${COMPANY}/capacity-v1`, copy(d.snapshot));
  const restored = reviewer(await d.a.caps());
  assert.equal(restored.allocated, control.allocated, 'restoring real same-instance provenance restores admission');
  assert.equal(restored.maxConcurrentRuns, restored.allocated);
});
