import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin, resolveConfig, validateConfigShape } from '../src/plugin.mjs';
import { manifest } from '../src/manifest.mjs';
import { DEFAULT_PACE_GUARD } from '../src/paceguard.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';
import { createBreakerStore, breakerStoreToJSON, recordArmFailure, sanitizeBreakers } from '../src/breakers.mjs';

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

function drive({ config = {}, accounts, agentGets = {}, heartbeats = [], snapshotRows = aaRows() }) {
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
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness({ observedAt: new Date(now).toISOString(), accounts: lane }, now) }) },
    agents: { get: async (id) => agentGets[id] ?? null, getQueuedRunCounts: async () => heartbeats },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return {
    setNow: ms => { now = ms; },
    seed: (key, value) => { store.set(skey(key), value); },
    setAccounts: a => { lane = a; },
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: snapshotRows, duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: () => jobs.get('quota-refresh')({}),
    fire: e => handlers.get(e.type)(e),
    hook: (runId, extra = {}) => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId: 'agent-9', issueId: null, adapterType: 'claude-code',
      invocationSource: 'test', wakeReason: null, agentDefaultModel: null, previous: null,
      issueOverrideModel: null, deadlineMs: 1500, ...extra,
    }),
    api: routeKey => plugin.onApiRequest({ companyId: 'acme', routeKey }),
    updateCapacity: fn => fn(store.get(skey({ ...AA_STATE_KEY, stateKey: 'capacity-v1' }))),
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
  const d = drive({ config: { enforce: true, pacing: { holdAheadPts: null } }, accounts: AHEAD() });
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
  const d = drive({ config: { enforce: true, pacing: { holdAheadPts: null } }, accounts: AHEAD() });
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
  const d = drive({ config: { enforce: true, pacing: { holdAheadPts: null } }, accounts: AHEAD() });
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
  const wide = drive({ config: { enforce: true, pacing: { holdAheadPts: null, guard: { marginPct: 0.25 } } }, accounts: AHEAD() });
  await wide.setup();
  await wide.tick();
  for (const id of ['run-1', 'run-2', 'run-3']) assert.equal((await wide.hook(id)).kind, 'decide', id);
  const slow = drive({ config: { enforce: true, pacing: { holdAheadPts: null, guard: { retryAfterMs: 120000 } } }, accounts: AHEAD() });
  await slow.setup();
  await slow.tick();
  await slow.hook('run-1');
  assert.equal((await slow.hook('run-2')).retryAfterMs, 120000);
});

test('hook: with a second pool behind plan, the run goes there; with none left it defers', async () => {
  const d = drive({ config: { enforce: true, pacing: { holdAheadPts: null } }, accounts: [claudeLane(0.9, 48), geminiLane(0.3, 48)] });
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
});

test('hook: a run the event-time path already decided does not hold the pool against itself', async () => {
  // The host fires agent.run.started at claim, the event-time path decides
  // the run, a tick publishes the view with that decision counted in the
  // pool, and only then does the hook resolve the same run.
  const d = drive({ config: { enforce: true, pacing: { holdAheadPts: null } }, accounts: AHEAD() });
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
  const d = drive({ config: { concurrency: { maxTotal: 75, meanRunDurationHours: 0.9 }, pacing: { holdAheadPts: null } }, accounts: AHEAD() });
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
  const d = drive({ config: { pacing: { holdAheadPts: null } }, accounts: AHEAD() });
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
  const d = drive({ config: { pacing: { holdAheadPts: null } }, accounts: AHEAD() });
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
  const d = drive({ config: { pacing: { holdAheadPts: null } }, accounts: AHEAD() });
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

test('plugin loop: six contended hours hold the ahead pool at its cap and refill it as runs finish', async () => {
  // 0.9h runs make the share 1.67 slots: cap 2. Four runs are always queued;
  // the host claims each (agent.run.started), asks the hook, and re-asks a
  // deferred run every retryAfterMs (5 min). Agent config names the model, so
  // the tick attributes the waiting runs to the pool as it does in production.
  const RETRY_MIN = 5;
  const RUN_MIN = 54;
  const agentGets = { 'agent-9': { adapterConfig: { model: 'claude-opus-5-5' } } };
  const d = drive({ config: { enforce: true, concurrency: { maxTotal: 75, meanRunDurationHours: 0.9 }, pacing: { holdAheadPts: null } }, accounts: AHEAD(), agentGets });
  await d.setup();
  await d.tick();
  const running = new Map(); // runId -> finish minute
  const waiting = new Map(); // runId -> next minute the host asks again
  let seq = 0;
  let started = 0;
  let deferrals = 0;
  let peak = 0;
  for (let m = 1; m <= 360; m++) {
    const at = TICK + m * 60000;
    d.setNow(at);
    for (const [runId, endMin] of [...running]) {
      if (endMin <= m) {
        await d.fire(runEvent(runId, at, 'agent.run.finished'));
        running.delete(runId);
      }
    }
    while (running.size + waiting.size < 6) {
      const runId = `loop-${seq++}`;
      await d.fire(runEvent(runId, at));
      waiting.set(runId, m);
    }
    await d.tick();
    for (const [runId, nextTry] of [...waiting]) {
      if (nextTry > m) continue;
      const out = await d.hook(runId);
      if (out.kind === 'decide') {
        waiting.delete(runId);
        running.set(runId, m + RUN_MIN);
        started += 1;
      } else {
        assert.equal(out.kind, 'defer');
        assert.match(out.reason, /pace guard/);
        assert.equal(out.retryAfterMs, RETRY_MIN * 60000);
        waiting.set(runId, m + RETRY_MIN);
        deferrals += 1;
      }
    }
    peak = Math.max(peak, running.size);
    assert.ok(running.size <= 2, `minute ${m}: ${running.size} in flight on a cap of 2`);
  }
  assert.equal(peak, 2, 'the pool is filled to its cap');
  // 2 slots / 0.9h over 6h is 13 runs; retry spacing and tick lag cost at most
  // a couple. With waiting runs counted as in flight the pool wedges at 8.
  assert.ok(started >= 12, `slots are refilled as runs finish, not wedged by the waiting runs: ${started} started in 6h`);
  assert.ok(deferrals > started, 'and the runs beyond the cap waited');
});

test('runs the hook deferred do not hold the pool: it refills once the real runs finish', async () => {
  // The host claims a run (agent.run.started) before the hook answers, so a
  // deferred run sits in the ledger as running; the tick then attributes it
  // to the pool its agent's configured model serves. Counted as in flight,
  // two waiting runs would hold an idle one-slot pool at its cap until the
  // host gave up on them.
  const agentGets = { 'agent-9': { adapterConfig: { model: 'claude-opus-5-5' } } };
  const d = drive({ config: { enforce: true, pacing: { holdAheadPts: null } }, accounts: AHEAD(), agentGets });
  await d.setup();
  await d.tick();
  let at = TICK + 30000;
  d.setNow(at);
  await d.fire(runEvent('run-1', at));
  assert.equal((await d.hook('run-1')).kind, 'decide');
  for (const id of ['run-2', 'run-3']) {
    await d.fire(runEvent(id, at));
    assert.equal((await d.hook(id)).kind, 'defer', `${id} waits behind run-1`);
  }
  at += 60000;
  d.setNow(at);
  await d.tick(); // backfills the waiting runs' actual account from agent config
  const held = (await d.api('capacity')).body.paceGuard.pools.find(p => p.pool === 'claude');
  assert.equal(held.inFlight, 1, 'only the running run counts');
  at += 60000;
  d.setNow(at);
  await d.fire(runEvent('run-1', at, 'agent.run.finished'));
  await d.tick();
  assert.equal((await d.api('capacity')).body.paceGuard.pools.find(p => p.pool === 'claude').state, 'ahead',
    'idle again: under its cap, not paced');
  assert.equal((await d.hook('run-2')).kind, 'decide', 'the first waiting run is admitted');
  assert.equal((await d.hook('run-3')).kind, 'defer', 'and the next still waits for it');
});

test('a lane without ready credentials is outside the pool: its position does not move the mean', async () => {
  // Lane a1 is 4 points behind plan and ready; lane a2 is far ahead but has
  // no ready credential, so it can serve nothing. The pool is a1 alone.
  // Readiness exclusion is opt-in: this pins the flag on (off mode admits
  // both lanes, covered by the credential-readiness parity corpus).
  const ready = claudeLane(0.6, 48, { models: ['claude-opus-5-5'] });
  const unready = { ...claudeLane(0.99, 48, { models: ['claude-sonnet-5-5'] }),
    accountKey: 'a2', lane: 'claude-2', credentialAvailability: { version: 1, models: [] } };
  const d = drive({ config: { enforce: true, credentialReadiness: { enforce: true } }, accounts: [ready, unready] });
  await d.setup();
  await d.tick();
  const pool = (await d.api('capacity')).body.paceGuard.pools.find(p => p.pool === 'claude');
  assert.equal(pool.lanes, 1);
  assert.equal(pool.state, 'on-plan');
  assert.ok(pool.planAhead < 0.02, `planAhead ${pool.planAhead}`);
  for (const id of ['run-1', 'run-2', 'run-3']) assert.equal((await d.hook(id)).kind, 'decide', id);
});

test('a deferred run that later runs anyway (the hook keeps it) counts as executing again', async () => {
  const agentGets = { 'agent-9': { adapterConfig: { model: 'claude-opus-5-5' } } };
  const d = drive({ config: { enforce: true, pacing: { holdAheadPts: null } }, accounts: AHEAD(), agentGets });
  await d.setup();
  await d.tick();
  let at = TICK + 30000;
  d.setNow(at);
  await d.fire(runEvent('run-1', at));
  assert.equal((await d.hook('run-1')).kind, 'decide');
  await d.fire(runEvent('run-2', at));
  assert.equal((await d.hook('run-2')).kind, 'defer', 'run-2 waits behind run-1');
  // The operator pins a model on run-2's issue; the retry keeps it and it runs.
  assert.deepEqual(await d.hook('run-2', { issueOverrideModel: 'claude-opus-5-5' }), { kind: 'keep' });
  at += 60000;
  d.setNow(at);
  await d.tick();
  await d.fire(runEvent('run-1', at, 'agent.run.finished'));
  const out = await d.hook('run-3');
  assert.equal(out.kind, 'defer', 'run-2 is executing on a cap of one, so run-3 still waits');
  assert.match(out.reason, /1 of 1 in flight/);
});

test('an unmeasured lane in the pool makes the whole pool fail open', async () => {
  const unknownReset = { ...claudeLane(0.5, 48), accountKey: 'a2', lane: 'claude-2', weekly: { used: 0.5, resetsAt: null } };
  const d = drive({ config: { enforce: true, pacing: { holdAheadPts: null } }, accounts: [claudeLane(0.9, 48), unknownReset] });
  await d.setup();
  await d.tick();
  const pool = (await d.api('capacity')).body.paceGuard.pools.find(p => p.pool === 'claude');
  assert.equal(pool.state, 'not-measured');
  for (const id of ['run-1', 'run-2', 'run-3']) assert.equal((await d.hook(id)).kind, 'decide', id);
});

test('a paced pool plus a trial-full unpaced pool defers on the guard retry', async () => {
  const d = drive({ config: { enforce: true, pacing: { holdAheadPts: null } }, accounts: [claudeLane(0.9, 48), geminiLane(0.3, 48)] });
  await d.setup();
  await d.tick();
  for (const id of ['run-1', 'run-2', 'run-3']) assert.equal((await d.hook(id)).kind, 'decide', id);
  // Claude is held (one run) and gemini's two trial slots are full. The
  // paced pool is a real minutes-scale hold even though an unpaced pool is
  // also unselectable, so the wait carries the guard retry, not the 60 s
  // generic one, and names both holds.
  const fourth = await d.hook('run-4');
  assert.equal(fourth.kind, 'defer');
  assert.equal(fourth.retryAfterMs, DEFAULT_PACE_GUARD.retryAfterMs);
  assert.match(fourth.reason, /pace guard/);
  assert.match(fourth.reason, /claude/);
  assert.match(fourth.reason, /1 unpaced account\(s\) also unselectable/);
});

test('validateConfigShape tolerates a non-object pacing like before the guard existed', () => {
  for (const pacing of [5, 'abc', true, [], null]) {
    assert.doesNotThrow(() => validateConfigShape({ pacing }), JSON.stringify(pacing));
  }
});

test('tick and hook agree on pool membership when a lane\'s every arm is breaker-open', async () => {
  // a1 is 18 points ahead and ready; a2 is far behind plan but every arm on
  // it is breaker-open, so it cannot serve and is not part of the pool. The
  // hook already built the pool from breaker-filtered rungs; the tick must too.
  const mk = () => [claudeLane(0.9, 48), { ...claudeLane(0.2, 48), accountKey: 'a2', lane: 'claude-2' }];
  const probe = drive({ config: { enforce: true, pacing: { holdAheadPts: null } }, accounts: mk() });
  await probe.setup();
  await probe.tick();
  const ladders = (await probe.api('ladder')).body.ladders;
  const armIds = (ladders['claude:a2']?.rungs ?? []).map(r => r.armId);
  assert.ok(armIds.length > 0, 'a2 has arms');
  const cfg = sanitizeBreakers();
  const seed = createBreakerStore();
  for (const armId of armIds) {
    recordArmFailure(seed, 'claude:a2', armId, { atMs: TICK - 120000, errorText: 'auth_unavailable' }, TICK - 120000, cfg);
    recordArmFailure(seed, 'claude:a2', armId, { atMs: TICK - 60000, errorText: 'auth_unavailable' }, TICK - 60000, cfg);
  }
  const d = drive({ config: { enforce: true, pacing: { holdAheadPts: null } }, accounts: mk() });
  await d.setup();
  d.seed({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'breaker-v1' }, breakerStoreToJSON(seed, { nowMs: TICK, cfg }));
  await d.tick();
  assert.equal((await d.hook('run-1')).kind, 'decide');
  assert.equal((await d.hook('run-2')).kind, 'defer', 'the hook holds a1 alone at its cap');
  d.setNow(TICK + 60000);
  await d.tick();
  const cap = (await d.api('capacity')).body;
  const pool = cap.paceGuard.pools.find(p => p.pool === 'claude');
  assert.equal(pool.lanes, 1, 'the tick report counts a1 alone');
  assert.equal(pool.state, 'paced');
});

test('/capacity reports the guard state per pool', async () => {
  const d = drive({ config: { enforce: true, pacing: { holdAheadPts: null } }, accounts: AHEAD() });
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

test('a reset further away than one weekly window is an unknown position: it fails open', async () => {
  // 30% used with 240h to reset cannot sit on a 168h window. Clamped, it
  // would read 30 points ahead of plan and throttle a lane with no real lead.
  for (const hoursLeft of [240, 600]) {
    const d = drive({ config: { enforce: true }, accounts: [claudeLane(0.3, hoursLeft)] });
    await d.setup();
    await d.tick();
    const pool = (await d.api('capacity')).body.paceGuard.pools.find(p => p.pool === 'claude');
    assert.equal(pool.state, 'not-measured', `${hoursLeft}h`);
    assert.equal(pool.planAhead, null);
    for (const id of ['run-1', 'run-2', 'run-3']) assert.equal((await d.hook(id)).kind, 'decide', `${hoursLeft}h ${id}`);
  }
});

test('a reset that already passed is an unknown position too (stale reading)', async () => {
  const d = drive({ config: { enforce: true }, accounts: [claudeLane(0.99, -3)] });
  await d.setup();
  await d.tick();
  assert.equal((await d.api('capacity')).body.paceGuard.pools.find(p => p.pool === 'claude')?.state ?? 'not-measured', 'not-measured');
});

test('a window that has just reset (reset one week out, clock skew of minutes) is still measured', async () => {
  const d = drive({ config: { enforce: true }, accounts: [claudeLane(0.3, 168.2)] });
  await d.setup();
  await d.tick();
  const pool = (await d.api('capacity')).body.paceGuard.pools.find(p => p.pool === 'claude');
  assert.equal(pool.state, 'hard-held', '30% used at hour 0 is measured and exceeds the hard-hold band');
  assert.ok(Math.abs(pool.planAhead - 0.3) < 1e-9);
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

test('weekly hard hold: hook and capacity keep a deeply ahead idle lane at zero until the plan catches up', async () => {
  const d = drive({ config: { enforce: true }, accounts: [claudeLane(0.83, 104.6), geminiLane(0.3, 48)] });
  await d.setup();
  await d.tick();
  let cap = (await d.api('capacity')).body;
  assert.equal(cap.paceGuard.holdAheadPts, 0.10);
  assert.equal(cap.paceGuard.pools.find(p => p.pool === 'claude').cap, 0);
  assert.match((await d.hook('held-first')).model, /^gemini/);
  d.setAccounts([claudeLane(0.83, 30), geminiLane(0.3, 48)]);
  d.setNow(TICK + 60000);
  await d.tick();
  cap = (await d.api('capacity')).body;
  assert.notEqual(cap.paceGuard.pools.find(p => p.pool === 'claude').cap, 0);
});

test('weekly hard hold: a sole held role defers without a suspension diagnostic', async () => {
  const d = drive({ config: { enforce: true, pacing: { holdAheadPts: 0.10 } }, accounts: AHEAD() });
  await d.setup();
  await d.tick();
  const cap = (await d.api('capacity')).body;
  assert.deepEqual(cap.paceGuard.roleSafety, []);
  assert.equal(cap.paceGuard.rawPools.find(p => p.pool === 'claude').cap, 0);
  assert.deepEqual(cap.paceGuard.rawPools.find(p => p.pool === 'claude').hardHeldAccountIds, ['claude:a1']);
  assert.equal((await d.hook('safety-first')).kind, 'defer');
  assert.equal((await d.hook('safety-second')).kind, 'defer');
});

test('weekly plan prices only spendable quota above the configured level floor', async () => {
  const d = drive({ config: { burnMode: { floors: { 'claude:*': 0.15 } } }, accounts: [claudeLane(0.4, 84)] });
  await d.setup();
  await d.tick();
  const a = (await d.api('capacity')).body.accounts.find(a => a.accountId === 'claude:a1');
  assert.ok(Math.abs(a.planAhead - (-0.025)) < 1e-10, `plan ahead ${a.planAhead}`);
  assert.ok(Math.abs(a.requiredRatePerHour - 0.45 / 84) < 1e-10, `required ${a.requiredRatePerHour}`);
  assert.equal(a.planTargetUsedPct, 0.85);
});

test('weekly C* uses exactly the spendable weekly quota above the floor', async () => {
  const onlyOpus = { models: ['claude-opus-5-5'] };
  const d = drive({
    config: { burnMode: { floors: { 'claude:*': 0.15 } },
      concurrency: { maxTotal: 75, meanRunDurationHours: 2 } },
    accounts: [claudeLane(0.399, 84.5, onlyOpus)],
  });
  await d.setup();
  await d.tick();
  await d.fire(runEvent('floor-measured-run', TICK + 60000));
  await d.fire(runEvent('floor-measured-run', TICK + 120000, 'agent.run.finished'));
  d.setNow(TICK + 0.5 * HOUR);
  d.setAccounts([claudeLane(0.4, 84.5, { ...onlyOpus,
    observedAt: new Date(TICK + 0.5 * HOUR).toISOString() })]);
  await d.tick();
  const capacity = (await d.api('capacity')).body;
  const account = capacity.accounts.find(a => a.accountId === 'claude:a1');
  const perAccount = capacity.perAccount.find(a => a.accountId === 'claude:a1');
  assert.equal(capacity.calibration, 'measured', JSON.stringify(perAccount));
  assert.ok(Math.abs(account.spendableRemaining - 0.45) < 1e-10);
  // One run spent 0.001 of the week. (0.45 / 84) / 0.001 * 2 = 75/7 slots;
  // using the raw 0.60 remaining would incorrectly grant 100/7 slots.
  assert.ok(Math.abs(perAccount.slots - 75 / 7) < 1e-9, `weekly floor C* slots ${perAccount.slots}, expected ${75 / 7}`);
});

test('weekly hard hold: a regenerating-meter floor cannot reduce the weekly target or block healthy work', async () => {
  for (const regenUsed of [0.1, 0]) {
    // Half the week elapsed, 30% weekly used: twenty points BEHIND plan.
    // The 80% floor governs the regenerating balance, not the weekly quota.
    const d = drive({ config: { enforce: true, burnMode: { floors: { 'claude:*': 0.8 } } },
      accounts: [claudeLane(0.3, 84, { meterInfo: { weeklyUsed: regenUsed } }), geminiLane(0.3, 84)] });
    await d.setup();
    await d.tick();
    const cap = (await d.api('capacity')).body;
    const a = cap.accounts.find(a => a.accountId === 'claude:a1');
    assert.equal(a.health, 'healthy');
    assert.notEqual(a.burnMode, true, 'the account is ordinarily paced, not burn-exempt');
    assert.equal(a.burnFloor.floor, 0.8);
    assert.equal(a.burnFloor.remaining, 1 - regenUsed);
    assert.equal(a.planTargetUsedPct, 1, 'a regenerating floor leaves the weekly endpoint at 100%');
    assert.ok(Math.abs(a.planAhead - (-0.2)) < 1e-10, `plan ahead ${a.planAhead}`);
    assert.ok(Math.abs(a.spendableRemaining - 0.7) < 1e-10, `spendable ${a.spendableRemaining}`);
    assert.ok(Math.abs(a.requiredRatePerHour - 0.7 / 84) < 1e-10, `required ${a.requiredRatePerHour}`);
    const pool = cap.paceGuard.rawPools.find(p => p.pool === 'claude');
    assert.ok(!(pool.hardHeldAccountIds ?? []).includes('claude:a1'));
    assert.equal(cap.paceGuard.roleSafety.length, 0, 'an eligible peer prevents empty-role safety from hiding a false hold');
    // The peer's trial family can take two runs; healthy weekly capacity
    // must still serve when those trial slots are occupied.
    const runIds = [0, 1, 2].map(i => `regen-floor-${regenUsed}-${i}`);
    const models = [];
    for (const id of runIds) {
      const out = await d.hook(id);
      assert.equal(out.kind, 'decide');
      models.push(out.model);
    }
    assert.ok(models.some(model => model.startsWith('claude')), `models ${models}`);

    // The fix must not remove the regenerating meter's own exhaustion gate.
    for (const id of runIds) await d.fire(runEvent(id, TICK + 30000, 'agent.run.finished'));
    d.setAccounts([claudeLane(0.3, 84, { meterInfo: { weeklyUsed: 0.2 } }), geminiLane(0.3, 84)]);
    d.setNow(TICK + 60000);
    await d.tick();
    assert.equal((await d.api('capacity')).body.accounts.find(a => a.accountId === 'claude:a1').health, 'exhausted');
    assert.match((await d.hook(`regen-floor-reached-${regenUsed}`)).model, /^gemini/);
  }
});

test('weekly hard hold: a regenerating-meter floor does not exempt a genuinely ahead weekly account', async () => {
  const d = drive({ config: { enforce: true, burnMode: { floors: { 'claude:*': 0.8 } } },
    accounts: [claudeLane(0.65, 84, { meterInfo: { weeklyUsed: 0.1 } }), geminiLane(0.3, 84)] });
  await d.setup();
  await d.tick();
  const cap = (await d.api('capacity')).body;
  const a = cap.accounts.find(a => a.accountId === 'claude:a1');
  assert.equal(a.health, 'healthy');
  assert.ok(Math.abs(a.planAhead - 0.15) < 1e-10, `plan ahead ${a.planAhead}`);
  assert.deepEqual(cap.paceGuard.rawPools.find(p => p.pool === 'claude').hardHeldAccountIds, ['claude:a1']);
  assert.match((await d.hook('regen-weekly-ahead')).model, /^gemini/);
});

test('weekly hard hold: burn opt-in bypasses the hold without disabling it for ordinary accounts', async () => {
  const d = drive({ config: { enforce: true, burnMode: { accounts: ['claude:*'] } },
    accounts: [claudeLane(0.83, 104.6), geminiLane(0.3, 48)] });
  await d.setup();
  await d.tick();
  assert.match((await d.hook('burn-first')).model, /^claude/);
  assert.equal((await d.api('capacity')).body.paceGuard.pools.find(p => p.pool === 'claude').state, 'burn');
});

for (const mode of ['shadow', 'enforce']) {
  test(`weekly hard hold: an indistinguishable duplicate route stays closed (ranking=${mode})`, async () => {
    const fixture = {
      config: { enforce: true, taskRanking: { mode } },
      snapshotRows: aaRows().map(row => ({ ...row, terminalbenchV40: 0.9, scicode: 0.9, lcr: 0.9,
        ifbench: 0.9, omniscienceNonHallucination: 0.9, hle: 0.9, gpqa: 0.9, critpt: 0.9, gdpvalNormalized: 0.9 })),
      accounts: [claudeLane(0.83, 104.16), claudeLane(0.1, 120, {
        provider: 'devin', lane: 'devin-1', accountKey: 'd1', models: ['claude-opus-5-5'],
      })],
    };
    const peerOnly = drive({ ...fixture, accounts: fixture.accounts.slice(1) });
    await peerOnly.setup();
    await peerOnly.tick();
    assert.equal((await peerOnly.hook(`eligible-peer-${mode}`)).kind, 'decide',
      'the peer has a ready, role-eligible arm in the full pass');
    const d = drive(fixture);
    await d.setup();
    await d.tick();
    const capacity = (await d.api('capacity')).body;
    assert.ok(Math.abs(capacity.accounts.find(a => a.accountId === 'claude:a1').planAhead - 0.45) < 1e-10);
    assert.ok(capacity.accounts.find(a => a.accountId === 'devin:d1').planAhead < 0);
    const route = await d.hook(`duplicate-peer-${mode}`);
    assert.equal(route.kind, 'defer', JSON.stringify(route));
    assert.equal(route.model, undefined, 'the common model cannot prove the held native credential is excluded');
    await d.tick();
    const entry = (await d.api('shadow')).body.entries.find(e => e.runId === `duplicate-peer-${mode}`);
    assert.equal(entry?.accountId, undefined, 'an internal duplicate account label is not a safe emission');
    assert.equal(entry?.wouldModel, undefined);
  });
}

test('weekly soft cap: an unservable unknown-reset sibling cannot reopen fixed-model capacity', async () => {
  const onlyOpus = { models: ['claude-opus-5-5'] };
  const d = drive({
    config: { enforce: true, concurrency: { maxTotal: 75, meanRunDurationHours: 4 },
      roles: { keepAgentIds: ['fixed'] } },
    accounts: [claudeLane(0.55, 84.5, onlyOpus)],
    heartbeats: [{ agentId: 'fixed', queued: 8 }],
  });
  await d.setup();
  await d.tick();
  d.setNow(TICK + 0.5 * HOUR);
  const servable = claudeLane(0.58, 84.5, { ...onlyOpus, observedAt: new Date(TICK + 0.5 * HOUR).toISOString() });
  d.setAccounts([servable]);
  await d.tick();
  const read = async () => {
    const capacity = (await d.api('capacity')).body;
    // Calibrate the fleet response and bind the pin; the tick owns all lane sizing and pace facts.
    d.updateCapacity(cap => {
      cap.target = 8; cap.calibration = 'measured';
      cap.keptByAgent.fixed = { accountId: 'claude:a1' };
    });
    const caps = (await d.api('caps')).body;
    const pool = capacity.paceGuard.rawPools.find(p => p.pool === 'claude');
    return { capacity, summary: { lanes: pool?.lanes, cap: pool?.cap,
      allocated: caps.agents.find(a => a.agentId === 'fixed')?.allocated } };
  };
  const before = await read();
  const account = before.capacity.accounts.find(a => a.accountId === 'claude:a1');
  assert.ok(Math.abs(account.planAhead - 0.08) < 1e-10);
  assert.ok(Math.abs(account.measuredRatePerHour - 0.06) < 1e-10);
  assert.ok(before.capacity.perAccount.find(a => a.accountId === 'claude:a1').slots > 1);
  assert.deepEqual(before.summary, { lanes: 1, cap: 1, allocated: 1 });
  d.setNow(TICK + 31 * 60000);
  d.setAccounts([{ ...servable, observedAt: new Date(TICK + 31 * 60000).toISOString() },
    claudeLane(0.1, 84, { accountKey: 'empty', lane: 'claude-empty', models: [],
      weekly: { used: 0.1, resetsAt: null }, observedAt: new Date(TICK + 31 * 60000).toISOString() })]);
  await d.tick();
  const after = await read();
  const empty = after.capacity.accounts.find(a => a.accountId === 'claude:empty');
  assert.equal(empty.health, 'healthy');
  assert.deepEqual(empty.arms, [], 'the tick confirms the added lane has no servable arm');
  assert.equal(after.capacity.perAccount.find(a => a.accountId === 'claude:empty').slots, 0);
  assert.deepEqual(after.summary, { lanes: 1, cap: 1, allocated: 1 },
    'a zero-slot lane with no served model must not erase the finite raw cap');
});

test('weekly soft cap: an unready configured reviewer sibling cannot enter raw pool membership', async () => {
  const onlyOpus = { models: ['claude-opus-5-5'] };
  const d = drive({
    config: { enforce: true, credentialReadiness: { enforce: true },
      concurrency: { maxTotal: 75, meanRunDurationHours: 4 },
      roles: { keepAgentIds: ['fixed', 'reviewer-1'] },
      reviewerRouting: { agentIds: ['reviewer-1'], arms: [
        { provider: 'claude', model: 'claude-opus-5-5', effort: 'max' },
      ] } },
    accounts: [claudeLane(0.55, 84.5, onlyOpus)],
    heartbeats: [{ agentId: 'fixed', queued: 8 }],
  });
  await d.setup();
  await d.tick();
  d.setNow(TICK + 0.5 * HOUR);
  const ready = claudeLane(0.58, 84.5, { ...onlyOpus, observedAt: new Date(TICK + 0.5 * HOUR).toISOString() });
  d.setAccounts([ready]);
  await d.tick();
  const read = async () => {
    const capacity = (await d.api('capacity')).body;
    d.updateCapacity(cap => {
      cap.target = 8; cap.calibration = 'measured';
      cap.keptByAgent.fixed = { accountId: 'claude:a1' };
    });
    const caps = (await d.api('caps')).body;
    const pool = capacity.paceGuard.rawPools.find(p => p.pool === 'claude');
    return { capacity, summary: { lanes: pool?.lanes, cap: pool?.cap,
      allocated: caps.agents.find(a => a.agentId === 'fixed')?.allocated } };
  };
  const before = await read();
  const account = before.capacity.accounts.find(a => a.accountId === 'claude:a1');
  assert.ok(Math.abs(account.planAhead - 0.08) < 1e-10);
  assert.ok(Math.abs(account.measuredRatePerHour - 0.06) < 1e-10);
  assert.ok(before.capacity.perAccount.find(a => a.accountId === 'claude:a1').slots > 1);
  assert.deepEqual(before.summary, { lanes: 1, cap: 1, allocated: 1 });
  d.setNow(TICK + 31 * 60000);
  d.setAccounts([{ ...ready, observedAt: new Date(TICK + 31 * 60000).toISOString() },
    claudeLane(0.1, 84, { ...onlyOpus, accountKey: 'unready', lane: 'claude-unready',
      weekly: { used: 0.1, resetsAt: null }, observedAt: new Date(TICK + 31 * 60000).toISOString(),
      credentialAvailability: { version: 1, models: [] } })]);
  await d.tick();
  const after = await read();
  assert.equal(after.capacity.accounts.find(a => a.accountId === 'claude:unready').health, 'healthy');
  assert.deepEqual(after.capacity.reviewerAccountIdsByAgent['reviewer-1'], ['claude:a1'],
    'the configured policy model is not an admission without ready credentials');
  const ordinary = after.capacity.paceGuard.pools.find(p => p.pool === 'claude');
  assert.deepEqual({ lanes: ordinary.lanes, cap: ordinary.cap }, { lanes: 1, cap: 1 });
  assert.equal((await d.hook('ready-review-policy-peer')).kind, 'decide');
  assert.equal((await d.hook('unready-review-policy-peer')).kind, 'defer');
  await d.tick();
  assert.equal((await d.api('shadow')).body.entries.find(e => e.runId === 'ready-review-policy-peer')?.accountId, 'claude:a1');
  assert.deepEqual(after.summary, { lanes: 1, cap: 1, allocated: 1 },
    'raw pool membership must apply the same reviewer credential-readiness gate as admission');
});

const policyReviewerConfig = () => ({
  enforce: true, credentialReadiness: { enforce: true }, taskRanking: { mode: 'enforce' },
  concurrency: { maxTotal: 75, meanRunDurationHours: 4 },
  roles: { keepAgentIds: ['fixed', 'reviewer-1'] },
  reviewerRouting: { agentIds: ['reviewer-1'], arms: [
    { provider: 'claude', model: 'claude-opus-5-5', effort: 'max' },
  ] },
});
const policyReviewerSibling = (over = {}) => claudeLane(0.1, 84, {
  accountKey: 'policy-peer', lane: 'claude-policy-peer', models: ['claude-opus-5-5'],
  weekly: { used: 0.1, resetsAt: null }, ...over,
});

async function policyReviewerSnapshot(d) {
  const capacity = (await d.api('capacity')).body;
  d.updateCapacity(cap => {
    cap.target = 8; cap.calibration = 'measured';
    cap.keptByAgent.fixed = { accountId: 'claude:a1' };
  });
  const caps = (await d.api('caps')).body;
  const raw = capacity.paceGuard.rawPools.find(p => p.pool === 'claude');
  const review = capacity.reviewerPaceByAgent['reviewer-1'].pools.find(p => p.pool === 'claude');
  return { capacity, raw: { lanes: raw?.lanes, cap: raw?.cap,
    allocated: caps.agents.find(a => a.agentId === 'fixed')?.allocated },
  review: { lanes: review?.lanes, cap: review?.cap } };
}

async function measuredPolicyReviewer({ breakerArmIds = [], config = policyReviewerConfig(), snapshotRows = aaRows() } = {}) {
  const onlyOpus = { models: ['claude-opus-5-5'] };
  const d = drive({ config, snapshotRows, accounts: [claudeLane(0.55, 84.5, onlyOpus)],
    heartbeats: [{ agentId: 'fixed', queued: 8 }] });
  await d.setup();
  if (breakerArmIds.length > 0) {
    const cfg = sanitizeBreakers();
    const store = createBreakerStore();
    for (const armId of breakerArmIds) {
      for (const atMs of [TICK - 120000, TICK - 60000]) {
        recordArmFailure(store, 'claude:policy-peer', armId, { atMs, errorText: 'auth_unavailable' }, atMs, cfg);
      }
    }
    d.seed({ ...AA_STATE_KEY, stateKey: 'breaker-v1' }, breakerStoreToJSON(store, { nowMs: TICK, cfg }));
  }
  await d.tick();
  d.setNow(TICK + 0.5 * HOUR);
  const ready = claudeLane(0.58, 84.5, { ...onlyOpus, observedAt: new Date(TICK + 0.5 * HOUR).toISOString() });
  d.setAccounts([ready]);
  await d.tick();
  const before = await policyReviewerSnapshot(d);
  const account = before.capacity.accounts.find(a => a.accountId === 'claude:a1');
  assert.ok(Math.abs(account.planAhead - 0.08) < 1e-10);
  assert.ok(Math.abs(account.measuredRatePerHour - 0.06) < 1e-10);
  assert.ok(before.capacity.perAccount.find(a => a.accountId === 'claude:a1').slots > 1);
  assert.deepEqual(before.raw, { lanes: 1, cap: 1, allocated: 1 });
  assert.deepEqual(before.review, { lanes: 1, cap: 1 });
  return { d, ready };
}

async function addPolicyReviewerSibling({ d, ready }, sibling) {
  const observedAt = new Date(TICK + 31 * 60000).toISOString();
  d.setNow(TICK + 31 * 60000);
  d.setAccounts([{ ...ready, observedAt }, ...(sibling ? [{ ...sibling, observedAt }] : [])]);
  await d.tick();
  return policyReviewerSnapshot(d);
}

test('weekly soft cap: a ready breaker-open policy sibling cannot enter raw membership', async t => {
  const probe = drive({ config: policyReviewerConfig(), accounts: [
    claudeLane(0.55, 84.5, { models: ['claude-opus-5-5'] }), policyReviewerSibling(),
  ] });
  await probe.setup();
  await probe.tick();
  const ladder = (await probe.api('ladder')).body.ladders['claude:policy-peer'];
  const policyArms = ladder.policyReviewerArms ?? [];
  assert.ok(policyArms.length > 0, 'the real ladder publishes configured reviewer arms');
  const armIds = [...new Set([...(ladder.rungs ?? []), ...policyArms].map(a => a.armId))];
  assert.ok(armIds.length > 0);
  t.diagnostic(`seeded sibling breaker identities: ${armIds.join(', ')}`);
  const fixture = await measuredPolicyReviewer({ breakerArmIds: armIds });
  const after = await addPolicyReviewerSibling(fixture, policyReviewerSibling());
  assert.deepEqual(after.capacity.reviewerAccountIdsByAgent['reviewer-1'], ['claude:a1']);
  const blocked = (await fixture.d.api('ladder')).body.ladders['claude:policy-peer'];
  assert.ok(blocked.rungs.length > 0, 'the real ladder retains diagnostic rows for blocked arms');
  for (const row of blocked.rungs) {
    assert.equal(row.breaker, 'open', `breaker ${row.armId}`);
    assert.equal(row.credentialEvidence?.readyCredentials, 1, `ready ${row.armId}`);
  }
  assert.ok(blocked.policyReviewerArms.length > 0);
  for (const row of blocked.policyReviewerArms) assert.equal(row.credentialEvidence?.readyCredentials, 1, `policy ready ${row.armId}`);
  assert.deepEqual(after.raw, { lanes: 1, cap: 1, allocated: 1 },
    'ready credentials do not qualify a policy arm whose breaker is open');
});

test('weekly soft cap: a ready closed-breaker policy sibling remains a raw member', async () => {
  const fixture = await measuredPolicyReviewer();
  const after = await addPolicyReviewerSibling(fixture, policyReviewerSibling());
  assert.deepEqual(after.capacity.reviewerAccountIdsByAgent['reviewer-1'], ['claude:a1', 'claude:policy-peer']);
  assert.deepEqual(after.raw, { lanes: 2, cap: null, allocated: 8 },
    'a ready policy-only sibling with an unknown reset legitimately keeps the pool fail-open');
});

for (const unreadySibling of [false, true]) {
  test(`weekly soft cap: live reviewer membership retains the ready lane's cap (unreadySibling=${unreadySibling})`, async () => {
    const fixture = await measuredPolicyReviewer();
    const sibling = unreadySibling ? policyReviewerSibling({ credentialAvailability: { version: 1, models: [] } }) : null;
    const after = await addPolicyReviewerSibling(fixture, sibling);
    assert.deepEqual(after.raw, { lanes: 1, cap: 1, allocated: 1 });
    assert.deepEqual(after.capacity.reviewerAccountIdsByAgent['reviewer-1'], ['claude:a1']);
    const runIds = [`review-policy-${unreadySibling}-first`, `review-policy-${unreadySibling}-second`];
    const decisions = [];
    for (const runId of runIds) decisions.push(await fixture.d.hook(runId, { agentId: 'reviewer-1' }));
    assert.equal(decisions[0].kind, 'decide');
    await fixture.d.tick();
    const entries = (await fixture.d.api('shadow')).body.entries;
    for (const [i, decision] of decisions.entries()) {
      if (decision.kind === 'decide') assert.equal(entries.find(e => e.runId === runIds[i])?.accountId, 'claude:a1');
    }
    assert.deepEqual({ review: after.review, decisions: decisions.map(d => d.kind) },
      { review: { lanes: 1, cap: 1 }, decisions: ['decide', 'defer'] },
      'an unready policy sibling cannot reopen the live reviewer pool or admit a second run');
  });
}

const sonnetPolicyReviewerConfig = (excludeFamilies = {}, mode = 'enforce') => {
  const config = policyReviewerConfig();
  config.taskRanking.mode = mode;
  config.roles = { ...config.roles, doerAgentIds: ['fixed', 'reviewer-1'],
    thinkerAgentIds: ['reviewer-thinker'],
    keepAgentIds: ['fixed', 'reviewer-1', 'reviewer-thinker', 'reviewer-other'], excludeFamilies };
  config.reviewerRouting.agentIds = ['reviewer-1', 'reviewer-thinker', 'reviewer-other'];
  config.reviewerRouting.arms.push({ provider: 'claude', model: 'claude-sonnet-5-5', effort: 'max' });
  return config;
};
const sonnetPolicySibling = () => policyReviewerSibling({ models: ['claude-sonnet-5-5'] });

async function policyReviewerRunPair(d, prefix, agentId = 'reviewer-1') {
  const runIds = [`${prefix}-first`, `${prefix}-second`];
  const decisions = [];
  for (const runId of runIds) decisions.push(await d.hook(runId, { agentId }));
  await d.tick();
  const entries = (await d.api('shadow')).body.entries;
  const admitted = decisions.flatMap((decision, i) => decision.kind === 'decide' ? [{ decision, runId: runIds[i] }] : []);
  return { decisions: decisions.map(d => d.kind),
    models: admitted.map(({ decision }) => decision.model),
    accounts: admitted.map(({ runId }) => entries.find(e => e.runId === runId)?.accountId) };
}

test('policy exclusions: a sibling excluded by every role cannot erase the universal raw cap', async t => {
  const config = sonnetPolicyReviewerConfig({ doer: ['sonnet'], thinker: ['sonnet'], other: ['sonnet'] });
  const fixture = await measuredPolicyReviewer({ config });
  const after = await addPolicyReviewerSibling(fixture, sonnetPolicySibling());
  const ladder = (await fixture.d.api('ladder')).body.ladders['claude:policy-peer'];
  assert.ok(ladder.policyReviewerArms.some(a => a.model === 'claude-sonnet-5-5'
    && a.credentialEvidence?.readyCredentials === 1), 'the excluded model has ready policy evidence');
  assert.equal(after.capacity.accounts.find(a => a.accountId === 'claude:policy-peer').health, 'healthy');
  assert.deepEqual(after.capacity.reviewerAccountIdsByAgent['reviewer-1'], ['claude:a1']);
  assert.deepEqual(after.review, { lanes: 1, cap: 1 });
  const live = await policyReviewerRunPair(fixture.d, 'all-roles-excluded');
  assert.deepEqual(live, { decisions: ['decide', 'defer'], models: ['claude-opus-5-5'], accounts: ['claude:a1'] });
  t.diagnostic(JSON.stringify({ raw: after.raw, review: after.review, live }));
  assert.deepEqual(after.raw, { lanes: 1, cap: 1, allocated: 1 },
    'no spendable role survives: a policy record alone must not reopen fixed capacity');
});

for (const survivingRole of ['doer', 'thinker', 'other']) {
  test(`policy exclusions: universal membership survives when only ${survivingRole} can spend the sibling`, async () => {
    const exclusions = { doer: ['sonnet'], thinker: ['sonnet'], other: ['sonnet'], [survivingRole]: [] };
    const config = sonnetPolicyReviewerConfig(exclusions);
    // Prefer Sonnet in this positive control so the admitted run proves the sibling is spendable.
    config.reviewerRouting.arms.reverse();
    const fixture = await measuredPolicyReviewer({ config });
    const after = await addPolicyReviewerSibling(fixture, sonnetPolicySibling());
    assert.deepEqual(after.raw, { lanes: 2, cap: null, allocated: 8 },
      'one relevant role is enough; another role must not narrow universal capacity');
    const agentId = { doer: 'reviewer-1', thinker: 'reviewer-thinker', other: 'reviewer-other' }[survivingRole];
    assert.deepEqual(after.capacity.reviewerAccountIdsByAgent[agentId], ['claude:a1', 'claude:policy-peer']);
    const pool = after.capacity.reviewerPaceByAgent[agentId].pools.find(p => p.pool === 'claude');
    assert.deepEqual({ lanes: pool.lanes, cap: pool.cap }, { lanes: 2, cap: null });
    if (survivingRole !== 'doer') {
      assert.deepEqual(after.capacity.reviewerAccountIdsByAgent['reviewer-1'], ['claude:a1']);
      assert.deepEqual(after.review, { lanes: 1, cap: 1 }, 'reviewer-local membership still obeys its own role fence');
    }
    const live = await policyReviewerRunPair(fixture.d, `only-${survivingRole}-allowed`, agentId);
    assert.deepEqual(live, { decisions: ['decide', 'decide'], models: ['claude-sonnet-5-5', 'claude-sonnet-5-5'],
      accounts: ['claude:policy-peer', 'claude:policy-peer'] });
  });
}

test('policy exclusions: no sibling retains the reviewer cap independently of family overrides', async () => {
  const fixture = await measuredPolicyReviewer({ config: sonnetPolicyReviewerConfig({ doer: ['sonnet'] }) });
  const after = await addPolicyReviewerSibling(fixture, null);
  assert.deepEqual(after.raw, { lanes: 1, cap: 1, allocated: 1 });
  assert.deepEqual(after.review, { lanes: 1, cap: 1 });
  assert.deepEqual(await policyReviewerRunPair(fixture.d, 'excluded-no-sibling'),
    { decisions: ['decide', 'defer'], models: ['claude-opus-5-5'], accounts: ['claude:a1'] });
});

for (const token of ['sonnet', 'arm:claude-sonnet-5-5', 'arm:claude-sonnet-5-5@max']) {
  test(`policy exclusions: reviewer-local and live membership honor ${token}`, async t => {
    const fixture = await measuredPolicyReviewer({ config: sonnetPolicyReviewerConfig({ doer: [token] }) });
    const after = await addPolicyReviewerSibling(fixture, sonnetPolicySibling());
    assert.deepEqual(after.capacity.reviewerAccountIdsByAgent['reviewer-1'], ['claude:a1']);
    assert.deepEqual(after.raw, { lanes: 2, cap: null, allocated: 8 },
      'other roles may spend Sonnet; a local reviewer exclusion is not a global hold');
    const live = await policyReviewerRunPair(fixture.d, `local-${token}`);
    t.diagnostic(JSON.stringify({ raw: after.raw, review: after.review, live }));
    assert.deepEqual({ review: after.review, ...live }, { review: { lanes: 1, cap: 1 },
      decisions: ['decide', 'defer'], models: ['claude-opus-5-5'], accounts: ['claude:a1'] },
    'the reviewer cannot borrow another role\'s sibling membership or admit a second run on a1');
  });
}

for (const mode of ['shadow', 'enforce']) {
  test(`policy membership mode: ${mode} ${mode === 'enforce' ? 'admits' : 'ignores'} a policy-only sibling`, async t => {
    const config = sonnetPolicyReviewerConfig({}, mode);
    config.reviewerRouting.arms.reverse();
    const fixture = await measuredPolicyReviewer({ config,
      snapshotRows: aaRows().filter(row => !row.slug.startsWith('claude-sonnet')) });
    const after = await addPolicyReviewerSibling(fixture, sonnetPolicySibling());
    const ladder = (await fixture.d.api('ladder')).body.ladders['claude:policy-peer'];
    assert.equal(ladder.rungs.length, 0, 'no AA row supplies ordinary capacity for the Sonnet sibling');
    assert.ok(ladder.policyReviewerArms.some(a => a.model === 'claude-sonnet-5-5'
      && a.credentialEvidence?.readyCredentials === 1), 'the policy-only diagnostic record exists in both modes');
    const live = await policyReviewerRunPair(fixture.d, `policy-only-${mode}`);
    t.diagnostic(JSON.stringify({ raw: after.raw, review: after.review, live }));
    if (mode === 'shadow') {
      assert.deepEqual(after.capacity.reviewerAccountIdsByAgent['reviewer-1'], ['claude:a1']);
      assert.deepEqual({ raw: after.raw, review: after.review, ...live },
        { raw: { lanes: 1, cap: 1, allocated: 1 }, review: { lanes: 1, cap: 1 },
          decisions: ['decide', 'defer'], models: ['claude-opus-5-5'], accounts: ['claude:a1'] },
        'shadow policy diagnostics are not enforced capacity');
    } else {
      assert.deepEqual(after.capacity.reviewerAccountIdsByAgent['reviewer-1'], ['claude:a1', 'claude:policy-peer']);
      assert.deepEqual({ raw: after.raw, review: after.review, ...live },
        { raw: { lanes: 2, cap: null, allocated: 8 }, review: { lanes: 2, cap: null },
          decisions: ['decide', 'decide'], models: ['claude-sonnet-5-5', 'claude-sonnet-5-5'],
          accounts: ['claude:policy-peer', 'claude:policy-peer'] });
    }
  });
}

test('weekly hard hold: routing headroom cannot erase global holds or reopen fixed-model caps', async () => {
  const d = drive({
    config: { enforce: true, pacing: { guardHighPct: 0.99, guardRejoinPct: 0.98 },
      concurrency: { maxTotal: 75, meanRunDurationHours: 2 }, roles: { keepAgentIds: ['fixed'] } },
    accounts: [claudeLane(0.85, 120, {
      fiveHour: { used: 0.96, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
    }), geminiLane(0.1, 120)],
    heartbeats: [{ agentId: 'fixed', queued: 8 }],
  });
  await d.setup();
  await d.tick();
  const capacity = (await d.api('capacity')).body;
  const account = capacity.accounts.find(a => a.accountId === 'claude:a1');
  assert.equal(account.health, 'healthy');
  assert.equal(account.guardActive, false);
  assert.ok(Math.abs(account.headroomPct - 0.04) < 1e-10, `headroom ${account.headroomPct}`);
  assert.ok(capacity.perAccount.find(a => a.accountId === 'claude:a1').slots > 1, JSON.stringify(capacity.perAccount));
  const route = await d.hook('low-headroom');
  assert.equal(route.kind, 'decide');
  assert.match(route.model, /^gemini/, 'the routing headroom exclusion still applies');
  // Supply fleet calibration and an exact pin, never pool membership or lane slots.
  d.updateCapacity(cap => {
    cap.target = 8; cap.calibration = 'measured';
    cap.keptByAgent.fixed = { accountId: 'claude:a1' };
  });
  const caps = (await d.api('caps')).body;
  const raw = capacity.paceGuard.rawPools.find(p => p.pool === 'claude');
  assert.deepEqual({ hardHeld: raw?.hardHeldAccountIds ?? [], cap: raw?.cap ?? null,
    allocated: caps.agents.find(a => a.agentId === 'fixed')?.allocated },
  { hardHeld: ['claude:a1'], cap: 0, allocated: 0 });
});

test('weekly hard hold: invalid threshold is rejected before it can replace routing policy', async () => {
  const d = drive({ config: { enforce: true, pacing: { holdAheadPts: 'off' } }, accounts: AHEAD() });
  await assert.rejects(d.setup(), /invalid-config/);
});

test('weekly hard hold: deferral exhaustion cannot bypass a hold below a custom soft-cap margin', async () => {
  const d = drive({ config: { enforce: true, exhaustion: { enabled: true }, pacing: { guard: { marginPct: 1 } } },
    accounts: [claudeLane(0.83, 104.6), geminiLane(0.3, 48)] });
  await d.setup();
  await d.tick();
  await d.hook('trial-1');
  await d.hook('trial-2');
  for (let i = 0; i < 14; i++) {
    const out = await d.hook(`waiting-${i}`, { issueId: 'same-work', agentDefaultModel: 'claude-opus-5-5' });
    assert.equal(out.kind, 'defer', `attempt ${i}: ${JSON.stringify(out)}`);
  }
});
