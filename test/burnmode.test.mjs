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
  DEFAULT_BURN_MODE, normalizeBurnMode, validateBurnMode, isBurnAccount, burnDeadlineAtMs, burnPaceResetAtMs, burnPaceTarget, burnModeActive,
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
    setAccounts: a => { laneAccounts = a; },
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
  assert.deepEqual(normalizeBurnMode(undefined), { accounts: [], horizonMinutes: 60, deadlines: {} });
  assert.deepEqual(normalizeBurnMode({ accounts: [' Meta:Meta-Lane-3 ', 'meta:meta-lane-3', 7], horizonMinutes: -1 }),
    { accounts: ['meta:meta-lane-3'], horizonMinutes: DEFAULT_BURN_MODE.horizonMinutes, deadlines: {} });
  assert.deepEqual(resolveConfig({}).burnMode, { accounts: [], horizonMinutes: 60, deadlines: {} });
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

test('config: deadlines validate as an object of matchers to ISO-8601 timestamps', () => {
  assert.deepEqual(validateBurnMode({ deadlines: {} }), []);
  assert.deepEqual(validateBurnMode({ deadlines: { 'meta:*': '2026-10-27T00:00:00Z' } }), []);
  assert.match(validateBurnMode({ deadlines: 'meta:*' }).join(), /deadlines must be an object/);
  assert.match(validateBurnMode({ deadlines: [] }).join(), /deadlines must be an object/);
  assert.match(validateBurnMode({ deadlines: { 'meta:*': 'someday' } }).join(), /ISO-8601/);
  assert.match(validateBurnMode({ deadlines: { 'meta:*': 123 } }).join(), /ISO-8601/);
  assert.match(validateBurnMode({ deadlines: { '': '2026-10-27T00:00:00Z' } }).join(), /non-empty strings/);
  // Wired into the plugin's config validator.
  assert.ok(validateConfigShape({ burnMode: { deadlines: 'x' } }).some(e => /burnMode\.deadlines/.test(e)));
  assert.ok(!validateConfigShape({ burnMode: { accounts: ['codex:*'], deadlines: { 'meta:*': '2026-10-27T00:00:00Z' } } }).some(e => /burnMode/.test(e)));
});

test('config: normalize lower-cases deadline keys and defaults to no deadlines', () => {
  assert.deepEqual(normalizeBurnMode(undefined).deadlines, {});
  assert.deepEqual(normalizeBurnMode({ accounts: ['x'] }), { accounts: ['x'], horizonMinutes: 60, deadlines: {} });
  assert.deepEqual(
    normalizeBurnMode({ deadlines: { ' PISNRZRS+META@TWO.GG ': '2026-10-27T00:00:00Z', 'meta:*': 'not-a-date' } }).deadlines,
    { 'pisnrzrs+meta@two.gg': '2026-10-27T00:00:00Z', 'meta:*': 'not-a-date' },
    'normalize coerces shape; validation reports the bad stamp, the pace math ignores it',
  );
  assert.deepEqual(resolveConfig({}).burnMode.deadlines, {});
});

test('deadlines: same identity semantics as accounts (id, lane, label/email, provider:*; case-insensitive)', () => {
  const at = (iso) => Date.parse(iso);
  const cfg = normalizeBurnMode({
    accounts: ['meta:*'],
    deadlines: {
      'pisnrzrs+meta@two.gg': '2026-10-27T00:00:00Z',
      'meta-lane-4': '2026-10-28T00:00:00Z',
      'codex:*': '2026-11-01T00:00:00Z',
    },
  });
  const meta = (over = {}) => ({ accountId: 'meta:meta-lane-9', provider: 'meta', lane: 'meta-lane-9', ...over });
  assert.equal(burnDeadlineAtMs(cfg, meta({ label: 'PISNRZRS+META@two.gg' }), 'meta:meta-lane-9', TICK), at('2026-10-27T00:00:00Z'), 'label/email match');
  assert.equal(burnDeadlineAtMs(cfg, meta({ lane: 'META-LANE-4' }), 'meta:meta-lane-4', TICK), at('2026-10-28T00:00:00Z'), 'lane match');
  assert.equal(burnDeadlineAtMs(cfg, meta(), 'meta:meta-lane-9', TICK), null, 'no matcher matches this account');
  assert.equal(burnDeadlineAtMs(cfg, { accountId: 'codex:c1', provider: 'codex' }, 'codex:c1', TICK), at('2026-11-01T00:00:00Z'), 'provider:* match');
  assert.equal(burnDeadlineAtMs(cfg, { accountId: 'claude:c1', provider: 'claude' }, 'claude:c1', TICK), null);
  // Several matchers: the earliest future one wins.
  const multi = normalizeBurnMode({ accounts: ['x'], deadlines: { 'meta:*': '2026-10-29T00:00:00Z', 'meta-lane-9': '2026-10-27T00:00:00Z' } });
  assert.equal(burnDeadlineAtMs(multi, meta(), 'meta:meta-lane-9', TICK), at('2026-10-27T00:00:00Z'));
  assert.deepEqual(normalizeBurnMode(undefined).deadlines, {}, 'absent deadlines match nothing');
});

test('deadlines: a past deadline is ignored; an unparseable stamp never binds', () => {
  const cfg = normalizeBurnMode({
    accounts: ['x'],
    deadlines: { 'meta-lane-9': '2026-10-01T00:00:00Z', 'meta-lane-4': 'not-a-date' },
  });
  const acct = { accountId: 'meta:meta-lane-9', provider: 'meta', lane: 'meta-lane-9' };
  assert.equal(burnDeadlineAtMs(cfg, acct, 'meta:meta-lane-9', TICK), null, '10-01 is past at TICK (10-08)');
  assert.equal(
    burnPaceResetAtMs({ nowMs: TICK, resetAtMs: TICK + 48 * HOUR, deadlineAtMs: TICK - HOUR, cfg }),
    TICK + HOUR, 'a past deadline passed straight through is ignored too',
  );
});

test('pace target: a deadline before the reset shortens the target and names its source', () => {
  const cfg = normalizeBurnMode({ accounts: ['x'], horizonMinutes: 10080 });
  const t = (over) => burnPaceTarget({ nowMs: TICK, resetAtMs: TICK + 48 * HOUR, cfg, ...over });
  assert.deepEqual(t({ deadlineAtMs: TICK + 24 * HOUR }), { atMs: TICK + 24 * HOUR, source: 'deadline' });
  assert.deepEqual(t({}), { atMs: TICK + 48 * HOUR, source: 'reset' }, 'no deadline: the reset binds');
  assert.deepEqual(t({ deadlineAtMs: TICK + 72 * HOUR }), { atMs: TICK + 48 * HOUR, source: 'reset' }, 'a deadline past the reset never binds');
  assert.deepEqual(
    burnPaceTarget({ nowMs: TICK, resetAtMs: null, cfg: normalizeBurnMode({ accounts: ['x'] }) }),
    { atMs: TICK + HOUR, source: 'horizon' }, 'unknown reset: now + horizon',
  );
  assert.deepEqual(
    t({ horizonMs: TICK + 12 * HOUR, deadlineAtMs: TICK + 24 * HOUR }),
    { atMs: TICK + 12 * HOUR, source: 'horizon' }, 'an earlier burn horizon still wins over a later deadline',
  );
  // Bit-for-bit: a config with empty/non-matching deadlines paces exactly as without.
  const plain = normalizeBurnMode({ accounts: ['x'], horizonMinutes: 10080 });
  const dated = normalizeBurnMode({ accounts: ['x'], horizonMinutes: 10080, deadlines: { 'nobody:none': '2026-10-27T00:00:00Z' } });
  for (const args of [
    { nowMs: TICK, resetAtMs: TICK + 48 * HOUR },
    { nowMs: TICK, resetAtMs: TICK + 0.5 * HOUR, horizonMs: TICK + 0.25 * HOUR },
  ]) {
    assert.equal(burnPaceResetAtMs({ ...args, cfg: dated }), burnPaceResetAtMs({ ...args, cfg: plain }));
  }
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

test('plugin: a future deadline before the reset shortens the pace and is reported with its source', async () => {
  const deadline = new Date(TICK + 24 * HOUR).toISOString();
  const d = drive({
    config: {
      enforce: true, reviewReserve: { enabled: false },
      burnMode: { accounts: ['claude:a1'], horizonMinutes: 10080, deadlines: { 'claude:a1': deadline } },
    },
    accounts: [lane(0.9, 48)],
  });
  await d.setup();
  await d.tick();
  const cap = (await d.api('capacity')).body;
  const a = cap.accounts.find(x => x.accountId === 'claude:a1');
  assert.equal(a.burnMode, true);
  assert.equal(a.paceResetAtMs, TICK + 24 * HOUR);
  assert.equal(a.paceTargetAt, TICK + 24 * HOUR);
  assert.equal(a.paceTargetSource, 'deadline');
  // remaining 10% over 24 h, not 48 h and not now + 10080 min.
  assert.ok(Math.abs(a.requiredRatePerHour - 0.1 / 24) < 1e-9);
  for (const id of ['run-1', 'run-2', 'run-3']) assert.equal((await d.hook(id)).kind, 'decide', id);
});

test('plugin: 10-26 simulation — fresh weeks, P1 deadline 10-27 paces at remaining/24h (owner Meta MAX plan)', async () => {
  const NOW26 = Date.parse('2026-10-26T00:05:00Z');
  const WEEK = Date.parse('2026-11-02T00:00:00Z');
  const P1 = '2026-10-27T00:00:00Z';
  const P4 = '2026-10-28T00:00:00Z';
  const fresh = (key, used, label) => ({
    lane: key, provider: 'meta', accountKey: key, label, health: 'healthy',
    weekly: { used, resetsAt: new Date(WEEK).toISOString() },
    fiveHour: { used: 0.1, resetsAt: new Date(NOW26 + 4 * HOUR).toISOString() },
    observedAt: new Date(NOW26).toISOString(), quality: 'live',
    models: ['claude-opus-5-5'],
  });
  const d = drive({
    config: {
      enforce: true, reviewReserve: { enabled: false },
      burnMode: {
        accounts: ['meta:*'],
        horizonMinutes: 10080,
        deadlines: { 'pisnrzrs+meta@two.gg': P1, 'meta:meta-lane-4': P4 },
      },
    },
    accounts: [fresh('meta-lane-9', 0.02, 'pisnrzrs+meta@two.gg'), fresh('meta-lane-4', 0.02, 'other@two.gg')],
  });
  d.setNow(NOW26);
  d.setAccounts([fresh('meta-lane-9', 0.02, 'pisnrzrs+meta@two.gg'), fresh('meta-lane-4', 0.02, 'other@two.gg')]);
  await d.setup();
  await d.tick();
  const cap = (await d.api('capacity')).body;
  const p1 = cap.accounts.find(x => x.accountId === 'meta:meta-lane-9');
  assert.equal(p1.burnMode, true);
  assert.equal(p1.paceTargetAt, Date.parse(P1), 'P1 paces to the 10-27 deadline, not the fresh week');
  assert.equal(p1.paceTargetSource, 'deadline');
  const remaining = 0.98;
  assert.ok(Math.abs(p1.requiredRatePerHour - remaining / ((Date.parse(P1) - NOW26) / 3600000)) < 1e-9);
  assert.ok(
    Math.abs(p1.requiredRatePerHour - remaining / 24) / (remaining / 24) < 0.01,
    `P1 required ${p1.requiredRatePerHour} ≈ remaining/24h ${remaining / 24}`,
  );
  const p4 = cap.accounts.find(x => x.accountId === 'meta:meta-lane-4');
  assert.equal(p4.paceTargetAt, Date.parse(P4), 'P4 keeps its own 10-28 deadline');
  assert.equal(p4.paceTargetSource, 'deadline');
});

test('plugin: before the reset the reset still binds (deadlines only shorten after it)', async () => {
  // Host 10-21 ~21:00Z: reset 10-26, horizonMinutes 10080, P1 deadline 10-27.
  const now = Date.parse('2026-10-21T21:06:00Z');
  const reset = Date.parse('2026-10-26T00:00:00Z');
  const cfg = normalizeBurnMode({
    accounts: ['meta:*'], horizonMinutes: 10080, deadlines: { 'pisnrzrs+meta@two.gg': '2026-10-27T00:00:00Z' },
  });
  const acct = { accountId: 'meta:x', provider: 'meta', lane: 'meta-lane-9', label: 'pisnrzrs+meta@two.gg' };
  assert.equal(burnDeadlineAtMs(cfg, acct, 'meta:x', now), Date.parse('2026-10-27T00:00:00Z'));
  assert.deepEqual(
    burnPaceTarget({ nowMs: now, resetAtMs: reset, deadlineAtMs: Date.parse('2026-10-27T00:00:00Z'), cfg }),
    { atMs: reset, source: 'reset' },
  );
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
  assert.equal(await scenario({ burnMode: { accounts: [], deadlines: {} } }), absent, 'empty deadlines are a no-op');
  assert.equal(await scenario({ burnMode: { accounts: ['nobody:none'], deadlines: { 'nobody:none': '2026-10-27T00:00:00Z' } } }), absent, 'non-matching deadlines are a no-op');
  assert.equal(await scenario({ burnMode: { deadlines: { 'claude:a1': '2026-10-01T00:00:00Z' } } }), absent, 'deadlines alone (no accounts entry, past stamp) burn nothing');
  assert.doesNotMatch(absent, /burnMode|"burn"/);
});

// ------------------------------------------------ whole-percent meters

test('plugin: a flat whole-percent meter with a run in flight never reports 0%/h', async () => {
  const flat = (atMs) => [{ ...lane(0.5, 100), observedAt: new Date(atMs).toISOString() }];
  const run = async (withRun) => {
    const d = drive({ config: { enforce: true, reviewReserve: { enabled: false } }, accounts: flat(TICK) });
    await d.setup();
    await d.tick();
    if (withRun) assert.equal((await d.hook('run-live')).kind, 'decide');
    for (let m = 10; m <= 70; m += 10) {
      d.setNow(TICK + m * 60000);
      d.setAccounts(flat(TICK + m * 60000));
      await d.tick();
    }
    const cap = (await d.api('capacity')).body;
    return cap.accounts.find(a => a.accountId === 'claude:a1');
  };
  const busy = await run(true);
  assert.ok(busy.measuredRatePerHour > 0, `busy rate ${busy.measuredRatePerHour}`);
  assert.equal(busy.rateEstimate, 'tick-bound');
  const idle = await run(false);
  assert.equal(idle.measuredRatePerHour, 0);
  assert.equal(idle.rateEstimate, undefined);
});

test('order: a burn account on credit fallback never outranks plan headroom', () => {
  const r = orderAccountsWithPacing([
    view('claude:a', { pool: 'a', planAhead: -0.3, targetShare: 9, remainingPct: 0.5 }),
    view('codex:b', { pool: 'b', planAhead: 0.0, targetShare: 1, burn: true, creditFallback: true, remainingPct: 0 }),
    view('meta:c', { pool: 'c', planAhead: 0.0, targetShare: 1, burn: true, remainingPct: 0.5 }),
  ], { pacing: PACING });
  assert.deepEqual(ids(r), ['meta:c', 'claude:a', 'codex:b']);
});

test('burn: provider:label scopes an email to one provider; excludes win (owner config 2026-10-20)', async () => {
  const { normalizeBurnMode, isBurnAccount } = await import('../src/burnmode.mjs');
  const cfg = normalizeBurnMode({ accounts: ['codex:*', 'meta:*', '!meta:owner-b@example.test', '!meta:owner-a@example.test'] });
  assert.equal(isBurnAccount(cfg, { accountId: 'codex:codex-lane-1', provider: 'codex', label: 'owner-a@example.test' }), true);
  assert.equal(isBurnAccount(cfg, { accountId: 'meta:meta-lane-4', provider: 'meta', label: 'owner-a@example.test' }), false);
  assert.equal(isBurnAccount(cfg, { accountId: 'meta:meta-lane-7', provider: 'meta', label: 'owner-b@example.test' }), false);
  assert.equal(isBurnAccount(cfg, { accountId: 'meta:meta-lane-3', provider: 'meta', label: 'POOL-C@EXAMPLE.TEST' }), true);
  assert.equal(isBurnAccount(cfg, { accountId: 'claude:claude-lane-4', provider: 'claude', label: 'owner-b@example.test' }), false);
});

test('reviewer routing burn flag follows burn-mode rules', async () => {
  const { isBurnFlagged } = await import('../src/reviewerrouting.mjs');
  const t = new Set(['codex:*', 'meta:*', '!meta:owner-b@example.test']);
  assert.equal(isBurnFlagged({ accountId: 'meta:meta-lane-7', pool: 'meta', label: 'owner-b@example.test' }, t), false);
  assert.equal(isBurnFlagged({ accountId: 'meta:meta-lane-1', pool: 'meta', label: 'pool-d@example.test' }, t), true);
  assert.equal(isBurnFlagged({ accountId: 'claude:claude-lane-4', pool: 'claude', label: 'owner-b@example.test' }, t), false);
});

test('burn eligibility: a utilization-floored degraded burn lane stays allocatable until spent', async () => {
  const { burnEligibleAccounts, normalizeBurnMode } = await import('../src/burnmode.mjs');
  const cfg = normalizeBurnMode({ accounts: ['meta:*', '!meta:owner-a@example.test'] });
  const acc = (key, weekly, over = {}) => ({
    accountId: `meta:${key}`, provider: 'meta', accountKey: key, health: 'degraded',
    healthReason: `peak utilization ${weekly.toFixed(4)}`,
    weekly: { utilization: weekly }, fiveHour: { utilization: 0.3 }, ...over,
  });
  const input = [
    acc('meta-lane-1', 0.9),
    acc('meta-lane-2', 0.995),
    acc('meta-lane-3', 0.93, { fiveHour: { utilization: 0.99 } }),
    acc('meta-lane-4', 0.92, { label: 'owner-a@example.test' }),
    acc('meta-lane-6', 0.91, { healthReason: undefined }),
    { accountId: 'meta:meta-lane-8', provider: 'meta', accountKey: 'meta-lane-8', health: 'exhausted', weekly: { utilization: 0.999 } },
  ];
  const out = burnEligibleAccounts(cfg, input);
  assert.deepEqual(out.map(a => a.health), ['healthy', 'degraded', 'degraded', 'degraded', 'degraded', 'exhausted']);
  assert.equal(out[0].feedHealth, 'degraded');
  assert.equal(input[0].health, 'degraded', 'never mutates the feed accounts');
  assert.equal(burnEligibleAccounts(normalizeBurnMode(undefined), input), input, 'burn mode off returns the same array');
  assert.equal(burnEligibleAccounts(cfg, [input[1]]).length, 1);
  // Unknown weekly meter fails closed (stays degraded); an absent five-hour
  // meter is not a full bucket, so the account is restored.
  const noWeekly = burnEligibleAccounts(cfg, [acc('meta-lane-1', 0.9, { weekly: { utilization: null } })]);
  assert.equal(noWeekly[0].health, 'degraded');
  const noWeeklyObj = burnEligibleAccounts(cfg, [acc('meta-lane-1', 0.9, { weekly: undefined })]);
  assert.equal(noWeeklyObj[0].health, 'degraded');
  const noFive = burnEligibleAccounts(cfg, [acc('meta-lane-1', 0.9, { fiveHour: undefined })]);
  assert.equal(noFive[0].health, 'healthy');
  const nullFive = burnEligibleAccounts(cfg, [acc('meta-lane-1', 0.9, { fiveHour: { utilization: null } })]);
  assert.equal(nullFive[0].health, 'healthy');
});

test('plugin: a burn lane the feed floored to degraded at 90% still allocates; without burn it is excluded', async () => {
  const floored = { ...lane(0.92, 48), health: 'degraded', healthReason: 'peak utilization 0.9200' };
  const plain = drive({ config: { enforce: true, reviewReserve: { enabled: false } }, accounts: [floored] });
  await plain.setup();
  await plain.tick();
  const plainView = (await plain.api('capacity')).body.accounts.find(x => x.accountId === 'claude:a1');
  assert.equal(plainView.action, 'excluded');

  const d = drive({
    config: { enforce: true, reviewReserve: { enabled: false }, burnMode: { accounts: ['claude:a1'] } },
    accounts: [floored],
  });
  await d.setup();
  await d.tick();
  const view = (await d.api('capacity')).body.accounts.find(x => x.accountId === 'claude:a1');
  assert.notEqual(view.action, 'excluded');
  assert.equal(view.health, 'healthy');
  assert.equal(view.feedHealth, 'degraded');
  assert.equal((await d.hook('run-1')).kind, 'decide');

  const failing = drive({
    config: { enforce: true, reviewReserve: { enabled: false }, burnMode: { accounts: ['claude:a1'] } },
    accounts: [{ ...lane(0.92, 48), health: 'degraded' }],
  });
  await failing.setup();
  await failing.tick();
  const failView = (await failing.api('capacity')).body.accounts.find(x => x.accountId === 'claude:a1');
  assert.equal(failView.action, 'excluded', 'degraded for another reason (no utilization floor) stays out');
});
