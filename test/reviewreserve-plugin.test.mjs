/**
 * Review reserve through the plugin: the enforcing hook, the shadow tick
 * and /capacity agree on the held Claude accounts. A held account admits
 * review runs (agents in reviewReserve.agentIds) but defers other work;
 * pinned agents (roles.keepAgentIds) keep their model before admission.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { orderAccountsWithPacing } from '../src/select.mjs';
import { REVIEW_RESERVE_STATE_KEY } from '../src/reviewreserve.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const TICK = Date.parse('2026-10-08T23:00:00Z');
const HOUR = 3600 * 1000;
const hourStart = (ms) => Math.floor(ms / HOUR) * HOUR;
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
const RR_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: REVIEW_RESERVE_STATE_KEY };

const aaRows = () => ([
  { slug: 'claude-opus-5-5', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
  { slug: 'claude-haiku-5-5-xhigh', intelligenceIndex: 53, intelligenceIndexCostPerTask: 8, price1mInputTokens: 1, price1mOutputTokens: 5 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
]);

const lane = (used, hoursLeft, fiveUsed = 0.1, fiveLeftH = 4) => ({
  lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy',
  weekly: { used, resetsAt: new Date(TICK + hoursLeft * HOUR).toISOString() },
  fiveHour: { used: fiveUsed, resetsAt: new Date(TICK + fiveLeftH * HOUR).toISOString() },
  observedAt: new Date(TICK).toISOString(), quality: 'live',
  models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
});

const runEvent = (runId, atMs, agentId) => ({
  type: 'agent.run.started', companyId: 'acme', entityId: runId,
  payload: { run: { agentId, provider: 'claude' } },
  occurredAt: new Date(atMs).toISOString(),
});

// Two closed hours of measured review burn: 1.0 %/h each, 10 runs each.
// burn: closed-hour review burn %/h. The hook test uses 2.0 so demand
// (need 2.025) still pins R at the 0.95 cap against the roomier lane below.
const burnedState = (burn = 1.0) => ({
  buckets: [
    { atMs: hourStart(TICK) - 2 * HOUR, burn: { 'claude:a1': burn }, runs: { 'claude:a1': 10 } },
    { atMs: hourStart(TICK) - HOUR, burn: { 'claude:a1': burn }, runs: { 'claude:a1': 10 } },
  ],
  envelope: null,
  runsRate: null,
  lastFoldMs: hourStart(TICK) - 2 * HOUR,
});

function drive({ config = {}, accounts, feedExtra = {} }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = TICK;
  let laneAccounts = accounts;
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET, ...(config.cliproxy ?? {}) } }) },
    state: { get: async k => store.get(skey(k)) ?? null, set: async (k, v) => { store.set(skey(k), v); } },
    secrets: { resolve: async () => 'lane-key' },
    http: {
      fetch: async () => ({
        status: 200,
        json: async () => withSyntheticReadiness(
          { observedAt: new Date(now).toISOString(), accounts: laneAccounts, ...feedExtra }, now),
      }),
    },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now });
  return {
    setNow: ms => { now = ms; },
    seed: (key, value) => { store.set(skey(key), value); },
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: () => jobs.get('shadow-tick')({ companyId: 'acme' }),
    fire: e => handlers.get(e.type)(e),
    hook: (runId, extra = {}) => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId: 'agent-9', issueId: null, adapterType: 'claude-code',
      invocationSource: 'test', wakeReason: null, agentDefaultModel: null, previous: null,
      issueOverrideModel: null, deadlineMs: 1500, ...extra,
    }),
    api: routeKey => plugin.onApiRequest({ companyId: 'acme', routeKey }),
  };
}

const REVIEW_CFG = {
  enforce: true,
  roles: { keepAgentIds: ['reviewer-1'] },
  reviewReserve: { agentIds: ['reviewer-1', 'reviewer-2'] },
};

test('ordering: a held account leaves the non-review order but stays for review runs', () => {
  const view = {
    accountId: 'claude:a1', health: 'healthy', headroomPct: 0.5,
    resetAtMs: TICK + 100 * HOUR, targetShare: 1, inFlight: 0,
    measuredRatePerHour: null, requiredRatePerHour: 0.005,
  };
  const held = { heldAccountIds: ['claude:a1'], forReview: false };
  const closed = orderAccountsWithPacing([view], { reviewReserve: held });
  assert.equal(closed.order.length, 0);
  assert.equal(closed.reserveHeld.length, 1);
  assert.equal(closed.reserveHeld[0].accountId, 'claude:a1');
  const open = orderAccountsWithPacing([view], { reviewReserve: { heldAccountIds: ['claude:a1'], forReview: true } });
  assert.equal(open.order.length, 1);
  const plain = orderAccountsWithPacing([view]);
  assert.equal(plain.order.length, 1);
});

test('hook: non-review work defers on a held Claude account; review runs decide; pinned agents keep', async () => {
  // 40h to reset: the pool's pace cap fits the waiting review plus one more
  // (a cap-1 pool with an executing review admits nothing, reserve or not).
  const d = drive({ config: REVIEW_CFG, accounts: [lane(0.5, 40)] });
  await d.setup();
  d.seed(RR_STATE_KEY, burnedState(2.0));
  // One review run waiting reclaims the reserve through admission.
  await d.fire(runEvent('rev-waiting', TICK - 60000, 'reviewer-2'));
  await d.tick();
  const cap = (await d.api('capacity')).body;
  assert.equal(cap.reviewReserve.enabled, true);
  assert.equal(cap.reviewReserve.perProvider.claude.reserve, 0.95);
  assert.equal(cap.reviewReserve.perProvider.claude.lent, false);
  assert.deepEqual(cap.reviewReserve.heldAccountIds, ['claude:a1']);
  // Other work: the only account is held for reviews -> defer, and the
  // reason says so (not a generic no-headroom).
  const other = await d.hook('run-other');
  assert.equal(other.kind, 'defer');
  assert.match(other.reason, /review reserve/);
  // A review run (not pinned) is admitted past the hold: the hook answers
  // decide, and the ledger records it on the held account (the hook's
  // decide carries no accountId by convention -- see enforce.test.mjs).
  const review = await d.hook('run-review', { agentId: 'reviewer-2' });
  assert.equal(review.kind, 'decide');
  // Hook decisions persist on the next tick; the shadow log then shows the
  // review on the held account (entry field is accountId, not decidedAccount).
  await d.tick();
  const shadow = (await d.api('shadow')).body;
  assert.equal(shadow.entries.find(e => e.runId === 'run-review')?.accountId, 'claude:a1');
  // A pinned agent keeps its model before admission, hold or no hold.
  const pinned = await d.hook('run-pinned', { agentId: 'reviewer-1' });
  assert.equal(pinned.kind, 'keep');
});

test('hook: a held 5h window holds even while the weekly window is fine', async () => {
  const d = drive({ config: REVIEW_CFG, accounts: [lane(0.02, 100, 0.5, 4)] });
  await d.setup();
  d.seed(RR_STATE_KEY, burnedState());
  await d.fire(runEvent('rev-waiting', TICK - 60000, 'reviewer-2'));
  await d.tick();
  const cap = (await d.api('capacity')).body;
  assert.deepEqual(cap.reviewReserve.heldAccountIds, ['claude:a1']);
  assert.equal(cap.reviewReserve.perProvider.claude.accounts[0].window, 'five-hour');
  const other = await d.hook('run-other');
  assert.equal(other.kind, 'defer');
  assert.match(other.reason, /review reserve/);
});

test('lending: with no review demand the reserve sits at the floor and nothing is held', async () => {
  const d = drive({ config: REVIEW_CFG, accounts: [lane(0.5, 100)] });
  await d.setup();
  await d.tick();
  const cap = (await d.api('capacity')).body;
  assert.equal(cap.reviewReserve.perProvider.claude.reserve, 0.10);
  assert.equal(cap.reviewReserve.perProvider.claude.lent, true);
  assert.deepEqual(cap.reviewReserve.heldAccountIds, []);
  const other = await d.hook('run-other');
  assert.equal(other.kind, 'decide');
});

test('disabled: reviewReserve.enabled false restores pre-reserve admission', async () => {
  const d = drive({
    config: { ...REVIEW_CFG, reviewReserve: { enabled: false, agentIds: ['reviewer-1', 'reviewer-2'] } },
    accounts: [lane(0.5, 40)],
  });
  await d.setup();
  d.seed(RR_STATE_KEY, burnedState());
  await d.fire(runEvent('rev-waiting', TICK - 60000, 'reviewer-2'));
  await d.tick();
  const cap = (await d.api('capacity')).body;
  assert.equal(cap.reviewReserve.enabled, false);
  assert.deepEqual(cap.reviewReserve.heldAccountIds, []);
  const other = await d.hook('run-other');
  assert.equal(other.kind, 'decide');
});
