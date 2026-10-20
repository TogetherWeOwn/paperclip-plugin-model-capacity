import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCredits, usableCredit, DEFAULT_CREDITS, hasUsablePlanHeadroom,
  planConcurrencyRoles, gateCreditConcurrencyRoles,
} from '../src/credits.mjs';
import { parseLaneAccount, parseCredits } from '../src/cliproxy.mjs';
import { createModelCapacityPlugin, validateConfigShape } from '../src/plugin.mjs';
import { orderAccountsForRun } from '../src/select.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const T0 = Date.parse('2026-10-15T00:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const skey = stateKey => JSON.stringify({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey });

test('credits config defaults to the free Codex grant and rejects unknown keys', () => {
  assert.deepEqual(normalizeCredits(null).freeTypes, ['codex-credits']);
  assert.deepEqual(normalizeCredits({}).paidTypes, []);
  assert.deepEqual(normalizeCredits({ freeTypes: ['  X  ', 'x'] }).freeTypes, ['x']);
  assert.deepEqual(DEFAULT_CREDITS.freeTypes, ['codex-credits']);
});

test('plan headroom needs weekly quota unless the lane is reactive', () => {
  assert.equal(hasUsablePlanHeadroom({ reactive: false, remainingPct: null, headroomPct: 0.6 }), false);
  assert.equal(hasUsablePlanHeadroom({ reactive: false, remainingPct: 0.01, headroomPct: 0.6 }), false);
  assert.equal(hasUsablePlanHeadroom({ reactive: false, remainingPct: 0.02, headroomPct: 0.6 }), true);
  assert.equal(hasUsablePlanHeadroom({ reactive: false, remainingPct: 0.02, headroomPct: 0.2 }, 0.1), true);
  assert.equal(hasUsablePlanHeadroom({ reactive: false, remainingPct: 0.02, headroomPct: 0.2 }, 0.25), false);
  assert.equal(hasUsablePlanHeadroom({ reactive: true, remainingPct: null, headroomPct: null }), true);
  assert.equal(hasUsablePlanHeadroom({ reactive: true, guardActive: true }), false);
});

test('only usable, unheld plan slots suppress credit concurrency for their roles', () => {
  const usable = { accountId: 'meta:usable', usableSlots: 1, eligibleRoles: ['thinker'] };
  const lowHeadroom = { accountId: 'meta:low', usableSlots: 1, eligibleRoles: ['doer'] };
  const reactiveZero = { accountId: 'meta:reactive', usableSlots: 0, eligibleRoles: ['other'] };
  const held = { accountId: 'meta:held', usableSlots: 1, eligibleRoles: ['reviewer'] };
  const excluded = { accountId: 'meta:excluded', usableSlots: 1, eligibleRoles: ['excluded-role'] };
  const creditFallback = { accountId: 'meta:credit-fallback', usableSlots: 1, eligibleRoles: ['credit-role'] };
  const views = new Map([
    ['meta:usable', { remainingPct: 0.5, headroomPct: 0.4, health: 'healthy' }],
    ['meta:low', { remainingPct: 0.5, headroomPct: 0.02, health: 'healthy' }],
    ['meta:reactive', { reactive: true, health: 'healthy' }],
    ['meta:held', { remainingPct: 0.5, headroomPct: 0.4, health: 'healthy' }],
    ['meta:excluded', { remainingPct: 0.5, headroomPct: 0.4, health: 'healthy', action: 'excluded' }],
    ['meta:credit-fallback', { remainingPct: 0.5, headroomPct: 0.4, health: 'healthy', creditFallback: true }],
  ]);
  const roles = planConcurrencyRoles([usable, lowHeadroom, reactiveZero, held, excluded, creditFallback], views, ['meta:held']);
  assert.deepEqual([...roles], ['thinker'],
    'only the usable thinker lane suppresses credit roles; skipped rows have disjoint roles');
  const access = { 'codex:credit': {
    doer: { eligible: true }, thinker: { eligible: true }, other: { eligible: true },
    reviewer: { eligible: true }, 'excluded-role': { eligible: true }, 'credit-role': { eligible: true },
  } };
  const gated = gateCreditConcurrencyRoles(access, ['codex:credit'], roles);
  assert.equal(gated['codex:credit'].doer.eligible, true,
    'a plan lane eligible only for thinkers cannot suppress doer credits');
  assert.equal(gated['codex:credit'].thinker.eligible, false);
  assert.equal(gated['codex:credit'].other.eligible, true);
  assert.equal(gated['codex:credit'].reviewer.eligible, true);
  assert.equal(gated['codex:credit']['excluded-role'].eligible, true);
  assert.equal(gated['codex:credit']['credit-role'].eligible, true);
  assert.equal(access['codex:credit'].thinker.eligible, true, 'the helper does not mutate route eligibility');
});

test('credits priority defaults to fallback and validates the normal compatibility setting', () => {
  assert.equal(normalizeCredits(null).priority, 'fallback');
  assert.equal(normalizeCredits({ priority: 'normal' }).priority, 'normal');
  assert.deepEqual(validateConfigShape({ credits: { priority: 'fallback' } }), []);
  assert.deepEqual(validateConfigShape({ credits: { priority: 'normal' } }), []);
  assert.ok(validateConfigShape({ credits: { priority: 'first' } }).some(e => e.includes('credits.priority')));
});

test('credit-funded accounts are a fallback tier after plan headroom', () => {
  const plan = { accountId: 'meta:plan', health: 'healthy', headroomPct: 0.65, remainingPct: 0.7, targetShare: 1,
    measuredRatePerHour: 0.5, requiredRatePerHour: 1, placementQ: -1, resetAtMs: T0 + 1000 };
  const credits = { accountId: 'codex:credits', health: 'healthy', headroomPct: 0.9, targetShare: 1,
    measuredRatePerHour: 0.5, requiredRatePerHour: 1, placementQ: 10, creditFallback: true, resetAtMs: T0 + 2000 };
  const accounts = [plan, credits];
  assert.equal(orderAccountsForRun(accounts, { placement: { qualityWeight: 1, allowanceWeight: 0 }, creditPriority: 'fallback' })[0].accountId, 'meta:plan');
  assert.equal(orderAccountsForRun(accounts, { placement: { qualityWeight: 1, allowanceWeight: 0 } })[0].accountId, 'meta:plan',
    'callers without an explicit priority inherit the safe fallback default');
  assert.equal(orderAccountsForRun([{ ...plan, headroomPct: 0, remainingPct: 0 }, credits], {
    placement: { qualityWeight: 1, allowanceWeight: 0 }, creditPriority: 'fallback',
  })[0].accountId, 'codex:credits');
  assert.equal(orderAccountsForRun([{ ...plan, remainingPct: null }, credits], {
    placement: { qualityWeight: 1, allowanceWeight: 0 }, creditPriority: 'fallback',
  })[0].accountId, 'codex:credits', 'unknown weekly usage is not usable plan capacity');
  assert.equal(orderAccountsForRun([{ ...plan, guardActive: true }, credits], {
    placement: { qualityWeight: 1, allowanceWeight: 0 }, creditPriority: 'fallback',
  })[0].accountId, 'codex:credits', 'guarded plan capacity does not block credit fallback');
  assert.equal(orderAccountsForRun(accounts, { placement: { qualityWeight: 1, allowanceWeight: 0 }, creditPriority: 'normal' })[0].accountId, 'codex:credits');
  assert.equal(orderAccountsForRun([{ ...plan, roleEligible: false }, credits], {
    placement: { qualityWeight: 1, allowanceWeight: 0 }, creditPriority: 'fallback',
  })[0].accountId, 'codex:credits', 'role-ineligible plan capacity does not block the credit lane');
});

test('usage parser keeps credits provenance: unknown or empty is never capacity', () => {
  const base = { provider: 'codex', lane: 'a', observedAt: new Date(T0).toISOString() };
  assert.equal(parseLaneAccount(base, T0).credits, null);
  assert.equal(parseLaneAccount({ ...base, credits: 'yes' }, T0).credits, null);
  const parsed = parseLaneAccount({ ...base, credits: [
    { type: 'Codex-Credits', hasCredits: true, balance: 12.5, fraction: 0.4, resetsAt: '2026-10-22T01:44:14Z' },
    { type: '', hasCredits: true, balance: 5 },
    { type: 'other', hasCredits: true, balance: -1 },
  ] }, T0).credits;
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].type, 'codex-credits');
  assert.equal(parsed[0].balance, 12.5);
  assert.equal(parsed[0].fraction, 0.4);
  assert.equal(parsed[0].resetsAtMs, Date.parse('2026-10-22T01:44:14Z'));
  assert.equal(parsed[1].balance, null);
  assert.deepEqual(parseCredits(null), null);
});

test('only allowed types with a positive balance are spendable; paid needs opt-in', () => {
  const free = [{ type: 'codex-credits', hasCredits: true, balance: 3, fraction: null, resetsAtMs: null }];
  assert.equal(usableCredit(free, null).creditFree, true);
  assert.equal(usableCredit(free, { freeTypes: [], paidTypes: [] }), null);
  assert.equal(usableCredit([{ type: 'codex-credits', hasCredits: true, balance: 0 }], null), null);
  assert.equal(usableCredit([{ type: 'codex-credits', hasCredits: true, balance: null }], null), null);
  assert.equal(usableCredit([{ type: 'codex-credits', hasCredits: false, balance: 3 }], null), null);
  const paid = [{ type: 'acme-paid', hasCredits: true, balance: 3, fraction: null, resetsAtMs: null }];
  assert.equal(usableCredit(paid, null), null);
  assert.equal(usableCredit(paid, { paidTypes: ['acme-paid'] }).creditFree, false);
  assert.equal(usableCredit([{ type: 'unknown', hasCredits: true, balance: 3 }], { paidTypes: ['unknown'] }).creditFree, false);
});

function drive(extraAccounts, configCredits, { baseModels = ['gpt-6.1-sol'], baseProvider = 'codex', progressive = false,
  enforce = false, reviewReserve = { enabled: false }, rows = [{ slug: 'gpt-6-1-sol', intelligenceIndex: 60,
    intelligenceIndexCostPerTask: 20, price1mInputTokens: 2, price1mOutputTokens: 8 }] } = {}) {
  const state = new Map();
  const jobs = new Map();
  const handlers = new Map();
  let now = T0;
  let step = 0;
  const accounts = () => [
    { lane: 'ok', provider: baseProvider, accountKey: 'ok', health: 'healthy', models: baseModels,
      weekly: { used: 0.2 + (progressive ? step * 0.01 : 0), resetsAt: new Date(T0 + 96 * 3600000).toISOString() },
      fiveHour: { used: 0.1 + (progressive ? step * 0.04 : 0), resetsAt: new Date(T0 + 5 * 3600000).toISOString() },
      observedAt: new Date(now).toISOString(), quality: 'live',
      ...(progressive ? { usage: { observedAt: new Date(now).toISOString(), epoch: 'credit-fallback', requests: 100 + step * 100 } } : {}) },
    ...extraAccounts.map(a => progressive ? ({ ...a,
      fiveHour: { ...a.fiveHour, used: 0.1 + step * 0.04 },
      observedAt: new Date(now).toISOString(),
      usage: { observedAt: new Date(now).toISOString(), epoch: 'credit-fallback', requests: 100 + step * 100 },
    }) : a),
  ];
  const config = { pacing: { climbForSpend: true }, enforce, cliproxy: { laneKeySecretRef: SECRET }, reviewReserve,
    ...(configCredits === undefined ? {} : { credits: configCredits }) };
  const io = {
    config: { get: async () => config },
    state: { get: async k => state.get(JSON.stringify(k)) ?? null, set: async (k, v) => state.set(JSON.stringify(k), v) },
    secrets: { resolve: async () => 'fixture' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness({ observedAt: new Date(now).toISOString(), accounts: accounts() }, now) }) },
    agents: { get: async () => ({ adapterType: 'claude-code' }) },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (k, fn) => jobs.set(k, fn) },
    events: { on: (k, fn) => handlers.set(k, fn) },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  const setup = async () => {
    await plugin.setup(io);
    state.set(skey('aa-snapshot-v1'), { fetchedAt: new Date(now).toISOString(), rows, duplicateSlugs: [] });
    await plugin.onConfigChanged(config, { companyId: 'acme' });
  };
  const tick = async i => {
    if (i != null && progressive) {
      step = i;
      now = T0 + i * 5 * 60000;
    }
    await jobs.get('shadow-tick')({});
    return (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body;
  };
  return {
    setup,
    tick,
    start: async (runId, model) => handlers.get('agent.run.started')({ type: 'agent.run.started', companyId: 'acme', entityId: runId,
      payload: { run: { agentId: 'agent-9', provider: 'codex', adapterType: 'claude-code', model } }, occurredAt: new Date(now).toISOString() }),
    shadow: async () => plugin.onApiRequest({ companyId: 'acme', routeKey: 'shadow' }),
    hook: (runId, agentId = 'agent-9') => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId, issueId: null, adapterType: 'claude-code',
      invocationSource: 'test', wakeReason: null, agentDefaultModel: null, previous: null,
      issueOverrideModel: null, deadlineMs: 1500,
    }),
    api: routeKey => plugin.onApiRequest({ companyId: 'acme', routeKey }),
    run: async () => { await setup(); return tick(); },
  };
}

const spent = (key, credits) => ({ lane: key, provider: 'codex', accountKey: key, health: 'healthy', models: ['gpt-6.1-sol'],
  weekly: { used: 1.0, resetsAt: new Date(T0 + 96 * 3600000).toISOString() },
  fiveHour: { used: 0.1, resetsAt: new Date(T0 + 5 * 3600000).toISOString() },
  observedAt: new Date(T0).toISOString(), quality: 'live', ...(credits === undefined ? {} : { credits }) });

// Same fixture as the hook test below, on the tick path: both lanes serve
// the same doer model and the credit lane is far hungrier, so under the old
// ordering it wins on shortfall alone. The normal-mode run is the negative
// control pinning the tick wiring (creditPriority, creditFallback and
// remainingPct all have to reach the tick-side allocation order).
test('shadow tick routes a run to plan headroom before higher-quality credit capacity', async () => {
  const free = [{ type: 'codex-credits', hasCredits: true, balance: 1000, fraction: 0.99,
    resetsAt: new Date(T0 + 2 * 3600000).toISOString() }];
  const rows = [
    { slug: 'gemini-2-5-flash', intelligenceIndex: 54, intelligenceIndexCostPerTask: 5, price1mInputTokens: 1, price1mOutputTokens: 3 },
  ];
  const accounts = [{ ...spent('credit', free), models: ['gemini-2-5-flash'] }];
  const tickWith = async credits => {
    const d = drive(structuredClone(accounts), credits, {
      baseModels: ['gemini-2-5-flash'], baseProvider: 'meta', progressive: true, rows,
    });
    await d.setup();
    await d.start('plan-headroom-run', 'gemini-2-5-flash');
    let cap;
    for (let i = 0; i <= 2; i++) cap = await d.tick(i);
    const shadow = (await d.shadow()).body;
    const entry = shadow.entries.find(e => e.runId === 'plan-headroom-run');
    return { entry, shadow, cap };
  };
  const fallback = await tickWith(undefined);
  assert.equal(fallback.entry?.accountId, 'meta:ok',
    JSON.stringify({ shadow: fallback.shadow, tick: fallback.cap.shadow }));
  assert.equal(fallback.entry?.eventTime, false, 'the tick path made the fallback decision');
  const normal = await tickWith({ priority: 'normal' });
  assert.equal(normal.entry?.accountId, 'codex:credit',
    `negative control: the same fixture under normal priority picks the hungrier credit lane, got ${JSON.stringify({ shadow: normal.shadow, tick: normal.cap.shadow })}`);
  assert.equal(normal.entry?.eventTime, false, 'the tick path made the normal-priority decision');
});

// Both lanes serve the same doer model, and the credit lane is far hungrier
// (nearly full fraction draining over 2h), so under the old ordering the
// credit lane wins on shortfall alone. Only the fallback demotion can put
// the plan lane first -- which is what makes the normal-mode run below a
// real negative control for the hook wiring (creditPriority, remainingPct,
// guardActive and roleEligible all have to reach the hook-side sort).
test('hook selection prefers plan headroom over a higher-ranked credit lane', async () => {
  const free = [{ type: 'codex-credits', hasCredits: true, balance: 1000, fraction: 0.99,
    resetsAt: new Date(T0 + 2 * 3600000).toISOString() }];
  const rows = [
    { slug: 'gemini-2-5-flash', intelligenceIndex: 54, intelligenceIndexCostPerTask: 5, price1mInputTokens: 1, price1mOutputTokens: 3 },
  ];
  const accounts = [{ ...spent('credit', free), models: ['gemini-2-5-flash'] }];
  const hookWith = async credits => {
    const d = drive(structuredClone(accounts), credits, {
      baseModels: ['gemini-2-5-flash'], baseProvider: 'meta', enforce: true, rows,
    });
    await d.setup();
    await d.tick();
    return d.hook('hook-plan-first');
  };
  const fallback = await hookWith(undefined);
  assert.equal(fallback.kind, 'decide');
  assert.match(fallback.reason, /on meta:ok/, 'fallback ordering routes the hook run to plan headroom');
  const normal = await hookWith({ priority: 'normal' });
  assert.equal(normal.kind, 'decide');
  assert.match(normal.reason, /on codex:credit/,
    'negative control: the same fixture under normal priority picks the hungrier credit lane');
});

test('review reserve excludes credit accounts while same-provider plan headroom exists', async () => {
  const free = [{ type: 'codex-credits', hasCredits: true, balance: 12.5, fraction: 0.4,
    resetsAt: new Date(T0 + 96 * 3600000).toISOString() }];
  const d = drive([spent('credit', free)], undefined, {
    reviewReserve: { enabled: true, providers: ['codex'], agentIds: ['reviewer'] },
  });
  await d.setup();
  await d.tick();
  const cap = (await d.api('capacity')).body;
  assert.deepEqual(cap.reviewReserve.perProvider.codex.accounts.map(a => a.accountId), ['codex:ok']);
});

test('review reserve keeps credit accounts when the same-provider plan lane has no usable headroom', async () => {
  const free = [{ type: 'codex-credits', hasCredits: true, balance: 12.5, fraction: 0.4,
    resetsAt: new Date(T0 + 96 * 3600000).toISOString() }];
  const guardedPlan = { lane: 'guarded', provider: 'codex', accountKey: 'guarded', health: 'healthy',
    models: ['gpt-6.1-sol'],
    weekly: { used: 0.2, resetsAt: new Date(T0 + 96 * 3600000).toISOString() },
    fiveHour: { used: 0.99, resetsAt: new Date(T0 + 5 * 3600000).toISOString() },
    observedAt: new Date(T0).toISOString(), quality: 'live' };
  const d = drive([spent('credit', free), guardedPlan], undefined, {
    baseProvider: 'meta',
    reviewReserve: { enabled: true, providers: ['codex'], agentIds: ['reviewer'] },
  });
  await d.setup();
  await d.tick();
  const cap = (await d.api('capacity')).body;
  const ids = cap.reviewReserve.perProvider.codex.accounts.map(a => a.accountId);
  assert.ok(ids.includes('codex:credit'),
    `credit lane stays in the reserve when no codex plan lane has usable headroom, got ${JSON.stringify(ids)}`);
});

test('weekly-spent Codex lane with free credits stays available and paced; without stays excluded', async () => {
  const free = [{ type: 'codex-credits', hasCredits: true, balance: 12.5, fraction: 0.4, resetsAt: new Date(T0 + 96 * 3600000).toISOString() }];
  const cap = await drive([spent('with-free', free), spent('without')]).run();
  const withFree = cap.accounts.find(a => a.accountId === 'codex:with-free');
  assert.notEqual(withFree.action, 'excluded');
  assert.equal(withFree.headroomSource, 'credits');
  assert.equal(withFree.creditType, 'codex-credits');
  assert.equal(withFree.creditFree, true);
  assert.equal(withFree.creditBalance, 12.5);
  assert.ok(withFree.requiredRatePerHour > 0, 'drain-paced required rate');
  assert.ok(withFree.targetShare > 0, 'earns sustainable share');
  const without = cap.accounts.find(a => a.accountId === 'codex:without');
  assert.equal(without.action, 'excluded');
  assert.ok(/weekly window exhausted/.test(without.reason));
});

test('paid credits stay excluded unless the operator allows the type', async () => {
  const paid = [{ type: 'acme-paid', hasCredits: true, balance: 9, fraction: 0.9, resetsAt: new Date(T0 + 96 * 3600000).toISOString() }];
  const denied = await drive([spent('paid', paid)]).run();
  assert.equal(denied.accounts.find(a => a.accountId === 'codex:paid').action, 'excluded');
  const allowed = await drive([spent('paid', paid)], { paidTypes: ['acme-paid'] }).run();
  const view = allowed.accounts.find(a => a.accountId === 'codex:paid');
  assert.notEqual(view.action, 'excluded');
  assert.equal(view.headroomSource, 'credits');
  assert.equal(view.creditFree, false);
});

test('zero-balance free grant is excluded: empty is never capacity', async () => {
  const empty = [{ type: 'codex-credits', hasCredits: true, balance: 0, fraction: 0, resetsAt: new Date(T0 + 96 * 3600000).toISOString() }];
  const cap = await drive([spent('empty', empty)]).run();
  assert.equal(cap.accounts.find(a => a.accountId === 'codex:empty').action, 'excluded');
});

// Review #38 finding 1: a credit entry without a fraction (the Has-Credits
// plus Balance feed shape) must stay routable at full-window headroom, not
// report 0 and drop out of the allocation order.
test('credit lane without a fraction routes at full-window headroom', async () => {
  const noFraction = [{ type: 'codex-credits', hasCredits: true, balance: 5 }];
  const cap = await drive([spent('nofrac', noFraction)]).run();
  const view = cap.accounts.find(a => a.accountId === 'codex:nofrac');
  assert.notEqual(view.action, 'excluded');
  assert.equal(view.headroomSource, 'credits');
  assert.equal(view.headroomPct, 1);
  assert.ok(view.targetShare > 0, 'earns sustainable share');
  assert.ok(orderAccountsForRun(cap.accounts).some(v => v.accountId === 'codex:nofrac'), 'in the allocation order');
});

// A quantified fraction at or below the routing reserve honestly reports
// itself: only the unquantified (null) case reads as a full window.
test('credit lane with a depleted quantified fraction stays out of the order', async () => {
  const low = [{ type: 'codex-credits', hasCredits: true, balance: 1, fraction: 0.03,
    resetsAt: new Date(T0 + 96 * 3600000).toISOString() }];
  const cap = await drive([spent('low', low)]).run();
  const view = cap.accounts.find(a => a.accountId === 'codex:low');
  assert.equal(view.headroomPct, 0.03);
  assert.ok(!orderAccountsForRun(cap.accounts).some(v => v.accountId === 'codex:low'));
});

// Review #38 finding 2: the fleet concurrency target counts the credit pool
// over the credit reset horizon, not the spent weekly window. The credit
// lane carries a 5h burn sample (its weekly meter is flat at 100%) so C*
// has a measured burn; pre-fix its need was 0/96h and it earned 0 slots.
function driveCreditGroup() {
  const state = new Map();
  const jobs = new Map();
  const handlers = new Map();
  let now = T0;
  let step = 0;
  const accounts = () => [
    { lane: 'ok', provider: 'codex', accountKey: 'ok', health: 'healthy', models: ['gpt-6.1-sol'],
      weekly: { used: 0.2 + step * 0.01, resetsAt: new Date(T0 + 96 * 3600000).toISOString() },
      fiveHour: { used: 0.1, resetsAt: new Date(T0 + 5 * 3600000).toISOString() },
      observedAt: new Date(now).toISOString(), quality: 'live',
      usage: { observedAt: new Date(now).toISOString(), epoch: 'keeper-1', requests: 100 + step * 100 } },
    { lane: 'cr', provider: 'codex', accountKey: 'cr', health: 'healthy', models: ['gpt-6.1-sol'],
      weekly: { used: 1.0, resetsAt: new Date(T0 + 96 * 3600000).toISOString() },
      fiveHour: { used: 0.1 + step * 0.04, resetsAt: new Date(T0 + 5 * 3600000).toISOString() },
      observedAt: new Date(now).toISOString(), quality: 'live',
      usage: { observedAt: new Date(now).toISOString(), epoch: 'keeper-1', requests: 100 + step * 100 },
      credits: [{ type: 'codex-credits', hasCredits: true, balance: 9, fraction: 0.5,
        resetsAt: new Date(T0 + 48 * 3600000).toISOString() }] },
  ];
  const config = { pacing: { climbForSpend: true }, cliproxy: { laneKeySecretRef: SECRET }, reviewReserve: { enabled: false } };
  const io = {
    config: { get: async () => config },
    state: { get: async k => state.get(JSON.stringify(k)) ?? null, set: async (k, v) => state.set(JSON.stringify(k), v) },
    secrets: { resolve: async () => 'fixture' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness({ observedAt: new Date(now).toISOString(), accounts: accounts() }, now) }) },
    agents: { get: async () => ({ adapterType: 'claude-code' }) },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (k, fn) => jobs.set(k, fn) },
    events: { on: (k, fn) => handlers.set(k, fn) },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return {
    setup: async () => {
      await plugin.setup(io);
      state.set(skey('aa-snapshot-v1'), { fetchedAt: new Date(now).toISOString(), rows: [{ slug: 'gpt-6-1-sol', intelligenceIndex: 60,
        intelligenceIndexCostPerTask: 20, price1mInputTokens: 2, price1mOutputTokens: 8 }], duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: async i => {
      now = T0 + i * 5 * MIN;
      step = i;
      if (i > 0) for (let n = 0; n < 10; n++) {
        await handlers.get('agent.run.started')({ companyId: 'acme', entityId: `cr-run-${i}-${n}`,
          payload: { run: { agentId: 'eng', model: 'gpt-6.1-sol' } }, occurredAt: new Date(now - (n + 1) * 1000).toISOString() });
      }
      await jobs.get('shadow-tick')({});
      return (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body;
    },
  };
}

test('credit capacity does not inflate concurrency while plan headroom remains', async () => {
  const d = driveCreditGroup();
  await d.setup();
  let cap;
  for (let i = 0; i <= 6; i++) cap = await d.tick(i);
  const view = cap.accounts.find(a => a.accountId === 'codex:cr');
  assert.equal(view.calibrationSource, 'account-five-hour');
  const row = cap.perAccount.find(a => a.accountId === 'codex:cr');
  const planRow = cap.perAccount.find(a => a.accountId === 'codex:ok');
  assert.equal(row.usableSlots, 0, `credit lane is excluded from target while plan headroom remains, got ${row.usableSlots}`);
  assert.ok(planRow.usableSlots > 0, 'plan lane retains its concurrency capacity');
});

const MIN = 60000;

// Multi-rung drain drive: the lane serves three models so the ladder has
// three arms (a climb is possible), and the credit reset (48h) differs from
// the weekly reset (96h) so the credit horizon is pinned, not assumed.
const DRAIN_MODELS = ['gpt-6.1-sol', 'gpt-6.1-sol-lite', 'gpt-6.1-sol-micro'];
const DRAIN_SLUGS = ['gpt-6-1-sol', 'gpt-6-1-sol-lite', 'gpt-6-1-sol-micro'];

function driveDrain({ fractions, creditResetsAtH = 48, creditFromStep = 0, preCreditWeekly = 0.9 }) {
  const state = new Map();
  const jobs = new Map();
  const handlers = new Map();
  let now = T0;
  let step = 0;
  const accounts = () => {
    const pre = step < creditFromStep;
    return [{
      lane: 'cr', provider: 'codex', accountKey: 'cr', health: 'healthy', models: DRAIN_MODELS,
      weekly: { used: pre ? preCreditWeekly : 1.0, resetsAt: new Date(T0 + 96 * 3600000).toISOString() },
      fiveHour: { used: 0.1, resetsAt: new Date(T0 + 5 * 3600000).toISOString() },
      observedAt: new Date(now).toISOString(), quality: 'live',
      ...(!pre ? { credits: [{ type: 'codex-credits', hasCredits: true, balance: 10,
        ...(fractions[step] == null ? {} : { fraction: fractions[step] }),
        resetsAt: new Date(T0 + creditResetsAtH * 3600000).toISOString() }] } : {}),
    }];
  };
  const config = { pacing: { climbForSpend: true }, cliproxy: { laneKeySecretRef: SECRET }, reviewReserve: { enabled: false } };
  const io = {
    config: { get: async () => config },
    state: { get: async k => state.get(JSON.stringify(k)) ?? null, set: async (k, v) => state.set(JSON.stringify(k), v) },
    secrets: { resolve: async () => 'fixture' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness({ observedAt: new Date(now).toISOString(), accounts: accounts() }, now) }) },
    agents: { get: async () => ({ adapterType: 'claude-code' }) },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (k, fn) => jobs.set(k, fn) },
    events: { on: (k, fn) => handlers.set(k, fn) },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return {
    setup: async () => {
      await plugin.setup(io);
      state.set(skey('aa-snapshot-v1'), { fetchedAt: new Date(now).toISOString(), rows: DRAIN_SLUGS.map(slug => ({ slug,
        intelligenceIndex: 60, intelligenceIndexCostPerTask: 20, price1mInputTokens: 2, price1mOutputTokens: 8 })) ,
        duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: async i => {
      now = T0 + i * 5 * MIN;
      step = i;
      await jobs.get('shadow-tick')({});
      return (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body;
    },
  };
}

// Review #38 finding 3: the controller paces the measured credit drain, so a
// lane draining ~10x above pace holds the floor instead of climbing to the
// ceiling on the flat weekly meter. The required rate pins the credit
// horizon (fraction / credit hours), not the weekly reset.
test('falling credit fraction paces the drain without climbing', async () => {
  const fractions = Array.from({ length: 14 }, (_, i) => 0.6 - i * 0.01);
  const d = driveDrain({ fractions });
  await d.setup();
  let cap;
  for (let i = 0; i < fractions.length; i++) {
    cap = await d.tick(i);
    const view = cap.accounts.find(a => a.accountId === 'codex:cr');
    assert.ok(view.arms.length >= 3, `multi-rung ladder, got ${view.arms.length} arms`);
    assert.equal(view.pointer, 0, `tick ${i}: pointer holds the floor while credits drain above pace`);
  }
  const view = cap.accounts.find(a => a.accountId === 'codex:cr');
  assert.equal(view.rateBasis, 'measured');
  assert.ok(view.measuredRatePerHour > view.requiredRatePerHour,
    `measured ${view.measuredRatePerHour} tracks the credit drain above required ${view.requiredRatePerHour}`);
  const lastHours = 48 - (fractions.length - 1) * 5 / 60;
  assert.ok(Math.abs(view.requiredRatePerHour - (0.6 - 0.13) / lastHours) < 1e-9,
    `required paces the credit horizon: ${view.requiredRatePerHour}`);
});

// Review round 2 finding 1: a fraction-less credit entry (the live feed
// shape) carries no position signal, so the pointer holds on a multi-rung
// ladder instead of climbing to the ceiling on a synthetic deficit.
test('fraction-less credit lane holds the pointer on a multi-rung ladder', async () => {
  const d = driveDrain({ fractions: Array(14).fill(null) });
  await d.setup();
  let cap;
  for (let i = 0; i < 14; i++) {
    cap = await d.tick(i);
    const view = cap.accounts.find(a => a.accountId === 'codex:cr');
    assert.ok(view.arms.length >= 3, `multi-rung ladder, got ${view.arms.length} arms`);
    assert.equal(view.headroomPct, 1);
    assert.notEqual(view.action, 'excluded');
    assert.equal(view.pointer, 0, `tick ${i}: pointer holds with no fraction signal`);
  }
});

// Review round 3: pin positionError = 0 for credit lanes above the floor.
// The lane first climbs on its weekly meter alone, then a fraction-less
// credit entry arrives: the pointer must hold its rung instead of descending
// on the weekly 100%-used position (without the fix it falls 2→1→0 within
// three ticks).
test('fraction-less credit lane holds above the floor', async () => {
  const d = driveDrain({ fractions: Array(60).fill(null), creditFromStep: 30 });
  await d.setup();
  let cap;
  let rung = -1;
  for (let i = 0; i < 30; i++) {
    cap = await d.tick(i);
    const view = cap.accounts.find(a => a.accountId === 'codex:cr');
    assert.ok(view.arms.length >= 3, `multi-rung ladder, got ${view.arms.length} arms`);
    if (view.pointer >= 2) { rung = view.pointer; break; }
  }
  assert.ok(rung >= 2, `lane climbs above the floor on its weekly meter (rung ${rung})`);
  for (let i = 30; i < 50; i++) {
    cap = await d.tick(i);
    const view = cap.accounts.find(a => a.accountId === 'codex:cr');
    assert.equal(view.headroomPct, 1, `tick ${i}: credit headroom is full-window`);
    assert.equal(view.pointer, rung, `tick ${i}: pointer holds rung ${rung} with no fraction signal`);
  }
});

// Review round 4: the quantified twin. positionError = 0 covers every credit
// lane, so a slowly draining quantified fraction must also hold its rung
// through the 60-minute warmup instead of descending on the weekly 100%-used
// position (mutant M2 zeroes the error only when fraction == null: falls
// 2→1→0, then re-climbs when the measured drain takes over).
test('quantified slow drain holds above the floor through warmup', async () => {
  const fractions = Array.from({ length: 80 }, (_, i) => 0.6 - Math.max(0, i - 30) * 0.0004);
  const d = driveDrain({ fractions, creditFromStep: 30 });
  await d.setup();
  let cap;
  let rung = -1;
  for (let i = 0; i < 30; i++) {
    cap = await d.tick(i);
    const view = cap.accounts.find(a => a.accountId === 'codex:cr');
    assert.ok(view.arms.length >= 3, `multi-rung ladder, got ${view.arms.length} arms`);
    if (view.pointer >= 2) { rung = view.pointer; break; }
  }
  assert.ok(rung >= 2, `lane climbs above the floor on its weekly meter (rung ${rung})`);
  for (let i = 30; i <= 41; i++) {
    cap = await d.tick(i);
    const view = cap.accounts.find(a => a.accountId === 'codex:cr');
    assert.equal(view.pointer, rung, `tick ${i}: pointer holds rung ${rung} while the quantified drain warms up`);
  }
});

// A below-pace quantified drain inside the warmup span stays on position
// pacing (hold), which kills replacing the credit warmup span with false:
// with rate control the 0.24%/h drain would read behind the ~1%/h required
// rate and climb.
test('slow quantified drain inside warmup holds instead of climbing', async () => {
  const fractions = [0.5, 0.4998, 0.4996, 0.4994, 0.4992];
  const d = driveDrain({ fractions });
  await d.setup();
  for (let i = 0; i < fractions.length; i++) {
    const cap = await d.tick(i);
    const view = cap.accounts.find(a => a.accountId === 'codex:cr');
    assert.ok(view.arms.length >= 3, `multi-rung ladder, got ${view.arms.length} arms`);
    assert.equal(view.pointer, 0, `tick ${i}: warmup holds on position pacing`);
  }
});

// Review round 2 finding 2: C* slots scale with the credit horizon. Two
// lanes with the same fraction and the same burn but different credit resets
// earn slots in inverse-horizon ratio; the fraction-less lane earns slots
// from the full-window assumption.
function driveCreditHorizons() {
  const state = new Map();
  const jobs = new Map();
  const handlers = new Map();
  let now = T0;
  let step = 0;
  const creditLane = (lane, extra) => ({
    lane, provider: 'codex', accountKey: lane, health: 'healthy', models: ['gpt-6.1-sol'],
    weekly: { used: 1.0, resetsAt: new Date(T0 + 96 * 3600000).toISOString() },
    fiveHour: { used: 0.1 + step * 0.04, resetsAt: new Date(T0 + 5 * 3600000).toISOString() },
    observedAt: new Date(now).toISOString(), quality: 'live',
    usage: { observedAt: new Date(now).toISOString(), epoch: 'keeper-1', requests: 100 + step * 100 },
    ...extra,
  });
  const accounts = () => [
    { lane: 'ok', provider: 'codex', accountKey: 'ok', health: 'healthy', models: ['gpt-6.1-sol'],
      weekly: { used: 0.2 + step * 0.01, resetsAt: new Date(T0 + 96 * 3600000).toISOString() },
      fiveHour: { used: 0.1, resetsAt: new Date(T0 + 5 * 3600000).toISOString() },
      observedAt: new Date(now).toISOString(), quality: 'live',
      usage: { observedAt: new Date(now).toISOString(), epoch: 'keeper-1', requests: 100 + step * 100 } },
    creditLane('cr48', { credits: [{ type: 'codex-credits', hasCredits: true, balance: 9, fraction: 0.5,
      resetsAt: new Date(T0 + 48 * 3600000).toISOString() }] }),
    creditLane('cr96', { credits: [{ type: 'codex-credits', hasCredits: true, balance: 9, fraction: 0.5,
      resetsAt: new Date(T0 + 96 * 3600000).toISOString() }] }),
    creditLane('crnofrac', { credits: [{ type: 'codex-credits', hasCredits: true, balance: 9,
      resetsAt: new Date(T0 + 48 * 3600000).toISOString() }] }),
  ];
  const config = { pacing: { climbForSpend: true }, cliproxy: { laneKeySecretRef: SECRET }, reviewReserve: { enabled: false } };
  const io = {
    config: { get: async () => config },
    state: { get: async k => state.get(JSON.stringify(k)) ?? null, set: async (k, v) => state.set(JSON.stringify(k), v) },
    secrets: { resolve: async () => 'fixture' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness({ observedAt: new Date(now).toISOString(), accounts: accounts() }, now) }) },
    agents: { get: async () => ({ adapterType: 'claude-code' }) },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (k, fn) => jobs.set(k, fn) },
    events: { on: (k, fn) => handlers.set(k, fn) },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return {
    setup: async () => {
      await plugin.setup(io);
      state.set(skey('aa-snapshot-v1'), { fetchedAt: new Date(now).toISOString(), rows: [{ slug: 'gpt-6-1-sol', intelligenceIndex: 60,
        intelligenceIndexCostPerTask: 20, price1mInputTokens: 2, price1mOutputTokens: 8 }], duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: async i => {
      now = T0 + i * 5 * MIN;
      step = i;
      if (i > 0) for (let n = 0; n < 10; n++) {
        await handlers.get('agent.run.started')({ companyId: 'acme', entityId: `hz-run-${i}-${n}`,
          payload: { run: { agentId: 'eng', model: 'gpt-6.1-sol' } }, occurredAt: new Date(now - (n + 1) * 1000).toISOString() });
      }
      await jobs.get('shadow-tick')({});
      return (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body;
    },
  };
}

test('C* slots scale with the credit horizon', async () => {
  const d = driveCreditHorizons();
  await d.setup();
  let cap;
  for (let i = 0; i <= 6; i++) cap = await d.tick(i);
  for (const id of ['codex:cr48', 'codex:cr96', 'codex:crnofrac']) {
    assert.equal(cap.accounts.find(a => a.accountId === id).calibrationSource, 'account-five-hour');
  }
  const slots = id => cap.perAccount.find(a => a.accountId === id).slots;
  assert.ok(slots('codex:cr48') > 0 && slots('codex:cr96') > 0 && slots('codex:crnofrac') > 0);
  const ratio = slots('codex:cr48') / slots('codex:cr96');
  assert.ok(Math.abs(ratio - 2) < 0.02, `slots scale with the horizon, ratio ${ratio}`);
  const req48 = cap.accounts.find(a => a.accountId === 'codex:cr48').requiredRatePerHour;
  assert.ok(Math.abs(req48 - 0.5 / 47.5) < 1e-9, `required paces the 48h credit horizon: ${req48}`);
});


