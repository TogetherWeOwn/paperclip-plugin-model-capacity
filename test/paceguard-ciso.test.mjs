import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { DEFAULT_PACE_GUARD } from '../src/paceguard.mjs';
import { withSyntheticReadiness, syntheticAvailability } from './synthetic-readiness.mjs';

// Regression tests for the CISO re-review on the v0.2.28 pace-guard merge
// (adverse findings, fixed here). Each test fails on the pre-fix code. The
// drive mirrors paceguard-plugin.test.mjs.

const TICK = Date.parse('2026-10-08T23:00:00Z');
const HOUR = 3600 * 1000;
const MIN = 60 * 1000;
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
// spent. 90% with 48h left is ~19 points ahead of the linear plan; the
// slots left are well under one, so the cap is 1.
const claudeLane = (used, hoursLeft = 48, over = {}) => ({
  lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy',
  weekly: { used, resetsAt: new Date(TICK + hoursLeft * HOUR).toISOString() },
  fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
  observedAt: new Date(TICK).toISOString(), quality: 'live',
  models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  ...over,
});
// 30% with 48h left is ~41 points behind plan: never paced.
const geminiLane = (used = 0.3, hoursLeft = 48) => ({
  lane: 'gemini-1', provider: 'gemini', accountKey: 'g1', health: 'healthy',
  weekly: { used, resetsAt: new Date(TICK + hoursLeft * HOUR).toISOString() },
  fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
  observedAt: new Date(TICK).toISOString(), quality: 'live',
  models: ['gemini-2-5-flash'],
});

const runEvent = (runId, atMs, type = 'agent.run.started', agentId = 'agent-9', runExtra = {}) => ({
  type, companyId: 'acme', entityId: runId,
  payload: { run: { agentId, provider: 'claude', ...runExtra } },
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
  // Unit suite drives the lane read against the public placeholder pin
  // with a fake http client (see the requirePinnedLaneHost seam).
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return {
    setNow: ms => { now = ms; },
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

// Finding 1 (Medium): a deferred mark must stop suppressing its run once the
// host's retry lifespan is over. The host abandons a run after 12 deferred
// attempts, so a mark older than 12 x retryAfterMs (+ slack) no longer means
// "waiting": the run counts as in flight again (fail closed, like a lost
// terminal event whose record stays running until the horizon). Pre-fix the
// mark lives until the next defer arrives, so the pool reads empty and the
// guard admits a run over the cap.
test('hook: a deferred run abandoned past the retry budget counts as in-flight again', async () => {
  const d = drive({ config: { enforce: true, pacing: { holdAheadPts: null } }, accounts: [claudeLane(0.9)] });
  await d.setup();
  await d.tick();
  assert.equal((await d.hook('run-1')).kind, 'decide');
  // run-2 starts (host order: started fires before the hook resolves) with a
  // model the tick maps to the claude pool, then the hook defers it at the
  // cap and marks it waiting. The event is stamped at the tick time: a
  // future anchor would read as unverified and leave the census through the
  // read-time prune instead of the TTL, so the TTL assertions below would
  // pass with the TTL logic removed.
  await d.fire(runEvent('run-2', TICK, 'agent.run.started', 'agent-9', { model: 'claude-opus-5-5' }));
  const def = await d.hook('run-2');
  assert.equal(def.kind, 'defer');
  assert.match(def.reason, /pace guard/);
  // run-1 finishes; run-2 never resolves and no terminal event ever lands.
  await d.fire(runEvent('run-1', TICK + 2 * MIN, 'agent.run.finished'));
  await d.tick();
  // Inside 12 x 300 s + 60 s slack = 61 min the mark is fresh, so the pool
  // reads empty and the next run is admitted.
  d.setNow(TICK + 30 * MIN);
  await d.tick();
  assert.equal((await d.hook('run-3')).kind, 'decide', 'fresh mark still hides run-2; the pool has a free slot');
  // Past the 61 min lifespan, inside the 2 h ledger horizon, the stale mark
  // drops and run-2 counts as in flight again: the pool is back at its cap.
  // Same run id as above, so the guard's self-exclusion keeps run-3's own
  // decided record out of the census and only run-2 can hold the pool.
  d.setNow(TICK + 70 * MIN);
  await d.tick();
  d.killIo();
  const again = await d.hook('run-3');
  assert.equal(again.kind, 'defer', 'stale mark must not hide run-2; the pool is still at its cap');
  assert.match(again.reason, /pace guard/);
});

// Finding 2 (Low-Medium): a fresh nonterminal run with neither
// decidedAccount nor actualAccount is deliberately NOT counted toward any
// pool's cap: each may belong to any pool, or to none (an undecided run may
// never execute), so counting them lets one burst of fresh starts hold every
// pool for all the others and nothing is ever decided (trial-budget and
// shadow-agreement tests pin the deciding behavior). The fail-open is
// explicit instead: /capacity publishes the unaccounted amount. Here the
// claude lane is all-cooling (no ready credentials, transient lane state)
// while the thinker is banned from the healthy gemini family: the ban holds
// (claude still serves the role structurally, so no suspension lifts it)
// but nothing anywhere can decide the thinker's run, so its started record
// stays running and unattributed; the hook still decides for the doer on
// gemini while the report shows the 1 unaccounted run and no claude pool
// usage (unmeasured while all-cooling).
test('hook: an unattributed waiting run fails open and is exposed in /capacity', async () => {
  const coolingClaude = claudeLane(0.9);
  coolingClaude.credentialAvailability = syntheticAvailability(coolingClaude, TICK, { serving: 1, ready: 0 });
  const d = drive({
    config: {
      enforce: true,
      // Readiness admission is opt-in (v0.2.37); without it the cooling lane is admitted.
      credentialReadiness: { enforce: true },
      roles: {
        thinkerAgentIds: ['agent-thinker'],
        excludeFamilies: { thinker: ['gemini'] },
      },
    },
    accounts: [coolingClaude, geminiLane()],
  });
  await d.setup();
  await d.tick();
  // The thinker starts a run nobody can decide for it (claude all-cooling,
  // gemini banned for its role) and no model info ever resolves, so the
  // record stays running and unattributed. The event is stamped at the tick
  // time: a future anchor would read as stale and leave the census entirely.
  await d.fire(runEvent('run-X', TICK, 'agent.run.started', 'agent-thinker'));
  await d.tick();
  const cap = (await d.api('capacity')).body;
  assert.equal(cap.paceGuard.unattributedInFlight, 1, 'the unaccounted run is visible to operators');
  assert.equal(
    cap.paceGuard.pools.find(p => p.pool === 'claude')?.inFlight ?? 0, 0,
    'the unattributed run consumes none of the claude pool cap (unmeasured while all-cooling)',
  );
  d.killIo();
  const h = await d.hook('run-Y');
  assert.equal(h.kind, 'decide', 'fail open: an unknown run alone never holds the pool');
});

// Finding 3 (Low): when a paced pool AND unselectable unpaced accounts both
// hold, the defer must carry the pace-guard retry, not the 60 s generic one.
// Pool A is ahead at its cap; pool B is on plan but fully excluded for the
// deciding role, so the loop skips everything it can see.
test('hook: a paced pool plus unselectable unpaced accounts defers on the guard retry', async () => {
  const d = drive({
    config: { enforce: true, pacing: { holdAheadPts: null }, roles: { excludeFamilies: { doer: ['gemini'] } } },
    accounts: [claudeLane(0.9), geminiLane()],
  });
  await d.setup();
  await d.tick();
  d.killIo();
  assert.equal((await d.hook('run-0')).kind, 'decide', 'gemini excluded, claude takes the single slot');
  const h = await d.hook('run-1');
  assert.equal(h.kind, 'defer');
  assert.equal(h.retryAfterMs, DEFAULT_PACE_GUARD.retryAfterMs, 'the paced pool waits minutes for a slot, not seconds');
  assert.match(h.reason, /pace guard/);
  assert.match(h.reason, /claude/);
  assert.match(h.reason, /1 unpaced account\(s\) also unselectable/);
});
