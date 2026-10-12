import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/decide.mjs';
import { buildEligibility, normalizeMinQuality, DEFAULT_OUTCOME_GATE } from '../src/eligibility.mjs';

// The operator's list must yield when it alone would leave a role with no
// arm (single-provider fleets). Every role decides on every fleet shape.

const NOW = 1_750_000_000_000;
const bands = { thinker: { floorRung: 0, ceilingRung: null }, doer: { floorRung: 0, ceilingRung: null } };
const arm = (armId, family, qFleet, extra = {}) => ({
  armId, model: armId, effort: 'max', family, Q: qFleet, qFleet, qFleetThinker: extra.qFleetThinker ?? qFleet,
  C: 1, trial: false, contextWindow: 1000000, ...extra,
});
const groupsFor = (arms) => [{ rung: 0, arms }];
const roleOf = (id) => (id.startsWith('think') ? 'thinker' : id.startsWith('doer') ? 'doer' : 'other');
const familyOf = (r) => r.family;
const ROLES = ['doer', 'thinker', 'other'];
const LIVE_MANUAL = { doer: ['muse', 'oss'], thinker: ['muse', 'luna', 'sol', 'astra'], other: [] };

const META = [
  arm('muse-spark-1.1', 'muse', -0.2),
  arm('muse-spark-1.2', 'muse', 0.1, { qFleetThinker: 0.15 }),
  arm('muse-spark-1.3', 'muse', 0.35, { qFleetThinker: 0.32 }),
];
const CLAUDE = [
  arm('claude-opus-5-5', 'opus', 1.3, { qFleetThinker: 1.3 }),
  arm('claude-sonnet-5-5', 'sonnet', 0.9, { qFleetThinker: 0.9 }),
  arm('claude-haiku-4-5', 'haiku', 0.1, { qFleetThinker: -0.4 }),
];
const CODEX = [
  arm('gpt-6-1-sol', 'sol', 0.33, { qFleetThinker: 0.33 }),
  arm('gpt-6-astra', 'astra', 0.2, { qFleetThinker: 0.2 }),
  // Production marks oss as trial (not in PROVEN_FAMILIES), so thinkers
  // never run it; the fixture says so too.
  arm('gpt-oss-120b', 'oss', -1.75, { qFleetThinker: -1.75, trial: true }),
];

const build = (arms, overrides = {}) => buildEligibility({
  arms,
  records: [],
  nowMs: NOW,
  minQuality: normalizeMinQuality(undefined),
  outcomeGate: DEFAULT_OUTCOME_GATE,
  manual: LIVE_MANUAL,
  roleOf,
  familyOf,
  accountGroups: [groupsFor(arms), groupsFor(arms)],
  roleBands: bands,
  trialRoles: ['doer', 'other'],
  minFleetArms: 1,
  ...overrides,
});

const decideFor = (arms, role, exclusions) => decide({
  runId: `r-${role}`,
  agentId: `${role}-1`,
  role,
  ladderRungs: groupsFor(arms),
  pointer: 0,
  accountId: 'acct-1',
  fiveHourHeadroomPct: null,
  burnPerRunPct: {},
  roleBands: bands,
  trialRoles: ['doer', 'other'],
  excludedFamilies: exclusions,
});

const codes = (e) => e.report.warnings.map(w => w.code);

test('Meta-only fleet: doers and thinkers decide muse-spark-1.3, nothing defers', () => {
  const e = build(META);
  for (const role of ['doer', 'thinker']) {
    const d = decideFor(META, role, e.exclusions[role]);
    assert.notEqual(d.kind, 'defer', `${role} must not defer`);
    assert.equal(d.armId, 'muse-spark-1.3', `${role} picks the best muse arm`);
  }
});

test('Meta-only fleet: the operator muse ban is suspended, reported as manual-suspended', () => {
  const e = build(META);
  assert.deepEqual(e.report.roles.doer.suspendedManual, ['muse']);
  assert.deepEqual(e.report.roles.thinker.suspendedManual, ['muse']);
  assert.equal(e.report.roles.doer.suspended, true);
  const w = e.report.warnings.find(x => x.code === 'manual-suspended' && x.role === 'thinker');
  assert.ok(w, 'thinker gets a manual-suspended warning');
  assert.deepEqual(w.entries, ['muse']);
  assert.ok(codes(e).includes('manual-exclusions'));
});

test('Meta-only fleet: the thinker quality gate yields before the manual list does', () => {
  const e = build(META);
  const q = e.report.warnings.find(x => x.code === 'role-empty-suspended' && x.role === 'thinker');
  assert.deepEqual(q.gates, ['quality'], 'muse fails the 0.4 thinker minimum, so that gate yields');
  assert.deepEqual(codes(e).filter(c => c === 'manual-suspended').length, 2, 'doer and thinker');
});

test('Meta-only fleet: the report marks the muse arm as suspended, not blocked, for doers', () => {
  const e = build(META);
  const row = e.report.arms.find(a => a.armId === 'muse-spark-1.3');
  assert.equal(row.eligible.doer.ok, true);
  assert.ok(row.eligible.doer.reasons.includes('suspended: manual-exclusion: muse'));
});

test('Meta-only fleet with too few scored arms: no quality gate, manual still yields', () => {
  const e = build(META, { minFleetArms: 8 });
  assert.ok(codes(e).includes('fleet-too-small'));
  assert.equal(decideFor(META, 'doer', e.exclusions.doer).armId, 'muse-spark-1.3');
  assert.equal(decideFor(META, 'thinker', e.exclusions.thinker).armId, 'muse-spark-1.3');
});

test('Claude-only fleet: every role decides on Claude, no manual suspension', () => {
  const e = build(CLAUDE);
  for (const role of ROLES) {
    const d = decideFor(CLAUDE, role, e.exclusions[role]);
    assert.notEqual(d.kind, 'defer', `${role} must not defer`);
    assert.ok(d.armId.startsWith('claude-'), `${role} stays on a Claude arm`);
  }
  assert.ok(!codes(e).includes('manual-suspended'));
  assert.deepEqual(e.report.roles.thinker.suspendedManual, []);
});

test('Codex-only fleet: thinkers lift sol with the quality floor suspended (oss is trial-only)', () => {
  // gpt-oss-120b is trial in production, so thinkers cannot run it. The
  // thinker list (muse, luna, sol, astra) plus the 0.4 quality floor leave
  // the role empty, so the minimal lift restores sol and suspends quality.
  const e = build(CODEX);
  const d = decideFor(CODEX, 'thinker', e.exclusions.thinker);
  assert.notEqual(d.kind, 'defer');
  assert.equal(d.armId, 'gpt-6-1-sol');
  assert.deepEqual(e.report.roles.thinker.suspendedManual, ['sol']);
  assert.deepEqual(e.report.roles.thinker.suspendedGates, ['quality']);
});

test('hypothetical non-trial weak arm: the quality gate yields before the operator list (cascade order)', () => {
  // A serving non-trial arm below the floor is a data-gate problem, not a
  // list problem: quality yields and the list holds.
  const arms = [
    arm('weak-low', 'weak', -1.75, { qFleetThinker: -1.75 }),
    arm('gpt-6-1-sol', 'sol', 0.33, { qFleetThinker: 0.33 }),
  ];
  const e = build(arms, { manual: { doer: [], thinker: ['sol'], other: [] } });
  const d = decideFor(arms, 'thinker', e.exclusions.thinker);
  assert.notEqual(d.kind, 'defer');
  assert.equal(d.armId, 'weak-low');
  assert.deepEqual(e.report.roles.thinker.suspendedManual, []);
  assert.deepEqual(e.report.roles.thinker.suspendedGates, ['quality']);
});

test('Codex-only fleet: doers keep the manual oss ban and decide on sol', () => {
  const e = build(CODEX);
  const d = decideFor(CODEX, 'doer', e.exclusions.doer);
  assert.notEqual(d.kind, 'defer');
  assert.equal(d.armId, 'gpt-6-1-sol');
  assert.deepEqual(e.report.roles.doer.suspendedManual, [], 'doers never needed the list to yield');
  assert.ok(e.exclusions.doer.includes('oss'), 'the oss ban holds');
});

test('mixed fleet: a live Claude arm means no manual suspension for any role', () => {
  const mixed = [...CLAUDE, ...META, ...CODEX];
  const e = build(mixed);
  for (const role of ROLES) {
    const d = decideFor(mixed, role, e.exclusions[role]);
    assert.notEqual(d.kind, 'defer', `${role} must not defer`);
  }
  assert.equal(decideFor(mixed, 'doer', e.exclusions.doer).armId.startsWith('claude-'), true);
  assert.equal(decideFor(mixed, 'thinker', e.exclusions.thinker).armId, 'claude-opus-5-5');
  assert.ok(!codes(e).includes('manual-suspended'));
});

test('strongest banned family lifts first when the list alone empties a role', () => {
  const arms = [arm('muse-spark-1.3', 'muse', 0.35), arm('gpt-oss-120b', 'oss', -1.75)];
  const e = build(arms, { manual: { doer: ['oss', 'muse'], thinker: [], other: [] } });
  assert.deepEqual(e.report.roles.doer.suspendedManual, ['muse'], 'muse outranks oss, so only muse lifts');
  assert.equal(decideFor(arms, 'doer', e.exclusions.doer).armId, 'muse-spark-1.3');
});

test('an arm-token entry in the list is suspended like a family entry', () => {
  const arms = [arm('gpt-6-1-sol-xhigh', 'sol', 0.33, { qFleetThinker: 0.33 })];
  const e = build(arms, { manual: { doer: [], thinker: ['arm:gpt-6-1-sol-xhigh'], other: [] } });
  assert.deepEqual(e.report.roles.thinker.suspendedManual, ['arm:gpt-6-1-sol-xhigh']);
  assert.equal(decideFor(arms, 'thinker', e.exclusions.thinker).armId, 'gpt-6-1-sol-xhigh');
  const row = e.report.arms.find(a => a.armId === 'gpt-6-1-sol-xhigh');
  assert.equal(row.eligible.thinker.ok, true);
});

test('no arm for a role at all: nothing is suspended and the role stays empty', () => {
  const e = build(CLAUDE, { accountGroups: [], manual: { doer: ['muse'], thinker: [], other: [] } });
  assert.deepEqual(e.exclusions.doer, ['muse']);
  assert.deepEqual(e.report.roles.doer.suspendedManual, []);
  assert.ok(!codes(e).includes('manual-suspended'));
});

test('a lift keeps the quality floor: only the banned family that serves is restored', () => {
  const arms = [arm('muse-weak', 'muse', -1.5), arm('muse-mid', 'muse', -0.2), arm('muse-top', 'muse', 0.35)];
  const e = build(arms, { manual: { doer: ['muse'], thinker: [], other: [] } });
  assert.deepEqual(e.report.roles.doer.suspendedManual, ['muse']);
  assert.deepEqual(e.report.roles.doer.suspendedGates, [], 'the quality floor still holds');
  assert.deepEqual(e.exclusions.doer, ['arm:muse-weak']);
  assert.equal(decideFor(arms, 'doer', e.exclusions.doer).armId, 'muse-top');
  assert.ok(!e.report.warnings.some(w => w.code === 'role-empty-suspended' && w.role === 'doer'));
});

test('equal-size lifts tie-break on data gates first: the lift that keeps the floor wins', () => {
  const solUnhealthy = arm('gpt-6-1-sol-xhigh', 'sol', 0.9);
  const solLow = arm('gpt-6-1-sol-low', 'sol', -1.5);
  const lunaHigh = arm('luna-high', 'luna', -0.2);
  const e = build([solUnhealthy, solLow, lunaHigh], {
    manual: { doer: ['sol', 'luna'], thinker: [], other: [] },
    accountGroups: [groupsFor([solLow, lunaHigh])],
  });
  assert.deepEqual(e.report.roles.doer.suspendedManual, ['luna']);
  assert.deepEqual(e.report.roles.doer.suspendedGates, [], 'lifting sol would have dropped the floor');
  assert.equal(decideFor([solLow, lunaHigh], 'doer', e.exclusions.doer).armId, 'luna-high');
});

test('an entry whose only arms are on a lane with no healthy account is not lifted', () => {
  const sol = arm('gpt-6-1-sol', 'sol', 0.9);
  const e = build([sol, ...META], {
    manual: { doer: ['sol', 'muse'], thinker: [], other: [] },
    accountGroups: [groupsFor(META)],
  });
  assert.deepEqual(e.report.roles.doer.suspendedManual, ['muse'], 'sol cannot serve, so only muse lifts');
  assert.ok(e.exclusions.doer.includes('sol'));
  assert.equal(decideFor(META, 'doer', e.exclusions.doer).armId, 'muse-spark-1.3');
});

test('an entry outside the role rung window is not lifted', () => {
  const floorRung = 2;
  const roleBands = { ...bands, thinker: { floorRung, ceilingRung: null } };
  const muse = arm('muse-spark-1.3', 'muse', 0.9, { qFleetThinker: 0.9 });
  const sol = arm('gpt-6-1-sol', 'sol', 0.5, { qFleetThinker: 0.5 });
  const ladder = [{ rung: 0, arms: [muse] }, { rung: 1, arms: [] }, { rung: 2, arms: [sol] }];
  const e = buildEligibility({
    arms: [muse, sol], records: [], nowMs: NOW, minQuality: normalizeMinQuality(undefined),
    outcomeGate: DEFAULT_OUTCOME_GATE, manual: { doer: [], thinker: ['muse', 'sol'], other: [] },
    roleOf, familyOf, accountGroups: [ladder], roleBands, trialRoles: ['doer', 'other'], minFleetArms: 1,
  });
  assert.deepEqual(e.report.roles.thinker.suspendedManual, ['sol']);
  const d = decide({
    runId: 'r-thinker', agentId: 'thinker-1', role: 'thinker', ladderRungs: ladder, pointer: 0,
    accountId: 'acct-1', fiveHourHeadroomPct: null, burnPerRunPct: {}, roleBands, trialRoles: ['doer', 'other'],
    excludedFamilies: e.exclusions.thinker,
  });
  assert.equal(d.armId, 'gpt-6-1-sol');
});

test('an unhealthy lane never lifts the operator ban: the role defers until the lane recovers', () => {
  // Structural emptiness only: the fleet-wide arm set still holds a
  // non-banned Claude arm fitting the role window and trial rules, so the
  // ban holds while the lane is down and the role defers (the old behavior).
  const fleet = [...CLAUDE, ...META];
  const manual = { doer: ['muse'], thinker: [], other: [] };
  const structuralGroups = [groupsFor(CLAUDE), groupsFor(META)];
  const healthy = build(fleet, { manual, accountGroups: [groupsFor(CLAUDE), groupsFor(META)], structuralGroups });
  assert.deepEqual(healthy.report.roles.doer.suspendedManual, []);
  assert.deepEqual(healthy.exclusions.doer, ['muse']);
  assert.ok(decideFor(CLAUDE, 'doer', healthy.exclusions.doer).armId.startsWith('claude-'));
  const degraded = build(fleet, { manual, accountGroups: [groupsFor(META)], structuralGroups });
  assert.deepEqual(degraded.report.roles.doer.suspendedManual, [], 'the ban holds during the outage');
  assert.ok(degraded.exclusions.doer.includes('muse'));
  assert.equal(decideFor(META, 'doer', degraded.exclusions.doer).kind, 'defer');
});

test('structural emptiness ignores the data gates: a quality-gated non-banned arm holds the ban when its lane drops', () => {
  // The thinker list bans muse; the only non-banned arm (Claude haiku)
  // sits below the thinker quality floor. The list does not empty the
  // role -- the data gates yield for that -- so the ban must hold even
  // when the Claude lane drops out of the healthy set and the role defers.
  const haiku = arm('claude-haiku-4-5', 'haiku', 0.1, { qFleetThinker: -0.4 });
  const muse = arm('muse-spark-1.3', 'muse', 0.35, { qFleetThinker: 0.32 });
  const manual = { doer: [], thinker: ['muse'], other: [] };
  const structuralGroups = [groupsFor([haiku]), groupsFor([muse])];
  const healthy = build([haiku, muse], { manual, accountGroups: structuralGroups, structuralGroups });
  assert.deepEqual(healthy.report.roles.thinker.suspendedManual, [], 'the ban holds; quality yields for haiku');
  assert.deepEqual(healthy.report.roles.thinker.suspendedGates, ['quality']);
  const degraded = build([haiku, muse], { manual, accountGroups: [groupsFor([muse])], structuralGroups });
  assert.deepEqual(degraded.report.roles.thinker.suspendedManual, [], 'the ban still holds; the role defers');
  assert.ok(degraded.exclusions.thinker.includes('muse'));
});
