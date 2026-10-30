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

function drive({ config = {}, accounts, agentGets = {} }) {
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
    agents: { get: async (id) => agentGets[id] ?? null },
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
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: aaRows(), duplicateSlugs: [] });
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

test('plugin loop: six contended hours hold the ahead pool at its cap and refill it as runs finish', async () => {
  // 0.9h runs make the share 1.67 slots: cap 2. Four runs are always queued;
  // the host claims each (agent.run.started), asks the hook, and re-asks a
  // deferred run every retryAfterMs (5 min). Agent config names the model, so
  // the tick attributes the waiting runs to the pool as it does in production.
  const RETRY_MIN = 5;
  const RUN_MIN = 54;
  const agentGets = { 'agent-9': { adapterConfig: { model: 'claude-opus-5-5' } } };
  const d = drive({ config: { enforce: true, concurrency: { maxTotal: 75, meanRunDurationHours: 0.9 } }, accounts: AHEAD(), agentGets });
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
  const d = drive({ config: { enforce: true }, accounts: AHEAD(), agentGets });
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
  const ready = claudeLane(0.6, 48);
  const unready = { ...claudeLane(0.99, 48), accountKey: 'a2', lane: 'claude-2', credentialAvailability: { version: 1, models: [] } };
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
  const d = drive({ config: { enforce: true }, accounts: AHEAD(), agentGets });
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
  const d = drive({ config: { enforce: true }, accounts: [claudeLane(0.9, 48), unknownReset] });
  await d.setup();
  await d.tick();
  const pool = (await d.api('capacity')).body.paceGuard.pools.find(p => p.pool === 'claude');
  assert.equal(pool.state, 'not-measured');
  for (const id of ['run-1', 'run-2', 'run-3']) assert.equal((await d.hook(id)).kind, 'decide', id);
});

test('a paced pool plus a trial-full unpaced pool defers on the guard retry', async () => {
  const d = drive({ config: { enforce: true }, accounts: [claudeLane(0.9, 48), geminiLane(0.3, 48)] });
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
  const probe = drive({ config: { enforce: true }, accounts: mk() });
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
  const d = drive({ config: { enforce: true }, accounts: mk() });
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
  assert.equal(pool.state, 'ahead', '30% used at hour 0 is ahead of plan');
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
