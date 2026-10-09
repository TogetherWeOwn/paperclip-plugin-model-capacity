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

test('config validation rejects bad secret refs, weights, baseUrl, and enforce', () => {
  assert.deepEqual(validateConfigShape({}), []);
  assert.ok(validateConfigShape({ cliproxy: { laneKeySecretRef: 'pasted-key' } }).length > 0);
  assert.deepEqual(validateConfigShape({
    cliproxy: { laneKeySecretRef: { type: 'secret_ref', secretId: 'cd121e86-3899-4720-9a04-a89b73e9e1' } },
  }), []);
  assert.ok(validateConfigShape({ pacing: { guardHighPct: 0.4, guardRejoinPct: 0.5 } }).length > 0);
  assert.ok(validateConfigShape({ weights: { terminalBench: -1 } }).length > 0);
  // Lane endpoint pinned: anything off the allowlist is rejected.
  assert.ok(validateConfigShape({ cliproxy: { baseUrl: 'https://telemetry.example.com' } }).length > 0);
  assert.deepEqual(validateConfigShape({ cliproxy: { baseUrl: 'https://router.infextion.net' } }), []);
  assert.ok(validateConfigShape({ enforce: 'yes' }).length > 0);
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

const acct = (lane, provider, key, weeklyUsed, resetsAt, fiveHourUsed = 0.1, observedAt = '2026-10-08T22:59:00Z') => ({
  lane, provider, accountKey: key, health: 'healthy',
  weekly: { used: weeklyUsed, resetsAt },
  fiveHour: { used: fiveHourUsed, resetsAt: '2026-10-09T03:59:00Z' },
  observedAt, quality: 'live',
});

const oneClaude = (weeklyUsed, observedAt) => ({
  observedAt, accounts: [acct('claude-1', 'claude', 'a1', weeklyUsed, '2026-10-15T22:59:00Z', 0.1, observedAt)],
});

const started = (runId, atMs, extra = {}, type = 'agent.run.started') => ({
  type, companyId: 'acme', entityId: runId,
  payload: { run: { agentId: 'agent-9', ...extra } },
  occurredAt: new Date(atMs).toISOString(),
});

function drive({ nowMs, config = {}, laneAccounts = null, steps = null, issueGets = {}, agentGets = {}, failIssueGet = null, failAgentGet = null }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = nowMs;
  let tickNo = 0;
  const resolveLane = () => {
    const accounts = typeof laneAccounts === 'function' ? laneAccounts(tickNo, now) : laneAccounts;
    return { observedAt: new Date(now).toISOString(), accounts: accounts ?? oneClaude(0.3, new Date(now).toISOString()).accounts };
  };
  let lane = resolveLane();
  const strictGet = (kind, table, fail) => async (id, companyId) => {
    if (typeof id !== 'string' || typeof companyId !== 'string') {
      throw new Error('companyId is required for this operation');
    }
    if (fail) throw new Error(fail);
    return table[id] ?? null;
  };
  const fake = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET, ...(config.cliproxy ?? {}) } }) },
    state: {
      get: async k => store.get(skey(k)) ?? null,
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => lane }) },
    agents: { get: strictGet('agents', agentGets, failAgentGet) },
    issues: { get: strictGet('issues', issueGets, failIssueGet) },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now });
  return {
    run: async () => {
      await plugin.setup(fake);
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
      for (const s of steps ?? [{ now: nowMs }]) {
        now = s.now;
        if (s.lane !== undefined) lane = s.lane;
        else lane = resolveLane();
        tickNo += 1;
        for (const e of s.fire ?? []) await handlers.get(e.type)(e);
        await jobs.get('shadow-tick')({});
      }
      return {
        shadow: await plugin.onApiRequest({ companyId: 'acme', routeKey: 'shadow' }),
        capacity: await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' }),
      };
    },
  };
}

test('tick records started events; the event model wins outright', async () => {
  const { run } = drive({
    nowMs: TICK,
    steps: [{ now: TICK, fire: [started('run-1', TICK - 5 * 60000, { model: 'claude-sonnet-5-5', provider: 'claude' })] }],
  });
  const { shadow, capacity } = await run();
  assert.equal(shadow.status, 200);
  assert.equal(shadow.body.entries.length, 1);
  const [entry] = shadow.body.entries;
  assert.deepEqual(
    [entry.runId, entry.agentId, entry.actualModel, entry.actualModelSource, entry.actualModelError],
    ['run-1', 'agent-9', 'claude-sonnet-5-5', 'run-event', null],
  );
  assert.equal(capacity.body.runsSource, 'events');
  assert.equal(capacity.body.runsObserved, 1);
  // One reading cannot measure a rate: weak, no target, no caps.
  assert.equal(capacity.body.calibration, 'weak');
  assert.equal(capacity.body.target, null);
});

test('company-less events are ignored, never fanned out', async () => {
  const { run } = drive({
    nowMs: TICK,
    steps: [{
      now: TICK,
      fire: [{ ...started('run-x', TICK - 60000, { model: 'm', provider: 'claude' }), companyId: undefined }],
    }],
  });
  const { shadow, capacity } = await run();
  assert.equal(shadow.body.entries.length, 0);
  assert.equal(capacity.body.runsObserved, 0);
  assert.equal(capacity.body.runEventsSeen, 0);
});

test('started + finished for one run dedupe to a single run with terminal status', async () => {
  const at = TICK - 5 * 60000;
  const { run } = drive({
    nowMs: TICK,
    steps: [{
      now: TICK,
      fire: [
        started('run-1', at, { provider: 'claude' }),
        { ...started('run-1', at + 60000, { provider: 'claude' }), type: 'agent.run.finished' },
      ],
    }],
  });
  const { capacity } = await run();
  assert.equal(capacity.body.runsObserved, 1);
});

test('required rate is a number whenever remaining and reset are known', async () => {
  // Coordinator live example: remaining 0.34, reset 2026-10-09T19:00Z,
  // tick at 2026-10-08T23:00Z => 0.34/20h = 0.017/h.
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [acct('claude-1', 'claude', 'a1', 0.66, '2026-10-09T19:00:00Z')],
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
    laneAccounts: [acct('claude-1', 'claude', 'a1', 0.5, null)],
  });
  const { capacity } = await run();
  const claude = capacity.body.accounts.find(a => a.accountId === 'claude:a1');
  assert.equal(claude.remainingPct, 0.5);
  assert.equal(claude.hoursToReset, null);
  assert.equal(claude.requiredRatePerHour, null);
});

test('three accounts with different deltas get different measured rates', async () => {
  // Item 1 regression: each account's rate comes from its OWN weekly.used
  // series -- never a shared history.
  const uses = [[0.30, 0.34], [0.50, 0.52], [0.10, 0.10]];
  const { run } = drive({
    nowMs: TICK,
    // Each tick is stamped with its own observedAt: same stamp + same
    // value is an exact duplicate and is skipped, so distinct stamps are
    // what let each account build its own two-point series.
    laneAccounts: (t, now) => uses.map(([u0, u1], i) => (
      acct(`lane-${i + 1}`, i < 2 ? 'claude' : 'codex', `k${i + 1}`, t === 0 ? u0 : u1, '2026-10-15T22:59:00Z', 0.1, new Date(now).toISOString())
    )),
    steps: [{ now: TICK }, { now: TICK + 30 * 60000 }],
  });
  const { capacity } = await run();
  const rates = new Map(capacity.body.accounts.map(a => [a.accountId, a.measuredRatePerHour]));
  // 30-minute span: (u1-u0)/0.5h.
  assert.ok(Math.abs(rates.get('claude:k1') - 0.08) < 1e-9);
  assert.ok(Math.abs(rates.get('claude:k2') - 0.04) < 1e-9);
  assert.ok(Math.abs(rates.get('codex:k3') - 0) < 1e-9);
});

test('entries sharing one account id keep separate series via lane suffix', async () => {
  // Degenerate payload: same provider + accountKey, different lanes.
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: (t, now) => [
      acct('x1', 'claude', 'shared', t === 0 ? 0.30 : 0.34, '2026-10-15T22:59:00Z', 0.1, new Date(now).toISOString()),
      acct('x2', 'claude', 'shared', t === 0 ? 0.50 : 0.52, '2026-10-15T22:59:00Z', 0.1, new Date(now).toISOString()),
    ],
    steps: [{ now: TICK }, { now: TICK + 30 * 60000 }],
  });
  const { capacity } = await run();
  const rates = new Map(capacity.body.accounts.map(a => [a.accountId, a.measuredRatePerHour]));
  assert.ok(Math.abs(rates.get('claude:shared') - 0.08) < 1e-9);
  assert.ok(Math.abs(rates.get('claude:shared#x2') - 0.04) < 1e-9);
});

test('deficit order: the over-burning account gets no new marginal runs', async () => {
  // lane-1 rises 0.30 -> 0.34 in 30 min (8%/h vs ~0.4%/h required:
  // deep into over-burn); lane-2 sits flat (measured 0, deficit ~1).
  const lanes = (t, now) => [
    acct('claude-lane-1', 'claude', 'a1', t === 0 ? 0.30 : 0.34, '2026-10-15T22:59:00Z', 0.1, new Date(now).toISOString()),
    acct('claude-lane-2', 'claude', 'a2', 0.50, '2026-10-15T22:59:00Z', 0.1, new Date(now).toISOString()),
  ];
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: lanes,
    steps: [
      { now: TICK },
      { now: TICK + 30 * 60000, fire: [started('run-1', TICK + 25 * 60000, { provider: 'claude' })] },
    ],
  });
  const { shadow, capacity } = await run();
  const lane1 = capacity.body.accounts.find(a => a.accountId === 'claude:a1');
  assert.ok(lane1.measuredRatePerHour > lane1.requiredRatePerHour * 1.15);
  assert.equal(shadow.body.entries.length, 1);
  assert.equal(shadow.body.entries[0].account, 'claude:a2');
});

test('issue override beats agent config; the event model beats both', async () => {
  const at = TICK - 5 * 60000;
  const { run } = drive({
    nowMs: TICK,
    steps: [{
      now: TICK,
      fire: [
        started('run-override', at, { issueId: 'iss-1' }),
        started('run-agent', at, {}),
        started('run-ev', at, { model: 'claude-haiku-5-5', issueId: 'iss-1' }),
      ],
    }],
    issueGets: { 'iss-1': { assigneeAdapterOverrides: { adapterConfig: { model: 'gpt-6-luna' } } } },
    agentGets: { 'agent-9': { adapterConfig: { model: 'claude-sonnet-5-5' } } },
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
    [byId.get('run-ev').actualModel, byId.get('run-ev').actualModelSource],
    ['claude-haiku-5-5', 'run-event'],
  );
});

test('actualModel failures log codes, never upstream text', async () => {
  const { run } = drive({
    nowMs: TICK,
    steps: [{ now: TICK, fire: [started('run-1', TICK - 5 * 60000, { issueId: 'iss-9' })] }],
    failIssueGet: 'db-query-denied: connection refused (raw upstream text)',
  });
  const { shadow } = await run();
  const [entry] = shadow.body.entries;
  assert.equal(entry.actualModel, 'unknown');
  assert.ok(entry.actualModelError.includes('issue-read-unavailable'));
  assert.ok(!entry.actualModelError.includes('db-query-denied'));
});

test('runs with no trail log exactly why the model stayed unknown', async () => {
  const { run } = drive({
    nowMs: TICK,
    steps: [{ now: TICK, fire: [started('run-1', TICK - 5 * 60000, {})] }],
  });
  const { shadow } = await run();
  assert.equal(shadow.body.entries[0].actualModelError, 'no-issue-id; agent-not-found');
});

test('exact duplicates are skipped, fresh data accumulates', async () => {
  const iso = (ms) => new Date(ms).toISOString();
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [acct('claude-1', 'claude', 'a1', 0.3, '2026-10-15T22:59:00Z', 0.1, iso(TICK - 60000))],
    steps: [
      { now: TICK },
      // Same stamp + same value is an exact duplicate: skipped, not stored.
      { now: TICK + 60000, lane: { observedAt: iso(TICK - 60000), accounts: [acct('claude-1', 'claude', 'a1', 0.3, '2026-10-15T22:59:00Z', 0.1, iso(TICK - 60000))] } },
      { now: TICK + 120000, lane: { observedAt: iso(TICK + 60000), accounts: [acct('claude-1', 'claude', 'a1', 0.302, '2026-10-15T22:59:00Z', 0.1, iso(TICK + 60000))] } },
    ],
  });
  const { capacity } = await run();
  assert.equal(capacity.body.accounts[0].rateHistoryPoints, 2);
});

test('measured rate appears within ~10-15 min of install on live data', async () => {
  const steps = [{ now: TICK }];
  for (let i = 1; i <= 12; i++) {
    steps.push({ now: TICK + i * 60000 });
  }
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: (t, now) => [acct('claude-1', 'claude', 'a1', 0.3 + t * 0.002, '2026-10-15T22:59:00Z', 0.1, new Date(now).toISOString())],
    steps,
  });
  const { capacity } = await run();
  const claude = capacity.body.accounts[0];
  assert.equal(claude.rateBasis, 'measured');
  assert.ok(claude.ratePoints >= 2);
  assert.ok(claude.measuredRatePerHour > 0);
});

test('two rising readings plus runs in span calibrate E and recommend a target', async () => {
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: (t, now) => [acct('claude-1', 'claude', 'a1', t < 3 ? 0.30 : 0.328, '2026-10-15T22:59:00Z', 0.1, new Date(now).toISOString())],
    steps: [
      { now: TICK },
      { now: TICK + 10 * 60000, fire: [started('run-a', TICK + 10 * 60000, { provider: 'claude' })] },
      { now: TICK + 20 * 60000, fire: [started('run-b', TICK + 20 * 60000, { provider: 'claude' })] },
      { now: TICK + 30 * 60000 },
    ],
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
  assert.equal(c.enforce, false);
  assert.equal(c.concurrency.maxTotal, 75);
  assert.equal(c.contextCaps.solLunaMaxTokens, 260000);
  assert.equal(c.armMap.length > 0, true);
});

test('non-allowlisted baseUrl falls back to the default instead of carrying the key', () => {
  const c = resolveConfig({ cliproxy: { baseUrl: 'https://telemetry.example.com' } });
  assert.equal(c.cliproxy.baseUrl, 'https://router.infextion.net');
});

test('prune drops only matching entries and reports the count', () => {
  const ring = createShadowRing();
  for (const id of ['keep-1', 'drop-1', 'keep-2', 'drop-2']) ring.push(record(id));
  assert.equal(ring.prune(e => e.runId.startsWith('drop-')), 2);
  assert.deepEqual(ring.list(10).map(r => r.runId), ['keep-2', 'keep-1']);
  assert.equal(ring.prune(() => true), 2);
  assert.equal(ring.size(), 0);
});
