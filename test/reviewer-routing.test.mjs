/**
 * Reviewer routing (0.2.53): both Claude and Meta accounts serve reviews.
 * reviewer.providers falls back to reviewReserve.providers; reviewerRouting
 * routes listed review agents to the best configured arm (burn mode first,
 * then the pool most behind plan) instead of keep; absent config = keep.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin, resolveConfig, validateConfigShape } from '../src/plugin.mjs';
import { normalizeReviewer, computeReviewerCapacity } from '../src/reviewer.mjs';
import {
  validateReviewerRouting, normalizeReviewerRouting, burnModeTokens, isBurnFlagged, selectReviewerRoute,
} from '../src/reviewerrouting.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const TICK = Date.parse('2026-10-08T23:00:00Z');
const HOUR = 3600 * 1000;
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
const WONDER = 'muse-wonder-full-1.0-contributor';

const aaRows = () => ([
  { slug: 'claude-opus-5-5', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
]);

const claudeLane = (used, hoursLeft, extra = {}) => ({
  lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy',
  weekly: { used, resetsAt: new Date(TICK + hoursLeft * HOUR).toISOString() },
  fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
  observedAt: new Date(TICK).toISOString(), quality: 'live',
  models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  ...extra,
});

const metaLane = (key, used, hoursLeft, extra = {}) => ({
  lane: key, provider: 'meta', accountKey: key, health: 'healthy',
  weekly: { used, resetsAt: new Date(TICK + hoursLeft * HOUR).toISOString() },
  fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
  observedAt: new Date(TICK).toISOString(), quality: 'live',
  models: [WONDER, 'muse-spark-1.3-contributor'],
  ...extra,
});

function drive({ config = {}, accounts, heartbeats = [], issues = [] }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  let now = TICK;
  let laneAccounts = accounts;
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET } }) },
    state: { get: async k => store.get(skey(k)) ?? null, set: async (k, v) => { store.set(skey(k), v); } },
    secrets: { resolve: async () => 'lane-key' },
    http: {
      fetch: async () => ({
        status: 200,
        json: async () => withSyntheticReadiness({ observedAt: new Date(now).toISOString(), accounts: laneAccounts }, now),
      }),
    },
    agents: { get: async () => null, getQueuedRunCounts: async () => heartbeats },
    issues: { get: async () => null, list: async ({ status } = {}) => issues.filter(row => !status || row.status === status) },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return {
    setNow: ms => { now = ms; },
    setAccounts: list => { laneAccounts = list; },
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: () => jobs.get('shadow-tick')({ companyId: 'acme' }),
    hook: (runId, extra = {}) => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId: 'reviewer-1', issueId: null, adapterType: 'opencode_local',
      invocationSource: 'test', wakeReason: null, agentDefaultModel: null, previous: null,
      issueOverrideModel: null, deadlineMs: 1500, ...extra,
    }),
    api: routeKey => plugin.onApiRequest({ companyId: 'acme', routeKey }),
    fire: e => handlers.get(e.type)(e),
    updateCapacity: fn => fn(store.get(skey({ ...AA_STATE_KEY, stateKey: 'capacity-v1' }))),
  };
}

const ARMS = [
  { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  { provider: 'meta', model: WONDER, effort: 'max' },
];
const BASE = {
  enforce: true,
  roles: { keepAgentIds: ['reviewer-1'] },
  reviewReserve: { agentIds: ['reviewer-1'], providers: ['claude', 'meta'] },
};

// ---------- 1. reviewer.providers fallback ----------

test('reviewer.providers: reviewReserve.providers when set, explicit wins, else claude', () => {
  assert.deepEqual(normalizeReviewer({}, { defaultProviders: ['Claude', 'meta'] }).providers, ['claude', 'meta']);
  assert.deepEqual(normalizeReviewer({ providers: ['meta'] }, { defaultProviders: ['claude', 'meta'] }).providers, ['meta']);
  assert.deepEqual(normalizeReviewer({}).providers, ['claude']);
  assert.deepEqual(resolveConfig({ reviewReserve: { providers: ['claude', 'meta'] } }).reviewer.providers, ['claude', 'meta']);
  assert.deepEqual(resolveConfig({ reviewReserve: { providers: ['claude', 'meta'] }, reviewer: { providers: ['claude'] } }).reviewer.providers, ['claude']);
  assert.deepEqual(resolveConfig({}).reviewer.providers, ['claude']);
  assert.deepEqual(resolveConfig({ reviewReserve: { enabled: true } }).reviewer.providers, ['claude']);
});

test('reviewer capacity counts Meta and Claude lanes when both are reserved', () => {
  const cfg = resolveConfig({ reviewReserve: { providers: ['claude', 'meta'] } }).reviewer;
  const acct = (accountId, provider) => ({ accountId, provider, health: 'healthy', headroomPct: 0.5, reviewerEligible: true });
  const cap = computeReviewerCapacity({ accounts: [acct('claude:a1', 'claude'), acct('meta:meta-lane-3', 'meta'), acct('codex:c1', 'codex')], cfg });
  assert.deepEqual(cap.qualifiedAccountIds, ['claude:a1', 'meta:meta-lane-3']);
  assert.equal(cap.slots, 1);
  assert.deepEqual(cap.providers, ['claude', 'meta']);
});

// ---------- 2. config ----------

test('reviewerRouting validation', () => {
  assert.deepEqual(validateReviewerRouting(undefined), []);
  assert.deepEqual(validateReviewerRouting({ arms: [{ provider: 'meta', model: WONDER, effort: 'max' }] }), []);
  assert.ok(validateReviewerRouting([]).length > 0);
  assert.ok(validateReviewerRouting({ arms: [] }).some(e => /non-empty array/.test(e)));
  assert.ok(validateReviewerRouting({ arms: [{ provider: '', model: 'x' }] }).some(e => /provider/.test(e)));
  assert.ok(validateReviewerRouting({ arms: [{ provider: 'meta' }] }).some(e => /model/.test(e)));
  assert.ok(validateReviewerRouting({ arms: [{ provider: 'meta', model: 'x', effort: 3 }] }).some(e => /effort/.test(e)));
  assert.ok(validateReviewerRouting({ arms: [{ provider: 'meta', model: 'x', bogus: 1 }] }).some(e => /bogus/.test(e)));
  assert.ok(validateReviewerRouting({ agentIds: 'r', arms: ARMS }).some(e => /agentIds/.test(e)));
  assert.ok(validateReviewerRouting({ arms: ARMS, extra: 1 }).some(e => /extra/.test(e)));
  assert.ok(validateConfigShape({ reviewerRouting: { arms: [] } }).some(e => /reviewerRouting/.test(e)));
  assert.equal(validateConfigShape({ reviewerRouting: { arms: ARMS } }).some(e => /reviewerRouting/.test(e)), false);
});

test('reviewerRouting normalizes; agentIds default to reviewReserve.agentIds (then keepAgentIds)', () => {
  assert.equal(normalizeReviewerRouting(undefined), null);
  assert.equal(normalizeReviewerRouting({ arms: [] }), null);
  assert.equal(normalizeReviewerRouting({ enabled: false, arms: ARMS }), null);
  const n = normalizeReviewerRouting({ arms: [...ARMS, { provider: 'META', model: ` ${WONDER} `, effort: 'max' }] }, { reviewAgentIds: ['r1'] });
  assert.deepEqual(n.agentIds, ['r1']);
  assert.equal(n.arms.length, 2);
  assert.equal(n.arms[1].provider, 'meta');
  assert.equal(resolveConfig({ roles: { keepAgentIds: ['k1'] }, reviewerRouting: { arms: ARMS } }).reviewerRouting.agentIds[0], 'k1');
  assert.deepEqual(resolveConfig({ roles: { keepAgentIds: ['k1'] }, reviewReserve: { agentIds: ['r1', 'r2'] }, reviewerRouting: { arms: ARMS } }).reviewerRouting.agentIds, ['r1', 'r2']);
  assert.deepEqual(resolveConfig({ reviewReserve: { agentIds: ['r1'] }, reviewerRouting: { agentIds: ['x'], arms: ARMS } }).reviewerRouting.agentIds, ['x']);
  assert.equal(resolveConfig({}).reviewerRouting, null);
});

test('burn mode tokens: tolerant shapes, matched by id, lane or label', () => {
  assert.equal(burnModeTokens(undefined).size, 0);
  assert.equal(burnModeTokens({ enabled: false, accounts: ['meta:x'] }).size, 0);
  assert.ok(burnModeTokens(['Meta:Meta-Lane-3']).has('meta:meta-lane-3'));
  assert.ok(burnModeTokens({ accounts: [{ lane: 'meta-lane-4' }, { id: 'meta:off', enabled: false }] }).has('meta-lane-4'));
  assert.equal(burnModeTokens({ accounts: [{ id: 'meta:off', enabled: false }] }).has('meta:off'), false);
  assert.ok(burnModeTokens({ 'codex:codex-lane-1': true, 'meta:no': false }).has('codex:codex-lane-1'));
  assert.equal(burnModeTokens({ 'meta:no': false }).has('meta:no'), false);
  assert.ok(burnModeTokens({ accounts: { 'meta:meta-lane-5': { enabled: true } } }).has('meta:meta-lane-5'));
  const t = new Set(['meta-lane-3', 'rick@example.test']);
  assert.equal(isBurnFlagged({ accountId: 'meta:meta-lane-3' }, t), true);
  assert.equal(isBurnFlagged({ accountId: 'meta:meta-lane-9', label: 'Rick@example.test' }, t), true);
  assert.equal(isBurnFlagged({ accountId: 'meta:meta-lane-9' }, t), false);
});

// ---------- 2. pure selection ----------

const view = (accountId, extra = {}) => ({
  accountId, provider: accountId.split(':')[0], health: 'healthy', headroomPct: 0.6,
  remainingPct: 0.5, hoursToReset: 50, planAhead: 0, inFlight: 0, ...extra,
});
const CFG = { agentIds: ['reviewer-1'], arms: ARMS };

test('select: the pool most behind its pace plan wins; arm order breaks ties', () => {
  const behindMeta = selectReviewerRoute({ cfg: CFG, accounts: [view('claude:a1', { planAhead: 0.05 }), view('meta:m3', { planAhead: -0.2 })] });
  assert.equal(behindMeta.provider, 'meta');
  assert.equal(behindMeta.accountId, 'meta:m3');
  assert.equal(behindMeta.arm.model, WONDER);
  assert.match(behindMeta.reason, /behind plan/);
  const behindClaude = selectReviewerRoute({ cfg: CFG, accounts: [view('claude:a1', { planAhead: -0.3 }), view('meta:m3', { planAhead: -0.2 })] });
  assert.equal(behindClaude.provider, 'claude');
  const tie = selectReviewerRoute({ cfg: CFG, accounts: [view('meta:m3'), view('claude:a1')] });
  assert.equal(tie.provider, 'claude');
  // Unknown plan position: most remaining quota per hour to reset wins.
  const perHour = selectReviewerRoute({ cfg: CFG, accounts: [view('claude:a1', { planAhead: null, hoursToReset: 100 }), view('meta:m3', { planAhead: null, hoursToReset: 10 })] });
  assert.equal(perHour.provider, 'meta');
});

test('select: burn-mode accounts win over plan position; lanes spread by in-flight', () => {
  const tokens = new Set(['meta-lane-4']);
  const r = selectReviewerRoute({
    cfg: CFG, burnTokens: tokens,
    accounts: [view('claude:a1', { planAhead: -0.5 }), view('meta:meta-lane-3', { planAhead: 0.1 }), view('meta:meta-lane-4', { planAhead: 0.1 })],
  });
  assert.equal(r.accountId, 'meta:meta-lane-4');
  assert.equal(r.burn, true);
  assert.match(r.reason, /burn mode/);
  const spread = selectReviewerRoute({
    cfg: CFG, inFlightOf: (a) => (a.accountId === 'meta:meta-lane-3' ? 2 : 0),
    accounts: [view('meta:meta-lane-3', { planAhead: -0.2 }), view('meta:meta-lane-4', { planAhead: -0.2 })],
  });
  assert.equal(spread.accountId, 'meta:meta-lane-4');
});

test('select: unhealthy, excluded, guarded, no-headroom and unserved accounts never qualify', () => {
  const accounts = [
    view('claude:a1', { health: 'exhausted', planAhead: -0.9 }),
    view('claude:a2', { action: 'excluded', planAhead: -0.9 }),
    view('claude:a3', { guardActive: true, planAhead: -0.9 }),
    view('claude:a4', { headroomPct: 0.01, planAhead: -0.9 }),
    view('codex:c1', { planAhead: -0.9 }),
    view('meta:m3', { planAhead: 0.2 }),
  ];
  const r = selectReviewerRoute({ cfg: CFG, accounts });
  assert.equal(r.accountId, 'meta:m3');
  const unserved = selectReviewerRoute({ cfg: CFG, accounts, serves: (a) => (a.accountId === 'meta:m3' ? 'breaker open' : true) });
  assert.equal(unserved.none, true);
  assert.match(unserved.reason, /refused/);
  const none = selectReviewerRoute({ cfg: CFG, accounts: accounts.slice(0, 5) });
  assert.equal(none.none, true);
  assert.equal(selectReviewerRoute({ cfg: null, accounts }).none, true);
  // Plan headroom before credit-funded headroom.
  const credit = selectReviewerRoute({ cfg: CFG, accounts: [view('claude:a1', { creditFallback: true, planAhead: -0.9 }), view('meta:m3', { planAhead: 0.2 })] });
  assert.equal(credit.accountId, 'meta:m3');
});

// ---------- 2. plugin hook + /capacity ----------

test('hook: a keep-pinned reviewer routes to the Meta arm when Meta is most behind plan', async () => {
  // Meta: 10% used with 24h to reset (far behind plan); Claude: 90% used.
  const d = drive({
    config: { ...BASE, reviewerRouting: { arms: ARMS } },
    accounts: [claudeLane(0.9, 24), metaLane('meta-lane-3', 0.1, 24)],
  });
  await d.setup();
  await d.tick();
  const out = await d.hook('rev-1');
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, WONDER);
  assert.equal(out.effort, 'max');
  assert.match(out.reason, /reviewer routing: .* on meta:meta-lane-3/);
  await d.tick();
  const cap = (await d.api('capacity')).body;
  assert.equal(cap.reviewer.routing.enabled, true);
  assert.equal(cap.reviewer.routing.provider, 'meta');
  assert.equal(cap.reviewer.routing.accountId, 'meta:meta-lane-3');
  assert.deepEqual(cap.reviewer.routing.arm, { provider: 'meta', model: WONDER, effort: 'max' });
  assert.equal(cap.reviewer.routing.last.routed, true);
  assert.equal(cap.reviewer.routing.last.runId, 'rev-1');
  assert.deepEqual(cap.reviewer.providers, ['claude', 'meta']);
  assert.deepEqual(cap.reviewer.qualifiedAccountIds, ['claude:a1', 'meta:meta-lane-3']);
  const shadow = (await d.api('shadow')).body;
  assert.equal(shadow.entries.find(e => e.runId === 'rev-1')?.accountId, 'meta:meta-lane-3');
});

test('hook: a burn-mode account wins; an exhausted Meta pool routes to Claude', async () => {
  const burn = drive({
    config: { ...BASE, reviewerRouting: { arms: ARMS }, burnMode: { accounts: ['claude:a1'] } },
    accounts: [claudeLane(0.5, 24), metaLane('meta-lane-3', 0.1, 24)],
  });
  await burn.setup();
  await burn.tick();
  const b = await burn.hook('rev-burn');
  assert.equal(b.kind, 'decide');
  assert.equal(b.model, 'claude-opus-5-5');
  assert.equal(b.effort, 'high');
  assert.match(b.reason, /burn mode/);

  const ex = drive({
    config: { ...BASE, reviewerRouting: { arms: ARMS } },
    accounts: [claudeLane(0.5, 24), metaLane('meta-lane-3', 0.999, 24)],
  });
  await ex.setup();
  await ex.tick();
  const c = await ex.hook('rev-ex');
  assert.equal(c.kind, 'decide');
  assert.equal(c.model, 'claude-opus-5-5');
});

test('hook: no qualifying arm falls back to keep and reports why', async () => {
  const d = drive({
    config: { ...BASE, reviewerRouting: { arms: [{ provider: 'meta', model: 'muse-not-served', effort: 'max' }] } },
    accounts: [claudeLane(0.5, 24), metaLane('meta-lane-3', 0.1, 24)],
  });
  await d.setup();
  await d.tick();
  const out = await d.hook('rev-keep');
  assert.equal(out.kind, 'keep');
  await d.tick();
  const cap = (await d.api('capacity')).body;
  assert.equal(cap.reviewer.routing.last.routed, false);
  assert.equal(cap.reviewer.routing.last.fallback, 'keep');
  assert.equal(cap.reviewer.routing.preview.routed, false);
  // Role exclusions apply: the reviewer's role excluding muse refuses Meta.
  const ex = drive({
    config: { ...BASE, roles: { keepAgentIds: ['reviewer-1'], excludeFamilies: { doer: ['muse'] } }, reviewerRouting: { arms: [ARMS[1]] } },
    accounts: [metaLane('meta-lane-3', 0.1, 24)],
  });
  await ex.setup();
  await ex.tick();
  assert.equal((await ex.hook('rev-ex')).kind, 'keep');
});

// ---------- 3. regression: absent reviewerRouting ----------

test('absent reviewerRouting: the pinned reviewer keeps, exactly as before', async () => {
  const d = drive({
    config: { enforce: true, roles: { keepAgentIds: ['reviewer-1'] } },
    accounts: [claudeLane(0.5, 24), metaLane('meta-lane-3', 0.1, 24)],
  });
  await d.setup();
  await d.tick();
  const out = await d.hook('rev-plain');
  assert.deepEqual(out, { kind: 'keep' });
  await d.tick();
  const cap = (await d.api('capacity')).body;
  assert.equal(cap.reviewer.routing.enabled, false);
  assert.deepEqual(cap.reviewer.providers, ['claude']);
  assert.deepEqual(cap.reviewer.qualifiedAccountIds, ['claude:a1']);
  // Non-review agents are untouched by a reviewerRouting config.
  const r = drive({
    config: { ...BASE, reviewerRouting: { arms: ARMS } },
    accounts: [claudeLane(0.5, 24), metaLane('meta-lane-3', 0.1, 24)],
  });
  await r.setup();
  await r.tick();
  const doer = await r.hook('doer-1', { agentId: 'agent-9', adapterType: 'claude-code' });
  assert.notEqual(doer.reason ?? '', '');
  assert.doesNotMatch(doer.reason ?? '', /reviewer routing/);
});

test('select: burn mode never ranks credit-funded headroom above plan headroom', () => {
  const r = selectReviewerRoute({
    cfg: CFG, burnTokens: new Set(['claude:a1']),
    accounts: [view('claude:a1', { creditFallback: true }), view('meta:m3', { planAhead: 0.2 })],
  });
  assert.equal(r.accountId, 'meta:m3');
  assert.equal(r.burn, false);
});

test('hook: reviewer routing obeys the pace guard (skip held lanes, defer when only held lanes serve)', async () => {
  const started = (d, runId, provider, model) => d.fire({ type: 'agent.run.started', companyId: 'acme', entityId: runId,
    payload: { run: { agentId: 'reviewer-1', provider, model } }, occurredAt: new Date(TICK).toISOString() });
  // Claude 90% spent with 48h left: far ahead of plan, so its pace cap is 1.
  const held = drive({
    config: { ...BASE, reviewerRouting: { arms: [ARMS[0]] } },
    accounts: [claudeLane(0.9, 48)],
  });
  await held.setup();
  await held.tick();
  const first = await held.hook('rev-a');
  assert.equal(first.kind, 'decide');
  assert.match(first.reason, /on claude:a1/);
  await started(held, 'rev-a', 'claude', 'claude-opus-5-5');
  // The first run fills the cap: the next review waits instead of keeping
  // its pinned model on the held lane.
  const second = await held.hook('rev-b');
  assert.equal(second.kind, 'defer');
  assert.match(second.reason, /pace guard: reviewer lanes held/);
  await held.tick();
  assert.equal((await held.api('capacity')).body.reviewer.routing.last.deferred, true);

  // Both lanes ahead of plan, Claude less ahead: the first review takes
  // Claude, filling its pace cap of 1, and the next review skips the held
  // Claude lane for Meta (without the pace guard it would stay on Claude).
  const mixed = drive({
    config: { ...BASE, reviewerRouting: { arms: ARMS } },
    accounts: [claudeLane(0.9, 48), metaLane('meta-lane-3', 0.9, 72)],
  });
  await mixed.setup();
  await mixed.tick();
  const a = await mixed.hook('rev-1');
  assert.equal(a.kind, 'decide');
  assert.match(a.reason, /on claude:a1/);
  await started(mixed, 'rev-1', 'claude', a.model);
  const b = await mixed.hook('rev-2');
  assert.equal(b.kind, 'decide');
  assert.match(b.reason, /on meta:meta-lane-3/, 'the full Claude lane is skipped');

  // Holds present but no arm can serve: the run keeps its pinned model
  // instead of deferring on the pace retry scale. The unfiltered recheck
  // pins this: without it the held lane alone would trigger a defer, yet
  // releasing the hold could never make an unservable arm servable.
  const unservableCfg = { ...BASE, reviewerRouting: { arms: [ARMS[0]] } };
  const unservable = drive({
    config: unservableCfg,
    accounts: [claudeLane(0.9, 48), metaLane('meta-lane-3', 0.1, 24)],
  });
  await unservable.setup();
  await unservable.tick();
  const u1 = await unservable.hook('rev-u1');
  assert.equal(u1.kind, 'decide');
  assert.match(u1.reason, /on claude:a1/);
  await started(unservable, 'rev-u1', 'claude', u1.model);
  // Swap to a Meta-only arm for a model no lane serves; the Claude hold
  // is still present (rev-u1 fills its cap of 1). The next tick rebuilds
  // the live view from this same config object, keeping the ledger.
  unservableCfg.reviewerRouting = { arms: [{ provider: 'meta', model: 'muse-not-served', effort: 'max' }] };
  await unservable.tick();
  const u2 = await unservable.hook('rev-u2');
  assert.equal(u2.kind, 'keep');
  await unservable.tick();
  const ulast = (await unservable.api('capacity')).body.reviewer.routing.last;
  assert.equal(ulast.routed, false);
  assert.equal(ulast.fallback, 'keep');
  assert.equal(ulast.deferred ?? false, false);
});


test('role-empty reviewer routes and receives its soft-capped slot without reopening another pinned role', async () => {
  const d = drive({
    config: { ...BASE, roles: { keepAgentIds: ['reviewer-1', 'other-pin'] },
      reviewerRouting: { agentIds: ['reviewer-1'], arms: [ARMS[0]] } },
    accounts: [claudeLane(0.85, 120)],
    heartbeats: [{ agentId: 'reviewer-1', queued: 1 }, { agentId: 'other-pin', queued: 1 }],
  });
  await d.setup();
  await d.tick();
  const capacity = (await d.api('capacity')).body;
  assert.deepEqual(capacity.paceGuard.rawPools[0].hardHeldAccountIds, ['claude:a1']);
  assert.ok(capacity.paceGuard.roleSafety.some(r => r.accountIds.includes('claude:a1')));
  const route = await d.hook('reviewer-run');
  assert.equal(route.kind, 'decide');
  assert.match(route.reason, /claude:a1/);
  // Supply calibrated sizing; admission and pace verdicts come from the real tick.
  d.updateCapacity(cap => {
    cap.target = 2; cap.calibration = 'measured'; cap.perAccount[0].slots = 2;
    cap.keptByAgent['other-pin'] = { accountId: 'claude:a1' };
  });
  const caps = (await d.api('caps')).body;
  assert.equal(caps.agents.find(a => a.agentId === 'reviewer-1')?.allocated, 1, JSON.stringify(caps));
  assert.equal(caps.agents.find(a => a.agentId === 'other-pin')?.allocated, 0, JSON.stringify(caps));
});

for (const blockingPriority of [false, true]) {
  test(`caps: an idle reviewer's role-local hold exception cannot fund a disjoint peer (priority=${blockingPriority})`, async () => {
    const x = claudeLane(0.85, 120.5, { models: ['claude-opus-5-5'] });
    const y = claudeLane(0.895, 24.5, { lane: 'claude-2', accountKey: 'a2', models: ['claude-haiku-5-5'] });
    const heartbeats = [{ agentId: 'reviewer-a', queued: 0 }, { agentId: 'reviewer-b', queued: 5 }];
    const issues = Array.from({ length: 5 }, (_, i) => ({ id: `peer-${i}`, assigneeAgentId: 'reviewer-b',
      status: 'todo', priority: 'medium', blockedBy: [] }));
    const d = drive({
      config: { enforce: true, concurrency: { maxTotal: 75, meanRunDurationHours: 0.8 },
        allocation: { blockingPriority },
        roles: { keepAgentIds: ['reviewer-a', 'reviewer-b'], thinkerAgentIds: ['reviewer-a'],
          doerAgentIds: ['reviewer-b'], thinkerFloorRung: 0,
          excludeFamilies: { thinker: ['haiku'], doer: ['opus'] } },
        reviewReserve: { agentIds: ['reviewer-a', 'reviewer-b'] },
        reviewerRouting: { agentIds: ['reviewer-a', 'reviewer-b'], arms: [ARMS[0],
          { provider: 'claude', model: 'claude-haiku-5-5', effort: 'max' }] } },
      accounts: [x, y], heartbeats, issues,
    });
    await d.setup();
    await d.tick();
    d.setNow(TICK + 0.5 * HOUR);
    d.setAccounts([{ ...x, observedAt: new Date(TICK + 0.5 * HOUR).toISOString() },
      { ...y, weekly: { ...y.weekly, used: 0.9 }, observedAt: new Date(TICK + 0.5 * HOUR).toISOString() }]);
    await d.tick();
    const capacity = (await d.api('capacity')).body;
    const aPace = capacity.reviewerPaceByAgent['reviewer-a'];
    const bPace = capacity.reviewerPaceByAgent['reviewer-b'];
    assert.deepEqual(capacity.reviewerAccountIdsByAgent['reviewer-a'], ['claude:a1']);
    assert.deepEqual(capacity.reviewerAccountIdsByAgent['reviewer-b'], ['claude:a2']);
    assert.deepEqual(aPace.holdSuspendedAccountIds, ['claude:a1']);
    assert.deepEqual(bPace.holdSuspendedAccountIds, []);
    // Y's measured 0.01/h corrects its 20/3 C* slots to 25/9 (cap 3).
    // Restoring X adds 7/15 slots, so only A has a local pool cap of 4.
    assert.deepEqual(capacity.paceGuard.rawPools.find(p => p.pool === 'claude')?.hardHeldAccountIds, ['claude:a1']);
    assert.deepEqual({ raw: capacity.paceGuard.rawPools.find(p => p.pool === 'claude')?.cap,
      a: aPace.pools.find(p => p.pool === 'claude')?.cap, b: bPace.pools.find(p => p.pool === 'claude')?.cap },
    { raw: 3, a: 4, b: 3 });
    assert.ok(capacity.perAccount.find(a => a.accountId === 'claude:a2').slots > 3);
    d.updateCapacity(cap => { cap.target = 10; cap.calibration = 'measured'; });
    const caps = (await d.api('caps')).body;
    assert.equal(caps.allocation?.blockingPriority ?? false, blockingPriority);
    const peer = caps.agents.find(a => a.agentId === 'reviewer-b');
    assert.equal(peer.running, 0);
    assert.equal(peer.queued, 5);
    assert.equal(peer.allocated, 3,
      'the unexempt peer retains its own cap even while the exempt reviewer is idle');
  });
}

test('ready policy-only reviewers remain raw pool members with credential readiness enforced', async () => {
  const d = drive({
    config: { ...BASE, credentialReadiness: { enforce: true }, taskRanking: { mode: 'enforce' },
      reviewerRouting: { agentIds: ['reviewer-1'], arms: [ARMS[1]] } },
    accounts: [metaLane('review', 0.85, 120), claudeLane(0.1, 120)],
    heartbeats: [{ agentId: 'reviewer-1', queued: 1 }],
  });
  await d.setup();
  await d.tick();
  const capacity = (await d.api('capacity')).body;
  const raw = capacity.paceGuard.rawPools.find(p => p.pool === 'meta');
  assert.deepEqual({ lanes: raw?.lanes, cap: raw?.cap, hardHeld: raw?.hardHeldAccountIds },
    { lanes: 1, cap: 0, hardHeld: ['meta:review'] });
  assert.deepEqual(capacity.reviewerPaceByAgent['reviewer-1'].holdSuspendedAccountIds, []);
  assert.equal((await d.hook('ready-policy-review-held')).kind, 'defer');
  d.updateCapacity(cap => { cap.target = 2; cap.calibration = 'measured'; });
  assert.equal((await d.api('caps')).body.agents.find(a => a.agentId === 'reviewer-1')?.allocated, 0);
});

test('policy-only reviewer hard hold is retained in global pools and denies queued caps', async () => {
  const d = drive({
    config: { ...BASE, taskRanking: { mode: 'enforce' },
      reviewerRouting: { agentIds: ['reviewer-1'], arms: [ARMS[1]] } },
    accounts: [metaLane('review', 0.85, 120), claudeLane(0.1, 120)],
    heartbeats: [{ agentId: 'reviewer-1', queued: 1 }],
  });
  await d.setup();
  await d.tick();
  const capacity = (await d.api('capacity')).body;
  const reviewerPace = capacity.reviewerPaceByAgent['reviewer-1'];
  assert.deepEqual(reviewerPace.holdSuspendedAccountIds, []);
  assert.deepEqual(reviewerPace.pools.find(p => p.pool === 'meta')?.hardHeldAccountIds, ['meta:review']);
  assert.equal((await d.hook('review-held')).kind, 'defer');
  d.updateCapacity(cap => {
    cap.target = 2; cap.calibration = 'measured';
    cap.perAccount.find(a => a.accountId === 'meta:review').slots = 2;
  });
  const caps = (await d.api('caps')).body;
  assert.equal(caps.agents.find(a => a.agentId === 'reviewer-1')?.allocated, 0, JSON.stringify(caps));
  assert.deepEqual(capacity.paceGuard.rawPools.find(p => p.pool === 'meta')?.hardHeldAccountIds, ['meta:review']);
});
