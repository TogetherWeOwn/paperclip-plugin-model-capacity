import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin, validateConfigShape, resolveConfig } from '../src/plugin.mjs';
import { DEFAULT_MIN_QUALITY, DEFAULT_OUTCOME_GATE } from '../src/eligibility.mjs';
import { withSyntheticReadiness, syntheticAvailability } from './synthetic-readiness.mjs';

// Eligibility from data, end to end: the Q minimum and the measured-outcome
// gate keep Muse off doers WITHOUT a hand-written ban, the emergency
// override still works and warns, and /capacity shows why every arm is in or out.

const TICK = Date.parse('2026-10-08T23:00:00Z');
const HOUR = 3600 * 1000;
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_SKEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
const LEDGER_SKEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'ledger-v1' };

// Eight Pareto survivors (cost and Q rise together) so the fleet is big
// enough to score. Muse is the cheap outlier far below the rest.
const row = (slug, ii, cost) => ({
  slug, intelligenceIndex: ii, intelligenceIndexCostPerTask: cost, price1mInputTokens: 1, price1mOutputTokens: 4,
});
const aaRows = () => ([
  row('muse-spark-1-3-xhigh', 20, 4),
  row('claude-haiku-5-5', 50, 7),
  row('claude-haiku-5-5-xhigh', 52, 8),
  row('claude-sonnet-5-5-high', 55, 30), // dominated by sonnet-xhigh: higher cost, lower Q
  row('claude-sonnet-5-5-xhigh', 57, 18),
  row('claude-sonnet-5-5', 59, 22),
  row('claude-opus-5-5-xhigh', 61, 28),
  row('claude-opus-5-5', 63, 34),
]);
const lane = (laneName, provider, key, weeklyUsed, fiveHourUsed = 0.1) => ({
  lane: laneName, provider, accountKey: key, health: 'healthy',
  weekly: { used: weeklyUsed, resetsAt: '2026-10-15T22:59:00Z' },
  fiveHour: { used: fiveHourUsed, resetsAt: '2026-10-09T03:59:00Z' },
  observedAt: new Date(TICK).toISOString(), quality: 'live',
});

function drive({ config = {}, ledger = null, warnings = null, unhealthyClaude = false, spentClaude = false, coolingClaude = false, coolingMeta = false, metaOnly = false, agentModels = {} } = {}) {
  const metaLane = lane('meta-1', 'meta', 'm1', 0.05, 0.05);
  if (coolingMeta) metaLane.credentialAvailability = syntheticAvailability(metaLane, TICK, { serving: 1, ready: 0 });
  const claudeLane = spentClaude
    ? lane('claude-1', 'claude', 'a1', 1, 0)
    : lane('claude-1', 'claude', 'a1', 0.95);
  if (unhealthyClaude) claudeLane.health = 'unhealthy';
  // All-cooling evidence (readyCredentials 0): transient lane state, not a
  // health flag. The lane stays healthy so placement still sees it; only
  // credential admission drops its arms. withSyntheticReadiness never
  // overwrites an own credentialAvailability key.
  if (coolingClaude) claudeLane.credentialAvailability = syntheticAvailability(claudeLane, TICK, { serving: 1, ready: 0 });
  const store = new Map();
  const jobs = new Map();
  const skey = k => JSON.stringify(k);
  let nowMs = TICK;
  const io = {
    config: { get: async () => ({ ...config, cliproxy: { laneKeySecretRef: SECRET } }) },
    state: {
      get: async k => store.get(skey(k)) ?? null,
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'lane-key' },
    http: {
      fetch: async () => ({
        status: 200,
        json: async () => withSyntheticReadiness({
          observedAt: new Date(nowMs).toISOString(),
          servedModels: ['muse-spark-1.3-contributor', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
          // Meta holds the biggest deficit, so without a gate the doer goes
          // to Muse; claude stays decidable on five-hour headroom.
          accounts: metaOnly ? [metaLane] : [metaLane, claudeLane],
        }, nowMs),
      }),
    },
    agents: { get: async (id) => ({ adapterType: 'claude-code', ...(agentModels[id] ? { adapterConfig: { model: agentModels[id] } } : {}) }) },
    issues: { get: async () => null, list: async () => [] },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: () => {} },
    logger: {
      info() {}, error() {},
      ...(warnings ? { warn: (msg, meta) => warnings.push({ msg, meta }) } : {}),
    },
  };
  const plugin = createModelCapacityPlugin({ clock: () => nowMs, requirePinnedLaneHost: false });
  return {
    setup: async () => {
      await plugin.setup(io);
      store.set(skey(AA_SKEY), { fetchedAt: new Date(TICK).toISOString(), rows: aaRows(), duplicateSlugs: [] });
      if (ledger) store.set(skey(LEDGER_SKEY), ledger);
      await plugin.onConfigChanged(config, { companyId: 'acme' });
    },
    advance: (ms) => { nowMs += ms; },
    tick: () => jobs.get('quota-refresh')({}),
    hook: (runId, agentId) => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId, issueId: null,
      adapterType: 'claude-code', invocationSource: 'test', wakeReason: null,
      agentDefaultModel: null, previous: null, issueOverrideModel: null,
      deadlineMs: 1500,
    }),
    ledger: () => store.get(skey(LEDGER_SKEY)),
    capacity: async () => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body,
    ladder: async () => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'ladder' })).body,
  };
}

const ROLES_CFG = { doerAgentIds: ['eng-doer'], thinkerAgentIds: ['planner'] };
const NO_GATES = { minQuality: { doer: null, thinker: null, other: null }, outcomeGate: { enabled: false } };
// Quality-aware placement would already steer away from a weak arm; the
// eligibility tests switch it off so they show the gates, not the blend.
const FLAT_PLACEMENT = { qualityWeight: 0 };

test('control: with the gates off and no ban, the biggest-deficit account (Muse) takes the doer', async () => {
  const d = drive({ config: { enforce: true, placement: FLAT_PLACEMENT, roles: { ...ROLES_CFG, ...NO_GATES } } });
  await d.setup();
  await d.tick();
  const h = await d.hook('run-1', 'eng-doer');
  assert.equal(h.kind, 'decide');
  assert.match(h.model, /muse-spark/);
});

test('quality minimum: default config keeps Muse off a doer with no excludeFamilies', async () => {
  const d = drive({ config: { enforce: true, roles: ROLES_CFG } });
  await d.setup();
  await d.tick();
  const h = await d.hook('run-1', 'eng-doer');
  assert.equal(h.kind, 'decide');
  assert.match(h.model, /claude/);
  const cap = await d.capacity();
  assert.deepEqual(cap.roleExclusions, { doer: [], thinker: [], other: [] }, 'operator list is empty');
  assert.deepEqual(cap.roleExclusionsEffective.doer, ['arm:muse-spark-1-3-xhigh']);
  const muse = cap.eligibility.arms.find(a => a.armId === 'muse-spark-1-3-xhigh');
  assert.ok(muse.qFleet < -1, `muse fleet Q ${muse.qFleet}`);
  assert.equal(muse.eligible.doer.ok, false);
  assert.match(muse.eligible.doer.reasons[0], /^min-quality: -2\.\d\d < -1$/);
  const opus = cap.eligibility.arms.find(a => a.armId === 'claude-opus-5-5');
  assert.equal(opus.eligible.doer.ok, true);
  assert.equal(opus.eligible.thinker.ok, true);
  assert.equal(cap.eligibility.minQuality.doer, DEFAULT_MIN_QUALITY.doer);
  assert.deepEqual(cap.eligibility.warnings, []);
});

test('the audit and the fleet-size rule cover every served arm, not only ladder survivors', async () => {
  const d = drive({ config: { enforce: true, roles: ROLES_CFG } });
  await d.setup();
  await d.tick();
  const cap = await d.capacity();
  const onLadders = new Set(cap.accounts.flatMap(a => a.arms.map(x => x.armId)));
  assert.ok(!onLadders.has('claude-sonnet-5-5-high'), 'dominated: on no ladder');
  const row = cap.eligibility.arms.find(a => a.armId === 'claude-sonnet-5-5-high');
  assert.ok(row && typeof row.qFleet === 'number', 'still scored and listed');
  assert.equal(cap.eligibility.arms.length, 8);
  assert.deepEqual(cap.eligibility.warnings, [], 'eight scored arms: the minimum applies');
});

test('the per-role minimum is per role: a lower doer floor lets Muse back in, thinkers still refuse it', async () => {
  const d = drive({ config: { enforce: true, placement: FLAT_PLACEMENT, roles: { ...ROLES_CFG, minQuality: { doer: -3, thinker: 0 }, outcomeGate: { enabled: false } } } });
  await d.setup();
  await d.tick();
  assert.match((await d.hook('run-d', 'eng-doer')).model, /muse-spark/);
  const cap = await d.capacity();
  assert.deepEqual(cap.roleExclusionsEffective.doer, []);
  // Thinker floor is fleet average: Muse and the two below-average Haiku arms are out.
  assert.deepEqual(cap.roleExclusionsEffective.thinker.sort(),
    ['arm:claude-haiku-5-5', 'arm:claude-haiku-5-5-xhigh', 'arm:muse-spark-1-3-xhigh']);
  const t = await d.hook('run-t', 'planner');
  assert.equal(t.kind, 'decide');
  assert.doesNotMatch(t.model, /haiku|muse/);
});

const rec = (i, model, progress, agentId = 'eng-doer', ageH = 2) => ({
  runId: `seed-${model}-${i}`, agentId, status: 'finished', actualModel: model, progress,
  terminalAt: TICK - ageH * HOUR, startedAt: TICK - ageH * HOUR - 5 * 60000, decidedAccount: null, unverified: false,
});
const seedLedger = (ageH = 2) => [
  ...Array.from({ length: 16 }, (_, i) => rec(i, 'muse-spark-1.3-contributor', 'noChange', 'eng-doer', ageH)),
  ...Array.from({ length: 4 }, (_, i) => rec(100 + i, 'muse-spark-1.3-contributor', 'progressed', 'eng-doer', ageH)),
  ...Array.from({ length: 16 }, (_, i) => rec(200 + i, 'claude-sonnet-5-5', 'progressed', 'eng-doer', ageH)),
  ...Array.from({ length: 4 }, (_, i) => rec(300 + i, 'claude-sonnet-5-5', 'noChange', 'eng-doer', ageH)),
];

test('outcome gate: Muse runs that did not do the job take it off doers, with the evidence in /capacity', async () => {
  const cfg = { enforce: true, roles: { ...ROLES_CFG, minQuality: { doer: null, thinker: null, other: null } } };
  const d = drive({ config: cfg, ledger: seedLedger() });
  await d.setup();
  await d.tick();
  const h = await d.hook('run-1', 'eng-doer');
  assert.equal(h.kind, 'decide');
  assert.match(h.model, /claude/);
  const cap = await d.capacity();
  assert.deepEqual(cap.roleExclusionsEffective.doer, ['muse']);
  const ev = cap.eligibility.roles.doer.outcome;
  assert.deepEqual(ev.gated, ['muse']);
  assert.equal(ev.families.muse.judged, 20);
  assert.equal(ev.families.muse.rate, 0.2);
  assert.equal(ev.families.sonnet.gated, false);
  assert.deepEqual(cap.eligibility.roles.thinker.outcome.gated, [], 'no thinker runs, no thinker verdict');
  const muse = cap.eligibility.arms.find(a => a.armId === 'muse-spark-1-3-xhigh');
  assert.match(muse.eligible.doer.reasons[0], /^outcome-gate: progress-rate 0\.20/);
  assert.equal(muse.eligible.thinker.ok, true, 'gated per role: thinkers have no evidence against it');
});

test('outcome gate recovers: the evidence ages out and Muse is eligible again', async () => {
  const cfg = { enforce: true, roles: { ...ROLES_CFG, minQuality: { doer: null, thinker: null, other: null } } };
  const d = drive({ config: cfg, ledger: seedLedger(2) });
  await d.setup();
  await d.tick();
  assert.deepEqual((await d.capacity()).roleExclusionsEffective.doer, ['muse']);
  d.advance(23 * HOUR);
  await d.tick();
  const cap = await d.capacity();
  assert.deepEqual(cap.roleExclusionsEffective.doer, [], 'the 2h-old evidence is 25h old now');
  assert.equal(cap.eligibility.roles.doer.outcome.families.muse, undefined);
});

test('outcome gate off: the same history gates nothing', async () => {
  const cfg = { enforce: true, roles: { ...ROLES_CFG, ...NO_GATES } };
  const d = drive({ config: cfg, ledger: seedLedger() });
  await d.setup();
  await d.tick();
  assert.deepEqual((await d.capacity()).roleExclusionsEffective.doer, []);
});

test('emergency override still applies, warns while non-empty, and logs at most hourly', async () => {
  const warnings = [];
  const cfg = { enforce: true, roles: { ...ROLES_CFG, ...NO_GATES, excludeFamilies: { doer: ['muse'] } } };
  const d = drive({ config: cfg, warnings });
  await d.setup();
  assert.deepEqual(warnings.map(w => w.meta), [{ variant: 'transitional', exitDate: '2026-11-30' }]);
  warnings.length = 0; // Measure eligibility warnings separately from the boot self-check.
  await d.tick();
  assert.match((await d.hook('run-1', 'eng-doer')).model, /claude/);
  const cap = await d.capacity();
  assert.deepEqual(cap.roleExclusions.doer, ['muse']);
  assert.deepEqual(cap.roleExclusionsEffective.doer, ['muse']);
  assert.deepEqual(cap.eligibility.warnings.map(w => w.code), ['manual-exclusions']);
  assert.deepEqual(cap.eligibility.warnings[0].roles, { doer: ['muse'] });
  const muse = cap.eligibility.arms.find(a => a.armId === 'muse-spark-1-3-xhigh');
  assert.match(muse.eligible.doer.reasons[0], /^manual-exclusion: muse/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /emergency override/);
  assert.equal(warnings[0].meta.code, 'manual-exclusions');
  await d.tick();
  assert.equal(warnings.length, 1, 'same hour: no repeat');
  d.advance(61 * 60000);
  await d.tick();
  assert.equal(warnings.length, 2, 'standing override is visible again after an hour');
});

test('an all-cooling lane never lifts the operator ban: the doer defers through the full plugin path', async () => {
  // Claude credentials all-cooling (readyCredentials 0) is transient lane
  // state, not fleet structure. The structural view must still see the
  // Claude arms (unfiltered ranking), so the Meta muse ban for doers holds
  // and the run defers -- going through the plugin readiness path, not a
  // hand-built structuralGroups. Pinned to on-mode: off mode admits the
  // cooling lane like legacy, so it would decide Claude instead of deferring.
  const cfg = { enforce: true, credentialReadiness: { enforce: true }, roles: { ...ROLES_CFG, ...NO_GATES, excludeFamilies: { doer: ['muse'] } } };
  const d = drive({ config: cfg, coolingClaude: true });
  await d.setup();
  await d.tick();
  const h = await d.hook('run-1', 'eng-doer');
  assert.equal(h.kind, 'defer', 'doer defers while Claude is all-cooling');
  const cap = await d.capacity();
  assert.deepEqual(cap.eligibility.roles.doer.suspendedManual, [], 'the muse ban holds');
  assert.ok(cap.roleExclusionsEffective.doer.includes('muse'));
});

test('off mode still lifts the operator ban onto an all-cooling lane: the doer decides through the full plugin path', async () => {
  // Same fixture as the on-mode test above, but a Meta-only fleet whose
  // single lane is all-cooling, with the flag off. The tick's eligibility
  // accountGroups are what let servesHealthy see the admitted cooling lane,
  // so the empty-role guard lifts the muse ban (legacy parity) instead of
  // deferring every doer run into the single-provider defer loop the
  // operator-list suspension exists to prevent. Forcing the flag on at that
  // call site must fail this test (verified by mutation).
  const base = { enforce: true, roles: { ...ROLES_CFG, ...NO_GATES, excludeFamilies: { doer: ['muse'] } } };
  const off = drive({ config: { ...base, credentialReadiness: { enforce: false } }, metaOnly: true, coolingMeta: true });
  await off.setup();
  await off.tick();
  const h = await off.hook('run-1', 'eng-doer');
  assert.equal(h.kind, 'decide', 'off mode admits the cooling lane like legacy');
  assert.match(h.model, /muse-spark/);
  assert.deepEqual((await off.capacity()).eligibility.roles.doer.suspendedManual, ['muse'], 'the ban lifts: legacy parity');
  const on = drive({ config: { ...base, credentialReadiness: { enforce: true } }, metaOnly: true, coolingMeta: true });
  await on.setup();
  await on.tick();
  assert.equal((await on.hook('run-1', 'eng-doer')).kind, 'defer', 'on mode refuses the all-cooling lane');
  assert.deepEqual((await on.capacity()).eligibility.roles.doer.suspendedManual, [], 'the muse ban holds');
});

test('an empty operator list adds no warnings beyond the boot self-check', async () => {
  const warnings = [];
  const d = drive({ config: { enforce: true, roles: ROLES_CFG }, warnings });
  await d.setup();
  await d.tick();
  assert.deepEqual(warnings.map(w => w.meta), [{ variant: 'transitional', exitDate: '2026-11-30' }]);
});

test('a logger without warn falls back to info instead of throwing', async () => {
  const cfg = { enforce: true, roles: { ...ROLES_CFG, ...NO_GATES, excludeFamilies: { doer: ['muse'] } } };
  const d = drive({ config: cfg });
  await d.setup();
  await d.tick();
  assert.match((await d.hook('run-1', 'eng-doer')).model, /claude/);
});

test('config: defaults, normalization and validation of roles.minQuality and roles.outcomeGate', () => {
  const r = resolveConfig({});
  assert.deepEqual(r.roles.minQuality, DEFAULT_MIN_QUALITY);
  assert.deepEqual(r.roles.outcomeGate, DEFAULT_OUTCOME_GATE);
  const c = resolveConfig({ roles: { minQuality: { doer: null, thinker: 0.4 }, outcomeGate: { minRuns: 5 } } });
  assert.equal(c.roles.minQuality.doer, null);
  assert.equal(c.roles.minQuality.thinker, 0.4);
  assert.equal(c.roles.minQuality.other, DEFAULT_MIN_QUALITY.other);
  assert.equal(c.roles.outcomeGate.minRuns, 5);
  assert.equal(c.roles.outcomeGate.minProgressRate, DEFAULT_OUTCOME_GATE.minProgressRate);
  assert.deepEqual(validateConfigShape({ roles: { minQuality: { doer: -1, thinker: null }, outcomeGate: { enabled: true, minRuns: 8, windowHours: 12 } } }), []);
  for (const bad of [
    { roles: { minQuality: 'x' } },
    { roles: { minQuality: [] } },
    { roles: { minQuality: { admin: 1 } } },
    { roles: { minQuality: { doer: 'low' } } },
    { roles: { minQuality: { doer: Infinity } } },
    { roles: { outcomeGate: 'x' } },
    { roles: { outcomeGate: { enabled: 'yes' } } },
    { roles: { outcomeGate: { minRuns: 0 } } },
    { roles: { outcomeGate: { lastRuns: 1.5 } } },
    { roles: { outcomeGate: { minProgressRate: 1.2 } } },
    { roles: { outcomeGate: { relativeToBest: -0.1 } } },
    { roles: { outcomeGate: { windowHours: 0 } } },
    { roles: { outcomeGate: { windowHours: 72 } } },
    { roles: { outcomeGate: { minRuns: 12, lastRuns: 5 } } },
  ]) {
    assert.ok(validateConfigShape(bad).length > 0, JSON.stringify(bad));
  }
});

test('a role the gates would empty is suspended, never a defer loop', async () => {
  // Doer floor above every arm: the gate would leave no doer arm anywhere.
  const cfg = { enforce: true, roles: { ...ROLES_CFG, minQuality: { doer: 5 }, outcomeGate: { enabled: false } } };
  const d = drive({ config: cfg });
  await d.setup();
  await d.tick();
  const h = await d.hook('run-1', 'eng-doer');
  assert.equal(h.kind, 'decide', 'gate suspended for the role: the run is placed');
  const cap = await d.capacity();
  assert.equal(cap.eligibility.roles.doer.suspended, true);
  assert.ok(cap.eligibility.warnings.some(w => w.code === 'role-empty-suspended' && w.role === 'doer'));
  assert.deepEqual(cap.roleExclusionsEffective.doer, []);
});

test('an unhealthy account cannot strand a role in defer: the guard reads only arms placement can use', async () => {
  // Claude unhealthy: placement can only use Meta (Muse), which the quality
  // gate keeps off doers. The empty-role guard must read the same arms --
  // healthy accounts with breaker-open arms filtered out -- so it suspends
  // the quality gate for doers instead of keeping it while every doer run
  // defers on headroom. Reading unfiltered rungs (or unhealthy accounts)
  // leaves the gate on and the role empty.
  const d = drive({ config: { enforce: true, roles: ROLES_CFG }, unhealthyClaude: true });
  await d.setup();
  await d.tick();
  const h = await d.hook('run-1', 'eng-doer');
  assert.equal(h.kind, 'decide', 'gate suspended for the role: the run is placed, never deferred');
  assert.match(h.model, /muse-spark/);
  const cap = await d.capacity();
  assert.equal(cap.eligibility.roles.doer.suspended, true);
  assert.ok(cap.eligibility.warnings.some(w => w.code === 'role-empty-suspended' && w.role === 'doer'));
});

test('a weekly-spent account cannot strand a role in defer: the guard skips it like an unhealthy one', async () => {
  // Claude reads healthy with an idle 5h meter but its weekly window is
  // spent, so placement excludes it and only Meta (Muse) remains, which the
  // quality gate keeps off doers. The empty-role guard must skip the spent
  // account too; reading it as usable keeps the gate on while every doer run
  // defers.
  const d = drive({ config: { enforce: true, roles: ROLES_CFG }, spentClaude: true });
  await d.setup();
  await d.tick();
  const h = await d.hook('run-1', 'eng-doer');
  assert.equal(h.kind, 'decide', 'gate suspended for the role: the run is placed, never deferred');
  assert.match(h.reason, /rung 0 on meta:m1/);
  const cap = await d.capacity();
  assert.equal(cap.eligibility.roles.doer.suspended, true);
});

test('a pinned agent keeps its configured model under enforce; other agents are still routed', async () => {
  const d = drive({ config: { enforce: true, roles: { ...ROLES_CFG, keepAgentIds: ['planner'] } } });
  await d.setup();
  await d.tick();
  assert.deepEqual(await d.hook('run-1', 'planner'), { kind: 'keep' });
  assert.equal((await d.hook('run-2', 'eng-doer')).kind, 'decide');
});

test('pinned runs count against their serving account at once, before the next tick', async () => {
  // The pinned agent runs Muse on meta:m1, the account a doer would
  // otherwise take. Pinned hooks between ticks must add pressure on m1 so
  // water-filling sends the doer elsewhere; without the kept decision the
  // doer still lands on m1.
  const cfg = { enforce: true, pacing: { holdAheadPts: null }, placement: FLAT_PLACEMENT, roles: { ...ROLES_CFG, ...NO_GATES, keepAgentIds: ['planner'] } };
  const control = drive({ config: cfg, agentModels: { planner: 'muse-spark-1.3-contributor' } });
  await control.setup();
  await control.tick();
  assert.match((await control.hook('run-d0', 'eng-doer')).reason, /meta:m1/);
  const d = drive({ config: cfg, agentModels: { planner: 'muse-spark-1.3-contributor' } });
  await d.setup();
  await d.tick();
  for (let i = 0; i < 40; i += 1) assert.deepEqual(await d.hook(`run-p${i}`, 'planner'), { kind: 'keep' });
  const h = await d.hook('run-d1', 'eng-doer');
  assert.equal(h.kind, 'decide');
  assert.doesNotMatch(h.reason, /meta:m1/, 'pinned runs already fill meta:m1');
});

test('the published family outcomes and the gate attribute a run to the same family', async () => {
  const ledger = [{
    runId: 'r-unknown-model', agentId: 'eng-doer', status: 'finished', actualModel: 'unknown', family: 'muse',
    progress: 'noChange', terminalAt: TICK - 2 * HOUR, startedAt: TICK - 3 * HOUR, unverified: false,
  }];
  const d = drive({ config: { enforce: true, roles: ROLES_CFG }, ledger });
  await d.setup();
  await d.tick();
  const cap = await d.capacity();
  assert.equal(cap.familyOutcomes.muse?.runs, 1, 'counted under the decision family, not "unknown"');
  assert.equal(cap.familyOutcomes.unknown, undefined);
  assert.equal(cap.eligibility.roles.doer.outcome.families.muse.judged, 1);
});

test('active fallback selects its finalized account without changing global exclusions or serialized ladders', async () => {
  const common = { enforce: true, roles: { ...ROLES_CFG, minQuality: { doer: 0.12, other: 0.17 }, outcomeGate: { enabled: false } } };
  const off = drive({ config: common });
  const on = drive({ config: { ...common, roles: { ...common.roles, accountFallback: { enabled: true, minQuality: -3 } } } });
  await off.setup(); await on.setup();
  await off.tick(); await on.tick();
  const a = await off.capacity(); const b = await on.capacity();
  assert.equal('accountFallback' in a.eligibility, false);
  assert.equal(b.eligibility.accountFallback.supported, true);
  assert.ok(b.eligibility.accountFallback.admitted.length > 0);
  assert.deepEqual(b.roleExclusionsEffective, a.roleExclusionsEffective);
  assert.equal(JSON.stringify(await on.ladder()), JSON.stringify(await off.ladder()));
  const onPick = await on.hook('f2-run', 'eng-doer');
  const offPick = await off.hook('f2-run', 'eng-doer');
  assert.deepEqual({ kind: onPick.kind, model: onPick.model, effort: onPick.effort },
    { kind: 'decide', model: 'muse-spark-1.3-contributor', effort: 'xhigh' });
  assert.deepEqual({ kind: offPick.kind, model: offPick.model, effort: offPick.effort },
    { kind: 'decide', model: 'claude-sonnet-5-5', effort: 'xhigh' });
  await on.tick(); await off.tick();
  const selected = on.ledger().find(row => row.runId === 'f2-run');
  const control = off.ledger().find(row => row.runId === 'f2-run');
  assert.deepEqual({ accountId: selected.decidedAccount, armId: selected.armId, rung: selected.rung, agentId: selected.agentId },
    { accountId: 'meta:m1', armId: 'muse-spark-1-3-xhigh', rung: 0, agentId: 'eng-doer' });
  assert.deepEqual({ accountId: control.decidedAccount, rung: control.rung }, { accountId: 'claude:a1', rung: 2 });
  assert.equal(b.eligibility.accountFallback.admitted.filter(row => row.accountId === selected.decidedAccount
    && row.armId === selected.armId && row.role === 'doer').length, 1,
  'the selected doer arm belongs to a finalized admission, not a global exclusion rewrite');
});


test('fallback warning and report reflect newest-version configuration at tick', async () => {
  for (const enabled of [false, true]) {
    const d = drive({ config: { roles: { ...ROLES_CFG, accountFallback: { enabled: true }, newestVersionOnly: { enabled } } } });
    await d.setup(); await d.tick();
    const report = (await d.capacity()).eligibility;
    assert.equal(report.accountFallback.newestVersionActive, enabled);
    assert.equal(report.warnings.filter(w => w.code === 'account-fallback-without-newest-version').length, enabled ? 0 : 1);
  }
});

test('tick suppresses a provisional fallback when its account has no usable benchmark rungs', async () => {
  const d = drive({ coolingMeta: true, config: { roles: { ...ROLES_CFG,
    accountFallback: { enabled: true, roles: ['doer'], minQuality: -3 },
    outcomeGate: { enabled: false },
  }, credentialReadiness: { enforce: true } } });
  await d.setup();
  await d.tick();
  const fallback = (await d.capacity()).eligibility.accountFallback;
  assert.ok(fallback.suppressed.some(row => row.role === 'doer' && row.armId === 'muse-spark-1-3-xhigh'), JSON.stringify(fallback));
  assert.ok(!fallback.admitted.some(row => row.role === 'doer' && row.armId === 'muse-spark-1-3-xhigh'));
});


test('tick shadow routes a doer to its admitted weak account', async () => {
  const ledger = [{ runId: 'shadow-weak', agentId: 'eng-doer', status: 'running', startedAt: TICK - 1000, unverified: false }];
  const config = { placement: FLAT_PLACEMENT, roles: { ...ROLES_CFG,
    accountFallback: { enabled: true, roles: ['doer'], minQuality: -3 }, outcomeGate: { enabled: false } } };
  const d = drive({ config, ledger });
  await d.setup();
  await d.tick();
  const cap = await d.capacity();
  assert.ok(cap.eligibility.accountFallback.admitted.some(row => row.role === 'doer' && row.accountId === 'meta:m1'));
  assert.equal(d.ledger().find(r => r.runId === 'shadow-weak').decidedAccount, 'meta:m1');
});

test('F-T28: finalized fallback is reported once per admitted role without changing fleet verdict', async () => {
  const roles = { ...ROLES_CFG, outcomeGate: { enabled: false } };
  const d = drive({ config: { roles: { ...roles,
    accountFallback: { enabled: true, roles: ['doer'], minQuality: -3 } } } });
  const control = drive({ config: { roles } });
  await d.setup(); await control.setup();
  await d.tick(); await control.tick();
  const e = (await d.capacity()).eligibility;
  const baseline = (await control.capacity()).eligibility;
  const verdicts = report => report.arms.map(a => [a.armId,
    Object.fromEntries(Object.entries(a.eligible).map(([role, v]) => [role, v.ok]))]);
  assert.deepEqual(verdicts(e), verdicts(baseline), 'fallback does not change fleet verdicts');
  assert.equal(e.warnings.filter(w => w.code === 'account-fallback-admitted' && w.role === 'doer').length, 1);
  const muse = e.arms.find(a => a.armId === 'muse-spark-1-3-xhigh');
  assert.equal(muse.eligible.doer.ok, false);
  assert.ok(muse.eligible.doer.reasons.some(r => r.startsWith('account-fallback-admitted:')));
});

test('F-T26: legacy tick preview seats fallback in shadow but enforce stays pinned', async () => {
  for (const mode of ['shadow', 'enforce']) {
    const d = drive({ config: { placement: FLAT_PLACEMENT, taskRanking: { mode }, roles: { ...ROLES_CFG,
      accountFallback: { enabled: true, roles: ['doer'], minQuality: -3 }, outcomeGate: { enabled: false } } } });
    await d.setup(); await d.tick();
    const cap = await d.capacity();
    const comparison = cap.taskRanking.routeComparisons.find(c => c.previewInputs.role === 'doer' && c.previewInputs.adapterType === null);
    assert.equal(comparison.legacy?.accountId, mode === 'shadow' ? 'meta:m1' : 'claude:a1', `legacy preview in ${mode}: ${JSON.stringify(comparison)}`);
    if (mode === 'enforce') assert.equal(cap.eligibility.accountFallback.supported, false);
  }
});

test('F-T27: fallback never changes serialized ladder with newest either off or on', async () => {
  for (const enabled of [false, true]) {
    const roles = { ...ROLES_CFG, newestVersionOnly: { enabled }, outcomeGate: { enabled: false } };
    const off = drive({ config: { roles } });
    const on = drive({ config: { roles: { ...roles, accountFallback: { enabled: true, roles: ['doer'], minQuality: -3 } } } });
    await off.setup(); await on.setup(); await off.tick(); await on.tick();
    const a = JSON.stringify(await off.ladder());
    const b = JSON.stringify(await on.ladder());
    assert.equal(b, a, `serialized ladders differ with newest ${enabled}`);
    assert.doesNotMatch(b, /accountFallback|accountAdmissions/);
  }
});

test('F-T12: reviewer capacity uses global eligibility, not account fallback', async () => {
  const roles = { ...ROLES_CFG, outcomeGate: { enabled: false } };
  const common = { reviewer: { providers: ['claude', 'meta'] } };
  const off = drive({ config: { ...common, roles } });
  const on = drive({ config: { ...common, roles: { ...roles,
    accountFallback: { enabled: true, roles: ['doer'], minQuality: -3 } } } });
  await off.setup(); await on.setup(); await off.tick(); await on.tick();
  const a = await off.capacity(), b = await on.capacity();
  assert.ok(b.eligibility.accountFallback.admitted.some(row => row.role === 'doer' && row.accountId === 'meta:m1'));
  assert.deepEqual(a.reviewer.qualifiedAccountIds, ['claude:a1']);
  assert.deepEqual(b.reviewer.qualifiedAccountIds, a.reviewer.qualifiedAccountIds);
  assert.equal(b.reviewer.slots, a.reviewer.slots);
});

test('tick shadow suppresses fallback for a recognized reviewer', async () => {
  const ledger = [{ runId: 'review-weak', agentId: 'eng-doer', status: 'running', startedAt: TICK - 1000, unverified: false }];
  const config = { placement: FLAT_PLACEMENT, reviewReserve: { agentIds: ['eng-doer'] }, roles: { ...ROLES_CFG,
    accountFallback: { enabled: true, roles: ['doer'], minQuality: -3 }, outcomeGate: { enabled: false } } };
  const d = drive({ config, ledger });
  await d.setup(); await d.tick();
  const cap = await d.capacity();
  assert.ok(cap.eligibility.accountFallback.admitted.some(row => row.role === 'doer' && row.accountId === 'meta:m1'));
  assert.equal(d.ledger().find(r => r.runId === 'review-weak').decidedAccount, 'claude:a1');
});

test('F-T20: doer admission does not change thinker tick routing', async () => {
  const ledger = [{ runId: 'thinker-run', agentId: 'planner', status: 'running', startedAt: TICK - 1000, unverified: false }];
  const roles = { ...ROLES_CFG, outcomeGate: { enabled: false } };
  const off = drive({ ledger: structuredClone(ledger), config: { placement: FLAT_PLACEMENT, roles } });
  const on = drive({ ledger: structuredClone(ledger), config: { placement: FLAT_PLACEMENT, roles: { ...roles,
    accountFallback: { enabled: true, roles: ['doer'], minQuality: -3 } } } });
  await off.setup(); await on.setup(); await off.tick(); await on.tick();
  const a = await off.capacity(), b = await on.capacity();
  assert.ok(b.eligibility.accountFallback.admitted.some(row => row.role === 'doer' && row.accountId === 'meta:m1'));
  assert.ok(!b.eligibility.accountFallback.admitted.some(row => row.role === 'thinker'));
  assert.equal(off.ledger().find(r => r.runId === 'thinker-run').decidedAccount, 'claude:a1');
  assert.equal(on.ledger().find(r => r.runId === 'thinker-run').decidedAccount, 'claude:a1');
  const thinker = cap => cap.taskRanking.routeComparisons.filter(c => c.previewInputs.role === 'thinker');
  assert.deepEqual(thinker(b), thinker(a));
});
