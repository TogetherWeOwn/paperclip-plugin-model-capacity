import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEligibility, DEFAULT_OUTCOME_GATE } from '../src/eligibility.mjs';
import * as decision from '../src/decide.mjs';
import { fallbackSeatCandidate } from '../src/plugin.mjs';

const bands = { doer: { floorRung: 0, ceilingRung: null }, thinker: { floorRung: 0, ceilingRung: null } };
const arms = [
  { armId: 'strong', family: 'strong', qFleet: 0.4 },
  { armId: 'old', family: 'sonnet', qFleet: -0.1 },
  { armId: 'new', family: 'sonnet', qFleet: -0.2 },
  { armId: 'floor', family: 'floor', qFleet: -0.5 },
  { armId: 'below', family: 'below', qFleet: -0.51 },
  { armId: 'blank', family: 'blank', qFleet: null },
];
const groups = [{ rung: 0, arms: arms.map(a => ({ ...a, Q: a.qFleet, C: 1 })) }];
const cfg = { enabled: true, roles: ['doer', 'other'], minQuality: -0.5 };
const base = { arms, records: [], nowMs: 1, minQuality: { doer: 0.12, other: 0.17, thinker: 0.4 },
  minFleetArms: 1, outcomeGate: { ...DEFAULT_OUTCOME_GATE, enabled: false }, manual: {},
  roleOf: () => 'doer', familyOf: () => 'sonnet', accountGroups: [groups], roleBands: bands,
  trialRoles: ['doer', 'other'], accountCandidates: {
    weak: [arms[1], arms[2]], strong: [arms[0], arms[1]], floor: [arms[3]],
    below: [arms[4]], blank: [arms[5]],
  }, supersededByAccount: {} };
const build = (extra = {}) => buildEligibility({ ...base, accountFallback: cfg, ...extra });

test('disabled fallback preserves every eligibility key and value', () => {
  const original = buildEligibility(base);
  assert.deepEqual(build({ accountFallback: { ...cfg, enabled: false } }), original);
  assert.equal('accountAdmissions' in original, false);
  assert.equal('accountFallback' in original.report, false);
});

test('weak accounts admit the best finite arm at the floor; strong and unscored accounts do not', () => {
  const e = build();
  assert.equal(e.accountAdmissions.doer.weak.armId, 'old');
  assert.equal(e.accountAdmissions.doer.floor.armId, 'floor');
  assert.equal(e.accountAdmissions.doer.strong, undefined);
  assert.equal(e.accountAdmissions.doer.below, undefined);
  assert.equal(e.accountAdmissions.doer.blank, undefined);
  assert.equal(e.accountAdmissions.thinker, undefined);
  assert.deepEqual(e.exclusions, buildEligibility(base).exclusions);
});

test('fallback does not lift a task-evidence failure with finite quality above the fallback floor', () => {
  const untrusted = { ...arms[1], roleTrusted: { doer: false } };
  const input = { arms: arms.map(a => a.armId === untrusted.armId ? untrusted : a), accountCandidates: { weak: [untrusted] } };
  const e = build(input);
  assert.equal(e.report.roles.doer.suspended, false);
  assert.equal(e.report.arms.find(a => a.armId === 'old').eligible.doer.reasons.includes('task-evidence-admission'), true);
  assert.equal(e.accountAdmissions.doer.weak, undefined);
  assert.equal(e.report.accountFallback.admitted.some(a => a.role === 'doer' && a.accountId === 'weak'), false);
  assert.equal(build({ accountCandidates: { weak: [arms[1]] } }).accountAdmissions.doer.weak.armId, 'old');
});

test('fallback rejects thinker even when an unnormalized roles list requests it', () => {
  const e = build({ accountFallback: { ...cfg, roles: ['thinker', 'doer'] }, accountCandidates: { weak: [arms[1]] } });
  assert.equal(e.accountAdmissions.doer.weak.armId, 'old');
  assert.equal(Object.hasOwn(e.accountAdmissions, 'thinker'), false);
  assert.equal(e.report.accountFallback.admitted.some(a => a.role === 'thinker'), false);
});

test('supersession removes candidates from both passing and fallback pools', () => {
  const updatedArms = arms.map(a => a.armId === 'old' ? { ...a, qFleet: 0.14 } : a);
  const candidates = { weak: [updatedArms[1], updatedArms[2]] };
  assert.equal(build({ arms: updatedArms, accountCandidates: candidates, supersededByAccount: { weak: ['old'] } }).accountAdmissions.doer.weak.armId, 'new');
  assert.equal(build({ arms: updatedArms, accountCandidates: candidates }).accountAdmissions.other.weak.armId, 'old');
  assert.equal(build({ arms: updatedArms, accountCandidates: candidates }).accountAdmissions.doer.weak, undefined);
});

test('manual and active outcome gates cannot be relaxed by fallback', () => {
  const manual = build({ manual: { doer: ['sonnet', 'arm:floor'] } });
  assert.equal(manual.accountAdmissions.doer.weak, undefined);
  assert.equal(manual.accountAdmissions.doer.floor, undefined);
  const records = [
    ...Array.from({ length: 12 }, (_, i) => ({ runId: `a${i}`, agentId: 'a', status: 'finished', actualModel: 'sonnet', progress: 'noChange', terminalAt: 1 })),
    ...Array.from({ length: 12 }, (_, i) => ({ runId: `b${i}`, agentId: 'a', status: 'finished', actualModel: 'strong', progress: 'progressed', terminalAt: 1 })),
  ];
  const withStrongSibling = [...arms, { armId: 'sonnet-strong', family: 'sonnet', qFleet: 0.3 }];
  const e = build({ arms: withStrongSibling, records, outcomeGate: DEFAULT_OUTCOME_GATE, familyOf: r => r.actualModel });
  assert.ok(e.report.roles.doer.outcome.gated.includes('sonnet'));
  assert.equal(e.accountAdmissions.doer.weak, undefined);
});

test('suspended gate and enforce mode never admit; shadow mode admits', () => {
  const suspended = build({ accountGroups: [[{ rung: 0, arms: [groups[0].arms[1]] }]] });
  assert.equal(suspended.report.roles.doer.suspended, true);
  assert.deepEqual(suspended.accountAdmissions.doer, {});
  const enforce = build({ mode: 'enforce' });
  assert.equal(enforce.report.accountFallback.supported, false);
  assert.deepEqual(enforce.accountAdmissions, {});
  assert.equal(enforce.report.warnings.filter(w => w.code === 'account-fallback-enforce-unsupported').length, 1);
  assert.equal(build({ mode: 'shadow' }).accountAdmissions.doer.weak.armId, 'old');
});

test('resolver removes only the admitted arm token on a copy and fails closed', () => {
  const resolve = decision.resolveAccountInputs;
  assert.equal(typeof resolve, 'function');
  const exclusions = ['sonnet', 'arm:old', 'arm:new'];
  const admissions = { doer: { weak: { armId: 'old' } } };
  const result = resolve(exclusions, admissions, bands, 'doer', 'weak');
  assert.deepEqual(result.excludedFamilies, ['sonnet', 'arm:new']);
  assert.deepEqual(exclusions, ['sonnet', 'arm:old', 'arm:new']);
  assert.deepEqual(result.fallbackAdmission, { armId: 'old', band: bands.doer, supersessionView: null, newestEnabled: false });
  for (const [account, opts] of [['strong', {}], ['weak', { suppressAccountFallback: true }], ['weak', { newestEnabled: true }]]) {
    const none = resolve(exclusions, admissions, bands, 'doer', account, opts);
    assert.equal(none.excludedFamilies, exclusions);
    assert.equal(none.fallbackAdmission, null);
  }
});


test('X-T02a: superseded weak candidate cannot re-enter the fallback pool', () => {
  const e = build({ accountCandidates: { weak: [arms[1], arms[2]] }, supersededByAccount: { weak: ['old'] } });
  assert.equal(e.accountAdmissions.doer.weak.armId, 'new');
});

test('equal quality candidates select lexical armId regardless of input order', () => {
  const tied = [{ armId: 'tie-b', family: 'b', qFleet: -0.1 }, { armId: 'tie-a', family: 'a', qFleet: -0.1 }];
  const e = build({ arms: [...arms, ...tied], accountCandidates: { weak: tied } });
  assert.equal(e.accountAdmissions.doer.weak.armId, 'tie-a');
});

test('fallback reports and admission maps are sorted by role and account', () => {
  const e = build({ accountFallback: { ...cfg, roles: ['other', 'doer'] }, accountCandidates: { 'z-acct': [arms[1]], 'a-acct': [arms[2]] } });
  assert.deepEqual(e.report.accountFallback.admitted.map(({ role, accountId }) => [role, accountId]), [
    ['doer', 'a-acct'], ['doer', 'z-acct'], ['other', 'a-acct'], ['other', 'z-acct'],
  ]);
  assert.deepEqual(Object.keys(e.accountAdmissions), ['doer', 'other']);
  assert.deepEqual(Object.keys(e.accountAdmissions.doer), ['a-acct', 'z-acct']);
});

test('resolver uses the thinker band for a thinker admission', () => {
  const admissions = { thinker: { weak: { armId: 'old' } } };
  const roleBands = { doer: { floorRung: 1, ceilingRung: 2 }, thinker: { floorRung: 3, ceilingRung: 5 } };
  assert.deepEqual(decision.resolveAccountInputs([], admissions, roleBands, 'thinker', 'weak').fallbackAdmission.band, roleBands.thinker);
});

test('resolver uses doer band for other and the default doer band when missing', () => {
  const admissions = { other: { weak: { armId: 'old' } }, doer: { weak: { armId: 'old' } } };
  const resolve = decision.resolveAccountInputs;
  const customBands = { doer: { floorRung: 3, ceilingRung: 5 } };
  assert.deepEqual(resolve([], admissions, customBands, 'other', 'weak').fallbackAdmission.band, customBands.doer);
  for (const roleBands of [undefined, {}]) {
    for (const role of ['doer', 'other']) {
      assert.deepEqual(resolve([], admissions, roleBands, role, 'weak').fallbackAdmission.band, { floorRung: 0, ceilingRung: null });
    }
  }
});

test('X-T02(b,d): superseded passer cannot make the weak account strong; newest-off admits old', () => {
  const passingOld = { ...arms[1], qFleet: 0.14 };
  const pool = { weak: [passingOld, arms[2]] };
  const updated = arms.map(arm => arm.armId === 'old' ? passingOld : arm);
  const on = build({ arms: updated, accountCandidates: pool, supersededByAccount: { weak: ['old'] } });
  assert.equal(on.accountAdmissions.doer.weak.armId, 'new');
  const offPasser = build({ arms: updated, accountCandidates: pool, supersededByAccount: {} });
  assert.equal(offPasser.accountAdmissions.doer.weak, undefined);
  const offWeak = build({ accountCandidates: { weak: [arms[1], arms[2]] }, supersededByAccount: {} });
  assert.equal(offWeak.accountAdmissions.doer.weak.armId, 'old');
});

test('F-T16: live-shaped Antigravity pool admits its best-Q seatable flash arm', () => {
  const candidates = [
    { armId: 'gemini-3.8-flash-high', family: 'gemini-flash', qFleet: -0.4 },
    { armId: 'gemini-3.1-pro-low', family: 'gemini-pro', qFleet: -0.83 },
    { armId: 'gemini-3.5-flash-lite', family: 'gemini-lite', qFleet: -1.41 },
  ];
  const e = build({ arms: [arms[0], ...candidates], accountCandidates: { weak: candidates },
    accountFallback: { ...cfg, minQuality: -1.5 } });
  const admission = e.accountAdmissions.doer.weak;
  assert.equal(admission.armId, 'gemini-3.8-flash-high');
  assert.deepEqual(e.report.accountFallback.admitted.filter(row => row.accountId === 'weak' && row.role === 'doer').map(row => row.armId), ['gemini-3.8-flash-high']);
  const local = candidates.map(a => ({ ...a, model: a.armId, Q: a.qFleet, C: 1 }));
  const ranking = { candidates: local, rankingRungs: [{ armId: local[0].armId, rung: 0, Q: local[0].Q, C: 1 }], excludedArmIds: [] };
  assert.equal(fallbackSeatCandidate(ranking, admission.armId, 1, false).candidate.armId, admission.armId);
});
