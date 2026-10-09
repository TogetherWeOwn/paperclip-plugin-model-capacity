import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateDemandCaps } from '../src/concurrency.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';

const REASONS = new Set(['full-demand', 'headroom', 'proportional', 'floor-running', 'trimmed-over-pace', 'capped-ceiling']);

// The live 08:00Z shape: DevOps 6 running + 11 queued with total running 15
// far below target 35. No throttle pressure: DevOps covers its full demand.
test('live shape: below target every agent covers full demand', () => {
  const agents = allocateDemandCaps(35, [
    { agentId: 'devops', running: 6, queued: 11, overPace: false },
    { agentId: 'worker', running: 8, queued: 0, overPace: false },
    { agentId: 'reviewer', running: 1, queued: 3, overPace: false },
  ]);
  const byId = new Map(agents.map(a => [a.agentId, a]));
  assert.equal(byId.get('devops').demand, 17);
  assert.ok(byId.get('devops').allocated >= 17);
  assert.equal(byId.get('devops').reason, 'full-demand');
  // Idle queue, still headroom: never capped at (or below) running.
  assert.equal(byId.get('worker').allocated, 9);
  assert.equal(byId.get('worker').reason, 'headroom');
  assert.equal(byId.get('reviewer').allocated, 4);
  for (const a of agents) {
    assert.ok(a.allocated >= a.running, a.agentId);
    assert.equal(a.maxConcurrentRuns, a.allocated);
    assert.ok(REASONS.has(a.reason), a.reason);
  }
  // Demand order, highest first.
  assert.deepEqual(agents.map(a => a.agentId), ['devops', 'worker', 'reviewer']);
});

test('no trim below target even for over-pace burners', () => {
  const agents = allocateDemandCaps(35, [
    { agentId: 'devops', running: 6, queued: 11, overPace: true },
  ]);
  assert.equal(agents[0].allocated, 17);
  assert.equal(agents[0].reason, 'full-demand');
});

test('at/above target: proportional shares floored at running', () => {
  const agents = allocateDemandCaps(10, [
    { agentId: 'a', running: 5, queued: 5, overPace: false },
    { agentId: 'b', running: 5, queued: 5, overPace: false },
  ]);
  assert.deepEqual(agents.map(a => a.allocated), [5, 5]);
  assert.ok(agents.every(a => a.reason === 'proportional'));
});

test('above target: over-pace agent with most in-flight trims to running', () => {
  const agents = allocateDemandCaps(12, [
    { agentId: 'hot', running: 4, queued: 16, overPace: true },
    { agentId: 'steady', running: 11, queued: 0, overPace: false },
  ]);
  const byId = new Map(agents.map(a => [a.agentId, a]));
  // Shares split 12 by 20:11 -> 8/4; hot trims 8 -> 4, steady floors at 11.
  assert.equal(byId.get('hot').allocated, 4);
  assert.equal(byId.get('hot').reason, 'trimmed-over-pace');
  assert.equal(byId.get('steady').allocated, 11);
  assert.equal(byId.get('steady').reason, 'floor-running');
  // Floors hold the sum above target; reported, never hidden.
  assert.ok(agents.reduce((s, a) => s + a.allocated, 0) > 12);
});

test('floors are absolute: shed target and ceiling never undercut running', () => {
  const shed = allocateDemandCaps(0, [{ agentId: 'a', running: 3, queued: 5, overPace: true }]);
  assert.equal(shed[0].allocated, 3);
  assert.equal(shed[0].reason, 'floor-running');
  const capped = allocateDemandCaps(35, [{ agentId: 'a', running: 0, queued: 10, overPace: false }], 5);
  assert.equal(capped[0].allocated, 5);
  assert.equal(capped[0].reason, 'capped-ceiling');
  const overCeilingRunning = allocateDemandCaps(35, [{ agentId: 'a', running: 9, queued: 0, overPace: false }], 5);
  assert.equal(overCeilingRunning[0].allocated, 9);
  assert.equal(overCeilingRunning[0].reason, 'floor-running');
});

test('empty and null targets allocate nothing', () => {
  assert.deepEqual(allocateDemandCaps(10, []), []);
  assert.deepEqual(allocateDemandCaps(null, [{ agentId: 'a', running: 1, queued: 1 }]), []);
  assert.deepEqual(allocateDemandCaps(10, [{ agentId: '', running: 1, queued: 1 }]), []);
});

// --- /caps handler wiring: running comes from the ledger, queued from issues.

const TICK = Date.parse('2026-10-08T23:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
const aaRows = () => ([
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
]);
const laneBody = (weeklyUsed, observedAt) => ({
  observedAt,
  accounts: [{
    lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy',
    weekly: { used: weeklyUsed, resetsAt: '2026-10-15T22:59:00Z' },
    fiveHour: { used: 0.1, resetsAt: '2026-10-09T03:59:00Z' },
    observedAt, quality: 'live',
  }],
});
const runEvent = (runId, atMs, agentId, type = 'agent.run.started') => ({
  type, companyId: 'acme', entityId: runId,
  payload: { run: { agentId, provider: 'claude' } },
  occurredAt: new Date(atMs).toISOString(),
});

function drive({ nowMs, config = {}, laneUsed = 0.3, issueLists = {} }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = nowMs;
  let lane = laneBody(laneUsed, new Date(now).toISOString());
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET } }) },
    state: {
      get: async k => store.get(skey(k)) ?? null,
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => lane }) },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async ({ status } = {}) => issueLists[status] ?? [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now });
  return {
    setNow: ms => { now = ms; },
    setLane: (used) => { lane = laneBody(used, new Date(now).toISOString()); },
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: () => jobs.get('shadow-tick')({}),
    fire: (e) => handlers.get(e.type)(e),
    api: (routeKey) => plugin.onApiRequest({ companyId: 'acme', routeKey }),
  };
}

test('/caps exposes demand, running, allocated, reason with ledger running counts', async () => {
  const queued = Array.from({ length: 11 }, (_, i) => ({ id: `q${i}`, status: 'todo', assigneeAgentId: 'devops' }));
  queued.push({ id: 'r1', status: 'todo', assigneeAgentId: 'reviewer' });
  const d = drive({ nowMs: TICK, config: { enforce: true }, issueLists: { todo: queued, in_progress: [] } });
  await d.setup();
  await d.tick();
  d.setNow(TICK + 10 * 60000);
  for (let i = 1; i <= 6; i++) await d.fire(runEvent(`devops-run-${i}`, TICK + 10 * 60000, 'devops'));
  await d.fire(runEvent('reviewer-run-1', TICK + 10 * 60000, 'reviewer'));
  d.setNow(TICK + 20 * 60000);
  await d.fire(runEvent('devops-run-1', TICK + 20 * 60000, 'devops', 'agent.run.finished'));
  await d.fire(runEvent('devops-run-2', TICK + 20 * 60000, 'devops', 'agent.run.finished'));
  d.setNow(TICK + 30 * 60000);
  d.setLane(0.328);
  await d.tick();
  const caps = await d.api('caps');
  assert.equal(caps.status, 200);
  assert.ok(caps.body.target > 0);
  const byId = new Map(caps.body.agents.map(a => [a.agentId, a]));
  // Ledger running: 4 devops (2 finished) + 1 reviewer; demand adds queued.
  assert.equal(byId.get('devops').running, 4);
  assert.equal(byId.get('devops').queued, 11);
  assert.equal(byId.get('devops').demand, 15);
  assert.equal(byId.get('reviewer').running, 1);
  assert.equal(byId.get('reviewer').demand, 2);
  const totalRunning = caps.body.agents.reduce((s, a) => s + a.running, 0);
  for (const a of caps.body.agents) {
    assert.ok(a.allocated >= a.running, `${a.agentId}: cap below running`);
    assert.equal(a.maxConcurrentRuns, a.allocated);
    assert.ok(REASONS.has(a.reason), a.reason);
    if (totalRunning < caps.body.target) {
      assert.ok(a.allocated >= a.demand, `${a.agentId}: throttled below demand under target`);
    }
  }
});
