import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { decide, DEFAULT_CONTEXT_CAPS, MAX_CONTEXT_ENV_KEY, AUTO_COMPACT_ENV_KEY } from '../src/decide.mjs';
import {
  tierModelKey, matchPricingTier, overFractionAt, blendedMultiplier,
  expectedMultiplier, armTierCost, armTierCap, tierCapsByFamily,
  fleetBaselineForModels, median,
} from '../src/tiers.mjs';
import { parseLaneBody } from '../src/cliproxy.mjs';

// Context pricing tiers (owner requirement): models whose per-request price
// rises past a prompt threshold reprice the ladder (C_eff = base x E[m]) and
// gate compact windows on feasibility (p10 < 0.6 x T, else NO cap).

const TICK = Date.parse('2026-10-09T12:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };

const closeTo = (actual, expected, eps = 1e-9) => {
  assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} ~= ${expected}`);
};

// Live-shape fixtures: Haiku 5x past 100k (fractionOver 0.98, p10 124k),
// Sol 2x past 272k (p10 58k).
const haikuTier = (overrides = {}) => ({
  overPromptTokens: 100000, appliesTo: 'whole_request', countsCached: true,
  multiplier: { input: 5, output: 5, cacheRead: 5, cacheWrite: 5 },
  pricesPerMTok: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  ...overrides,
});
const haikuStats = (overrides = {}) => ({
  requests: 412,
  promptTokens: { p10: 124000, p50: 210000, p90: 380000, p99: 500000 },
  fractionOver: { '100000': 0.98 },
  cacheReadShare: 0.7, meanOutputTokens: 3200,
  ...overrides,
});
const haikuEntry = (overrides = {}) => ({
  family: 'haiku', match: ['haiku'], vendor: 'anthropic',
  tiers: [haikuTier()], status: 'verified', source: 'vendor-page',
  verifiedAt: '2026-10-09T00:00:00Z', ...overrides,
});

test('tier keys strip provider prefixes, (effort) and [1m]', () => {
  assert.equal(tierModelKey('codex/gpt-6.1-sol(max)[1m]'), 'gpt-6.1-sol');
  assert.equal(tierModelKey('claude-haiku-5-5(max)'), 'claude-haiku-5-5');
  assert.equal(tierModelKey('Claude-Haiku-5-5'), 'claude-haiku-5-5');
  assert.equal(tierModelKey(null), null);
});

test('tier regexes match normalized ids; invalid regexes never match', () => {
  const tiers = [{ family: 'sol', match: ['gpt[-.]6[-.]1[-_]sol', '(unclosed'], tiers: [] }];
  assert.ok(matchPricingTier('gpt-6.1-sol', tiers));
  assert.ok(matchPricingTier('gpt-6-1-sol', tiers));
  assert.equal(matchPricingTier('gpt-6-luna', tiers), null);
});

test('over-fraction hits measured knots exactly, interpolates, clamps extremes', () => {
  const stats = { fractionOver: { '100000': 0.98, '200000': 0.4 } };
  assert.equal(overFractionAt(stats, 100000), 0.98);
  assert.equal(overFractionAt(stats, 200000), 0.4);
  closeTo(overFractionAt(stats, 150000), 0.69);
  assert.equal(overFractionAt(stats, 1000), 1.0);
  assert.equal(overFractionAt(stats, 999999), 0.0);
  assert.equal(overFractionAt({}, 100000), null);
});

test('whole_request E blends cost shares, then weights by over-probability', () => {
  // Blend by hand: fresh 63k@1 + read 147k@0.1 + out 3.2k@5, all 5x.
  // num = 315000 + 73500 + 80000 = 468500; den = 63000 + 14700 + 16000 = 93700.
  const stats = haikuStats();
  closeTo(blendedMultiplier(haikuTier(), stats, haikuTier().pricesPerMTok), 5.0);
  closeTo(expectedMultiplier([haikuTier()], stats, haikuTier().pricesPerMTok), 1 + 0.98 * 4);
  const cost = armTierCost({
    model: 'claude-haiku-5-5', costBase: 2.0,
    pricingTiers: [haikuEntry()],
    modelStats: { models: { 'claude-haiku-5-5': stats } },
  });
  assert.equal(cost.tierSource, 'verified');
  assert.equal(cost.statsRequests, 412);
  assert.equal(cost.tierThreshold, 100000);
  assert.equal(cost.tierAppliesTo, 'whole_request');
  closeTo(cost.costMultiplier, 4.92);
  closeTo(cost.costEffective, 9.84);
});

test('excess_only prices only the p50/p90 excess share', () => {
  const tier = haikuTier({ appliesTo: 'excess_only' });
  const stats = haikuStats();
  // Saturated: over 0.98 x excess (380k-100k)/210k -> capped share 1.0 x 4.
  closeTo(expectedMultiplier([tier], stats, tier.pricesPerMTok), 5.0);
  // Partial: over 0.98 x excess (150k-100k)/210k x 4.
  const partial = haikuStats({ promptTokens: { p10: 124000, p50: 210000, p90: 150000, p99: 500000 } });
  closeTo(expectedMultiplier([tier], partial, tier.pricesPerMTok), 1 + 0.98 * (50000 / 210000) * 4, 1e-9);
});

test('unverified tiers apply but are flagged', () => {
  const cost = armTierCost({
    model: 'claude-haiku-5-5', costBase: 2.0,
    pricingTiers: [haikuEntry({ status: 'unverified' })],
    modelStats: { models: { 'claude-haiku-5-5': haikuStats() } },
  });
  assert.equal(cost.tierSource, 'unverified');
  closeTo(cost.costMultiplier, 4.92);
});

test('no matching tier prices at base with source none', () => {
  const cost = armTierCost({
    model: 'kimi-k3-256k', costBase: 1.5,
    pricingTiers: [haikuEntry()], modelStats: { models: {} },
  });
  assert.deepEqual(
    [cost.costMultiplier, cost.costEffective, cost.tierSource, cost.statsRequests, cost.tierThreshold],
    [1, 1.5, 'none', 0, null],
  );
});

test('missing stats fall back to the fleet baseline, never the cheap tier', () => {
  const tiers = [haikuEntry()];
  const measured = { models: { 'claude-haiku-5-5': haikuStats() } };
  const baseline = fleetBaselineForModels(['claude-haiku-5-5'], tiers, measured);
  closeTo(baseline, 4.92);
  const unmeasured = armTierCost({
    model: 'claude-haiku-5-5-xhigh', costBase: 3.0,
    pricingTiers: [{ ...haikuEntry(), match: ['haiku'] }],
    modelStats: measured, baseline,
  });
  assert.equal(unmeasured.statsRequests, 0);
  closeTo(unmeasured.costMultiplier, 4.92);
  closeTo(unmeasured.costEffective, 14.76);
  // Nothing measured anywhere: assume the tier's own max multiplier.
  const blind = armTierCost({
    model: 'claude-haiku-5-5', costBase: 3.0,
    pricingTiers: [haikuEntry()], modelStats: { models: {} }, baseline: null,
  });
  assert.equal(blind.tierSource, 'verified');
  closeTo(blind.costMultiplier, 5.0);
});

test('countsCached=false scales the threshold by the uncached share', () => {
  const tier = haikuTier({ countsCached: false });
  const stats = haikuStats({ cacheReadShare: 0.5, fractionOver: { '100000': 0.98, '200000': 0.4 } });
  // Effective threshold 200k: over-fraction 0.4, not 0.98.
  closeTo(expectedMultiplier([tier], stats, tier.pricesPerMTok), 1 + 0.4 * 4);
});

test('multi-tier whole_request composes probability bands', () => {
  const tiers = [
    haikuTier({ overPromptTokens: 100000 }),
    haikuTier({ overPromptTokens: 200000, multiplier: { input: 10, output: 10, cacheRead: 10, cacheWrite: 10 } }),
  ];
  const stats = haikuStats({ fractionOver: { '100000': 0.98, '200000': 0.4 } });
  // Band [100k,200k): 0.58 @ blend1; band [200k,..): 0.4 @ blend2; under: 0.02 @ 1.
  const b1 = blendedMultiplier(tiers[0], stats, tiers[0].pricesPerMTok);
  const b2 = blendedMultiplier(tiers[1], stats, tiers[1].pricesPerMTok);
  closeTo(expectedMultiplier(tiers, stats, tiers[0].pricesPerMTok), 0.02 * 1 + 0.58 * b1 + 0.4 * b2, 1e-6);
});

test('feasibility gate: Haiku infeasible (no cap), Sol feasible (240k/220k)', () => {
  assert.equal(armTierCap({
    model: 'claude-haiku-5-5', pricingTiers: [haikuEntry()],
    modelStats: { models: { 'claude-haiku-5-5': haikuStats() } },
  }), null);
  const solStats = {
    requests: 96,
    promptTokens: { p10: 58000, p50: 120000, p90: 250000, p99: 300000 },
    fractionOver: { '272000': 0.12 }, cacheReadShare: 0.5, meanOutputTokens: 4000,
  };
  const solTier = haikuTier({ overPromptTokens: 272000 });
  assert.deepEqual(
    armTierCap({
      model: 'gpt-6.1-sol', pricingTiers: [{ ...haikuEntry(), match: ['sol'], tiers: [solTier] }],
      modelStats: { models: { 'gpt-6.1-sol': solStats } },
    }),
    { maxTokens: 240000, autoCompactTokens: 220000 },
  );
  // A feasible 300k cliff compacts just under it.
  const big = haikuTier({ overPromptTokens: 300000 });
  const bigStats = haikuStats({
    promptTokens: { p10: 100000, p50: 150000, p90: 200000, p99: 250000 },
    fractionOver: { '300000': 0.05 },
  });
  assert.deepEqual(
    armTierCap({
      model: 'm', pricingTiers: [{ ...haikuEntry(), match: ['^m$'], tiers: [big] }],
      modelStats: { models: { m: bigStats } },
    }),
    { maxTokens: 268000, autoCompactTokens: 248000 },
  );
  // No stats, no tier, or p10 exactly at the gate: no cap.
  assert.equal(armTierCap({ model: 'm', pricingTiers: [], modelStats: null }), null);
  assert.equal(tierCapsByFamily([{ family: 'sol', cap: null }]).sol, undefined);
  assert.deepEqual(
    tierCapsByFamily([
      { family: 'sol', cap: { maxTokens: 240000, autoCompactTokens: 220000 } },
      { family: 'sol', cap: { maxTokens: 200000, autoCompactTokens: 180000 } },
    ]).sol,
    { maxTokens: 200000, autoCompactTokens: 180000 },
  );
});

test('decide prefers tier windows over legacy keys, keeps legacy fallback', () => {
  const rungs = [{
    rung: 0,
    arms: [{ armId: 'a', model: 'gpt-6.1-sol', effort: 'max', family: 'sol', contextWindow: 272000, Q: 1, C: 1, trial: false }],
  }];
  const tiered = decide({
    runId: 'r', agentId: 'a', ladderRungs: rungs, accountId: 'codex:1',
    contextCaps: { ...DEFAULT_CONTEXT_CAPS, byFamily: { sol: { maxTokens: 240000, autoCompactTokens: 220000 } } },
  });
  assert.equal(tiered.env[MAX_CONTEXT_ENV_KEY], '240000');
  assert.equal(tiered.env[AUTO_COMPACT_ENV_KEY], '220000');
  const legacy = decide({
    runId: 'r', agentId: 'a', ladderRungs: rungs, accountId: 'codex:1',
    contextCaps: DEFAULT_CONTEXT_CAPS,
  });
  assert.equal(legacy.env[MAX_CONTEXT_ENV_KEY], '260000');
});

test('median helper', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([NaN, Infinity]), null);
});

test('lane body passes modelStats/pricingTiers through, tolerates junk', () => {
  const body = {
    observedAt: new Date(TICK).toISOString(), accounts: [],
    modelStats: { models: {} }, pricingTiers: [{ family: 'x' }],
  };
  const parsed = parseLaneBody(body, TICK);
  assert.deepEqual(parsed.modelStats, { models: {} });
  assert.deepEqual(parsed.pricingTiers, [{ family: 'x' }]);
  const bare = parseLaneBody({ accounts: [] }, TICK);
  assert.equal(bare.modelStats, null);
  assert.deepEqual(bare.pricingTiers, []);
  const junk = parseLaneBody({ accounts: [], modelStats: 42, pricingTiers: {} }, TICK);
  assert.equal(junk.modelStats, null);
  assert.deepEqual(junk.pricingTiers, []);
});

// End-to-end: a 5x tier on the cheap arm flips L0 to the pricey arm, and the
// per-arm tier fields surface in /ladder, /capacity, and the compact window
// lands in hook env via the live view.
test('tiered cheap arm loses L0; fields surface in ladder + capacity', async () => {
  const store = new Map();
  const jobs = new Map();
  const skey = k => JSON.stringify(k);
  const laneAccount = (models) => ({
    lane: 'l1', provider: 'claude', accountKey: 'a1',
    health: 'healthy', meter: 'metered', pool: null, models,
    weekly: { used: 0.1, resetsAt: null }, fiveHour: { used: 0.1, resetsAt: null },
    observedAt: new Date(TICK).toISOString(), quality: 'live',
  });
  // Cheap arm: live Haiku shape (5x past 100k, p10 124k -> infeasible).
  const cheapStats = {
    requests: 50,
    promptTokens: { p10: 124000, p50: 200000, p90: 300000, p99: 400000 },
    fractionOver: { '100000': 0.98 }, cacheReadShare: 0, meanOutputTokens: 1000,
  };
  // Pricey arm: mild 1.5x tier past 500k (E=1.1, feasible -> 468k window).
  const priceyStats = {
    requests: 30,
    promptTokens: { p10: 58000, p50: 100000, p90: 200000, p99: 250000 },
    fractionOver: { '500000': 0.2 }, cacheReadShare: 0, meanOutputTokens: 1000,
  };
  const book = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 };
  const laneBody = (withTiers) => ({
    observedAt: new Date(TICK).toISOString(),
    accounts: [laneAccount(['cheap-sol', 'pricey-luna'])],
    ...(withTiers ? {
      modelStats: {
        schemaVersion: 1, observedAt: new Date(TICK).toISOString(), windowHours: 24,
        thresholds: [100000, 500000],
        models: { 'cheap-sol': cheapStats, 'pricey-luna': priceyStats },
      },
      pricingTiers: [
        {
          family: 'sol', match: ['^cheap-sol$'], vendor: 'x',
          tiers: [haikuTier({ pricesPerMTok: book })],
          base: book, contextWindow: 200000,
          status: 'verified', source: 't', verifiedAt: '2026-10-09T00:00:00Z',
        },
        {
          family: 'luna', match: ['^pricey-luna$'], vendor: 'x',
          tiers: [haikuTier({
            overPromptTokens: 500000,
            multiplier: { input: 1.5, output: 1.5, cacheRead: 1.5, cacheWrite: 1.5 },
            pricesPerMTok: book,
          })],
          base: book, contextWindow: 500000,
          status: 'verified', source: 't', verifiedAt: '2026-10-09T00:00:00Z',
        },
      ],
    } : {}),
  });
  // Pricey scores HIGHER quality: flat both survive ([cheap L0, pricey L1]);
  // tiered the cheap arm (C_eff 4.92, lower Q) is dominated off the ladder.
  const aaRow = (slug, cost, index) => ({
    slug, intelligenceIndex: index, intelligenceIndexCostPerTask: cost,
    price1mInputTokens: 1, price1mOutputTokens: 4,
  });
  const armMap = [
    { aaSlug: 'cheap-sol', model: 'cheap-sol', effort: 'max', family: 'sol', providers: ['claude'] },
    { aaSlug: 'pricey-luna', model: 'pricey-luna', effort: 'max', family: 'luna', providers: ['claude'] },
  ];
  const rawConfig = {
    enforce: true,
    cliproxy: { laneKeySecretRef: SECRET },
    armMap,
    calibration: { referenceArmId: 'pricey-luna', referenceBurnPerRunPct: 0.0005 },
  };
  const runTick = async (withTiers) => {
    store.clear();
    jobs.clear();
    const io = {
      config: { get: async () => rawConfig },
      state: {
        get: async k => store.get(skey(k)) ?? null,
        set: async (k, v) => { store.set(skey(k), v); },
      },
      secrets: { resolve: async () => 'lane-key' },
      http: { fetch: async () => ({ status: 200, json: async () => laneBody(withTiers) }) },
      agents: { get: async () => null },
      issues: { get: async () => null, list: async () => [] },
      jobs: { register: (n, fn) => { jobs.set(n, fn); } },
      events: { on() {} },
      logger: { info() {}, error() {} },
    };
    const plugin = createModelCapacityPlugin({ clock: () => TICK });
    await plugin.setup(io);
    await plugin.onConfigChanged(rawConfig, { companyId: 'acme' });
    store.set(skey(AA_STATE_KEY), {
      fetchedAt: new Date(TICK).toISOString(),
      rows: [aaRow('cheap-sol', 1.0, 55), aaRow('pricey-luna', 2.0, 60)],
      duplicateSlugs: [],
    });
    await jobs.get('shadow-tick')({});
    const ladder = await plugin.onApiRequest({ companyId: 'acme', routeKey: 'ladder' });
    const capacity = await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' });
    return { ladder: ladder.body, capacity: capacity.body, plugin };
  };
  const flat = await runTick(false);
  const flatRungs = flat.ladder.ladders['claude:a1'].rungs;
  assert.deepEqual(flatRungs.map(r => r.armId), ['cheap-sol', 'pricey-luna']);
  assert.equal(flatRungs[0].tierSource, 'none');
  closeTo(flatRungs[0].costEffective, 1.0);
  const tiered = await runTick(true);
  const ladder = tiered.ladder.ladders['claude:a1'];
  // 1.0 x 4.92 = 4.92 at lower quality: dominated off; pricey takes L0.
  assert.deepEqual(ladder.rungs.map(r => r.armId), ['pricey-luna']);
  assert.ok(ladder.dominated.includes('cheap-sol'));
  const pricey = ladder.rungs[0];
  assert.equal(pricey.costBase, 2.0);
  closeTo(pricey.costMultiplier, 1.1);
  closeTo(pricey.costEffective, 2.2);
  assert.equal(pricey.tierSource, 'verified');
  assert.equal(pricey.statsRequests, 30);
  // /capacity carries the same per-arm fields plus the tier summary.
  const view = tiered.capacity.accounts.find(a => a.accountId === 'claude:a1');
  assert.ok(view);
  assert.equal(view.arms.length, 1);
  assert.equal(view.arms[0].tierSource, 'verified');
  closeTo(view.arms[0].costEffective, 2.2);
  // The feasible luna window reaches hook env through the live view.
  const hookOut = await tiered.plugin.onResolveRunModel({
    runId: 'run-hook', companyId: 'acme', agentId: 'agent-9', issueId: null,
    adapterType: 'claude-code', invocationSource: 'test', wakeReason: null,
    agentDefaultModel: null, previous: null, issueOverrideModel: null,
    deadlineMs: 1500,
  });
  assert.equal(hookOut.kind, 'decide');
  assert.equal(hookOut.env[MAX_CONTEXT_ENV_KEY], '468000');
  assert.equal(hookOut.env[AUTO_COMPACT_ENV_KEY], '448000');
  // Fleet baseline = median(4.92, 1.1) = 3.01; only the feasible luna window.
  closeTo(tiered.capacity.contextTiers.baselineMultiplier, 3.01);
  assert.deepEqual(
    tiered.capacity.contextTiers.caps,
    { luna: { maxTokens: 468000, autoCompactTokens: 448000 } },
  );
});
