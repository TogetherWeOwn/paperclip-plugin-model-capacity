import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin, resolveConfig, validateConfigShape } from '../src/plugin.mjs';
import { manifest } from '../src/manifest.mjs';
import { DEFAULT_PACE_GUARD } from '../src/paceguard.mjs';

// The pace guard through the plugin: the enforcing hook, the event-time
// shadow path and the shadow tick all order accounts with the same guard, so
// they agree on when a pool is held at its cap and when it is released.

const TICK = Date.parse('2026-10-08T23:00:00Z');
const HOUR = 3600 * 1000;
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };

const aaRows = () => ([
  { slug: 'claude-opus-5-5', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
  { slug: 'claude-haiku-5-5-xhigh', intelligenceIndex: 53, intelligenceIndexCostPerTask: 8, price1mInputTokens: 1, price1mOutputTokens: 5 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
  { slug: 'gemini-2-5-flash', intelligenceIndex: 54, intelligenceIndexCostPerTask: 5, price1mInputTokens: 1, price1mOutputTokens: 3 },
]);

// A claude lane that resets in `hoursLeft` hours with `used` of its week
// spent. Position on the linear plan: used - (1 - hoursLeft / 168).
const claudeLane = (used, hoursLeft = 48, over = {}) => ({
  lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy',
  weekly: { used, resetsAt: new Date(TICK + hoursLeft * HOUR).toISOString() },
  fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
  observedAt: new Date(TICK).toISOString(), quality: 'live',
  models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  ...over,
});
const geminiLane = (used, hoursLeft = 48) => ({
  lane: 'gemini-1', provider: 'gemini', accountKey: 'g1', health: 'healthy',
  weekly: { used, resetsAt: new Date(TICK + hoursLeft * HOUR).toISOString() },
  fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
  observedAt: new Date(TICK).toISOString(), quality: 'live',
  models: ['gemini-2-5-flash'],
});

const runEvent = (runId, atMs, type = 'agent.run.started', agentId = 'agent-9') => ({
  type, companyId: 'acme', entityId: runId,
  payload: { run: { agentId, provider: 'claude' } },
  occurredAt: new Date(atMs).toISOString(),
});

function drive({ config = {}, accounts }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = TICK;
  let lane = accounts;
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET, ...(config.cliproxy ?? {}) } }) },
    state: { get: async k => store.get(skey(k)) ?? null, set: async (k, v) => { store.set(skey(k), v); } },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => ({ observedAt: new Date(now).toISOString(), accounts: lane }) }) },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now });
  return {
    setNow: ms => { now = ms; },
    setAccounts: a => { lane = a; },
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: () => jobs.get('shadow-tick')({}),
    fire: e => handlers.get(e.type)(e),
    hook: (runId, extra = {}) => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId: 'agent-9', issueId: null, adapterType: 'claude-code',
      invocationSource: 'test', wakeReason: null, agentDefaultModel: null, previous: null,
      issueOverrideModel: null, deadlineMs: 1500, ...extra,
    }),
    api: routeKey => plugin.onApiRequest({ companyId: 'acme', routeKey }),
    killIo: () => {
      for (const k of ['config', 'state', 'secrets', 'http', 'agents', 'issues']) {
        io[k] = new Proxy({}, { get: () => { throw new Error(`io-forbidden:${k}`); } });
      }
    },
  };
}

// 90% spent with 48h left is 18.6 points ahead of the linear plan; the
// slots left (0.1 of the week over 48h) are well under one, so the cap is 1.
const AHEAD = () => [claudeLane(0.9, 48)];
// 50% spent with 48h left is 21 points behind plan: no cap applies.
const BEHIND = () => [claudeLane(0.5, 48)];

test('hook: an ahead pool serves one run, then defers the next with the guard\'s retry interval', async () => {
  const d = drive({ config: { enforce: true }, accounts: AHEAD() });
  await d.setup();
  await d.tick();
  d.killIo();
  const first = await d.hook('run-1');
  assert.equal(first.kind, 'decide', 'minimum of 1 in flight while it has headroom');
  const second = await d.hook('run-2');
  assert.equal(second.kind, 'defer');
  assert.equal(second.retryAfterMs, DEFAULT_PACE_GUARD.retryAfterMs);
  assert.match(second.reason, /pace guard/);
  assert.match(second.reason, /claude/);
  // The same run asks again (host retry): its own decision does not count against it.
  const again = await d.hook('run-1');
  assert.equal(again.kind, 'decide');
});

test('hook: a pool that is behind plan is never held', async () => {
  const d = drive({ config: { enforce: true }, accounts: BEHIND() });
  await d.setup();
  await d.tick();
  d.killIo();
  for (let i = 0; i < 6; i++) {
    assert.equal((await d.hook(`run-${i}`)).kind, 'decide', `run ${i}`);
  }
});

test('hook: the cap releases when the run finishes and the next tick republishes the pool', async () => {
  const d = drive({ config: { enforce: true }, accounts: AHEAD() });
  await d.setup();
  await d.tick();
  assert.equal((await d.hook('run-1')).kind, 'decide');
  assert.equal((await d.hook('run-2')).kind, 'defer');
  d.setNow(TICK + 2 * 60000);
  await d.fire(runEvent('run-1', TICK + 2 * 60000, 'agent.run.finished'));
  await d.tick();
  assert.equal((await d.hook('run-2')).kind, 'decide', 'a slot is free again');
  assert.equal((await d.hook('run-3')).kind, 'defer');
});

test('hook: the guard releases when time catches the plan up', async () => {
  // 90% spent with 48h left is ahead; with 5h left the linear plan is at 97%.
  const d = drive({ config: { enforce: true }, accounts: AHEAD() });
  await d.setup();
  await d.tick();
  assert.equal((await d.hook('run-1')).kind, 'decide');
  assert.equal((await d.hook('run-2')).kind, 'defer');
  d.setAccounts([claudeLane(0.9, 5)]);
  d.setNow(TICK + 60000);
  await d.tick();
  for (const id of ['run-3', 'run-4', 'run-5']) assert.equal((await d.hook(id)).kind, 'decide', id);
});

test('hook: enabled=false restores the old behaviour (no cap)', async () => {
  const d = drive({ config: { enforce: true, pacing: { guard: { enabled: false } } }, accounts: AHEAD() });
  await d.setup();
  await d.tick();
  for (const id of ['run-1', 'run-2', 'run-3']) assert.equal((await d.hook(id)).kind, 'decide', id);
});

test('hook: a custom margin and retry interval are honoured', async () => {
  // A 25-point margin: 18.6 points ahead is within it, so no cap.
  const wide = drive({ config: { enforce: true, pacing: { guard: { marginPct: 0.25 } } }, accounts: AHEAD() });
  await wide.setup();
  await wide.tick();
  for (const id of ['run-1', 'run-2', 'run-3']) assert.equal((await wide.hook(id)).kind, 'decide', id);
  const slow = drive({ config: { enforce: true, pacing: { guard: { retryAfterMs: 120000 } } }, accounts: AHEAD() });
  await slow.setup();
  await slow.tick();
  await slow.hook('run-1');
  assert.equal((await slow.hook('run-2')).retryAfterMs, 120000);
});

test('hook: with a second pool behind plan, the run goes there; with none left it defers', async () => {
  const d = drive({ config: { enforce: true }, accounts: [claudeLane(0.9, 48), geminiLane(0.3, 48)] });
  await d.setup();
  await d.tick();
  const models = [];
  for (const id of ['run-1', 'run-2', 'run-3']) {
    const out = await d.hook(id);
    assert.equal(out.kind, 'decide', id);
    models.push(out.model);
  }
  // Gemini is behind plan and is a trial family (two in flight at most);
  // the ahead claude pool takes the third, its one allowed run.
  assert.deepEqual(models.map(m => m.split('-')[0]), ['gemini', 'gemini', 'claude']);
  const fourth = await d.hook('run-4');
  assert.equal(fourth.kind, 'defer', 'claude is at its cap and gemini has no trial slot left');
  assert.match(fourth.reason, /pace guard: claude /);
});

test('hook: a run the event-time path already decided does not hold the pool against itself', async () => {
  // The host fires agent.run.started at claim, the event-time path decides
  // the run, a tick publishes the view with that decision counted in the
  // pool, and only then does the hook resolve the same run.
  const d = drive({ config: { enforce: true }, accounts: AHEAD() });
  await d.setup();
  await d.tick();
  d.setNow(TICK + 30000);
  await d.fire(runEvent('run-a', TICK + 30000));
  d.setNow(TICK + 60000);
  await d.tick();
  assert.equal((await d.hook('run-a')).kind, 'decide', 'its own slot is not counted against it');
  assert.equal((await d.hook('run-b')).kind, 'defer', 'a different run still sees the slot taken');
});

test('event-time shadow path holds the pool at its cap: the third concurrent run records no decision', async () => {
  // A 0.9h mean run turns the share into 1.67 slots: cap 2.
  const d = drive({ config: { concurrency: { maxTotal: 75, meanRunDurationHours: 0.9 } }, accounts: AHEAD() });
  await d.setup();
  await d.tick();
  d.setNow(TICK + 60000);
  for (const [i, id] of ['run-a', 'run-b', 'run-c'].entries()) await d.fire(runEvent(id, TICK + 1000 + i));
  await d.tick();
  const cap = (await d.api('capacity')).body;
  assert.equal(cap.shadow.mergedEventTime, 2, 'two event-time decisions landed; the third was held');
  const ids = (await d.api('shadow')).body.entries.map(e => e.runId).sort();
  assert.deepEqual(ids, ['run-a', 'run-b']);
  assert.equal(cap.shadow.skippedPaced, 1, 'the tick reports the held run');
});

test('shadow tick agrees with the hook: it holds the second run and decides it once a slot frees', async () => {
  const d = drive({ config: {}, accounts: AHEAD() });
  await d.setup();
  await d.tick();
  d.setNow(TICK + 60000);
  await d.fire(runEvent('run-a', TICK + 1000));
  await d.fire(runEvent('run-b', TICK + 2000));
  await d.tick();
  let ids = (await d.api('shadow')).body.entries.map(e => e.runId);
  assert.deepEqual(ids.sort(), ['run-a'], 'only one run decided on the ahead pool');
  d.setNow(TICK + 120000);
  await d.fire(runEvent('run-a', TICK + 120000, 'agent.run.finished'));
  await d.tick();
  ids = (await d.api('shadow')).body.entries.map(e => e.runId);
  assert.ok(ids.includes('run-b'), 'run-b is decided once run-a is done');
});

test('shadow tick does not count the run being decided against its own pool', async () => {
  // run-a started before any tick, so only its model ties it to the pool.
  // The census counts it there; the pool is at its cap of 1 only because of
  // run-a itself, so the guard must not hold it.
  const d = drive({ config: {}, accounts: AHEAD() });
  await d.setup();
  d.setNow(TICK + 60000);
  await d.fire({
    type: 'agent.run.started', companyId: 'acme', entityId: 'run-a',
    payload: { run: { agentId: 'agent-9', provider: 'claude', model: 'claude-opus-5-5' } },
    occurredAt: new Date(TICK + 1000).toISOString(),
  });
  await d.tick();
  const ids = (await d.api('shadow')).body.entries.map(e => e.runId);
  assert.deepEqual(ids, ['run-a'], 'a lone running run still gets its shadow decision');
  assert.equal((await d.api('capacity')).body.shadow.skippedPaced, 0);
});

test('shadow tick holds both of two running runs on a one-slot pool: the pool really is full', async () => {
  const d = drive({ config: {}, accounts: AHEAD() });
  await d.setup();
  d.setNow(TICK + 60000);
  for (const [i, id] of ['run-a', 'run-b'].entries()) {
    await d.fire({
      type: 'agent.run.started', companyId: 'acme', entityId: id,
      payload: { run: { agentId: 'agent-9', provider: 'claude', model: 'claude-opus-5-5' } },
      occurredAt: new Date(TICK + 1000 + i).toISOString(),
    });
  }
  await d.tick();
  assert.deepEqual((await d.api('shadow')).body.entries, []);
  assert.equal((await d.api('capacity')).body.shadow.skippedPaced, 2);
});

test('plugin loop: across six simulated hours the ahead pool holds at its cap and refills as runs finish', async () => {
  // 0.9h runs make the share 1.67 slots: cap 2. One tick a minute, one new
  // queued run offered to the hook a minute (a deferred run is re-offered).
  const d = drive({ config: { enforce: true, concurrency: { maxTotal: 75, meanRunDurationHours: 0.9 } }, accounts: AHEAD() });
  await d.setup();
  await d.tick();
  const RUN_MIN = 54;
  const live = new Map(); // runId -> finish minute
  let seq = 0;
  let waiting = null;
  let started = 0;
  let deferred = 0;
  let peak = 0;
  for (let m = 1; m <= 360; m++) {
    const at = TICK + m * 60000;
    d.setNow(at);
    for (const [runId, endMin] of [...live]) {
      if (endMin <= m) {
        await d.fire(runEvent(runId, at, 'agent.run.finished'));
        live.delete(runId);
      }
    }
    await d.tick();
    waiting ??= `loop-${seq++}`;
    const out = await d.hook(waiting);
    if (out.kind === 'decide') {
      await d.fire(runEvent(waiting, at));
      live.set(waiting, m + RUN_MIN);
      waiting = null;
      started += 1;
    } else {
      deferred += 1;
      assert.match(out.reason, /pace guard/);
    }
    peak = Math.max(peak, live.size);
    assert.ok(live.size <= 2, `minute ${m}: ${live.size} in flight on a cap of 2`);
  }
  assert.equal(peak, 2, 'the pool is filled to its cap');
  assert.ok(started >= 11, `slots are refilled as runs finish: ${started} runs in 6h (2 slots / 0.9h = 13 at best)`);
  assert.ok(deferred > 0, 'and runs beyond the cap waited');
});

test('/capacity reports the guard state per pool', async () => {
  const d = drive({ config: { enforce: true }, accounts: AHEAD() });
  await d.setup();
  await d.tick();
  await d.hook('run-1');
  d.setNow(TICK + 60000);
  await d.tick();
  const cap = (await d.api('capacity')).body;
  assert.equal(cap.paceGuard.enabled, true);
  assert.equal(cap.paceGuard.marginPct, 0.02);
  const pool = cap.paceGuard.pools.find(p => p.pool === 'claude');
  assert.equal(pool.state, 'paced');
  assert.equal(pool.cap, 1);
  assert.equal(pool.inFlight, 1);
  assert.ok(pool.planAhead > 0.18 && pool.planAhead < 0.19, `planAhead ${pool.planAhead}`);
  assert.ok(pool.pacedSlots > 0 && pool.pacedSlots < 1);
  const acct = cap.accounts.find(a => a.accountId === 'claude:a1');
  assert.ok(acct.planAhead > 0.18 && acct.planAhead < 0.19);
});

test('/capacity reports a behind-plan pool as on-plan, and an unknown reset as not measured', async () => {
  const d = drive({ config: { enforce: true }, accounts: BEHIND() });
  await d.setup();
  await d.tick();
  const pool = (await d.api('capacity')).body.paceGuard.pools.find(p => p.pool === 'claude');
  assert.equal(pool.state, 'on-plan');
  const unknown = drive({ config: { enforce: true }, accounts: [claudeLane(0.9, 48, { weekly: { used: 0.9, resetsAt: null } })] });
  await unknown.setup();
  await unknown.tick();
  const p2 = (await unknown.api('capacity')).body.paceGuard.pools.find(p => p.pool === 'claude');
  assert.equal(p2.state, 'not-measured');
  assert.equal(p2.planAhead, null);
  await unknown.hook('run-1');
  assert.equal((await unknown.hook('run-2')).kind, 'decide', 'unknown plan position fails open');
});

test('config: pacing.guard resolves to the defaults and validates', () => {
  assert.deepEqual(resolveConfig({}).pacing.guard, { ...DEFAULT_PACE_GUARD });
  assert.deepEqual(resolveConfig({ pacing: { guard: { marginPct: 0.05 } } }).pacing.guard,
    { ...DEFAULT_PACE_GUARD, marginPct: 0.05 });
  assert.deepEqual(validateConfigShape({ pacing: { guard: { enabled: true, marginPct: 0.03, retryAfterMs: 60000 } } }), []);
  assert.ok(validateConfigShape({ pacing: { guard: { enabled: 'yes' } } }).length > 0);
  assert.ok(validateConfigShape({ pacing: { guard: { marginPct: 2 } } }).length > 0);
  assert.ok(validateConfigShape({ pacing: { guard: { marginPct: -0.1 } } }).length > 0);
  assert.ok(validateConfigShape({ pacing: { guard: { retryAfterMs: 10 } } }).length > 0);
  assert.ok(validateConfigShape({ pacing: { guard: 'on' } }).length > 0);
});

test('manifest: the pacing.guard schema defaults match the code defaults', () => {
  const g = manifest.instanceConfigSchema.properties.pacing.properties.guard;
  assert.equal(g.type, 'object');
  assert.equal(g.additionalProperties, false);
  assert.equal(g.properties.enabled.default, DEFAULT_PACE_GUARD.enabled);
  assert.equal(g.properties.marginPct.default, DEFAULT_PACE_GUARD.marginPct);
  assert.equal(g.properties.retryAfterMs.default, DEFAULT_PACE_GUARD.retryAfterMs);
});
