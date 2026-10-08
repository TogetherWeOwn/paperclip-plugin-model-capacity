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

const laneBody = (weeklyUsed, observedAt = '2026-10-08T22:59:00Z') => ({
  observedAt,
  accounts: [{
    lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy',
    weekly: { used: weeklyUsed, resetsAt: '2026-10-15T22:59:00Z' },
    fiveHour: { used: 0.1, resetsAt: '2026-10-09T03:59:00Z' },
    observedAt, quality: 'live',
  }],
});

const dbRow = (id, startedAtMs, model = 'claude-sonnet-5-5', provider = 'claude', issueId = null) => ({
  id, agent_id: 'agent-9', status: 'running',
  started_at: new Date(startedAtMs).toISOString(), finished_at: null, model, provider,
  issue_id: issueId,
});

function drive({ nowMs, laneUsed, laneObservedAt = null, laneAccounts = null, dbRows = [], dbError = null, withEvents = null, extraTicks = [], issues = {}, agents = {} }) {
  const lane = { used: laneUsed, observedAt: laneObservedAt };
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
    http: {
      fetch: async () => ({
        status: 200,
        json: async () => (laneAccounts
          ? { observedAt: '2026-10-08T22:59:00Z', accounts: laneAccounts }
          : laneBody(lane.used, lane.observedAt ?? undefined)),
      }),
    },
    db: { query: async () => { if (dbError) throw new Error(dbError); return dbRows; } },
    agents: { get: async (id) => agents[id] ?? null },
    issues: { get: async (id) => issues[id] ?? null },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now });
  const run = async () => {
    await plugin.setup(fake);
    store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: aaRows(), duplicateSlugs: [] });
    await plugin.onConfigChanged({}, { companyId: 'acme' });
    const plan = [{ now: nowMs }, ...extraTicks];
    for (const t of plan) {
      now = t.now;
      if (t.used !== undefined) lane.used = t.used;
      if (t.observedAt !== undefined) lane.observedAt = t.observedAt;
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

test('required rate is a number whenever remaining and reset are known', async () => {
  // Coordinator live example: claude-lane-1, remaining 0.34, weekly reset
  // 2026-10-09T19:00Z, tick at 2026-10-08T23:00Z => 0.34/20h = 0.017/h.
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [{
      lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy',
      weekly: { used: 0.66, resetsAt: '2026-10-09T19:00:00Z' },
      fiveHour: { used: 0.1, resetsAt: '2026-10-09T03:59:00Z' },
      observedAt: '2026-10-08T22:59:00Z', quality: 'live',
    }],
    dbRows: [dbRow('run-1', TICK - 5 * 60000)],
  });
  const { capacity } = await run();
  const claude = capacity.body.accounts.find(a => a.accountId === 'claude:a1');
  assert.ok(Math.abs(claude.remainingPct - 0.34) < 1e-9);
  assert.ok(Math.abs(claude.hoursToReset - 20) < 1e-9);
  assert.ok(Math.abs(claude.requiredRatePerHour - 0.017) < 1e-9);
});

test('required rate is null (not zero) when the reset is unknown', async () => {
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [{
      lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy',
      weekly: { used: 0.5, resetsAt: null },
      fiveHour: { used: 0.1, resetsAt: null },
      observedAt: '2026-10-08T22:59:00Z', quality: 'cached',
    }],
    dbRows: [],
  });
  const { capacity } = await run();
  const claude = capacity.body.accounts.find(a => a.accountId === 'claude:a1');
  assert.equal(claude.remainingPct, 0.5);
  assert.equal(claude.hoursToReset, null);
  assert.equal(claude.requiredRatePerHour, null);
});

test('shadow entry records actualModel and whether shadow agreed with reality', async () => {
  const { run } = drive({
    nowMs: TICK, laneUsed: 0.3,
    dbRows: [
      // Cheapest rung-0 arm is claude-haiku-5-5: shadow agrees here.
      dbRow('run-agree', TICK - 5 * 60000, 'claude-haiku-5-5', 'claude'),
      // A costlier actual model on the same account: shadow disagrees.
      dbRow('run-other', TICK - 4 * 60000, 'claude-opus-5-5', 'claude'),
    ],
  });
  const { shadow } = await run();
  const byId = new Map(shadow.body.entries.map(e => [e.runId, e]));
  assert.equal(byId.get('run-agree').actualModel, 'claude-haiku-5-5');
  assert.equal(byId.get('run-agree').modelMatch, true);
  assert.equal(byId.get('run-other').actualModel, 'claude-opus-5-5');
  assert.equal(byId.get('run-other').modelMatch, false);
});

test('event-seen run keeps its place but takes its model from the db row', async () => {
  const at = new Date(TICK - 2 * 60000).toISOString();
  const { run } = drive({
    nowMs: TICK, laneUsed: 0.3,
    dbRows: [dbRow('run-7', TICK - 2 * 60000, 'claude-haiku-5-5', 'claude')],
    withEvents: [{
      companyId: 'acme', entityId: 'run-7',
      payload: { run: { agentId: 'agent-9' } }, // no model on the event
      occurredAt: at,
    }],
  });
  const { shadow } = await run();
  assert.equal(shadow.body.entries.length, 1);
  assert.equal(shadow.body.entries[0].actualModel, 'claude-haiku-5-5');
  assert.equal(shadow.body.entries[0].modelMatch, true);
});

test('issue override beats agent config; heartbeat row beats both', async () => {
  const row = (id, extra) => ({ ...dbRow(id, TICK - 5 * 60000, '', 'claude'), ...extra });
  const { run } = drive({
    nowMs: TICK, laneUsed: 0.3,
    dbRows: [
      row('run-override', { issue_id: 'iss-1' }),
      row('run-agent', { issue_id: null }),
      { ...dbRow('run-hb', TICK - 5 * 60000, 'claude-haiku-5-5', 'claude'), issue_id: 'iss-1' },
    ],
    issues: { 'iss-1': { assigneeAdapterOverrides: { adapterConfig: { model: 'gpt-6-luna' } } } },
    agents: { 'agent-9': { adapterConfig: { model: 'claude-sonnet-5-5' } } },
  });
  const { shadow } = await run();
  const byId = new Map(shadow.body.entries.map(e => [e.runId, e]));
  assert.deepEqual(
    [byId.get('run-override').actualModel, byId.get('run-override').actualModelSource],
    ['gpt-6-luna', 'issue-override'],
  );
  assert.deepEqual(
    [byId.get('run-agent').actualModel, byId.get('run-agent').actualModelSource],
    ['claude-sonnet-5-5', 'agent-config'],
  );
  assert.deepEqual(
    [byId.get('run-hb').actualModel, byId.get('run-hb').actualModelSource],
    ['claude-haiku-5-5', 'heartbeat'],
  );
});

test('cached payloads do not fake history: duplicates skipped, fresh data accumulates', async () => {
  const iso = (ms) => new Date(ms).toISOString();
  const { run } = drive({
    nowMs: TICK, laneUsed: 0.3, laneObservedAt: iso(TICK - 60000),
    dbRows: [],
    extraTicks: [
      // Same observedAt, same value: exact duplicate, skipped.
      { now: TICK + 60000, observedAt: iso(TICK - 60000) },
      // Same observedAt is impossible with a new value here; new data:
      { now: TICK + 120000, used: 0.302, observedAt: iso(TICK + 60000) },
    ],
  });
  const { capacity } = await run();
  assert.equal(capacity.body.accounts[0].rateHistoryPoints, 2);
});

test('measured rate appears within ~10-15 min of install on live data', async () => {
  const ticks = [];
  for (let i = 1; i <= 12; i++) {
    ticks.push({ now: TICK + i * 60000, used: 0.3 + i * 0.002, observedAt: new Date(TICK + i * 60000).toISOString() });
  }
  const { run } = drive({
    nowMs: TICK, laneUsed: 0.3, laneObservedAt: new Date(TICK).toISOString(),
    dbRows: [],
    extraTicks: ticks,
  });
  const { capacity } = await run();
  const claude = capacity.body.accounts[0];
  assert.equal(claude.rateBasis, 'measured');
  assert.ok(claude.ratePoints >= 2);
  assert.ok(claude.measuredRatePerHour > 0);
});

test('two rising readings plus runs in span calibrate E and recommend a target', async () => {
  const { run } = drive({
    nowMs: TICK, laneUsed: 0.30, laneObservedAt: new Date(TICK).toISOString(),
    dbRows: [dbRow('run-a', TICK + 10 * 60000), dbRow('run-b', TICK + 20 * 60000)],
    extraTicks: [{ now: TICK + 30 * 60000, used: 0.328, observedAt: new Date(TICK + 30 * 60000).toISOString() }],
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
