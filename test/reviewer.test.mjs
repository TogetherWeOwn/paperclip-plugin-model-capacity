import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REVIEWER,
  normalizeReviewer,
  computeReviewerCapacity,
  computeSupplySignal,
  computeDoerStarvation,
} from '../src/reviewer.mjs';

// reviewer is a first-class role. Claude qualifies today; Meta only
// after the operator opts in (qualification bar lives in the analysis reports).
// The plugin emits runnable review capacity plus a hold/resume signal.

const acct = (accountId, provider, extra = {}) => ({
  accountId,
  provider,
  health: 'healthy',
  headroomPct: 0.5,
  remainingPct: 0.5,
  hoursToReset: 100,
  reviewerEligible: true,
  ...extra,
});

test('default reviewer qualifies claude only', () => {
  assert.deepEqual([...DEFAULT_REVIEWER.providers], ['claude']);
  const cfg = normalizeReviewer(null);
  assert.deepEqual(cfg.providers, ['claude']);
});

test('reviewer capacity counts only qualified healthy headroom accounts', () => {
  const cfg = normalizeReviewer({ providers: ['claude'] });
  const accounts = [
    acct('claude:a1', 'claude', { headroomPct: 0.6 }),
    acct('meta:m1', 'meta', { headroomPct: 0.9 }),
    acct('claude:a2', 'claude', { health: 'unavailable', headroomPct: 0.6 }),
    acct('claude:a3', 'claude', { headroomPct: null, reviewerEligible: false }),
  ];
  const out = computeReviewerCapacity({ accounts, cfg, nowMs: 1000 });
  assert.deepEqual(out.qualifiedAccountIds, ['claude:a1']);
  assert.equal(out.hold, false);
  assert.equal(out.resume, true);
  assert.ok(out.slots > 0);
});

test('no qualified capacity holds reviews with a reason', () => {
  const cfg = normalizeReviewer({ providers: ['claude'] });
  const out = computeReviewerCapacity({
    accounts: [acct('meta:m1', 'meta', { headroomPct: 0.9 })],
    cfg,
    nowMs: 1000,
  });
  assert.equal(out.hold, true);
  assert.equal(out.resume, false);
  assert.equal(out.slots, 0);
  assert.match(out.reason, /no qualified reviewer capacity/i);
});

test('opted-in meta provider counts once qualified', () => {
  const cfg = normalizeReviewer({ providers: ['claude', 'meta'] });
  const out = computeReviewerCapacity({
    accounts: [acct('meta:m1', 'meta', { headroomPct: 0.9 })],
    cfg,
    nowMs: 1000,
  });
  assert.deepEqual(out.qualifiedAccountIds, ['meta:m1']);
  assert.equal(out.hold, false);
});

test('supply signal fires on large unused headroom near reset with idle doers', () => {
  const accounts = [acct('meta:m1', 'meta', { remainingPct: 0.6, hoursToReset: 60 })];
  const fire = computeSupplySignal({ accounts, doerIdle: true, nowMs: 1000 });
  assert.equal(fire.wake, true);
  assert.ok(fire.providers.some((p) => p.provider === 'meta'));
  const quiet = computeSupplySignal({ accounts, doerIdle: false, nowMs: 1000 });
  assert.equal(quiet.wake, false);
  const far = computeSupplySignal({
    accounts: [acct('meta:m1', 'meta', { remainingPct: 0.6, hoursToReset: 200 })],
    doerIdle: true,
    nowMs: 1000,
  });
  assert.equal(far.wake, false);
});

test('reviewer holds accounts the allocator would refuse (excluded, guarded, thin headroom)', () => {
  // Paperclip Review probe: a lone healthy Claude account at 99.5% weekly
  // used (tick action 'excluded'), or at 97% of its 5h window (floor guard,
  // headroom 0.03 under the allocator's 0.05 reserve), must hold reviews --
  // the signal exists to stop routing reviews to nothing.
  const cfg = normalizeReviewer({ providers: ['claude'] });
  const exhausted = computeReviewerCapacity({
    accounts: [acct('claude:a1', 'claude', { headroomPct: 0.005, remainingPct: 0.005, action: 'excluded', guardActive: false })],
    cfg,
    nowMs: 1000,
  });
  assert.equal(exhausted.hold, true);
  assert.equal(exhausted.resume, false);
  const guarded = computeReviewerCapacity({
    accounts: [acct('claude:a1', 'claude', { headroomPct: 0.03, remainingPct: 0.5, action: 'hold-guard', guardActive: true })],
    cfg,
    nowMs: 1000,
  });
  assert.equal(guarded.hold, true);
  assert.equal(guarded.resume, false);
  const thin = computeReviewerCapacity({
    accounts: [acct('claude:a1', 'claude', { headroomPct: 0.03, remainingPct: 0.5 })],
    cfg,
    nowMs: 1000,
  });
  assert.equal(thin.hold, true);
  assert.equal(thin.resume, false);
  // Reactive lanes carry no meter and qualify on health alone (allocator
  // admits them); a healthy reactive account still resumes.
  const reactive = computeReviewerCapacity({
    accounts: [acct('claude:a1', 'claude', { headroomPct: null, reactive: true })],
    cfg,
    nowMs: 1000,
  });
  assert.equal(reactive.hold, false);
  assert.equal(reactive.resume, true);
});

test('supply signal pairs each account headroom with its own reset', () => {
  // Paperclip Review probe: a 90%-headroom account resetting in 150h plus an
  // exhausted account resetting in 2h must NOT wake supply -- the old code
  // averaged the headroom (0.45) with the nearest reset (2h) across accounts.
  const mixed = [
    acct('claude:a1', 'claude', { remainingPct: 0.9, hoursToReset: 150 }),
    acct('claude:a2', 'claude', { remainingPct: 0, hoursToReset: 2, action: 'excluded' }),
  ];
  const out = computeSupplySignal({ accounts: mixed, doerIdle: true });
  assert.equal(out.wake, false);
  assert.deepEqual(out.providers, []);
  // One account that clears both bars on its own still wakes.
  const single = computeSupplySignal({
    accounts: [acct('claude:a1', 'claude', { remainingPct: 0.9, hoursToReset: 60 })],
    doerIdle: true,
  });
  assert.equal(single.wake, true);
  // Unhealthy accounts never contribute, even with headroom near reset.
  const sick = computeSupplySignal({
    accounts: [acct('claude:a1', 'claude', { health: 'degraded', remainingPct: 0.9, hoursToReset: 60 })],
    doerIdle: true,
  });
  assert.equal(sick.wake, false);
});

test('supply signal reports per-provider live runs; an idle healthy provider wakes even when the fleet is busy', () => {
  // Host 2026-10-14: Meta held large unused headroom with almost no runs
  // while fleet runs/h (Claude reviewer traffic) looked healthy. Fleet
  // doerIdle=false must not mask the idle provider.
  const accounts = [
    acct('claude:r1', 'claude', { remainingPct: 0.1, hoursToReset: 100, inFlight: 3 }),
    acct('meta:m1', 'meta', { remainingPct: 0.6, hoursToReset: 60, inFlight: 0 }),
  ];
  const out = computeSupplySignal({ accounts, doerIdle: false });
  const meta = out.providers.find((p) => p.provider === 'meta');
  assert.ok(meta);
  assert.equal(meta.liveRuns, 0);
  assert.equal(meta.idle, true);
  assert.equal(meta.qualifyingAccounts, 1);
  assert.equal(meta.wake, true);
  assert.equal(out.wake, true);
  assert.equal(out.providers.find((p) => p.provider === 'claude'), undefined);
});

test('supply liveRuns count every provider run, not just qualifying accounts', () => {
  // A non-qualifying account on the same provider still burns quota: its
  // runs must show in the provider entry, or an idle flag lies.
  const accounts = [
    acct('meta:m1', 'meta', { remainingPct: 0.6, hoursToReset: 60, inFlight: 0 }),
    acct('meta:m2', 'meta', { remainingPct: 0.6, hoursToReset: 60, action: 'excluded', inFlight: 5 }),
  ];
  const out = computeSupplySignal({ accounts, doerIdle: false });
  const meta = out.providers.find((p) => p.provider === 'meta');
  assert.ok(meta);
  assert.equal(meta.liveRuns, 5);
  assert.equal(meta.idle, false);
  assert.equal(meta.wake, false);
  assert.equal(out.wake, false);
});

test('supply signal without liveness falls back to the fleet doer flag', () => {
  const accounts = [acct('meta:m1', 'meta', { remainingPct: 0.6, hoursToReset: 60 })];
  const out = computeSupplySignal({ accounts, doerIdle: false });
  assert.equal(out.providers[0].liveRuns, null);
  assert.equal(out.providers[0].idle, null);
  assert.equal(out.wake, false);
});

test('doer starvation wakes only after the C* gap persists past the sustain window', () => {
  const t0 = 1000000;
  const first = computeDoerStarvation({ target: 22, liveDoerRuns: 8, doerDemand: 37, sinceMs: null, nowMs: t0 });
  assert.equal(first.starving, true);
  assert.equal(first.gap, 14);
  assert.equal(first.waiting, true);
  assert.equal(first.wake, false);
  assert.equal(first.sinceMs, t0);
  const early = computeDoerStarvation({ target: 22, liveDoerRuns: 8, doerDemand: 37, sinceMs: first.sinceMs, nowMs: t0 + 5 * 60000 });
  assert.equal(early.wake, false);
  assert.equal(early.sinceMs, t0);
  const late = computeDoerStarvation({ target: 22, liveDoerRuns: 8, doerDemand: 37, sinceMs: first.sinceMs, nowMs: t0 + 10 * 60000 });
  assert.equal(late.wake, true);
  const closed = computeDoerStarvation({ target: 22, liveDoerRuns: 21, doerDemand: 37, sinceMs: late.sinceMs, nowMs: t0 + 11 * 60000 });
  assert.equal(closed.starving, false);
  assert.equal(closed.sinceMs, null);
  assert.equal(closed.wake, false);
});

test('doer starvation never wakes without waiting doer demand', () => {
  // C* absorbed by thinker runs, or an issues outage zeroing demand: a gap
  // with nothing queued is not starvation, however long it persists.
  const t0 = 1000000;
  const out = computeDoerStarvation({ target: 22, liveDoerRuns: 0, doerDemand: 0, sinceMs: t0, nowMs: t0 + 30 * 60000 });
  assert.equal(out.starving, true);
  assert.equal(out.waiting, false);
  assert.equal(out.wake, false);
  assert.equal(out.sinceMs, t0);
});

test('reviewer excludes guard-pinned and weekly-exhausted accounts even with headroom above the reserve', () => {
  // Mutation pin: headroom 0.06/0.10 clears the allocator's 0.05 reserve, so
  // hasHeadroom alone would count these -- only the excluded/guardActive
  // parity line holds the signal.
  const cfg = normalizeReviewer({ providers: ['claude'] });
  const guarded = computeReviewerCapacity({
    accounts: [acct('claude:a1', 'claude', { headroomPct: 0.06, remainingPct: 0.5, guardActive: true })],
    cfg,
    nowMs: 1000,
  });
  assert.equal(guarded.hold, true);
  assert.equal(guarded.resume, false);
  assert.deepEqual(guarded.qualifiedAccountIds, []);
  const excluded = computeReviewerCapacity({
    accounts: [acct('claude:a1', 'claude', { headroomPct: 0.10, remainingPct: 0.5, action: 'excluded' })],
    cfg,
    nowMs: 1000,
  });
  assert.equal(excluded.hold, true);
  assert.equal(excluded.resume, false);
  assert.deepEqual(excluded.qualifiedAccountIds, []);
});

test('supply signal ignores excluded and guard-pinned accounts with qualifying headroom and reset', () => {
  // Mutation pin: remaining 0.6 with reset in 60h clears both supply bars on
  // its own, so only the excluded/guardActive parity line keeps it out.
  const guarded = computeSupplySignal({
    accounts: [acct('claude:a1', 'claude', { remainingPct: 0.6, hoursToReset: 60, guardActive: true })],
    doerIdle: true,
  });
  assert.deepEqual(guarded.providers, []);
  assert.equal(guarded.wake, false);
  const excluded = computeSupplySignal({
    accounts: [acct('claude:a1', 'claude', { remainingPct: 0.6, hoursToReset: 60, action: 'excluded' })],
    doerIdle: true,
  });
  assert.deepEqual(excluded.providers, []);
  assert.equal(excluded.wake, false);
});

test('doer starvation treats a gap exactly at the margin as starving', () => {
  // Boundary pin: the margin comparison is >=, not >.
  const at = computeDoerStarvation({ target: 22, liveDoerRuns: 18, doerDemand: 37, sinceMs: null, nowMs: 1000 });
  assert.equal(at.gap, 4);
  assert.equal(at.starving, true);
  assert.equal(at.sinceMs, 1000);
});

test('a doer gap inside the margin never starves; an unmeasurable target stays unknown', () => {
  const inside = computeDoerStarvation({ target: 22, liveDoerRuns: 20, sinceMs: null, nowMs: 1000 });
  assert.equal(inside.starving, false);
  assert.equal(inside.wake, false);
  assert.equal(inside.sinceMs, null);
  const unknown = computeDoerStarvation({ target: null, liveDoerRuns: 0, sinceMs: null, nowMs: 1000 });
  assert.equal(unknown.wake, false);
  assert.equal(unknown.starving, false);
  assert.equal(unknown.unknown, true);
});
