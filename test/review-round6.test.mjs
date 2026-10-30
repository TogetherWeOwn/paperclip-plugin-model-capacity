import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

// Review round 6: tick-level pins for the reviewer/allocator parity and the
// doer-starvation wiring. The unit pins live in reviewer.test.mjs; these
// prove the plugin passes the right values into those pure functions:
// action/guardActive on the reviewer account map, the persisted
// doerStarvationSinceMs across ticks, the starvation term in
// supplySignal.wake, and the per-provider inFlight census.

const TICK = Date.parse('2026-10-08T23:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };

const iso = (ms) => new Date(ms).toISOString();

const aaRows = () => ([
  { slug: 'claude-opus-5-5', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
  { slug: 'claude-haiku-5-5-xhigh', intelligenceIndex: 53, intelligenceIndexCostPerTask: 8, price1mInputTokens: 1, price1mOutputTokens: 5 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
]);

const lane = (weeklyUsed, fiveHourUsed, nowMs, weeklyResetsAt = '2026-10-15T22:59:00Z') => ({
  lane: 'claude-a1', provider: 'claude', accountKey: 'a1', health: 'healthy',
  meter: null, pool: null, models: ['claude-haiku-5-5'],
  weekly: { used: weeklyUsed, resetsAt: weeklyResetsAt },
  fiveHour: { used: fiveHourUsed, resetsAt: '2026-10-09T03:59:00Z' },
  observedAt: iso(nowMs), quality: 'live',
});

const started = (runId, atMs, extra = {}) => ({
  type: 'agent.run.started', companyId: 'acme', entityId: runId,
  payload: { run: { agentId: 'agent-9', provider: 'claude', ...extra } },
  occurredAt: iso(atMs),
});

function drive({ nowMs, config = {}, laneAccounts = null, steps = null, todoIssues = [], inProgressIssues = [] }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = (k) => JSON.stringify(k);
  let now = nowMs;
  let tickNo = 0;
  const resolveLane = () => {
    const accounts = typeof laneAccounts === 'function' ? laneAccounts(tickNo, now) : laneAccounts;
    return { observedAt: iso(now), accounts: accounts ?? [lane(0.3, 0.1, now)] };
  };
  let lanePayload = resolveLane();
  const fake = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET, ...(config.cliproxy ?? {}) } }) },
    state: {
      get: async (k) => store.get(skey(k)) ?? null,
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness(lanePayload, now) }) },
    agents: { get: async () => null },
    issues: {
      get: async () => null,
      list: async ({ status } = {}) => (status === 'todo' ? todoIssues : status === 'in_progress' ? inProgressIssues : []),
    },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return {
    run: async () => {
      await plugin.setup(fake);
      store.set(skey(AA_STATE_KEY), { fetchedAt: iso(now), rows: aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
      const bodies = [];
      for (const s of steps ?? [{ now: nowMs }]) {
        now = s.now;
        if (s.lane !== undefined) lanePayload = s.lane;
        else lanePayload = resolveLane();
        tickNo += 1;
        for (const e of s.fire ?? []) await handlers.get(e.type)(e);
        await jobs.get('quota-refresh')({});
        bodies.push((await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body);
      }
      return bodies;
    },
  };
}

test('healthy claude lane resumes reviews (control)', async () => {
  const { run } = drive({ nowMs: TICK });
  const [body] = await run();
  assert.equal(body.reviewer.hold, false);
  assert.equal(body.reviewer.resume, true);
  assert.deepEqual(body.reviewer.qualifiedAccountIds, ['claude:a1']);
});

test('doer-starvation wake fires after the sustain window and keeps its start across ticks', async () => {
  // Calibrated target (rising readings + runs in span) with 12 queued doer
  // cards and 2 live doer runs: the C* gap persists, so the wake fires once
  // the 10-minute sustain elapses. The start persists across the intermediate
  // tick (passing sinceMs:null restarts the window forever); at the final
  // tick the provider entry is busy so the headroom path stays quiet and the
  // supply wake rides the starvation wake alone (dropping that term silences
  // it).
  const issues = Array.from({ length: 12 }, (_, i) => ({ id: `q-${i}`, status: 'todo', assigneeAgentId: 'agent-9' }));
  const resetSoon = iso(TICK + 3600000);
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: (t, now) => [lane(t < 3 ? 0.30 : 0.328, 0.1, now, resetSoon)],
    todoIssues: issues,
    steps: [
      { now: TICK },
      { now: TICK + 10 * 60000, fire: [started('run-a', TICK + 10 * 60000)] },
      { now: TICK + 20 * 60000, fire: [started('run-b', TICK + 20 * 60000)] },
      { now: TICK + 30 * 60000 },
      { now: TICK + 40 * 60000 },
    ],
  });
  const bodies = await run();
  const last = bodies[bodies.length - 1];
  assert.ok(last.target > 0, 'target calibrates from rising readings plus runs in span');
  const pre = bodies[3].supplySignal.doerStarvation;
  assert.equal(pre.starving, true);
  assert.equal(pre.wake, false, 'no wake before the sustain window elapses');
  assert.equal(pre.sinceMs, TICK + 30 * 60000);
  assert.equal(bodies[3].supplySignal.wake, false);
  const ds = last.supplySignal.doerStarvation;
  assert.equal(ds.unknown, false);
  assert.equal(ds.liveDoerRuns, 2);
  assert.equal(ds.doerDemand, 12);
  assert.ok(ds.gap >= ds.marginRuns);
  assert.equal(ds.sinceMs, pre.sinceMs, 'the start survives the intermediate tick');
  assert.equal(ds.wake, true);
  assert.equal(last.supplySignal.wake, true, 'supply wake carries the starvation wake');
});

test('per-provider liveRuns count attributed tick runs', async () => {
  // Two runs started with a served model attribute to claude:a1, so the
  // claude supply entry reports them and the idle flag tells the truth.
  // Zeroing the per-provider census flips liveRuns to 0/null and the entry
  // reads idle while busy.
  const resetSoon = iso(TICK + 60 * 3600000);
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: (t, now) => [lane(0.3, 0.1, now, resetSoon)],
    steps: [
      { now: TICK },
      { now: TICK + 60000, fire: [started('run-a', TICK + 60000, { model: 'claude-haiku-5-5' }), started('run-b', TICK + 60000, { model: 'claude-haiku-5-5' })] },
    ],
  });
  const bodies = await run();
  const [quiet, busy] = bodies.map((b) => b.supplySignal.providers.find((p) => p.provider === 'claude'));
  assert.equal(quiet.liveRuns, 0);
  assert.equal(quiet.idle, true);
  assert.equal(busy.liveRuns, 2);
  assert.equal(busy.idle, false);
  assert.equal(busy.qualifyingAccounts, 1);
});

test('lone guard-pinned claude account holds reviews at the tick', async () => {
  // 5h at 94% trips the pace guard (>= 0.8) while headroom 0.06 clears the
  // allocator reserve (0.05): only the guard/excluded parity line on the
  // reviewer account map holds the signal. Nulling action/guardActive in
  // that map resumes reviews here.
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: (t, now) => [lane(0.3, 0.94, now)],
  });
  const [body] = await run();
  assert.equal(body.reviewer.hold, true);
  assert.equal(body.reviewer.resume, false);
  assert.deepEqual(body.reviewer.qualifiedAccountIds, []);
});
