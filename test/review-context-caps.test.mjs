/**
 * 0.2.65: GPT-6.1 Sol runs at the 890k window on every path; Luna (and
 * pre-6.1 Sol ids) stay under the 272k price cliff.
 *
 * OpenAI charges no long-context fee on GPT-6.1 Sol subscription usage
 * (2026-10-11; the 272k surcharge is API pay-as-you-go only), so Sol has no
 * price cap, only the server ceiling: measured 2026-10-22 through CLIProxy,
 * 917,354 input tokens accepted and ~941k rejected (context_too_large), so
 * ~922k. Sol: CLAUDE_CODE_MAX_CONTEXT_TOKENS=890000 /
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW=870000 (contextCaps.solMaxTokens /
 * solAutoCompactTokens, 32k / 52k under it), a ceiling a feed tier cap may
 * lower, never raise. Luna: 260000/240000
 * (lunaMaxTokens / lunaAutoCompactTokens; the legacy solLuna* keys alias
 * them). 0.2.61 routed reviews with `env: {}`, so a review on a Sol arm ran
 * under the agent's base-config window, and a `keep` answer carries no env
 * at all. One helper (contextCapsEnv) now builds the env for decide(),
 * routed reviews and the keep paths, so the paths cannot drift again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin, resolveConfig } from '../src/plugin.mjs';
import { manifest, MODEL_ROUTING_ENV_KEYS } from '../src/manifest.mjs';
import {
  decide, contextCapsEnv, normalizeContextCaps, isSolWindowModel, needsContextCap,
  CAPPED_CONTEXT_FAMILIES, DEFAULT_CONTEXT_CAPS,
  MAX_CONTEXT_ENV_KEY, AUTO_COMPACT_ENV_KEY, MAX_OUTPUT_ENV_KEY,
} from '../src/decide.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const TICK = Date.parse('2026-10-22T18:30:00Z');
const HOUR = 3600000;
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const key = stateKey => ({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey });
const SOL = 'gpt-6.1-sol';
const LUNA = 'gpt-6.1-luna';
const WONDER = 'muse-wonder-full-1.0-contributor';
const caps = (max, compact) => ({ [MAX_CONTEXT_ENV_KEY]: String(max), [AUTO_COMPACT_ENV_KEY]: String(compact) });
const SOL_CAPS = caps(890000, 870000);
const LUNA_CAPS = caps(260000, 240000);
// The measured subscription input ceiling (2026-10-22) the feed's gpt-6-1-sol
// "window" tier carries; tiers.mjs derives T - 32k / T - 52k = SOL_CAPS.
const SOL_CEILING = 922000;
// A stale 500k window tier (the pre-0.2.65 feed) derives this lower window.
const SOL_500K_TIER_CAPS = caps(468000, 448000);

const aaRows = () => [
  { slug: 'claude-opus-5-5', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
  { slug: 'gpt-6-1-sol-high', intelligenceIndex: 61, intelligenceIndexCostPerTask: 20, price1mInputTokens: 2, price1mOutputTokens: 10 },
  { slug: 'gpt-6-1-luna-high', intelligenceIndex: 50, intelligenceIndexCostPerTask: 4, price1mInputTokens: 0.5, price1mOutputTokens: 2 },
];

const window = (used, hoursLeft) => ({
  weekly: { used, resetsAt: new Date(TICK + hoursLeft * HOUR).toISOString() },
  fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
  observedAt: new Date(TICK).toISOString(), quality: 'live',
});
const claudeLane = (used = 0.5, hoursLeft = 24) => ({
  lane: 'claude-1', provider: 'claude', accountKey: 'a1', health: 'healthy', ...window(used, hoursLeft),
  models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
});
const metaLane = (used = 0.5, hoursLeft = 24) => ({
  lane: 'meta-lane-3', provider: 'meta', accountKey: 'meta-lane-3', health: 'healthy', ...window(used, hoursLeft),
  models: [WONDER, 'muse-spark-1.3-contributor'],
});
const codexLane = (used = 0.1, hoursLeft = 24, models = [SOL, LUNA]) => ({
  lane: 'codex-1', provider: 'codex', accountKey: 'c1', health: 'healthy', ...window(used, hoursLeft), models,
});

const book = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 };
const solStats = () => ({
  requests: 96,
  promptTokens: { p10: 58000, p50: 120000, p90: 250000, p99: 300000 },
  fractionOver: { 272000: 0.12, 500000: 0 }, cacheReadShare: 0.5, meanOutputTokens: 4000,
});
// Feed Sol tier at `threshold` (p10 58k: feasible, so tiers.mjs derives a
// cap of threshold - 32k / threshold - 52k onto the Sol arms).
const solTierFeed = ({ threshold = 272000, appliesTo = 'whole_request', mult = 2 } = {}) => ({
  modelStats: {
    schemaVersion: 1, observedAt: new Date(TICK).toISOString(), windowHours: 24, thresholds: [272000, 500000],
    models: { [SOL]: solStats() },
  },
  pricingTiers: [{
    family: 'gpt-6-1-sol', match: ['^gpt-6\\.1-sol', '^gpt-6[.-]1-sol'], vendor: 'openai',
    tiers: [{
      overPromptTokens: threshold, appliesTo, countsCached: true,
      multiplier: { input: mult, output: mult, cacheRead: mult, cacheWrite: mult }, pricesPerMTok: book,
    }],
    base: book, status: 'verified', source: 'vendor-page', verifiedAt: '2026-10-22T00:00:00Z',
  }],
});
// The live price-tier feed shape: a ~922k "window" tier (the measured
// ceiling) with no price multiplier (subscription usage pays no
// long-context fee).
const liveSolWindowFeed = () => solTierFeed({ threshold: SOL_CEILING, appliesTo: 'window', mult: 1 });
// The pre-0.2.65 feed: the same window tier at 500k.
const stale500kWindowFeed = () => solTierFeed({ threshold: 500000, appliesTo: 'window', mult: 1 });

function drive({ arms = null, accounts, overrides = {}, feedExtra = {}, rows = aaRows() } = {}) {
  const config = {
    enforce: true,
    credentialReadiness: { enforce: false },
    roles: {
      keepAgentIds: ['reviewer-1'],
      minQuality: { doer: null, thinker: null, other: null },
      outcomeGate: { enabled: false },
    },
    ...(arms ? { reviewerRouting: { agentIds: ['reviewer-1'], arms } } : {}),
    ...overrides,
  };
  const store = new Map();
  const jobs = new Map();
  let now = TICK;
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET } }) },
    state: {
      get: async k => store.get(JSON.stringify(k)) ?? null,
      set: async (k, v) => { store.set(JSON.stringify(k), v); },
    },
    secrets: { resolve: async () => 'synthetic-lane-key' },
    http: { fetch: async () => ({
      status: 200,
      json: async () => withSyntheticReadiness({ observedAt: new Date(now).toISOString(), accounts, ...feedExtra }, now),
    }) },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (name, fn) => { jobs.set(name, fn); } },
    events: { on() {} },
    logger: { info() {}, error() {} },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return {
    start: async () => {
      await plugin.setup(io);
      store.set(JSON.stringify(key('aa-snapshot-v1')), { fetchedAt: new Date(now).toISOString(), rows, duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
      await jobs.get('shadow-tick')({ companyId: 'acme' });
    },
    setNow: ms => { now = ms; },
    tick: () => jobs.get('shadow-tick')({ companyId: 'acme' }),
    hook: (runId, extra = {}) => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId: 'reviewer-1', issueId: 'issue-1', adapterType: 'claude_local',
      invocationSource: 'test', wakeReason: null, agentDefaultModel: null, previous: null,
      issueOverrideModel: null, deadlineMs: 1500, ...extra,
    }),
    api: async routeKey => (await plugin.onApiRequest({ companyId: 'acme', routeKey })).body,
  };
}

// ---------- 1. the shared helper ----------

test('isSolWindowModel: GPT-6.1 Sol in every served spelling, nothing else', () => {
  for (const m of [SOL, 'GPT-6.1-Sol', 'gpt-6-1-sol', 'devin/gpt-6-1-sol', 'codex/gpt-6.1-sol', `${SOL}(high)`, `${SOL}(max)[1m]`]) {
    assert.equal(isSolWindowModel(m), true, m);
  }
  for (const m of ['gpt-6-sol', 'gpt-5.6-sol', 'gpt-5-6-sol', 'gpt-6.1-luna', 'gpt-6-luna', 'gpt-6.10-sol', 'model_private_gpt', WONDER, '', null, undefined, 7]) {
    assert.equal(isSolWindowModel(m), false, String(m));
  }
  assert.deepEqual(CAPPED_CONTEXT_FAMILIES, ['sol', 'luna']);
  assert.equal(needsContextCap('luna', 'gpt-6-luna'), true);
  assert.equal(needsContextCap('sol', 'gpt-6-sol'), true);
  // A GPT-6.1 Sol id is capped even under an unexpected arm-map family.
  assert.equal(needsContextCap('gpt', SOL), true);
  assert.equal(needsContextCap('muse', WONDER), false);
  assert.equal(needsContextCap('haiku', 'claude-haiku-5-5'), false);
});

test('contextCapsEnv: Sol 890k window, Luna 260k cliff caps, haiku output cap, others empty', () => {
  assert.deepEqual(contextCapsEnv({ family: 'sol', model: SOL, cap: null }), SOL_CAPS);
  assert.deepEqual(contextCapsEnv({ family: 'sol', model: 'devin/gpt-6-1-sol' }), SOL_CAPS);
  assert.deepEqual(contextCapsEnv({ family: 'sol', model: `${SOL}(xhigh)` }), SOL_CAPS);
  assert.deepEqual(contextCapsEnv({ family: 'luna', model: LUNA }), LUNA_CAPS);
  assert.deepEqual(contextCapsEnv({ family: 'luna', model: 'gpt-6-luna' }), LUNA_CAPS);
  // Pre-6.1 Sol ids are not covered by the GPT-6.1 Sol change: cliff caps.
  assert.deepEqual(contextCapsEnv({ family: 'sol', model: 'gpt-6-sol' }), LUNA_CAPS);
  assert.deepEqual(contextCapsEnv({ family: 'sol', model: 'gpt-5.6-sol' }), LUNA_CAPS);
  // A sol-family arm with no model id is never treated as the Sol window.
  assert.deepEqual(contextCapsEnv({ family: 'sol' }), LUNA_CAPS);
  assert.deepEqual(contextCapsEnv({ family: 'haiku', cap: null }), { [MAX_OUTPUT_ENV_KEY]: '64000' });
  assert.deepEqual(contextCapsEnv({ family: 'opus', model: 'claude-opus-5-5', cap: null }), {});
  assert.deepEqual(contextCapsEnv({ family: 'muse', model: WONDER, cap: null }), {});
  assert.deepEqual(contextCapsEnv({}), {});
  assert.deepEqual(contextCapsEnv(null), {});
});

test('contextCapsEnv: a tier cap lowers the Sol window, never raises it; other arms keep 0.2.61 tier semantics', () => {
  const sol = (cap) => contextCapsEnv({ family: 'sol', model: SOL, cap });
  assert.deepEqual(sol({ maxTokens: 468000, autoCompactTokens: 448000 }), SOL_500K_TIER_CAPS);
  assert.deepEqual(sol({ maxTokens: 240000, autoCompactTokens: 220000 }), caps(240000, 220000));
  // The 922k tier's cap equals the ceiling; anything wider stays on it.
  assert.deepEqual(sol({ maxTokens: 890000, autoCompactTokens: 870000 }), SOL_CAPS);
  assert.deepEqual(sol({ maxTokens: 968000, autoCompactTokens: 948000 }), SOL_CAPS, 'never raised past 890k');
  assert.deepEqual(sol({ maxTokens: 1018000, autoCompactTokens: 998000 }), SOL_CAPS, 'a 1.05M tier never raises it');
  assert.deepEqual(sol({ maxTokens: 1e12, autoCompactTokens: 1e12 }), SOL_CAPS);
  assert.deepEqual(sol({ maxTokens: 890001, autoCompactTokens: 870001 }), SOL_CAPS);
  // Mixed: max lowered, compact clamped under it.
  assert.deepEqual(sol({ maxTokens: 880000, autoCompactTokens: null }), caps(880000, 870000));
  assert.deepEqual(sol({ maxTokens: 450000, autoCompactTokens: null }), caps(450000, 450000));
  // A wider max with a lower compact: max stays on the ceiling, compact lowers.
  assert.deepEqual(sol({ maxTokens: 968000, autoCompactTokens: 800000 }), caps(890000, 800000));
  // Infeasible (null/zero) tier caps fall back to the window.
  assert.deepEqual(sol({ maxTokens: 0, autoCompactTokens: 0 }), SOL_CAPS);
  assert.deepEqual(sol(null), SOL_CAPS);
  // Luna and other families: the tier cap as is (the live Luna 240k/220k).
  assert.deepEqual(contextCapsEnv({ family: 'luna', model: 'gpt-6-luna', cap: { maxTokens: 240000, autoCompactTokens: 220000 } }), caps(240000, 220000));
  assert.deepEqual(contextCapsEnv({ family: 'luna', model: 'gpt-6-luna', cap: { maxTokens: 468000, autoCompactTokens: 448000 } }), caps(468000, 448000));
  assert.deepEqual(contextCapsEnv({ family: 'luna', model: 'gpt-6-luna', cap: { maxTokens: 0 } }), LUNA_CAPS);
  assert.deepEqual(
    contextCapsEnv({ family: 'gemini', model: 'gemini-3-pro', cap: { maxTokens: 168000.7, autoCompactTokens: 148000 } }),
    caps(168000, 148000),
  );
  assert.deepEqual(contextCapsEnv({ family: 'gemini', model: 'gemini-3-pro', cap: { maxTokens: 168000 } }), { [MAX_CONTEXT_ENV_KEY]: '168000' });
});

test('contextCapsEnv: operator caps, custom/null compact key, broken config falls back to defaults', () => {
  const custom = { ...DEFAULT_CONTEXT_CAPS, solMaxTokens: 400000, solAutoCompactTokens: 380000, lunaMaxTokens: 250000, lunaAutoCompactTokens: 230000 };
  assert.deepEqual(contextCapsEnv({ family: 'sol', model: SOL }, custom), caps(400000, 380000));
  assert.deepEqual(contextCapsEnv({ family: 'luna', model: LUNA }, custom), caps(250000, 230000));
  // The configured Sol window is still the ceiling over a wider tier.
  assert.deepEqual(contextCapsEnv({ family: 'sol', model: SOL, cap: { maxTokens: 468000, autoCompactTokens: 448000 } }, custom), caps(400000, 380000));
  // Compact never sits above the window.
  assert.deepEqual(contextCapsEnv({ family: 'sol', model: SOL }, { ...DEFAULT_CONTEXT_CAPS, solMaxTokens: 300000 }), caps(300000, 300000));
  assert.deepEqual(
    contextCapsEnv({ family: 'sol', model: SOL }, { ...DEFAULT_CONTEXT_CAPS, autoCompactEnvKey: null }),
    { [MAX_CONTEXT_ENV_KEY]: '890000' },
  );
  assert.deepEqual(
    contextCapsEnv({ family: 'sol', model: SOL }, { ...DEFAULT_CONTEXT_CAPS, autoCompactEnvKey: 'CUSTOM_COMPACT' }),
    { [MAX_CONTEXT_ENV_KEY]: '890000', CUSTOM_COMPACT: '870000' },
  );
  // Missing caps, or non-positive values, never emit an uncapped Sol run.
  assert.deepEqual(contextCapsEnv({ family: 'sol', model: SOL }, null), SOL_CAPS);
  assert.deepEqual(contextCapsEnv({ family: 'sol', model: SOL }, undefined), SOL_CAPS);
  assert.deepEqual(contextCapsEnv({ family: 'sol', model: SOL }, { autoCompactEnvKey: AUTO_COMPACT_ENV_KEY }), SOL_CAPS);
  assert.deepEqual(contextCapsEnv({ family: 'sol', model: SOL }, { ...DEFAULT_CONTEXT_CAPS, solMaxTokens: 0, solAutoCompactTokens: -5 }), SOL_CAPS);
  assert.deepEqual(contextCapsEnv({ family: 'luna', model: LUNA }, { ...DEFAULT_CONTEXT_CAPS, lunaMaxTokens: 'x' }), LUNA_CAPS);
});

// ---------- 2. config: new keys, backward compatibility ----------

test('normalizeContextCaps: defaults, new keys, legacy solLuna* keys alias Luna only', () => {
  const d = normalizeContextCaps(undefined);
  assert.equal(d.solMaxTokens, 890000);
  assert.equal(d.solAutoCompactTokens, 870000);
  assert.equal(d.lunaMaxTokens, 260000);
  assert.equal(d.lunaAutoCompactTokens, 240000);
  assert.equal(d.autoCompactEnvKey, AUTO_COMPACT_ENV_KEY);
  assert.equal(d.haikuMaxOutputTokens, 64000);
  assert.equal(d.tierAffectsQuota, true);
  assert.deepEqual(normalizeContextCaps(null), d);
  assert.deepEqual(normalizeContextCaps([]), d);
  // The exact live 0.2.61 config: Luna keeps 260k/240k, Sol takes its window.
  const live = normalizeContextCaps({
    solLunaMaxTokens: 260000, autoCompactEnvKey: AUTO_COMPACT_ENV_KEY,
    haikuMaxOutputTokens: 64000, solLunaAutoCompactTokens: 240000,
  });
  assert.equal(live.solMaxTokens, 890000);
  assert.equal(live.solAutoCompactTokens, 870000);
  assert.equal(live.lunaMaxTokens, 260000);
  assert.equal(live.lunaAutoCompactTokens, 240000);
  assert.equal('solLunaMaxTokens' in live, false);
  assert.equal('solLunaAutoCompactTokens' in live, false);
  // A legacy key never pins (or raises) the Sol window.
  const legacy = normalizeContextCaps({ solLunaMaxTokens: 250000, solLunaAutoCompactTokens: 230000 });
  assert.equal(legacy.lunaMaxTokens, 250000);
  assert.equal(legacy.lunaAutoCompactTokens, 230000);
  assert.equal(legacy.solMaxTokens, 890000);
  assert.equal(legacy.solAutoCompactTokens, 870000);
  const raised = normalizeContextCaps({ solLunaMaxTokens: 1000000 });
  assert.equal(raised.solMaxTokens, 890000);
  // Explicit new keys win over the legacy aliases.
  const both = normalizeContextCaps({
    solLunaMaxTokens: 250000, solLunaAutoCompactTokens: 230000,
    lunaMaxTokens: 255000, lunaAutoCompactTokens: 235000,
    solMaxTokens: 450000, solAutoCompactTokens: 420000,
  });
  assert.deepEqual(
    [both.lunaMaxTokens, both.lunaAutoCompactTokens, both.solMaxTokens, both.solAutoCompactTokens],
    [255000, 235000, 450000, 420000],
  );
  // Rollback switch and operator keys survive.
  const rb = normalizeContextCaps({ tierAffectsQuota: false, autoCompactEnvKey: null, haikuMaxOutputTokens: 32000 });
  assert.equal(rb.tierAffectsQuota, false);
  assert.equal(rb.autoCompactEnvKey, null);
  assert.equal(rb.haikuMaxOutputTokens, 32000);
  // resolveConfig wires the same normalizer.
  assert.deepEqual(resolveConfig({ contextCaps: { solLunaMaxTokens: 250000 } }).contextCaps, normalizeContextCaps({ solLunaMaxTokens: 250000 }));
});

test('manifest schema declares the new keys with the defaults and keeps the legacy aliases', () => {
  const props = manifest.instanceConfigSchema.properties.contextCaps.properties;
  assert.equal(manifest.instanceConfigSchema.properties.contextCaps.additionalProperties, false);
  assert.equal(props.solMaxTokens.default, DEFAULT_CONTEXT_CAPS.solMaxTokens);
  assert.equal(props.solAutoCompactTokens.default, DEFAULT_CONTEXT_CAPS.solAutoCompactTokens);
  assert.equal(props.lunaMaxTokens.default, DEFAULT_CONTEXT_CAPS.lunaMaxTokens);
  assert.equal(props.lunaAutoCompactTokens.default, DEFAULT_CONTEXT_CAPS.lunaAutoCompactTokens);
  // Legacy keys stay valid config (the live config sets them) with no default
  // injected, so they can never shadow the new keys.
  for (const k of ['solLunaMaxTokens', 'solLunaAutoCompactTokens']) {
    assert.equal(props[k].type, 'integer', k);
    assert.equal('default' in props[k], false, k);
  }
  // Env keys are unchanged: decisions still set only the declared keys.
  assert.deepEqual(MODEL_ROUTING_ENV_KEYS, [MAX_CONTEXT_ENV_KEY, AUTO_COMPACT_ENV_KEY, MAX_OUTPUT_ENV_KEY]);
});

// ---------- 3. decide() ----------

test('decide: Sol 890k/870k at every effort, Luna 260k/240k, Claude/Meta unchanged, equal to the shared helper', () => {
  const arm = (model, family, effort = 'high', cap = null, extra = {}) => ({
    armId: `${model}:${effort}`, model, effort, family, contextWindow: 1000000, Q: 1, C: 1, trial: false, cap, ...extra,
  });
  const cases = [];
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) cases.push([arm(SOL, 'sol', effort), SOL_CAPS]);
  cases.push(
    [arm('devin/gpt-6-1-sol', 'sol'), SOL_CAPS],
    [arm(LUNA, 'luna'), LUNA_CAPS],
    [arm('gpt-6-luna', 'luna', 'max'), LUNA_CAPS],
    [arm('gpt-6-sol', 'sol'), LUNA_CAPS],
    [arm(SOL, 'sol', 'high', { maxTokens: 468000, autoCompactTokens: 448000 }), SOL_500K_TIER_CAPS],
    [arm(SOL, 'sol', 'high', { maxTokens: 890000, autoCompactTokens: 870000 }), SOL_CAPS],
    [arm(SOL, 'sol', 'high', { maxTokens: 968000, autoCompactTokens: 948000 }), SOL_CAPS],
    [arm(SOL, 'sol', 'max', { maxTokens: 1018000, autoCompactTokens: 998000 }), SOL_CAPS],
    [arm('gpt-6-luna', 'luna', 'high', { maxTokens: 240000, autoCompactTokens: 220000 }), caps(240000, 220000)],
    [arm('gemini-3-pro', 'gemini', 'high', { maxTokens: 168000, autoCompactTokens: 148000 }), caps(168000, 148000)],
    [arm('claude-haiku-5-5', 'haiku'), { [MAX_OUTPUT_ENV_KEY]: '64000' }],
    [arm('claude-opus-5-5', 'opus'), {}],
    [arm('claude-sonnet-5-5', 'sonnet'), {}],
    [arm(WONDER, 'muse', 'max'), {}],
    [arm('muse-spark-1.3-contributor', 'muse', 'max'), {}],
  );
  for (const [a, expected] of cases) {
    for (const contextCaps of [DEFAULT_CONTEXT_CAPS, undefined, normalizeContextCaps({ solLunaMaxTokens: 260000, solLunaAutoCompactTokens: 240000 })]) {
      const d = decide({ runId: 'r', agentId: 'a', ladderRungs: [{ rung: 0, arms: [a] }], accountId: 'x:1', contextCaps });
      assert.equal(d.kind, 'decide', a.armId);
      assert.deepEqual(d.env, expected, a.armId);
      assert.deepEqual(d.env, contextCapsEnv(a, contextCaps), a.armId);
    }
  }
});

test('decide: trial Sol picks carry the window too', () => {
  const trialArm = { armId: 'sol-trial', model: SOL, effort: 'high', family: 'sol', contextWindow: 1000000, Q: 1, C: 1, trial: true, cap: null };
  const d = decide({
    runId: 'r', agentId: 'a', role: 'doer', ladderRungs: [{ rung: 0, arms: [trialArm] }], accountId: 'codex:1',
    adapterType: 'claude_local', trialBudget: { sol: 1 }, trialAdapters: { claude_local: ['*'] },
    fiveHourHeadroomPct: 0.5, burnPerRunPct: {},
  });
  assert.equal(d.kind, 'decide');
  assert.equal(d.trial, true);
  assert.deepEqual(d.env, SOL_CAPS);
});

// ---------- 4. hook: doer decide, burn mode, live config ----------

test('hook decide on a Sol doer run: 890k/870k with the live 0.2.61 config (legacy keys), Luna 260k/240k', async () => {
  const contextCaps = {
    solLunaMaxTokens: 260000, autoCompactEnvKey: AUTO_COMPACT_ENV_KEY,
    haikuMaxOutputTokens: 64000, solLunaAutoCompactTokens: 240000,
  };
  const sol = drive({ accounts: [codexLane(0.1, 24, [SOL])], overrides: { contextCaps } });
  await sol.start();
  const s = await sol.hook('doer-sol', { agentId: 'agent-9' });
  assert.equal(s.kind, 'decide');
  assert.equal(s.model, SOL);
  assert.deepEqual(s.env, SOL_CAPS);
  const luna = drive({ accounts: [codexLane(0.1, 24, [LUNA])], overrides: { contextCaps } });
  await luna.start();
  const l = await luna.hook('doer-luna', { agentId: 'agent-9' });
  assert.equal(l.kind, 'decide');
  assert.equal(l.model, LUNA);
  assert.deepEqual(l.env, LUNA_CAPS);
});

test('hook decide on a burn-mode Sol account carries the window', async () => {
  const d = drive({
    accounts: [codexLane(0.1, 24, [SOL])],
    overrides: { burnMode: { accounts: ['codex:*'] } },
  });
  await d.start();
  const out = await d.hook('burn-sol', { agentId: 'agent-9' });
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, SOL);
  assert.deepEqual(out.env, SOL_CAPS);
  const view = (await d.api('capacity')).accounts.find(a => a.accountId === 'codex:c1');
  assert.equal(view?.burnMode, true);
});

test('operator override of the Sol window reaches the hook', async () => {
  const d = drive({
    accounts: [codexLane(0.1, 24, [SOL])],
    overrides: { contextCaps: { solMaxTokens: 400000, solAutoCompactTokens: 380000 } },
  });
  await d.start();
  const out = await d.hook('doer-sol-400', { agentId: 'agent-9' });
  assert.deepEqual(out.env, caps(400000, 380000));
});

// ---------- 5. routed reviews ----------

test('routed review on gpt-6.1-sol gets the 890000/870000 window (0.2.61 emitted env {})', async () => {
  const d = drive({ arms: [{ provider: 'codex', model: SOL, effort: 'high' }], accounts: [codexLane()] });
  await d.start();
  const out = await d.hook('rev-sol');
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, SOL);
  assert.equal(out.effort, 'high');
  assert.match(out.reason, /reviewer routing: gpt-6\.1-sol\(high\) on codex:c1/);
  assert.deepEqual(out.env, SOL_CAPS);
  await d.tick();
  const routing = (await d.api('capacity')).reviewer.routing;
  assert.equal(routing.last.routed, true);
  assert.deepEqual(routing.last.env, SOL_CAPS);
  assert.deepEqual(routing.preview.env, SOL_CAPS);
});

test('routed Sol review at max effort, and a luna review arm, are capped too', async () => {
  const max = drive({ arms: [{ provider: 'codex', model: SOL, effort: 'max' }], accounts: [codexLane()] });
  await max.start();
  const m = await max.hook('rev-sol-max');
  assert.equal(m.kind, 'decide');
  assert.equal(m.effort, 'max');
  assert.deepEqual(m.env, SOL_CAPS);
  const luna = drive({ arms: [{ provider: 'codex', model: LUNA, effort: 'high' }], accounts: [codexLane()] });
  await luna.start();
  const l = await luna.hook('rev-luna');
  assert.equal(l.kind, 'decide');
  assert.equal(l.model, LUNA);
  assert.deepEqual(l.env, LUNA_CAPS);
});

test('routed Sol review served without a ladder arm still gets the window (family from the model id)', async () => {
  // No AA row for Sol: the lane lists the model, admission passes with no
  // ladder match, so the window comes from the emitted id itself.
  const d = drive({
    arms: [{ provider: 'codex', model: SOL, effort: 'high' }],
    accounts: [codexLane()],
    rows: aaRows().filter(r => !r.slug.startsWith('gpt-')),
  });
  await d.start();
  const out = await d.hook('rev-sol-listed');
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, SOL);
  assert.deepEqual(out.env, SOL_CAPS);
});

test('live feed shape (922k window tier): the tier cap IS the 890000/870000 ceiling on review and doer paths', async () => {
  const d = drive({
    arms: [{ provider: 'codex', model: SOL, effort: 'high' }],
    // Sol-only lane, so the doer decide below lands on the same model.
    accounts: [codexLane(0.1, 24, [SOL])],
    feedExtra: liveSolWindowFeed(),
  });
  await d.start();
  // tiers.mjs: T - 32k / T - 52k over the measured ceiling = the defaults.
  assert.deepEqual((await d.api('capacity')).contextTiers.caps, {
    [SOL]: { maxTokens: DEFAULT_CONTEXT_CAPS.solMaxTokens, autoCompactTokens: DEFAULT_CONTEXT_CAPS.solAutoCompactTokens },
  });
  const out = await d.hook('rev-sol-tier');
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, SOL);
  assert.deepEqual(out.env, SOL_CAPS);
  const doer = await d.hook('doer-sol', { agentId: 'agent-9' });
  assert.equal(doer.kind, 'decide');
  assert.equal(doer.model, SOL);
  assert.deepEqual(doer.env, out.env);
});

test('a stale 500k window tier still lowers review and doer paths to 468000/448000', async () => {
  const d = drive({
    arms: [{ provider: 'codex', model: SOL, effort: 'high' }],
    accounts: [codexLane(0.1, 24, [SOL])],
    feedExtra: stale500kWindowFeed(),
  });
  await d.start();
  assert.deepEqual((await d.api('capacity')).contextTiers.caps, { [SOL]: { maxTokens: 468000, autoCompactTokens: 448000 } });
  const out = await d.hook('rev-sol-stale-tier');
  assert.deepEqual(out.env, SOL_500K_TIER_CAPS);
  const doer = await d.hook('doer-sol-stale-tier', { agentId: 'agent-9' });
  assert.deepEqual(doer.env, SOL_500K_TIER_CAPS);
});

test('a feed tier wider than the ceiling (the 1.05M window) never raises Sol past 890000/870000', async () => {
  const d = drive({
    arms: [{ provider: 'codex', model: SOL, effort: 'high' }],
    accounts: [codexLane(0.1, 24, [SOL])],
    feedExtra: solTierFeed({ threshold: 1050000, appliesTo: 'window', mult: 1 }),
  });
  await d.start();
  // The feed derives a 1.018M cap; every emitted env stays on the ceiling.
  assert.deepEqual((await d.api('capacity')).contextTiers.caps, { [SOL]: { maxTokens: 1018000, autoCompactTokens: 998000 } });
  assert.deepEqual((await d.hook('rev-sol-wide')).env, SOL_CAPS);
  assert.deepEqual((await d.hook('doer-sol-wide', { agentId: 'agent-9' })).env, SOL_CAPS);
  assert.deepEqual((await d.hook('kept-sol-wide', { agentDefaultModel: SOL })).env, SOL_CAPS);
});

test('a 272k price-cliff tier on Sol lowers every path to 240000/220000', async () => {
  const d = drive({
    arms: [{ provider: 'codex', model: SOL, effort: 'high' }],
    accounts: [codexLane(0.1, 24, [SOL])],
    feedExtra: solTierFeed(),
  });
  await d.start();
  const review = await d.hook('rev-sol-cliff');
  const doer = await d.hook('doer-sol-cliff', { agentId: 'agent-9' });
  assert.deepEqual(review.env, caps(240000, 220000));
  assert.deepEqual(doer.env, caps(240000, 220000));
});

test('Meta and Claude review arms are unchanged (no env keys)', async () => {
  const meta = drive({ arms: [{ provider: 'meta', model: WONDER, effort: 'max' }], accounts: [metaLane()] });
  await meta.start();
  const m = await meta.hook('rev-meta');
  assert.deepEqual(Object.keys(m).sort(), ['decisionId', 'effort', 'env', 'kind', 'model', 'reason', 'source']);
  assert.equal(m.kind, 'decide');
  assert.equal(m.model, WONDER);
  assert.equal(m.effort, 'max');
  assert.deepEqual(m.env, {});
  const claude = drive({ arms: [{ provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }], accounts: [claudeLane()] });
  await claude.start();
  const c = await claude.hook('rev-claude');
  assert.equal(c.kind, 'decide');
  assert.equal(c.model, 'claude-opus-5-5');
  assert.deepEqual(c.env, {});
  // Mixed config, Sol third: the Meta/Claude picks stay env-free, a Sol pick is capped.
  const arms = [
    { provider: 'meta', model: WONDER, effort: 'max' },
    { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    { provider: 'codex', model: SOL, effort: 'high' },
  ];
  const mixed = drive({ arms, accounts: [metaLane(0.9, 24), claudeLane(0.9, 24), codexLane(0.1, 24)] });
  await mixed.start();
  const x = await mixed.hook('rev-mixed');
  assert.equal(x.kind, 'decide');
  assert.equal(x.model, SOL, 'the pool most behind plan (codex) wins');
  assert.deepEqual(x.env, SOL_CAPS);
});

// ---------- 6. keep paths ----------

test('kept agent pinned to Sol runs its configured model WITH the window; other kept agents keep', async () => {
  const d = drive({ accounts: [codexLane(), metaLane()] });
  await d.start();
  const sol = await d.hook('kept-sol', { agentDefaultModel: SOL });
  assert.equal(sol.kind, 'decide');
  assert.equal(sol.model, SOL, 'exact configured model string');
  assert.equal('effort' in sol, false, 'effort omitted: the host keeps the configured effort');
  assert.deepEqual(sol.env, SOL_CAPS);
  assert.equal(sol.source, 'model-capacity');
  assert.match(sol.reason, /kept: .*context caps/);
  // Decorated/prefixed configured ids keep their exact string.
  for (const model of [`codex/${SOL}`, 'devin/gpt-6-1-sol', `${SOL}(xhigh)`]) {
    const out = await d.hook(`kept-${model}`, { agentDefaultModel: model });
    assert.equal(out.model, model);
    assert.deepEqual(out.env, SOL_CAPS, model);
  }
  const luna = await d.hook('kept-luna', { agentDefaultModel: LUNA });
  assert.equal(luna.model, LUNA);
  assert.deepEqual(luna.env, LUNA_CAPS);
  // Non-Sol/Luna kept agents and unknown defaults keep exactly as before.
  assert.deepEqual(await d.hook('kept-meta', { agentDefaultModel: WONDER }), { kind: 'keep' });
  assert.deepEqual(await d.hook('kept-opus', { agentDefaultModel: 'claude-opus-5-5' }), { kind: 'keep' });
  assert.deepEqual(await d.hook('kept-haiku', { agentDefaultModel: 'claude-haiku-5-5' }), { kind: 'keep' });
  assert.deepEqual(await d.hook('kept-none', { agentDefaultModel: null }), { kind: 'keep' });
  assert.deepEqual(await d.hook('kept-blank', { agentDefaultModel: '  ' }), { kind: 'keep' });
});

test('kept Sol agent with no Sol lane in the feed still gets the window', async () => {
  const d = drive({ accounts: [metaLane()] });
  await d.start();
  const out = await d.hook('kept-sol-nolane', { agentDefaultModel: SOL });
  assert.equal(out.kind, 'decide');
  assert.deepEqual(out.env, SOL_CAPS);
});

test('kept Sol agent takes the feed tier cap when its model carries one (lowered, never raised)', async () => {
  const live = drive({ accounts: [codexLane()], feedExtra: liveSolWindowFeed() });
  await live.start();
  const out = await live.hook('kept-sol-tier', { agentDefaultModel: SOL });
  assert.equal(out.kind, 'decide');
  assert.deepEqual(out.env, SOL_CAPS);
  const stale = drive({ accounts: [codexLane()], feedExtra: stale500kWindowFeed() });
  await stale.start();
  const lowered = await stale.hook('kept-sol-stale-tier', { agentDefaultModel: SOL });
  assert.equal(lowered.kind, 'decide');
  assert.deepEqual(lowered.env, SOL_500K_TIER_CAPS);
});

test('reviewer routing with no qualifying arm falls back to the capped configured Sol model', async () => {
  const d = drive({
    arms: [{ provider: 'meta', model: 'muse-not-served', effort: 'max' }],
    accounts: [metaLane(), codexLane()],
  });
  await d.start();
  const out = await d.hook('rev-fallback', { agentDefaultModel: SOL });
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, SOL);
  assert.deepEqual(out.env, SOL_CAPS);
  await d.tick();
  assert.equal((await d.api('capacity')).reviewer.routing.last.fallback, 'keep');
  // The same fallback on a Meta default keeps exactly as before.
  assert.deepEqual(await d.hook('rev-fallback-meta', { agentDefaultModel: WONDER }), { kind: 'keep' });
});

test('stale routing snapshot: a Sol default still gets the window, others keep', async () => {
  const d = drive({ accounts: [codexLane()] });
  await d.start();
  d.setNow(TICK + 5 * 60 * 1000);
  const sol = await d.hook('stale-sol', { agentId: 'agent-9', agentDefaultModel: SOL });
  assert.equal(sol.kind, 'decide');
  assert.equal(sol.model, SOL);
  assert.deepEqual(sol.env, SOL_CAPS);
  const luna = await d.hook('stale-luna', { agentId: 'agent-9', agentDefaultModel: LUNA });
  assert.deepEqual(luna.env, LUNA_CAPS);
  assert.deepEqual(await d.hook('stale-meta', { agentId: 'agent-9', agentDefaultModel: WONDER }), { kind: 'keep' });
});

test('enforce off stays the kill switch: keep, even for Sol', async () => {
  const d = drive({ accounts: [codexLane()], overrides: { enforce: false } });
  await d.start();
  assert.deepEqual(await d.hook('off-sol', { agentDefaultModel: SOL }), { kind: 'keep' });
  assert.deepEqual(await d.hook('off-sol-doer', { agentId: 'agent-9', agentDefaultModel: SOL }), { kind: 'keep' });
});
