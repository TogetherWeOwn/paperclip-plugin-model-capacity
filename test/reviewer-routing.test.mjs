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

function drive({ config = {}, accounts, heartbeats = [], issues = [], rows = aaRows(), onReviewerAdmission = null }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const warnings = [];
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
    logger: { info() {}, error() {}, warn(message, details) { warnings.push({ message, details }); } },
  };
  const liveViews = new Map();
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false, liveViews, onReviewerAdmission });
  return {
    setNow: ms => { now = ms; },
    setAccounts: list => { laneAccounts = list; },
    warnings, liveViews,
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows, duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: () => jobs.get('quota-refresh')({ companyId: 'acme' }),
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

async function occupiedReviewerAlternative({ enforceReadiness = false } = {}) {
  // The alternative is configured and admitted, but its ordinary soft-cap slot is occupied.
  const d = drive({
    config: { ...BASE, credentialReadiness: { enforce: enforceReadiness }, taskRanking: { mode: 'enforce' },
      concurrency: { maxTotal: 75, meanRunDurationHours: 0.2 },
      roles: { keepAgentIds: ['reviewer-1', 'busy-pin'] },
      reviewerRouting: { agentIds: ['reviewer-1'], arms: [ARMS[1], ARMS[0]] } },
    accounts: [metaLane('review', 0.85, 120), claudeLane(0.58, 84)],
    heartbeats: [{ agentId: 'reviewer-1', queued: 1 }, { agentId: 'busy-pin', running: 1, queued: 0 }],
  });
  await d.setup();
  await d.tick();
  await d.fire({ type: 'agent.run.started', companyId: 'acme', entityId: 'occupied-review-alternative',
    payload: { run: { agentId: 'busy-pin', provider: 'claude', model: 'claude-opus-5-5' } },
    occurredAt: new Date(TICK).toISOString() });
  await d.tick();
  const capacity = (await d.api('capacity')).body;
  assert.deepEqual([...capacity.reviewerAccountIdsByAgent['reviewer-1']].sort(), ['claude:a1', 'meta:review']);
  const pool = capacity.reviewerPaceByAgent['reviewer-1'].pools.find(p => p.pool === 'claude');
  assert.deepEqual({ cap: pool.cap, inFlight: pool.inFlight }, { cap: 1, inFlight: 1 });
  d.updateCapacity(cap => { cap.keptByAgent['busy-pin'] = { accountId: 'claude:a1' }; });
  return d;
}

test('ready policy-only reviewers remain raw pool members with credential readiness enforced', async () => {
  const d = await occupiedReviewerAlternative({ enforceReadiness: true });
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
  const d = await occupiedReviewerAlternative();
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

async function policyReviewerSafetyFixture({ accounts = [metaLane('review', 0.85, 120)], arms = [ARMS[1]], excludeFamilies = {} } = {}) {
  const d = drive({
    config: { ...BASE, credentialReadiness: { enforce: true }, taskRanking: { mode: 'enforce' },
      roles: { keepAgentIds: ['reviewer-1', 'other-pin'], excludeFamilies },
      reviewerRouting: { agentIds: ['reviewer-1'], arms } },
    accounts, heartbeats: [{ agentId: 'reviewer-1', queued: 1 }, { agentId: 'other-pin', queued: 1 }],
  });
  await d.setup();
  await d.tick();
  return d;
}

for (const ordinaryAlternative of [false, true]) {
  test(`policy reviewer safety: admitted policy-only lane keeps its local soft-cap slot (ordinaryAlternative=${ordinaryAlternative})`, async t => {
    const d = await policyReviewerSafetyFixture({ accounts: [metaLane('review', 0.85, 120),
      ...(ordinaryAlternative ? [claudeLane(0.1, 120)] : [])] });
    const capacity = (await d.api('capacity')).body;
    const raw = capacity.paceGuard.rawPools.find(p => p.pool === 'meta');
    const local = capacity.reviewerPaceByAgent['reviewer-1'];
    const pool = local.pools.find(p => p.pool === 'meta');
    const ladder = (await d.api('ladder')).body.ladders['meta:review'];
    assert.deepEqual(capacity.reviewerAccountIdsByAgent['reviewer-1'], ['meta:review']);
    assert.equal(ladder.rungs.length, 0, 'the reviewer is served by an approved policy arm, not an ordinary ladder');
    assert.ok(ladder.policyReviewerArms.some(a => a.model === WONDER && a.effort === 'max'
      && a.credentialEvidence?.readyCredentials === 1));
    assert.ok(Math.abs(capacity.accounts.find(a => a.accountId === 'meta:review').planAhead - 0.5642857142857143) < 1e-10);
    assert.deepEqual({ cap: raw.cap, held: raw.hardHeldAccountIds }, { cap: 0, held: ['meta:review'] });
    assert.equal(capacity.inFlightByPool.meta ?? 0, 0);
    // Calibrate only quota sizing and the exact fixed binding, never admission or pace facts.
    d.updateCapacity(cap => {
      cap.target = 2; cap.calibration = 'measured';
      cap.perAccount.find(a => a.accountId === 'meta:review').slots = 2;
      cap.keptByAgent['other-pin'] = { accountId: 'meta:review' };
    });
    const caps = (await d.api('caps')).body;
    const runIds = [`policy-safety-${ordinaryAlternative}-first`, `policy-safety-${ordinaryAlternative}-second`];
    const decisions = [];
    for (const runId of runIds) decisions.push(await d.hook(runId));
    await d.tick();
    const entries = (await d.api('shadow')).body.entries;
    const admittedAccounts = runIds.flatMap((runId, i) => decisions[i].kind === 'decide'
      ? [entries.find(e => e.runId === runId)?.accountId] : []);
    const actual = { suspended: local.holdSuspendedAccountIds, cap: pool?.cap,
      reviewerGrant: caps.agents.find(a => a.agentId === 'reviewer-1')?.allocated,
      fixedGrant: caps.agents.find(a => a.agentId === 'other-pin')?.allocated,
      hooks: decisions.map(d => d.kind), admittedAccounts };
    t.diagnostic(JSON.stringify(actual));
    assert.deepEqual(actual, { suspended: ['meta:review'], cap: 1, reviewerGrant: 1, fixedGrant: 0,
      hooks: ['decide', 'defer'], admittedAccounts: ['meta:review'] },
    'an actually admitted policy-only reviewer has role-empty safety, not an unrestricted grant or a global hold release');
  });
}

test('policy reviewer safety: a behind-plan admitted configured alternative retains the Meta hold', async () => {
  const d = await policyReviewerSafetyFixture({ accounts: [metaLane('review', 0.85, 120), claudeLane(0.1, 120)],
    arms: [ARMS[1], ARMS[0]] });
  const capacity = (await d.api('capacity')).body;
  assert.deepEqual([...capacity.reviewerAccountIdsByAgent['reviewer-1']].sort(), ['claude:a1', 'meta:review']);
  const local = capacity.reviewerPaceByAgent['reviewer-1'];
  assert.deepEqual(local.holdSuspendedAccountIds, []);
  assert.equal(local.pools.find(p => p.pool === 'meta').cap, 0);
  assert.deepEqual(capacity.paceGuard.rawPools.find(p => p.pool === 'meta').hardHeldAccountIds, ['meta:review']);
  assert.ok(capacity.accounts.find(a => a.accountId === 'claude:a1').planAhead < 0);
  const route = await d.hook('approved-review-alternative');
  assert.deepEqual({ kind: route.kind, model: route.model }, { kind: 'decide', model: 'claude-opus-5-5' });
  await d.tick();
  assert.equal((await d.api('shadow')).body.entries.find(e => e.runId === 'approved-review-alternative')?.accountId, 'claude:a1');
});

for (const refusal of ['unready', 'manual-exclusion']) {
  test(`policy reviewer safety: role-empty safety cannot revive ${refusal} policy arms`, async () => {
    const d = await policyReviewerSafetyFixture({
      accounts: [metaLane('review', 0.85, 120, refusal === 'unready'
        ? { credentialAvailability: { version: 1, models: [] } } : {})],
      excludeFamilies: refusal === 'manual-exclusion' ? { doer: ['muse'] } : {},
    });
    const capacity = (await d.api('capacity')).body;
    assert.deepEqual(capacity.reviewerAccountIdsByAgent['reviewer-1'], []);
    assert.deepEqual(capacity.reviewerPaceByAgent['reviewer-1'].holdSuspendedAccountIds, []);
    assert.equal((await d.hook(`refused-policy-${refusal}`)).kind, 'defer');
  });
}

for (const includeDeniedAlternative of [false, true]) {
  test(`policy reviewer safety: a denied trial alternative cannot remove local safety (configured=${includeDeniedAlternative})`, async t => {
    const admissions = [];
    const trialModel = 'devin/swe-2';
    const d = drive({
      config: { ...BASE, credentialReadiness: { enforce: false }, taskRanking: { mode: 'enforce' },
        roles: { keepAgentIds: ['reviewer-1', 'other-pin'] },
        trials: { roles: [], unscoredServedIds: [{ servedId: trialModel, reason: 'test' }] },
        placement: { freeCostServedIds: { [trialModel]: { until: '2026-12-01T00:00:00Z', reason: 'test' } } },
        reviewerRouting: { agentIds: ['reviewer-1'], arms: [ARMS[1], ...(includeDeniedAlternative
          ? [{ provider: 'devin', model: trialModel, effort: 'max' }] : [])] } },
      accounts: [metaLane('review', 0.85, 120), { provider: 'devin', accountKey: 'd', models: [trialModel],
        health: 'healthy', meter: 'reactive', quality: 'reactive' }],
      heartbeats: [{ agentId: 'reviewer-1', queued: 1 }, { agentId: 'other-pin', queued: 1 }],
      onReviewerAdmission: event => admissions.push(event),
    });
    await d.setup();
    await d.tick();
    const capacity = (await d.api('capacity')).body;
    const policy = (await d.api('ladder')).body.ladders['devin:d'].policyReviewerArms;
    assert.equal(policy.some(arm => arm.model === trialModel && arm.effort === 'max'), includeDeniedAlternative);
    if (includeDeniedAlternative) {
      // The observer reports structural checks before final trial gates; the
      // published admission list below is the final verdict.
      const checked = admissions.filter(event => event.arm.model === trialModel);
      assert.ok(checked.some(event => event.result.ok === true && event.result.model === trialModel),
        'the configured policy model passes structural servability, before final unscored/trial admission');
    }
    assert.deepEqual(capacity.reviewerAccountIdsByAgent['reviewer-1'], ['meta:review']);
    const local = capacity.reviewerPaceByAgent['reviewer-1'];
    const meta = local.pools.find(pool => pool.pool === 'meta');
    const raw = capacity.paceGuard.rawPools.find(pool => pool.pool === 'meta');
    assert.deepEqual({ cap: raw.cap, held: raw.hardHeldAccountIds }, { cap: 0, held: ['meta:review'] });
    // Supply only sizing and a fixed binding; actual admissions and pace verdicts stay intact.
    d.updateCapacity(cap => {
      cap.target = 2; cap.calibration = 'measured';
      cap.perAccount.find(account => account.accountId === 'meta:review').slots = 2;
      cap.keptByAgent['other-pin'] = { accountId: 'meta:review' };
    });
    const caps = (await d.api('caps')).body;
    const runIds = [`denied-trial-${includeDeniedAlternative}-first`, `denied-trial-${includeDeniedAlternative}-second`];
    const decisions = [];
    for (const runId of runIds) decisions.push(await d.hook(runId));
    await d.tick();
    const entries = (await d.api('shadow')).body.entries;
    const selected = decisions.flatMap((decision, index) => decision.kind === 'decide' ? [{ model: decision.model,
      effort: decision.effort, accountId: entries.find(entry => entry.runId === runIds[index])?.accountId }] : []);
    const actual = { suspended: local.holdSuspendedAccountIds, cap: meta.cap,
      reviewerGrant: caps.agents.find(agent => agent.agentId === 'reviewer-1')?.allocated,
      fixedGrant: caps.agents.find(agent => agent.agentId === 'other-pin')?.allocated,
      hooks: decisions.map(decision => decision.kind), selected };
    t.diagnostic(JSON.stringify(actual));
    assert.deepEqual(actual, { suspended: ['meta:review'], cap: 1, reviewerGrant: 1, fixedGrant: 0,
      hooks: ['decide', 'defer'], selected: [{ model: WONDER, effort: 'max', accountId: 'meta:review' }] },
    'a non-admitted unscored policy record is not a usable alternative to the sole admitted reviewer');
  });
}

test('N-T16: kept default superseded on every serving account defers', async () => {
  const old = 'claude-sonnet-5', newer = 'claude-sonnet-5-5';
  const d = drive({ config: { ...BASE, roles: { ...BASE.roles, newestVersionOnly: { enabled: true } } },
    accounts: [claudeLane(0.5, 24, { models: [old, newer] })] });
  await d.setup(); await d.tick();
  const out = await d.hook('superseded-default', { agentDefaultModel: old });
  assert.equal(out.kind, 'defer');
  assert.match(out.reason, /superseded-version/);
});

test('N-T16: inferred serving universe blocks superseded default while explicit empty serves nowhere', async () => {
  const old = 'claude-sonnet-5', newer = 'claude-sonnet-5-5';
  const armMap = [old, newer].map(model => ({ aaSlug: model, model, effort: 'high', family: 'claude', providers: ['claude'] }));
  const rows = armMap.map(({ aaSlug }) => ({ slug: aaSlug, intelligenceIndex: 70, intelligenceIndexCostPerTask: 2 }));
  for (const [models, expectedSource, expectedKind] of [
    [undefined, 'inferred-provider-arms', 'defer'],
    [[], 'account-models', 'keep'],
  ]) {
    const d = drive({ rows, config: { ...BASE, armMap, roles: { ...BASE.roles, newestVersionOnly: { enabled: true } } },
      accounts: [claudeLane(0.5, 24, { models })] });
    await d.setup(); await d.tick();
    const view = d.liveViews.get('acme').accounts[0].newestVersion;
    assert.equal(view.universeSource, expectedSource);
    assert.equal(Object.hasOwn(view.identities, old), models === undefined);
    const out = await d.hook(`universe-${expectedSource}`, { agentDefaultModel: old });
    assert.equal(out.kind, expectedKind);
    if (expectedKind === 'defer') assert.match(out.reason, /superseded-version/);
  }
});

test('N-T14: unscored superseded listed reviewer model cannot route', async () => {
  const old = 'claude-sonnet-5', newer = 'claude-sonnet-5-5';
  const d = drive({ config: { ...BASE, roles: { ...BASE.roles, newestVersionOnly: { enabled: true } },
    reviewerRouting: { arms: [{ provider: 'claude', model: old, effort: 'high' }] } },
    accounts: [claudeLane(0.5, 24, { models: [old, newer] })] });
  await d.setup(); await d.tick();
  const out = await d.hook('old-reviewer');
  assert.notEqual(out.kind, 'decide');
  const capacity = (await d.api('capacity')).body;
  assert.equal(capacity.reviewer.routing.preview.routed, false);
});

test('N-T14b: listed old reviewer arm honors only its own keep', async () => {
  const old = 'claude-sonnet-5', newer = 'claude-sonnet-5-5';
  for (const [keep, effort, accepted] of [
    ['claude-sonnet-5@max', 'max', true],
    ['claude-sonnet-5@max', 'high', false],
    ['model:claude-sonnet-5', 'high', true],
    ['product:claude-sonnet', 'high', true],
  ]) {
    const d = drive({ config: { ...BASE, roles: { ...BASE.roles, newestVersionOnly: { enabled: true, overrides: { keep: [keep] } } },
      reviewerRouting: { arms: [{ provider: 'claude', model: old, effort }] } },
      accounts: [claudeLane(0.5, 24, { models: [old, newer] })] });
    await d.setup(); await d.tick();
    const out = await d.hook(`keep-${keep}-${effort}`);
    assert.equal(out.kind === 'decide', accepted, `${keep} ${effort}`);
    const capacity = (await d.api('capacity')).body;
    assert.equal(capacity.reviewer.routing.preview.routed, accepted, `${keep} ${effort} preview`);
  }
});

test('N-T16: old-only and unserved defaults stay unchanged', async () => {
  const old = 'claude-sonnet-5';
  for (const models of [[old], ['claude-opus-5-5']]) {
    const d = drive({ config: { ...BASE, roles: { ...BASE.roles, newestVersionOnly: { enabled: true } } },
      accounts: [claudeLane(0.5, 24, { models })] });
    await d.setup(); await d.tick();
    assert.equal((await d.hook('allowed-default', { agentDefaultModel: old })).kind, 'keep');
  }
});

test('N-T14b(d): requested high is refused despite ready kept max on both consumers', async () => {
  const old = 'claude-sonnet-5', newer = 'claude-sonnet-5-5';
  const armMap = [
    { aaSlug: 'claude-sonnet-5-max', model: old, effort: 'max', family: 'claude', providers: ['claude'] },
    { aaSlug: 'claude-sonnet-5-high', model: old, effort: 'high', family: 'claude', providers: ['claude'] },
  ];
  const rows = armMap.map((a, i) => ({ slug: a.aaSlug, intelligenceIndex: 80 - i * 10, intelligenceIndexCostPerTask: 2 + i }));
  for (const mode of ['shadow', 'enforce']) {
    const admissions = [];
    const d = drive({ rows, onReviewerAdmission: event => admissions.push(event),
      config: { ...BASE, armMap, credentialReadiness: { enforce: true }, taskRanking: { mode },
        roles: { ...BASE.roles, newestVersionOnly: { enabled: true, overrides: { keep: [`${old}@max`] } } },
        reviewerRouting: { arms: [{ provider: 'claude', model: old, effort: 'high' },
          { provider: 'claude', model: old, effort: 'max' }] } },
      accounts: [claudeLane(0.5, 24, { models: [old, newer] })] });
    await d.setup(); await d.tick();
    function check(consumer) {
      const high = admissions.find(e => e.consumer === consumer && e.arm.effort === 'high');
      const max = admissions.find(e => e.consumer === consumer && e.arm.effort === 'max');
      assert.ok(high, `${mode} ${consumer} high admission`);
      assert.match(high.result.ok, /^superseded-version:/);
      assert.deepEqual(high.readyArms.map(a => [a.model, a.effort]), [[old, 'max']]);
      assert.ok(high.ladderArms.some(a => a.model === old && a.effort === 'max'));
      assert.ok(high.ladderArms.every(a => a.model === old && a.effort === 'max'));
      assert.equal(max?.result.ok, true, `${mode} ${consumer} max control`);
    }
    check('capacity');
    admissions.length = 0;
    const out = await d.hook(`sibling-${mode}`);
    assert.equal(out.kind, 'decide');
    assert.equal(out.effort, 'max');
    check('route');
    const preview = (await d.api('capacity')).body.reviewer.routing.preview;
    assert.equal(preview.arm.effort, 'max');
  }
});

test('N-T14b(f): unscored unkept requested identity reports supersession to both consumers', async () => {
  const old = 'claude-sonnet-5', newer = 'claude-sonnet-5-5';
  const admissions = [];
  const d = drive({ rows: [], onReviewerAdmission: event => admissions.push(event),
    config: { ...BASE, armMap: [], roles: { ...BASE.roles, newestVersionOnly: { enabled: true } },
      reviewerRouting: { arms: [{ provider: 'claude', model: old, effort: 'high' }] } },
    accounts: [claudeLane(0.5, 24, { models: [old, newer] })] });
  await d.setup(); await d.tick();
  assert.match(admissions.find(e => e.consumer === 'capacity')?.result.ok, /^superseded-version:/);
  admissions.length = 0;
  assert.notEqual((await d.hook('unkept-constructed')).kind, 'decide');
  assert.match(admissions.find(e => e.consumer === 'route')?.result.ok, /^superseded-version:/);
});

test('N-T15: policy arm is dropped with warning unless its own dialect is kept', async () => {
  const old = 'claude-sonnet-5', newer = 'claude-sonnet-5-5';
  const armMap = [{ aaSlug: 'claude-sonnet-5-high', model: old, effort: 'high', family: 'claude', providers: ['claude'] }];
  for (const keep of [null, 'arm:claude-sonnet-5-high', 'claude-sonnet-5@high']) {
    const d = drive({ config: { ...BASE, armMap, taskRanking: { mode: 'enforce' },
      roles: { ...BASE.roles, newestVersionOnly: { enabled: true, overrides: { keep: keep ? [keep] : [] } } },
      reviewerRouting: { arms: [{ provider: 'claude', model: old, effort: 'high' }] } },
      accounts: [claudeLane(0.5, 24, { models: [old, newer] })] });
    await d.setup(); await d.tick();
    const policy = (await d.api('ladder')).body.ladders['claude:a1'].policyReviewerArms;
    assert.equal(policy.some(a => a.model === old && a.effort === 'high'), keep != null, `${keep}`);
    assert.equal(d.warnings.some(w => w.message.includes('newest-version-policy-arm-superseded')), keep == null, `${keep}`);
    assert.equal((await d.hook(`policy-${keep}`)).kind === 'decide', keep != null, `${keep}`);
  }
});

test('N-T16: superseded scored and unscored capped defaults never run', async () => {
  const old = 'gpt-6-sol', newer = 'gpt-6.1-sol';
  for (const scored of [true, false]) {
    const rows = scored ? [{ slug: old, intelligenceIndex: 70, intelligenceIndexCostPerTask: 2 }] : [];
    const armMap = [{ aaSlug: old, model: old, effort: 'max', family: 'sol', providers: ['codex'] }];
    const d = drive({ rows, config: { ...BASE, armMap, roles: { ...BASE.roles, newestVersionOnly: { enabled: true } } },
      accounts: [claudeLane(0.5, 24, { provider: 'codex', accountKey: 'a1', models: [old, newer] })] });
    await d.setup(); await d.tick();
    const out = await d.hook(`capped-${scored}`, { agentDefaultModel: old });
    assert.equal(out.kind, 'defer', `${scored}`);
    assert.match(out.reason, /superseded-version/);
  }
});

test('N-T16: one non-superseding serving account keeps the default', async () => {
  const old = 'claude-sonnet-5', newer = 'claude-sonnet-5-5';
  const d = drive({ config: { ...BASE, roles: { ...BASE.roles, newestVersionOnly: { enabled: true } } },
    accounts: [claudeLane(0.5, 24, { accountKey: 'a1', models: [old, newer] }),
      claudeLane(0.5, 24, { accountKey: 'a2', models: [old] })] });
  await d.setup(); await d.tick();
  assert.equal((await d.hook('mixed-serving', { agentDefaultModel: old })).kind, 'keep');
});

test('N-T14: old-only account admits reviewer independently of a newer account', async () => {
  const old = 'claude-sonnet-5', newer = 'claude-sonnet-5-5';
  const d = drive({ config: { ...BASE, roles: { ...BASE.roles, newestVersionOnly: { enabled: true } },
    reviewerRouting: { arms: [{ provider: 'claude', model: old, effort: 'high' }] } },
    accounts: [claudeLane(0.5, 24, { accountKey: 'a1', models: [old, newer] }),
      claudeLane(0.5, 24, { accountKey: 'a2', models: [old] })] });
  await d.setup(); await d.tick();
  const out = await d.hook('old-only-reviewer');
  assert.equal(out.kind, 'decide');
  const preview = (await d.api('capacity')).body.reviewer.routing.preview;
  assert.equal(preview.accountId, 'claude:a2');
});

test('N-T13: live default cap lookup filters stale superseded ladder arms and is neutral without a view', async () => {
  const old = 'gpt-6-sol', newer = 'gpt-6.1-sol';
  for (const enabled of [false, true]) {
    const d = drive({ config: { ...BASE, roles: { ...BASE.roles, newestVersionOnly: { enabled } } },
      accounts: [claudeLane(0.5, 24, { provider: 'codex', accountKey: 'a1', models: [old, newer] }),
        claudeLane(0.5, 24, { provider: 'codex', accountKey: 'a2', models: [old] })] });
    await d.setup(); await d.tick();
    const live = d.liveViews.get('acme');
    for (const [index, account] of live.accounts.entries()) {
      const arm = { armId: old, model: old, family: 'sol', effort: 'max', cap: { maxTokens: index ? 200000 : 100000 } };
      account.ladderRungs = [{ rung: 0, arms: [arm] }];
      account.credentialRanking = null;
    }
    const result = await d.hook(`cap-filter-${enabled}`, { agentDefaultModel: old });
    assert.equal(result.kind, 'decide');
    assert.equal(result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, enabled ? '200000' : '100000');
  }
});

test('N-T14b(a): legacy arm keep admits the old reviewer on hook and capacity', async () => {
  const old = 'claude-sonnet-5', newer = 'claude-sonnet-5-5';
  const armMap = [{ aaSlug: old, model: old, effort: 'max', family: 'claude', providers: ['claude'] }];
  const rows = [{ slug: old, intelligenceIndex: 70, intelligenceIndexCostPerTask: 2 }];
  const d = drive({ rows, config: { ...BASE, armMap,
    roles: { ...BASE.roles, newestVersionOnly: { enabled: true, overrides: { keep: [`arm:${old}`] } } },
    reviewerRouting: { arms: [{ provider: 'claude', model: old, effort: 'max' }] } },
    accounts: [claudeLane(0.5, 24, { models: [old, newer] })] });
  await d.setup(); await d.tick();
  assert.equal((await d.hook('legacy-reviewer')).kind, 'decide');
  const capacity = (await d.api('capacity')).body;
  assert.equal(capacity.reviewer.routing.preview.routed, true);
  assert.ok(capacity.reviewer.qualifiedAccountIds.includes('claude:a1'));
});

test('N-T14b(e): constructed unscored listed reviewer identity honors its own task keep', async () => {
  const old = 'claude-sonnet-5', newer = 'claude-sonnet-5-5';
  const d = drive({ rows: [], config: { ...BASE, armMap: [],
    roles: { ...BASE.roles, newestVersionOnly: { enabled: true, overrides: { keep: [`${old}@max`] } } },
    reviewerRouting: { arms: [{ provider: 'claude', model: old, effort: 'max' }] } },
    accounts: [claudeLane(0.5, 24, { models: [old, newer] })] });
  await d.setup(); await d.tick();
  const account = d.liveViews.get('acme').accounts.find(a => a.accountId === 'claude:a1');
  assert.equal(account.ladderRungs.flatMap(g => g.arms ?? []).filter(a => a.model === old).length, 0);
  const out = await d.hook('constructed-reviewer');
  assert.equal(out.kind, 'decide');
  assert.equal(out.effort, 'max');
  const capacity = (await d.api('capacity')).body;
  assert.equal(capacity.reviewer.routing.preview.routed, true);
  assert.ok(capacity.reviewer.qualifiedAccountIds.includes('claude:a1'));
});

test('N-T16: central keep guard rejects a default superseded while pinned accounting yields', async () => {
  const old = 'claude-sonnet-5', newer = 'claude-sonnet-5-5';
  const d = drive({ config: { ...BASE, roles: { ...BASE.roles, newestVersionOnly: { enabled: true } } },
    accounts: [claudeLane(0.5, 24, { models: [old, newer] })] });
  await d.setup(); await d.tick();
  const live = d.liveViews.get('acme');
  const account = live.accounts.find(a => a.accountId === 'claude:a1');
  const supersessionView = account.newestVersion;
  account.newestVersion = null;
  // Simulate the view changing while the pinned-decision accounting awaits.
  Object.defineProperty(live.keptByAgent, 'reviewer-1', { configurable: true, get() {
    queueMicrotask(() => { account.newestVersion = supersessionView; });
    return null;
  } });
  const out = await d.hook('keep-guard-race', { agentDefaultModel: old });
  assert.equal(out.kind, 'defer');
  assert.equal(out.reason, 'default model superseded-version');
});
