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
    seedCaps: patch => {
      const key = skey({ ...LEDGER_SKEY, stateKey: 'capacity-v1' });
      store.set(key, { ...store.get(key), ...patch });
    },
    reconfigure: async next => { config = next; await plugin.onConfigChanged(config, { companyId: 'acme' }); },
    io,
    // Fresh plugin on the same io store: the next tick cold-loads persisted
    // state (proves the persisted breaker form works, like review-breaker).
    reboot: () => { plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false }); },
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: snapshotRows, duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: () => jobs.get('quota-refresh')({}),
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
  // Meta burns 6%/h (0.90 -> 0.93 in 30 min) against ~0.15%/h required: the
  // measured-rate correction (0.2.59, floor 0.1) holds the ahead pool to one run.
  assert.equal(initialPools.get('meta')?.cap, 1, `the ahead-of-plan Meta pool is held by its measured burn: ${JSON.stringify(initialPools.get('meta'))}`);
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
  assert.equal(metaPool.cap, 1);
  assert.equal(metaPool.inFlight, 1, 'the running kept Reviewer record is charged to its Meta serving pool');
  assert.equal(capacity.paceGuard.unattributedInFlight, 0, 'the kept run is not left unattributed');
  assert.ok(reviewer.maxConcurrentRuns <= metaPool.cap,
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

// High synthetic targets isolate publication safety from pacing/calibration.
// Admission metadata is retained from a real tick, never fabricated by tests.
async function boundaryDrive({ maxTotal = 4, config = {}, records = [] } = {}) {
  const d = drive({ nowMs: TICK, config: { enforce: true, concurrency: { maxTotal }, ...config },
    issueLists: { todo: Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, assigneeAgentId: 'worker' })) } });
  d.seed(LEDGER_SKEY, records);
  await d.setup();
  await d.tick();
  d.seedCaps({ target: 20, calibration: 'measured' });
  return d;
}
const newSlots = body => body.agents.reduce((n, a) => n + a.allocated - a.running, 0);

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

test('retained census F1: a start during deferred tick I/O remains physical occupancy', async () => {
  const d = await boundaryDrive({ maxTotal: 1 });
  const entered = deferred(), release = deferred();
  const get = d.io.state.get;
  d.io.state.get = async key => {
    if (key.stateKey === 'aa-snapshot-v1') { entered.resolve(); await release.promise; }
    return get(key);
  };
  const tick = d.tick();
  await entered.promise;
  d.setNow(TICK + 100);
  await d.fire(runEvent('during-read', TICK + 100, 'worker'));
  release.resolve();
  await tick;
  d.seedCaps({ target: 20, calibration: 'measured' });
  const body = (await d.api('caps')).body;
  assert.deepEqual(body.physicalOccupancy, { running: 1, unassignedRunning: 0, pending: 0 });
  assert.equal(body.agents.find(a => a.agentId === 'worker').running, 1);
  assert.equal(newSlots(body), 0);
  assert.equal((await get(LEDGER_SKEY)).find(r => r.runId === 'during-read').unverified, false);

  const control = await boundaryDrive({ maxTotal: 1, records: [
    { runId: 'future', status: 'running', agentId: 'worker', startedAt: TICK + 10_000 },
    { runId: 'unanchored', status: 'running', agentId: 'worker' },
  ] });
  assert.equal((await control.api('caps')).body.physicalOccupancy.running, 0);
  assert.equal(newSlots((await control.api('caps')).body), 1, 'unverifiable carried rows do not consume room');
});

test('retained census F2: valid bounded history pressure cannot erase executing or pending occupancy', async () => {
  const records = [
    ...['a', 'b'].map(runId => ({ runId, agentId: 'worker', status: 'running', startedAt: TICK - 1000 })),
    { runId: 'pending', status: 'decided', enforced: true, decidedAt: TICK - 1000, decidedAccount: 'claude:a1' },
    { runId: 'expired', status: 'running', startedAt: TICK - 3 * HOUR },
    { runId: 'old-terminal', status: 'finished', terminalAt: TICK - 25 * HOUR },
    ...Array.from({ length: 150 }, (_, i) => ({ runId: `terminal-${i}`, status: 'finished', terminalAt: TICK - i })),
  ];
  const d = await boundaryDrive({ maxTotal: 3, config: { shadow: { maxEntries: 100 } }, records });
  const body = (await d.api('caps')).body;
  assert.deepEqual(body.physicalOccupancy, { running: 2, unassignedRunning: 0, pending: 1 });
  assert.equal(body.agents.find(a => a.agentId === 'worker').running, 2);
  assert.equal(newSlots(body), 0);
  const saved = await d.io.state.get(LEDGER_SKEY);
  assert.equal(saved.length, 100);
  for (const id of ['a', 'b', 'pending']) assert.ok(saved.some(r => r.runId === id), id);
  for (const id of ['expired', 'old-terminal']) assert.ok(!saved.some(r => r.runId === id), id);
  await d.fire(runEvent('pending', TICK, 'unknown'));
  const started = (await d.api('caps')).body;
  assert.deepEqual(started.physicalOccupancy, { running: 3, unassignedRunning: 1, pending: 0 });
  assert.equal(newSlots(started), 0, 'pending to running is one physical slot');
  for (const id of ['a', 'b', 'pending']) await d.fire(runEvent(id, TICK, 'worker', 'agent.run.finished'));
  assert.equal(newSlots((await d.api('caps')).body), 3, 'terminal observations release exactly the occupied room');

  // Live pressure itself can exceed the history setting. Persist identities
  // rather than silently evict executing rows, even across a worker restart.
  const overflow = await boundaryDrive({ maxTotal: 3, config: { shadow: { maxEntries: 100 } }, records: [
    ...Array.from({ length: 105 }, (_, i) => ({ runId: `live-${i}`, agentId: 'worker', status: 'running', startedAt: TICK - 1000 })),
    ...records.filter(r => r.status === 'finished'),
  ] });
  assert.equal((await overflow.io.state.get(LEDGER_SKEY)).length, 105, 'only live identities exceed the history bound');
  overflow.reboot(); await overflow.setup(); await overflow.tick();
  overflow.seedCaps({ target: 20, calibration: 'measured' });
  const over = (await overflow.api('caps')).body;
  assert.deepEqual(over.physicalOccupancy, { running: 105, unassignedRunning: 0, pending: 0 });
  assert.equal(over.agents.find(a => a.agentId === 'worker').running, 105);
  assert.equal(newSlots(over), 0, 'over-capacity executing floors never authorize a grant');
  overflow.setNow(TICK + 3 * MIN); overflow.setLane(0.3);
  for (let i = 0; i < 105; i++) await overflow.fire(runEvent(`live-${i}`, TICK + 3 * MIN, 'worker', 'agent.run.finished'));
  const capacityKey = { ...LEDGER_SKEY, stateKey: 'capacity-v1' };
  const previous = await overflow.io.state.get(capacityKey);
  const persist = overflow.io.state.set;
  overflow.io.state.set = async (key, value) => {
    if (key.stateKey === 'ledger-v1') throw Error('ledger write unavailable');
    return persist(key, value);
  };
  await assert.rejects(overflow.tick(), /quota-refresh-failed/);
  assert.strictEqual(await overflow.io.state.get(capacityKey), previous, 'failed ledger persist cannot publish new capacity');
  assert.equal(newSlots((await overflow.api('caps')).body), 0, 'expired saved admission cannot turn released floors into grants');
  overflow.io.state.set = persist;
  await overflow.tick();
  overflow.seedCaps({ target: 20, calibration: 'measured' });
  assert.equal((await overflow.io.state.get(LEDGER_SKEY)).length, 100, 'terminal history returns to the hard bound');
  const finished = (await overflow.api('caps')).body;
  assert.equal(finished.physicalOccupancy.running, 0);
  assert.equal(newSlots(finished), 3, 'only actual terminal observations release capacity');
});

test('retained census F3: successfully loaded stale ledger unions snapshot identities with terminal precedence', async () => {
  const d = await boundaryDrive({ maxTotal: 4 });
  await d.fire(runEvent('overlap', TICK, 'worker'));
  const set = d.io.state.set;
  let inserted = false;
  d.io.state.set = async (key, value) => {
    await set(key, value);
    if (key.stateKey === 'ledger-v1' && !inserted) {
      inserted = true;
      await d.fire(runEvent('snapshot-only', TICK, 'other'));
      await d.fire(runEvent('unnamed', TICK, 'unknown'));
    }
  };
  await d.tick();
  d.seedCaps({ target: 20, calibration: 'measured' });
  assert.equal((await d.io.state.get(LEDGER_SKEY)).length, 1, 'start is after the older nonempty persist');
  d.reboot(); await d.setup();
  await d.fire(runEvent('overlap', TICK, 'worker'));
  for (let i = 0; i < 3; i++) {
    const body = (await d.api('caps')).body;
    assert.deepEqual(body.physicalOccupancy, { running: 3, unassignedRunning: 1, pending: 0 });
    assert.equal(body.agents.find(a => a.agentId === 'worker').running, 1);
    assert.equal(body.agents.find(a => a.agentId === 'other').running, 1);
    assert.equal(newSlots(body), 0, 'snapshot union is reporting, not restart admission authority');
  }
  await d.tick(); d.seedCaps({ target: 20, calibration: 'measured' });
  const fresh = (await d.api('caps')).body;
  assert.deepEqual(fresh.physicalOccupancy, { running: 3, unassignedRunning: 1, pending: 0 });
  assert.equal(newSlots(fresh), 1, 'a fresh compatible tick preserves recovered pressure and only genuine slack');
  await d.fire(runEvent('snapshot-only', TICK, 'other', 'agent.run.finished'));
  await d.fire(runEvent('overlap', TICK, 'worker', 'agent.run.finished'));
  await d.fire(runEvent('snapshot-only', TICK, 'other'));
  const ended = (await d.api('caps')).body;
  assert.deepEqual(ended.physicalOccupancy, { running: 1, unassignedRunning: 1, pending: 0 });
  assert.equal(newSlots(ended), 3, 'terminal observations release room without resurrection by snapshot or late start');
});

test('retained census F4: unknown and empty identities promote without replacing conflicting known identity', async () => {
  for (const agentId of ['unknown', '']) {
    for (const pending of [false, true]) {
      const { d } = await outageDrive({ records: [{ runId: 'promote', agentId,
        ...(pending ? { status: 'decided', enforced: true, decidedAt: TICK, decidedAccount: 'claude:a1' }
          : { status: 'running', startedAt: TICK }) }] });
      await d.fire(runEvent('promote', TICK, 'worker'));
      for (let i = 0; i < 3; i++) {
        const body = (await d.api('caps')).body;
        assert.deepEqual(body.physicalOccupancy, { running: 1, unassignedRunning: 0, pending: 0 });
        assert.equal(body.agents.find(a => a.agentId === 'worker').running, 1);
        assert.equal(newSlots(body), 0);
      }
    }
  }
  const { d } = await outageDrive({ records: [{ runId: 'conflict', agentId: 'original', status: 'running', startedAt: TICK }] });
  await d.fire(runEvent('conflict', TICK, 'worker'));
  const body = (await d.api('caps')).body;
  assert.equal(body.physicalOccupancy.running, 1);
  assert.equal(body.agents.find(a => a.agentId === 'original').running, 1);
  assert.equal(body.agents.find(a => a.agentId === 'worker')?.running ?? 0, 0);
  assert.equal(newSlots(body), 0);
});

for (const agentId of [undefined, null, '', 'unknown']) {
  test(`/caps conserves unnamed physical occupancy (${String(agentId)}) at the hard fleet limit`, async () => {
    const d = await boundaryDrive({ maxTotal: 2 });
    await d.fire(runEvent('named', TICK, 'worker'));
    await d.fire(runEvent('unnamed', TICK, agentId, 'agent.run.started', { provider: 'unmapped-provider' }));
    for (const tick of [false, true]) {
      if (tick) { await d.tick(); d.seedCaps({ target: 20, calibration: 'measured' }); }
      const body = (await d.api('caps')).body;
      assert.equal(body.physicalOccupancy.running, 2);
      assert.equal(body.physicalOccupancy.unassignedRunning, 1);
      assert.equal(body.agents.find(a => a.agentId === 'worker').running, 1);
      assert.equal(newSlots(body), 0, 'executing pressure is not apparent slack');
      assert.ok(body.agents.every(a => a.agentId === 'worker'), 'no invented identity or attribution');
      if (tick) {
        const row = (await d.io.state.get(LEDGER_SKEY)).find(r => r.runId === 'unnamed');
        assert.equal(row.actualAccount ?? null, null, 'occupancy does not invent a serving account');
      }
    }
  });
}

test('/caps burn mode never exempts executing work from the physical fleet boundary', async () => {
  const d = await boundaryDrive({ maxTotal: 1, config: { burnMode: { accounts: ['claude:a1'] } } });
  const capacity = (await d.api('capacity')).body;
  assert.equal(capacity.accounts.find(a => a.accountId === 'claude:a1').burnMode, true);
  await d.fire(runEvent('burn-running', TICK, 'unknown', 'agent.run.started', {
    model: 'claude-haiku-5-5', accountId: 'claude:a1',
  }));
  assert.equal(newSlots((await d.api('caps')).body), 0);
});

test('/caps large reserved floors cannot outlive the ceiling balancer iteration budget', async () => {
  const d = await boundaryDrive({ maxTotal: 1,
    config: { caps: { reservedFloors: { worker: { base: 10_000, perQueued: 1, max: 10_000 } } } } });
  await d.fire(runEvent('unnamed', TICK, 'unknown'));
  assert.equal(newSlots((await d.api('caps')).body), 0);
});

test('/caps counts overlapping named and unnamed work once and leaves exactly the physical slack', async () => {
  const d = await boundaryDrive();
  await d.fire(runEvent('named', TICK, 'worker'));
  await d.fire(runEvent('unnamed', TICK, 'unknown'));
  const body = (await d.api('caps')).body;
  assert.equal(newSlots(body), 2);
  assert.equal(body.agents.find(a => a.agentId === 'worker').allocated, 3);
});

test('/caps preserves over-ceiling named floors and does not grant more work', async () => {
  const d = await boundaryDrive({ maxTotal: 2 });
  for (let i = 0; i < 3; i++) await d.fire(runEvent(`named-${i}`, TICK, 'worker'));
  await d.fire(runEvent('unnamed', TICK, 'unknown'));
  const body = (await d.api('caps')).body;
  assert.equal(body.agents.find(a => a.agentId === 'worker').allocated, 3);
  assert.equal(newSlots(body), 0);
});

test('/caps pending-to-running transition reserves one slot, not zero or two', async () => {
  const d = await boundaryDrive({ records: [{ runId: 'pending', agentId: 'unknown', status: 'decided',
    enforced: true, decidedAt: TICK, decidedAccount: 'claude:a1', unverified: false }] });
  const before = (await d.api('caps')).body;
  assert.equal(before.physicalOccupancy.pending, 1);
  assert.equal(newSlots(before), 3);
  await d.fire(runEvent('pending', TICK, 'unknown'));
  const after = (await d.api('caps')).body;
  assert.equal(after.physicalOccupancy.pending, 0);
  assert.equal(after.physicalOccupancy.unassignedRunning, 1);
  assert.equal(newSlots(after), 3);
});

test('/caps holds and reserved floors cannot bypass physical pressure or a zero remaining ceiling', async () => {
  const d = await boundaryDrive({ maxTotal: 1, config: { caps: { reservedFloors: { worker: { base: 4, perQueued: 1, max: 4 } } } } });
  d.seed({ ...LEDGER_SKEY, stateKey: 'caps-hold-v1' }, { atMs: TICK, agents: { worker: { value: 20, atMs: TICK } } });
  await d.fire(runEvent('unnamed', TICK, 'unknown'));
  const body = (await d.api('caps')).body;
  assert.equal(newSlots(body), 0);
  assert.equal(body.reservedFloors.worker.blocked, true);
});

for (const [label, patch] of [
  ['future', { atMs: TICK + 1 }],
  ['old generation', { reviewAdmissionGeneration: -1 }],
  ['other worker', { reviewAdmissionEpoch: 'other-worker' }],
  ['legacy persisted facts', { reviewAdmissionGeneration: undefined, reviewAdmissionEpoch: undefined }],
]) {
  test(`/caps ${label} facts preserve running but cannot authorize grants`, async () => {
    const d = await boundaryDrive();
    await d.fire(runEvent('named', TICK, 'worker'));
    d.seedCaps(patch);
    const body = (await d.api('caps')).body;
    assert.equal(body.capsError, 'admission-unavailable');
    assert.equal(body.agents.find(a => a.agentId === 'worker').running, 1);
    assert.equal(newSlots(body), 0);
  });
}

test('/caps uses the retained hook freshness window without expiring executing floors', async () => {
  const d = await boundaryDrive();
  await d.fire(runEvent('named', TICK, 'worker'));
  d.setNow(TICK + 120_000);
  assert.equal(newSlots((await d.api('caps')).body), 3, 'fresh compatible negative control');
  d.setNow(TICK + 120_001);
  const body = (await d.api('caps')).body;
  assert.equal(body.capsError, 'admission-unavailable');
  assert.equal(body.target, null);
  assert.equal(newSlots(body), 0);
  assert.equal(body.agents.find(a => a.agentId === 'worker').running, 1);
});

test('/caps rejects pre-existing config and restart authority even with identical counters and clocks', async () => {
  const d = await boundaryDrive();
  await d.fire(runEvent('named', TICK, 'worker'));
  await d.tick(); d.seedCaps({ target: 20, calibration: 'measured' });
  d.reboot(); await d.setup();
  assert.equal(newSlots((await d.api('caps')).body), 0, 'same generation is not same worker');
  await d.tick(); d.seedCaps({ target: 20, calibration: 'measured' });
  assert.equal(newSlots((await d.api('caps')).body), 3);
  await d.reconfigure({ enforce: true, concurrency: { maxTotal: 1 } });
  const body = (await d.api('caps')).body;
  assert.equal(body.agents.find(a => a.agentId === 'worker').running, 1);
  assert.equal(newSlots(body), 0, 'old maxTotal and target do not survive reconfiguration');
});

test('/caps unavailable demand or calibration never loses named running floors', async () => {
  const d = await boundaryDrive();
  await d.fire(runEvent('named', TICK, 'worker'));
  d.seedCaps({ target: null, calibration: 'weak' });
  assert.equal((await d.api('caps')).body.agents.find(a => a.agentId === 'worker').allocated, 1);
  d.seedCaps({ target: 20, calibration: 'measured' });
  d.io.issues.list = async () => { throw Error('unavailable'); };
  d.setNow(TICK + 20_000);
  const body = (await d.api('caps')).body;
  assert.equal(body.capsError, 'issues-unavailable');
  assert.equal(body.agents.find(a => a.agentId === 'worker').allocated, 1);
});

test('/caps unavailable calibration preserves unnamed physical census diagnostics', async () => {
  const d = await boundaryDrive();
  await d.fire(runEvent('unnamed', TICK, 'unknown'));
  d.seedCaps({ target: null, calibration: 'weak' });
  const body = (await d.api('caps')).body;
  assert.equal(body.target, null);
  assert.deepEqual(body.agents, []);
  assert.deepEqual(body.physicalOccupancy, { running: 1, unassignedRunning: 1, pending: 0 });
});

test('/caps configuration changes retain physical census diagnostics without new grants', async () => {
  const d = await boundaryDrive();
  await d.fire(runEvent('unnamed', TICK, 'unknown'));
  const get = d.io.state.get;
  let changed = false;
  d.io.state.get = async key => {
    if (key.stateKey === 'caps-hold-v1' && !changed) {
      changed = true;
      await d.reconfigure({ enforce: true, concurrency: { maxTotal: 1 } });
    }
    return get(key);
  };
  const body = (await d.api('caps')).body;
  assert.equal(body.capsError, 'configuration-changed');
  assert.equal(newSlots(body), 0);
  assert.deepEqual(body.physicalOccupancy, { running: 1, unassignedRunning: 1, pending: 0 });
});

test('/caps recomputes exhausted kept admission after a finish during hold I/O', async () => {
  const d = await boundaryDrive({ config: { roles: { keepAgentIds: ['worker'] } } });
  d.io.agents.getQueuedRunCounts = async () => [{ agentId: 'worker', queued: 8 }];
  d.seedCaps({ keptByAgent: { worker: { accountId: 'claude:a1' } },
    perAccount: [{ accountId: 'claude:a1', slots: 0 }] });
  await d.fire(runEvent('ending', TICK, 'worker'));
  const get = d.io.state.get;
  let finished = false;
  d.io.state.get = async key => {
    if (key.stateKey === 'caps-hold-v1' && !finished) {
      finished = true;
      await d.fire(runEvent('ending', TICK, 'worker', 'agent.run.finished'));
    }
    return get(key);
  };
  const row = (await d.api('caps')).body.agents.find(a => a.agentId === 'worker');
  assert.equal(row.running, 0);
  assert.equal(row.allocated, 0, 'finished floors cannot become grants on an exhausted pool');
});

test('/caps preserves memory-only positive running evidence when ledger storage fails', async () => {
  const d = await boundaryDrive();
  d.reboot(); await d.setup();
  const get = d.io.state.get;
  d.io.state.get = async key => {
    if (key.stateKey === 'ledger-v1') throw Error('storage unavailable');
    return get(key);
  };
  await d.fire(runEvent('memory-only', TICK, 'worker'));
  const body = (await d.api('caps')).body;
  assert.equal(body.agents.find(a => a.agentId === 'worker').running, 1);
  assert.equal(body.physicalOccupancy.running, 1);
  assert.equal(newSlots(body), 0);
  assert.equal(body.capsError, 'admission-unavailable');
});

async function outageDrive({ config = {}, records = [], legacy = false } = {}) {
  const d = await boundaryDrive({ config, records });
  if (records.length === 0) await d.fire(runEvent('saved', TICK, 'worker'));
  await d.tick();
  d.seedCaps({ target: 20, calibration: 'measured', ...(legacy ? { runningCensusRecords: undefined } : {}) });
  d.reboot(); await d.setup();
  const get = d.io.state.get;
  d.io.state.get = async key => {
    if (key.stateKey === 'ledger-v1') throw Error('storage unavailable');
    return get(key);
  };
  return { d, get };
}

for (const burn of [false, true]) {
  test(`/caps outage unions disjoint saved and memory runs (${burn ? 'burn' : 'ordinary'}) without refresh inflation`, async () => {
    const { d, get } = await outageDrive({ config: burn ? { burnMode: { accounts: ['claude:a1'] } } : {} });
    await d.fire(runEvent('distinct', TICK, 'worker'));
    for (let i = 0; i < 3; i++) {
      const body = (await d.api('caps')).body;
      const row = body.agents.find(a => a.agentId === 'worker');
      assert.equal(row.running, 2);
      assert.equal(row.allocated, 2);
      assert.equal(row.maxConcurrentRuns, 2);
      assert.deepEqual(body.physicalOccupancy, { running: 2, unassignedRunning: 0, pending: 0 });
      assert.equal(newSlots(body), 0);
      assert.equal(body.capsError, 'admission-unavailable');
    }
    // Recovery uses the real ledger union, not the anonymous fallback bound.
    d.io.state.get = get;
    const recovered = (await d.api('caps')).body;
    assert.equal(recovered.physicalOccupancy.running, 2);
    assert.equal(recovered.agents.find(a => a.agentId === 'worker').running, 2);
  });
}

test('/caps outage deduplicates overlapping starts and observes terminals from the memory ledger', async () => {
  const { d } = await outageDrive();
  await d.fire(runEvent('saved', TICK, 'worker'));
  for (let i = 0; i < 3; i++) {
    const body = (await d.api('caps')).body;
    assert.equal(body.agents.find(a => a.agentId === 'worker').running, 1);
    assert.equal(body.physicalOccupancy.running, 1);
    assert.equal(newSlots(body), 0);
  }
  await d.fire(runEvent('saved', TICK, 'worker', 'agent.run.finished'));
  const body = (await d.api('caps')).body;
  assert.equal(body.physicalOccupancy.running, 0);
  assert.equal(newSlots(body), 0);
});

test('/caps outage reconciles a saved pending reservation with its memory-only start once', async () => {
  const { d } = await outageDrive({ records: [{ runId: 'pending', agentId: 'worker', status: 'decided',
    enforced: true, decidedAt: TICK, decidedAccount: 'claude:a1', unverified: false }] });
  const before = (await d.api('caps')).body;
  assert.equal(before.physicalOccupancy.pending, 1);
  await d.fire(runEvent('pending', TICK, 'worker'));
  for (let i = 0; i < 3; i++) {
    const body = (await d.api('caps')).body;
    assert.deepEqual(body.physicalOccupancy, { running: 1, unassignedRunning: 0, pending: 0 });
    assert.equal(body.agents.find(a => a.agentId === 'worker').allocated, 1);
    assert.equal(newSlots(body), 0);
  }
});

test('/caps outage refresh includes unnamed starts during hold I/O without inventing attribution', async () => {
  const { d } = await outageDrive();
  const get = d.io.state.get;
  let started = false;
  d.io.state.get = async key => {
    if (key.stateKey === 'caps-hold-v1' && !started) {
      started = true;
      await d.fire(runEvent('unnamed', TICK, 'unknown'));
    }
    return get(key);
  };
  for (let i = 0; i < 3; i++) {
    const body = (await d.api('caps')).body;
    assert.deepEqual(body.physicalOccupancy, { running: 2, unassignedRunning: 1, pending: 0 });
    assert.equal(body.agents.find(a => a.agentId === 'worker').running, 1);
    assert.ok(body.agents.every(a => a.agentId !== 'unknown'));
    assert.equal(newSlots(body), 0);
  }
});

test('/caps legacy count-only outage conservatively retains saved plus partial memory floors', async () => {
  const { d } = await outageDrive({ legacy: true });
  await d.fire(runEvent('distinct', TICK, 'worker'));
  for (let i = 0; i < 3; i++) {
    const body = (await d.api('caps')).body;
    assert.equal(body.agents.find(a => a.agentId === 'worker').running, 2);
    assert.equal(body.physicalOccupancy.running, 2);
    assert.equal(newSlots(body), 0);
  }
});

test('/caps legacy overlap bound is stable and disappears when the ledger recovers', async () => {
  const { d, get } = await outageDrive({ legacy: true });
  // Old snapshots may also predate the additive physical census.
  d.seedCaps({ physicalOccupancy: undefined });
  await d.fire(runEvent('saved', TICK, 'worker'));
  for (let i = 0; i < 3; i++) {
    const body = (await d.api('caps')).body;
    assert.equal(body.agents.find(a => a.agentId === 'worker').running, 2,
      'without saved identities overlap cannot be proved; retain the conservative bound');
    assert.equal(body.physicalOccupancy.running, 2);
    assert.equal(newSlots(body), 0);
  }
  d.io.state.get = get;
  const recovered = (await d.api('caps')).body;
  assert.equal(recovered.agents.find(a => a.agentId === 'worker').running, 1);
  assert.equal(recovered.physicalOccupancy.running, 1);
  assert.equal(newSlots(recovered), 0, 'ledger recovery alone does not restore worker admission authority');
});

test('/caps unavailable issues publishes starts observed during the failed read', async () => {
  const d = await boundaryDrive();
  await d.fire(runEvent('first', TICK, 'worker'));
  let started = false;
  d.setNow(TICK + 20_000);
  d.io.issues.list = async () => {
    if (!started) { started = true; await d.fire(runEvent('second', TICK, 'worker')); }
    throw Error('issues unavailable');
  };
  const body = (await d.api('caps')).body;
  assert.equal(body.capsError, 'issues-unavailable');
  assert.equal(body.agents.find(a => a.agentId === 'worker').allocated, 2);
  assert.equal(body.physicalOccupancy.running, 2);
});

for (const weighted of [false, true]) {
  test(`/caps physical pressure preserves ${weighted ? 'weighted priority' : 'feasible reserved floors'}`, async () => {
    const d = await boundaryDrive({ config: weighted
      ? { allocation: { blockingPriority: true } }
      : { caps: { reservedFloors: { a: { base: 2, perQueued: 100, max: 2 } } } } });
    d.io.issues.list = async ({ status }) => status !== 'todo' ? [] : ['a', 'b'].flatMap(agentId =>
      Array.from({ length: 8 }, (_, i) => ({ id: `${agentId}-${i}`, assigneeAgentId: agentId,
        status: 'todo', priority: agentId === 'a' ? 'high' : 'low', blockedBy: [] })));
    d.setNow(TICK + 20_000);
    await d.tick(); d.seedCaps({ target: 20, calibration: 'measured' });
    await d.fire(runEvent('unknown-1', TICK, 'unknown'));
    if (weighted) await d.fire(runEvent('unknown-2', TICK, 'unknown'));
    const body = (await d.api('caps')).body;
    const rows = new Map(body.agents.map(a => [a.agentId, a]));
    assert.deepEqual(['a', 'b'].map(id => rows.get(id).allocated), weighted ? [2, 0] : [2, 1]);
    assert.equal(newSlots(body), weighted ? 2 : 3);
    if (!weighted) assert.equal(rows.get('a').floorBlocked ?? false, false);
  });
}

test('/caps freshness crossed during hold I/O cannot redecorate positive admitted review shares', async () => {
  const d = await boundaryDrive({ config: {
    roles: { keepAgentIds: ['worker'] },
    reviewerRouting: { agentIds: ['worker'], arms: [{ provider: 'claude', model: 'claude-haiku-5-5' }] },
    reviewDemand: { repositories: ['example/product'], tokenSecretRef: SECRET, requiredChecks: ['ci-ok'] },
  } });
  const fetch = d.io.http.fetch;
  const oid = 'a'.repeat(40);
  d.io.http.fetch = async (url, ...args) => url !== 'https://api.github.com/graphql' ? fetch(url, ...args)
    : { status: 200, text: async () => JSON.stringify({ data: { repository: { pullRequests: {
      nodes: [{ number: 1, isDraft: false, mergeable: 'MERGEABLE', headRefOid: oid,
        commits: { nodes: [{ commit: { oid, statusCheckRollup: { contexts: {
          nodes: [{ __typename: 'CheckRun', name: 'ci-ok', status: 'COMPLETED', conclusion: 'SUCCESS' }],
          pageInfo: { hasNextPage: false },
        } } } }] } }], pageInfo: { hasNextPage: false, endCursor: null },
    } } } }) };
  d.setNow(TICK + 60_000);
  await d.reconfigure(await d.io.config.get());
  await d.tick(); d.seedCaps({ target: 20, calibration: 'measured',
    perAccount: [{ accountId: 'claude:a1', slots: 8 }],
    reviewerAccountIdsByAgent: { worker: ['claude:a1'] } });
  const control = (await d.api('caps')).body;
  assert.ok(control.agents.find(a => a.agentId === 'worker'), JSON.stringify(control));
  assert.equal(control.agents.find(a => a.agentId === 'worker').reviewEligibleHeads, 1,
    'fresh compatible control actually admits a head');
  const get = d.io.state.get;
  d.io.state.get = async key => {
    if (key.stateKey === 'caps-hold-v1') d.setNow(TICK + 180_001);
    return get(key);
  };
  const body = (await d.api('caps')).body;
  assert.equal(body.capsError, 'admission-unavailable');
  assert.equal(newSlots(body), 0);
  assert.equal(body.agents.find(a => a.agentId === 'worker').reviewEligibleHeads, 0);
});

test('/caps zero physical room cannot fund a fixed-reviewer head in the feasibility probe', async () => {
  const d = await boundaryDrive({ maxTotal: 1, config: {
    roles: { keepAgentIds: ['worker'] }, reviewReserve: { agentIds: ['worker'] },
    reviewDemand: { repositories: ['example/product'], tokenSecretRef: SECRET, requiredChecks: ['ci-ok'] },
  } });
  d.io.agents.getQueuedRunCounts = async () => [];
  const fetch = d.io.http.fetch;
  const oid = 'a'.repeat(40);
  d.io.http.fetch = async (url, ...args) => url !== 'https://api.github.com/graphql' ? fetch(url, ...args)
    : { status: 200, text: async () => JSON.stringify({ data: { repository: { pullRequests: {
      nodes: [{ number: 1, isDraft: false, mergeable: 'MERGEABLE', headRefOid: oid,
        commits: { nodes: [{ commit: { oid, statusCheckRollup: { contexts: {
          nodes: [{ __typename: 'CheckRun', name: 'ci-ok', status: 'COMPLETED', conclusion: 'SUCCESS' }],
          pageInfo: { hasNextPage: false },
        } } } }] } }], pageInfo: { hasNextPage: false, endCursor: null },
    } } } }) };
  d.setNow(TICK + 60_000);
  await d.reconfigure(await d.io.config.get());
  await d.tick(); d.seedCaps({ target: 20, calibration: 'measured',
    keptByAgent: { worker: { accountId: 'claude:a1' } }, perAccount: [{ accountId: 'claude:a1', slots: 8 }] });
  const control = (await d.api('caps')).body;
  assert.equal(control.agents.find(a => a.agentId === 'worker').reviewEligibleHeads, 1,
    'a fresh fixed reviewer with physical room actually admits a head');
  await d.fire(runEvent('unnamed', TICK + 60_000, 'unknown'));
  const body = (await d.api('caps')).body;
  assert.equal(body.reviewDemand.eligibleHeads, 1, 'census remains available');
  assert.equal(body.capsError, undefined, 'zero room is not stale evidence');
  assert.equal(body.agents.find(a => a.agentId === 'worker')?.reviewEligibleHeads ?? 0, 0);
  assert.equal(body.agents.find(a => a.agentId === 'worker')?.queued ?? 0, 0);
  assert.equal(newSlots(body), 0);
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
