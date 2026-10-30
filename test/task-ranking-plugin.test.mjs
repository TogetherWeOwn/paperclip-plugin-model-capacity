import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin, resolveConfig, validateConfigShape } from '../src/plugin.mjs';
import { withSyntheticReadiness, syntheticAvailability } from './synthetic-readiness.mjs';

const NOW = Date.parse('2026-10-25T07:00:00Z');
const SECRET = { type: 'secret_ref', secretId: 'test-key' };
// Public AA Intelligence workload costs, NOT measured fleet accepted-output costs.
const solCost = .31914442375664703, terraCost = 1.3987235612691513;
// Task-aligned observations below are synthetic independent capability fixtures.
const metrics = n => ({ terminalbenchV40: n, scicode: n, lcr: n, ifbench: n, omniscienceNonHallucination: n,
  hle: 1 - n, gpqa: 1 - n, critpt: 1 - n, gdpvalNormalized: 1 - n });
const rows = [
  { slug: 'gpt-6-1-sol-high', intelligenceIndex: 50.2377777519769, intelligenceIndexCostPerTask: solCost, ...metrics(.6), contextWindowTokens: 1000000 },
  { slug: 'gpt-6-1-terra', intelligenceIndex: 42.0829248239494, intelligenceIndexCostPerTask: terraCost, ...metrics(.9), contextWindowTokens: 1000000 },
];
const armMap = [
  { aaSlug: 'gpt-6-1-sol-high', model: 'gpt-6.1-sol', effort: 'high', family: 'sol', providers: ['codex'] },
  { aaSlug: 'gpt-6-1-terra', model: 'gpt-6.1-terra', effort: 'max', family: 'terra', providers: ['codex'] },
];

async function drive({ mode = 'enforce', served = ['gpt-6.1-sol', 'gpt-6.1-terra'], aaRows = rows,
  config = {}, agents = {}, fiveHourUsed = .1 } = {}) {
  let now = NOW;
  const store = new Map(), jobs = new Map(), events = new Map();
  const key = k => JSON.stringify(k);
  const raw = { enforce: true, cliproxy: { laneKeySecretRef: SECRET }, armMap,
    roles: { minQuality: { doer: null, thinker: null, other: null }, thinkerFloorRung: 0 },
    pacing: { guard: { enabled: false } }, reviewReserve: { enabled: false },
    calibration: { referenceArmId: 'gpt-6-1-sol-high', referenceBurnPerRunPct: .0005 },
    taskRanking: { mode }, ...config };
  const lane = { observedAt: new Date(now).toISOString(), servedModels: served, accounts: [
    { accountKey: 's', lane: 'one', provider: 'codex', models: ['gpt-6.1-sol'], health: 'healthy', quality: 'live',
      weekly: { used: .1, resetsAt: new Date(now + 7 * 86400000).toISOString() }, fiveHour: { used: fiveHourUsed, resetsAt: new Date(now + 3600000).toISOString() } },
    { accountKey: 't', lane: 'two', provider: 'codex', models: ['gpt-6.1-terra'], health: 'healthy', quality: 'live',
      weekly: { used: .1, resetsAt: new Date(now + 7 * 86400000).toISOString() }, fiveHour: { used: fiveHourUsed, resetsAt: new Date(now + 3600000).toISOString() } },
  ] };
  const io = { config: { get: async () => raw }, secrets: { resolve: async () => 'test-key' },
    state: { get: async k => store.get(key(k)) ?? null, set: async (k, v) => store.set(key(k), v) },
    http: { fetch: async () => ({ status: 200, json: async () => withSyntheticReadiness(lane, now) }) },
    agents: { get: async id => agents[id] ?? { adapterType: 'claude-code' } },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, f) => jobs.set(n, f) }, events: { on: (n, f) => events.set(n, f) }, logger: { info() {}, error() {} } };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  await plugin.setup(io);
  store.set(key({ scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' }),
    { fetchedAt: new Date(now).toISOString(), rows: aaRows, duplicateSlugs: [] });
  await plugin.onConfigChanged(raw, { companyId: 'acme' });
  await jobs.get('quota-refresh')({});
  return { store, io, lane, config: raw, plugin, tick: () => jobs.get('quota-refresh')({}), setNow: ms => { now = ms; },
    hook: (p = {}) => plugin.onResolveRunModel({ runId: 'hook', companyId: 'acme', agentId: 'builder',
      issueId: 'issue', adapterType: 'claude-code', agentDefaultModel: null, issueOverrideModel: null, ...p }),
    fire: (runId = 'event', agentId = 'builder') => events.get('agent.run.started')({ type: 'agent.run.started', companyId: 'acme', entityId: runId,
      occurredAt: new Date(now).toISOString(), payload: { run: { agentId, adapterType: 'claude-code' } } }),
    shadow: async () => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'shadow' })).body,
    capacity: async () => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body };
}

test('new config defaults shadow and cannot enable resolution or learned calibration', () => {
  const config = resolveConfig({});
  assert.equal(config.taskRanking.mode, 'shadow');
  assert.equal(config.enforce, false);
  assert.ok(validateConfigShape({ taskRanking: { calibration: { enabled: true } } }).length > 0);
  assert.ok(validateConfigShape({ taskRanking: { roleMetricWeights: { doer: { nope: 1 } } } }).length > 0);
});

test('native resolver and event path choose capable Sol high, not costly surplus quality', async () => {
  const d = await drive();
  const report = await d.capacity();
  assert.equal(report.taskRanking.mode, 'enforce');
  const hook = await d.hook();
  assert.equal(hook.kind, 'decide');
  assert.equal(hook.model, 'gpt-6.1-sol');
  assert.equal(hook.effort, 'high');
  await d.fire();
  // Event memory is persisted at next tick. Do not call any provider model.
  await d.tick();
  const shadow = await d.shadow();
  assert.match(shadow.entries.find(r => r.runId === 'event').wouldModel, /^gpt-6\.1-sol/);
  const cap = await d.capacity();
  const entries = cap.taskRanking.candidates.filter(c => c.role === 'doer');
  assert.ok(entries.some(c => c.aaSlug === 'gpt-6-1-sol-high' && c.aaCostPerTask === solCost));
  assert.ok(entries.every(c => c.estimatedApiEquivalentPerAcceptedTask === null));
  assert.ok(entries.every(c => c.cashUsdPerAcceptedTask === null));
  assert.equal(cap.taskRanking.calibration.reason, 'awaiting-native-attributed-outcomes');
  assert.ok(cap.taskRanking.routeComparisons.length > 0);
});

test('Terra is retained when Sol is not actually servable; report names the refusal', async () => {
  const d = await drive({ served: ['gpt-6.1-terra'] });
  assert.equal((await d.hook()).model, 'gpt-6.1-terra');
  const report = await d.capacity();
  const sol = report.taskRanking.candidates.find(c => c.aaSlug === 'gpt-6-1-sol-high' && c.role === 'doer');
  assert.ok(sol.exclusionReasons.includes('unservable-emitted-id'));
});

test('shadow and off keep legacy routes and quota inputs; shadow exposes proposed route differences', async () => {
  const off = await drive({ mode: 'off' }), shadow = await drive({ mode: 'shadow' });
  assert.equal((await off.hook()).model, (await shadow.hook()).model);
  const a = await off.capacity(), b = await shadow.capacity();
  assert.deepEqual(a.accounts.map(v => v.targetShare), b.accounts.map(v => v.targetShare));
  assert.ok(b.taskRanking.routeComparisons.some(r => r.changed));
});

test('AA aggregate-only evidence cannot create trusted coding capacity or a calibrated completion cost', async () => {
  const d = await drive({ aaRows: rows.map(({ terminalbenchV40, scicode, lcr, ifbench, omniscienceNonHallucination, ...r }) => r) });
  assert.equal((await d.hook()).kind, 'defer');
  const report = await d.capacity();
  assert.ok(report.taskRanking.candidates.filter(c => c.role === 'doer').every(c => c.benchmarkTrusted === false));
});

test('missing-AA approved reviewer is policy-trusted, credential-admitted and never silently substituted', async () => {
  const d = await drive({ config: { credentialReadiness: { enforce: true },
    reviewerRouting: { agentIds: ['reviewer'], arms: [
      { provider: 'meta', model: 'muse-wonder-full-contributor', effort: 'max' },
      { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    ] } } });
  d.lane.accounts.push({ ...d.lane.accounts[0], provider: 'meta', lane: 'review', accountKey: 'review',
    models: ['muse-wonder-full-contributor'] });
  d.lane.servedModels.push('muse-wonder-full-contributor');
  d.setNow(NOW + 61000);
  d.lane.observedAt = new Date(NOW + 61000).toISOString();
  await d.tick();
  const pick = await d.hook({ agentId: 'reviewer' });
  assert.equal(pick.kind, 'decide');
  assert.equal(pick.model, 'muse-wonder-full-contributor');
  const cap = await d.capacity();
  const incumbent = cap.taskRanking.candidates.find(c => c.model === 'muse-wonder-full-contributor' && c.role === 'reviewer');
  assert.equal(incumbent.evidenceTrust, 'policy-trusted-incumbent');
  assert.equal(incumbent.qFleet, null);
});

test('exhaustion cannot revive missing role evidence or use a cheaper but untrusted default', async () => {
  const d = await drive({ fiveHourUsed: .99, config: { exhaustion: { enabled: true, finalAnswerFromAttempt: 1 } },
    aaRows: rows.map(({ terminalbenchV40, scicode, lcr, ifbench, omniscienceNonHallucination, ...r }) => r) });
  const pick = await d.hook({ agentDefaultModel: 'gpt-6.1-sol' });
  assert.equal(pick.kind, 'defer');
});

test('free cash, AA resource cost and quota burn stay distinct; calibration cannot inflate burn', async () => {
  const d = await drive({ config: { placement: { freeCostProviders: ['codex'] } } });
  for (const a of d.lane.accounts) a.plan = 'free';
  d.setNow(NOW + 61000);
  d.lane.observedAt = new Date(NOW + 61000).toISOString();
  await d.tick();
  const cap = await d.capacity();
  const sol = cap.taskRanking.candidates.find(c => c.aaSlug === 'gpt-6-1-sol-high' && c.role === 'doer');
  assert.equal(sol.cashUsdPerAcceptedTask, 0);
  assert.equal(sol.taskCostProxy, solCost);
  assert.ok(sol.quotaBurnPerRunPct > 0);
});

test('a thinker-only frontier arm survives a doer dominance relation on the same account', async () => {
  const d = await drive({ aaRows: [
    { ...rows[0], ...metrics(.9) }, { ...rows[1], ...metrics(.6) },
  ], config: { roles: { thinkerAgentIds: ['planner'], thinkerFloorRung: 1,
    minQuality: { doer: null, thinker: null, other: null } },
    trials: { roles: ['doer', 'other', 'thinker:terra'] } } });
  d.lane.accounts = [{ ...d.lane.accounts[0], models: ['gpt-6.1-sol', 'gpt-6.1-terra'] }];
  d.setNow(NOW + 61000); d.lane.observedAt = new Date(NOW + 61000).toISOString();
  await d.tick();
  assert.equal((await d.hook()).model, 'gpt-6.1-sol');
  assert.equal((await d.hook({ agentId: 'planner', runId: 'planner-run' })).model, 'gpt-6.1-terra');
});

test('rollback mode waits for a native view rather than keeping an unvetted default, then restores legacy routing', async () => {
  const d = await drive();
  assert.equal((await d.hook()).model, 'gpt-6.1-sol');
  d.config.taskRanking.mode = 'off';
  await d.plugin.onConfigChanged(d.config, { companyId: 'acme' });
  assert.equal((await d.hook({ runId: 'during-switch' })).kind, 'defer');
  d.setNow(NOW + 61000); d.lane.observedAt = new Date(NOW + 61000).toISOString();
  await d.tick();
  assert.equal((await d.hook({ runId: 'after-switch' })).model, 'gpt-6.1-terra');
});

test('a configured reviewer with no approved feasible arm defers instead of taking ordinary cheap overflow', async () => {
  const d = await drive({ config: { exhaustion: { enabled: true, finalAnswerFromAttempt: 1 },
    reviewerRouting: { agentIds: ['reviewer'], arms: [
      { provider: 'meta', model: 'muse-wonder-full-contributor', effort: 'max' },
    ] } } });
  const pick = await d.hook({ agentId: 'reviewer', agentDefaultModel: 'gpt-6.1-sol' });
  assert.equal(pick.kind, 'defer');
  assert.match(pick.reason, /approved reviewer/);
  await d.fire('review-observation', 'reviewer');
  await d.tick();
  assert.equal((await d.shadow()).entries.some(r => r.runId === 'review-observation'), false);
});

for (const token of ['arm:gpt-6-1-sol-high', 'arm:GPT-6-1-Sol-High', 'ARM:GPT-6-1-Sol-High', 'arm:GPT-6.1-Sol']) {
  test(`existing per-arm manual exclusion ${token} retains its meaning after canonical effort identity changes`, async () => {
    const d = await drive({ config: { roles: { excludeFamilies: { doer: [token] },
      thinkerFloorRung: 0, minQuality: { doer: null, thinker: null, other: null } } } });
    assert.equal((await d.hook()).model, 'gpt-6.1-terra');
  });
}

for (const token of ['arm:gpt-6-1-sol-high', 'ARM:GPT-6-1-Sol-High']) {
  test(`missing-AA reviewer respects legacy exclusion ${token} in enforce mode`, async () => {
    const d = await drive({ aaRows: rows.filter(r => r.slug !== 'gpt-6-1-sol-high'),
      config: { roles: { excludeFamilies: { doer: [token] },
        minQuality: { doer: null, thinker: null, other: null } },
      reviewerRouting: { agentIds: ['reviewer'], arms: [
        { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
        { provider: 'codex', model: 'gpt-6.1-terra', effort: 'max' },
      ] } } });
    const pick = await d.hook({ agentId: 'reviewer' });
    assert.equal(pick.kind, 'decide');
    assert.equal(pick.model, 'gpt-6.1-terra');
    await d.fire('excluded-review', 'reviewer');
    await d.tick();
    const observation = (await d.shadow()).entries.find(r => r.runId === 'excluded-review');
    assert.equal(observation.wouldModel, 'gpt-6.1-terra(max)');
  });
}

for (const mode of ['off', 'shadow', 'enforce']) {
  test(`legacy reviewer AA alias remains excluded without exact task evidence in ${mode} mode`, async () => {
    // Legacy bindings may borrow a configured AA alias. Exact task discovery
    // intentionally cannot treat that old alias as evidence for this model.
    const alias = 'legacy-sol-high';
    const d = await drive({ mode, aaRows: [{ ...rows[0], slug: alias }, rows[1]],
      config: { armMap: [{ ...armMap[0], aaSlug: alias }, armMap[1]],
        roles: { excludeFamilies: { doer: ['ARM:Legacy-Sol-High'] },
          minQuality: { doer: null, thinker: null, other: null } },
        reviewerRouting: { agentIds: ['reviewer'], arms: [
          { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
          { provider: 'codex', model: 'gpt-6.1-terra', effort: 'max' },
        ] } } });
    const pick = await d.hook({ agentId: 'reviewer' });
    assert.equal(pick.kind, 'decide');
    assert.equal(pick.model, 'gpt-6.1-terra');
  });
}

test('missing-AA reviewer legacy aliases do not exclude sibling efforts or invent benchmark trust', async () => {
  const d = await drive({ aaRows: rows.filter(r => r.slug !== 'gpt-6-1-sol-high'),
    config: { armMap: [...armMap, { ...armMap[0], aaSlug: 'gpt-6-1-sol', effort: 'max' }],
      roles: { excludeFamilies: { doer: ['arm:gpt-6-1-sol-high'] },
        minQuality: { doer: null, thinker: null, other: null } },
      reviewerRouting: { agentIds: ['reviewer'], arms: [
        { provider: 'codex', model: 'gpt-6.1-sol', effort: 'max' },
      ] } } });
  const pick = await d.hook({ agentId: 'reviewer' });
  assert.equal(pick.kind, 'decide');
  assert.equal(pick.model, 'gpt-6.1-sol');
  assert.equal(pick.effort, 'max');
  const incumbent = (await d.capacity()).taskRanking.candidates.find(c => c.role === 'reviewer' && c.model === 'gpt-6.1-sol');
  assert.equal(incumbent.aaSlug, null);
  assert.equal(incumbent.benchmarkTrusted, false);
  assert.equal(incumbent.qFleet, null);
});

test('excluding the sole missing-AA reviewer incumbent defers rather than bypassing its legacy token', async () => {
  const d = await drive({ aaRows: rows.filter(r => r.slug !== 'gpt-6-1-sol-high'),
    config: { roles: { excludeFamilies: { doer: ['arm:gpt-6-1-sol-high'] },
      minQuality: { doer: null, thinker: null, other: null } },
      reviewerRouting: { agentIds: ['reviewer'], arms: [
        { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
      ] } } });
  assert.equal((await d.hook({ agentId: 'reviewer' })).kind, 'defer');
});

test('unsupported positive legacy weights and nonfinite values are rejected instead of silently ignored', () => {
  assert.ok(validateConfigShape({ weights: { spellingMistake: 1 } }).length > 0);
  assert.ok(validateConfigShape({ weights: { hle: Infinity } }).length > 0);
});

test('an adapter-ineligible cheaper dominator cannot hide a feasible native arm', async () => {
  const d = await drive({ aaRows: [rows[0], { slug: 'kimi-k3', ...metrics(.9), intelligenceIndexCostPerTask: .01 }],
    config: { armMap: [armMap[0], { aaSlug: 'kimi-k3', model: 'kimi-k3', effort: 'max', family: 'kimi', providers: ['codex'] }] } });
  d.lane.accounts = [{ ...d.lane.accounts[0], models: ['gpt-6.1-sol', 'kimi-k3'] }];
  d.lane.servedModels = ['gpt-6.1-sol', 'kimi-k3'];
  d.setNow(NOW + 61000); d.lane.observedAt = new Date(NOW + 61000).toISOString();
  await d.tick();
  const out = await d.hook({ adapterType: 'codex_local' });
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, 'gpt-6.1-sol');
  const cap = await d.capacity();
  const scenario = cap.taskRanking.routeComparisons.find(r => r.previewInputs.role === 'doer' && r.previewInputs.adapterType === null);
  assert.match(scenario.cheapestRejectedAlternative.reason, /trial.*adapter/);
  const selected = cap.taskRanking.candidates.find(c => c.role === 'doer' && c.aaSlug === 'gpt-6-1-sol-high');
  assert.equal(selected.exclusionReasons.includes('pareto-dominated'), false, 'static dominance is not a hard per-run ban');
});

test('exhaustion ranks the actual feasible arm, not an adapter-ineligible cheap preview', async () => {
  const d = await drive({ fiveHourUsed: .99,
    aaRows: [rows[0], { slug: 'kimi-k3', ...metrics(.3), intelligenceIndexCostPerTask: .01 },
      { slug: 'claude-haiku-5-5', ...metrics(.5), intelligenceIndexCostPerTask: .2 }],
    config: { exhaustion: { enabled: true, finalAnswerFromAttempt: 1 },
      burnMode: { accounts: ['codex:*', 'claude:*'] }, armMap: [armMap[0],
        { aaSlug: 'kimi-k3', model: 'kimi-k3', effort: 'max', family: 'kimi', providers: ['codex'] },
        { aaSlug: 'claude-haiku-5-5', model: 'claude-haiku-5-5', effort: 'max', family: 'haiku', providers: ['claude'] }] } });
  d.lane.accounts = [
    { ...d.lane.accounts[0], models: ['gpt-6.1-sol', 'kimi-k3'] },
    { ...d.lane.accounts[1], provider: 'claude', models: ['claude-haiku-5-5'] },
  ];
  d.lane.servedModels = ['gpt-6.1-sol', 'kimi-k3', 'claude-haiku-5-5'];
  d.setNow(NOW + 61000); d.lane.observedAt = new Date(NOW + 61000).toISOString();
  await d.tick();
  const out = await d.hook({ adapterType: 'codex_local' });
  assert.equal(out.kind, 'decide');
  assert.match(out.model, /^claude-haiku-5-5/);
  assert.match(out.reason, /deferral-exhausted/);
});


test('credential expiry can revive an equal-score/cost older version without changing role rungs', async () => {
  const oldModel = 'claude-haiku-5-4', newModel = 'claude-haiku-5-5';
  const d = await drive({ aaRows: [oldModel, newModel].map(slug => ({ slug, ...metrics(.8), intelligenceIndexCostPerTask: .2 })),
    config: { credentialReadiness: { enforce: true }, calibration: { referenceArmId: newModel, referenceBurnPerRunPct: .0005 }, armMap: [oldModel, newModel].map(model =>
      ({ aaSlug: model, model, effort: 'max', family: 'haiku', providers: ['codex'] })) } });
  const a = { ...d.lane.accounts[0], models: [oldModel, newModel] };
  a.credentialAvailability = syntheticAvailability(a, NOW + 61000);
  a.credentialAvailability.models.find(r => r.model === newModel).expiresAt = new Date(NOW + 80000).toISOString();
  d.lane.accounts = [a]; d.lane.servedModels = [oldModel, newModel];
  d.setNow(NOW + 61000); d.lane.observedAt = new Date(NOW + 61000).toISOString();
  await d.tick();
  assert.match((await d.hook({ runId: 'before-expiry' })).model, /^claude-haiku-5-5/);
  d.setNow(NOW + 90000);
  const out = await d.hook({ runId: 'after-expiry' });
  assert.equal(out.kind, 'decide');
  assert.match(out.model, /^claude-haiku-5-4/);
});

test('restart and stale evidence fail closed in task enforce mode without changing legacy keep semantics', async () => {
  const d = await drive();
  const restarted = createModelCapacityPlugin({ clock: () => NOW, requirePinnedLaneHost: false });
  const { io: restartContext } = d;
  await restarted.setup(restartContext);
  await restarted.onConfigChanged(d.config, { companyId: 'acme' });
  const params = { companyId: 'acme', runId: 'restart-run', agentId: 'builder', adapterType: 'claude-code', agentDefaultModel: 'unverified-default' };
  assert.equal((await restarted.onResolveRunModel(params)).kind, 'defer');
  assert.equal((await restarted.onResolveRunModel({ ...params, issueOverrideModel: 'explicit-pin' })).kind, 'keep');
  await d.tick();
  assert.equal((await restarted.onResolveRunModel(params)).model, 'gpt-6.1-sol');
  d.setNow(NOW + 121000);
  assert.equal((await d.hook({ agentDefaultModel: 'unverified-default' })).kind, 'defer');
});


test('task-enforced resolution remains memory-only after the native tick', async () => {
  const { io, hook } = await drive();
  for (const key of ['config', 'state', 'secrets', 'http', 'agents', 'issues']) {
    io[key] = new Proxy({}, { get: () => { throw new Error(`io-forbidden:${key}`); } });
  }
  assert.equal((await hook()).model, 'gpt-6.1-sol');
});

test('policy-trusted reviewers with sparse legacy AA evidence use their policy identity for readiness', async () => {
  const d = await drive({ aaRows: rows.map(({ terminalbenchV40, scicode, lcr, ifbench, omniscienceNonHallucination, ...r }) => r),
    config: { credentialReadiness: { enforce: true }, reviewerRouting: { agentIds: ['reviewer'], arms: [
      { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    ] } } });
  const out = await d.hook({ agentId: 'reviewer' });
  assert.equal(out.kind, 'decide');
  assert.equal(out.model, 'gpt-6.1-sol');
  assert.equal(out.effort, 'high');
});

test('task exhaustion never keeps an unverified default effort using a different admitted effort', async () => {
  const d = await drive({ fiveHourUsed: .99999, served: ['gpt-6.1-sol'],
    config: { exhaustion: { enabled: true, finalAnswerFromAttempt: 1 } } });
  for (const account of d.lane.accounts) account.weekly.used = 0;
  d.setNow(NOW + 61000); d.lane.observedAt = new Date(NOW + 61000).toISOString();
  await d.tick();
  const out = await d.hook({ agentDefaultModel: 'gpt-6.1-sol(max)' });
  assert.equal(out.kind, 'defer', 'the only Sol evidence is high, not the configured max default');
});

test('approved reviewer config cannot bypass contributor-only Muse or Sol identity fences', async () => {
  for (const model of ['muse-spark-1.3', 'gpt-6-sol']) {
    const d = await drive({ served: [model], aaRows: [], config: { reviewerRouting: {
      agentIds: ['reviewer'], arms: [{ provider: 'codex', model, effort: 'max' }],
    } } });
    d.lane.accounts = [{ ...d.lane.accounts[0], models: [model] }];
    d.setNow(NOW + 61000); d.lane.observedAt = new Date(NOW + 61000).toISOString();
    await d.tick();
    assert.equal((await d.hook({ agentId: 'reviewer' })).kind, 'defer', model);
  }
});
