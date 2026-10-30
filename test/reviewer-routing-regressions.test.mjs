import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin, resolveConfig, validateConfigShape } from '../src/plugin.mjs';
import { manifest } from '../src/manifest.mjs';
import {
  burnModeTokens, isBurnFlagged, normalizeReviewerRouting, selectReviewerRoute, validateReviewerRouting,
} from '../src/reviewerrouting.mjs';
import { createBreakerStore, recordArmFailure, breakerStoreToJSON, DEFAULT_BREAKERS } from '../src/breakers.mjs';
import { syntheticAvailability, withSyntheticReadiness } from './synthetic-readiness.mjs';

// The existing burn-mode probes' fixture, made permanent with a mutable clock.
// All IO is in memory; no provider, host, SDK install or real secret is used.
const TICK = Date.parse('2026-10-08T23:00:00Z');
const HOUR = 3600000;
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const key = stateKey => ({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey });
const arm = (model = 'claude-sonnet-5-5', effort = 'high') => ({ provider: 'claude', model, effort });
const aaRows = () => [
  { slug: 'claude-opus-5-5', intelligenceIndex: 62, intelligenceIndexCostPerTask: 30, price1mInputTokens: 5, price1mOutputTokens: 25 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 58, intelligenceIndexCostPerTask: 18, price1mInputTokens: 3, price1mOutputTokens: 15 },
  { slug: 'claude-haiku-5-5-xhigh', intelligenceIndex: 53, intelligenceIndexCostPerTask: 8, price1mInputTokens: 1, price1mOutputTokens: 5 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 52, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
];
const lane = (accountKey = 'a1', extra = {}) => ({
  lane: `claude-${accountKey}`, provider: 'claude', accountKey, health: 'healthy',
  weekly: { used: 0.1, resetsAt: new Date(TICK + 24 * HOUR).toISOString() },
  fiveHour: { used: 0.1, resetsAt: new Date(TICK + 4 * HOUR).toISOString() },
  observedAt: new Date(TICK).toISOString(), quality: 'live',
  models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  ...extra,
});

function drive({ selected = arm(), accounts = [lane()], overrides = {}, feedExtra = {} } = {}) {
  const config = {
    enforce: true,
    credentialReadiness: { enforce: false },
    roles: {
      keepAgentIds: ['reviewer-1'],
      minQuality: { doer: null, thinker: null, other: null },
      outcomeGate: { enabled: false },
    },
    reviewerRouting: { agentIds: ['reviewer-1'], arms: [selected] },
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
    setup: async () => {
      await plugin.setup(io);
      store.set(JSON.stringify(key('aa-snapshot-v1')), { fetchedAt: new Date(now).toISOString(), rows: aaRows(), duplicateSlugs: [] });
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    seed: (stateKey, value) => store.set(JSON.stringify(key(stateKey)), value),
    setNow: ms => { now = ms; },
    tick: () => jobs.get('quota-refresh')({ companyId: 'acme' }),
    hook: runId => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId: 'reviewer-1', issueId: null, adapterType: 'opencode_local',
      invocationSource: 'test', wakeReason: null, agentDefaultModel: null, previous: null,
      issueOverrideModel: null, deadlineMs: 1500,
    }),
    api: async routeKey => {
      const response = await plugin.onApiRequest({ companyId: 'acme', routeKey });
      assert.equal(response.status, 200);
      return response.body;
    },
  };
}

async function start({ openArm, ...options } = {}) {
  const d = drive(options);
  await d.setup();
  if (openArm) {
    const store = createBreakerStore();
    for (const delay of [120000, 60000]) {
      recordArmFailure(store, 'claude:a1', openArm,
        { atMs: TICK - delay, errorText: 'auth_unavailable' }, TICK - delay, DEFAULT_BREAKERS);
    }
    d.seed('breaker-v1', breakerStoreToJSON(store, { nowMs: TICK, cfg: DEFAULT_BREAKERS }));
  }
  await d.tick();
  return d;
}

async function assertNoReviewerCapacity(d) {
  const cap = await d.api('capacity');
  assert.deepEqual(cap.reviewer.qualifiedAccountIds, []);
  assert.equal(cap.reviewer.slots, 0);
  assert.equal(cap.reviewer.hold, true);
  assert.equal(cap.reviewer.resume, false);
  assert.equal(cap.reviewer.routing.preview.routed, false);
  assert.deepEqual(await d.hook('refused-review'), { kind: 'keep' });
}

async function assertReviewerReady(d, model, effort) {
  const cap = await d.api('capacity');
  assert.deepEqual(cap.reviewer.qualifiedAccountIds, ['claude:a1']);
  assert.ok(cap.reviewer.slots > 0);
  assert.equal(cap.reviewer.hold, false);
  assert.equal(cap.reviewer.resume, true);
  assert.equal(cap.reviewer.routing.preview.routed, true);
  const result = await d.hook('ready-review');
  assert.equal(result.kind, 'decide');
  assert.equal(result.model, model);
  assert.equal(result.effort, effort);
}

test('reviewer regression: emits the exact provider-prefixed served id', async () => {
  const served = 'claude/claude-sonnet-5-5';
  const d = await start({ accounts: [lane('a1', { models: [served] })], feedExtra: { servedModels: [served] } });
  await assertReviewerReady(d, served, 'high');
});

test('reviewer regression: an unserved selected model keeps despite healthy ordinary arms', async () => {
  const d = await start({ accounts: [lane('a1', { models: ['claude-haiku-5-5'] })] });
  await assertNoReviewerCapacity(d);
});

for (const field of ['label', 'email']) {
  test(`reviewer regression: tick ${field} burn exclusion survives the hook`, async () => {
    const excluded = 'excluded@example.test';
    const d = await start({
      accounts: [lane('a1', { [field]: excluded })],
      overrides: { burnMode: { accounts: ['claude:*', `!claude:${excluded}`] } },
    });
    const before = await d.api('capacity');
    assert.notEqual(before.accounts[0].burnMode, true);
    assert.equal(before.reviewer.routing.preview.burn, false);
    assert.equal((await d.hook(`excluded-${field}`)).kind, 'decide');
    await d.tick();
    const last = (await d.api('capacity')).reviewer.routing.last;
    assert.equal(last.runId, `excluded-${field}`);
    assert.equal(last.routed, true);
    assert.equal(last.burn, false);
  });
}

test('reviewer regression: label-only burn selection survives preview and hook', async () => {
  const d = await start({
    accounts: [lane('a1', { label: 'SPARE SEAT' })],
    overrides: { burnMode: { accounts: ['spare seat'] } },
  });
  const before = await d.api('capacity');
  assert.equal(before.accounts[0].burnMode, true);
  assert.equal(before.reviewer.routing.preview.burn, true);
  assert.equal((await d.hook('label-burn')).kind, 'decide');
  await d.tick();
  const last = (await d.api('capacity')).reviewer.routing.last;
  assert.equal(last.runId, 'label-burn');
  assert.equal(last.routed, true);
  assert.equal(last.burn, true);
});

test('reviewer regression: explicit tick burn=false overrides a matching legacy token', () => {
  const account = { accountId: 'claude:a1', provider: 'claude', health: 'healthy', headroomPct: 0.6 };
  const args = { cfg: { arms: [arm()] }, burnTokens: new Set(['claude:a1']) };
  assert.equal(selectReviewerRoute({ ...args, accounts: [account] }).burn, true);
  assert.equal(selectReviewerRoute({ ...args, accounts: [{ ...account, burn: false }] }).burn, false);
});

const ordinaryAccounts = () => [lane(), lane('a2', { models: ['claude-haiku-5-5'] })];
async function assertOrdinaryArmsRemain(d) {
  const { ladders } = await d.api('ladder');
  for (const accountId of ['claude:a1', 'claude:a2']) {
    assert.ok(ladders[accountId].rungs.some(r => r.model === 'claude-haiku-5-5'), `${accountId} retains healthy ordinary Haiku`);
  }
}

test('reviewer regression: open selected breaker excludes capacity, not healthy ordinary arms', async () => {
  const d = await start({ selected: arm('claude-opus-5-5', 'max'), accounts: ordinaryAccounts(), openArm: 'claude-opus-5-5' });
  await assertOrdinaryArmsRemain(d);
  await assertNoReviewerCapacity(d);
});

test('reviewer regression: credential-unready selected arm excludes capacity despite ordinary arms', async () => {
  const accounts = ordinaryAccounts();
  accounts[0].credentialAvailability = syntheticAvailability(accounts[0], TICK);
  accounts[0].credentialAvailability.models.find(row => row.model === 'claude-opus-5-5').readyCredentials = 0;
  const d = await start({ selected: arm('claude-opus-5-5', 'max'), accounts, overrides: { credentialReadiness: { enforce: true } } });
  await assertOrdinaryArmsRemain(d);
  await assertNoReviewerCapacity(d);
});

test('reviewer regression: ready selected arm supplies positive reviewer capacity', async () => {
  const d = await start({ selected: arm('claude-opus-5-5', 'max'), accounts: ordinaryAccounts(), overrides: { credentialReadiness: { enforce: true } } });
  await assertOrdinaryArmsRemain(d);
  await assertReviewerReady(d, 'claude-opus-5-5', 'max');
});

test('reviewer regression: a sibling-effort breaker does not poison the ready selected effort', async () => {
  const d = await start({ selected: arm('claude-haiku-5-5', 'max'), openArm: 'claude-haiku-5-5-xhigh' });
  await assertReviewerReady(d, 'claude-haiku-5-5', 'max');
});

test('reviewer regression: the selected-effort breaker still keeps the fallback', async () => {
  const d = await start({ selected: arm('claude-haiku-5-5', 'max'), openArm: 'claude-haiku-5-5' });
  await assertNoReviewerCapacity(d);
});

// Wire readiness is model-scoped, so it cannot express differing evidence for
// two efforts of one model. This synthetic admission seam deliberately changes
// ONLY one candidate's evidence in the in-memory state double shared with the
// live view. No implementation import rewriting or on-disk source mutation.
async function withholdEffortEvidence(d, armId) {
  const { ladders } = await d.api('ladder');
  const candidates = ladders['claude:a1'].credentialRanking.candidates;
  const selected = candidates.filter(c => c.armId === armId);
  assert.equal(selected.length, 1, 'the synthetic seam must target exactly one effort');
  selected[0].credentialEvidence = { ...selected[0].credentialEvidence, readyCredentials: 0 };
  const siblingId = armId === 'claude-haiku-5-5' ? 'claude-haiku-5-5-xhigh' : 'claude-haiku-5-5';
  const sibling = candidates.find(c => c.armId === siblingId);
  assert.ok(sibling, 'the other effort must actually exist');
  assert.equal(sibling.credentialEvidence.status, 'valid');
  assert.ok(sibling.credentialEvidence.readyCredentials > 0, 'sibling remains ready');
  assert.equal(selected[0].credentialEvidence.readyCredentials, 0);
}

test('reviewer regression: unready selected effort cannot borrow ready sibling evidence', async () => {
  const d = await start({ selected: arm('claude-haiku-5-5', 'max'), overrides: { credentialReadiness: { enforce: true } } });
  await assertReviewerReady(d, 'claude-haiku-5-5', 'max');
  await withholdEffortEvidence(d, 'claude-haiku-5-5');
  assert.deepEqual(await d.hook('unready-selected-effort'), { kind: 'keep' });
});

test('reviewer regression: unready sibling effort does not poison ready selected evidence', async () => {
  const d = await start({ selected: arm('claude-haiku-5-5', 'max'), overrides: { credentialReadiness: { enforce: true } } });
  await withholdEffortEvidence(d, 'claude-haiku-5-5-xhigh');
  const result = await d.hook('ready-selected-effort');
  assert.equal(result.kind, 'decide');
  assert.equal(result.model, 'claude-haiku-5-5');
  assert.equal(result.effort, 'max');
});

test('reviewer regression: credential evidence expiry closes the hook before the tick snapshot expires', async () => {
  const account = lane();
  account.credentialAvailability = syntheticAvailability(account, TICK);
  for (const row of account.credentialAvailability.models) row.expiresAt = new Date(TICK + 30000).toISOString();
  const d = await start({ accounts: [account], overrides: { credentialReadiness: { enforce: true } } });
  await assertReviewerReady(d, 'claude-sonnet-5-5', 'high');
  d.setNow(TICK + 31000);
  assert.deepEqual(await d.hook('expired-credentials'), { kind: 'keep' });
});

const configCases = [
  ['disabled without arms', { enabled: false }, true],
  ['disabled valid arms', { enabled: false, arms: [arm()] }, true],
  ['disabled null agentIds', { enabled: false, agentIds: null }, true],
  ['explicit enabled valid arms', { enabled: true, arms: [arm()] }, true],
  ['implicit enabled valid arms', { arms: [arm()] }, true],
  ['explicit enabled missing arms', { enabled: true }, false],
  ['implicit enabled missing arms', {}, false],
  ['disabled empty arms', { enabled: false, arms: [] }, false],
  ['disabled null arms', { enabled: false, arms: null }, false],
  ['disabled malformed arms', { enabled: false, arms: [{}] }, false],
  ['disabled invalid effort', { enabled: false, arms: [{ ...arm(), effort: 3 }] }, false],
  ['disabled unknown arm field', { enabled: false, arms: [{ ...arm(), unknown: true }] }, false],
  ['disabled invalid agentIds', { enabled: false, agentIds: 'reviewer' }, false],
  ['disabled invalid agentIds entry', { enabled: false, agentIds: [''] }, false],
  ['disabled unknown field', { enabled: false, unknown: true }, false],
  ['invalid enabled type', { enabled: 'false' }, false],
];
for (const [name, raw, valid] of configCases) {
  test(`reviewer config regression: ${name}`, () => {
    assert.equal(validateReviewerRouting(raw).length === 0, valid, 'routing validator');
    assert.equal(validateConfigShape({ reviewerRouting: raw }).length === 0, valid, 'plugin validator');
    if (raw.enabled === false) {
      assert.equal(normalizeReviewerRouting(raw), null);
      assert.equal(resolveConfig({ reviewerRouting: raw }).reviewerRouting, null);
    }
  });
}

test('reviewer config regression: disabled without arms retains legacy hook and capacity', async () => {
  const d = await start({ overrides: { reviewerRouting: { enabled: false } } });
  assert.deepEqual(await d.hook('disabled-routing'), { kind: 'keep' });
  const cap = await d.api('capacity');
  assert.equal(cap.reviewer.routing.enabled, false);
  assert.deepEqual(cap.reviewer.qualifiedAccountIds, ['claude:a1']);
  assert.ok(cap.reviewer.slots > 0);
  assert.equal(cap.reviewer.hold, false);
});

test('reviewer config regression: manifest conditionally requires arms while validating supplied fields', () => {
  // Structural contract only: this is not host schema-engine validation.
  const schema = manifest.instanceConfigSchema.properties.reviewerRouting;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.required, undefined);
  assert.deepEqual(schema.anyOf, [
    { required: ['enabled'], properties: { enabled: { const: false } } },
    { required: ['arms'] },
  ]);
  assert.deepEqual(schema.properties.enabled, { type: 'boolean', default: true });
  assert.equal(schema.properties.arms.type, 'array');
  assert.equal(schema.properties.arms.minItems, 1);
  assert.equal(schema.properties.arms.items.additionalProperties, false);
  assert.deepEqual(schema.properties.arms.items.required, ['provider', 'model']);
});

const legacyAccount = (extra = {}) => ({
  accountId: 'meta:meta-lane-7', pool: 'meta', label: 'Spare Seat',
  health: 'healthy', headroomPct: 0.6, ...extra,
});
const legacyCfg = { arms: [{ provider: 'meta', model: 'muse-spark-1.3-contributor', effort: 'xhigh' }] };

test('reviewer legacy regression: isBurnFlagged matches provider-qualified label without special tokens', () => {
  for (const token of ['codex:spare seat', 'meta:other seat']) {
    assert.equal(isBurnFlagged(legacyAccount(), burnModeTokens([token])), false, token);
  }
  assert.equal(isBurnFlagged(legacyAccount(), burnModeTokens(['meta:spare seat'])), true);
});

test('reviewer legacy regression: selectReviewerRoute matches provider-qualified label', () => {
  for (const token of ['codex:spare seat', 'meta:other seat', 'meta:spare seat']) {
    const route = selectReviewerRoute({ cfg: legacyCfg, accounts: [legacyAccount()], burnTokens: burnModeTokens([token]) });
    assert.equal(route.accountId, 'meta:meta-lane-7');
    assert.equal(route.burn, token === 'meta:spare seat', token);
  }
});

test('reviewer legacy regression: bare laneKey alias still matches in both exports', () => {
  const account = legacyAccount({ laneKey: 'legacy-seat' });
  const tokens = burnModeTokens(['legacy-seat']);
  assert.equal(isBurnFlagged(account, tokens), true);
  assert.equal(selectReviewerRoute({ cfg: legacyCfg, accounts: [account], burnTokens: tokens }).burn, true);
  assert.equal(isBurnFlagged(account, burnModeTokens(['other-seat'])), false);
  assert.equal(selectReviewerRoute({ cfg: legacyCfg, accounts: [account], burnTokens: burnModeTokens(['other-seat']) }).burn, false);
});
