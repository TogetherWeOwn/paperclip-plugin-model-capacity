import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import {
  DEFAULT_BREAKERS, sanitizeBreakers, createBreakerStore, breakerStoreToJSON,
  breakerState, recordArmFailure,
} from '../src/breakers.mjs';

// Review fold-in (PR #11): one regression test per finding.
//
// Finding 1: the breaker first-load used to mark ready BEFORE the state read,
// so a failed read left ready set with no store and the next tick persisted an
// empty store over saved open/half-open breakers.
// Finding 2: recordArmFailure filtered stale failures BEFORE appending the new
// one, so recent-then-ancient arrivals counted the stale failure and tripped
// while ancient-then-recent did not.
// Finding 3: the hook discarded startProbe's return, so N enforced runs piled
// onto one half-open probe slot; slipped-run failures then no-op'd in
// recordArmFailure (open arms only refresh lastError).

const T = Date.parse('2026-10-08T23:00:00Z');
const MIN = 60 * 1000;
const HOUR = 3600 * 1000;
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const NS = 'model-capacity';
const BREAKER_SKEY = { scopeKind: 'company', scopeId: 'acme', namespace: NS, stateKey: 'breaker-v1' };
const AA_SKEY = { scopeKind: 'company', scopeId: 'acme', namespace: NS, stateKey: 'aa-snapshot-v1' };
const cfg = sanitizeBreakers();

const aaRows = () => ([
  { slug: 'claude-opus-5-5', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
  { slug: 'claude-haiku-5-5-xhigh', intelligenceIndex: 53, intelligenceIndexCostPerTask: 8, price1mInputTokens: 1, price1mOutputTokens: 5 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
]);

const laneBody = () => ({
  observedAt: new Date(T).toISOString(),
  accounts: [{
    lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy',
    weekly: { used: 0.3, resetsAt: '2026-10-15T22:59:00Z' },
    fiveHour: { used: 0.1, resetsAt: '2026-10-09T03:59:00Z' },
    observedAt: new Date(T).toISOString(), quality: 'live',
  }],
});

// accountId 'claude:a1' rungs, cheapest first (matches the tick-published ladder).
const ARMS = ['claude-haiku-5-5', 'claude-haiku-5-5-xhigh', 'claude-sonnet-5-5-high', 'claude-opus-5-5'];

function rig({ failBreakerReads = false } = {}) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let failBreaker = failBreakerReads;
  let plugin = null;
  const io = {
    config: { get: async () => ({ enforce: true, cliproxy: { laneKeySecretRef: SECRET } }) },
    state: {
      get: async k => {
        if (failBreaker && skey(k).includes('"breaker-v1"')) throw new Error('boom: breaker read');
        return store.get(skey(k)) ?? null;
      },
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => laneBody() }) },
    agents: { get: async () => ({ adapterType: 'claude-code' }) },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  return {
    setFailBreaker: v => { failBreaker = v; },
    seed: (k, v) => { store.set(skey(k), v); },
    read: k => store.get(skey(k)) ?? null,
    boot: async () => {
      plugin = createModelCapacityPlugin({ clock: () => T });
      await plugin.setup(io);
      store.set(skey(AA_SKEY), { fetchedAt: new Date(T).toISOString(), rows: aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged({ enforce: true }, { companyId: 'acme' });
    },
    tick: () => jobs.get('shadow-tick')({}),
    hook: (runId) => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId: 'agent-9', issueId: null,
      adapterType: 'claude-code', invocationSource: 'test', wakeReason: null,
      agentDefaultModel: null, previous: null, issueOverrideModel: null,
      deadlineMs: 1500,
    }),
    capacity: () => plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' }),
  };
}

test('finding 1: breaker load failure aborts the tick without wiping; retry loads', async () => {
  const r = rig({ failBreakerReads: true });
  await r.boot();
  // Saved state: an open breaker for the cheapest arm.
  const seed = createBreakerStore();
  recordArmFailure(seed, 'claude:a1', ARMS[0], { atMs: T - 2 * MIN, errorText: 'auth_unavailable' }, T - 2 * MIN, cfg);
  recordArmFailure(seed, 'claude:a1', ARMS[0], { atMs: T - MIN, errorText: 'auth_unavailable' }, T - MIN, cfg);
  assert.equal(breakerState(seed, 'claude:a1', ARMS[0], T, cfg), 'open');
  const seedJSON = breakerStoreToJSON(seed, { nowMs: T, cfg });
  r.seed(BREAKER_SKEY, seedJSON);

  // The job wrapper reports per-company failures as shadow-tick-failed.
  await assert.rejects(r.tick(), /shadow-tick-failed/);
  // Nothing persisted over the saved breakers: the seed is untouched.
  assert.deepEqual(r.read(BREAKER_SKEY), seedJSON);

  // Retry with a healthy read: the tick succeeds and the open arm is back.
  r.setFailBreaker(false);
  await r.tick();
  const cap = await r.capacity();
  const entry = cap.body.armBreakers.find(e => e.armId === ARMS[0]);
  assert.ok(entry, 'open arm survives the failed tick');
  assert.equal(entry.status, 'open');
});

test('finding 2: failure counting is order-independent; stale failures never trip', () => {
  const recent = T;
  const recent2 = T + 5 * MIN;
  const stale = T - 60 * MIN;
  // Recent-then-ancient: trip on the two recents; re-processing the stale one
  // afterwards is a no-op on the open arm.
  const a = createBreakerStore();
  assert.equal(recordArmFailure(a, 'x', 'arm', { atMs: recent, errorText: 'auth_unavailable' }, recent, cfg), null);
  assert.equal(recordArmFailure(a, 'x', 'arm', { atMs: recent2, errorText: 'auth_unavailable' }, recent2, cfg).transition, 'opened');
  assert.equal(recordArmFailure(a, 'x', 'arm', { atMs: stale, errorText: 'auth_unavailable' }, recent2, cfg), null);
  // Ancient-then-recent on a fresh store agrees: the stale failure is dropped,
  // never counted, and the same two recents trip.
  const b = createBreakerStore();
  assert.equal(recordArmFailure(b, 'x', 'arm', { atMs: stale, errorText: 'auth_unavailable' }, stale, cfg), null);
  assert.equal(recordArmFailure(b, 'x', 'arm', { atMs: recent, errorText: 'auth_unavailable' }, recent2, cfg), null);
  assert.equal(recordArmFailure(b, 'x', 'arm', { atMs: recent2, errorText: 'auth_unavailable' }, recent2, cfg).transition, 'opened');
  // A stale failure re-processed against a single recent failure cannot trip.
  const c = createBreakerStore();
  assert.equal(recordArmFailure(c, 'x', 'arm', { atMs: recent, errorText: 'auth_unavailable' }, recent, cfg), null);
  assert.equal(recordArmFailure(c, 'x', 'arm', { atMs: stale, errorText: 'auth_unavailable' }, recent, cfg), null);
  assert.equal(breakerState(c, 'x', 'arm', recent, cfg), 'closed');
  assert.ok(DEFAULT_BREAKERS); // keep the import honest if defaults change shape
});

test('finding 3: two hooks claim one half-open probe; the second run routes elsewhere', async () => {
  const r = rig();
  await r.boot();
  await r.tick();
  // Every arm open except the cheapest, whose cool-off (6h) elapsed 7h after
  // opening, so it is the only pickable arm and it is half-open at tick time.
  const seed = createBreakerStore();
  for (const arm of ARMS.slice(1)) {
    recordArmFailure(seed, 'claude:a1', arm, { atMs: T - 2 * MIN, errorText: 'auth_unavailable' }, T - 2 * MIN, cfg);
    recordArmFailure(seed, 'claude:a1', arm, { atMs: T - MIN, errorText: 'auth_unavailable' }, T - MIN, cfg);
  }
  recordArmFailure(seed, 'claude:a1', ARMS[0], { atMs: T - 7 * HOUR, errorText: 'auth_unavailable' }, T - 7 * HOUR, cfg);
  recordArmFailure(seed, 'claude:a1', ARMS[0], { atMs: T - 7 * HOUR + MIN, errorText: 'auth_unavailable' }, T - 7 * HOUR + MIN, cfg);
  assert.equal(breakerState(seed, 'claude:a1', ARMS[0], T, cfg), 'half-open');
  r.seed(BREAKER_SKEY, breakerStoreToJSON(seed, { nowMs: T, cfg }));

  // Restart so the tick loads the seed (proves the persisted form works too).
  await r.boot();
  await r.tick();

  const h1 = await r.hook('run-probe-1');
  assert.equal(h1.kind, 'decide');
  assert.equal(h1.model, 'claude-haiku-5-5');
  // The probe slot is now occupied: the second run must not pile onto the
  // same arm (every other arm is open), so it defers to a later tick.
  const h2 = await r.hook('run-probe-2');
  assert.equal(h2.kind, 'defer');
  // The probe claim is memory-only until the next tick persists it.
  await r.tick();
  const cap = await r.capacity();
  const entry = cap.body.armBreakers.find(e => e.armId === ARMS[0]);
  assert.equal(entry.status, 'half-open');
  assert.equal(entry.probeRunId, 'run-probe-1');
});
