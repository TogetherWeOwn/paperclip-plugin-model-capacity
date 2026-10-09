import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfigShape, createModelCapacityPlugin } from '../src/plugin.mjs';

const TICK = Date.parse('2026-10-08T23:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };

// AA snapshot: classic claude rows plus the dynamic rows the feed models
// below normalize to (kimi-k3-256k via override, gemini-2-5-flash direct).
const aaRows = () => ([
  { slug: 'claude-opus-5-5', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
  { slug: 'claude-haiku-5-5-xhigh', intelligenceIndex: 53, intelligenceIndexCostPerTask: 8, price1mInputTokens: 1, price1mOutputTokens: 5 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
  { slug: 'kimi-k3', intelligenceIndex: 55, intelligenceIndexCostPerTask: 10, price1mInputTokens: 1, price1mOutputTokens: 4 },
  { slug: 'gemini-2-5-flash', intelligenceIndex: 54, intelligenceIndexCostPerTask: 5, price1mInputTokens: 1, price1mOutputTokens: 3 },
]);

const rawAcct = (o) => ({
  lane: o.lane, provider: o.provider, accountKey: o.key,
  health: o.health ?? 'healthy', meter: o.meter ?? null, pool: o.pool ?? null,
  models: o.models ?? null,
  weekly: { used: o.weekly ?? null, resetsAt: o.reset ?? null },
  fiveHour: { used: o.fiveHour ?? null, resetsAt: o.reset5 ?? null },
  observedAt: o.observedAt ?? '2026-10-08T22:59:00Z', quality: o.quality ?? 'live',
});

const kimiAcct = (over = {}) => rawAcct({
  lane: 'kimi-1', provider: 'kimi', key: 'k1', meter: 'reactive', quality: 'reactive',
  models: ['kimi-k3-256k'], ...over,
});

const claudeAcct = (over = {}) => rawAcct({
  lane: 'claude-1', provider: 'claude', key: 'a1',
  weekly: 0.3, reset: '2026-10-15T22:59:00Z', fiveHour: 0.1,
  models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], ...over,
});

const started = (runId, atMs, extra = {}, type = 'agent.run.started') => ({
  type, companyId: 'acme', entityId: runId,
  payload: { run: { agentId: 'agent-9', ...extra } },
  occurredAt: new Date(atMs).toISOString(),
});

function drive({ nowMs, config = {}, laneAccounts = null, steps = null, issueGets = {}, agentGets = {} }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = nowMs;
  let tickNo = 0;
  const resolveLane = () => {
    const accounts = typeof laneAccounts === 'function' ? laneAccounts(tickNo, now) : laneAccounts;
    return { observedAt: new Date(now).toISOString(), accounts: accounts ?? [] };
  };
  let lane = resolveLane();
  const fake = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET, ...(config.cliproxy ?? {}) } }) },
    state: {
      get: async k => store.get(skey(k)) ?? null,
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => lane }) },
    agents: {
      get: async (agentId, companyId) => {
        if (typeof agentId !== 'string' || typeof companyId !== 'string') {
          throw new Error('companyId is required for this operation');
        }
        return agentGets[agentId] ?? null;
      },
    },
    issues: {
      get: async (issueId, companyId) => {
        if (typeof issueId !== 'string' || typeof companyId !== 'string') {
          throw new Error('companyId is required for this operation');
        }
        return issueGets[issueId] ?? null;
      },
    },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return {
    run: async () => {
      await plugin.setup(fake);
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
      for (const s of steps ?? [{ now: nowMs }]) {
        now = s.now;
        lane = s.lane !== undefined ? s.lane : resolveLane();
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

test('trials config validates: minima and adapter shape', () => {
  assert.deepEqual(validateConfigShape({ trials: { maxInFlightPerAccount: 2, minSuccessRate: 0.8 } }), []);
  assert.ok(validateConfigShape({ trials: { maxInFlightPerAccount: 0 } }).length > 0);
  assert.ok(validateConfigShape({ trials: { minSuccessRate: 2 } }).length > 0);
  assert.ok(validateConfigShape({ trials: { adapters: ['claude-code'] } }).length > 0);
  assert.ok(validateConfigShape({ modelAaOverrides: ['x'] }).length > 0);
  assert.deepEqual(validateConfigShape({ modelAaOverrides: { 'my-model': 'my-slug' } }), []);
});

test('healthy reactive lane routes a capped trial decision', async () => {
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [kimiAcct()],
    steps: [{ now: TICK, fire: [started('run-k', TICK - 60000, { adapterType: 'claude-code' })] }],
  });
  const { shadow, capacity } = await run();
  assert.equal(shadow.body.entries.length, 1);
  const [entry] = shadow.body.entries;
  assert.deepEqual(
    [entry.accountId, entry.trial, entry.family, entry.wouldModel],
    ['kimi:k1', true, 'kimi', 'kimi-k3-256k(max)'],
  );
  assert.equal(capacity.body.reactiveAccounts, 1);
  assert.equal(capacity.body.trialFamilies.kimi.inFlight, 1);
  assert.equal(capacity.body.trialFamilies.kimi.proven, false);
});

test('exhausted reactive lane gets nothing: health gates eligibility', async () => {
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [kimiAcct({ health: 'exhausted' })],
    steps: [{ now: TICK, fire: [started('run-k', TICK - 60000, { adapterType: 'claude-code' })] }],
  });
  const { shadow, capacity } = await run();
  assert.equal(shadow.body.entries.length, 0);
  assert.equal(capacity.body.shadow.skippedNoDecision, 1);
});

test('run maps to its account from the resolved actual model', async () => {
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [claudeAcct(), kimiAcct()],
    issueGets: { 'iss-k': { assigneeAdapterOverrides: { adapterConfig: { model: 'kimi-k3-256k' } } } },
    steps: [{
      now: TICK,
      fire: [
        started('run-mapped', TICK - 60000, { issueId: 'iss-k' }),
        started('run-unmapped', TICK - 30000, {}),
      ],
    }],
  });
  const { shadow, capacity } = await run();
  // The mapped run resolved through its issue override; the bare run names
  // no model anywhere and stays honestly unmapped.
  assert.equal(capacity.body.unmappedRuns, 1);
  assert.equal(capacity.body.runsObserved, 2);
  assert.equal(shadow.body.entries.length, 2);
  const byId = new Map(shadow.body.entries.map(e => [e.runId, e]));
  assert.deepEqual(
    [byId.get('run-mapped').actualModel, byId.get('run-mapped').actualModelSource],
    ['kimi-k3-256k', 'issue-override'],
  );
});

test('pool headroom falls back to weekly when 5h is missing; legacy feeds stay null', async () => {
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [
      rawAcct({
        lane: 'ag-pool', provider: 'antigravity', key: 'pool1', pool: 'partner',
        models: ['gemini-2-5-flash'], weekly: 0.75, reset: '2026-10-15T22:59:00Z',
      }),
      rawAcct({
        lane: 'legacy', provider: 'codex', key: 'old', weekly: 0.5, reset: '2026-10-15T22:59:00Z',
      }),
    ],
  });
  const { capacity } = await run();
  const byId = new Map(capacity.body.accounts.map(a => [a.accountId, a]));
  assert.deepEqual(
    [byId.get('antigravity:pool1').headroomPct, byId.get('antigravity:pool1').headroomSource],
    [0.25, 'weekly-fallback'],
  );
  // No models list on a metered feed with no 5h: the CISO
  // unknown-headroom rule, still excluded, still null.
  assert.deepEqual(
    [byId.get('codex:old').headroomPct, byId.get('codex:old').headroomSource],
    [null, null],
  );
});

test('models with no AA match are listed unscored with their servers, never invented', async () => {
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [kimiAcct({ models: ['kimi-k3-256k', 'zzz-new-9'] })],
  });
  const { capacity } = await run();
  const hit = capacity.body.unscored.find(u => u.model === 'zzz-new-9');
  assert.deepEqual([hit.reason, hit.servedBy], ['no-aa-match', ['kimi:k1']]);
});

test('event-time shadow covers runs that start between ticks', async () => {
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [claudeAcct()],
    steps: [
      { now: TICK },
      { now: TICK + 60000, fire: [started('run-e', TICK + 30000, { model: 'claude-haiku-5-5', provider: 'claude' })] },
    ],
  });
  const { shadow } = await run();
  // The started event fired after tick 1 published its live view, so the
  // memory-only path recorded the decision before tick 2 merged it.
  assert.equal(shadow.body.entries.length, 1);
  assert.equal(shadow.body.entries[0].eventTime, true);
  assert.equal(shadow.body.entries[0].runId, 'run-e');
});

test('measured fleet success graduates a trial family', async () => {
  const at = TICK - 5 * 60000;
  const { run } = drive({
    nowMs: TICK,
    config: { trials: { minRuns: 2, minSuccessRate: 0.5 } },
    laneAccounts: [kimiAcct()],
    issueGets: { 'iss-k': { assigneeAdapterOverrides: { adapterConfig: { model: 'kimi-k3-256k' } } } },
    steps: [{
      now: TICK,
      fire: [
        started('run-g1', at, { issueId: 'iss-k', adapterType: 'claude-code' }),
        { ...started('run-g1', at + 60000, { issueId: 'iss-k' }), type: 'agent.run.finished' },
        started('run-g2', at, { issueId: 'iss-k', adapterType: 'claude-code' }),
        { ...started('run-g2', at + 60000, { issueId: 'iss-k' }), type: 'agent.run.finished' },
      ],
    }],
  });
  const { capacity } = await run();
  assert.deepEqual(
    [capacity.body.trialFamilies.kimi.finished, capacity.body.trialFamilies.kimi.proven],
    [2, true],
  );
  assert.equal(capacity.body.trialTransitions, 2);
});

test('water-filling spreads ten decisions across three equal metered accounts', async () => {
  // Herding regression test end to end: three metered lanes with identical
  // quota signals and identical (proven) arms. The old static argmax order
  // put all ten decisions on one lane; per-run re-sorting with tick-pending
  // in-flight must spread them 4/3/3.
  const mk = (provider, key) => rawAcct({
    lane: `${provider}-1`, provider, key,
    weekly: 0.3, reset: '2026-10-15T22:59:00Z', fiveHour: 0.1,
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  });
  const fires = [];
  for (let i = 0; i < 10; i++) fires.push(started(`run-wf-${i}`, TICK - 60000));
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [mk('p1', 'a1'), mk('p2', 'a2'), mk('p3', 'a3')],
    steps: [{ now: TICK, fire: fires }],
  });
  const { shadow, capacity } = await run();
  assert.equal(shadow.body.entries.length, 10);
  const counts = {};
  for (const e of shadow.body.entries) counts[e.accountId] = (counts[e.accountId] ?? 0) + 1;
  assert.deepEqual(Object.values(counts).sort(), [3, 3, 4]);
  for (const a of capacity.body.accounts) assert.ok(a.targetShare > 0, `${a.accountId} carries a target share`);
});

test('trial gemini arm decidable from the agent record when the event lacks adapterType', async () => {
  // The adapter gate fix: agent.run.started carries no adapterType, so the
  // tick resolves it from the agent record (10-min TTL cache) and the
  // gemini trial arm becomes decidable for a claude_local agent.
  const geminiReactive = () => rawAcct({
    lane: 'ag-1', provider: 'antigravity', key: 'g1', meter: 'reactive', quality: 'reactive',
    models: ['gemini-2-5-flash'],
  });
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [geminiReactive()],
    agentGets: { 'agent-9': { adapterType: 'claude_local' } },
    steps: [{ now: TICK, fire: [started('run-t', TICK - 60000)] }],
  });
  const { shadow } = await run();
  assert.equal(shadow.body.entries.length, 1);
  const [entry] = shadow.body.entries;
  assert.deepEqual([entry.trial, entry.family], [true, 'gemini']);
});

test('unresolvable agent adapter keeps trial arms gated (stable deferral)', async () => {
  // Lookup failure falls back to current behavior: no invented
  // eligibility, the trial-only ladder defers with the stable reason.
  const geminiReactive = () => rawAcct({
    lane: 'ag-1', provider: 'antigravity', key: 'g1', meter: 'reactive', quality: 'reactive',
    models: ['gemini-2-5-flash'],
  });
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [geminiReactive()],
    agentGets: {},
    steps: [{ now: TICK, fire: [started('run-u', TICK - 60000)] }],
  });
  const { shadow, capacity } = await run();
  assert.equal(shadow.body.entries.length, 0);
  assert.ok(capacity.body.shadow.skippedNoDecision >= 1);
});

test('finding 4: finished runs older than the rate window do not haunt pool in-flight', async () => {
  // The live ghost: inFlightByPool { kimi: 1 } with nothing running. The run
  // finished 69 min ago, so the 60-min window evicted it while its ring
  // entry (2h horizon) still counted. Terminal-id memory fixes it -- and
  // the defensive invariant (total pooled <= observed running, here 0) holds.
  const at = TICK - 70 * 60000;
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [kimiAcct()],
    steps: [
      { now: at, fire: [started('run-old', at, { adapterType: 'claude-code' })] },
      { now: at + 60000, fire: [{ ...started('run-old', at + 60000), type: 'agent.run.finished' }] },
      { now: TICK },
    ],
  });
  const { capacity } = await run();
  assert.deepEqual(capacity.body.inFlightByPool, {});
  assert.equal(capacity.body.staleInFlightDropped, 0);
  assert.equal(capacity.body.clampedInFlightDropped, 0);
});

test('finding 4b: ring entries older than the horizon with no terminal event are stale-dropped and counted', async () => {
  // Decided 150 min ago, never heard from again: older than max(3 x mean
  // run duration, 2h), so it stops counting and shows up in the counter.
  const at = TICK - 150 * 60000;
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [kimiAcct()],
    steps: [
      { now: at, fire: [started('run-stale', at, { adapterType: 'claude-code' })] },
      { now: TICK },
    ],
  });
  const { capacity } = await run();
  assert.deepEqual(capacity.body.inFlightByPool, {});
  assert.equal(capacity.body.staleInFlightDropped, 1);
});

test('finding 5: cancelled runs free their slot (agent.run.cancelled subscribed)', async () => {
  // Started 40 min ago, cancelled 39 min ago: pre-fix the event had no
  // subscriber (and no terminal status), so the run held its slot for an
  // hour. Post-fix it counts as terminal everywhere except the
  // finished/failed graduation counters.
  const at = TICK - 40 * 60000;
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [kimiAcct()],
    steps: [
      { now: at, fire: [started('run-c', at, { adapterType: 'claude-code' })] },
      { now: at + 60000, fire: [{ ...started('run-c', at + 60000), type: 'agent.run.cancelled' }] },
      { now: TICK },
    ],
  });
  const { capacity } = await run();
  assert.deepEqual(capacity.body.inFlightByPool, {});
  assert.equal(capacity.body.trialFamilies.kimi.finished, 0);
});

test('finding 6: terminal modelDecision attributes the run to the decided model', async () => {
  // The hook/tick decided kimi, but the agent record names no model, so the
  // old trail credited agent-config (null here). The finished event's
  // payload.modelDecision is authoritative: kimi earns the finished run
  // (graduation signal) and the ring actual is corrected with match true.
  const at = TICK - 60000;
  const fin = {
    ...started('run-m', at + 30000),
    type: 'agent.run.finished',
    payload: { run: { agentId: 'agent-9' }, modelDecision: { model: 'kimi-k3-256k' } },
  };
  const { run } = drive({
    nowMs: TICK,
    laneAccounts: [kimiAcct()],
    agentGets: { 'agent-9': { adapterType: 'claude-code' } },
    steps: [
      { now: at + 30000, fire: [started('run-m', at)] },
      { now: TICK, fire: [fin] },
    ],
  });
  const { shadow, capacity } = await run();
  assert.equal(capacity.body.trialFamilies.kimi.finished, 1);
  const entry = shadow.body.entries.find(e => e.runId === 'run-m');
  assert.equal(entry.actualModel, 'kimi-k3-256k');
  assert.equal(entry.actualModelSource, 'run-decision');
  assert.equal(entry.modelMatch, true);
});
