import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';
import { projectProducerEpoch } from './producer-evidence.mjs';

const COMPANY = 'acme';
const NOW = Date.parse('2026-10-25T12:00:00Z');
const MIN = 60000;
const enabled = { allocation: { blockingPriority: true } };
const issue = (id, agentId, overrides = {}) => ({
  id, assigneeAgentId: agentId, status: 'todo', priority: 'medium', blockedBy: [], ...overrides,
});
const byId = body => new Map(body.agents.map(row => [row.agentId, row]));
const key = stateKey => ({ scopeKind: 'company', scopeId: COMPANY, namespace: 'model-capacity', stateKey });

// Exercise the public API and registered tick without changing the existing
// acceptance suites. All lane/credential evidence here is synthetic.
async function drive({ issues, config = enabled, cap = null, failStatus = null }) {
  let now = NOW;
  let used = 0.3;
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const reads = [];
  if (cap) store.set(JSON.stringify(key('capacity-v1')), cap);
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  await plugin.setup({
    config: { get: async () => ({ ...config, cliproxy: {
      laneKeySecretRef: { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' },
    } }) },
    state: {
      get: async k => store.get(JSON.stringify(k)) ?? null,
      set: async (k, value) => { store.set(JSON.stringify(k), value); },
    },
    secrets: { resolve: async () => 'synthetic-lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness({
      observedAt: new Date(now).toISOString(),
      accounts: [{
        lane: 'codex-1', provider: 'codex', accountKey: 'c1', health: 'healthy', models: ['gpt-6.1-sol'],
        weekly: { used, resetsAt: new Date(NOW + 2 * 60 * MIN).toISOString() },
        fiveHour: { used: 0.1, resetsAt: new Date(NOW + 4 * 60 * MIN).toISOString() },
        observedAt: new Date(now).toISOString(), quality: 'live',
      }],
    }, now) }) },
    agents: { get: async () => null, getQueuedRunCounts: async () => [] },
    issues: { get: async () => null, list: async ({ companyId, status }) => {
      assert.equal(companyId, COMPANY);
      reads.push(status);
      if (status === failStatus) throw new Error('synthetic relation read failure');
      return issues.filter(row => row.status === status);
    } },
    jobs: { register: (name, fn) => { jobs.set(name, fn); } },
    events: { on: (name, fn) => { handlers.set(name, fn); } },
    logger: { info() {}, error() {} },
  });
  store.set(JSON.stringify(key('aa-snapshot-v1')), {
    fetchedAt: new Date(NOW).toISOString(), duplicateSlugs: [],
    rows: [{ slug: 'gpt-6.1-sol', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30,
      price1mInputTokens: 5, price1mOutputTokens: 25 }],
  });
  await plugin.onConfigChanged(config, { companyId: COMPANY });
  const api = async routeKey => {
    const response = await plugin.onApiRequest({ companyId: COMPANY, routeKey });
    assert.equal(response.status, 200);
    return response.body;
  };
  return {
    reads, api,
    setNow: ms => { now = ms; },
    setUsed: value => { used = value; },
    tick: () => jobs.get('quota-refresh')({ companyId: COMPANY }),
    run: (id, type) => handlers.get(type)({
      type, companyId: COMPANY, entityId: id, occurredAt: new Date(now).toISOString(),
      payload: { run: { agentId: 'worker', provider: 'codex', model: 'gpt-6.1-sol' } },
    }),
  };
}

const scarce = { atMs: NOW, target: 1, maxTotal: 75, calibration: 'measured', agentRunning: {} };

for (const status of ['in_review', 'backlog', 'blocked']) {
  test(`assigned ${status} cards are descendants but never priority roots`, async () => {
    const d = await drive({ cap: scarce, issues: [
      issue('a-ready', 'a', { priority: 'low' }),
      issue('b-ready', 'b'),
      issue('a-not-ready', 'a', { status, priority: 'high' }),
      issue('a-child', null, { status: 'blocked', blockedBy: [{ id: 'a-not-ready' }] }),
      issue('b-child', null, { status: 'blocked', blockedBy: [{ id: 'b-ready' }] }),
    ] });
    const body = await d.api('caps');
    const rows = byId(body);
    assert.deepEqual(body.allocation, { blockingPriority: true });
    assert.deepEqual(rows.get('a').allocationPriority, { blockingFanOut: 0, cardPriority: 'low', weight: 1 });
    assert.deepEqual(rows.get('b').allocationPriority, { blockingFanOut: 1, cardPriority: 'medium', weight: 4 });
    assert.equal(rows.get('a').queued, 1);
    assert.equal(rows.get('a').allocated, 0);
    assert.equal(rows.get('b').allocated, 1);
  });
}

test('equal-size contradictory edge sets retain the exact legacy caps response', async () => {
  const issues = [
    issue('root', 'a', { priority: 'high', blocks: [{ id: 'x' }] }),
    issue('x', null, { status: 'blocked', blocks: [] }),
    issue('y', null, { status: 'blocked', blockedBy: [{ id: 'root' }], blocks: [] }),
    ...Array.from({ length: 4 }, (_, i) => issue(`b-${i}`, 'b', { blocks: [] })),
  ];
  const legacy = await drive({ cap: scarce, issues, config: {} });
  const d = await drive({ cap: scarce, issues });
  const body = await d.api('caps');
  const { allocation, ...fallback } = body;
  assert.deepEqual(allocation, { blockingPriority: false, error: 'priority-unavailable' });
  assert.deepEqual(fallback, await legacy.api('caps'));
  assert.equal(byId(body).get('a').allocated, 1);
  assert.equal(byId(body).get('b').allocated, 4);
});

async function targetScenario({ priority, relations = false, failStatus = null, recoverRelations = false }) {
  const issues = Array.from({ length: 11 }, (_, i) => issue(`q-${i}`, 'worker'));
  if (!relations || recoverRelations) for (const row of issues) delete row.blockedBy;
  const d = await drive({ issues, failStatus, config: {
    allocation: { blockingPriority: priority }, roles: { doerAgentIds: ['worker'] },
    concurrency: { meanRunDurationHours: 1.1, maxTotal: 75 },
  } });
  await d.tick();
  d.setNow(NOW + 10 * MIN);
  for (let i = 0; i < 6; i++) await d.run(`run-${i}`, 'agent.run.started');
  d.setNow(NOW + 20 * MIN);
  for (let i = 0; i < 2; i++) await d.run(`run-${i}`, 'agent.run.finished');
  d.setNow(NOW + 30 * MIN);
  d.setUsed(0.328);
  await d.tick();
  // An ordinary demand refresh five seconds before the next minute tick.
  d.setNow(NOW + 31 * MIN - 5000);
  const warm = await d.api('caps');
  assert.equal(byId(warm).get('worker').queued, 11);
  issues.splice(1);
  if (recoverRelations) issues[0].blockedBy = [];
  d.setNow(NOW + 31 * MIN);
  d.setUsed(0.329);
  await d.tick();
  return { capacity: await d.api('capacity'), caps: await d.api('caps'), reads: d.reads };
}

for (const [label, options] of [
  ['missing relation arrays', {}],
  ['failed relation read', { relations: true, failStatus: 'blocked' }],
]) {
  test(`registered tick preserves legacy target and demand TTL with ${label}`, async () => {
    const legacy = await targetScenario({ priority: false, ...options });
    const d = await targetScenario({ priority: true, ...options });
    assert.equal(legacy.capacity.target, 15);
    assert.equal(legacy.capacity.demandBound, 15);
    assert.deepEqual(projectProducerEpoch(d.capacity), projectProducerEpoch(legacy.capacity));
    const { allocation, ...fallback } = d.caps;
    assert.deepEqual(allocation, { blockingPriority: false, error: 'priority-unavailable' });
    assert.deepEqual(fallback, legacy.caps);
    const worker = byId(d.caps).get('worker');
    assert.equal(worker.running, 4);
    assert.equal(worker.queued, 11);
    assert.equal(worker.allocated, 15);
  });
}

for (const recoverRelations of [false, true]) {
  test(`usable priority metadata shares fresh target/caps demand (recovery=${recoverRelations})`, async () => {
    const d = await targetScenario({ priority: true, relations: true, recoverRelations });
    assert.equal(d.capacity.target, 5);
    assert.equal(d.capacity.demandBound, 5);
    assert.deepEqual(d.caps.allocation, { blockingPriority: true });
    const worker = byId(d.caps).get('worker');
    assert.equal(worker.running, 4);
    assert.equal(worker.queued, 1);
    assert.equal(worker.allocated, 5);
    assert.deepEqual(worker.allocationPriority, { blockingFanOut: 0, cardPriority: 'medium', weight: 2 });
  });
}
