import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decide, placementArm, roleLadderAccess, filterRungsByExcludedFamilies, armToken,
} from '../src/decide.mjs';
import {
  DEFAULT_MIN_QUALITY, DEFAULT_OUTCOME_GATE, MIN_FLEET_ARMS, armQuality, qualityVerdicts, outcomeGates,
  buildEligibility, normalizeMinQuality, normalizeOutcomeGate,
} from '../src/eligibility.mjs';

// Eligibility from data: a per-role quality minimum and a measured-outcome
// gate replace hand-picked family bans. Exclusions travel as tokens in the
// existing exclusion list: `muse` (family) or `arm:<armId>` (one arm).

const NOW = 1_750_000_000_000;
const HOUR = 3600 * 1000;
const bands = { thinker: { floorRung: 0, ceilingRung: null }, doer: { floorRung: 0, ceilingRung: null } };
const arm = (armId, family, qFleet, extra = {}) => ({
  armId, model: armId, effort: 'max', family, Q: qFleet, qFleet, qFleetThinker: extra.qFleetThinker ?? qFleet,
  C: 1, trial: false, contextWindow: 1000000, ...extra,
});

test('arm tokens exclude one arm; its family siblings stay', () => {
  const groups = [{ rung: 0, arms: [arm('luna-low', 'luna', -1.1), arm('luna-max', 'luna', -0.2)] }];
  assert.equal(armToken('Luna-Low'), 'arm:luna-low');
  const filtered = filterRungsByExcludedFamilies(groups, [armToken('luna-low')]);
  assert.deepEqual(filtered[0].arms.map(a => a.armId), ['luna-max']);
  const base = {
    runId: 'r', agentId: 'a', role: 'doer', ladderRungs: groups, pointer: 0, accountId: 'x',
    fiveHourHeadroomPct: null, burnPerRunPct: {}, roleBands: bands,
  };
  // luna-low would win on armId order if it were not excluded.
  assert.equal(decide({ ...base, excludedFamilies: [armToken('luna-max')] }).armId, 'luna-low');
  assert.equal(decide({ ...base, excludedFamilies: [armToken('luna-low')] }).armId, 'luna-max');
  assert.equal(roleLadderAccess(groups, { role: 'doer', roleBands: bands, excludedFamilies: [armToken('luna-low'), armToken('luna-max')] }).eligible, false);
  assert.equal(placementArm(groups, { role: 'doer', roleBands: bands, excludedFamilies: [armToken('luna-max')] }).armId, 'luna-low');
});

test('armQuality: thinkers read the thinker blend, others the doer blend', () => {
  const a = arm('x', 'x', 0.2, { qFleetThinker: 0.9 });
  assert.equal(armQuality(a, 'doer'), 0.2);
  assert.equal(armQuality(a, 'other'), 0.2);
  assert.equal(armQuality(a, 'thinker'), 0.9);
  assert.equal(armQuality({ armId: 'y', qFleet: 0.4, qFleetThinker: null }, 'thinker'), 0.4);
  assert.equal(armQuality({ armId: 'z' }, 'doer'), null);
});

test('a fleet too small to score is not judged: the minimum is off and the report says so', () => {
  const arms = [arm('top', 'opus', 1), arm('low', 'oss', -1)];
  assert.ok(MIN_FLEET_ARMS > arms.length);
  const v = qualityVerdicts(arms, { doer: 0, thinker: 0, other: 0 });
  assert.equal(v.doer.low.ok, true);
  const e = buildEligibility({
    arms, records: [], nowMs: NOW, minQuality: { doer: 0, thinker: null, other: null },
    outcomeGate: G, manual: {}, roleOf, familyOf,
    accountGroups: [groupsFor(arms)], roleBands: bands, trialRoles: ['doer', 'other'],
  });
  assert.deepEqual(e.exclusions.doer, []);
  assert.deepEqual(e.report.warnings.map(w => [w.code, w.role]), [['fleet-too-small', 'doer']]);
});

test('quality minimum: at-or-above passes, below fails, null minimum is off, no score fails closed', () => {
  const arms = [arm('top', 'opus', 1.3), arm('mid', 'haiku', 0), arm('low', 'oss', -1.7), arm('blank', 'new', null, { qFleet: null, qFleetThinker: null })];
  const v = qualityVerdicts(arms, { doer: -1, thinker: 0, other: null }, { minFleetArms: 1 });
  assert.equal(v.doer.top.ok, true);
  assert.equal(v.doer.low.ok, false);
  assert.match(v.doer.low.reason, /min-quality/);
  assert.equal(v.doer.blank.ok, false, 'a min is set and the arm has no score');
  assert.equal(v.doer.blank.reason, 'unscored');
  assert.equal(v.thinker.mid.ok, true, 'boundary is inclusive');
  assert.equal(v.thinker.low.ok, false);
  assert.equal(v.other.low.ok, true, 'no minimum for the role');
  assert.equal(v.other.blank.ok, true);
});

// --- measured-outcome gate

const rec = (i, { agentId = 'doer-1', model = 'muse-spark-1.3-contributor', progress = 'noChange', ageH = 1, status = 'finished' } = {}) => ({
  runId: `r${i}-${agentId}-${model}`, agentId, status, actualModel: model, progress, terminalAt: NOW - ageH * HOUR,
});
const many = (n, opts) => Array.from({ length: n }, (_, i) => rec(i + (opts.seed ?? 0), opts));
const roleOf = (id) => (id.startsWith('think') ? 'thinker' : id.startsWith('doer') ? 'doer' : 'other');
const familyOf = (r) => (r.actualModel.includes('muse') ? 'muse' : r.actualModel.includes('sonnet') ? 'sonnet' : 'x');
const G = { ...DEFAULT_OUTCOME_GATE };
const gate = (records, cfg = G) => outcomeGates(records, { nowMs: NOW, cfg, roleOf, familyOf });

test('a family that does not do the job is gated; the family that does is not', () => {
  const recs = [
    ...many(14, { model: 'muse-spark-1.3-contributor', progress: 'noChange', seed: 0 }),
    ...many(6, { model: 'muse-spark-1.3-contributor', progress: 'progressed', seed: 100 }),
    ...many(14, { model: 'claude-sonnet-5-5', progress: 'progressed', seed: 200 }),
    ...many(6, { model: 'claude-sonnet-5-5', progress: 'noChange', seed: 300 }),
  ];
  const g = gate(recs);
  assert.deepEqual(g.doer.gated, ['muse']);
  assert.equal(g.doer.families.muse.judged, 20);
  assert.equal(g.doer.families.muse.progressed, 6);
  assert.equal(g.doer.families.muse.rate, 0.3);
  assert.equal(g.doer.families.sonnet.gated, false);
  assert.match(g.doer.families.muse.reason, /progress-rate/);
});

test('not enough evidence: never gated (new and rarely used families keep their chance)', () => {
  const g = gate(many(DEFAULT_OUTCOME_GATE.minRuns - 1, { progress: 'noChange' }));
  assert.deepEqual(g.doer.gated, []);
  assert.equal(g.doer.families.muse.gated, false);
  assert.match(g.doer.families.muse.reason, /insufficient/);
});

test('unknown outcomes, failed and cancelled runs are not evidence', () => {
  const recs = [
    ...many(30, { progress: 'unknown', seed: 0 }),
    ...many(30, { status: 'failed', progress: 'noChange', seed: 100 }),
    ...many(30, { status: 'cancelled', progress: 'noChange', seed: 200 }),
    // A healthy comparison family, so counting any of the above would gate Muse.
    ...many(20, { model: 'claude-sonnet-5-5', progress: 'progressed', seed: 300 }),
  ];
  const g = gate(recs);
  assert.deepEqual(g.doer.gated, []);
  assert.equal(g.doer.families.muse, undefined, 'no judged run, no row');
});

test('the best-evidenced family is never gated: a role where everyone is low keeps all', () => {
  // Reviewers answer in comments the plugin cannot see: every family reads
  // low. Gating on the absolute bar alone would empty the role.
  const recs = [
    ...many(20, { agentId: 'think-1', model: 'claude-sonnet-5-5', progress: 'noChange', seed: 0 }),
    ...many(2, { agentId: 'think-1', model: 'claude-sonnet-5-5', progress: 'progressed', seed: 50 }),
    ...many(20, { agentId: 'think-1', model: 'muse-spark-1.3-contributor', progress: 'noChange', seed: 100 }),
    ...many(2, { agentId: 'think-1', model: 'muse-spark-1.3-contributor', progress: 'progressed', seed: 150 }),
  ];
  assert.deepEqual(gate(recs).thinker.gated, [], 'both are ~9%: neither is worse than the best');
});

test('relative guard: below the bar but close to the best family is kept', () => {
  const recs = [
    ...many(20, { model: 'claude-sonnet-5-5', progress: 'noChange', seed: 0 }),
    ...many(18, { model: 'claude-sonnet-5-5', progress: 'progressed', seed: 50 }), // 47%
    ...many(22, { model: 'muse-spark-1.3-contributor', progress: 'noChange', seed: 100 }),
    ...many(14, { model: 'muse-spark-1.3-contributor', progress: 'progressed', seed: 150 }), // 39%
  ];
  assert.deepEqual(gate(recs).doer.gated, [], '39% < 50% bar but 39/47 = 0.83 of the best');
});

test('roles are judged apart: gated for doers, still eligible for other agents', () => {
  const recs = [
    ...many(20, { agentId: 'doer-1', model: 'muse-spark-1.3-contributor', progress: 'noChange', seed: 0 }),
    ...many(20, { agentId: 'doer-1', model: 'claude-sonnet-5-5', progress: 'progressed', seed: 100 }),
    ...many(20, { agentId: 'helper-1', model: 'muse-spark-1.3-contributor', progress: 'progressed', seed: 200 }),
  ];
  const g = gate(recs);
  assert.deepEqual(g.doer.gated, ['muse']);
  assert.deepEqual(g.other.gated, []);
});

test('recovery: evidence ages out of the window, and a family whose rate climbs is released', () => {
  const stale = many(25, { progress: 'noChange', ageH: 30 });
  assert.deepEqual(gate(stale).doer.gated, [], 'outside windowHours');
  const bad = [
    ...many(15, { progress: 'noChange', ageH: 3, seed: 0 }),
    ...many(20, { model: 'claude-sonnet-5-5', progress: 'progressed', seed: 500 }),
  ];
  assert.deepEqual(gate(bad).doer.gated, ['muse']);
  // Newer runs make progress: the last N judged runs now clear the bar.
  const better = [...bad, ...many(30, { progress: 'progressed', ageH: 0.5, seed: 800 })];
  const g = gate(better, { ...G, lastRuns: 30 });
  assert.deepEqual(g.doer.gated, [], 'only the most recent lastRuns count');
});

test('only the most recent lastRuns judged runs count', () => {
  const recs = [
    ...many(40, { progress: 'noChange', ageH: 10, seed: 0 }),
    ...many(10, { progress: 'progressed', ageH: 1, seed: 100 }),
    ...many(20, { model: 'claude-sonnet-5-5', progress: 'progressed', seed: 500 }),
  ];
  const wide = gate(recs, { ...G, lastRuns: 50 });
  assert.equal(wide.doer.families.muse.judged, 50);
  assert.deepEqual(wide.doer.gated, ['muse']);
  const narrow = gate(recs, { ...G, lastRuns: 12 });
  assert.equal(narrow.doer.families.muse.judged, 12);
  assert.equal(narrow.doer.families.muse.progressed, 10);
  assert.deepEqual(narrow.doer.gated, []);
});

test('disabled gate, unknown families and unknown roles gate nothing', () => {
  const recs = [...many(30, { progress: 'noChange' }), ...many(30, { model: 'claude-sonnet-5-5', progress: 'progressed', seed: 100 })];
  assert.deepEqual(gate(recs, { ...G, enabled: false }).doer.gated, []);
  const unk = outcomeGates(many(30, { progress: 'noChange' }), { nowMs: NOW, cfg: G, roleOf, familyOf: () => null });
  assert.deepEqual(unk.doer.gated, []);
});

// --- combined eligibility

const groupsFor = (...armsByRung) => armsByRung.map((arms, rung) => ({ rung, arms }));

test('buildEligibility: manual override, quality and outcome gates all land in one token list', () => {
  const arms = [arm('muse-xhigh', 'muse', 0.6), arm('oss-120b', 'oss', -1.7), arm('sonnet-max', 'sonnet', 0.9), arm('luna-high', 'luna', -0.9)];
  const recs = [
    ...many(20, { model: 'muse-spark-1.3-contributor', progress: 'noChange', seed: 0 }),
    ...many(20, { model: 'claude-sonnet-5-5', progress: 'progressed', seed: 100 }),
  ];
  const e = buildEligibility({
    arms,
    records: recs,
    nowMs: NOW,
    minQuality: { doer: -1, thinker: 0, other: -1 },
    outcomeGate: G,
    manual: { doer: ['astra'], thinker: [], other: [] },
    roleOf, familyOf,
    accountGroups: [groupsFor(arms)],
    roleBands: bands,
    trialRoles: ['doer', 'other'],
    minFleetArms: 1,
  });
  assert.deepEqual(e.exclusions.doer.sort(), ['arm:oss-120b', 'astra', 'muse'].sort());
  // thinker: quality floor 0 drops oss + luna; muse has no thinker evidence.
  assert.deepEqual(e.exclusions.thinker.sort(), ['arm:luna-high', 'arm:oss-120b']);
  assert.deepEqual(e.exclusions.other.sort(), ['arm:oss-120b']);
  const row = e.report.arms.find(a => a.armId === 'oss-120b');
  assert.equal(row.eligible.doer.ok, false);
  assert.deepEqual(row.eligible.doer.reasons.map(r => r.split(':')[0]), ['min-quality']);
  assert.equal(e.report.arms.find(a => a.armId === 'muse-xhigh').eligible.doer.ok, false);
  assert.match(e.report.arms.find(a => a.armId === 'muse-xhigh').eligible.doer.reasons[0], /outcome-gate/);
  assert.equal(e.report.arms.find(a => a.armId === 'sonnet-max').eligible.doer.ok, true);
  assert.deepEqual(e.report.warnings.map(w => w.code), ['manual-exclusions']);
  assert.equal(e.report.roles.doer.suspended, false);
});

test('buildEligibility: data gates that would empty a role are suspended, manual list still applies', () => {
  const arms = [arm('a', 'x', -2), arm('b', 'y', -3)];
  const e = buildEligibility({
    arms, records: [], nowMs: NOW,
    minQuality: { doer: 0, thinker: null, other: null },
    outcomeGate: G,
    manual: { doer: ['y'], thinker: [], other: [] },
    roleOf, familyOf,
    accountGroups: [groupsFor(arms)],
    roleBands: bands,
    trialRoles: ['doer', 'other'],
    minFleetArms: 1,
  });
  assert.deepEqual(e.exclusions.doer, ['y'], 'quality floor suspended; the operator list is kept');
  assert.equal(e.report.roles.doer.suspended, true);
  assert.ok(e.report.warnings.some(w => w.code === 'role-empty-suspended' && w.role === 'doer'));
  const row = e.report.arms.find(a => a.armId === 'a');
  assert.equal(row.eligible.doer.ok, true, 'reported as eligible while the gate is suspended');
  assert.ok(row.eligible.doer.reasons.some(r => r.startsWith('suspended')));
});

test('buildEligibility: with no data and no manual list nothing is excluded', () => {
  const arms = [arm('a', 'x', 0.3)];
  const e = buildEligibility({
    arms, records: [], nowMs: NOW,
    minQuality: { doer: null, thinker: null, other: null },
    outcomeGate: G, manual: {}, roleOf, familyOf,
    accountGroups: [groupsFor(arms)], roleBands: bands, trialRoles: ['doer', 'other'],
  });
  assert.deepEqual(e.exclusions, { doer: [], thinker: [], other: [] });
  assert.deepEqual(e.report.warnings, []);
});

test('config normalization: bad shapes fall back to defaults, nulls survive', () => {
  assert.deepEqual(normalizeMinQuality(undefined), DEFAULT_MIN_QUALITY);
  assert.deepEqual(normalizeMinQuality({ doer: null, thinker: 0.5, other: 'x' }),
    { doer: null, thinker: 0.5, other: DEFAULT_MIN_QUALITY.other });
  assert.deepEqual(normalizeMinQuality({ doer: Infinity, thinker: NaN }),
    { ...DEFAULT_MIN_QUALITY });
  assert.deepEqual(normalizeOutcomeGate(undefined), DEFAULT_OUTCOME_GATE);
  const n = normalizeOutcomeGate({ enabled: false, minRuns: 0, minProgressRate: 2, relativeToBest: -1, windowHours: 400, lastRuns: 0 });
  assert.equal(n.enabled, false);
  assert.equal(n.minRuns, DEFAULT_OUTCOME_GATE.minRuns, 'must be >= 1');
  assert.equal(n.minProgressRate, DEFAULT_OUTCOME_GATE.minProgressRate, 'a rate is in [0, 1]');
  assert.equal(n.relativeToBest, DEFAULT_OUTCOME_GATE.relativeToBest);
  assert.equal(n.windowHours, 24, 'the ledger keeps terminal runs for 24h: the window is clamped to it');
  assert.equal(n.lastRuns, DEFAULT_OUTCOME_GATE.lastRuns);
});

test('hostile ids as arm or family keys never touch Object.prototype', () => {
  const arms = [arm('__proto__', '__proto__', -2), arm('ok-arm', 'ok', 1)];
  const recs = [
    ...many(15, { model: 'x', progress: 'noChange', seed: 0 }),
    ...many(15, { model: 'y', progress: 'progressed', seed: 100 }),
  ];
  const e = buildEligibility({
    arms, records: recs, nowMs: NOW,
    minQuality: { doer: -1, thinker: null, other: null }, outcomeGate: G, manual: {},
    roleOf, familyOf: (r) => (r.actualModel === 'x' ? '__proto__' : 'ok'),
    accountGroups: [groupsFor(arms)], roleBands: bands, trialRoles: ['doer', 'other'], minFleetArms: 1,
  });
  assert.equal({}.ok, undefined);
  assert.equal({}.gated, undefined);
  assert.ok(e.exclusions.doer.includes('arm:__proto__'));
  assert.ok(e.exclusions.doer.includes('__proto__'), 'the family is outcome-gated');
  assert.equal(e.report.arms.find(a => a.armId === 'ok-arm').eligible.doer.ok, true);
});

test('the outcome gate alone emptying a role gives back only the outcome gate, not the quality floor', () => {
  // Thinker role: quality floor 0 leaves only the two sonnet/opus arms; the
  // outcome gate then gates sonnet (worse than opus). Dropping both gates
  // would let the low-Q arms in; dropping just the outcome gate keeps them out.
  const arms = [arm('opus-max', 'opus', 1.2), arm('sonnet-max', 'sonnet', 0.9), arm('luna-low', 'luna', -1), arm('oss', 'oss', -1.7)];
  const recs = [
    ...many(15, { agentId: 'think-1', model: 'claude-sonnet-5-5', progress: 'noChange', seed: 0 }),
    ...many(15, { agentId: 'think-1', model: 'claude-opus-5-5', progress: 'progressed', seed: 100 }),
  ];
  const fam = (r) => (r.actualModel.includes('sonnet') ? 'sonnet' : 'opus');
  const base = {
    arms, records: recs, nowMs: NOW, minQuality: { doer: null, thinker: 0, other: null }, outcomeGate: G,
    manual: {}, roleOf, familyOf: fam, roleBands: bands, trialRoles: ['doer', 'other'], minFleetArms: 1,
  };
  // One account that serves only the sonnet and the luna arm: gating sonnet empties it.
  const accountGroups = [groupsFor([arms[1], arms[2]])];
  const e = buildEligibility({ ...base, accountGroups });
  assert.deepEqual(e.report.roles.thinker.suspendedGates, ['outcome']);
  assert.ok(e.exclusions.thinker.includes('arm:luna-low'), 'quality floor stays on');
  assert.ok(!e.exclusions.thinker.includes('sonnet'), 'outcome gate given back');
  assert.ok(e.report.warnings.some(w => w.code === 'role-empty-suspended' && w.gates.join() === 'outcome'));
  const sonnet = e.report.arms.find(a => a.armId === 'sonnet-max').eligible.thinker;
  assert.equal(sonnet.ok, true);
  assert.match(sonnet.reasons[0], /^suspended: outcome-gate/);
  // Quality alone emptying it gives back the quality floor.
  const only = buildEligibility({ ...base, records: [], accountGroups: [groupsFor([arms[2], arms[3]])] });
  assert.deepEqual(only.report.roles.thinker.suspendedGates, ['quality']);
});

test('future-dated records are not evidence', () => {
  const recs = [
    ...many(20, { progress: 'noChange', ageH: -5, seed: 0 }),
    ...many(20, { model: 'claude-sonnet-5-5', progress: 'progressed', seed: 100 }),
  ];
  assert.deepEqual(gate(recs).doer.gated, []);
});

test('lastRuns is never shorter than minRuns; the validator says so', () => {
  assert.equal(normalizeOutcomeGate({ minRuns: 12, lastRuns: 5 }).lastRuns, 12);
  assert.equal(normalizeOutcomeGate({ minRuns: 3, lastRuns: 40 }).lastRuns, 40);
  const g = gate(many(14, { progress: 'noChange' }).concat(many(14, { model: 'claude-sonnet-5-5', progress: 'progressed', seed: 50 })),
    normalizeOutcomeGate({ minRuns: 12, lastRuns: 5 }));
  assert.deepEqual(g.doer.gated, ['muse'], 'a too-short slice no longer disables the gate');
});
