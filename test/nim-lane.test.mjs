import test from 'node:test';
import assert from 'node:assert/strict';
import { servedIdForArm, PREFIXED_ONLY_PROVIDERS } from '../src/arms.mjs';
import { parseLaneAccount } from '../src/cliproxy.mjs';
import {
  createModelCapacityPlugin,
  validateConfigShape,
  resolveConfig,
  normalizeTrialCapByProvider,
  trialInflightCapFor,
  normalizeFreeCostProviders,
  isFreeCostAccount,
  liveTrialInflightCapFor,
} from '../src/plugin.mjs';
import { computeConcurrencyTarget } from '../src/concurrency.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const NOW = Date.parse('2026-10-24T04:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const ALIAS = 'nvidia-nim/step-5-preview-nim';
const BARE = 'step-5-preview-nim';

// Gate (1): nvidia-nim lanes serve ONLY under the provider-prefixed id, even
// fail-open (no global served list). Native lanes keep byte-identical bare
// emission.
test('nvidia-nim is a prefixed-only provider', () => {
  assert.ok(PREFIXED_ONLY_PROVIDERS.includes('nvidia-nim'));
  // Fail-open: no global served list, alias-only account -> exact alias.
  assert.equal(servedIdForArm([ALIAS], BARE, 'nvidia-nim', null), ALIAS);
  assert.equal(servedIdForArm([ALIAS], BARE, 'nvidia-nim', new Set([ALIAS])), ALIAS);
  // A prefixed-only account that ALSO lists the bare id still emits its own
  // prefixed alias (the bare id is unknown to CLIProxy or names another
  // provider's model).
  assert.equal(servedIdForArm([BARE, ALIAS], BARE, 'nvidia-nim', null), ALIAS);
  // ... but only its OWN prefix: a foreign alias never beats the listed bare id.
  assert.equal(servedIdForArm([BARE, 'other/step-5-preview-nim'], BARE, 'nvidia-nim', null), BARE);
  // Native lanes are unchanged: bare emission fail-open.
  assert.equal(servedIdForArm(['openai/gpt-6.1-sol'], 'gpt-6.1-sol', 'codex', null), 'gpt-6.1-sol');
});

// Gate (2): the feed plan rides through parsing; absent stays absent so feeds
// without it parse byte-identically.
test('parseLaneAccount carries the feed plan', () => {
  const a = parseLaneAccount({
    lane: 'nvidia-nim-lane-1', provider: 'nvidia-nim', accountKey: 'nvidia-nim-lane-1',
    health: 'healthy', meter: 'reactive', quality: 'reactive', plan: 'free',
    models: [ALIAS],
    weekly: { used: null, resetsAt: null }, fiveHour: { used: null, resetsAt: null },
    observedAt: new Date(NOW).toISOString(),
  }, NOW);
  assert.equal(a.plan, 'free');
  const legacy = parseLaneAccount({
    lane: 'c', provider: 'codex', accountKey: 'k9', health: 'healthy',
    weekly: { used: 0.3, resetsAt: null }, fiveHour: { used: 0.1, resetsAt: null },
    observedAt: new Date(NOW).toISOString(), quality: 'live',
  }, NOW);
  assert.ok(!('plan' in legacy), 'feeds that predate plan stay plan-free');
});

// Gate (2): free-cost config shape. Empty (default) keeps AA pricing for every
// account; a listed provider prices only 'free'-plan accounts at zero.
test('free-cost provider config validates, normalizes, and matches', () => {
  assert.deepEqual(validateConfigShape({ placement: { freeCostProviders: ['nvidia-nim'] } }), []);
  assert.ok(validateConfigShape({ placement: { freeCostProviders: 'nvidia-nim' } }).length > 0);
  assert.ok(validateConfigShape({ placement: { freeCostProviders: [''] } }).length > 0);
  assert.deepEqual(normalizeFreeCostProviders(undefined), []);
  assert.deepEqual(normalizeFreeCostProviders(['NVIDIA-NIM', 'nvidia-nim ']), ['nvidia-nim']);
  const resolved = resolveConfig({ placement: { freeCostProviders: ['nvidia-nim'] } });
  assert.deepEqual(resolved.placement.freeCostProviders, ['nvidia-nim']);
  assert.deepEqual(resolveConfig({}).placement.freeCostProviders, []);
  // Quality bars and climbForSpend ride through untouched.
  assert.deepEqual(resolveConfig({}).roles.minQuality, resolveConfig({ placement: { freeCostProviders: ['nvidia-nim'] } }).roles.minQuality);
  assert.equal(resolveConfig({}).pacing.climbForSpend, resolveConfig({ placement: { freeCostProviders: ['nvidia-nim'] } }).pacing.climbForSpend);

  const listed = ['nvidia-nim'];
  assert.equal(isFreeCostAccount({ provider: 'nvidia-nim', plan: 'free' }, listed), true);
  assert.equal(isFreeCostAccount({ provider: 'NVIDIA-NIM', plan: 'Free' }, listed), true);
  assert.equal(isFreeCostAccount({ provider: 'nvidia-nim', plan: 'metered' }, listed), false);
  assert.equal(isFreeCostAccount({ provider: 'nvidia-nim' }, listed), false);
  assert.equal(isFreeCostAccount({ provider: 'codex', plan: 'free' }, listed), false);
  assert.equal(isFreeCostAccount({ provider: 'nvidia-nim', plan: 'free' }, []), false);
});

// Gate (3): provider-scoped in-flight cap. Listed providers take the override;
// every other provider keeps the global value.
test('provider-scoped in-flight cap validates and resolves', () => {
  assert.deepEqual(validateConfigShape({ trials: { maxInFlightPerAccountByProvider: { 'nvidia-nim': 1 } } }), []);
  assert.ok(validateConfigShape({ trials: { maxInFlightPerAccountByProvider: { 'nvidia-nim': 0 } } }).length > 0);
  assert.ok(validateConfigShape({ trials: { maxInFlightPerAccountByProvider: [] } }).length > 0);
  assert.deepEqual(normalizeTrialCapByProvider(undefined), {});
  assert.deepEqual(normalizeTrialCapByProvider({ 'NVIDIA-NIM': 1 }), { 'nvidia-nim': 1 });
  assert.deepEqual(resolveConfig({}).trials.maxInFlightPerAccountByProvider, {});
  assert.equal(resolveConfig({}).trials.maxInFlightPerAccount, 2);

  const trials = { maxInFlightPerAccount: 2, maxInFlightPerAccountByProvider: { 'nvidia-nim': 1 } };
  assert.equal(trialInflightCapFor(trials, 'nvidia-nim'), 1);
  assert.equal(trialInflightCapFor(trials, 'NVIDIA-NIM'), 1);
  assert.equal(trialInflightCapFor(trials, 'codex'), 2, 'other providers keep the global cap');
  assert.equal(trialInflightCapFor(trials, 'devin'), 2, 'other providers keep the global cap');
  assert.equal(trialInflightCapFor({ maxInFlightPerAccount: 2 }, 'nvidia-nim'), 2, 'no map: global for all');

  // Live-view resolution: scoped hit on any provider identity, scalar fallback.
  const live = { maxTrialInFlightPerAccount: 2, maxTrialInFlightPerAccountByProvider: { 'nvidia-nim': 1 } };
  assert.equal(liveTrialInflightCapFor(live, { accountId: 'nvidia-nim:x', provider: 'nvidia-nim', pool: 'nvidia-nim', laneProvider: 'nvidia-nim' }), 1);
  assert.equal(liveTrialInflightCapFor(live, { accountId: 'codex:x', provider: 'codex', pool: 'codex', laneProvider: 'codex' }), 2);
  assert.equal(liveTrialInflightCapFor({ maxTrialInFlightPerAccount: 2 }, { accountId: 'nvidia-nim:x', provider: 'nvidia-nim' }), 2);
  assert.equal(liveTrialInflightCapFor(live, { accountId: 'nvidia-nim:x' }), 1, 'account-id prefix alone resolves');
});

// Gates (1)+(2) end to end: the free NIM lane emits the exact prefixed alias
// at zero monetary placement cost while a sibling provider keeps its measured
// cost; quality bars and climbForSpend are unchanged.
test('free NIM lane emits the exact alias at zero placement cost', async () => {
  const lane = {
    observedAt: new Date(NOW).toISOString(),
    servedModels: [ALIAS, 'devin/gpt-5-5'],
    accounts: [
      {
        lane: 'nvidia-nim-lane-1', provider: 'nvidia-nim', accountKey: 'nvidia-nim-lane-1',
        health: 'healthy', meter: 'reactive', quality: 'reactive', plan: 'free',
        models: [ALIAS],
        weekly: { used: null, resetsAt: null }, fiveHour: { used: null, resetsAt: null },
        observedAt: new Date(NOW).toISOString(),
      },
      {
        lane: 'devin-lane-1', provider: 'devin', accountKey: 'devin-lane-1',
        health: 'healthy', meter: 'reactive', quality: 'reactive',
        models: ['devin/gpt-5-5'],
        weekly: { used: null, resetsAt: null }, fiveHour: { used: null, resetsAt: null },
        observedAt: new Date(NOW).toISOString(),
      },
    ],
  };
  const rows = [
    { slug: 'step-5', intelligenceIndex: 72, intelligenceIndexCostPerTask: 9, price1mInputTokens: 1, price1mOutputTokens: 4 },
    { slug: 'gpt-5-5', intelligenceIndex: 70, intelligenceIndexCostPerTask: 10, price1mInputTokens: 1, price1mOutputTokens: 4 },
    { slug: 'claude-haiku-5-5', intelligenceIndex: 50, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
  ];
  const config = {
    enforce: true,
    cliproxy: { laneKeySecretRef: SECRET },
    roles: { minQuality: { doer: null, other: null, thinker: null } },
    modelAaOverrides: { [BARE]: { slug: 'step-5', effort: 'max' } },
    placement: { freeCostProviders: ['nvidia-nim'] },
    trials: { maxInFlightPerAccount: 2, maxInFlightPerAccountByProvider: { 'nvidia-nim': 1 } },
  };
  assert.deepEqual(validateConfigShape(config), []);
  const store = new Map();
  const jobs = new Map();
  const key = k => JSON.stringify(k);
  const plugin = createModelCapacityPlugin({ clock: () => NOW, requirePinnedLaneHost: false });
  await plugin.setup({
    config: { get: async () => config },
    state: { get: async k => store.get(key(k)) ?? null, set: async (k, v) => { store.set(key(k), v); } },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness(lane, NOW, { emitted: { 'nvidia-nim': [BARE], devin: ['gpt-5-5'] } }) }) },
    agents: { get: async () => null },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => jobs.set(n, fn) },
    events: { on: () => {} },
    logger: { info() {}, error() {}, warn() {} },
  });
  store.set(key({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' }),
    { fetchedAt: new Date(NOW).toISOString(), rows, duplicateSlugs: [] });
  await plugin.onConfigChanged(config, { companyId: 'acme' });
  await jobs.get('shadow-tick')({});
  const cap = await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' });

  // The global cap is untouched by the NIM-scoped override.
  assert.equal(cap.body.trials?.maxInFlightPerAccount ?? 2, 2);

  const nim = cap.body.accounts?.find(a => a.accountId === 'nvidia-nim:nvidia-nim-lane-1');
  assert.ok(nim, 'NIM account present');
  const arm = nim.arms?.find(a => a.armId === BARE);
  assert.ok(arm, 'NIM arm present');
  assert.equal(arm.model, ALIAS, 'exact prefixed emission');
  assert.equal(arm.costEffective, 0, 'zero monetary placement cost');
  assert.ok((arm.costBase ?? 0) > 0, 'measured AA cost kept for audit');

  const devin = cap.body.accounts?.find(a => a.accountId === 'devin:devin-lane-1');
  const dArm = devin?.arms?.find(a => a.armId === 'gpt-5-5');
  assert.ok(dArm && (dArm.costEffective ?? 0) > 0, 'sibling provider keeps its measured cost');

  const ladder = await plugin.onApiRequest({ companyId: 'acme', routeKey: 'ladder' });
  const nimRung = (ladder.body.ladders['nvidia-nim:nvidia-nim-lane-1']?.rungs ?? [])
    .find(r => r.armId === BARE);
  assert.ok(nimRung, 'NIM arm on the ladder');
  assert.equal(nimRung.model, ALIAS, 'ladder emits the exact alias');
  assert.equal(nimRung.C, 0, 'ladder orders on zero monetary cost');
  assert.equal(nimRung.costEffective, 0, 'ladder carries zero effective cost');
  // Quota burn still prices the measured tier cost: placement zero must never
  // read as zero quota consumption.
  const nimBurn = ladder.body.ladders['nvidia-nim:nvidia-nim-lane-1']?.burnPerRunPct?.[BARE];
  assert.ok((nimBurn ?? 0) > 0, `free lane still burns measured cost, got ${nimBurn}`);

  const hook = await plugin.onResolveRunModel({
    runId: 'run-nim-1', companyId: 'acme', agentId: 'agent-9', adapterType: 'claude-code',
    issueId: null, deadlineMs: 1500,
  });
  assert.equal(hook.kind, 'decide');
  assert.ok(hook.model === ALIAS || String(hook.model).startsWith(`${ALIAS}(`), `expected NIM alias, got ${hook.model}`);
});

// The concurrency target honors the provider-scoped trial cap: a trial-only
// NIM account publishes at most 1 slot while a trial-only sibling keeps 2.
test('concurrency target honors the provider-scoped trial cap', () => {
  const accounts = [
    { accountId: 'nvidia-nim:1', remainingPct: 1, hoursToReset: 168, burnPerRunPct: 0.0005, measuredBurnPerRunPct: 0.0005, guardActive: false },
    { accountId: 'codex:1', remainingPct: 1, hoursToReset: 168, burnPerRunPct: 0.0005, measuredBurnPerRunPct: 0.0005, guardActive: false },
  ];
  const trialOnly = Object.fromEntries(['doer', 'thinker', 'other'].map(r => [r, { eligible: true, trialOnly: true }]));
  const roleAccess = { 'nvidia-nim:1': trialOnly, 'codex:1': trialOnly };
  const base = { accounts, meanRunDurationHours: 0.186, maxTotal: 75, roleAccess, trialSlotCap: 2 };
  const unscoped = computeConcurrencyTarget(base);
  assert.equal(unscoped.perAccount.find(a => a.accountId === 'nvidia-nim:1').usableSlots, 2);
  const scoped = computeConcurrencyTarget({
    ...base,
    trialSlotCapFor: (accountId) => (String(accountId).startsWith('nvidia-nim') ? 1 : 2),
  });
  assert.equal(scoped.perAccount.find(a => a.accountId === 'nvidia-nim:1').usableSlots, 1);
  assert.equal(scoped.perAccount.find(a => a.accountId === 'codex:1').usableSlots, 2,
    'sibling provider keeps the global cap in the target too');
});

// Gate (3) end to end: the NIM-scoped cap of 1 holds after one in-flight run
// while an unlisted provider still takes its second run under the global 2.
test('NIM-scoped cap holds at one; other providers keep two', async () => {
  async function harness({ scoped }) {
    const lane = {
      observedAt: new Date(NOW).toISOString(),
      servedModels: [ALIAS],
      accounts: [{
        lane: 'nvidia-nim-lane-1', provider: 'nvidia-nim', accountKey: 'nvidia-nim-lane-1',
        health: 'healthy', meter: 'reactive', quality: 'reactive', plan: 'free',
        models: [ALIAS],
        weekly: { used: null, resetsAt: null }, fiveHour: { used: null, resetsAt: null },
        observedAt: new Date(NOW).toISOString(),
      }],
    };
    const rows = [
      { slug: 'step-5', intelligenceIndex: 72, intelligenceIndexCostPerTask: 9, price1mInputTokens: 1, price1mOutputTokens: 4 },
    ];
    const config = {
      enforce: true,
      cliproxy: { laneKeySecretRef: SECRET },
      roles: { minQuality: { doer: null, other: null, thinker: null } },
      modelAaOverrides: { [BARE]: { slug: 'step-5', effort: 'max' } },
      placement: { freeCostProviders: ['nvidia-nim'] },
      ...(scoped ? { trials: { maxInFlightPerAccountByProvider: { 'nvidia-nim': 1 } } } : {}),
    };
    const store = new Map();
    const jobs = new Map();
    const key = k => JSON.stringify(k);
    const plugin = createModelCapacityPlugin({ clock: () => NOW, requirePinnedLaneHost: false });
    await plugin.setup({
      config: { get: async () => config },
      state: { get: async k => store.get(key(k)) ?? null, set: async (k, v) => { store.set(key(k), v); } },
      secrets: { resolve: async () => 'lane-key' },
      http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness(lane, NOW, { emitted: { 'nvidia-nim': [BARE] } }) }) },
      agents: { get: async () => null },
      issues: { get: async () => null, list: async () => [] },
      jobs: { register: (n, fn) => jobs.set(n, fn) },
      events: { on: () => {} },
      logger: { info() {}, error() {}, warn() {} },
    });
    store.set(key({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' }),
      { fetchedAt: new Date(NOW).toISOString(), rows, duplicateSlugs: [] });
    await plugin.onConfigChanged(config, { companyId: 'acme' });
    await jobs.get('shadow-tick')({});
    const hook = (runId) => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId: 'agent-9', adapterType: 'claude-code',
      issueId: null, deadlineMs: 1500,
    });
    return hook;
  }

  const scopedHook = await harness({ scoped: true });
  const first = await scopedHook('run-nim-cap-1');
  assert.equal(first.kind, 'decide', 'first run routes');
  const second = await scopedHook('run-nim-cap-2');
  assert.equal(second.kind, 'defer', 'scoped cap 1 holds the second run');

  const globalHook = await harness({ scoped: false });
  assert.equal((await globalHook('run-nim-cap-1')).kind, 'decide');
  assert.equal((await globalHook('run-nim-cap-2')).kind, 'decide', 'global cap 2 still takes two');
});
