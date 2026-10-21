import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateDemandCaps } from '../src/concurrency.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import {
  createBreakerStore, breakerKey, breakerStoreFromJSON, breakerStoreToJSON,
  noteKnownArms, recordArmFailure, sanitizeBreakers,
} from '../src/breakers.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const REASONS = new Set(['full-demand', 'headroom', 'proportional', 'floor-running', 'capped-ceiling']);

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

test('above target: firewall holds, fleet starts nothing new', () => {
  // Review round 3: A and B run 20 each, C has 60 queued, target 35. The old
  // floor-after-split handed C 21 new slots (sum 61 on 40 running). Running
  // is now subtracted before splitting, so R = 0 and every agent holds.
  const agents = allocateDemandCaps(35, [
    { agentId: 'a', running: 20, queued: 0, overPace: false },
    { agentId: 'b', running: 20, queued: 0, overPace: true },
    { agentId: 'c', running: 0, queued: 60, overPace: false },
  ]);
  const byId = new Map(agents.map(a => [a.agentId, a]));
  assert.equal(byId.get('a').allocated, 20);
  assert.equal(byId.get('b').allocated, 20);
  assert.equal(byId.get('c').allocated, 0);
  assert.ok(agents.every(a => a.reason === 'proportional'));
  // Zero new slots: the sum is exactly the pre-existing running count.
  assert.equal(agents.reduce((s, a) => s + a.allocated, 0), 40);
  assert.equal(agents.reduce((s, a) => s + Math.max(0, a.allocated - a.running), 0), 0);
});

test('above target with headroom in target still grants nothing new past running', () => {
  // totalRunning 15 >= T 12: R = 0, both agents hold running, over-pace or not.
  const agents = allocateDemandCaps(12, [
    { agentId: 'hot', running: 4, queued: 16, overPace: true },
    { agentId: 'steady', running: 11, queued: 0, overPace: false },
  ]);
  const byId = new Map(agents.map(a => [a.agentId, a]));
  assert.equal(byId.get('hot').allocated, 4);
  assert.equal(byId.get('steady').allocated, 11);
  assert.ok(agents.every(a => a.reason === 'proportional'));
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

test('below-target queue spike shares the ceiling, not the target', () => {
  // Review PoC: 5 x {running:1, queued:20} at target 35, maxTotal 75 had
  // allocated [21 x 5] = 105, overshooting the fleet ceiling. Running-first
  // shares the ceiling out: R = 75 - 5 = 70 by demand, 14 each on top of
  // running 1.
  const spike = Array.from({ length: 5 }, (_, i) => ({ agentId: `a${i}`, running: 1, queued: 20, overPace: false }));
  const agents = allocateDemandCaps(35, spike, 75);
  const sum = agents.reduce((s, a) => s + a.allocated, 0);
  assert.ok(sum <= 75, `fleet sum ${sum} exceeds maxTotal`);
  for (const a of agents) {
    assert.ok(a.allocated >= a.running, a.agentId);
    assert.equal(a.maxConcurrentRuns, a.allocated);
    assert.ok(REASONS.has(a.reason), a.reason);
  }
  // Equal demands split the ceiling remainder evenly.
  assert.deepEqual(agents.map(a => a.allocated), [15, 15, 15, 15, 15]);
});

test('one more queued item never halves the fleet (14 -> 15 stays 15)', () => {
  // Review round 3: 5 x {running:1, queued:14} got 15 each (wants fit the
  // ceiling exactly); one more queued item each fell back to sharing the
  // target and every agent dropped to 7. The fallback now shares the
  // ceiling, so both land on 15.
  for (const queued of [14, 15]) {
    const agents = allocateDemandCaps(35,
      Array.from({ length: 5 }, (_, i) => ({ agentId: `a${i}`, running: 1, queued, overPace: i === 0 })),
      75);
    assert.deepEqual(agents.map(a => a.allocated), [15, 15, 15, 15, 15], `queued=${queued}`);
  }
});

test("more queued never lowers an agent's own cap (monotone sweep)", () => {
  // Deterministic sweep across the fit/fallback boundary: own queued rises
  // 0..30 against fixed teammates, own allocation never drops.
  const teammates = [
    { agentId: 't0', running: 3, queued: 18, overPace: false },
    { agentId: 't1', running: 0, queued: 22, overPace: true },
    { agentId: 't2', running: 7, queued: 2, overPace: false },
  ];
  let prev = -1;
  for (let q = 0; q <= 30; q++) {
    const agents = allocateDemandCaps(35, [
      { agentId: 'me', running: 2, queued: q, overPace: q % 2 === 0 },
      ...teammates,
    ], 75);
    const me = agents.find(a => a.agentId === 'me');
    assert.ok(me.allocated >= me.running, `q=${q}: cap below running`);
    assert.ok(me.allocated >= prev, `q=${q}: cap ${me.allocated} < prev ${prev} (non-monotone)`);
    prev = me.allocated;
  }
});

test("a '__proto__' agentId counts in caps without polluting Object.prototype", () => {
  const agents = allocateDemandCaps(35, [
    { agentId: '__proto__', running: 2, queued: 3, overPace: false },
    { agentId: 'devops', running: 1, queued: 0, overPace: false },
  ]);
  const byId = new Map(agents.map(a => [a.agentId, a]));
  assert.equal(byId.get('__proto__').running, 2);
  assert.equal(byId.get('__proto__').demand, 5);
  assert.equal(byId.get('__proto__').allocated, 5);
  assert.equal(byId.get('devops').allocated, 2);
  assert.equal({}.running, undefined);
  assert.equal(Object.prototype.running, undefined);
});

// --- /caps handler wiring: running comes from the ledger, queued from issues.

const TICK = Date.parse('2026-10-08T23:00:00Z');
const MIN = 60 * 1000;
const HOUR = 3600 * 1000;
const REVIEWER_MODEL = 'muse-wonder-full-1.0-contributor';
const CODEX_MODEL = 'gpt-6.1-sol';
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
const BREAKER_SKEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'breaker-v1' };
const LEDGER_SKEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'ledger-v1' };
const BREAKER_CFG = sanitizeBreakers();
const aaRows = (extra = []) => ([
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
  ...extra,
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
const runEvent = (runId, atMs, agentId, type = 'agent.run.started', runFields = {}) => ({
  type, companyId: 'acme', entityId: runId,
  payload: { run: { agentId, provider: 'claude', ...runFields } },
  occurredAt: new Date(atMs).toISOString(),
});

// Host-aggregated queued-run seam: agents.getQueuedRunCounts({ companyId })
// -> [{ agentId, queued }]. Derive the same counts from the raw fixture rows,
// applying the predicate the host applies in prod (queued status +
// same-company rows only) so the fixture stays honest. No real database.
function queuedCounts(runs, companyId) {
  const counts = new Map();
  for (const run of runs) {
    if (run.company_id !== companyId) continue;
    if (run.status !== 'queued') continue;
    if (typeof run.agent_id !== 'string' || run.agent_id.length === 0) continue;
    counts.set(run.agent_id, (counts.get(run.agent_id) ?? 0) + 1);
  }
  return [...counts].map(([agentId, queued]) => ({ agentId, queued }));
}

function drive({ nowMs, config = {}, laneUsed = 0.3, issueLists = {}, accounts = null, agentGets = {}, snapshotRows = aaRows(), heartbeatRuns = null }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = nowMs;
  let lane = accounts
    ? { observedAt: new Date(now).toISOString(), accounts }
    : laneBody(laneUsed, new Date(now).toISOString());
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET } }) },
    state: {
      get: async k => store.get(skey(k)) ?? null,
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness(lane, now) }) },
    agents: {
      get: async id => agentGets[id] ?? null,
      ...(heartbeatRuns == null ? {} : {
        getQueuedRunCounts: async ({ companyId } = {}) => queuedCounts(heartbeatRuns, companyId),
      }),
    },
    issues: { get: async () => null, list: async ({ status } = {}) => issueLists[status] ?? [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  let plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return {
    setNow: ms => { now = ms; },
    setLane: used => { lane = laneBody(used, new Date(now).toISOString()); },
    setAccounts: list => { lane = { observedAt: new Date(now).toISOString(), accounts: list }; },
    seed: (k, v) => { store.set(skey(k), v); },
    // Fresh plugin on the same io store: the next tick cold-loads persisted
    // state (proves the persisted breaker form works, like review-breaker).
    reboot: () => { plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false }); },
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: snapshotRows, duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: () => jobs.get('shadow-tick')({}),
    fire: e => handlers.get(e.type)(e),
    hook: (runId, agentId) => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId, issueId: null, adapterType: 'claude-code',
      invocationSource: 'test', wakeReason: null, agentDefaultModel: null, previous: null,
      issueOverrideModel: null, deadlineMs: 1500,
    }),
    api: routeKey => plugin.onApiRequest({ companyId: 'acme', routeKey }),
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

test('/caps keeps a pinned Reviewer within its Meta pace cap, not the fresh Codex fleet', async t => {
  const meta = {
    lane: 'meta-1', provider: 'meta', accountKey: 'm1', health: 'healthy', models: [REVIEWER_MODEL],
    weekly: { used: 0.9, resetsAt: new Date(TICK + 48 * HOUR).toISOString() },
    fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
    observedAt: new Date(TICK).toISOString(), quality: 'live',
  };
  const codex = {
    lane: 'codex-1', provider: 'codex', accountKey: 'c1', health: 'healthy', models: [CODEX_MODEL],
    weekly: { used: 0.01, resetsAt: new Date(TICK + 168 * HOUR).toISOString() },
    fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
    observedAt: new Date(TICK).toISOString(), quality: 'live',
  };
  const queued = Array.from({ length: 32 }, (_, i) => ({ id: `review-${i}`, status: 'todo', assigneeAgentId: 'reviewer' }));
  const d = drive({
    nowMs: TICK,
    config: {
      enforce: true,
      concurrency: { maxTotal: 75, meanRunDurationHours: 1.1 },
      roles: { keepAgentIds: ['reviewer'] },
    },
    accounts: [meta, codex],
    issueLists: { todo: queued, in_progress: [] },
    heartbeatRuns: queued.map(issue => ({
      id: `heartbeat-${issue.id}`, company_id: 'acme', agent_id: 'reviewer',
      status: 'queued', invocation_source: 'on_demand',
    })),
    agentGets: { reviewer: { adapterConfig: { model: REVIEWER_MODEL } } },
    snapshotRows: aaRows([
      { slug: REVIEWER_MODEL, intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
      { slug: CODEX_MODEL, intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
    ]),
  });
  await d.setup();
  await d.tick();
  // Build the two-point caps calibration while keeping an unpaced Codex fleet available.
  d.setNow(TICK + 10 * 60 * 1000);
  for (let i = 1; i <= 6; i++) {
    await d.fire(runEvent(`codex-run-${i}`, TICK + 10 * 60 * 1000, 'codex-worker', 'agent.run.started', {
      provider: 'codex', model: CODEX_MODEL,
    }));
  }
  d.setNow(TICK + 20 * 60 * 1000);
  for (let i = 1; i <= 2; i++) {
    await d.fire(runEvent(`codex-run-${i}`, TICK + 20 * 60 * 1000, 'codex-worker', 'agent.run.finished', {
      provider: 'codex', model: CODEX_MODEL,
    }));
  }
  d.setNow(TICK + 30 * 60 * 1000);
  d.setAccounts([
    { ...meta, observedAt: new Date(TICK + 30 * 60 * 1000).toISOString(), weekly: { ...meta.weekly, used: 0.93 } },
    { ...codex, observedAt: new Date(TICK + 30 * 60 * 1000).toISOString(), weekly: { ...codex.weekly, used: 0.013 } },
  ]);
  await d.tick();

  const initialCapacity = (await d.api('capacity')).body;
  const initialPools = new Map(initialCapacity.paceGuard.pools.map(pool => [pool.pool, pool]));
  assert.equal(initialPools.get('meta')?.cap, 4, `the ahead-of-plan Meta pool has a four-run pace cap: ${JSON.stringify(initialPools.get('meta'))}`);
  assert.equal(initialPools.get('codex')?.state, 'on-plan', 'fresh Codex capacity is unpaced');
  assert.equal(initialPools.get('codex')?.inFlight, 4, 'the Codex fleet remains active beside Meta');

  d.setNow(TICK + 31 * 60 * 1000);
  await d.fire(runEvent('kept-reviewer-run', TICK + 31 * 60 * 1000, 'reviewer', 'agent.run.started', {
    provider: 'meta', model: REVIEWER_MODEL,
  }));
  assert.deepEqual(await d.hook('kept-reviewer-run', 'reviewer'), { kind: 'keep' });
  d.setNow(TICK + 32 * 60 * 1000);
  await d.tick();

  const caps = await d.api('caps');
  assert.equal(caps.status, 200);
  const reviewer = caps.body.agents.find(agent => agent.agentId === 'reviewer');
  assert.ok(reviewer, `kept Reviewer demand appears in /caps: ${JSON.stringify(caps.body.agents)}`);
  assert.equal(reviewer.queued, 32, 'the Reviewer has high queued demand');
  assert.equal(reviewer.running, 1, 'the kept Reviewer run appears in the ledger-backed running count');

  const capacity = (await d.api('capacity')).body;
  const metaPool = capacity.paceGuard.pools.find(pool => pool.pool === 'meta');
  assert.equal(metaPool.cap, 4);
  assert.equal(metaPool.inFlight, 1, 'the running kept Reviewer record is charged to its Meta serving pool');
  assert.equal(capacity.paceGuard.unattributedInFlight, 0, 'the kept run is not left unattributed');
  assert.ok(reviewer.maxConcurrentRuns <= 4,
    `Reviewer cap ${reviewer.maxConcurrentRuns} must not borrow fresh Codex fleet capacity`);
});

test('/capacity opens every known arm on a kept-run balance failure; ambiguous text trips nothing', async () => {
  const meta = {
    lane: 'meta-1', provider: 'meta', accountKey: 'm1', health: 'healthy', models: [REVIEWER_MODEL],
    weekly: { used: 0.3, resetsAt: new Date(TICK + 168 * HOUR).toISOString() },
    fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
    observedAt: new Date(TICK).toISOString(), quality: 'live',
  };
  const codex = {
    lane: 'codex-1', provider: 'codex', accountKey: 'c1', health: 'healthy', models: [CODEX_MODEL],
    weekly: { used: 0.3, resetsAt: new Date(TICK + 168 * HOUR).toISOString() },
    fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
    observedAt: new Date(TICK).toISOString(), quality: 'live',
  };
  const d = drive({
    nowMs: TICK,
    config: {
      enforce: true,
      concurrency: { maxTotal: 75, meanRunDurationHours: 1.1 },
      roles: { keepAgentIds: ['reviewer'] },
    },
    accounts: [meta, codex],
    issueLists: { todo: [], in_progress: [] },
    agentGets: { reviewer: { adapterConfig: { model: REVIEWER_MODEL } } },
    snapshotRows: aaRows([
      { slug: REVIEWER_MODEL, intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
      { slug: CODEX_MODEL, intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
    ]),
  });
  await d.setup();
  await d.tick();
  const before = (await d.api('capacity')).body;
  const metaAcct = before.accounts.find(a => a.provider === 'meta').accountId;
  const codexAcct = before.accounts.find(a => a.provider === 'codex').accountId;
  const metaRungs = before.accounts.find(a => a.provider === 'meta').arms.map(a => a.armId);
  assert.ok(metaRungs.length >= 1, `meta ladder has servable arms: ${JSON.stringify(metaRungs)}`);

  // A kept Reviewer run (no armId) fails with a 402 balance exhaustion; a
  // routed run on the other account fails with ambiguous balance wording.
  await d.fire(runEvent('kept-run-1', TICK, 'reviewer', 'agent.run.started', { provider: 'meta', model: REVIEWER_MODEL }));
  await d.fire(runEvent('kept-run-1', TICK, 'reviewer', 'agent.run.failed', {
    provider: 'meta', model: REVIEWER_MODEL, error: '402 usage balance exhausted',
  }));
  await d.fire(runEvent('doer-run-1', TICK, 'doer', 'agent.run.started', { provider: 'codex', model: CODEX_MODEL }));
  await d.fire(runEvent('doer-run-1', TICK, 'doer', 'agent.run.failed', {
    provider: 'codex', model: CODEX_MODEL, error: '402 balance check unavailable; retry after account verification',
  }));
  await d.tick();

  const cap = (await d.api('capacity')).body;
  assert.ok(cap.breakerUnavailableAccountIds.includes(metaAcct),
    `exhausted meta account is unavailable: ${JSON.stringify(cap.breakerUnavailableAccountIds)}`);
  assert.ok(!cap.breakerUnavailableAccountIds.includes(codexAcct),
    `ambiguous text leaves codex available: ${JSON.stringify(cap.breakerUnavailableAccountIds)}`);
  const metaBreakers = new Map(cap.armBreakers.filter(e => e.accountId === metaAcct).map(e => [e.armId, e.status]));
  for (const armId of metaRungs) {
    assert.equal(metaBreakers.get(armId), 'open', `known arm ${armId} opens on balance exhaustion`);
  }
  const codexOpen = cap.armBreakers.filter(e => e.accountId === codexAcct && e.status === 'open');
  assert.deepEqual(codexOpen, [], 'ambiguous balance wording trips no codex arm');
});

test('/caps excludes only the fully breaker-open account from kept pool slots', async t => {
  const meta = {
    lane: 'meta-1', provider: 'meta', accountKey: 'm1', health: 'healthy', models: [REVIEWER_MODEL],
    weekly: { used: 0.9, resetsAt: new Date(TICK + 48 * HOUR).toISOString() },
    fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
    observedAt: new Date(TICK).toISOString(), quality: 'live',
  };
  const codex = {
    lane: 'codex-1', provider: 'codex', accountKey: 'c1', health: 'healthy', models: [CODEX_MODEL],
    weekly: { used: 0.01, resetsAt: new Date(TICK + 168 * HOUR).toISOString() },
    fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
    observedAt: new Date(TICK).toISOString(), quality: 'live',
  };
  const queued = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `a-${i}`, status: 'todo', assigneeAgentId: 'keeperA' })),
    ...Array.from({ length: 8 }, (_, i) => ({ id: `b-${i}`, status: 'todo', assigneeAgentId: 'keeperB' })),
  ];
  const d = drive({
    nowMs: TICK,
    config: {
      enforce: true,
      concurrency: { maxTotal: 75, meanRunDurationHours: 1.1 },
      roles: { keepAgentIds: ['keeperA', 'keeperB'] },
    },
    accounts: [meta, codex],
    issueLists: { todo: queued, in_progress: [] },
    heartbeatRuns: queued.map(issue => ({
      id: `heartbeat-${issue.id}`, company_id: 'acme', agent_id: issue.assigneeAgentId,
      status: 'queued', invocation_source: 'on_demand',
    })),
    agentGets: {
      keeperA: { adapterConfig: { model: REVIEWER_MODEL } },
      keeperB: { adapterConfig: { model: CODEX_MODEL } },
    },
    snapshotRows: aaRows([
      { slug: REVIEWER_MODEL, intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
      { slug: CODEX_MODEL, intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
    ]),
  });
  await d.setup();
  await d.tick();
  const before = (await d.api('capacity')).body;
  const metaAcct = before.accounts.find(a => a.provider === 'meta').accountId;
  const codexAcct = before.accounts.find(a => a.provider === 'codex').accountId;
  const metaArms = before.accounts.find(a => a.provider === 'meta').arms.map(a => a.armId);
  const codexArms = before.accounts.find(a => a.provider === 'codex').arms.map(a => a.armId);
  assert.ok(metaArms.length >= 1 && codexArms.length >= 1,
    `both ladders have servable arms: meta=${JSON.stringify(metaArms)} codex=${JSON.stringify(codexArms)}`);

  // Seed breaker-v1: meta fully open (fresh), codex half-open (cool-off elapsed).
  const seed = createBreakerStore();
  for (const armId of metaArms) {
    recordArmFailure(seed, metaAcct, armId, { atMs: TICK - 2 * MIN, errorText: 'auth_unavailable' }, TICK - 2 * MIN, BREAKER_CFG);
    recordArmFailure(seed, metaAcct, armId, { atMs: TICK - MIN, errorText: 'auth_unavailable' }, TICK - MIN, BREAKER_CFG);
  }
  for (const armId of codexArms) {
    recordArmFailure(seed, codexAcct, armId, { atMs: TICK - 7 * HOUR, errorText: 'auth_unavailable' }, TICK - 7 * HOUR, BREAKER_CFG);
    recordArmFailure(seed, codexAcct, armId, { atMs: TICK - 7 * HOUR + MIN, errorText: 'auth_unavailable' }, TICK - 7 * HOUR + MIN, BREAKER_CFG);
  }
  noteKnownArms(seed, [
    ...metaArms.map(armId => ({ accountId: metaAcct, armId })),
    ...codexArms.map(armId => ({ accountId: codexAcct, armId })),
  ], TICK);
  // Retained history for a removed arm must not make a fully-open ladder available.
  seed.known['stale-arm'] = { accountId: metaAcct, armId: 'meta-removed-arm', lastSeen: TICK - HOUR };
  assert.ok(!metaArms.includes('meta-removed-arm'), 'the retained arm is not in the current Meta ladder');
  const persisted = JSON.parse(JSON.stringify(breakerStoreToJSON(seed, { nowMs: TICK, cfg: BREAKER_CFG })));
  const restored = breakerStoreFromJSON(persisted);
  const staleKey = breakerKey(metaAcct, 'meta-removed-arm');
  assert.deepEqual(restored.known[staleKey], {
    accountId: metaAcct, armId: 'meta-removed-arm', lastSeen: TICK - HOUR,
  }, 'the removed arm survives breaker serialization and loading');
  assert.equal(restored.arms[staleKey], undefined, 'the removed arm has no breaker entry');
  d.seed(BREAKER_SKEY, persisted);

  // Reboot so the tick cold-loads the seed.
  d.reboot();
  await d.setup();
  await d.tick();
  const loaded = (await d.api('capacity')).body;
  assert.ok(loaded.breakerUnavailableAccountIds.includes(metaAcct),
    `fully-open meta is unavailable: ${JSON.stringify(loaded.breakerUnavailableAccountIds)}`);
  assert.ok(!loaded.breakerUnavailableAccountIds.includes(codexAcct),
    `half-open codex stays available: ${JSON.stringify(loaded.breakerUnavailableAccountIds)}`);
  const statusOf = new Map(loaded.armBreakers.map(e => [`${e.accountId} ${e.armId}`, e.status]));
  for (const armId of metaArms) assert.equal(statusOf.get(`${metaAcct} ${armId}`), 'open');
  for (const armId of codexArms) assert.equal(statusOf.get(`${codexAcct} ${armId}`), 'half-open');

  // Calibration dance so /caps has a target (mirrors the demand test above).
  d.setNow(TICK + 10 * MIN);
  for (let i = 1; i <= 6; i++) {
    await d.fire(runEvent(`codex-run-${i}`, TICK + 10 * MIN, 'codex-worker', 'agent.run.started', {
      provider: 'codex', model: CODEX_MODEL,
    }));
  }
  d.setNow(TICK + 20 * MIN);
  for (let i = 1; i <= 2; i++) {
    await d.fire(runEvent(`codex-run-${i}`, TICK + 20 * MIN, 'codex-worker', 'agent.run.finished', {
      provider: 'codex', model: CODEX_MODEL,
    }));
  }
  d.setNow(TICK + 30 * MIN);
  d.setAccounts([
    { ...meta, observedAt: new Date(TICK + 30 * MIN).toISOString(), weekly: { ...meta.weekly, used: 0.93 } },
    { ...codex, observedAt: new Date(TICK + 30 * MIN).toISOString(), weekly: { ...codex.weekly, used: 0.013 } },
  ]);
  await d.tick();

  const cap = (await d.api('capacity')).body;
  assert.ok(cap.breakerUnavailableAccountIds.includes(metaAcct), 'meta stays unavailable after the dance');
  assert.ok(!cap.breakerUnavailableAccountIds.includes(codexAcct), 'codex stays available after the dance');

  const caps = await d.api('caps');
  assert.equal(caps.status, 200);
  const byId = new Map(caps.body.agents.map(a => [a.agentId, a]));
  const a = byId.get('keeperA');
  const b = byId.get('keeperB');
  assert.ok(a && b, `both keepers appear in /caps: ${JSON.stringify(caps.body.agents)}`);
  assert.ok(a.queued > 0 && b.queued > 0, 'both keepers have demand');
  assert.equal(a.maxConcurrentRuns, a.running, 'keeperA on the fully-open account holds running only');
  assert.ok(b.maxConcurrentRuns >= 1, `keeperB on the half-open account keeps pool slots (got ${b.maxConcurrentRuns})`);
});

test('/capacity trips the serving account on balance exhaustion, not the shadow guess', async () => {
  const meta = {
    lane: 'meta-1', provider: 'meta', accountKey: 'm1', health: 'healthy', models: [REVIEWER_MODEL],
    weekly: { used: 0.3, resetsAt: new Date(TICK + 168 * HOUR).toISOString() },
    fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
    observedAt: new Date(TICK).toISOString(), quality: 'live',
  };
  const codex = {
    lane: 'codex-1', provider: 'codex', accountKey: 'c1', health: 'healthy', models: [CODEX_MODEL],
    weekly: { used: 0.3, resetsAt: new Date(TICK + 168 * HOUR).toISOString() },
    fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
    observedAt: new Date(TICK).toISOString(), quality: 'live',
  };
  const d = drive({
    nowMs: TICK,
    config: { enforce: false, concurrency: { maxTotal: 75, meanRunDurationHours: 1.1 } },
    accounts: [meta, codex],
    issueLists: { todo: [], in_progress: [] },
    snapshotRows: aaRows([
      { slug: REVIEWER_MODEL, intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
      { slug: CODEX_MODEL, intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
    ]),
  });
  await d.setup();
  await d.tick();
  const before = (await d.api('capacity')).body;
  const metaAcct = before.accounts.find(a => a.provider === 'meta').accountId;
  const codexAcct = before.accounts.find(a => a.provider === 'codex').accountId;
  const metaArms = before.accounts.find(a => a.provider === 'meta').arms.map(a => a.armId);
  const codexArms = before.accounts.find(a => a.provider === 'codex').arms.map(a => a.armId);
  assert.ok(metaArms.length >= 1 && codexArms.length >= 1, 'both ladders have servable arms');

  // Two failed runs shadow-decided onto meta but served by codex: one with a
  // backfilled actual account, one naming only its serving provider.
  d.seed(LEDGER_SKEY, [
    {
      runId: 'diverged-actual', agentId: 'doer', status: 'failed', terminalAt: TICK,
      decidedAccount: metaAcct, decidedAt: TICK, enforced: false, armId: metaArms[0],
      actualAccount: codexAcct, actualModel: CODEX_MODEL, actualModelSource: 'run-event',
      provider: 'codex', errorText: '402 usage balance exhausted',
    },
    {
      runId: 'diverged-provider', agentId: 'doer', status: 'failed', terminalAt: TICK,
      decidedAccount: metaAcct, decidedAt: TICK, enforced: false, armId: metaArms[0],
      provider: 'codex', errorText: '402 usage balance exhausted',
    },
  ]);
  d.reboot();
  await d.setup();
  await d.tick();

  const cap = (await d.api('capacity')).body;
  assert.ok(cap.breakerUnavailableAccountIds.includes(codexAcct),
    `serving codex account is unavailable: ${JSON.stringify(cap.breakerUnavailableAccountIds)}`);
  assert.ok(!cap.breakerUnavailableAccountIds.includes(metaAcct),
    `shadow-guessed meta account stays available: ${JSON.stringify(cap.breakerUnavailableAccountIds)}`);
  const codexOpen = cap.armBreakers
    .filter(e => e.accountId === codexAcct && e.status === 'open')
    .map(e => e.armId)
    .sort();
  assert.deepEqual(codexOpen, [...codexArms].sort(),
    'every known codex arm opens and no foreign decided arm seeds state there');
  const metaOpen = cap.armBreakers.filter(e => e.accountId === metaAcct && e.status === 'open');
  assert.deepEqual(metaOpen, [], 'no meta arm trips on a codex-served failure');
});

test("tick accumulator isolates a '__proto__' agentId end to end", async () => {
  const d = drive({ nowMs: TICK, config: { enforce: true }, issueLists: { todo: [], in_progress: [] } });
  await d.setup();
  await d.tick();
  d.setNow(TICK + 10 * 60000);
  await d.fire(runEvent('proto-run-1', TICK + 10 * 60000, '__proto__'));
  await d.fire(runEvent('devops-run-1', TICK + 10 * 60000, 'devops'));
  d.setNow(TICK + 30 * 60000);
  d.setLane(0.328);
  await d.tick();
  const caps = await d.api('caps');
  assert.equal(caps.status, 200);
  const byId = new Map(caps.body.agents.map(a => [a.agentId, a]));
  // The hostile id is counted as its own agent, not folded into the
  // prototype: both agents report their own running counts.
  assert.equal(byId.get('__proto__').running, 1);
  assert.equal(byId.get('devops').running, 1);
  for (const a of caps.body.agents) assert.ok(a.allocated >= a.running, a.agentId);
  // No worker-wide pollution from the accumulator write path.
  assert.equal({}.running, undefined);
  assert.equal(Object.prototype.running, undefined);
});
