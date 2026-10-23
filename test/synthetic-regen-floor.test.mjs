/**
 * 0.2.66: synthetic.new lanes spent at their regeneration rate.
 *
 * synthetic.new sells one weekly credit bar that refills +2% every 202 min
 * and never resets. Before 0.2.66 burn mode sorted the (reactive) lane first
 * and drained it to the feed's 5% reserve. Now:
 *   - burnMode.floors holds a matched account at a level floor (fail closed
 *     without a reading), and a burn account above its floor routes first,
 *     so spend tracks regeneration;
 *   - contextCaps.servedIds caps the window per emitted id (synthetic serves
 *     524,288 tokens; agents run with 1M);
 *   - a trials.roles entry 'role:family' opens one trial family to one role.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin, validateConfigShape } from '../src/plugin.mjs';
import { parseLaneAccount } from '../src/cliproxy.mjs';
import {
  normalizeBurnMode, validateBurnMode, applyBurnFloors, burnFloorFor, floorBarUsed,
} from '../src/burnmode.mjs';
import { orderAccountsWithPacing } from '../src/select.mjs';
import {
  decide, contextCapsEnv, normalizeContextCaps, validateServedIdCaps, servedIdKey, roleTakesTrial,
  roleLadderAccess, placementArm, DEFAULT_CONTEXT_CAPS, MAX_CONTEXT_ENV_KEY, AUTO_COMPACT_ENV_KEY,
} from '../src/decide.mjs';
import { manifest } from '../src/manifest.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const TICK = Date.parse('2026-10-23T18:00:00Z');
const HOUR = 3600 * 1000;
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };

// ------------------------------------------------------------ feed parse

test('feed: meterInfo.weeklyUsed parses as regenUsed; absent or invalid stays absent', () => {
  const base = { lane: 'synthetic-lane-1', provider: 'synthetic', accountKey: 'synthetic-lane-1', health: 'healthy', meter: 'reactive' };
  assert.equal(parseLaneAccount({ ...base, meterInfo: { weeklyUsed: 0.2, nextRegenAt: '2026-10-23T18:29:00Z' } }, TICK).regenUsed, 0.2);
  assert.equal(parseLaneAccount({ ...base, meterInfo: { weeklyUsed: 0 } }, TICK).regenUsed, 0);
  for (const meterInfo of [undefined, null, {}, { weeklyUsed: null }, { weeklyUsed: 1.5 }, { weeklyUsed: -0.1 }, { weeklyUsed: 'x' }, 'x']) {
    const a = parseLaneAccount({ ...base, ...(meterInfo === undefined ? {} : { meterInfo }) }, TICK);
    assert.equal('regenUsed' in a, false, JSON.stringify(meterInfo));
  }
  // Byte-identical parse for a feed entry without meterInfo.
  assert.deepEqual(parseLaneAccount(base, TICK), parseLaneAccount({ ...base }, TICK));
});

// ------------------------------------------------------------ floors config

test('config: burnMode.floors validates matchers and shares in [0, 1)', () => {
  assert.deepEqual(validateBurnMode({ floors: { 'synthetic:*': 0.8, 'meta-lane-3': 0 } }), []);
  assert.deepEqual(validateBurnMode({ floors: {} }), []);
  for (const floors of [null, [], 'x', 3]) {
    assert.equal(validateBurnMode({ floors }).length, 1, JSON.stringify(floors));
  }
  for (const v of [1, 1.2, -0.1, NaN, '0.8', null]) {
    assert.equal(validateBurnMode({ floors: { 'synthetic:*': v } }).length, 1, String(v));
  }
  assert.equal(validateBurnMode({ floors: { '  ': 0.5 } }).length, 1);
  assert.match(validateBurnMode({ floors: { '!synthetic:*': 0.5 } })[0], /cannot exclude/);
  assert.match(validateBurnMode({ floors: { 'Synthetic:*': 0.5, ' synthetic:* ': 0.6 } })[0], /duplicate/);
  assert.deepEqual(validateConfigShape({ cliproxy: { laneKeySecretRef: SECRET }, burnMode: { floors: { 'synthetic:*': 0.8 } } }), []);
  assert.equal(validateConfigShape({ cliproxy: { laneKeySecretRef: SECRET }, burnMode: { floors: { 'synthetic:*': 2 } } }).length, 1);
});

test('config: normalize lower-cases floor keys, keeps the higher floor, fails closed on bad values', () => {
  assert.equal('floors' in normalizeBurnMode(undefined), false, 'no floors key when none is set');
  assert.equal('floors' in normalizeBurnMode({ floors: {} }), false);
  assert.deepEqual(normalizeBurnMode({ floors: { ' Synthetic:* ': 0.6, 'synthetic:*': 0.8 } }).floors, { 'synthetic:*': 0.8 });
  assert.deepEqual(normalizeBurnMode({ floors: { 'synthetic:*': 'x', '!a': 0.5 } }).floors, { 'synthetic:*': 1 });
  const proto = normalizeBurnMode({ floors: JSON.parse('{"__proto__":0.7}') });
  assert.equal(Object.hasOwn(proto.floors, '__proto__'), true);
  assert.equal(burnFloorFor(proto, { accountId: '__proto__' }), 0.7);
});

test('floors: same identity semantics as accounts; the highest matching floor wins', () => {
  const cfg = normalizeBurnMode({ floors: { 'synthetic:*': 0.6, 'synthetic-lane-1': 0.8, 'Owner@Example.com': 0.5 } });
  const syn = { accountId: 'synthetic:synthetic-lane-1', provider: 'synthetic', lane: 'synthetic-lane-1' };
  assert.equal(burnFloorFor(cfg, syn), 0.8);
  assert.equal(burnFloorFor(cfg, { accountId: 'synthetic-infinite:synthetic-infinite-lane-1', provider: 'synthetic-infinite' }), null,
    'provider:* matches the exact provider only');
  assert.equal(burnFloorFor(cfg, { accountId: 'meta:meta-lane-2', provider: 'meta', email: 'owner@example.com' }), 0.5);
  assert.equal(burnFloorFor(normalizeBurnMode({}), syn), null);
});

// ------------------------------------------------------------ applyBurnFloors

const synAcct = (over = {}) => ({
  accountId: 'synthetic:synthetic-lane-1', provider: 'synthetic', lane: 'synthetic-lane-1',
  health: 'healthy', meter: 'reactive', quality: 'reactive', weekly: { utilization: null }, ...over,
});

test('applyBurnFloors: above the floor stays allocatable and is marked; at or below it is exhausted', () => {
  const cfg = normalizeBurnMode({ floors: { 'synthetic:*': 0.8 } });
  const [above] = applyBurnFloors(cfg, [synAcct({ regenUsed: 0.1 })]);
  assert.equal(above.health, 'healthy');
  assert.deepEqual(above.burnFloor, { floor: 0.8, remaining: 0.9 });
  const [at] = applyBurnFloors(cfg, [synAcct({ regenUsed: 0.2 })]);
  assert.equal(at.health, 'exhausted', 'exactly at the floor takes no runs');
  assert.equal(at.feedHealth, 'healthy');
  assert.equal(at.burnFloor.reason, 'burn floor 80% reached (80% left)');
  const [below] = applyBurnFloors(cfg, [synAcct({ regenUsed: 0.206 })]);
  assert.equal(below.health, 'exhausted');
  assert.equal(below.burnFloor.reason, 'burn floor 80% reached (79.4% left)');
});

test('applyBurnFloors: no reading fails closed; the weekly meter is the fallback reading', () => {
  const cfg = normalizeBurnMode({ floors: { 'synthetic:*': 0.8, 'claude:*': 0.2 } });
  const [none] = applyBurnFloors(cfg, [synAcct()]);
  assert.equal(none.health, 'unavailable');
  assert.match(none.burnFloor.reason, /no reading \(fail closed\)/);
  const claude = { accountId: 'claude:a1', provider: 'claude', health: 'healthy', weekly: { utilization: 0.75 } };
  assert.equal(floorBarUsed(claude), 0.75);
  assert.equal(applyBurnFloors(cfg, [claude])[0].health, 'healthy');
  assert.equal(applyBurnFloors(cfg, [{ ...claude, weekly: { utilization: 0.8 } }])[0].health, 'exhausted');
  // regenUsed wins over a weekly figure when both exist.
  assert.equal(floorBarUsed({ regenUsed: 0.1, weekly: { utilization: 0.9 } }), 0.1);
});

test('applyBurnFloors: feed-unhealthy accounts keep the feed verdict; no match returns the same array', () => {
  const cfg = normalizeBurnMode({ floors: { 'synthetic:*': 0.8 } });
  const exhausted = synAcct({ health: 'exhausted', regenUsed: 0.96 });
  assert.equal(applyBurnFloors(cfg, [exhausted])[0], exhausted);
  const other = [{ accountId: 'claude:a1', provider: 'claude', health: 'healthy', weekly: { utilization: 0.1 } }];
  assert.equal(applyBurnFloors(cfg, other), other);
  assert.equal(applyBurnFloors(normalizeBurnMode({}), [synAcct({ regenUsed: 0.5 })]).length, 1);
  const list = [synAcct({ regenUsed: 0.5 })];
  assert.equal(applyBurnFloors(normalizeBurnMode({ accounts: ['synthetic:*'] }), list), list);
  // A burn lane the utilization floor promoted keeps feedHealth 'degraded'.
  const promoted = synAcct({ regenUsed: 0.5, feedHealth: 'degraded' });
  assert.equal(applyBurnFloors(cfg, [promoted])[0].feedHealth, 'degraded');
});

// ------------------------------------------------------------ order

test('order: a burn account above its floor routes before other burn accounts; without the flag the order is unchanged', () => {
  const metered = {
    accountId: 'meta:m1', health: 'healthy', headroomPct: 0.9, requiredRatePerHour: 1, measuredRatePerHour: 0.5,
    targetShare: 3, burn: true, placementQ: 0.9,
  };
  const reactive = { accountId: 'synthetic:s1', health: 'healthy', meter: 'reactive', burn: true, placementQ: 0.4 };
  assert.deepEqual(orderAccountsWithPacing([reactive, metered]).order.map(v => v.accountId), ['meta:m1', 'synthetic:s1'],
    'without a floor a behind-plan metered burn lane (band 0) leads a reactive one (band 1)');
  assert.deepEqual(orderAccountsWithPacing([metered, { ...reactive, burnFirst: true }]).order.map(v => v.accountId),
    ['synthetic:s1', 'meta:m1']);
  // burnFirst without burn mode ranks as a plain account.
  assert.deepEqual(orderAccountsWithPacing([metered, { ...reactive, burn: false, burnFirst: true }]).order.map(v => v.accountId),
    ['meta:m1', 'synthetic:s1']);
  // An exhausted (floored) account never reaches the order.
  assert.deepEqual(orderAccountsWithPacing([metered, { ...reactive, burnFirst: true, health: 'exhausted' }]).order.map(v => v.accountId), ['meta:m1']);
});

// ------------------------------------------------------------ served-id caps

const GLM = 'synthetic/glm-5.3';
const SERVED = { 'synthetic/glm-5.3': { maxTokens: 480000, autoCompactTokens: 450000 }, 'Synthetic/Kimi-K3': { maxTokens: 480000 } };

test('servedIds: a synthetic arm gets its lane ceiling; unlisted ids and the defaults are unchanged', () => {
  const caps = normalizeContextCaps({ servedIds: SERVED });
  const want = { [MAX_CONTEXT_ENV_KEY]: '480000', [AUTO_COMPACT_ENV_KEY]: '450000' };
  assert.deepEqual(contextCapsEnv({ model: GLM, family: 'glm', cap: null }, caps), want);
  assert.deepEqual(contextCapsEnv({ model: `${GLM}(max)`, family: 'glm' }, caps), want, '(effort) decoration ignored');
  assert.deepEqual(contextCapsEnv({ model: 'SYNTHETIC/GLM-5.3[1m]', family: 'glm' }, caps), want, 'case and [1m] ignored');
  assert.deepEqual(contextCapsEnv({ model: 'synthetic/kimi-k3', family: 'kimi' }, caps), { [MAX_CONTEXT_ENV_KEY]: '480000' });
  assert.deepEqual(contextCapsEnv({ model: 'glm-5.3', family: 'glm' }, caps), {}, 'the bare id (another lane) is not capped');
  assert.deepEqual(contextCapsEnv({ model: 'zai/glm-5.3', family: 'glm' }, caps), {});
  assert.deepEqual(contextCapsEnv({ model: GLM, family: 'glm' }), {}, 'default caps carry no served ids');
  assert.deepEqual(contextCapsEnv({ model: GLM, family: 'glm' }, DEFAULT_CONTEXT_CAPS), {});
});

test('servedIds: a ceiling only lowers (tier caps, the Sol window), never raises', () => {
  const caps = normalizeContextCaps({ servedIds: { [GLM]: { maxTokens: 480000, autoCompactTokens: 450000 }, 'gpt-6.1-sol': { maxTokens: 990000, autoCompactTokens: 970000 }, 'devin/gpt-6-1-sol': { maxTokens: 400000 } } });
  assert.deepEqual(contextCapsEnv({ model: GLM, family: 'glm', cap: { maxTokens: 300000, autoCompactTokens: 280000 } }, caps),
    { [MAX_CONTEXT_ENV_KEY]: '300000', [AUTO_COMPACT_ENV_KEY]: '280000' });
  assert.deepEqual(contextCapsEnv({ model: GLM, family: 'glm', cap: { maxTokens: 500000, autoCompactTokens: 470000 } }, caps),
    { [MAX_CONTEXT_ENV_KEY]: '480000', [AUTO_COMPACT_ENV_KEY]: '450000' });
  assert.deepEqual(contextCapsEnv({ model: 'gpt-6.1-sol', family: 'sol' }, caps),
    { [MAX_CONTEXT_ENV_KEY]: '890000', [AUTO_COMPACT_ENV_KEY]: '870000' }, 'a wider served ceiling never raises Sol');
  assert.deepEqual(contextCapsEnv({ model: 'devin/gpt-6-1-sol', family: 'sol' }, caps),
    { [MAX_CONTEXT_ENV_KEY]: '400000', [AUTO_COMPACT_ENV_KEY]: '400000' }, 'compact never above the max window');
});

test('servedIds: config resolves, validates and normalizes; absent leaves the resolved caps unchanged', () => {
  assert.deepEqual(normalizeContextCaps({ autoCompactEnvKey: 'X' }), { ...normalizeContextCaps({}), autoCompactEnvKey: 'X' });
  assert.equal('servedIds' in normalizeContextCaps({}), false);
  assert.equal('servedIds' in normalizeContextCaps({ servedIds: {} }), false);
  assert.deepEqual(normalizeContextCaps({ servedIds: { ' Synthetic/GLM-5.3 ': { maxTokens: 480000.7 }, 'a': { maxTokens: 0 }, 'b': 3 } }).servedIds,
    { 'synthetic/glm-5.3': { maxTokens: 480000 } });
  assert.deepEqual(normalizeContextCaps({ servedIds: { 'x/y': { maxTokens: 500000 }, 'X/Y': { maxTokens: 400000 } } }).servedIds,
    { 'x/y': { maxTokens: 400000 } }, 'colliding keys keep the lower ceiling');
  assert.equal(servedIdKey('  '), null);
  assert.deepEqual(validateServedIdCaps(undefined), []);
  assert.deepEqual(validateServedIdCaps(SERVED), []);
  assert.equal(validateServedIdCaps([]).length, 1);
  assert.equal(validateServedIdCaps({ [GLM]: { maxTokens: 0 } }).length, 1);
  assert.equal(validateServedIdCaps({ [GLM]: { maxTokens: 480000, autoCompactTokens: 'x' } }).length, 1);
  assert.equal(validateServedIdCaps({ [GLM]: 480000 }).length, 1);
  assert.equal(validateConfigShape({ cliproxy: { laneKeySecretRef: SECRET }, contextCaps: { servedIds: { [GLM]: {} } } }).length, 1);
  const schema = manifest.instanceConfigSchema.properties;
  assert.ok(schema.contextCaps.properties.servedIds, 'servedIds is in the config schema (contextCaps is additionalProperties:false)');
  assert.ok(schema.burnMode.properties.floors, 'floors is in the config schema (burnMode is additionalProperties:false)');
});

// ------------------------------------------------------------ trial roles by family

const trialRungs = [{
  rung: 0,
  arms: [
    { armId: 'kimi-k3', model: 'synthetic/kimi-k3', family: 'kimi', Q: 0.9, qThinker: 0.9, qFleet: 0.9, qFleetThinker: 0.9, trial: true },
    { armId: 'glm-5.3', model: GLM, family: 'glm', Q: 0.5, qThinker: 0.6, qFleet: 0.5, qFleetThinker: 0.6, trial: true },
  ],
}];
const thinkerDecide = (trialRoles, extra = {}) => decide({
  runId: 'r1', agentId: 'ceo', role: 'thinker', ladderRungs: trialRungs, pointer: 0, accountId: 'synthetic:synthetic-lane-1',
  adapterType: 'claude_local', trialAdapters: { claude_local: ['*'] }, trialBudget: { glm: 2, kimi: 2 }, trialRoles, ...extra,
});

test('trials: a role:family entry opens exactly that family to that role', () => {
  assert.equal(roleTakesTrial(['doer', 'other'], 'thinker', 'glm'), false);
  assert.equal(roleTakesTrial(['doer', 'other', 'thinker:glm'], 'thinker', 'glm'), true);
  assert.equal(roleTakesTrial(['doer', 'other', ' Thinker:GLM '], 'thinker', 'glm'), true);
  assert.equal(roleTakesTrial(['doer', 'other', 'thinker:glm'], 'thinker', 'kimi'), false);
  assert.equal(roleTakesTrial(['doer', 'other', 'thinker:glm'], 'doer', 'kimi'), true);
  assert.equal(roleTakesTrial(['thinker:glm'], 'doer', 'glm'), false);
  assert.equal(roleTakesTrial(['thinker:glm'], 'thinker', null), false);

  assert.equal(thinkerDecide(['doer', 'other']).kind, 'defer', 'thinkers take no trial arms by default');
  const d = thinkerDecide(['doer', 'other', 'thinker:glm']);
  assert.equal(d.kind, 'decide');
  assert.equal(d.model, GLM, 'the higher-Q kimi trial arm stays closed to thinkers');
  assert.equal(d.trial, true);
  assert.equal(d.calibration, 'weak');
  assert.equal(thinkerDecide(['doer', 'other', 'thinker:glm'], { trialBudget: { glm: 0, kimi: 2 } }).kind, 'defer', 'family in-flight cap still applies');
  assert.equal(thinkerDecide(['doer', 'other', 'thinker:glm'], { excludedFamilies: ['arm:glm-5.3'] }).kind, 'defer', 'exclusions still apply');

  const opts = { role: 'thinker', trialRoles: ['doer', 'other', 'thinker:glm'] };
  assert.deepEqual(roleLadderAccess(trialRungs, opts), { eligible: true, trialOnly: true });
  assert.deepEqual(roleLadderAccess(trialRungs, { role: 'thinker', trialRoles: ['doer', 'other'] }), { eligible: false, trialOnly: false });
  assert.deepEqual(roleLadderAccess(trialRungs, { ...opts, excludedFamilies: ['glm'] }), { eligible: false, trialOnly: false });
  assert.equal(placementArm(trialRungs, opts).armId, 'glm-5.3');
  assert.equal(placementArm(trialRungs, { role: 'thinker', trialRoles: ['doer', 'other'] }), null);
  assert.equal(placementArm(trialRungs, { role: 'doer', trialRoles: ['doer', 'other', 'thinker:glm'] }).armId, 'kimi-k3', 'doers unchanged');
});

// ------------------------------------------------------------ plugin end to end

const aaRows = () => ([
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
  { slug: 'gemini-2-5-flash', intelligenceIndex: 54, intelligenceIndexCostPerTask: 5, price1mInputTokens: 1, price1mOutputTokens: 3 },
]);

const claudeLane = (used = 0.2) => ({
  lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy', label: 'seat-one',
  weekly: { used, resetsAt: new Date(TICK + 100 * HOUR).toISOString() },
  fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
  observedAt: new Date(TICK).toISOString(), quality: 'live',
  models: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
});

const synLane = (weeklyUsed, over = {}) => ({
  lane: 'synthetic-lane-1', provider: 'synthetic', accountKey: 'synthetic-lane-1', health: 'healthy',
  meter: 'reactive', quality: 'reactive', weekly: null, fiveHour: null,
  observedAt: new Date(TICK).toISOString(), models: ['synthetic/gemini-2-5-flash'],
  ...(weeklyUsed === undefined ? {} : { meterInfo: { weeklyUsed, nextRegenAt: '2026-10-23T18:29:00Z', regenStep: 0.02, reserve: 0.05 } }),
  ...over,
});

function drive({ config = {}, accounts }) {
  const store = new Map();
  const jobs = new Map();
  const skey = k => JSON.stringify(k);
  let now = TICK;
  let laneAccounts = accounts;
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET } }) },
    state: { get: async k => store.get(skey(k)) ?? null, set: async (k, v) => { store.set(skey(k), v); } },
    secrets: { resolve: async () => 'lane-key' },
    http: {
      fetch: async () => ({
        status: 200,
        json: async () => withSyntheticReadiness({ observedAt: new Date(now).toISOString(), accounts: laneAccounts }, now,
          { emitted: { synthetic: ['gemini-2-5-flash'] } }),
      }),
    },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: () => {} },
    logger: { info() {}, error() {}, warn() {} },
  };
  return {
    setAccounts: a => { laneAccounts = a; },
    setNow: ms => { now = ms; },
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    tick: () => jobs.get('shadow-tick')({ companyId: 'acme' }),
    hook: (runId, agentId = 'agent-9') => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId, issueId: null, adapterType: 'claude-code',
      invocationSource: 'test', wakeReason: null, agentDefaultModel: null, previous: null,
      issueOverrideModel: null, deadlineMs: 1500,
    }),
    view: async (id) => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body.accounts.find(a => a.accountId === id),
  };
}

const BASE = {
  enforce: true, reviewReserve: { enabled: false },
  burnMode: { accounts: ['seat-one', 'synthetic:*'], horizonMinutes: 10080 },
};
const withFloor = (floor = 0.8, extra = {}) => ({ ...BASE, burnMode: { ...BASE.burnMode, floors: { 'synthetic:*': floor } }, ...extra });

test('plugin: above its floor the synthetic burn lane routes first, emitting the prefixed id', async () => {
  const d = drive({ config: withFloor(0.8), accounts: [claudeLane(), synLane(0.1)] });
  await d.setup();
  await d.tick();
  const view = await d.view('synthetic:synthetic-lane-1');
  assert.deepEqual(view.burnFloor, { floor: 0.8, remaining: 0.9 });
  assert.equal(view.health, 'healthy');
  const run = await d.hook('run-1');
  assert.equal(run.kind, 'decide');
  assert.equal(run.model, 'synthetic/gemini-2-5-flash', 'prefixed-only: never the bare id');
  // Without a floor the behind-plan metered burn seat leads the reactive lane.
  const plain = drive({ config: BASE, accounts: [claudeLane(), synLane(0.1)] });
  await plain.setup();
  await plain.tick();
  assert.equal(String((await plain.hook('run-1')).model).startsWith('claude-'), true);
  assert.equal('burnFloor' in (await plain.view('synthetic:synthetic-lane-1')), false);
});

test('plugin: at the floor the lane leaves allocation with the floor as the reason, and returns after regeneration', async () => {
  const d = drive({ config: withFloor(0.8), accounts: [claudeLane(), synLane(0.2)] });
  await d.setup();
  await d.tick();
  const view = await d.view('synthetic:synthetic-lane-1');
  assert.equal(view.health, 'exhausted');
  assert.equal(view.feedHealth, 'healthy');
  assert.equal(view.action, 'excluded');
  assert.equal(view.reason, 'excluded: burn floor 80% reached (80% left) -- takes runs again once the bar is above the floor');
  assert.equal(String((await d.hook('run-1')).model).startsWith('claude-'), true);
  // A regeneration tick (+2%) lifts the bar over the floor: the lane serves again.
  d.setAccounts([claudeLane(), synLane(0.18)]);
  d.setNow(TICK + 2 * 60000);
  await d.tick();
  assert.equal((await d.view('synthetic:synthetic-lane-1')).health, 'healthy');
  assert.equal((await d.hook('run-2')).model, 'synthetic/gemini-2-5-flash');
});

test('plugin: a floored lane without a bar reading takes no runs (fail closed)', async () => {
  const d = drive({ config: withFloor(0.8), accounts: [claudeLane(), synLane(undefined)] });
  await d.setup();
  await d.tick();
  const view = await d.view('synthetic:synthetic-lane-1');
  assert.equal(view.health, 'unavailable');
  assert.match(view.reason, /no reading \(fail closed\)/);
  assert.equal(String((await d.hook('run-1')).model).startsWith('claude-'), true);
});

test('plugin: thinkers take a synthetic trial arm only through a role:family entry', async () => {
  const thinkers = { roles: { thinkerAgentIds: ['ceo'] } };
  const closed = drive({ config: withFloor(0.8, thinkers), accounts: [synLane(0.1)] });
  await closed.setup();
  await closed.tick();
  assert.equal((await closed.hook('run-1', 'ceo')).kind, 'defer', 'thinkers take no trial arms by default');
  const open = drive({ config: withFloor(0.8, { ...thinkers, trials: { roles: ['doer', 'other', 'thinker:gemini'] } }), accounts: [synLane(0.1)] });
  await open.setup();
  await open.tick();
  const run = await open.hook('run-1', 'ceo');
  assert.equal(run.kind, 'decide');
  assert.equal(run.model, 'synthetic/gemini-2-5-flash');
  const other = drive({ config: withFloor(0.8, { ...thinkers, trials: { roles: ['doer', 'other', 'thinker:glm'] } }), accounts: [synLane(0.1)] });
  await other.setup();
  await other.tick();
  assert.equal((await other.hook('run-1', 'ceo')).kind, 'defer', 'another family stays closed');
});

test('plugin: servedIds caps the decision env of a synthetic run', async () => {
  const d = drive({
    config: withFloor(0.8, { contextCaps: { servedIds: { 'synthetic/gemini-2-5-flash': { maxTokens: 480000, autoCompactTokens: 450000 } } } }),
    accounts: [synLane(0.1)],
  });
  await d.setup();
  await d.tick();
  const run = await d.hook('run-1');
  assert.equal(run.model, 'synthetic/gemini-2-5-flash');
  assert.deepEqual(run.env, { [MAX_CONTEXT_ENV_KEY]: '480000', [AUTO_COMPACT_ENV_KEY]: '450000' });
});

test('regression: absent or empty floors, servedIds and plain trial roles decide bit-for-bit as before', async () => {
  const scenario = async (extra) => {
    const accounts = [claudeLane(0.3), synLane(0.1)];
    const d = drive({ config: { ...BASE, roles: { thinkerAgentIds: ['ceo'] }, ...extra }, accounts });
    await d.setup();
    await d.tick();
    const hooks = [];
    for (const [id, agent] of [['r1', 'agent-9'], ['r2', 'ceo'], ['r3', 'agent-9'], ['r4', 'ceo']]) hooks.push(await d.hook(id, agent));
    d.setNow(TICK + 5 * 60000);
    await d.tick();
    const views = [await d.view('claude:a1'), await d.view('synthetic:synthetic-lane-1')];
    return JSON.stringify({ hooks, views });
  };
  const absent = await scenario({});
  assert.equal(await scenario({ burnMode: { ...BASE.burnMode, floors: {} } }), absent);
  assert.equal(await scenario({ burnMode: { ...BASE.burnMode, floors: { 'nobody:*': 0.5 } } }), absent);
  assert.equal(await scenario({ contextCaps: { servedIds: {} } }), absent);
  assert.equal(await scenario({ contextCaps: { servedIds: { 'nobody/x': { maxTokens: 1000 } } } }), absent);
  assert.equal(await scenario({ trials: { roles: ['doer', 'other'] } }), absent);
  assert.doesNotMatch(absent, /burnFloor|burnFirst|regenUsed/);
});
