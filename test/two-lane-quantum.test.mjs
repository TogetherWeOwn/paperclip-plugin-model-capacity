import test from 'node:test';
import assert from 'node:assert/strict';
import { appendAccountUsage, calibrateAccounts } from '../src/calibration.mjs';
import { computeConcurrencyTarget } from '../src/concurrency.mjs';

// 2026-10-22 12:31Z: target C* fell 7.1 -> 0.72, worse than the 10:06Z
// single-lane jump. meta:lane-4 and meta:lane-7 each moved one weekly
// quantum over 0.72 and 0.60 attributed runs (confidence 0.25). Both
// switched to account-weekly with a baseline of 0.0105/run against the
// group prior of 0.0004, and their slots fell from ~3.7 to ~0.1.
//
// Same cause as the first jump: the Keeper request counters count every
// CLIProxy request, including runs outside the ledger, while runsBetween
// counts only ledger runs, so requestsPerRun inflates ~25x and the baseline
// follows it. Two lanes moving at once does not clear the guards: each lane
// still prices only on >=10 attributed runs with a baseline within 4x of
// the prior, otherwise the prior holds with a named reason.
const NOW = Date.parse('2026-10-22T12:31:00Z');
const MIN = 60000;
const reading = (atMs, requests, used, five = 0.1) => ({
  signalsAtMs: atMs,
  weekly: { utilization: used, resetsAtMs: NOW + 4 * 86400000 },
  fiveHour: { utilization: five, resetsAtMs: NOW + 5 * 3600000 },
  usage: { observedAtMs: atMs, epoch: 'keeper-1', requests },
});
const historyOf = (points) => points.reduce((h, a) => appendAccountUsage(h, a, NOW), []);
// Incident shape: lanes 4 and 7 each move one quantum (60 and 50 requests);
// siblings are flat but contribute their counters to requestsPerRun. Twelve
// ledger runs over 1000 counted requests inflate requestsPerRun to ~83, so
// lane 4 lands at 0.72 attributed runs and lane 7 at 0.60.
const incidentHistories = () => ({
  'meta:lane-4': historyOf([reading(NOW - 30 * MIN, 100, 0.20), reading(NOW, 160, 0.21)]),
  'meta:lane-5': historyOf([reading(NOW - 30 * MIN, 100, 0.30), reading(NOW, 545, 0.30)]),
  'meta:lane-7': historyOf([reading(NOW - 30 * MIN, 100, 0.18), reading(NOW, 150, 0.19)]),
  'meta:lane-8': historyOf([reading(NOW - 30 * MIN, 100, 0.24), reading(NOW, 545, 0.24)]),
});
const incidentCalibrate = (histories = incidentHistories(), prior = 0.0004) => calibrateAccounts({
  memberKeys: Object.keys(histories), historyOf: k => histories[k],
  groupBurnPerRunPct: prior, runsBetween: () => 12, nowMs: NOW,
});

test('double-quantum replay: both moving lanes keep the group prior', () => {
  const result = incidentCalibrate();
  for (const [key, expectedRuns] of [['meta:lane-4', 0.72], ['meta:lane-7', 0.60]]) {
    const lane = result.get(key);
    assert.equal(lane.source, 'group-prior');
    assert.equal(lane.burnPerRunPct, 0.0004);
    assert.equal(lane.capacityWeight, 1);
    assert.equal(lane.attributedRuns, null);
    assert.equal(lane.rejectionReason, 'low-attributed-runs');
    assert.ok(Math.abs(lane.attemptedAttributedRuns - expectedRuns) < 0.01);
    // Either guard alone would hold: the baseline is ~38x the prior.
    assert.ok(lane.attemptedBaseline / 0.0004 > 4);
  }
  // Siblings never had a sample; they name the missing evidence too.
  for (const k of ['meta:lane-5', 'meta:lane-8']) {
    assert.equal(result.get(k).source, 'group-prior');
    assert.equal(result.get(k).rejectionReason, 'no-evidence');
  }
});

test('double-quantum replay: moving lanes slots stay within 25% of pre-jump', () => {
  // Pre-jump: lane 4 on the 0.0004 prior with 80% remaining over ~96h.
  const pre = computeConcurrencyTarget({
    accounts: [{ accountId: 'meta:lane-4', remainingPct: 0.80, hoursToReset: 96,
      burnPerRunPct: 0.0004, measuredBurnPerRunPct: 0.0004 }],
    meanRunDurationHours: 0.186,
  });
  // Post-fix replay: the rejected samples keep the 0.0004 prior (79%
  // remaining after the quantum); without the guards the lanes would price
  // at ~0.015 and collapse to ~3% of their slots.
  const fixed = incidentCalibrate().get('meta:lane-4');
  assert.equal(fixed.burnPerRunPct, 0.0004);
  const post = computeConcurrencyTarget({
    accounts: [{ accountId: 'meta:lane-4', remainingPct: 0.79, hoursToReset: 95.9,
      burnPerRunPct: 0.0004, measuredBurnPerRunPct: fixed.burnPerRunPct }],
    meanRunDurationHours: 0.186,
  });
  const preSlots = pre.perAccount[0].slots;
  const postSlots = post.perAccount[0].slots;
  assert.ok(Math.abs(postSlots - preSlots) / preSlots < 0.25,
    `slots ${postSlots} within 25% of pre-jump ${preSlots}`);
});
