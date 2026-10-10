import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin, validateConfigShape, resolveConfig } from '../src/plugin.mjs';
import { DEFAULT_MIN_QUALITY, DEFAULT_OUTCOME_GATE } from '../src/eligibility.mjs';

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

function drive({ config = {}, ledger = null, warnings = null, unhealthyClaude = false } = {}) {
  const claudeLane = lane('claude-1', 'claude', 'a1', 0.95);
  if (unhealthyClaude) claudeLane.health = 'unhealthy';
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
        json: async () => ({
          observedAt: new Date(nowMs).toISOString(),
          // Meta holds the biggest deficit, so without a gate the doer goes
          // to Muse; claude stays decidable on five-hour headroom.
          accounts: [lane('meta-1', 'meta', 'm1', 0.05, 0.05), claudeLane],
        }),
      }),
    },
    agents: { get: async () => ({ adapterType: 'claude-code' }) },
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
    tick: () => jobs.get('shadow-tick')({}),
    hook: (runId, agentId) => plugin.onResolveRunModel({
      runId, companyId: 'acme', agentId, issueId: null,
      adapterType: 'claude-code', invocationSource: 'test', wakeReason: null,
      agentDefaultModel: null, previous: null, issueOverrideModel: null,
      deadlineMs: 1500,
    }),
    capacity: async () => (await plugin.onApiRequest({ companyId: 'acme', routeKey: 'capacity' })).body,
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

test('an empty operator list logs nothing', async () => {
  const warnings = [];
  const d = drive({ config: { enforce: true, roles: ROLES_CFG }, warnings });
  await d.setup();
  await d.tick();
  assert.deepEqual(warnings, []);
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
