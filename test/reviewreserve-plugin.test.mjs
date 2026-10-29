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
  { slug: 'gemini-2-5-flash', intelligenceIndex: 54, intelligenceIndexCostPerTask: 5, price1mInputTokens: 1, price1mOutputTokens: 3 },
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

const geminiLane = (used, hoursLeft = 48) => ({
  lane: 'gemini-1', provider: 'gemini', accountKey: 'g1', health: 'healthy',
  weekly: { used, resetsAt: new Date(TICK + hoursLeft * HOUR).toISOString() },
  fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
  observedAt: new Date(TICK).toISOString(), quality: 'live',
  models: ['gemini-2-5-flash'],
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

function drive({ config = {}, accounts, feedExtra = {}, agentGets = {} }) {
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

test('hook: a pinned review run (armId null) still prices review burn into the reserve', async () => {
  // Default config reviews ARE the pinned keep agents: their ledger records
  // carry armId null (the hook keeps before arm selection). Pre-fix the
  // fold priced burnOf(null) = null and skipped them, so R sat at the floor
  // forever with the default config; post-fix they price from the pinned
  // model on the kept record, falling back to the hottest arm only when the
  // model matches nothing.
  // The pinned reviewer resolves its configured model to the claude lane,
  // so the keep decision lands in the ledger (armId null, decidedAccount
  // claude:a1) for the fold to price.
  const d = drive({
    config: REVIEW_CFG,
    accounts: [lane(0.5, 40)],
    agentGets: { 'reviewer-1': { adapterConfig: { model: 'claude-opus-5-5' } } },
  });
  await d.setup();
  await d.tick();
  const kept = await d.hook('run-review-kept', { agentId: 'reviewer-1' });
  assert.equal(kept.kind, 'keep');
  // Close the partial hour so the kept run's burn enters the envelope.
  d.setNow(TICK + HOUR + 60000);
  await d.tick();
  const claude = (await d.api('capacity')).body.reviewReserve.perProvider.claude;
  assert.ok(claude.reviewRatePctPerH > 0, `kept review burn must price, got ${claude.reviewRatePctPerH}`);
});

test('hook: pinned review burn prices from the pinned model end to end', async () => {
  // Plugin-level cover for the pinned-pricing wiring: the hook's kept record
  // (armId null, wouldModel = pinned model), burnOf's model argument, and the
  // ladder arm-model map must all work, or Haiku and Opus reviewers price the
  // same (the hottest arm). Ten kept runs each, past the hour: Haiku must run
  // below half the Opus rate.
  const rateFor = async (pinnedModel, prefix) => {
    const d = drive({
      config: REVIEW_CFG,
      accounts: [lane(0.5, 40)],
      agentGets: { 'reviewer-1': { adapterConfig: { model: pinnedModel } } },
    });
    await d.setup();
    await d.tick();
    for (let i = 0; i < 10; i++) {
      const kept = await d.hook(`${prefix}-${i}`, { agentId: 'reviewer-1' });
      assert.equal(kept.kind, 'keep');
    }
    d.setNow(TICK + HOUR + 60000);
    await d.tick();
    return (await d.api('capacity')).body.reviewReserve.perProvider.claude.reviewRatePctPerH;
  };
  const haiku = await rateFor('claude-haiku-5-5', 'run-haiku');
  const opus = await rateFor('claude-opus-5-5', 'run-opus');
  assert.ok(haiku > 0, `Haiku-pinned review burn must price, got ${haiku}`);
  assert.ok(opus > 0, `Opus-pinned review burn must price, got ${opus}`);
  assert.ok(haiku < opus / 2, `Haiku-pinned (${haiku}) must run below half the Opus-pinned rate (${opus})`);
});

test('hook: a reserve defer retries on the pace-guard scale and names a co-holding guard', async () => {
  // 90%-used claude is reserve-held (burn 2.0 %/h, one review waiting);
  // gemini 90% with 48h left is ~19 points ahead of plan, so one executing
  // gemini run paces its pool at cap 1. A second doer run then faces BOTH
  // holds: the defer must carry the guard retry (not the 60 s generic one)
  // and name both holds.
  const d = drive({
    config: { ...REVIEW_CFG, pacing: { guard: { retryAfterMs: 600000 } } },
    accounts: [lane(0.9, 40), geminiLane(0.9, 48)],
  });
  await d.setup();
  d.seed(RR_STATE_KEY, burnedState(2.0));
  await d.fire(runEvent('rev-waiting', TICK - 60000, 'reviewer-2'));
  await d.tick();
  assert.deepEqual((await d.api('capacity')).body.reviewReserve.heldAccountIds, ['claude:a1']);
  const g = await d.hook('run-g');
  assert.equal(g.kind, 'decide', 'gemini is the only unheld account');
  // The gemini pool caps at 2: a second executing run fills it.
  const g2 = await d.hook('run-g2');
  assert.equal(g2.kind, 'decide', 'second gemini run fills the pool to its cap');
  await d.tick();
  const both = await d.hook('run-d');
  assert.equal(both.kind, 'defer');
  assert.equal(both.retryAfterMs, 600000, 'reserve wait retries on the guard scale, not 60 s');
  assert.match(both.reason, /review reserve: claude:a1 held for review runs/);
  assert.match(both.reason, /pace guard/, 'the co-holding guard is named, not hidden behind the reserve');
});

test('report: a reserve-held pool stays listed in paceGuard.pools', async () => {
  // The tick's pace report must see the complete pool set (applyReserve
  // false), not the reserve-filtered order. Pre-fix the merged
  // allocationOrder signature bound { applyReserve: false } to the new
  // `duplicates` parameter, so a held claude pool vanished from /capacity
  // paceGuard.pools while the suite stayed green.
  const d = drive({ config: REVIEW_CFG, accounts: [lane(0.5, 40)] });
  await d.setup();
  d.seed(RR_STATE_KEY, burnedState(2.0));
  await d.fire(runEvent('rev-waiting', TICK - 60000, 'reviewer-2'));
  await d.tick();
  const cap = (await d.api('capacity')).body;
  assert.ok((cap.reviewReserve.heldAccountIds ?? []).includes('claude:a1'), 'claude is reserve-held');
  const pool = (cap.paceGuard.pools ?? []).find(p => p.pool === 'claude');
  assert.ok(pool != null, 'a held pool is still listed in the pace-guard report');
});

test('weekly hard hold: role safety reports the reserve-applied non-review admission', async () => {
  const d = drive({
    config: { enforce: true, reviewReserve: { agentIds: ['reviewer-1'], providers: ['gemini'] } },
    accounts: [lane(0.83, 104.16), { ...geminiLane(0.3, 48),
      fiveHour: { used: 0.5, resetsAt: new Date(TICK + 4 * HOUR).toISOString() } }],
  });
  await d.setup();
  d.seed(RR_STATE_KEY, {
    ...burnedState(2.0),
    buckets: [2, 1].map(hoursAgo => ({ atMs: hourStart(TICK) - hoursAgo * HOUR,
      burn: { 'gemini:g1': 2.0 }, runs: { 'gemini:g1': 10 } })),
  });
  await d.fire({ type: 'agent.run.started', companyId: 'acme', entityId: 'review-waiting',
    payload: { run: { agentId: 'reviewer-1', provider: 'gemini', model: 'gemini-2-5-flash' } },
    occurredAt: new Date(TICK - 60000).toISOString() });
  await d.tick();
  const capacity = (await d.api('capacity')).body;
  assert.deepEqual(capacity.reviewReserve.heldAccountIds, ['gemini:g1']);
  assert.ok(Math.abs(capacity.accounts.find(a => a.accountId === 'claude:a1').planAhead - 0.45) < 1e-10);
  assert.ok(capacity.accounts.find(a => a.accountId === 'gemini:g1').planAhead < 0);
  const route = await d.hook('non-review-safety');
  assert.equal(route.kind, 'decide');
  assert.match(route.model, /^claude/, 'reserve remains closed to non-review work');
  assert.equal((await d.hook('non-review-next')).kind, 'defer', 'the restored ordinary cap still binds');
  assert.ok(capacity.paceGuard.roleSafety.some(row => row.role === 'doer'
    && row.code === 'role-empty-hold-suspended' && row.accountIds.includes('claude:a1')),
  JSON.stringify(capacity.paceGuard.roleSafety));
});

test('hook: a lone reserve hold still defers on the guard retry scale', async () => {
  const d = drive({
    config: { ...REVIEW_CFG, pacing: { guard: { retryAfterMs: 600000 } } },
    accounts: [lane(0.5, 40)],
  });
  await d.setup();
  d.seed(RR_STATE_KEY, burnedState(2.0));
  await d.fire(runEvent('rev-waiting', TICK - 60000, 'reviewer-2'));
  await d.tick();
  const other = await d.hook('run-other');
  assert.equal(other.kind, 'defer');
  assert.equal(other.retryAfterMs, 600000, 'a 60 s reserve retry would burn the host 12-attempt budget in ~12 min');
  assert.match(other.reason, /review reserve/);
});
