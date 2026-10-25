import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelInventory, INVENTORY_VERSION, COMPAT_UNKNOWN } from '../src/inventory.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const UNKNOWN_COMPAT = { protocol: 'unknown', tools: 'unknown', reasoning: 'unknown', reason: 'no-evidence' };

// Raw, canonical and emitted ids stay side by side: a native account listing
// both the bare id and a prefixed alias emits the bare id, while a
// prefixed-only lane emits its alias.
test('inventory retains raw, canonical and emitted ids per account', () => {
  const inv = buildModelInventory({
    nowMs: NOW,
    accounts: [
      { accountId: 'claude:lane-1', provider: 'claude', models: ['claude-sonnet-5-5', 'claude/claude-sonnet-5-5'] },
      { accountId: 'devin:lane-1', provider: 'devin', models: ['devin/gpt-5-5'] },
      { accountId: 'meta:lane-1', provider: 'meta', models: ['muse-spark-1.3-contributor'] },
    ],
    servedModels: ['claude-sonnet-5-5', 'claude/claude-sonnet-5-5', 'devin/gpt-5-5', 'muse-spark-1.3-contributor'],
    arms: [
      { model: 'claude-sonnet-5-5', aaSlug: 'claude-sonnet-5-5', effort: 'max' },
      { model: 'gpt-5-5', aaSlug: 'gpt-5-5', effort: 'max' },
      { model: 'muse-spark-1.3-contributor', aaSlug: 'muse-spark-1-3', effort: 'max' },
    ],
  });
  assert.equal(inv.version, INVENTORY_VERSION);
  assert.deepEqual(inv.servedList, { status: 'present', count: 4 });

  const sonnet = inv.models.find(m => m.canonical === 'claude-sonnet-5-5');
  assert.deepEqual(sonnet.rawIds, ['claude-sonnet-5-5', 'claude/claude-sonnet-5-5']);
  assert.deepEqual(sonnet.emittedByAccount, { 'claude:lane-1': 'claude-sonnet-5-5' });
  assert.deepEqual(sonnet.servedIdStatusByAccount, { 'claude:lane-1': 'present' });
  assert.deepEqual(sonnet.arms, [{ aaSlug: 'claude-sonnet-5-5', effort: 'max' }]);
  assert.equal(sonnet.unscored, null);

  const gpt = inv.models.find(m => m.canonical === 'gpt-5-5');
  assert.deepEqual(gpt.rawIds, ['devin/gpt-5-5']);
  assert.deepEqual(gpt.emittedByAccount, { 'devin:lane-1': 'devin/gpt-5-5' });
  assert.deepEqual(gpt.servedIdStatusByAccount, { 'devin:lane-1': 'present' });

  const muse = inv.models.find(m => m.canonical === 'muse-spark-1.3-contributor');
  assert.deepEqual(muse.rawIds, ['muse-spark-1.3-contributor']);
  assert.equal(muse.emittedByAccount['meta:lane-1'], 'muse-spark-1.3-contributor');
  assert.deepEqual(muse.servedIdStatusByAccount, { 'meta:lane-1': 'present' });
});

// Native alias-only accounts depend on the global served list, not just the
// discovery spelling. An empty authoritative catalog is not an unknown one.
test('inventory uses the served catalog to choose native alias-only emissions', () => {
  for (const [servedModels, emitted, status] of [
    [['claude/claude-haiku-5-5'], 'claude/claude-haiku-5-5', 'present'],
    [['claude/claude-haiku-5-5', 'claude-haiku-5-5'], 'claude-haiku-5-5', 'present'],
    [[], 'claude/claude-haiku-5-5', 'absent'],
    [null, 'claude-haiku-5-5', 'unknown'],
  ]) {
    const inv = buildModelInventory({
      nowMs: NOW,
      accounts: [{ accountId: 'claude:lane-1', provider: 'claude', models: ['claude/claude-haiku-5-5'] }],
      servedModels,
    });
    const haiku = inv.models.find(m => m.canonical === 'claude-haiku-5-5');
    assert.deepEqual(haiku.emittedByAccount, { 'claude:lane-1': emitted });
    assert.deepEqual(haiku.servedIdStatusByAccount, { 'claude:lane-1': status });
    assert.deepEqual(inv.servedList, {
      status: servedModels === null ? 'unknown' : 'present',
      count: servedModels === null ? null : servedModels.length,
    });
  }
});

test('inventory keeps each account\'s raw spellings alongside their union', () => {
  const inv = buildModelInventory({
    accounts: [
      { accountId: 'claude:lane-1', provider: 'claude', models: ['claude-haiku-5-5', 'claude-haiku-5-5'] },
      { accountId: 'claude:lane-2', provider: 'claude', models: ['claude/claude-haiku-5-5'] },
    ],
  });
  const haiku = inv.models.find(m => m.canonical === 'claude-haiku-5-5');
  assert.deepEqual(haiku.rawIds, ['claude-haiku-5-5', 'claude/claude-haiku-5-5']);
  assert.deepEqual(haiku.rawIdsByAccount, {
    'claude:lane-1': ['claude-haiku-5-5'],
    'claude:lane-2': ['claude/claude-haiku-5-5'],
  });
});

test('inventory counts refusal evidence separately from absent unscored ids', () => {
  const inv = buildModelInventory({
    accounts: [{ accountId: 'acme:lane-1', provider: 'acme', models: ['new-model-1'] }],
    servedModels: [],
    unscored: [{ model: 'new-model-1', reason: 'no-aa-match', tried: ['new-model-1'] }],
  });
  assert.equal(inv.counts.servedAbsent, 1);
  assert.equal(inv.counts.unservable, 0);
  assert.deepEqual(inv.models[0].unservable, []);
});

// An emitted id the served list does not contain reads absent and links the
// existing unservable evidence; readiness rows ride along per model.
test('inventory links absent served ids, unservable and readiness evidence', () => {
  const inv = buildModelInventory({
    nowMs: NOW,
    accounts: [{ accountId: 'devin:lane-1', provider: 'devin', models: ['devin/gpt-5-5'] }],
    servedModels: ['devin/gpt-5-4'],
    arms: [{ model: 'gpt-5-5', aaSlug: 'gpt-5-5', effort: 'max' }],
    unservable: [{ model: 'devin/gpt-5-5', accountId: 'devin:lane-1', emitted: 'devin/gpt-5-5' }],
    credentialAdmission: [{ accountId: 'devin:lane-1', provider: 'devin', model: 'gpt-5-5', eligible: true, reason: 'ready' }],
  });
  const gpt = inv.models.find(m => m.canonical === 'gpt-5-5');
  assert.deepEqual(gpt.servedIdStatusByAccount, { 'devin:lane-1': 'absent' });
  assert.deepEqual(gpt.unservable, [{ accountId: 'devin:lane-1', emitted: 'devin/gpt-5-5' }]);
  assert.deepEqual(gpt.readiness, [{ accountId: 'devin:lane-1', eligible: true, reason: 'ready' }]);
  assert.deepEqual(inv.counts.servedAbsent, 1);
  assert.deepEqual(inv.counts.unservable, 1);
});

// A feed without a served list stays fail-open: every emitted id reads
// unknown, never absent.
test('inventory reads unknown when the feed publishes no served list', () => {
  const inv = buildModelInventory({
    nowMs: NOW,
    accounts: [{ accountId: 'claude:lane-1', provider: 'claude', models: ['claude-haiku-5-5'] }],
    servedModels: null,
    arms: [{ model: 'claude-haiku-5-5', aaSlug: 'claude-haiku-5-5', effort: 'max' }],
  });
  assert.deepEqual(inv.servedList, { status: 'unknown', count: null });
  const haiku = inv.models.find(m => m.canonical === 'claude-haiku-5-5');
  assert.deepEqual(haiku.servedIdStatusByAccount, { 'claude:lane-1': 'unknown' });
  assert.deepEqual(haiku.unservable, []);
});

// Models with no AA match stay listed with their unscored reason, never
// silently dropped; compatibility stays unknown without evidence.
test('inventory keeps unscored models and marks compatibility unknown', () => {
  const inv = buildModelInventory({
    nowMs: NOW,
    accounts: [{ accountId: 'acme:lane-1', provider: 'acme', models: ['new-model-1'] }],
    servedModels: ['new-model-1'],
    arms: [],
    unscored: [{ model: 'new-model-1', reason: 'no-aa-match', tried: ['new-model-1'] }],
  });
  const entry = inv.models.find(m => m.canonical === 'new-model-1');
  assert.deepEqual(entry.arms, []);
  assert.deepEqual(entry.unscored, { reason: 'no-aa-match', tried: ['new-model-1'] });
  assert.deepEqual(entry.compatibility, UNKNOWN_COMPAT);
  assert.deepEqual(inv.compatibility, UNKNOWN_COMPAT);
  assert.deepEqual(COMPAT_UNKNOWN, UNKNOWN_COMPAT);
  assert.equal(inv.counts.unscored, 1);
});

// Configured-model coverage is incomplete: other-agent adapter configuration
// is restricted, so no fleet-wide configured-model census is claimed.
test('inventory marks configured-model coverage incomplete', () => {
  const inv = buildModelInventory({ nowMs: NOW, accounts: [], servedModels: [] });
  assert.deepEqual(inv.configuredModels, {
    coverage: 'incomplete',
    reason: 'agent-config-restricted',
    detail: 'other-agent adapter configuration is restricted; no fleet-wide configured-model census is claimed',
  });
  assert.deepEqual(inv.models, []);
});

// Feeds that predate `models` bind classic arms by provider tag: the models
// still appear, with no raw evidence and the account named for audit.
test('inventory covers provider-bound arms on feeds without model lists', () => {
  const inv = buildModelInventory({
    nowMs: NOW,
    accounts: [{ accountId: 'claude:lane-1', provider: 'claude', models: null }],
    servedModels: null,
    arms: [{ model: 'claude-haiku-5-5', aaSlug: 'claude-haiku-5-5', effort: 'max', providers: ['claude'] }],
  });
  assert.deepEqual(inv.feedModelsAbsentAccounts, ['claude:lane-1']);
  const haiku = inv.models.find(m => m.canonical === 'claude-haiku-5-5');
  assert.deepEqual(haiku.rawIds, []);
  assert.deepEqual(haiku.rawIdsByAccount, { 'claude:lane-1': [] });
  assert.deepEqual(haiku.servedBy, ['claude:lane-1']);
  assert.deepEqual(haiku.servedIdStatusByAccount, { 'claude:lane-1': 'unknown' });
});

async function capacityFor(lane, rows) {
  const config = { enforce: false, cliproxy: { laneKeySecretRef: SECRET } };
  const store = new Map();
  const jobs = new Map();
  const key = k => JSON.stringify(k);
  const plugin = createModelCapacityPlugin({ clock: () => NOW, requirePinnedLaneHost: false });
  await plugin.setup({
    config: { get: async () => config },
    state: { get: async k => store.get(key(k)) ?? null, set: async (k, v) => { store.set(key(k), v); } },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness(lane, NOW, { emitted: { devin: ['gpt-5-5'] } }) }) },
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
  return (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body;
}

// End to end: the shadow tick publishes the inventory on /capacity next to
// the existing unscored/unservable fields, from synthetic fixtures only.
test('/capacity publishes the read-only model inventory', async () => {
  const lane = {
    observedAt: new Date(NOW).toISOString(),
    servedModels: ['claude-haiku-5-5', 'devin/gpt-5-5'],
    accounts: [
      {
        lane: 'lane-1', provider: 'claude', accountKey: 'lane-1',
        health: 'healthy', meter: 'reactive', models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'new-model-1'],
        weekly: { used: null, resetsAt: null }, fiveHour: { used: null, resetsAt: null },
        observedAt: new Date(NOW).toISOString(), quality: 'reactive',
      },
      {
        lane: 'lane-2', provider: 'devin', accountKey: 'lane-2',
        health: 'healthy', meter: 'reactive', models: ['devin/gpt-5-5'],
        weekly: { used: null, resetsAt: null }, fiveHour: { used: null, resetsAt: null },
        observedAt: new Date(NOW).toISOString(), quality: 'reactive',
      },
    ],
  };
  const rows = [
    { slug: 'claude-haiku-5-5', intelligenceIndex: 60, intelligenceIndexCostPerTask: 7, price1mInputTokens: 1, price1mOutputTokens: 4 },
    { slug: 'claude-sonnet-5-5', intelligenceIndex: 75, intelligenceIndexCostPerTask: 8, price1mInputTokens: 1, price1mOutputTokens: 4 },
    { slug: 'gpt-5-5', intelligenceIndex: 70, intelligenceIndexCostPerTask: 10, price1mInputTokens: 1, price1mOutputTokens: 4 },
  ];
  const capacity = await capacityFor(lane, rows);
  const inv = capacity.modelInventory;
  assert.equal(inv.version, INVENTORY_VERSION);
  assert.deepEqual(inv.servedList, { status: 'present', count: 2 });
  assert.equal(inv.configuredModels.coverage, 'incomplete');
  const haiku = inv.models.find(m => m.canonical === 'claude-haiku-5-5');
  assert.deepEqual(haiku.rawIds, ['claude-haiku-5-5']);
  assert.deepEqual(haiku.rawIdsByAccount, { 'claude:lane-1': ['claude-haiku-5-5'] });
  assert.equal(haiku.emittedByAccount['claude:lane-1'], 'claude-haiku-5-5');
  assert.equal(haiku.servedIdStatusByAccount['claude:lane-1'], 'present');
  const gpt = inv.models.find(m => m.canonical === 'gpt-5-5');
  assert.deepEqual(gpt.rawIdsByAccount, { 'devin:lane-2': ['devin/gpt-5-5'] });
  assert.equal(gpt.emittedByAccount['devin:lane-2'], 'devin/gpt-5-5');
  assert.equal(gpt.servedIdStatusByAccount['devin:lane-2'], 'present');
  assert.deepEqual(haiku.arms, [{ aaSlug: 'claude-haiku-5-5', effort: 'max' }]);
  assert.deepEqual(haiku.readiness, [{ accountId: 'claude:lane-1', eligible: true, reason: 'ready' }]);
  assert.deepEqual(haiku.unservable, []);
  assert.equal(haiku.unscored, null);
  assert.deepEqual(gpt.arms, [{ aaSlug: 'gpt-5-5', effort: 'max' }]);
  assert.deepEqual(gpt.readiness, [{ accountId: 'devin:lane-2', eligible: true, reason: 'ready' }]);
  assert.deepEqual(gpt.unservable, []);
  const sonnet = inv.models.find(m => m.canonical === 'claude-sonnet-5-5');
  assert.deepEqual(sonnet.rawIdsByAccount, { 'claude:lane-1': ['claude-sonnet-5-5'] });
  assert.deepEqual(sonnet.arms, [{ aaSlug: 'claude-sonnet-5-5', effort: 'max' }]);
  assert.deepEqual(sonnet.unservable, [{ accountId: 'claude:lane-1', emitted: 'claude-sonnet-5-5' }]);
  assert.deepEqual(sonnet.readiness, []);
  assert.equal(sonnet.unscored, null);
  const unknown = inv.models.find(m => m.canonical === 'new-model-1');
  assert.deepEqual(unknown.rawIdsByAccount, { 'claude:lane-1': ['new-model-1'] });
  assert.deepEqual(unknown.arms, []);
  assert.deepEqual(unknown.unscored, { reason: 'no-aa-match', tried: ['new-model-1'] });
  assert.deepEqual(unknown.unservable, []);
  assert.deepEqual(unknown.readiness, []);
  assert.deepEqual(inv.counts, {
    canonicalModels: 4, rawIds: 4, servedPresent: 2, servedAbsent: 2,
    servedUnknown: 0, unscored: 1, unservable: 1,
  });
});

// Both entries have the same normalized accountId. The tick's unique keys
// must survive projection even though their canonical model is identical.
test('/capacity preserves duplicate account identities and differing served statuses', async () => {
  const capacity = await capacityFor({
    observedAt: new Date(NOW).toISOString(),
    servedModels: ['claude/claude-haiku-5-5'],
    accounts: [
      {
        lane: 'lane-1', provider: 'claude', accountKey: 'shared',
        health: 'healthy', meter: 'reactive', models: ['claude/claude-haiku-5-5'],
        weekly: { used: null, resetsAt: null }, fiveHour: { used: null, resetsAt: null },
        observedAt: new Date(NOW).toISOString(), quality: 'reactive',
      },
      {
        lane: 'lane-2', provider: 'claude', accountKey: 'shared',
        health: 'healthy', meter: 'reactive', models: ['claude-haiku-5-5'],
        weekly: { used: null, resetsAt: null }, fiveHour: { used: null, resetsAt: null },
        observedAt: new Date(NOW).toISOString(), quality: 'reactive',
      },
    ],
  }, [{ slug: 'claude-haiku-5-5', intelligenceIndex: 60, intelligenceIndexCostPerTask: 7,
    price1mInputTokens: 1, price1mOutputTokens: 4 }]);
  const inv = capacity.modelInventory;
  assert.equal(inv.models.length, 1);
  const haiku = inv.models[0];
  assert.deepEqual(haiku.servedBy, ['claude:shared', 'claude:shared#lane-2']);
  assert.deepEqual(haiku.emittedByAccount, {
    'claude:shared': 'claude/claude-haiku-5-5',
    'claude:shared#lane-2': 'claude-haiku-5-5',
  });
  assert.deepEqual(haiku.servedIdStatusByAccount, {
    'claude:shared': 'present', 'claude:shared#lane-2': 'absent',
  });
  assert.deepEqual(haiku.rawIdsByAccount, {
    'claude:shared': ['claude/claude-haiku-5-5'],
    'claude:shared#lane-2': ['claude-haiku-5-5'],
  });
  assert.deepEqual(haiku.arms, [{ aaSlug: 'claude-haiku-5-5', effort: 'max' }]);
  // Duplicate credential identities stay fail-closed even while the report
  // disambiguates each lane's discovery and servability evidence.
  assert.deepEqual(haiku.readiness, [{ accountId: 'claude:shared', eligible: false, reason: 'ambiguous-account' }]);
  assert.deepEqual(haiku.unservable, [{ accountId: 'claude:shared#lane-2', emitted: 'claude-haiku-5-5' }]);
  assert.deepEqual(inv.counts, {
    canonicalModels: 1, rawIds: 2, servedPresent: 1, servedAbsent: 1,
    servedUnknown: 0, unscored: 0, unservable: 1,
  });
});
