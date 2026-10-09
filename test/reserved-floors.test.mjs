import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateDemandCaps, applyReservedFloors, computeReservedFloor } from '../src/concurrency.mjs';
import { holdCaps, SMOOTHING_DEFAULTS } from '../src/smoothing.mjs';
import { breakerKey, breakerSuspendsFloors, createBreakerStore, DEFAULT_BREAKERS } from '../src/breakers.mjs';
import { resolveConfig, validateConfigShape, createModelCapacityPlugin } from '../src/plugin.mjs';

// Reserved per-agent floors: config-only, empty by default. Placeholders only,
// never real agent ids.
const FLOOR_A = { 'agent-a': { base: 4, perQueued: 20, max: 8 } };

// The live failure shape: agent-a runs 2 with 105 queued, fleet running 39,
// target at or below running, so the allocator pins every cap to running.
const liveAgents = () => ([
  { agentId: 'agent-a', running: 2, queued: 105, overPace: false },
  { agentId: 'agent-b', running: 20, queued: 4, overPace: false },
  { agentId: 'agent-c', running: 17, queued: 9, overPace: false },
]);

const MIN = 60 * 1000;
const holdOpts = {
  halfLifeMs: SMOOTHING_DEFAULTS.halfLifeMin * MIN,
  staleMs: SMOOTHING_DEFAULTS.staleHours * 60 * MIN,
};

// Full pipeline as /caps serves it: allocate, hold, then floors LAST.
const pipeline = (target, agents, { floors = {}, blocked = [], hold = {}, nowMs = 0, ceiling = 75 } = {}) => {
  const unheld = allocateDemandCaps(target, agents, ceiling);
  const held = holdCaps(unheld, hold, nowMs, { ...holdOpts, ceiling });
  return {
    unheld,
    held: held.entries,
    floored: applyReservedFloors(held.entries, { reservedFloors: floors, ceiling, blockedAgentIds: blocked }),
    holdState: held.hold,
  };
};

test('live failure: running 2 queued 105 reads cap 2 without the floor, >= 8 with it', () => {
  for (const T of [12, 20, 28]) {
    const bare = pipeline(T, liveAgents());
    assert.equal(
      bare.floored.entries.find(e => e.agentId === 'agent-a').allocated, 2,
      `T=${T}: allocator pins the cap to running`,
    );
    const r = pipeline(T, liveAgents(), { floors: FLOOR_A });
    const a = r.floored.entries.find(e => e.agentId === 'agent-a');
    assert.ok(a.allocated >= 8, `T=${T}: floored cap ${a.allocated} < 8`);
    assert.equal(a.reason, 'reserved-floor');
    assert.equal(a.maxConcurrentRuns, a.allocated);
    assert.equal(a.floor, 8);
    // Untouched agents still hold exactly their running count.
    for (const id of ['agent-b', 'agent-c']) {
      const e = r.floored.entries.find(x => x.agentId === id);
      assert.equal(e.allocated, e.running, `T=${T}: ${id} moved`);
    }
  }
});

test('floor formula: base + queued/perQueued clamped, never above demand', () => {
  const spec = { base: 4, perQueued: 20, max: 8 };
  assert.equal(computeReservedFloor(0, 10, spec), 4);
  assert.equal(computeReservedFloor(0, 19, spec), 4);
  assert.equal(computeReservedFloor(0, 40, spec), 6);
  assert.equal(computeReservedFloor(2, 105, spec), 8);
  // No queue: the floor is the demand itself, never headroom from nothing.
  assert.equal(computeReservedFloor(2, 0, spec), 2);
  assert.equal(computeReservedFloor(0, 0, spec), 0);
  // Invalid specs read null (validator reports them; runtime ignores them).
  assert.equal(computeReservedFloor(2, 105, null), null);
  assert.equal(computeReservedFloor(2, 105, { base: 4, perQueued: 0, max: 8 }), null);
  assert.equal(computeReservedFloor(2, 105, { base: 4, perQueued: 20, max: 2 }), null);
});

test('no reservedFloors entry: output identical to today', () => {
  const fixtures = [
    [35, liveAgents()],
    [10, liveAgents()],
    [35, [{ agentId: 'agent-a', running: 6, queued: 11, overPace: false }]],
    [0, liveAgents()],
  ];
  for (const [T, agents] of fixtures) {
    const unheld = allocateDemandCaps(T, agents, 75);
    for (const floors of [undefined, {}, { 'agent-z': { base: 4, perQueued: 20, max: 8 } }]) {
      const r = applyReservedFloors(unheld, { reservedFloors: floors, ceiling: 75 });
      assert.deepEqual(r.entries, unheld);
      assert.deepEqual(r.applied, []);
    }
  }
  // A matching entry that does not bind only adds the auditable floor value:
  // allocations and reasons are untouched.
  const unheld = allocateDemandCaps(10, liveAgents(), 75);
  const r = applyReservedFloors(unheld, {
    reservedFloors: { 'agent-b': { base: 4, perQueued: 20, max: 8 } }, ceiling: 75,
  });
  assert.deepEqual(r.entries.map(e => [e.allocated, e.reason]), unheld.map(e => [e.allocated, e.reason]));
  assert.equal(r.entries.find(e => e.agentId === 'agent-b').floor, 4);
  assert.deepEqual(r.applied, []);
});

test('ceiling: floors win, others give back new slots only, never below running', () => {
  const entries = [
    { agentId: 'agent-a', running: 2, queued: 105, demand: 107, allocated: 2, maxConcurrentRuns: 2, reason: 'proportional' },
    { agentId: 'agent-b', running: 3, queued: 40, demand: 43, allocated: 10, maxConcurrentRuns: 10, reason: 'full-demand' },
    { agentId: 'agent-c', running: 1, queued: 20, demand: 21, allocated: 6, maxConcurrentRuns: 6, reason: 'headroom' },
  ];
  const r = applyReservedFloors(entries, { reservedFloors: FLOOR_A, ceiling: 15 });
  const byId = new Map(r.entries.map(e => [e.agentId, e]));
  assert.equal(byId.get('agent-a').allocated, 8);
  assert.equal(byId.get('agent-a').reason, 'reserved-floor');
  for (const id of ['agent-b', 'agent-c']) {
    assert.ok(byId.get(id).allocated >= byId.get(id).running, `${id} cut below running`);
    assert.ok(byId.get(id).allocated <= entries.find(e => e.agentId === id).allocated, `${id} grew`);
  }
  assert.ok(r.entries.reduce((s, e) => s + e.allocated, 0) <= 15);
  assert.deepEqual(r.applied, ['agent-a']);
});

test('breaker open on the agent arm: the floor does not apply, cap holds at running', () => {
  for (const T of [12, 20, 28]) {
    const r = pipeline(T, liveAgents(), { floors: FLOOR_A, blocked: ['agent-a'] });
    const a = r.floored.entries.find(e => e.agentId === 'agent-a');
    assert.equal(a.allocated, a.running);
    assert.notEqual(a.reason, 'reserved-floor');
    assert.equal(a.floor, 8, 'the floor stays auditable while suspended');
    assert.equal(r.floored.floors['agent-a'].blocked, true);
  }
});

test('after holdCaps decay the served cap never reads below the floor', () => {
  const t0 = 1_750_000_000_000;
  let hold = {};
  for (let step = 0; step < 6; step++) {
    const queued = [105, 80, 60, 40, 20, 10][step];
    const nowMs = t0 + step * 5 * MIN;
    const unheld = allocateDemandCaps(100, [
      { agentId: 'agent-a', running: 2, queued, overPace: false },
    ], 200);
    const held = holdCaps(unheld, hold, nowMs, { ...holdOpts, ceiling: 200 });
    hold = held.hold;
    const r = applyReservedFloors(held.entries, { reservedFloors: FLOOR_A, ceiling: 200 });
    const a = r.entries.find(e => e.agentId === 'agent-a');
    const floor = computeReservedFloor(2, queued, FLOOR_A['agent-a']);
    assert.ok(a.allocated >= floor, `queued=${queued}: served ${a.allocated} < floor ${floor}`);
  }
});

test('overshoot bound: floors add at most their new slots over the unheld sum', () => {
  // Pre-existing running can already hold the sum over the target (39
  // running over T=12 reads over 27 with no floors at all), so the bound
  // constrains what floors ADD: floored sum minus held sum stays within the
  // floors' own new slots. Live case: 39 -> 45, exactly floor - running = 6.
  const cases = [[12, liveAgents()], [20, liveAgents()], [28, liveAgents()], [39, liveAgents()], [35, liveAgents()]];
  for (let i = 0; i < 20; i++) {
    const agents = Array.from({ length: 3 }, (_, j) => ({
      agentId: `agent-${j}`,
      running: 1 + ((i * 7 + j * 13) % 12),
      queued: (i * 31 + j * 17) % 60,
      overPace: false,
    }));
    cases.push([12 + ((i * 5) % 30), agents]);
  }
  const spec = { base: 4, perQueued: 20, max: 8 };
  for (const [T, agents] of cases) {
    const r = pipeline(T, agents, { floors: { 'agent-0': spec, 'agent-a': spec } });
    const heldSum = r.held.reduce((s, e) => s + e.allocated, 0);
    const flooredSum = r.floored.entries.reduce((s, e) => s + e.allocated, 0);
    let newFloorSlots = 0;
    for (const a of agents) {
      const floor = computeReservedFloor(a.running, a.queued, spec);
      if (floor != null && (a.agentId === 'agent-0' || a.agentId === 'agent-a')) {
        newFloorSlots += Math.max(0, floor - a.running);
      }
    }
    assert.ok(flooredSum - heldSum <= newFloorSlots, `T=${T}: floors added ${flooredSum - heldSum} > ${newFloorSlots}`);
  }
});

test('agent ids that look like prototype keys are safe', () => {
  const entries = [{
    agentId: '__proto__', running: 1, queued: 50, demand: 51,
    allocated: 1, maxConcurrentRuns: 1, reason: 'proportional',
  }];
  const r = applyReservedFloors(entries, {
    reservedFloors: Object.fromEntries([['__proto__', { base: 4, perQueued: 20, max: 8 }]]),
    ceiling: 75,
  });
  assert.equal(r.entries[0].allocated, 6);
  assert.equal(r.entries[0].reason, 'reserved-floor');
  assert.equal({}.running, undefined);
  assert.equal(Object.prototype.running, undefined);
});

test('config: empty by default, validated like roles.*', () => {
  assert.deepEqual(resolveConfig({}).caps.reservedFloors, {});
  assert.deepEqual(validateConfigShape({}), []);
  assert.deepEqual(validateConfigShape({ caps: { reservedFloors: FLOOR_A } }), []);
  assert.deepEqual(
    validateConfigShape({ caps: { reservedFloors: [] } }),
    ['caps.reservedFloors must be an object of agent id to floor'],
  );
  assert.deepEqual(
    validateConfigShape({ caps: { reservedFloors: { 'agent-a': { base: -1, perQueued: 20, max: 8 } } } }),
    ['caps.reservedFloors.agent-a.base must be an integer >= 0'],
  );
  assert.deepEqual(
    validateConfigShape({ caps: { reservedFloors: { 'agent-a': { base: 4, perQueued: 0, max: 8 } } } }),
    ['caps.reservedFloors.agent-a.perQueued must be an integer >= 1'],
  );
  assert.deepEqual(
    validateConfigShape({ caps: { reservedFloors: { 'agent-a': { base: 4, perQueued: 20, max: 2 } } } }),
    ['caps.reservedFloors.agent-a.max must be >= base'],
  );
  // Invalid entries never reach the allocator: the resolver drops them.
  assert.deepEqual(resolveConfig({ caps: { reservedFloors: { 'agent-a': { base: 4, perQueued: 0, max: 8 } } } }).caps.reservedFloors, {});
  assert.deepEqual(resolveConfig({ caps: { reservedFloors: FLOOR_A } }).caps.reservedFloors, FLOOR_A);
});

const openStore = (pairs, atMs) => ({
  arms: Object.fromEntries(pairs.map(([accountId, armId]) => ([
    breakerKey(accountId, armId),
    {
      accountId, armId, state: 'open', openedAt: atMs, cooloffHours: 6,
      opens: 1, fails: [{ atMs, errorText: 'cooling' }], lastError: 'cooling',
    },
  ]))),
  seen: [],
});

test('breaker guard: suspends only while every tracked arm reads open', () => {
  const now = 1_750_000_000_000;
  assert.equal(breakerSuspendsFloors(createBreakerStore(), now, DEFAULT_BREAKERS), false);
  assert.equal(
    breakerSuspendsFloors(openStore([['acct-a', 'arm-1'], ['acct-b', 'arm-2']], now), now, DEFAULT_BREAKERS),
    true,
  );
  const half = openStore([['acct-a', 'arm-1']], now - 7 * 3600 * 1000);
  assert.equal(breakerSuspendsFloors(half, now, DEFAULT_BREAKERS), false, 'cool-off elapsed: half-open serves');
  assert.equal(
    breakerSuspendsFloors(openStore([['acct-a', 'arm-1']], now), now, { ...DEFAULT_BREAKERS, enabled: false }),
    false,
    'disabled breaker never suspends',
  );
});

// --- /caps wiring: the floor binds last and stays auditable.

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
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
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

test('/caps exposes the floor and its reason once the queue pins the cap', async () => {
  const queued = Array.from({ length: 105 }, (_, i) => ({ id: `q${i}`, status: 'todo', assigneeAgentId: 'agent-a' }));
  const d = drive({
    nowMs: TICK,
    config: { enforce: true, caps: { reservedFloors: FLOOR_A } },
    issueLists: { todo: queued, in_progress: [] },
  });
  await d.setup();
  await d.tick();
  d.setNow(TICK + 10 * 60000);
  await d.fire(runEvent('agent-a-run-1', TICK + 10 * 60000, 'agent-a'));
  await d.fire(runEvent('agent-a-run-2', TICK + 10 * 60000, 'agent-a'));
  d.setNow(TICK + 30 * 60000);
  d.setLane(1.0);
  await d.tick();
  const caps = await d.api('caps');
  assert.equal(caps.status, 200);
  const a = caps.body.agents.find(x => x.agentId === 'agent-a');
  assert.ok(a, 'agent-a is capped');
  assert.ok(a.allocated >= 8, `floored cap ${a.allocated} < 8`);
  assert.equal(a.reason, 'reserved-floor');
  assert.equal(a.floor, 8);
  assert.equal(a.maxConcurrentRuns, a.allocated);
  assert.equal(caps.body.reservedFloors['agent-a'].floor, 8);
  assert.equal(caps.body.reservedFloors['agent-a'].applied, true);
  assert.equal(caps.body.floorsSuspended, false);
});

test('/caps without floors configured reads exactly as today', async () => {
  const d = drive({
    nowMs: TICK,
    config: { enforce: true },
    issueLists: { todo: [{ id: 'q0', status: 'todo', assigneeAgentId: 'agent-a' }], in_progress: [] },
  });
  await d.setup();
  await d.tick();
  d.setNow(TICK + 10 * 60000);
  await d.fire(runEvent('agent-a-run-1', TICK + 10 * 60000, 'agent-a'));
  d.setNow(TICK + 30 * 60000);
  d.setLane(0.328);
  await d.tick();
  const caps = await d.api('caps');
  assert.equal(caps.status, 200);
  for (const e of caps.body.agents) {
    assert.equal(e.floor ?? null, null);
    assert.notEqual(e.reason, 'reserved-floor');
  }
  assert.deepEqual(caps.body.reservedFloors, {});
});
