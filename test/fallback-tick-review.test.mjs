import test from 'node:test';
import assert from 'node:assert/strict';
import { replayTick } from '../scripts/aa-replay.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveAccountInputs } from '../src/decide.mjs';
import { buildAccountSupersession } from '../src/newest-version.mjs';
import { createBreakerStore, recordArmFailure, DEFAULT_BREAKERS } from '../src/breakers.mjs';
const nowMs = Date.parse('2026-10-29T12:00:00Z');
const names = Array.from({ length: 8 }, (_, i) => `fixture-model-${i + 1}`);
const account = (key, models) => ({ lane: key, provider: 'fixture', accountKey: key, health: 'healthy', models,
  observedAt: new Date(nowMs).toISOString(), quality: 'live',
  weekly: { used: .2, resetsAt: '2026-11-05T12:00:00Z' },
  fiveHour: { used: .1, resetsAt: '2026-10-29T17:00:00Z' } });
const lane = withSyntheticReadiness({ observedAt: new Date(nowMs).toISOString(), accounts: [
  account('weak', [names[0]]), account('strong', names.slice(1)),
] }, nowMs);
const armMap = names.map((model, i) => ({ aaSlug: model, model, effort: 'high', family: i < 2 ? 'shared' : `family${i}`, providers: ['fixture'] }));
const snapshot = { fetchedAt: new Date(nowMs).toISOString(), duplicateSlugs: [], rows: names.map((slug, i) => ({
  slug, intelligenceIndex: 20 + i * 10, intelligenceIndexCostPerTask: i === 0 ? 5 : 1 + i,
})) };
const config = { armMap, roles: { minQuality: { doer: 0, thinker: 0, other: 0 }, outcomeGate: { enabled: false },
  accountFallback: { enabled: true, roles: ['doer'], minQuality: -3 } } };

// Carried, fresh measured burn makes concurrency assertions non-vacuous:
// without it computeConcurrencyTarget returns early with calibration='weak'.
const calibratedStates = () => ({ 'smoothing-v1': { E: Object.fromEntries(['weak', 'strong'].map(key =>
  [`fixture:${key}`, { value: .00001, atMs: nowMs }])) } });

test('F-T23: suppressed fallback never reaches role access or concurrency', async () => {
  const input = { lane, snapshot, states: calibratedStates(), nowMs, demand: { doer: 40, thinker: 0, other: 0 } };
  const result = await replayTick({ ...input, config });
  const control = await replayTick({ ...input, config: { ...config, roles: { ...config.roles,
    accountFallback: { ...config.roles.accountFallback, enabled: false } } } });
  const fallback = result.capacity.eligibility.accountFallback;
  assert.ok(fallback.suppressed.some(row => row.accountId === 'fixture:weak' && row.armId === names[0] && row.reason === 'cross-account-excluded'), JSON.stringify(fallback));
  assert.ok(!fallback.admitted.some(row => row.accountId === 'fixture:weak'));
  const weak = result.capacity.perAccount.find(a => a.accountId === 'fixture:weak');
  assert.ok(weak.slots > 0, 'the barred account has calibrated quota capacity to inflate');
  assert.deepEqual(weak.eligibleRoles, []);
  assert.equal(weak.usableSlots, 0, 'only finalized admissions may add usable concurrency');
  assert.ok(result.capacity.roles.doer.slots > 0, 'strong account supplies real role capacity');
  for (const field of ['perAccount', 'roles', 'targetRaw', 'target', 'demandBound']) {
    assert.deepEqual(result.capacity[field], control.capacity[field], `suppression must leave ${field} at its off-state value`);
  }
});

// Run a private copy of the real tick with the same pure calculation exposed
// at its former location. This compares actual inputs at both program points;
// the deliberate rung mutation proves the tripwire can observe intervening writes.
test('F-T23b: hoisted dominance keys equal late keys, and intervening mutations are detectable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fallback-hoist-test-'));
  const callback = '__fallbackHoistTripwire';
  try {
    await cp(new URL('../src', import.meta.url), join(dir, 'src'), { recursive: true });
    await cp(new URL('../scripts', import.meta.url), join(dir, 'scripts'), { recursive: true });
    const path = join(dir, 'src', 'plugin.mjs');
    let code = await readFile(path, 'utf8');
    const start = 'const crossAccountInputs = (() => {';
    const end = 'return { orderingViews, nativeModels, dominated, dominatedKeys };\n    })();';
    const late = 'const { orderingViews, nativeModels, dominated, dominatedKeys } = crossAccountInputs;';
    for (const marker of [start, end, late]) assert.equal(code.split(marker).length, 2, `unique instrumentation marker: ${marker}`);
    code = code.replace(start, 'const crossAccountInputsForTripwire = () => {')
      .replace(end, 'return { orderingViews, nativeModels, dominated, dominatedKeys };\n    };\n    const crossAccountInputs = crossAccountInputsForTripwire();')
      .replace(late, `if (globalThis.${callback}.mutate) for (const ladder of Object.values(ladders)) ladder.rungs = [];\n      globalThis.${callback}(crossAccountInputs.dominatedKeys, crossAccountInputsForTripwire().dominatedKeys);\n      ${late}`);
    await writeFile(path, code);
    const { replayTick: replayInstrumented } = await import(pathToFileURL(join(dir, 'scripts', 'aa-replay.mjs')));
    for (const enabled of [false, true]) {
      let observed;
      globalThis[callback] = (early, lateKeys) => { observed = [Array.from(early).sort(), Array.from(lateKeys).sort()]; };
      await replayInstrumented({ lane, snapshot, config: { ...config, roles: { ...config.roles,
        accountFallback: { ...config.roles.accountFallback, enabled } } }, states: {}, nowMs, demand: { doer: 4 } });
      assert.ok(observed, 'the late cross-account block ran');
      assert.ok(observed[0].includes(`fixture:weak\0${names[0]}`), 'fixture exercises real domination');
      assert.deepEqual(observed[1], observed[0], `hoist preserves keys with fallback ${enabled}`);
      observed = null;
      globalThis[callback].mutate = true;
      await replayInstrumented({ lane, snapshot, config: { ...config, roles: { ...config.roles,
        accountFallback: { ...config.roles.accountFallback, enabled } } }, states: {}, nowMs, demand: { doer: 4 } });
      assert.ok(observed, 'the mutated late block ran');
      assert.notDeepEqual(observed[1], observed[0], `tripwire detects an intervening rung mutation with fallback ${enabled}`);
    }
  } finally {
    delete globalThis[callback];
    await rm(dir, { recursive: true, force: true });
  }
});

test('X-T02(e): a scoped kept-old arm is finalized, seated, and selected through the tick', async () => {
  const old = 'claude-sonnet-5', newer = 'claude-sonnet-5-5';
  const models = [old, newer, ...names.slice(2)];
  const customLane = withSyntheticReadiness({ observedAt: new Date(nowMs).toISOString(), accounts: [
    account('weak', [old, newer]), account('strong', models.slice(2)),
  ] }, nowMs);
  const customMap = models.map((model, i) => ({ aaSlug: model, model, effort: 'high',
    family: i < 2 ? 'sonnet' : `family${i}`, providers: ['fixture'] }));
  const customSnapshot = { fetchedAt: new Date(nowMs).toISOString(), duplicateSlugs: [], rows: models.map((slug, i) => ({
    slug, intelligenceIndex: i === 0 ? 30 : i === 1 ? 20 : 50 + 5 * i, intelligenceIndexCostPerTask: i === 0 ? 2 : i === 1 ? 1 : 12 - i,
  })) };
  const customConfig = { ...config, placement: { qualityWeight: 0 }, armMap: customMap,
    calibration: { referenceArmId: old, referenceBurnPerRunPct: .001 }, roles: { ...config.roles, doerCeilingRung: 0,
    newestVersionOnly: { enabled: true, overrides: { keep: [`arm:${old}`] } } } };
  customLane.accounts[0].weekly.used = .05;
  customLane.accounts[0].weekly.resetsAt = '2026-10-30T12:00:00Z';
  customLane.accounts[1].weekly.used = .95;
  const result = await runTick({ lane: customLane, snapshot: customSnapshot, config: customConfig,
    states: { 'ledger-v1': [running('kept-old')] }, demand: { doer: 4 } });
  const fallback = result.capacity.eligibility.accountFallback;
  assert.ok(fallback.admitted.some(row => row.accountId === 'fixture:weak' && row.armId === old), JSON.stringify(fallback));
  assert.ok(!fallback.suppressed.some(row => row.accountId === 'fixture:weak' && row.reason === 'superseded-version'));
  const view = result.capacity.newestVersion.accounts['fixture:weak'];
  assert.ok(!view.supersededLegacyArmIds.includes(old));
  const ladder = result.ladders.ladders['fixture:weak'];
  assert.ok(ladder.supersededArmEvidence.some(row => row.armId === old && row.kept));
  assert.equal(ladder.rankingRungs.find(row => row.armId === old).rung, 1,
    'kept-old starts outside the doer window, so selecting it requires seating');
  const decision = result.ledger.find(row => row.runId === 'kept-old');
  assert.equal(decision.decidedAccount, 'fixture:weak', JSON.stringify({ decision, account: result.capacity.accounts.find(a => a.accountId === 'fixture:weak') }));
  assert.equal(decision.armId, old);
  assert.equal(decision.rung, 0, 'tick seats the kept-old admission inside the doer window');
  assert.match(decision.wouldModel, /^claude-sonnet-5\(/);
});

// Real plugin, in-memory external I/O only. Unlike replayTick, this helper also
// returns the ledger so tick selection can be checked without changing F7's
// offline replay API. It never calls the live hook (F5/F6 are later slices).
async function runTick({ lane, snapshot, config, states = {}, demand = { doer: 4 },
  adapterType = 'claude-code', createPlugin = createModelCapacityPlugin }) {
  const store = new Map(Object.entries(structuredClone(states)));
  const jobs = new Map();
  const raw = structuredClone(config);
  const doer = raw.roles?.doerAgentIds?.[0] ?? 'worker';
  raw.roles = { ...raw.roles, doerAgentIds: [doer] };
  raw.cliproxy = { laneKeySecretRef: { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' } };
  const issues = Object.entries({ doer, thinker: 'planner', other: 'misc' }).flatMap(([role, agentId]) =>
    Array.from({ length: demand[role] ?? 0 }, (_, i) => ({ id: `${role}-${i}`, status: 'todo', assigneeAgentId: agentId })));
  const ctx = {
    config: { get: async () => raw },
    state: { get: async k => structuredClone(store.get(k.stateKey) ?? null),
      set: async (k, v) => store.set(k.stateKey, structuredClone(v)) },
    secrets: { resolve: async () => 'offline-placeholder' },
    http: { fetch: async () => ({ status: 200, json: async () => structuredClone(lane) }) },
    agents: { get: async () => ({ adapterType }) },
    issues: { list: async ({ status }) => status === 'todo' ? structuredClone(issues) : [], get: async () => null },
    jobs: { register: (name, fn) => jobs.set(name, fn) }, events: { on() {} },
    logger: { info() {}, warn() {}, error() {} },
  };
  const liveViews = new Map();
  const plugin = createPlugin({ clock: () => nowMs, requirePinnedLaneHost: false, liveViews });
  await plugin.setup(ctx);
  store.set('aa-snapshot-v1', structuredClone(snapshot));
  await plugin.onConfigChanged(raw, { companyId: 'offline-test' });
  await jobs.get('shadow-tick')({});
  const capacity = store.get('capacity-v1');
  assert.equal(capacity?.atMs, nowMs, 'real tick published capacity');
  return { capacity, ladders: store.get('ladder-v1'), ledger: store.get('ledger-v1'), live: liveViews.get('offline-test') };
}

const running = (runId, agentId = 'worker') => ({ runId, agentId, status: 'running',
  startedAt: nowMs - 1000, unverified: false });

// Two weak arms: a-best is better but dearer, on rung 1. The doer/other
// window is [0,0]. Fallback must seat a-best on rung 0 without moving the
// strong-for-doer z-cheap choice when only 'other' needs admission (R-1).
function windowFixture() {
  const models = ['z-cheap', 'a-best', ...names.slice(2)];
  const lane = withSyntheticReadiness({ observedAt: new Date(nowMs).toISOString(), accounts: [
    account('weak', models.slice(0, 2)), account('strong', models.slice(2)),
  ] }, nowMs);
  lane.accounts[0].weekly.used = .05;
  lane.accounts[0].weekly.resetsAt = '2026-10-30T12:00:00Z';
  lane.accounts[1].weekly.used = .95;
  return { lane,
    snapshot: { fetchedAt: new Date(nowMs).toISOString(), duplicateSlugs: [], rows: models.map((slug, i) => ({
      slug, intelligenceIndex: 20 + i * 10, intelligenceIndexCostPerTask: i < 2 ? i + 1 : 12 - i,
    })) },
    config: { placement: { qualityWeight: 0 }, taskRanking: { mode: 'shadow' },
      calibration: { referenceArmId: 'a-best', referenceBurnPerRunPct: .001 },
      armMap: models.map((model, i) => ({ aaSlug: model, model, effort: 'high', family: `family${i}`, providers: ['fixture'] })),
      roles: { doerAgentIds: ['worker'], thinkerAgentIds: ['planner'], doerFloorRung: 0, doerCeilingRung: 0,
        minQuality: { doer: 0, thinker: 0, other: 0 }, outcomeGate: { enabled: false },
        accountFallback: { enabled: true, roles: ['doer', 'other'], minQuality: -3 } } },
    states: { ...calibratedStates(), 'trial-families-v1': { counters: {},
      graduated: models.map((_, i) => `family${i}`), seenTerminal: [] } },
  };
}

test('F-T26: preview threads both exclusion subtraction and out-of-window seating', async () => {
  const input = windowFixture();
  const on = await runTick(input);
  input.config.roles.accountFallback.enabled = false;
  const off = await runTick(input);
  const preview = result => result.capacity.taskRanking.routeComparisons.find(c =>
    c.previewInputs.role === 'doer' && c.previewInputs.adapterType === null).legacy;
  assert.ok(on.capacity.eligibility.accountFallback.admitted.some(row => row.role === 'doer'
    && row.accountId === 'fixture:weak' && row.armId === 'a-best'), JSON.stringify(on.capacity.eligibility));
  const weak = on.ladders.ladders['fixture:weak'];
  assert.equal(weak.rankingRungs.find(r => r.armId === 'a-best').rung, 1);
  assert.ok(on.capacity.roleExclusionsEffective.doer.includes('arm:a-best'), 'fleet token stays in place');
  assert.ok(preview(off), 'strong control remains selectable with fallback off');
  assert.equal(preview(off).accountId, 'fixture:strong');
  assert.equal(preview(on).accountId, 'fixture:weak');
  assert.equal(preview(on).armId, 'a-best', 'the preview itself must seat and unbar the admitted arm');
});

test('F-T8: fallback preserves trial role, adapter, and in-flight budget gates', async t => {
  for (const scenario of ['allowed', 'role-blocked', 'adapter-blocked', 'budget-exhausted']) {
    await t.test(scenario, async () => {
      const input = windowFixture();
      input.states['trial-families-v1'].graduated = names.slice(2).map((_, i) => `family${i + 2}`);
      input.states['ledger-v1'] = [running('trial-candidate')];
      input.config.trials = { roles: scenario === 'role-blocked' ? ['other'] : ['doer', 'other'],
        adapters: { 'claude-code': scenario === 'adapter-blocked' ? [] : ['*'] }, maxInFlightPerFamily: 1 };
      // A still-running trial on a now-absent account consumes the FLEET
      // family budget without independently filling the weak account's lane.
      if (scenario === 'budget-exhausted') input.states['ledger-v1'].push({ ...running('occupied', 'misc'),
        trial: true, family: 'family1', decidedAccount: 'fixture:elsewhere', armId: 'a-best', wouldModel: 'a-best(high)' });
      const result = await runTick(input);
      assert.ok(result.capacity.eligibility.accountFallback.admitted.some(row => row.role === 'doer'
        && row.accountId === 'fixture:weak' && row.armId === 'a-best'), 'quality admission is present in every case');
      const candidate = result.ladders.ladders['fixture:weak'].credentialRanking.candidates.find(a => a.armId === 'a-best');
      assert.equal(candidate.trial, true);
      const decision = result.ledger.find(row => row.runId === 'trial-candidate');
      assert.equal(decision.decidedAccount, scenario === 'allowed' ? 'fixture:weak' : 'fixture:strong');
      if (scenario === 'allowed') { assert.equal(decision.armId, 'a-best'); assert.equal(decision.trial, true); }
      if (scenario === 'budget-exhausted') assert.equal(result.capacity.trialFamilies.family1.budget, 0);
    });
  }
});

test('F-T19: R-1 other-role admission leaves the strong doer pick, groups, and placementQ unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fallback-role-probe-'));
  const callback = '__fallbackPlacementProbe';
  try {
    await cp(new URL('../src', import.meta.url), join(dir, 'src'), { recursive: true });
    const path = join(dir, 'src', 'plugin.mjs');
    const code = await readFile(path, 'utf8');
    const marker = `return placementArm(groups, {
        role, roleBands, excludedFamilies: inputs.excludedFamilies,
        trialRoles: config.trials.roles, pointer,
      })?.quality ?? null;`;
    assert.equal(code.split(marker).length, 2, 'unique real tick placement probe site');
    await writeFile(path, code.replace(marker, `return globalThis.${callback}({ accountId, role, groups, placementQ: placementArm(groups, {
        role, roleBands, excludedFamilies: inputs.excludedFamilies,
        trialRoles: config.trials.roles, pointer,
      })?.quality ?? null });`));
    const { createModelCapacityPlugin: createPlugin } = await import(pathToFileURL(path));
    const input = windowFixture();
    input.config.roles.minQuality.doer = -2;
    input.states['ledger-v1'] = [running('r1-doer')];
    const observations = [];
    globalThis[callback] = row => { observations.push(structuredClone(row)); return row.placementQ; };
    const on = await runTick({ ...input, createPlugin });
    const observedOn = observations.splice(0);
    input.config.roles.accountFallback.enabled = false;
    const off = await runTick({ ...input, createPlugin });
    const observedOff = observations.splice(0);
    const report = on.capacity.eligibility.accountFallback;
    assert.ok(report.admitted.some(row => row.role === 'other' && row.accountId === 'fixture:weak' && row.armId === 'a-best'));
    assert.ok(!report.admitted.some(row => row.role === 'doer' && row.accountId === 'fixture:weak'), 'this account already passes the doer floor');
    const pick = result => {
      const row = result.ledger.find(r => r.runId === 'r1-doer');
      return { accountId: row.decidedAccount, armId: row.armId, rung: row.rung, model: row.wouldModel };
    };
    assert.deepEqual(pick(off), { accountId: 'fixture:weak', armId: 'z-cheap', rung: 0, model: 'z-cheap(high)' });
    assert.deepEqual(pick(on), pick(off));
    const doerRows = rows => rows.filter(row => row.accountId === 'fixture:weak' && row.role === 'doer');
    const baseline = doerRows(observedOff)[0];
    assert.ok(baseline, 'observed the real doer placement calculation with fallback off');
    assert.deepEqual(baseline.groups.map(g => g.arms.map(a => a.armId)), [['z-cheap'], ['a-best']]);
    assert.ok(Math.abs(baseline.placementQ - -1.5275252316519468) < 1e-12, 'placement uses z-cheap fleet Q');
    assert.ok(doerRows(observedOn).length > 0, 'observed the real doer placement calculation with fallback on');
    for (const row of doerRows(observedOn)) {
      assert.deepEqual(row.groups, baseline.groups, 'other-role seating never mutates doer materialization');
      assert.equal(row.placementQ, baseline.placementQ);
    }
    assert.ok(observedOn.some(row => row.accountId === 'fixture:weak' && row.role === 'other'
      && row.groups[0].arms.some(a => a.armId === 'a-best')), 'other role really seats the same account\'s a-best');
  } finally {
    delete globalThis[callback];
    await rm(dir, { recursive: true, force: true });
  }
});

test('F-T9: fallback capacity obeys trial/provider clips and the fleet concurrency cap', async () => {
  const input = windowFixture();
  input.config.concurrency = { maxTotal: 3 };
  input.config.trials = { maxInFlightPerAccount: 1, maxInFlightPerAccountByProvider: { fixture: 2 } };
  input.states['trial-families-v1'].graduated = [];
  const on = await runTick(input);
  input.config.roles.accountFallback.enabled = false;
  const off = await runTick(input);
  const weak = on.capacity.perAccount.find(row => row.accountId === 'fixture:weak');
  assert.ok(on.capacity.eligibility.accountFallback.admitted.some(row => row.role === 'doer' && row.accountId === weak.accountId));
  assert.ok(weak.slots > 2, 'uncapped quota capacity exceeds the provider trial limit');
  assert.equal(weak.trialOnly, true);
  assert.deepEqual(weak.eligibleRoles, ['doer', 'other']);
  assert.equal(weak.usableSlots, 2, 'provider override clips rather than the global cap of one');
  assert.equal(on.capacity.roles.doer.slots - off.capacity.roles.doer.slots, 2);
  assert.equal(on.capacity.targetRaw, 3, 'fleet cap also applies after admitting a weak account');
  assert.ok(on.capacity.target <= 3);
});

test('F5 publishes only finalized JSON admissions and leaves disabled live views unchanged', async () => {
  const input = windowFixture();
  const on = await runTick(input);
  const rows = on.capacity.eligibility.accountFallback.admitted;
  assert.ok(rows.some(r => r.accountId === 'fixture:weak' && r.role === 'doer'));
  for (const row of rows) assert.equal(on.live.accountAdmissions?.[row.role]?.[row.accountId]?.armId, row.armId);
  assert.deepEqual(JSON.parse(JSON.stringify(on.live.accountAdmissions)), on.live.accountAdmissions);
  const base = on.live.accounts.find(a => a.accountId === 'fixture:weak');
  assert.ok(!base.ladderRungs[0].arms.some(a => a.armId === 'a-best'), 'published groups remain BASE');
  input.config.roles.accountFallback.enabled = false;
  const off = await runTick(input);
  assert.equal(Object.hasOwn(off.live, 'accountAdmissions'), false);
});

// Expose existing private live consumers in a disposable copy; production
// modules are not modified or supplied test-only hooks.
async function withLiveInternals(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fallback-live-test-'));
  try {
    await cp(new URL('../src', import.meta.url), join(dir, 'src'), { recursive: true });
    const path = join(dir, 'src', 'plugin.mjs');
    let code = await readFile(path, 'utf8');
    const marker = '  return {\n    multiCompanyConfig: true,';
    assert.equal(code.split(marker).length, 2);
    code = code.replace(marker, `  return {\n    internals: { allocationOrderFromLive, reviewerArmAdmission, reviewerArmCheck, pickReviewerRoute, breakerStores, credentialEnforceCompanies,\n      recognized: typeof liveIsRecognizedReviewAgent === 'function' ? liveIsRecognizedReviewAgent : null,\n      liveAccountInputs: typeof liveAccountInputs === 'function' ? liveAccountInputs : null },\n    multiCompanyConfig: true,`);
    await writeFile(path, code);
    const module = await import(pathToFileURL(path));
    const liveViews = new Map();
    const plugin = module.createModelCapacityPlugin({ clock: () => nowMs, liveViews });
    await fn(plugin.internals, liveViews);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function syntheticLive() {
  const old = { armId: 'sample-0@high', model: 'sample-0', effort: 'high', family: 'sample', Q: 0, C: 3, coverage: 1 };
  const kept = { armId: 'sample-1@max', model: 'sample-1', effort: 'max', family: 'sample', Q: 0, C: 4, coverage: 1 };
  const fresh = { armId: 'sample-2', model: 'sample-2', family: 'sample', Q: 1, C: 1, coverage: 1 };
  const view = buildAccountSupersession({ models: ['sample-0', 'sample-1', 'sample-2'] }, [],
    { overrides: { keep: ['arm:sample-1@max', 'model:sample-1'] } });
  const ranking = { candidates: [old, kept, fresh], rankingRungs: [{ armId: fresh.armId, rung: 0, Q: 1, C: 1 }], previousRungs: [], excludedArmIds: [] };
  const account = { accountId: 'fixture:one', provider: 'fixture', pool: 'fixture', health: 'healthy', meter: 'metered',
    headroomPct: .9, remainingKnown: true, remainingPct: .9, targetShare: 1, models: ['sample-0', 'sample-1', 'sample-2'],
    credentialRanking: ranking, newestVersion: view, taskRankingMode: 'shadow', pointer: 0 };
  const live = { accounts: [account], newestVersion: { enabled: true }, roleBands: { doer: { floorRung: 0, ceilingRung: 0 } },
    excludeFamilies: { doer: ['arm:sample-0@high', 'arm:sample-1@max'] }, taskRanking: { mode: 'shadow' },
    reviewReserve: { agentIds: ['reserve'] }, reviewerRouting: { agentIds: ['routed'] }, decidedRunIds: new Set() };
  return { live, account, old, kept, fresh, view };
}

function liveResolver(live, armId) {
  const admissions = { doer: { 'fixture:one': { armId } } };
  return a => resolveAccountInputs(live.excludeFamilies.doer, admissions, live.roleBands, 'doer', a.accountId,
    { newestEnabled: live.newestVersion.enabled, supersessionView: a.newestVersion ?? null });
}

test('X-T01 F5: allocation materializes per-account descriptors and respects real view keeps', async () => {
  await withLiveInternals(async ({ allocationOrderFromLive }, views) => {
    const { live, account, old, kept, view } = syntheticLive();
    views.set('co', live);
    const groups = resolver => allocationOrderFromLive(live, 'co', null, 'doer', resolver).order[0]?.ladderRungs.flatMap(g => g.arms).map(a => a.armId) ?? [];
    assert.ok(view.verdicts.some(v => v.canonicalModel === kept.model && v.kept));
    assert.ok(!view.supersededLegacyArmIds.includes(kept.armId));
    assert.ok(!groups(liveResolver(live, old.armId)).includes(old.armId), 'superseded old never seats');
    assert.ok(groups(liveResolver(live, kept.armId)).includes(kept.armId), 'kept old seats');
    account.newestVersion = null;
    assert.ok(!groups(liveResolver(live, kept.armId)).includes(kept.armId), 'viewless enabled fails closed');
    assert.ok(!groups(live.excludeFamilies.doer).includes(kept.armId), 'array caller remains BASE');
  });
});

test('F5 reviewer recognition separates reserve and routing identities', async () => {
  await withLiveInternals(async ({ recognized }) => {
    assert.equal(typeof recognized, 'function');
    const { live } = syntheticLive();
    assert.equal(recognized(live, 'reserve'), true);
    assert.equal(recognized(live, 'routed'), true);
    assert.equal(recognized(live, 'worker'), false);
    assert.equal(recognized({ keepAgentIds: ['pinned'] }, 'pinned'), false);
  });
});

test('F-T11 reviewer admission keeps global exclusion for fallback arms', async () => {
  await withLiveInternals(async ({ reviewerArmAdmission, pickReviewerRoute }, views) => {
    const { live, account, kept } = syntheticLive();
    live.doerAgentIds = ['reviewer'];
    live.reviewerRouting.arms = [{ provider: 'fixture', model: kept.model, effort: kept.effort }];
    live.accountAdmissions = { doer: { [account.accountId]: { armId: kept.armId } } };
    views.set('co', live);
    const admit = reviewerArmAdmission(live, 'co', 'reviewer', nowMs);
    assert.equal(admit(account, kept).ok, 'arm excluded for the role');
    assert.equal(pickReviewerRoute(live, 'co', 'reviewer').pick.none, true);
    live.excludeFamilies.doer = [];
    assert.equal(reviewerArmAdmission(live, 'co', 'reviewer', nowMs)(account, kept).ok, true);
    assert.equal(pickReviewerRoute(live, 'co', 'reviewer').pick.accountId, account.accountId);
  });
});

test('F-T10: live fallback seating still obeys credential readiness and open breakers', async () => {
  await withLiveInternals(async ({ allocationOrderFromLive, breakerStores, credentialEnforceCompanies }, views) => {
    const { live, kept, fresh } = syntheticLive();
    live.credentialReadinessEnforced = true;
    const ready = { status: 'valid', observedAtMs: nowMs - 1000, expiresAtMs: nowMs + 100000, servingCredentials: 1, readyCredentials: 1 };
    fresh.credentialEvidence = ready;
    views.set('co', live);
    credentialEnforceCompanies.add('co');
    const groups = () => allocationOrderFromLive(live, 'co', null, 'doer', liveResolver(live, kept.armId))
      .order[0]?.ladderRungs.flatMap(g => g.arms).map(a => a.armId) ?? [];
    assert.ok(!groups().includes(kept.armId), 'unready candidate cannot seat');
    kept.credentialEvidence = ready;
    assert.ok(groups().includes(kept.armId), 'ready candidate seats when breaker is closed');
    const store = createBreakerStore();
    recordArmFailure(store, 'fixture:one', kept.armId, { atMs: nowMs - 2000, errorText: 'auth_unavailable' }, nowMs - 2000, DEFAULT_BREAKERS);
    recordArmFailure(store, 'fixture:one', kept.armId, { atMs: nowMs - 1000, errorText: 'auth_unavailable' }, nowMs - 1000, DEFAULT_BREAKERS);
    breakerStores.set('co', store);
    assert.ok(!groups().includes(kept.armId), 'open breaker removes the seated candidate');
    assert.ok(groups().includes(fresh.armId), 'other ready arms still route');
  });
});

test('F5 array callers remain identical to a resolver with no admission', async () => {
  await withLiveInternals(async ({ allocationOrderFromLive }, views) => {
    const { live } = syntheticLive();
    views.set('co', live);
    const global = live.excludeFamilies.doer;
    const arrayOrder = allocationOrderFromLive(live, 'co', null, 'doer', global, true, true);
    const resolverOrder = allocationOrderFromLive(live, 'co', null, 'doer', () => ({ excludedFamilies: global, fallbackAdmission: null }), true, true);
    assert.deepEqual(resolverOrder, arrayOrder);
  });
});

test('F5 per-account exclusions feed both access and placement, while arrays stay global', async () => {
  await withLiveInternals(async ({ allocationOrderFromLive }, views) => {
    const { live, kept } = syntheticLive();
    kept.qFleet = 0.27;
    live.excludeFamilies.doer.push('arm:sample-2');
    views.set('co', live);
    const routed = allocationOrderFromLive(live, 'co', null, 'doer', liveResolver(live, kept.armId));
    assert.equal(routed.order.length, 1);
    assert.equal(routed.order[0].roleEligible, true);
    assert.equal(routed.order[0].placementQ, 0.27);
    const global = allocationOrderFromLive(live, 'co', null, 'doer', live.excludeFamilies.doer);
    assert.equal(global.order[0].roleEligible, false);
    assert.equal(global.order[0].placementQ, null);
  });
});

test('X-T01 F5: production live resolver derives the descriptor from the serving account view', async () => {
  await withLiveInternals(async ({ allocationOrderFromLive, liveAccountInputs }, views) => {
    assert.equal(typeof liveAccountInputs, 'function');
    const { live, account, old, kept, view } = syntheticLive();
    views.set('co', live);
    const choose = armId => {
      live.accountAdmissions = { doer: { [account.accountId]: { armId } } };
      const resolver = a => liveAccountInputs(live, 'doer', live.excludeFamilies.doer, a);
      const desc = resolver(account).fallbackAdmission;
      const groups = allocationOrderFromLive(live, 'co', null, 'doer', resolver).order[0].ladderRungs;
      return { desc, ids: groups.flatMap(g => g.arms.map(a => a.armId)) };
    };
    assert.ok(view.verdicts.some(v => v.canonicalModel === kept.model && v.kept));
    assert.ok(!view.supersededLegacyArmIds.includes(kept.armId));
    assert.ok(!choose(old.armId).ids.includes(old.armId));
    const admitted = choose(kept.armId);
    assert.strictEqual(admitted.desc.supersessionView, account.newestVersion);
    assert.ok(admitted.ids.includes(kept.armId));
    account.newestVersion = null;
    const missing = choose(kept.armId);
    assert.equal(missing.desc, null);
    assert.ok(!missing.ids.includes(kept.armId));
    assert.equal(liveAccountInputs(live, 'doer', live.excludeFamilies.doer, account, true).fallbackAdmission, null);
  });
});
