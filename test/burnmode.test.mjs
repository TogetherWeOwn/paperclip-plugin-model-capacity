/**
 * Burn mode (0.2.53): operator-flagged provider accounts spend ASAP.
 * Unit coverage for config/matching (burnmode.mjs), the pace guard and the
 * allocation order, then the plugin end to end: an ahead lane in burn mode
 * is never paced or reserve-held, routing prefers burn accounts, /capacity
 * reports them, and an absent/empty burnMode decides bit-for-bit as before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin, resolveConfig, validateConfigShape } from '../src/plugin.mjs';
import { orderAccountsWithPacing } from '../src/select.mjs';
import { paceGuardPools } from '../src/paceguard.mjs';
import { REVIEW_RESERVE_STATE_KEY } from '../src/reviewreserve.mjs';
import {
  DEFAULT_BURN_MODE, normalizeBurnMode, validateBurnMode, isBurnAccount, burnPaceResetAtMs, burnModeActive,
} from '../src/burnmode.mjs';
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


const lane2 = (key, used, hoursLeft, over = {}) => ({
  ...lane(used, hoursLeft), lane: `claude-${key}`, accountKey: key, ...over,
});

// ---------------------------------------------------------------- config

test('config: burnMode validates arrays of strings and a horizon >= 1 minute', () => {
  assert.deepEqual(validateBurnMode(undefined), []);
  assert.deepEqual(validateBurnMode({ accounts: ['meta:meta-lane-3'], horizonMinutes: 30 }), []);
  assert.match(validateBurnMode([]).join(), /burnMode must be an object/);
  assert.match(validateBurnMode({ accounts: 'meta:meta-lane-3' }).join(), /array of strings/);
  assert.match(validateBurnMode({ accounts: ['ok', 3] }).join(), /non-empty strings/);
  assert.match(validateBurnMode({ accounts: [''] }).join(), /non-empty strings/);
  assert.match(validateBurnMode({ horizonMinutes: 0 }).join(), /horizonMinutes/);
  // Wired into the plugin's config validator.
  assert.ok(validateConfigShape({ burnMode: { accounts: 'x' } }).some(e => /burnMode\.accounts/.test(e)));
  assert.ok(!validateConfigShape({ burnMode: { accounts: ['codex:*'] } }).some(e => /burnMode/.test(e)));
});

test('config: normalize lower-cases, dedupes, defaults the horizon to 60 minutes', () => {
  assert.deepEqual(normalizeBurnMode(undefined), { accounts: [], horizonMinutes: 60 });
  assert.deepEqual(normalizeBurnMode({ accounts: [' Meta:Meta-Lane-3 ', 'meta:meta-lane-3', 7], horizonMinutes: -1 }),
    { accounts: ['meta:meta-lane-3'], horizonMinutes: DEFAULT_BURN_MODE.horizonMinutes });
  assert.deepEqual(resolveConfig({}).burnMode, { accounts: [], horizonMinutes: 60 });
  assert.equal(resolveConfig({ burnMode: { horizonMinutes: 15 } }).burnMode.horizonMinutes, 15);
  assert.equal(burnModeActive(normalizeBurnMode({ accounts: ['!x'] })), false);
});

test('matching: id, lane/accountKey, label, email (case-insensitive), provider:* and ! exclusions', () => {
  const acct = { accountId: 'meta:meta-lane-3', provider: 'meta', lane: 'meta-lane-3', label: 'Rick Lane', email: 'Someone@Example.com' };
  const on = (accounts) => isBurnAccount(normalizeBurnMode({ accounts }), acct, acct.accountId);
  assert.equal(on(['meta:meta-lane-3']), true);
  assert.equal(on(['META-LANE-3']), true);
  assert.equal(on(['rick lane']), true);
  assert.equal(on(['someone@example.com']), true);
  assert.equal(on(['meta:*']), true);
  assert.equal(on(['codex:*']), false);
  assert.equal(on(['meta:meta-lane-4']), false);
  assert.equal(on(['meta']), false, 'a bare provider name is not a wildcard');
  assert.equal(on(['meta:*', '!someone@example.com']), false, 'exclusion wins');
  assert.equal(on(['!someone@example.com', 'meta:*']), false, 'exclusion wins regardless of order');
  assert.equal(on([]), false);
  // A duplicate-suffixed state key still matches its lane.
  assert.equal(isBurnAccount(normalizeBurnMode({ accounts: ['codex:c1'] }), { provider: 'codex' }, 'codex:c1'), true);
});

test('pace end: min(regular reset, free-reset horizon, now + horizon); unknown reset still burns', () => {
  const cfg = normalizeBurnMode({ accounts: ['x'] });
  assert.equal(burnPaceResetAtMs({ nowMs: TICK, resetAtMs: TICK + 48 * HOUR, cfg }), TICK + HOUR);
  assert.equal(burnPaceResetAtMs({ nowMs: TICK, resetAtMs: TICK + 0.5 * HOUR, cfg }), TICK + 0.5 * HOUR);
  assert.equal(burnPaceResetAtMs({ nowMs: TICK, resetAtMs: null, cfg }), TICK + HOUR);
  assert.equal(burnPaceResetAtMs({ nowMs: TICK, resetAtMs: TICK + 48 * HOUR, horizonMs: TICK + 0.25 * HOUR, cfg }), TICK + 0.25 * HOUR);
});

// --------------------------------------------------------- guard + order

const view = (accountId, partial = {}) => ({
  accountId, pool: 'claude', health: 'healthy', headroomPct: 0.8, resetAtMs: 1000,
  targetShare: 10, inFlight: 0, planAhead: 0.1, ...partial,
});
const PACING = { enabled: true, marginPct: 0.02, meanRunDurationHours: 0.2 };
const ids = (r) => r.order.map(v => v.accountId);

test('pace guard: burn lanes leave the aggregation and are never held', () => {
  const r = orderAccountsWithPacing([
    view('claude:1', { planAhead: 0.3, targetShare: 3, inFlight: 9, laneInFlight: 4 }),
    view('claude:2', { planAhead: 0.3, targetShare: 3, inFlight: 9, laneInFlight: 5, burn: true }),
  ], { pacing: PACING });
  assert.deepEqual(ids(r), ['claude:2']);
  const pool = r.pools[0];
  assert.deepEqual(pool.burnAccountIds, ['claude:2']);
  assert.deepEqual(pool.pacedAccountIds, ['claude:1']);
  // The burn lane's own five runs do not count against the paced lane's cap.
  assert.equal(pool.inFlight, 4);
  assert.equal(pool.cap, 1);
  assert.ok(Math.abs(pool.pacedSlots - 0.6) < 1e-9);
});

test('pace guard: a pool whose every lane burns is unpaced (cap null, state burn)', () => {
  const pools = paceGuardPools([
    view('claude:1', { planAhead: 0.5, inFlight: 99, burn: true }),
    view('claude:2', { planAhead: 0.5, inFlight: 99, burn: true }),
  ], { pacing: PACING, poolKeyOf: v => `pool:${v.pool}` });
  assert.equal(pools[0].state, 'burn');
  assert.equal(pools[0].cap, null);
  assert.equal(pools[0].paced, false);
  assert.deepEqual(pools[0].burnAccountIds, ['claude:1', 'claude:2']);
});

test('order: burn accounts sort first; exhausted or unhealthy burn accounts are never chosen', () => {
  const base = [
    view('claude:a', { pool: 'a', planAhead: -0.3, targetShare: 9 }),
    view('meta:b', { pool: 'b', planAhead: 0.0, targetShare: 1, burn: true }),
    view('codex:c', { pool: 'c', planAhead: -0.1, targetShare: 5 }),
  ];
  assert.deepEqual(ids(orderAccountsWithPacing(base, { pacing: PACING })).slice(0, 1), ['meta:b']);
  const spent = base.map(v => (v.accountId === 'meta:b' ? { ...v, headroomPct: 0.01 } : v));
  assert.ok(!ids(orderAccountsWithPacing(spent, { pacing: PACING })).includes('meta:b'));
  const sick = base.map(v => (v.accountId === 'meta:b' ? { ...v, health: 'exhausted' } : v));
  assert.ok(!ids(orderAccountsWithPacing(sick, { pacing: PACING })).includes('meta:b'));
  // No burn flag anywhere: the order is the pre-burn order.
  const plain = base.map(({ burn, ...v }) => v);
  assert.equal(ids(orderAccountsWithPacing(plain, { pacing: PACING }))[0], 'claude:a');
});

test('order: the review reserve never holds a burn account', () => {
  const v = view('claude:a1', { pool: null, planAhead: -0.1 });
  const held = { heldAccountIds: ['claude:a1'], forReview: false };
  assert.equal(orderAccountsWithPacing([v], { reviewReserve: held }).order.length, 0);
  const r = orderAccountsWithPacing([{ ...v, burn: true }], { reviewReserve: held });
  assert.deepEqual(ids(r), ['claude:a1']);
  assert.deepEqual(r.reserveHeld, []);
});

// ------------------------------------------------------------- plugin

test('plugin: an ahead lane in burn mode is never paced, paces to the 60-min horizon, and is reported', async () => {
  // 90% spent with 48h left: 18.6 points ahead of plan -> normally cap 1.
  const plain = drive({ config: { enforce: true, reviewReserve: { enabled: false } }, accounts: [lane(0.9, 48)] });
  await plain.setup();
  await plain.tick();
  assert.equal((await plain.hook('run-1')).kind, 'decide');
  const held = await plain.hook('run-2');
  assert.equal(held.kind, 'defer');
  assert.match(held.reason, /pace guard/);

  const d = drive({
    config: { enforce: true, reviewReserve: { enabled: false }, burnMode: { accounts: ['claude:a1'] } },
    accounts: [lane(0.9, 48)],
  });
  await d.setup();
  await d.tick();
  for (const id of ['run-1', 'run-2', 'run-3']) assert.equal((await d.hook(id)).kind, 'decide', id);
  const cap = (await d.api('capacity')).body;
  const a = cap.accounts.find(x => x.accountId === 'claude:a1');
  assert.equal(a.burnMode, true);
  assert.equal(a.paceResetAtMs, TICK + HOUR);
  // remaining 10% over one hour (not 48h): the maximal required rate.
  assert.ok(Math.abs(a.requiredRatePerHour - 0.1) < 1e-9);
  assert.ok(a.planAhead <= 0, 'a burn account never reads ahead of plan');
  assert.deepEqual(cap.paceGuard.burnAccounts, ['claude:a1']);
  assert.equal(cap.paceGuard.pools.find(p => p.pool === 'claude').state, 'burn');
});

test('plugin: routing prefers the burn account; matching by label from the feed', async () => {
  const accounts = [lane2('a1', 0.2, 100), lane2('a2', 0.6, 100, { label: 'Spare Seat' })];
  const d = drive({ config: { enforce: true, reviewReserve: { enabled: false }, burnMode: { accounts: ['SPARE SEAT'] } }, accounts });
  await d.setup();
  await d.tick();
  assert.equal((await d.hook('run-1')).kind, 'decide');
  assert.equal((await d.hook('run-2')).kind, 'decide');
  await d.tick();
  const entries = (await d.api('shadow')).body.entries;
  assert.equal(entries.find(e => e.runId === 'run-1')?.accountId, 'claude:a2');
  assert.equal(entries.find(e => e.runId === 'run-2')?.accountId, 'claude:a2');
  // Without burn mode the lane far behind plan (a1) is preferred.
  const p = drive({ config: { enforce: true, reviewReserve: { enabled: false } }, accounts });
  await p.setup();
  await p.tick();
  await p.hook('run-1');
  await p.tick();
  assert.equal((await p.api('shadow')).body.entries.find(e => e.runId === 'run-1')?.accountId, 'claude:a1');
});

test('plugin: review-reserve holds skip burn accounts', async () => {
  const cfg = {
    enforce: true, roles: { keepAgentIds: ['reviewer-1'] },
    reviewReserve: { agentIds: ['reviewer-1', 'reviewer-2'] },
  };
  const run = async (config) => {
    const d = drive({ config, accounts: [lane(0.5, 40)] });
    await d.setup();
    d.seed(RR_STATE_KEY, burnedState(2.0));
    await d.fire(runEvent('rev-waiting', TICK - 60000, 'reviewer-2'));
    await d.tick();
    return { d, cap: (await d.api('capacity')).body };
  };
  const held = await run(cfg);
  assert.deepEqual(held.cap.reviewReserve.heldAccountIds, ['claude:a1']);
  assert.equal((await held.d.hook('run-other')).kind, 'defer');
  const burn = await run({ ...cfg, burnMode: { accounts: ['claude:*'] } });
  assert.deepEqual(burn.cap.reviewReserve.heldAccountIds, []);
  assert.equal((await burn.d.hook('run-other')).kind, 'decide');
});

test('regression: absent, empty and non-matching burnMode decide bit-for-bit identically', async () => {
  const scenario = async (extra) => {
    const accounts = [lane2('a1', 0.9, 48), lane2('a2', 0.3, 100), { ...geminiLane(0.5, 30) }];
    const d = drive({ config: { enforce: true, ...extra }, accounts });
    await d.setup();
    await d.tick();
    const hooks = [];
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) hooks.push(await d.hook(id));
    d.setNow(TICK + 5 * 60000);
    await d.tick();
    const cap = (await d.api('capacity')).body;
    const shadow = (await d.api('shadow')).body.entries;
    return JSON.stringify({
      hooks, shadow,
      accounts: cap.accounts, pools: cap.paceGuard.pools, reserve: cap.reviewReserve,
      target: cap.concurrency ?? null,
    });
  };
  const absent = await scenario({});
  assert.equal(await scenario({ burnMode: { accounts: [] } }), absent);
  assert.equal(await scenario({ burnMode: { accounts: ['nobody:none'], horizonMinutes: 5 } }), absent);
  assert.equal(await scenario({ burnMode: { accounts: ['!claude:a1'] } }), absent);
  assert.doesNotMatch(absent, /burnMode|"burn"/);
});
