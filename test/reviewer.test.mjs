import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REVIEWER,
  normalizeReviewer,
  computeReviewerCapacity,
  computeSupplySignal,
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
