import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowRing, SHADOW_CAPACITY, validRecord } from '../src/shadow.mjs';
import { validateConfigShape, resolveConfig, createModelCapacityPlugin } from '../src/plugin.mjs';

const record = (runId) => ({
  runId, agentId: 'agent-1', actualModel: 'claude-haiku-5-5(max)', wouldModel: 'gpt-6.1-sol(high)',
  account: 'codex:1', accountId: 'codex:1', rung: 1, reason: 'behind schedule: climb one rung', at: 1700000000000,
});

test('ring buffer caps at ~2000, newest wins', () => {
  assert.equal(SHADOW_CAPACITY, 2000);
  const ring = createShadowRing(3);
  for (const id of ['a', 'b', 'c', 'd']) ring.push(record(id));
  assert.equal(ring.size(), 3);
  assert.deepEqual(ring.list(10).map(r => r.runId), ['d', 'c', 'b']);
});

test('invalid records are refused, never stored', () => {
  const ring = createShadowRing();
  assert.equal(validRecord({ runId: 'x' }), false);
  assert.throws(() => ring.push({ runId: 'x' }), /invalid-shadow-record/);
  assert.equal(ring.size(), 0);
});

test('config validation rejects bad secret refs and weights', () => {
  assert.deepEqual(validateConfigShape({}), []);
  assert.ok(validateConfigShape({ cliproxy: { laneKeySecretRef: 'pasted-key' } }).length > 0);
  assert.deepEqual(validateConfigShape({
    cliproxy: { laneKeySecretRef: { type: 'secret_ref', secretId: 'cd121e86-3899-4720-9a04-a89b73e9e1' } },
  }), []);
  assert.ok(validateConfigShape({ pacing: { guardHighPct: 0.4, guardRejoinPct: 0.5 } }).length > 0);
  assert.ok(validateConfigShape({ weights: { terminalBench: -1 } }).length > 0);
});

const TICK = Date.parse('2026-10-08T23:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };

// Scorable claude rows: distinct quality + real cost fields so arms survive
// the ladder and carry per-run burn (null cost would defer every decision).
const aaRows = () => ([
  { slug: 'claude-opus-5-5', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
  { slug: 'claude-haiku-5-5-xhigh', intelligenceIndex: 53, intelligenceIndexCostPerTask: 8, price1mInputTokens: 1, price1mOutputTokens: 5 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
]);

const laneBody = (weeklyUsed) => ({
  observedAt: '2026-10-08T22:59:00Z',
  accounts: [{
    lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy',
    weekly: { used: weeklyUsed, resetsAt: '2026-10-15T22:59:00Z' },
    fiveHour: { used: 0.1, resetsAt: '2026-10-09T03:59:00Z' },
    observedAt: '2026-10-08T22:59:00Z', quality: 'live',
  }],
});

const dbRow = (id, startedAtMs, model = 'claude-sonnet-5-5', provider = 'claude') => ({
  id, agent_id: 'agent-9', status: 'running',
  started_at: new Date(startedAtMs).toISOString(), finished_at: null, model, provider,
});

function drive({ nowMs, laneUsed, dbRows = [], dbError = null, withEvents = null, secondNowMs = null, secondLaneUsed = null }) {
  const lane = { used: laneUsed };
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = nowMs;
  const fake = {
    config: { get: async () => ({ cliproxy: { laneKeySecretRef: SECRET } }) },
    state: {
      get: async k => store.get(skey(k)) ?? null,
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => laneBody(lane.used) }) },
    db: { query: async () => { if (dbError) throw new Error(dbError); return dbRows; } },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now });
  const run = async () => {
    await plugin.setup(fake);
    store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: aaRows(), duplicateSlugs: [] });
    await plugin.onConfigChanged({}, { companyId: 'acme' });
    if (withEvents) for (const e of withEvents) await handlers.get('agent.run.started')(e);
    await jobs.get('shadow-tick')({});
    if (secondNowMs != null) {
      now = secondNowMs;
      if (secondLaneUsed != null) lane.used = secondLaneUsed;
      if (withEvents) for (const e of withEvents) await handlers.get('agent.run.started')(e);
      await jobs.get('shadow-tick')({});
    }
    return {
      shadow: await plugin.onApiRequest({ companyId: 'acme', routeKey: 'shadow' }),
      capacity: await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' }),
    };
  };
  return { run };
}

test('tick backfills the ring from heartbeat runs with no events at all', async () => {
  const { run } = drive({
    nowMs: TICK, laneUsed: 0.3,
    dbRows: [dbRow('run-1', TICK - 5 * 60000)],
  });
  const { shadow, capacity } = await run();
  assert.equal(shadow.status, 200);
  assert.equal(shadow.body.entries.length, 1);
  const [entry] = shadow.body.entries;
  assert.deepEqual(
    [entry.runId, entry.agentId, entry.actualModel, entry.account],
    ['run-1', 'agent-9', 'claude-sonnet-5-5', 'claude:a1'],
  );
  assert.match(entry.wouldModel, /^claude-.+\(.+\)$/);
  assert.equal(capacity.body.runsSource, 'db-only');
  assert.equal(capacity.body.runsObserved, 1);
  // One reading cannot measure a rate: weak, no target, no caps.
  assert.equal(capacity.body.calibration, 'weak');
  assert.equal(capacity.body.target, null);
});

test('denied db degrades to events-only; odd event shapes are still kept', async () => {
  const { run } = drive({
    nowMs: TICK, laneUsed: 0.3, dbError: 'db-query-denied',
    withEvents: [{
      companyId: 'acme', entityId: 'run-9',
      payload: { run: { agentId: 'agent-9', model: 'claude-sonnet-5-5' } },
      occurredAt: new Date(TICK - 2 * 60000).toISOString(),
    }],
  });
  const { shadow, capacity } = await run();
  assert.equal(shadow.body.entries.length, 1);
  assert.equal(shadow.body.entries[0].runId, 'run-9');
  assert.equal(capacity.body.runsSource, 'events-only');
  assert.equal(capacity.body.runsDbError, 'db-query-denied');
  assert.equal(capacity.body.runEventsSeen, 1);
});

test('two rising readings plus runs in span calibrate E and recommend a target', async () => {
  const { run } = drive({
    nowMs: TICK, laneUsed: 0.30,
    dbRows: [dbRow('run-a', TICK + 10 * 60000), dbRow('run-b', TICK + 20 * 60000)],
    secondNowMs: TICK + 30 * 60000, secondLaneUsed: 0.328,
  });
  const { capacity } = await run();
  // Delta 0.028 over 2 runs in span => E = 0.014.
  const claude = capacity.body.perAccount.find(a => a.accountId === 'claude:a1');
  assert.ok(Math.abs(claude.measuredBurnPerRunPct - 0.014) < 1e-9);
  assert.ok(['measured', 'partial'].includes(capacity.body.calibration));
  assert.ok(capacity.body.target > 0);
});

test('config resolution applies documented defaults', () => {
  const c = resolveConfig({});
  assert.equal(c.cliproxy.baseUrl, 'https://router.infextion.net');
  assert.equal(c.cliproxy.accountsPath, '/telemetry/cliproxy/live/accounts.json');
  assert.equal(c.cliproxy.laneKeySecretRef, null);
  assert.equal(c.concurrency.maxTotal, 75);
  assert.equal(c.contextCaps.solLunaMaxTokens, 260000);
  assert.equal(c.armMap.length > 0, true);
});
