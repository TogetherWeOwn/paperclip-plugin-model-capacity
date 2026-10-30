import test from 'node:test';
import assert from 'node:assert/strict';
import * as arms from '../src/arms.mjs';
import { resolveConfig, validateConfigShape } from '../src/plugin.mjs';

test('mandatory banned models cannot create dynamic, classic, or task arms', () => {
  for (const model of ['gpt-6-sol', 'devin/gpt-6-sol', 'gpt-5.6-terra', 'gpt-5-6-terra', 'devin/gpt-5-6-terra']) {
    const bare = arms.canonicalModelName(model);
    const row = { slug: bare.replaceAll('.', '-'), intelligenceIndex: 50, intelligenceIndexCostPerTask: 1 };
    const binding = { aaSlug: row.slug, model: bare, family: 'terra', effort: 'max', providers: ['devin'] };
    assert.equal(arms.isBannedModel(model, []), true, model);
    assert.equal(arms.buildDynamicBindings([model]).unscored[0].reason, 'banned-model');
    assert.equal(arms.resolveArms([row], [binding]).skipped[0].reason, 'banned-model');
    assert.equal(arms.discoverTaskArms([row], [model]).unscored[0].reason, 'banned-model');
  }
  for (const model of ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-5.6-sol', 'swe-2']) assert.equal(arms.isBannedModel(model, []), false, model);
  assert.equal(arms.isBannedModel('devin/kimi-k3', ['kimi-k3']), true);
});

test('additional banned model configuration only widens mandatory bans', () => {
  assert.ok(validateConfigShape({ bannedModels: ['devin/kimi-k3'] }).some(e => e.includes('bannedModels')));
  assert.ok(validateConfigShape({ bannedModels: [null] }).some(e => e.includes('bannedModels')));
  assert.deepEqual(resolveConfig({ bannedModels: ['kimi-k3', 'kimi-k3'] }).bannedModels, ['kimi-k3']);
  assert.deepEqual(validateConfigShape({ bannedModels: [] }), []);
});

test('resolveConfig canonicalizes prefixed additional bans rather than dropping them', () => {
  const config = resolveConfig({ bannedModels: ['devin/kimi-k3', 'kimi-k3', ' nvidia-nim/glm-5 ', null, '', 'devin/'] });
  assert.deepEqual(config.bannedModels, ['kimi-k3', 'glm-5']);
  assert.equal(arms.isBannedModel('kimi-k3', config.bannedModels), true);
  assert.equal(arms.isBannedModel('nvidia-nim/kimi-k3', config.bannedModels), true);
  assert.equal(arms.isBannedModel('devin/glm-5', config.bannedModels), true);
  assert.equal(arms.isBannedModel('devin/swe-2', config.bannedModels), false);
});

test('explicit missing-AA admission preserves null score and rejects proven families', () => {
  const bindings = arms.buildDynamicBindings(['devin/swe-2', 'devin/claude-opus-99-9']).bindings;
  const unscoredAllowlist = new Map([
    ['swe-2', [{ servedId: 'devin/swe-2', reason: 'documented trial' }]],
    ['claude-opus-99-9', [{ servedId: 'devin/claude-opus-99-9', reason: 'documented trial' }]],
  ]);
  const result = arms.resolveDynamicArms([], bindings, { unscoredAllowlist });
  const swe = result.arms.find(a => a.model === 'swe-2');
  assert.equal(swe?.row, null);
  assert.equal(swe?.aaSlug, null);
  assert.equal(swe?.unscoredTrial, true);
  assert.deepEqual(swe?.unscoredServedIds, ['devin/swe-2']);
  assert.equal(result.unscored.find(u => u.model === 'claude-opus-99-9')?.reason, 'unscored-proven-family');
  assert.equal(arms.resolveDynamicArms([], bindings).unscored.find(u => u.model === 'swe-2')?.reason, 'no-aa-match');
});

test('unscored allowlist requires exact, unique ids, provenance, and new unbanned families', () => {
  const check = value => validateConfigShape({ trials: { unscoredServedIds: value } });
  assert.deepEqual(check([{ servedId: 'devin/swe-2', reason: 'documented' }]), []);
  for (const value of [[{ servedId: 'devin/swe-2', reason: '' }], [{ servedId: 'devin/claude-opus-99-9', reason: 'x' }],
    [{ servedId: 'devin/gpt-6-sol', reason: 'x' }], [{ servedId: 'devin/swe-2', reason: 'x' }, { servedId: 'devin/swe-2', reason: 'y' }], 'invalid']) {
    assert.ok(check(value).some(e => e.includes('unscoredServedIds')), JSON.stringify(value));
  }
});

test('unscored free trials share rung zero without changing benchmark rungs', async () => {
  const { paretoFilter, buildLadder, LOW_COVERAGE_MAX_RUNG } = await import('../src/ladder.mjs');
  const scored = [{ armId: 'a', Q: 1, C: 2, coverage: 1 }, { armId: 'b', Q: 2, C: 3, coverage: 1 }];
  const trial = { armId: 'swe-2', Q: null, C: 0, coverage: 0 };
  const ordinary = paretoFilter(scored);
  const result = paretoFilter([...scored, trial], { unscoredArmIds: new Set(['swe-2']) });
  assert.deepEqual(result.rungs, ordinary.rungs);
  assert.deepEqual(result.unscored, [{ rung: 0, armId: 'swe-2', Q: null, C: 0, coverage: 0, maxRung: LOW_COVERAGE_MAX_RUNG, unscoredTrial: true }]);
  assert.deepEqual(buildLadder([...scored, trial], [], null, [], { unscoredArmIds: new Set(['swe-2']) }).unscored, result.unscored);
  assert.deepEqual(paretoFilter([{ ...trial, C: null }], { unscoredArmIds: new Set(['swe-2']) }).dropped, ['swe-2']);
  assert.equal(Object.hasOwn(ordinary, 'unscored'), false);
});

test('free-price expiry only accepts exact timezone-explicit real timestamps', async () => {
  const { parseFreeUntil, normalizeFreeCostServedIds } = await import('../src/plugin.mjs');
  const good = [['2026-11-30T23:59:59Z', Date.UTC(2026,10,30,23,59,59)],
    ['2026-11-30T23:59:59+00:00', Date.UTC(2026,10,30,23,59,59)],
    ['2026-11-30T23:59:59.500Z', Date.UTC(2026,10,30,23,59,59,500)],
    ['2026-11-30T23:59+02:00', Date.UTC(2026,10,30,21,59)]];
  const bad = ['2026-11-31T23:59:59Z', '2026-02-30T00:00:00Z', '2026-11-30T24:00:00Z',
    '2026-11-30T23:59:60Z', ['2026-11-30T23:59:59Z'], 1796083199000,
    '2026-11-30T23:59:59', '2026-11-30 23:59:59Z', '2026-11-30', null, {}];
  for (const [until, expected] of good) {
    assert.equal(parseFreeUntil(until), expected);
    const config = { placement: { freeCostServedIds: { 'devin/swe-2': { until, reason: 'documentation' } } } };
    assert.deepEqual(validateConfigShape(config), []);
    assert.equal(normalizeFreeCostServedIds(config.placement.freeCostServedIds)['devin/swe-2'].untilMs, expected);
  }
  for (const until of bad) {
    assert.equal(parseFreeUntil(until), null, JSON.stringify(until));
    const map = { 'devin/swe-2': { until, reason: 'documentation' } };
    assert.ok(validateConfigShape({ placement: { freeCostServedIds: map } }).some(e => e.includes('real calendar date')));
    assert.equal(Object.hasOwn(normalizeFreeCostServedIds(map), 'devin/swe-2'), false);
  }
});

async function driveDevin({ mode = 'off', until = '2026-11-30T23:59:59Z', free = true, onlySwe = false, twins = false, folding = false, scoredFree = false, cap = 8, unhealthy = false, excludeSol = false, highOnly = false, priceRace = false, dominance = false, trialSettings = {}, configExtra = {}, nativeUnavailable = false, devinModels = null, onlyDevin = false, initialBreakers = null, aaExtraRows = [] } = {}) {
  const { createModelCapacityPlugin } = await import('../src/plugin.mjs');
  const { withSyntheticReadiness } = await import('./synthetic-readiness.mjs');
  let now = Date.parse('2026-11-01T00:00:00Z');
  const store = new Map(), jobs = new Map(), handlers = new Map();
  const models = [...(devinModels ?? ['devin/swe-2', 'devin/kimi-k3']), 'nvidia-nim/swe-2'];
  const accounts = [
    { provider: 'devin', accountKey: 'd', models: models.slice(0, 2), health: 'healthy', meter: 'reactive', quality: 'reactive' },
    { provider: 'nvidia-nim', accountKey: 'n', models: [models[2]], health: 'healthy', meter: 'reactive', quality: 'reactive' },
  ];
  if (onlyDevin) accounts.splice(1);
  if (onlySwe) { accounts.splice(1); accounts[0].models = ['devin/swe-2']; }
  if (priceRace) { accounts.splice(1); accounts[0].models = [...(priceRace === 'growth' ? [] : ['devin/kimi-k3']), 'devin/glm-5', 'devin/gpt-6-1-sol']; models.splice(0, models.length, ...accounts[0].models); }
  if (twins) {
    accounts.splice(0, accounts.length,
      { provider: 'codex', accountKey: 'native', models: ['gpt-6.1-sol'], health: 'healthy', meter: 'live', quality: 'live', weekly: { used: .1, resetsAt: '2026-11-08T00:00:00Z' }, fiveHour: { used: .1, resetsAt: '2026-11-01T05:00:00Z' } },
      { provider: 'devin', accountKey: 'd', models: ['devin/gpt-6-1-sol', 'devin/swe-2'], health: 'healthy', meter: 'reactive', quality: 'reactive' });
  }
  if (dominance) {
    accounts.splice(0, accounts.length,
      { provider: 'codex', accountKey: 'native', models: ['gpt-6.1-sol'], health: 'healthy', meter: 'live', quality: 'live', weekly: { used: .1, resetsAt: '2026-11-08T00:00:00Z' }, fiveHour: { used: .1, resetsAt: '2026-11-01T05:00:00Z' } },
      { provider: 'devin', accountKey: 'd', models: ['devin/gpt-5-6-sol', 'devin/swe-2', 'devin/kimi-k3'], health: 'healthy', meter: 'reactive', quality: 'reactive' });
  }
  if (nativeUnavailable) accounts.filter(a => a.provider === 'codex').forEach(a => { a.health = 'unhealthy'; });
  if (unhealthy) accounts.find(a => a.provider === 'devin').health = 'unhealthy';
  const lane = { observedAt: new Date(now).toISOString(), servedModels: dominance ? ['gpt-6.1-sol', 'devin/gpt-5-6-sol', 'devin/swe-2', 'devin/kimi-k3'] : twins ? ['gpt-6.1-sol', 'devin/gpt-6-1-sol', 'devin/swe-2'] : onlySwe ? ['devin/swe-2'] : models, accounts };
  const config = { enforce: true, calibration: { referenceArmId: 'gpt-6-1-sol', referenceBurnPerRunPct: .0005 }, pacing: { guard: { enabled: false } }, cliproxy: { laneKeySecretRef: { type: 'secret_ref', secretId: 'test' } }, taskRanking: { mode },
    roles: { thinkerAgentIds: ['thinker'], doerAgentIds: ['builder'], ...(excludeSol ? { excludeFamilies: { doer: ['sol'] } } : {}), minQuality: { doer: null, thinker: null, other: null } },
    trials: { roles: ['doer'], adapters: { 'claude-code': ['*'] }, maxInFlightPerAccount: 8, maxInFlightPerAccountByProvider: { devin: cap }, unscoredServedIds: [{ servedId: 'devin/swe-2', reason: 'documented trial' }], ...trialSettings },
    placement: { duplicateVersionPunctuationFolding: folding, freeCostServedIds: free ? { 'devin/swe-2': { until, reason: 'documented offer' }, 'nvidia-nim/swe-2': { until, reason: 'fixture' }, ...(scoredFree ? { [priceRace === 'growth' ? 'devin/gpt-6-1-sol' : 'devin/kimi-k3']: { until, reason: 'test price' } } : {}) } : {} }, ...configExtra };
  const io = { config: { get: async () => config }, state: { get: async k => store.get(JSON.stringify(k)) ?? null, set: async (k,v) => store.set(JSON.stringify(k),v) },
    secrets: { resolve: async () => 'test' }, http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness(lane, now, { emitted: { devin: [...models.slice(0, 2), 'swe-2', 'devin/gpt-6-1-sol', 'devin/gpt-5-6-sol', 'devin/glm-5'], 'nvidia-nim': [models[2]] } }) }) },
    agents: { get: async () => ({ adapterType: 'claude-code' }) }, issues: { get: async () => ({ assigneeAdapterOverrides: { adapterConfig: { model: 'devin/swe-2' } } }), list: async () => [] },
    jobs: { register: (n,f) => jobs.set(n,f) }, events: { on: (n, fn) => handlers.set(n, fn) }, logger: { info() {}, error() {}, warn() {} } };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  await plugin.setup(io);
  store.set(JSON.stringify({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' }),
    { fetchedAt: new Date(now).toISOString(), rows: [
      ...aaExtraRows,
      ...(dominance ? [{ slug: 'gpt-5-6-sol', intelligenceIndex: 50, intelligenceIndexCostPerTask: 8 }] : []),
      ...(priceRace ? [{ slug: 'glm-5', intelligenceIndex: 45, intelligenceIndexCostPerTask: 1, terminalbenchV40: .8, scicode: .8, lcr: .8, ifbench: .8, omniscienceNonHallucination: .8, hle: .2, gpqa: .2, critpt: .2, gdpvalNormalized: .2 }] : []),
      { slug: 'kimi-k3', intelligenceIndex: priceRace && priceRace !== 'growth' ? 40 : 55, intelligenceIndexCostPerTask: priceRace || dominance ? 10 : 5, terminalbenchV40: .8, scicode: .8, lcr: .8, ifbench: .8, omniscienceNonHallucination: .8, hle: .2, gpqa: .2, critpt: .2, gdpvalNormalized: .2 },
      ...(highOnly ? ['gpt-6-1-sol-high'] : ['gpt-6-1-sol', 'gpt-6-1-sol-high']).map((slug, i) => ({ slug, intelligenceIndex: 65-i, intelligenceIndexCostPerTask: 3-i, terminalbenchV40: .8, scicode: .8, lcr: .8, ifbench: .8, omniscienceNonHallucination: .8, hle: .2, gpqa: .2, critpt: .2, gdpvalNormalized: .2 }))], duplicateSlugs: [] });
  await plugin.onConfigChanged(config, { companyId: 'acme' });
  if (initialBreakers) store.set(JSON.stringify({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'breaker-v1' }), initialBreakers);
  await jobs.get('shadow-tick')({});
  return { plugin, tick: async () => jobs.get('shadow-tick')({}), fire: async (id, type) => handlers.get(type)({ type, companyId: 'acme', entityId: id, occurredAt: new Date(now).toISOString(), payload: { run: { agentId: 'builder', issueId: 'swe-issue', adapterType: 'claude-code' } } }), setNow: v => { now = v; }, capacity: async () => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body,
    ladder: async () => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'ladder' })).body,
    shadow: async () => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'shadow' })).body,
    hook: (runId = 'hook', agentId = 'builder') => plugin.onResolveRunModel({ runId, companyId: 'acme', agentId, adapterType: 'claude-code', deadlineMs: 1500 }) };
}

test('full tick admits a free unscored arm only to its exact serving account', async () => {
  const d = await driveDevin();
  const ladder = await d.ladder();
  const devin = ladder.ladders['devin:d'];
  const swe = devin.credentialRanking.candidates.find(a => a.armId === 'swe-2');
  assert.ok(swe);
  assert.equal(swe.model, 'devin/swe-2');
  assert.equal(swe.Q, null);
  assert.equal(swe.qFleet, null);
  assert.equal(swe.contextWindow, null);
  assert.equal(swe.costBase, null);
  assert.equal(swe.C, 0);
  assert.equal(swe.trial, true);
  assert.ok(devin.rungs.some(a => a.armId === 'swe-2'));
  assert.equal(ladder.ladders['nvidia-nim:n'].credentialRanking.candidates.some(a => a.armId === 'swe-2'), false);
});

test('a cached unscored arm is withdrawn when its included-price deadline passes', async () => {
  const until = '2026-11-01T00:01:00Z';
  const d = await driveDevin({ until, onlySwe: true });
  assert.equal((await d.hook()).model, 'devin/swe-2');
  d.setNow(Date.parse(until) + 1);
  assert.notEqual((await d.hook()).model, 'devin/swe-2');
});

test('task-enforced ranking does not admit missing-AA trial arms', async () => {
  const d = await driveDevin({ mode: 'enforce' });
  const cap = await d.capacity();
  assert.ok(cap.taskRanking.candidates.some(c => c.model === 'devin/swe-2' && c.matchType === 'missing'));
  assert.notEqual((await d.hook()).model, 'devin/swe-2');
});

test('opt-in version folding detects duplicate aggregator arms but not unique models', async () => {
  const { nativeQualifiedModels, isFallbackOnlyView } = await import('../src/cross-account.mjs');
  const native = { provider: 'codex', health: 'healthy', meter: 'live', headroomPct: .9, models: ['gpt-6.1-sol', 'claude-opus-5.5'] };
  const duplicate = { provider: 'devin', health: 'healthy', meter: 'reactive', models: ['devin/gpt-6-1-sol', 'devin/claude-opus-5-5'] };
  const mixed = { ...duplicate, models: [...duplicate.models, 'devin/swe-2'] };
  assert.equal(arms.aliasKey('gpt-6.1-sol'), arms.aliasKey('devin/gpt-6-1-sol'));
  assert.equal(arms.aliasKey('claude-opus-5.5'), arms.aliasKey('claude-opus-5-5'));
  assert.notEqual(arms.aliasKey('a.5x'), arms.aliasKey('a-5x'));
  assert.equal(isFallbackOnlyView(duplicate, nativeQualifiedModels([native])), false);
  const nativeKeys = nativeQualifiedModels([native], .05, arms.aliasKey);
  assert.equal(isFallbackOnlyView(duplicate, nativeKeys, arms.aliasKey), true);
  assert.equal(isFallbackOnlyView(mixed, nativeKeys, arms.aliasKey), false);
  assert.ok(validateConfigShape({ placement: { duplicateVersionPunctuationFolding: 'true' } }).some(e => e.includes('duplicateVersionPunctuationFolding')));
});

test('folded duplicate classification holds every task effort on a mixed account', async () => {
  const on = await driveDevin({ mode: 'enforce', twins: true, folding: true });
  const ladder = (await on.ladder()).ladders['devin:d'];
  assert.ok(ladder.credentialRanking.duplicateArmIds.includes('gpt-6-1-sol'));
  assert.equal(ladder.credentialRanking.duplicateArmIds.includes('swe-2'), false);
  const taskCandidates = ladder.taskRoles.doer.candidates.filter(c => c.canonicalModel === 'gpt-6-1-sol');
  assert.ok(taskCandidates.some(c => c.effort === 'high'));
  const hook = await on.hook();
  assert.equal(hook.model, 'gpt-6.1-sol');
  for (const c of taskCandidates) assert.ok(ladder.credentialRanking.duplicateTaskArmIds.includes(c.armId), c.armId);
  const off = (await (await driveDevin({ mode: 'enforce', twins: true })).ladder()).ladders['devin:d'];
  assert.equal(Object.hasOwn(off.credentialRanking, 'duplicateTaskArmIds'), false);
  assert.equal(off.credentialRanking.duplicateArmIds.includes('gpt-6-1-sol'), false);
});

test('scored task-path included price changes cash but not resource cost', async () => {
  const paid = await driveDevin({ mode: 'enforce' });
  const free = await driveDevin({ mode: 'enforce', scoredFree: true });
  const pick = cap => cap.taskRanking.candidates.find(c => c.model === 'devin/kimi-k3' && c.role === 'doer');
  const a = pick(await paid.capacity()), b = pick(await free.capacity());
  assert.equal(a.cashUsdPerAcceptedTask, null);
  assert.equal(b.cashUsdPerAcceptedTask, 0);
  assert.equal(b.costFreeSource, 'served-id');
  assert.equal(b.taskCostProxy, a.taskCostProxy);
  assert.equal(b.quotaBurnPerRunPct, a.quotaBurnPerRunPct);
});

test('manifest exposes optional exact-id controls with safe defaults', async () => {
  const { manifest } = await import('../src/manifest.mjs');
  const p = manifest.instanceConfigSchema.properties;
  assert.deepEqual(p.bannedModels.default, []);
  assert.match(p.bannedModels.description, /only widens/);
  assert.deepEqual(p.trials.properties.unscoredServedIds.default, []);
  assert.deepEqual(p.placement.properties.freeCostServedIds.default, {});
  assert.equal(p.placement.properties.duplicateVersionPunctuationFolding.default, false);
});

test('paid and free candidates share a single reactive account cap', async () => {
  const d = await driveDevin({ cap: 1 });
  const first = await d.hook('first');
  assert.equal(first.model, 'devin/kimi-k3');
  const second = await d.hook('second');
  assert.notEqual(second.model, 'devin/swe-2');
  assert.equal(second.kind, 'defer');
  const cap = await d.capacity();
  assert.equal(cap.accounts.filter(a => a.provider === 'devin').length, 1);
});

test('version folding has only the documented spelling twins in the served corpus', async () => {
  const { readFile } = await import('node:fs/promises');
  const models = JSON.parse(await readFile(new URL('./served-models-20261010.json', import.meta.url), 'utf8'));
  const seen = new Map();
  for (const model of models) {
    const key = arms.aliasKey(model), name = arms.canonicalModelName(model).toLowerCase();
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(name);
  }
  const collisions = [...seen.values()].filter(v => v.size > 1).map(v => [...v].sort().join(' = ')).sort();
  assert.deepEqual(collisions, [
    'deepseek-v4-1-flash = deepseek-v4.1-flash', 'gpt-5-6-terra = gpt-5.6-terra',
    'grok-4-5 = grok-4.5', 'grok-4-6 = grok-4.6', 'grok-4-7 = grok-4.7', 'kimi-k2-6 = kimi-k2.6',
  ]);
});

test('an unhealthy unscored trial remains structurally present and preserves manual exclusions', async () => {
  const d = await driveDevin({ twins: true, unhealthy: true, excludeSol: true });
  const cap = await d.capacity();
  assert.ok(cap.eligibility.roles.doer.excludedFamilies.includes('sol'));
  assert.equal(cap.eligibility.warnings.some(w => w.code === 'manual-suspended' && w.role === 'doer'), false);
  assert.equal((await d.hook()).kind, 'defer');
  const noPrice = await driveDevin({ twins: true, unhealthy: true, excludeSol: true, free: false });
  const other = await noPrice.capacity();
  assert.ok(other.eligibility.warnings.some(w => w.code === 'manual-suspended' && w.role === 'doer'));
});

test('a free trial consumes the shared reactive account cap', async () => {
  const d = await driveDevin({ cap: 1, onlySwe: true });
  assert.equal((await d.hook('swe-run')).model, 'devin/swe-2');
  assert.equal((await d.hook('next-run')).kind, 'defer');
});

test('expired and missing included-price entries do not price unscored arms', async () => {
  for (const opts of [{ free: false }, { until: '2026-10-31T23:59:59Z' }]) {
    const d = await driveDevin({ ...opts, onlySwe: true });
    const candidate = (await d.ladder()).ladders['devin:d'].credentialRanking.candidates.find(c => c.armId === 'swe-2');
    assert.equal(candidate.Q, null);
    assert.equal(candidate.C, null);
    assert.equal(candidate.costBase, null);
    assert.equal((await d.hook()).kind, 'defer');
  }
});

test('explicit unscored trials remain subject to trial roles while passing benchmark admission', async () => {
  const { qualityVerdicts } = await import('../src/eligibility.mjs');
  const { decide } = await import('../src/decide.mjs');
  const trial = { armId: 'swe-2', model: 'devin/swe-2', family: 'swe', effort: 'max', Q: null, qFleet: null, C: 0, unscoredTrial: true, trial: true, maxRung: 1 };
  const scored = Array.from({ length: 8 }, (_, i) => ({ armId: `scored-${i}`, qFleet: 1, family: 'sol' }));
  const verdict = qualityVerdicts([...scored, trial], { doer: .5 }, { minFleetArms: 8 });
  assert.equal(verdict.doer['swe-2'].ok, true);
  assert.equal(verdict.doer['swe-2'].reason, 'unscored-trial-admission');
  const base = { runId: 'r', agentId: 'a', accountId: 'devin:d', ladderRungs: [{ rung: 0, arms: [trial] }],
    roleBands: { doer: { floorRung: 0 }, thinker: { floorRung: 0 } }, adapterType: 'claude-code',
    trialRoles: ['doer'], trialAdapters: { 'claude-code': ['*'] }, trialBudget: { swe: 1 } };
  assert.equal(decide({ ...base, role: 'doer' }).model, 'devin/swe-2');
  assert.equal(decide({ ...base, role: 'thinker' }).kind, 'defer');
  assert.equal(decide({ ...base, role: 'doer', trialBudget: { swe: 0 } }).kind, 'defer');
});

test('malformed and conflicting unscored served ids fail closed even without validation', () => {
  for (const servedId of ['devin/', '/swe-2', 'devin//swe-2', 'devin/swe 2']) {
    const raw = { trials: { unscoredServedIds: [{ servedId, reason: 'test' }] } };
    assert.ok(validateConfigShape(raw).some(e => e.includes('unscoredServedIds')), servedId);
    assert.deepEqual(resolveConfig(raw).trials.unscoredServedIds, []);
  }
  const duplicate = { trials: { unscoredServedIds: [{ servedId: 'devin/swe-2', reason: 'one' }, { servedId: 'devin/swe-2', reason: 'two' }] } };
  assert.deepEqual(resolveConfig(duplicate).trials.unscoredServedIds, []);
});

test('high-only task observations are held even without a legacy duplicate arm', async () => {
  const d = await driveDevin({ mode: 'enforce', twins: true, folding: true, highOnly: true });
  const ladder = (await d.ladder()).ladders['devin:d'];
  assert.equal(ladder.credentialRanking.duplicateArmIds.includes('gpt-6-1-sol'), false);
  assert.ok(ladder.credentialRanking.duplicateTaskArmIds.includes('gpt-6-1-sol@high'));
});

test('malformed trials parent is rejected without throwing', () => {
  for (const trials of ['x', 2, []]) assert.ok(validateConfigShape({ trials }).some(e => e.includes('trials must be an object')));
});

// A stale free-price benchmark must not keep an expensive arm at the cheapest rung.
test('no-tick expiration rebuilds the scored price frontier like a paid tick', async () => {
  const until = '2026-11-01T00:01:00Z';
  const free = await driveDevin({ priceRace: true, scoredFree: true, until });
  const paid = await driveDevin({ priceRace: true, free: false });
  const before = (await free.ladder()).ladders['devin:d'];
  assert.equal(before.credentialRanking.rankingRungs.length, 3, JSON.stringify(before.credentialRanking.candidates.map(c => [c.armId,c.Q,c.C])));
  assert.equal((await free.hook('before')).model, 'devin/kimi-k3');
  free.setNow(Date.parse(until) + 1);
  assert.equal((await paid.hook('paid')).model, 'devin/glm-5');
  assert.equal((await free.hook('after')).model, 'devin/glm-5');
  const paidThinker = await paid.hook('paid-thinker', 'thinker');
  const expiredThinker = await free.hook('expired-thinker', 'thinker');
  assert.equal(paidThinker.kind, 'decide');
  assert.equal(paidThinker.model, 'devin/gpt-6-1-sol');
  assert.equal(expiredThinker.kind, 'decide');
  assert.equal(expiredThinker.model, paidThinker.model);
  assert.match(expiredThinker.reason, /rung 1 /);
});

test('expired included prices are not exposed by capacity or ladder without a tick', async () => {
  const until = '2026-11-01T00:01:00Z';
  const d = await driveDevin({ mode: 'enforce', scoredFree: true, until });
  const find = async () => (await d.capacity()).taskRanking.candidates.find(c => c.model === 'devin/kimi-k3' && c.role === 'doer');
  assert.equal((await find()).cashUsdPerAcceptedTask, 0);
  d.setNow(Date.parse(until));
  assert.equal((await find()).cashUsdPerAcceptedTask, 0);
  d.setNow(Date.parse(until) + 1);
  const item = await find();
  assert.notEqual(item.costFree, true);
  assert.notEqual(item.cashUsdPerAcceptedTask, 0);
  assert.equal(Object.hasOwn(item, 'costFreeSource'), false);
  const l = (await d.ladder()).ladders['devin:d'];
  const legacy = l.credentialRanking.candidates.find(c => c.armId === 'kimi-k3');
  assert.equal(legacy.C, legacy.costBase * legacy.costMultiplier);
  assert.equal(Object.hasOwn(legacy, 'costFree'), false);
  assert.equal(Object.hasOwn(legacy, 'cashUsdPerAcceptedTask'), false);
  assert.equal(l.rankingRungs.find(r => r.armId === 'kimi-k3').C, legacy.C);
  assert.equal(l.rungs.find(r => r.armId === 'swe-2').C, null);
});

for (const mode of ['off', 'enforce']) {
  for (const [armId, expectedCost] of [['kimi-k3', 5], ['swe-2', null]]) {
    test(`capacity account arm ${armId} expires its included price without a tick (${mode})`, async () => {
      const until = '2026-11-01T00:01:00Z';
      const d = await driveDevin({ mode, scoredFree: true, until });
      const find = async () => (await d.capacity()).accounts.find(a => a.accountId === 'devin:d').arms.find(a => a.armId === armId);
      assert.equal((await find()).costEffective, 0);
      d.setNow(Date.parse(until));
      assert.equal((await find()).costEffective, 0, 'the offer includes its exact deadline');
      d.setNow(Date.parse(until) + 1);
      const expired = await find();
      assert.equal(expired.costEffective, expectedCost);
      assert.notEqual(expired.costFree, true);
      assert.equal(Object.hasOwn(expired, 'costFreeSource'), false);
      assert.equal(Object.hasOwn(expired, 'freeUntilMs'), false);
      // Projection must not mutate the cached pre-expiry snapshot.
      d.setNow(Date.parse(until));
      assert.equal((await find()).costEffective, 0);
    });
  }
}

// Mutating unscored arms to trial:true forever must fail this lifecycle test.
test('unscored admission graduates only after sufficient successful terminal outcomes', async () => {
  const d = await driveDevin({ onlySwe: true, trialSettings: { minRuns: 3, minSuccessRate: .75 } });
  const candidate = async () => (await d.ladder()).ladders['devin:d'].credentialRanking.candidates.find(c => c.armId === 'swe-2');
  const outcome = async (id, status) => {
    await d.fire(id, 'agent.run.started');
    await d.fire(id, 'agent.run.' + status);
    await d.tick(); await d.tick();
  };
  assert.equal((await candidate()).trial, true);
  await outcome('one', 'finished');
  assert.equal((await candidate()).trial, true, 'one success is below minRuns');
  await outcome('two', 'failed');
  await outcome('three', 'finished');
  assert.equal((await candidate()).trial, true, 'two of three fails success threshold');
  await outcome('four', 'finished');
  const c = await candidate();
  assert.equal(c.trial, false);
  assert.equal(c.Q, null);
  assert.equal(c.qFleet, null);
});

test('unscored trials remain subject to measured outcome exclusion', async () => {
  const { buildEligibility, DEFAULT_OUTCOME_GATE } = await import('../src/eligibility.mjs');
  const now = Date.parse('2026-11-01T00:00:00Z');
  const swe = { armId: 'swe-2', model: 'devin/swe-2', family: 'swe', Q: null, qFleet: null, C: 0, trial: true, unscoredTrial: true };
  const kimi = { armId: 'kimi-k3', model: 'devin/kimi-k3', family: 'kimi', Q: 1, qFleet: 1, C: 1, trial: false };
  const records = Array.from({ length: 40 }, (_, i) => ({ runId: `r${i}`, agentId: 'builder', status: 'finished', actualModel: i < 20 ? swe.model : kimi.model, progress: i < 20 ? 'noChange' : 'progressed', terminalAt: now - 1000 }));
  const result = buildEligibility({ arms: [swe, kimi], records, nowMs: now,
    minQuality: { doer: null, thinker: null, other: null }, outcomeGate: DEFAULT_OUTCOME_GATE,
    manual: {}, roleOf: () => 'doer', familyOf: r => r.actualModel.includes('swe') ? 'swe' : 'kimi',
    accountGroups: [[{ rung: 0, arms: [swe, kimi] }]], roleBands: { doer: { floorRung: 0 } }, trialRoles: ['doer'] });
  assert.ok(result.exclusions.doer.includes('swe'));
  assert.equal(result.report.arms.find(a => a.armId === 'swe-2').eligible.doer.ok, false);
});

test('a mixed free and paid account is not an account-wide free lane', async () => {
  const d = await driveDevin();
  const account = (await d.capacity()).accounts.find(a => a.accountId === 'devin:d');
  assert.ok(account);
  assert.notEqual(account.freeCost, true);
  assert.notEqual(account.freeCash, true);
});


test('cross-account removal preserves shared unscored rung zero', async () => {
  const d = await driveDevin({ dominance: true });
  const l = (await d.ladder()).ladders['devin:d'];
  assert.ok(l.crossAccountDominated?.includes('gpt-5-6-sol'));
  assert.deepEqual(l.rungs.map(r => [r.armId, r.rung]), [['swe-2', 0], ['kimi-k3', 1]]);
  assert.equal(new Set(l.rungs.map(r => r.rung)).size, 2);
});


test('event-time routing rebuilds scored price frontier after expiry without a tick', async () => {
  const until = '2026-11-01T00:01:00Z';
  const d = await driveDevin({ priceRace: true, scoredFree: true, until });
  d.setNow(Date.parse(until) + 1);
  await d.fire('event-after-expiry', 'agent.run.started');
  await d.tick(); // persist the event-time decision, which is first-wins
  const entry = (await d.shadow()).entries.find(e => e.runId === 'event-after-expiry');
  assert.ok(entry);
  assert.equal(entry.eventTime, true);
  assert.equal(entry.wouldModel, 'devin/glm-5(max)');
});

test('included unscored price remains valid at the exact deadline and expires one millisecond later', async () => {
  const until = '2026-11-01T00:01:00Z';
  const d = await driveDevin({ until, onlySwe: true });
  d.setNow(Date.parse(until));
  assert.equal((await d.hook('at-boundary')).model, 'devin/swe-2');
  d.setNow(Date.parse(until) + 1);
  assert.notEqual((await d.hook('after-boundary')).model, 'devin/swe-2');
});

test('legacy stored ladder without ranking withdraws expired unscored arms', async () => {
  const until = '2026-11-01T00:01:00Z';
  const d = await driveDevin({ until, onlySwe: true });
  const ladder = (await d.ladder()).ladders['devin:d'];
  delete ladder.credentialRanking;
  d.setNow(Date.parse(until) + 1);
  assert.notEqual((await d.hook()).model, 'devin/swe-2');
});

for (const mode of ['off', 'shadow', 'enforce']) {
  for (const readiness of [false, true]) {
    for (const [model, extraBans] of [['devin/gpt-6-sol', []], ['devin/gpt-5-6-terra', []], ['devin/kimi-k3', ['kimi-k3']]]) {
      test(`reviewer admission rejects ${model} (${mode}, readiness ${readiness})`, async () => {
        const d = await driveDevin({ mode, devinModels: [model, 'devin/swe-2'], configExtra: {
          bannedModels: extraBans, credentialReadiness: { enforce: readiness },
          reviewerRouting: { agentIds: ['reviewer'], arms: [{ provider: 'devin', model }] },
        } });
        const answer = await d.hook('banned-review', 'reviewer');
        assert.equal(answer.kind === 'decide' && arms.isBannedModel(answer.model, extraBans), false, JSON.stringify(answer));
      });
    }
  }
  test(`reviewer duplicates stay native-first and release on native outage (${mode})`, async () => {
    const configExtra = { burnMode: { accounts: ['devin:d'] }, reviewerRouting: { agentIds: ['reviewer'], arms: [
      { provider: 'devin', model: 'devin/gpt-6-1-sol' }, { provider: 'codex', model: 'gpt-6.1-sol' },
    ] } };
    const native = await driveDevin({ mode, twins: true, folding: true, configExtra });
    assert.equal((await native.hook('native-review', 'reviewer')).model, 'gpt-6.1-sol');
    const outage = await driveDevin({ mode, twins: true, folding: true, nativeUnavailable: true, configExtra });
    assert.equal((await outage.hook('fallback-review', 'reviewer')).model, 'devin/gpt-6-1-sol');
  });
}

test('paid reviewer shares the reactive cap with a pending free run', async () => {
  const d = await driveDevin({ cap: 1, trialSettings: { roles: ['doer'] }, configExtra: {
    roles: { doerAgentIds: ['builder'], excludeFamilies: { doer: ['kimi'] }, minQuality: { doer: null, thinker: null, other: null } },
    reviewerRouting: { agentIds: ['reviewer'], arms: [{ provider: 'devin', model: 'devin/kimi-k3' }] },
  } });
  assert.equal((await d.hook('free-builder')).model, 'devin/swe-2');
  const answer = await d.hook('paid-review', 'reviewer');
  assert.equal(answer.kind, 'defer', JSON.stringify(answer));
});

test('mixed-account canary receives bounded traffic then returns to scored selection on graduation', async () => {
  const d = await driveDevin({ cap: 1, onlyDevin: true, trialSettings: { minRuns: 3, minSuccessRate: 1 } });
  const selected = [];
  for (let i = 0; i < 6; i++) {
    const id = `mixed-${i}`;
    const answer = await d.hook(id);
    assert.equal(answer.kind, 'decide');
    selected.push(answer.model);
    assert.notEqual((await d.hook(`blocked-${i}`)).kind, 'decide', 'shared cap still bounds canary and paid runs');
    await d.fire(id, 'agent.run.started');
    await d.fire(id, 'agent.run.finished');
    await d.tick(); await d.tick();
  }
  assert.deepEqual(selected, ['devin/swe-2', 'devin/swe-2', 'devin/swe-2', 'devin/kimi-k3', 'devin/kimi-k3', 'devin/kimi-k3']);
  const swe = (await d.ladder()).ladders['devin:d'].credentialRanking.candidates.find(c => c.armId === 'swe-2');
  assert.equal(swe.trial, false);
  assert.equal(swe.Q, null);
  assert.equal(swe.qFleet, null);
});


test('no-tick expiration grows benchmark shells to the fresh paid thinker window', async () => {
  const until = '2026-11-01T00:01:00Z';
  const free = await driveDevin({ priceRace: 'growth', scoredFree: true, until });
  const paid = await driveDevin({ priceRace: 'growth', free: false });
  assert.equal((await free.ladder()).ladders['devin:d'].credentialRanking.rankingRungs.length, 1);
  assert.equal((await paid.ladder()).ladders['devin:d'].credentialRanking.rankingRungs.length, 2);
  free.setNow(Date.parse(until) + 1);
  const expired = await free.hook('expired-growth', 'thinker');
  assert.equal(expired.kind, 'decide');
  assert.equal(expired.model, 'devin/gpt-6-1-sol');
  assert.equal(expired.model, (await paid.hook('paid-growth', 'thinker')).model);
  assert.match(expired.reason, /rung 1 /);
});

test('reviewer shared cap excludes its own reservation before and after a tick', async () => {
  const d = await driveDevin({ cap: 1, onlyDevin: true, configExtra: {
    reviewerRouting: { agentIds: ['reviewer'], arms: [{ provider: 'devin', model: 'devin/kimi-k3' }] },
  } });
  assert.equal((await d.hook('review-self', 'reviewer')).model, 'devin/kimi-k3');
  assert.equal((await d.hook('review-self', 'reviewer')).kind, 'decide');
  assert.equal((await d.hook('other-review', 'reviewer')).kind, 'defer');
  assert.equal((await d.hook('other-free')).kind, 'defer');
  await d.fire('review-self', 'agent.run.started'); await d.tick();
  assert.equal((await d.hook('review-self', 'reviewer')).kind, 'decide');
  assert.equal((await d.hook('other-review', 'reviewer')).kind, 'defer');
  await d.fire('review-self', 'agent.run.finished'); await d.tick();
  assert.equal((await d.hook('released-review', 'reviewer')).kind, 'decide');
});

test('reviewer native-first fallback releases when the native arm breaker opens', async () => {
  const { createBreakerStore, recordArmFailure, breakerStoreToJSON, DEFAULT_BREAKERS } = await import('../src/breakers.mjs');
  const configExtra = {
    burnMode: { accounts: ['devin:d'] },
    reviewerRouting: { agentIds: ['reviewer'], arms: [
      { provider: 'devin', model: 'devin/gpt-6-1-sol', effort: 'max' },
      { provider: 'codex', model: 'gpt-6.1-sol', effort: 'max' },
    ] },
  };
  const d = await driveDevin({ twins: true, folding: true, configExtra });
  assert.equal((await d.hook('native-closed', 'reviewer')).model, 'gpt-6.1-sol');
  const now = Date.parse('2026-11-01T00:00:00Z'), breakers = createBreakerStore();
  for (const armId of ['gpt-6-1-sol', 'gpt-6-1-sol-high']) for (const atMs of [now - 120000, now - 60000]) recordArmFailure(breakers, 'codex:native', armId, { atMs, errorText: 'model not found' }, atMs, DEFAULT_BREAKERS);
  const held = await driveDevin({ twins: true, folding: true, configExtra, initialBreakers: breakerStoreToJSON(breakers, { nowMs: now, cfg: DEFAULT_BREAKERS }) });
  assert.equal((await held.hook('native-open', 'reviewer')).model, 'devin/gpt-6-1-sol');
});

for (const [name, overrides, want] of [
  ['eligible', {}, 'devin/swe-2'],
  ['family budget exhausted', { trialBudget: { swe: 0 } }, 'devin/kimi-k3'],
  ['role excluded', { trialRoles: ['other'] }, 'devin/kimi-k3'],
  ['adapter excluded', { trialAdapters: { 'claude-code': ['kimi'] } }, 'devin/kimi-k3'],
  ['family excluded', { excludedFamilies: ['swe'] }, 'devin/kimi-k3'],
  ['context excluded', { contextTokens: 100 }, 'devin/kimi-k3'],
  ['retry retains scored selection', { retryCount: 1 }, 'devin/kimi-k3'],
]) {
  test(`unscored canary exploration preserves admission gate: ${name}`, async () => {
    const { decide } = await import('../src/decide.mjs');
    const trial = { armId: 'swe-2', model: 'devin/swe-2', family: 'swe', Q: null, C: 0, trial: true, unscoredTrial: true, contextWindow: 100 };
    const scored = { armId: 'kimi-k3', model: 'devin/kimi-k3', family: 'kimi', Q: 0, C: 5, trial: false, contextWindow: 1000 };
    const answer = decide({ runId: 'canary', agentId: 'builder', role: 'doer', accountId: 'devin:d',
      ladderRungs: [{ rung: 0, arms: [scored, trial] }], trialBudget: { swe: 1 },
      trialRoles: ['doer'], trialAdapters: { 'claude-code': ['*'] }, adapterType: 'claude-code', ...overrides });
    assert.equal(answer.kind, 'decide');
    assert.equal(answer.model, want);
    assert.equal(trial.Q, null);
  });
}

for (const mode of ['off', 'shadow']) {
  test(`reviewer reactive cap cannot fall through to a kept default (${mode})`, async () => {
    const d = await driveDevin({ mode, cap: 1, onlyDevin: true, configExtra: {
      roles: { doerAgentIds: ['builder'], keepAgentIds: ['reviewer'], excludeFamilies: { doer: ['kimi'] }, minQuality: { doer: null, thinker: null, other: null } },
      reviewerRouting: { agentIds: ['reviewer'], arms: [{ provider: 'devin', model: 'devin/kimi-k3' }] },
    } });
    assert.equal((await d.hook('free-running')).model, 'devin/swe-2');
    assert.equal((await d.hook('kept-review', 'reviewer')).kind, 'defer');
  });

  test(`reviewer hard account cap survives simultaneous family-budget refusal (${mode})`, async () => {
    const d = await driveDevin({ mode, cap: 1, onlySwe: true,
      trialSettings: { roles: ['doer', 'other'], maxInFlightPerFamily: 1 },
      configExtra: {
        roles: { doerAgentIds: ['builder'], keepAgentIds: ['reviewer'], minQuality: { doer: null, thinker: null, other: null } },
        reviewerRouting: { agentIds: ['reviewer'], arms: [{ provider: 'devin', model: 'devin/swe-2' }] },
      },
    });
    assert.equal((await d.hook('family-running')).model, 'devin/swe-2');
    const pending = await d.hook('kept-family-review', 'reviewer');
    assert.equal(pending.kind, 'defer', JSON.stringify(pending));
    assert.match(pending.reason, /account in-flight cap/);
    await d.fire('family-running', 'agent.run.started');
    await d.tick();
    assert.equal((await d.hook('kept-family-review-after-tick', 'reviewer')).kind, 'defer');
    await d.fire('family-running', 'agent.run.finished');
    await d.tick();
    assert.equal((await d.hook('released-family-review', 'reviewer')).model, 'devin/swe-2');
    assert.equal((await d.hook('released-family-review', 'reviewer')).kind, 'decide');
  });
}

for (const readiness of [false, true]) {
  test(`unscored reviewer requires current included pricing with readiness ${readiness}`, async () => {
    const until = '2026-11-01T00:01:00Z';
    const configExtra = {
      credentialReadiness: { enforce: readiness },
      reviewerRouting: { agentIds: ['reviewer'], arms: [{ provider: 'devin', model: 'devin/swe-2' }] },
    };
    const opts = { onlySwe: true, trialSettings: { roles: ['other'] }, configExtra };
    const d = await driveDevin({ ...opts, until });
    assert.equal((await d.hook('free-review', 'reviewer')).model, 'devin/swe-2');
    d.setNow(Date.parse(until));
    assert.equal((await d.hook('boundary-review', 'reviewer')).model, 'devin/swe-2');
    d.setNow(Date.parse(until) + 1);
    assert.notEqual((await d.hook('expired-review', 'reviewer')).model, 'devin/swe-2');
    const unpriced = await driveDevin({ ...opts, free: false });
    assert.notEqual((await unpriced.hook('unpriced-review', 'reviewer')).model, 'devin/swe-2');
    await d.tick();
    assert.notEqual((await d.hook('expired-after-tick', 'reviewer')).model, 'devin/swe-2');
  });
}

for (const mode of ['off', 'shadow']) {
  for (const allowlisted of [false, true]) {
    test(`AA-scored reviewer ignores obsolete unscored admission (${mode}, allowlisted ${allowlisted})`, async () => {
      const d = await driveDevin({ mode, onlySwe: true, free: false,
        aaExtraRows: [{ slug: 'swe-2', intelligenceIndex: 55, intelligenceIndexCostPerTask: 5 }],
        trialSettings: { roles: [], adapters: {}, unscoredServedIds: allowlisted
          ? [{ servedId: 'devin/swe-2', reason: 'obsolete trial entry' }] : [] },
        configExtra: {
          reviewerRouting: { agentIds: ['reviewer'], arms: [{ provider: 'devin', model: 'devin/swe-2', effort: 'max' }] },
        },
      });
      assert.equal((await d.capacity()).reviewer.routing.preview.routed, true);
      const answer = await d.hook('scored-review', 'reviewer');
      assert.equal(answer.kind, 'decide');
      assert.equal(answer.model, 'devin/swe-2');
      assert.equal(answer.effort, 'max');
    });
  }
}

for (const allowlisted of [false, true]) {
  test(`scored SWE reviewer ignores obsolete unscored admission in enforce mode (allowlisted ${allowlisted})`, async () => {
    const d = await driveDevin({ mode: 'enforce', onlySwe: true, free: false,
      aaExtraRows: [{ slug: 'swe-2', intelligenceIndex: 55, intelligenceIndexCostPerTask: 5,
        terminalbenchV40: .8, scicode: .8, lcr: .8, ifbench: .8, omniscienceNonHallucination: .8 }],
      trialSettings: { roles: [], adapters: {}, unscoredServedIds: allowlisted
        ? [{ servedId: 'devin/swe-2', reason: 'obsolete trial entry' }] : [] },
      configExtra: {
        taskRanking: { mode: 'enforce', effortSupport: { 'devin/swe-2': ['max'] } },
        reviewerRouting: { agentIds: ['reviewer'], arms: [{ provider: 'devin', model: 'devin/swe-2', effort: 'max' }] },
      },
    });
    const policy = (await d.ladder()).ladders['devin:d'].policyReviewerArms[0];
    assert.equal(policy.aaSlug, 'swe-2');
    assert.equal(policy.benchmarkTrusted, true);
    assert.equal((await d.capacity()).reviewer.routing.preview.routed, true);
    const answer = await d.hook('scored-review', 'reviewer');
    assert.equal(answer.kind, 'decide');
    assert.equal(answer.model, 'devin/swe-2');
    assert.equal(answer.effort, 'max');
  });
}

test('enforce reviewer still rejects missing-AA SWE with a stale allowlist entry', async () => {
  const d = await driveDevin({ mode: 'enforce', onlySwe: true, trialSettings: { roles: ['other'] },
    configExtra: { reviewerRouting: { agentIds: ['reviewer'], arms: [{ provider: 'devin', model: 'devin/swe-2', effort: 'max' }] } },
  });
  assert.equal((await d.ladder()).ladders['devin:d'].policyReviewerArms[0].aaSlug, null);
  assert.equal((await d.capacity()).reviewer.routing.preview.routed, false);
  assert.notEqual((await d.hook('missing-aa-review', 'reviewer')).model, 'devin/swe-2');
});

test('reviewer model-list fallback cannot borrow another served id admission', async () => {
  const d = await driveDevin({ onlySwe: true, trialSettings: {
    roles: ['other'], unscoredServedIds: [{ servedId: 'nvidia-nim/swe-2', reason: 'not the Devin credential' }],
  }, configExtra: {
    reviewerRouting: { agentIds: ['reviewer'], arms: [{ provider: 'devin', model: 'devin/swe-2' }] },
  } });
  assert.notEqual((await d.hook('wrong-id-review', 'reviewer')).model, 'devin/swe-2');
});

for (const readiness of [false, true]) {
  test(`unpriced unscored reviewer cannot use account-model-list fallback with readiness ${readiness}`, async () => {
    const d = await driveDevin({ onlySwe: true, free: false, trialSettings: { roles: ['other'] }, configExtra: {
      credentialReadiness: { enforce: readiness },
      reviewerRouting: { agentIds: ['reviewer'], arms: [{ provider: 'devin', model: 'devin/swe-2' }] },
    } });
    assert.notEqual((await d.hook('unpriced-review', 'reviewer')).model, 'devin/swe-2');
  });
}

for (const [name, trialSettings] of [
  ['role excluded', { roles: [] }],
  ['different family role', { roles: ['other:kimi'] }],
  ['adapter excluded', { roles: ['other'], adapters: {} }],
  ['different adapter family', { roles: ['other'], adapters: { 'claude-code': ['kimi'] } }],
]) {
  test(`unscored reviewer retains normal trial gate: ${name}`, async () => {
    const d = await driveDevin({ onlySwe: true, trialSettings, configExtra: {
      reviewerRouting: { agentIds: ['reviewer'], arms: [{ provider: 'devin', model: 'devin/swe-2' }] },
    } });
    assert.notEqual((await d.hook('blocked-trial', 'reviewer')).model, 'devin/swe-2');
  });
}

test('unscored reviewer reservations share the family budget and exclude self across ticks', async () => {
  const d = await driveDevin({ onlySwe: true, trialSettings: {
    roles: ['doer:swe', 'other:swe'], maxInFlightPerFamily: 1,
  }, configExtra: {
    reviewerRouting: { agentIds: ['reviewer'], arms: [{ provider: 'devin', model: 'devin/swe-2' }] },
  } });
  assert.equal((await d.hook('family-self', 'reviewer')).model, 'devin/swe-2');
  assert.equal((await d.hook('family-self', 'reviewer')).model, 'devin/swe-2');
  assert.notEqual((await d.hook('family-other', 'reviewer')).model, 'devin/swe-2');
  assert.notEqual((await d.hook('family-builder', 'builder')).model, 'devin/swe-2');
  await d.fire('family-self', 'agent.run.started');
  await d.tick();
  const entry = (await d.shadow()).entries.find(e => e.runId === 'family-self');
  assert.equal(entry.trial, true);
  assert.equal(entry.family, 'swe');
  assert.equal((await d.hook('family-self', 'reviewer')).model, 'devin/swe-2');
  assert.notEqual((await d.hook('family-other-after-tick', 'reviewer')).model, 'devin/swe-2');
  await d.fire('family-self', 'agent.run.finished');
  await d.tick();
  assert.equal((await d.hook('family-released', 'reviewer')).model, 'devin/swe-2');
});

test('ordinary trial reservations consume the same reviewer family budget', async () => {
  const d = await driveDevin({ onlySwe: true, trialSettings: {
    roles: ['doer', 'other'], maxInFlightPerFamily: 1,
  }, configExtra: {
    reviewerRouting: { agentIds: ['reviewer'], arms: [{ provider: 'devin', model: 'devin/swe-2' }] },
  } });
  assert.equal((await d.hook('ordinary-trial')).model, 'devin/swe-2');
  assert.notEqual((await d.hook('review-after-ordinary', 'reviewer')).model, 'devin/swe-2');
});

for (const mode of ['off', 'enforce']) {
  test(`Devin folded duplicates preserve newest and account-fallback routing in ${mode} mode`, async () => {
    const d = await driveDevin({ mode, twins: true, folding: true, configExtra: {
      roles: { doerAgentIds: ['builder'], thinkerAgentIds: ['thinker'],
        minQuality: { doer: null, thinker: null, other: null },
        newestVersionOnly: { enabled: true }, accountFallback: { enabled: true } },
    } });
    const cap = await d.capacity();
    assert.equal(cap.newestVersion.enabled, true);
    assert.ok(Array.isArray(cap.eligibility.accountFallback.admitted));
    const ladder = (await d.ladder()).ladders['devin:d'];
    assert.ok(ladder.credentialRanking.duplicateArmIds.includes('gpt-6-1-sol'));
    if (mode === 'off') assert.ok(ladder.rungs.some(a => a.unscoredTrial && a.model === 'devin/swe-2'));
    else {
      assert.ok(ladder.taskRoles.doer.candidates.every(a => a.model !== 'devin/swe-2'));
      assert.ok(ladder.credentialRanking.duplicateTaskArmIds.length > 0);
    }
    assert.equal((await d.hook()).model, 'gpt-6.1-sol');
  });
}

test('newest-version filtering excludes an admitted missing-AA Devin predecessor', async () => {
  const d = await driveDevin({ onlyDevin: true, devinModels: ['devin/swe-2', 'devin/swe-3'],
    aaExtraRows: [{ slug: 'swe-3', intelligenceIndex: 60, intelligenceIndexCostPerTask: 2 }],
    configExtra: { roles: { doerAgentIds: ['builder'], minQuality: { doer: null, thinker: null, other: null },
      newestVersionOnly: { enabled: true }, accountFallback: { enabled: true } } },
  });
  const cap = await d.capacity();
  assert.ok(cap.newestVersion.accounts['devin:d'].supersededCanonicalModels.includes('swe-2'));
  const ladder = (await d.ladder()).ladders['devin:d'];
  assert.ok(ladder.credentialRanking.excludedArmIds.includes('swe-2'));
  assert.ok(ladder.credentialRanking.candidates.every(a => a.model !== 'devin/swe-2'));
  assert.ok(ladder.rungs.every(a => a.model !== 'devin/swe-2'));
  assert.notEqual((await d.hook()).model, 'devin/swe-2');
});
