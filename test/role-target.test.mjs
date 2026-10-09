import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, roleRungWindow, roleLadderAccess } from '../src/decide.mjs';
import { computeConcurrencyTarget, roleDemandBound } from '../src/concurrency.mjs';

// Per-role target: the target counts only capacity the roles can use.
// Live evidence (12:37Z): target ~20 of which ~9 slots came from a lane that
// offers only gpt-oss (doers exclude oss; oss is a trial family thinkers
// never take) and ~6.7 from Meta (thinkers exclude it).

const arm = (armId, family, { trial = false, Q = 1 } = {}) =>
  ({ armId, model: armId, effort: 'max', family, Q, C: 1, trial, contextWindow: 1000000 });
const bands = {
  thinker: { floorRung: 2, ceilingRung: null },
  doer: { floorRung: 0, ceilingRung: null },
};

test('roleRungWindow clamps floor/ceiling to the ladder like decide()', () => {
  assert.deepEqual(roleRungWindow({ floorRung: 2, ceilingRung: null }, 3), { topRung: 2, floor: 2, ceiling: 2 });
  assert.deepEqual(roleRungWindow({ floorRung: 2, ceilingRung: null }, 1), { topRung: 0, floor: 0, ceiling: 0 });
  assert.deepEqual(roleRungWindow({ floorRung: 0, ceilingRung: 1 }, 4), { topRung: 3, floor: 0, ceiling: 1 });
  assert.deepEqual(roleRungWindow({}, 0), { topRung: 0, floor: 0, ceiling: 0 });
});

test('thinker floor rung hides arms below it', () => {
  const rungs = [
    { rung: 0, arms: [arm('haiku', 'haiku')] },
    { rung: 1, arms: [arm('sonnet', 'sonnet')] },
    { rung: 2, arms: [arm('opus', 'opus')] },
  ];
  assert.deepEqual(roleLadderAccess(rungs, { role: 'thinker', roleBands: bands }), { eligible: true, trialOnly: false });
  // The same account with its top rung excluded leaves nothing at or above
  // the thinker floor, though it still has arms for a doer.
  const noTop = { role: 'thinker', roleBands: bands, excludedFamilies: ['opus'] };
  assert.equal(roleLadderAccess(rungs, noTop).eligible, false);
  assert.equal(roleLadderAccess(rungs, { ...noTop, role: 'doer' }).eligible, true);
});

test('a role ceiling hides arms above it', () => {
  const rungs = [
    { rung: 0, arms: [arm('haiku', 'haiku')] },
    { rung: 1, arms: [arm('opus', 'opus')] },
  ];
  const capped = { doer: { floorRung: 0, ceilingRung: 0 }, thinker: { floorRung: 1, ceilingRung: 1 } };
  assert.equal(roleLadderAccess(rungs, { role: 'doer', roleBands: capped, excludedFamilies: ['haiku'] }).eligible, false);
  assert.equal(roleLadderAccess(rungs, { role: 'thinker', roleBands: capped, excludedFamilies: ['opus'] }).eligible, false);
});

test('trial-only ladders: eligible only for trial roles, flagged trialOnly', () => {
  const oss = [{ rung: 0, arms: [arm('gpt-oss', 'oss', { trial: true })] }];
  const opts = { roleBands: bands, trialRoles: ['doer', 'other'] };
  assert.deepEqual(roleLadderAccess(oss, { ...opts, role: 'doer' }), { eligible: true, trialOnly: true });
  assert.deepEqual(roleLadderAccess(oss, { ...opts, role: 'thinker' }), { eligible: false, trialOnly: false });
  // Doers exclude oss in production: nothing left for anyone.
  assert.equal(roleLadderAccess(oss, { ...opts, role: 'doer', excludedFamilies: ['oss'] }).eligible, false);
});

test('access agrees with decide(): eligible means decide() can pick an arm with ample headroom', () => {
  const ladders = [
    [{ rung: 0, arms: [arm('muse', 'muse')] }],
    [{ rung: 0, arms: [arm('gpt-oss', 'oss', { trial: true })] }],
    [{ rung: 0, arms: [arm('haiku', 'haiku')] }, { rung: 1, arms: [arm('sonnet', 'sonnet')] }, { rung: 2, arms: [arm('opus', 'opus')] }],
  ];
  const exclusions = [[], ['muse'], ['oss'], ['opus'], ['haiku', 'sonnet']];
  for (const rungs of ladders) {
    for (const role of ['doer', 'thinker', 'other']) {
      for (const excludedFamilies of exclusions) {
        const access = roleLadderAccess(rungs, { role, roleBands: bands, excludedFamilies, trialRoles: ['doer', 'other'] });
        const burn = Object.fromEntries(rungs.flatMap(g => g.arms).map(a => [a.armId, 0.0005]));
        const d = decide({
          runId: 'r', agentId: 'a', role, ladderRungs: rungs, excludedFamilies,
          pointer: rungs.length - 1, fiveHourHeadroomPct: 0.9, burnPerRunPct: burn, reservePct: 0.05,
          accountId: 'x', roleBands: bands, adapterType: 'claude_local',
          trialAdapters: { claude_local: ['*'] }, trialBudget: { oss: 2 }, trialRoles: ['doer', 'other'],
        });
        assert.equal(d.kind === 'decide', access.eligible,
          `${JSON.stringify(rungs.map(g => g.arms.map(a => a.family)))} role=${role} excl=${excludedFamilies}`);
      }
    }
  }
});

const acct = (accountId, extra = {}) => ({
  accountId, remainingPct: 0.5, hoursToReset: 100, burnPerRunPct: 0.001, measuredBurnPerRunPct: 0.001,
  guardActive: false, healthy: true, ...extra,
});
const access = (doer, thinker, other = { eligible: false, trialOnly: false }) => ({ doer, thinker, other });
const yes = { eligible: true, trialOnly: false };
const no = { eligible: false, trialOnly: false };
const trial = { eligible: true, trialOnly: true };

test('ineligible capacity adds nothing: only accounts a role can use count for it', () => {
  // Each account is worth 0.5/100/0.001*0.186 = 0.93 slots.
  const out = computeConcurrencyTarget({
    accounts: [acct('claude'), acct('meta'), acct('ag')],
    meanRunDurationHours: 0.186, maxTotal: 75,
    roleAccess: { claude: access(yes, yes), meta: access(yes, no), ag: access(no, no) },
    roleDemand: { doer: 10, thinker: 0, other: 0 },
  });
  assert.ok(Math.abs(out.target - 2 * 0.93) < 1e-9, `target ${out.target}`);
  assert.equal(out.perAccount.find(a => a.accountId === 'ag').usableSlots, 0);
  assert.equal(out.roles.doer.accounts, 2);
  assert.equal(out.roles.thinker.accounts, 1);
  assert.ok(out.slotsTotal > out.raw, 'raw quota capacity stays visible next to the usable target');
});

test('the capacity target ignores the queue; the demand bound follows it', () => {
  const accounts = [acct('claude'), acct('meta')];
  const roleAccess = { claude: access(yes, yes), meta: access(yes, no) };
  const slot = 0.93;
  const run = (roleDemand) => computeConcurrencyTarget({ accounts, roleAccess, roleDemand });
  const doerOnly = run({ doer: 5, thinker: 0, other: 0 });
  const thinkerOnly = run({ doer: 0, thinker: 5, other: 0 });
  const mixed = run({ doer: 3, thinker: 1, other: 0 });
  const idle = run({ doer: 0, thinker: 0, other: 0 });
  for (const out of [doerOnly, thinkerOnly, mixed, idle]) {
    assert.ok(Math.abs(out.target - 2 * slot) < 1e-9, 'every account some role can use counts, whatever the queue');
  }
  // Deep queues: both bounds are what the roles can reach. Thinkers cannot
  // use Meta; doers can use both.
  const deep = (d, t) => run({ doer: d, thinker: t, other: 0 }).demandBound;
  assert.ok(Math.abs(deep(50, 0) - 2 * slot) < 1e-9);
  assert.ok(Math.abs(deep(0, 50) - slot) < 1e-9, 'Meta is invisible to thinkers');
  assert.ok(Math.abs(deep(50, 50) - 2 * slot) < 1e-9);
  // 3 doers : 1 thinker queued is short of the 1.86 slots: bounded by the queue.
  assert.ok(Math.abs(mixed.demandBound - Math.min(4, 2 * slot)) < 1e-9);
  assert.equal(idle.demandBound, null, 'no queued work: the bound is not applied');
  assert.equal(computeConcurrencyTarget({ accounts, roleAccess }).demandBound, null, 'absent demand: not applied');
});

// Paperclip Review: two role-exclusive pools under deep queues both run
// full, so the target must read the sum, not the other role's queue share.
test('role-exclusive pools under deep queues are not discounted by the other role queue', () => {
  // 9.3 slots each: a doer-only and a thinker-only pool.
  const accounts = [acct('d1', { hoursToReset: 10 }), acct('t1', { hoursToReset: 10 })];
  const roleAccess = { d1: access(yes, no), t1: access(no, yes) };
  const run = (doer, thinker) => computeConcurrencyTarget({ accounts, roleAccess, roleDemand: { doer, thinker, other: 0 } });
  for (const [d, t] of [[50, 50], [90, 10], [10, 90], [30, 30]]) {
    const out = run(d, t);
    assert.ok(Math.abs(out.target - 18.6) < 1e-9, `${d}/${t} target ${out.target}`);
    assert.ok(Math.abs(out.demandBound - 18.6) < 1e-9, `${d}/${t} bound ${out.demandBound}`);
  }
  // A role with nothing queued cannot fill its pool; a thin queue fills part.
  assert.ok(Math.abs(run(100, 0).demandBound - 9.3) < 1e-9);
  assert.ok(Math.abs(run(100, 1).demandBound - 10.3) < 1e-9);
  assert.ok(Math.abs(run(100, 1).target - 18.6) < 1e-9, 'the capacity target itself does not follow the queue');
  // The idle / unreadable prior counts every account some role can use.
  const shared = [acct('s1', { hoursToReset: 10 }), acct('d1', { hoursToReset: 10 })];
  const idle = computeConcurrencyTarget({
    accounts: shared,
    roleAccess: { s1: access(yes, yes), d1: access(yes, no, yes) },
    roleDemand: { doer: 0, thinker: 0, other: 0 },
  });
  assert.ok(Math.abs(idle.target - 18.6) < 1e-9, `idle ${idle.target}`);
  assert.equal(idle.demandBound, null);
});

test('roleDemandBound: a shared pool fills the other roles after exclusive demand', () => {
  const row = (slots, eligibleRoles) => ({ usableSlots: slots, eligibleRoles });
  const rows = [row(9, ['doer']), row(9, ['doer', 'thinker'])];
  // Doers can take the shared pool too; thinkers only the shared one.
  assert.equal(roleDemandBound(rows, { doer: 5, thinker: 5, other: 0 }), 10);
  // Thinkers take 5 of the shared pool; doers fill their own 9 plus the other 4.
  assert.equal(roleDemandBound(rows, { doer: 100, thinker: 5, other: 0 }), 18);
  assert.equal(roleDemandBound(rows, { doer: 3, thinker: 100, other: 0 }), 12);
  assert.equal(roleDemandBound(rows, { doer: 100, thinker: 100, other: 0 }), 18);
  assert.equal(roleDemandBound(rows, { doer: 0, thinker: 100, other: 0 }), 9, 'thinkers reach only the shared pool');
  assert.equal(roleDemandBound(rows, { doer: 0, thinker: 0, other: 0 }), 0);
  // An account no role can use adds nothing; the demand factor scales capacity.
  assert.equal(roleDemandBound([row(9, [])], { doer: 5, thinker: 5, other: 5 }), 0);
  assert.equal(roleDemandBound(rows, { doer: 100, thinker: 100, other: 0 }, 0.5), 9);
});

test('no role access map keeps the legacy sum', () => {
  const accounts = [acct('a'), acct('b')];
  const out = computeConcurrencyTarget({ accounts, meanRunDurationHours: 0.186 });
  assert.ok(Math.abs(out.target - 2 * 0.93) < 1e-9);
});

test('trial-only accounts are clipped to the trial cap', () => {
  // 8 slots of quota on a lane only trial arms can use: at most the trial
  // in-flight cap is sustainable.
  const out = computeConcurrencyTarget({
    accounts: [acct('claude'), acct('ag', { remainingPct: 1, hoursToReset: 10, measuredBurnPerRunPct: null, burnPerRunPct: 0.00025 })],
    roleAccess: { claude: access(yes, yes), ag: access(trial, no, trial) },
    roleDemand: { doer: 4, thinker: 0, other: 0 },
    trialSlotCap: 2, meanRunDurationHours: 0.186,
  });
  const ag = out.perAccount.find(a => a.accountId === 'ag');
  assert.equal(ag.trialOnly, true);
  assert.ok(ag.usableSlots <= 2 + 1e-9, `trial-only usable ${ag.usableSlots}`);
});

test('anchor-fallback slots are floored at the median measured burn', () => {
  // Measured peers burn 0.002/run. The anchor lane guesses 0.00025 (8x
  // cheaper), which uncapped would mint 8x the slots of an identical
  // measured account.
  const measured = (id, e) => acct(id, { measuredBurnPerRunPct: e, burnPerRunPct: e });
  const anchor = acct('guess', { measuredBurnPerRunPct: null, burnPerRunPct: 0.00025 });
  const out = computeConcurrencyTarget({
    accounts: [measured('m1', 0.002), measured('m2', 0.002), measured('m3', 0.01), anchor],
    meanRunDurationHours: 0.186,
  });
  assert.equal(out.medianMeasuredBurnPct, 0.002);
  const g = out.perAccount.find(a => a.accountId === 'guess');
  const m1 = out.perAccount.find(a => a.accountId === 'm1');
  assert.equal(g.anchorCapped, true);
  assert.equal(g.reason, 'anchor-fallback');
  assert.ok(Math.abs(g.slots - m1.slots) < 1e-9, 'capped anchor equals one median-burn account');
  // An anchor already above the median is left alone (it is conservative).
  const high = computeConcurrencyTarget({
    accounts: [measured('m1', 0.002), acct('g2', { measuredBurnPerRunPct: null, burnPerRunPct: 0.02 })],
    meanRunDurationHours: 0.186,
  });
  assert.equal(high.perAccount.find(a => a.accountId === 'g2').anchorCapped, false);
});

test('median is taken over distinct calibration groups, not accounts', () => {
  // Eight Meta lanes share one E; they must not outvote the two others.
  const lane = (n) => acct(`meta:${n}`, { measuredBurnPerRunPct: 0.01, calibrationGroup: 'meta' });
  const lanes = Array.from({ length: 8 }, (_, i) => lane(i));
  const out = computeConcurrencyTarget({
    accounts: [...lanes, acct('c1', { measuredBurnPerRunPct: 0.001 }), acct('c2', { measuredBurnPerRunPct: 0.002 })],
  });
  assert.equal(out.medianMeasuredBurnPct, 0.002, 'median of {0.01, 0.001, 0.002}');
});
