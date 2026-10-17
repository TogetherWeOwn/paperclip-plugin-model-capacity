/**
 * Arm-aware burn calibration: burn per run is measured per arm
 * (model+effort) per pool, not per account.
 *
 * Regression: when doers switch from an expensive arm to a cheap arm, slots
 * must rise within one tick of ledger evidence -- the fleet must not wait
 * for quantized meter quanta priced at the old arm's burn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  armKeyOfRecord,
  countRunsByArm,
  attributeArmBurn,
  effectiveBurnForMix,
  dominantArm,
  UNATTRIBUTED_ARM,
} from '../src/arm-calibration.mjs';
import { computeConcurrencyTarget } from '../src/concurrency.mjs';

const EXPENSIVE = 'wonder-full-era:high';
const CHEAP = 'muse-spark-1.3-contributor:xhigh';

test('armKeyOfRecord keys runs by model+effort', () => {
  assert.equal(armKeyOfRecord({ armId: 'muse-spark-1-3-xhigh' }), 'muse-spark-1-3-xhigh');
  assert.equal(
    armKeyOfRecord({ armId: null, actualModel: 'muse-spark-1.3-contributor', effort: 'xhigh' }),
    'muse-spark-1.3-contributor:xhigh',
  );
  // Decorated wouldModel carries the effort when the record has no arm id.
  assert.equal(
    armKeyOfRecord({ armId: null, wouldModel: 'muse-spark-1.3-contributor(xhigh)' }),
    'muse-spark-1.3-contributor:xhigh',
  );
  assert.equal(armKeyOfRecord({}), null);
});

test('attributeArmBurn measures the single arm of a pure span exactly', () => {
  const raw = attributeArmBurn({ deltaPct: 0.02, runsByArm: { [EXPENSIVE]: 10 } });
  assert.ok(Math.abs(raw[EXPENSIVE] - 0.002) < 1e-12);
});

test('attributeArmBurn splits a mixed span by responsibility, not by headcount', () => {
  // 5 expensive runs at E=0.002 plus 5 cheap runs at E=0.0002 burn 0.011.
  const raw = attributeArmBurn({
    deltaPct: 0.011,
    runsByArm: { [EXPENSIVE]: 5, [CHEAP]: 5 },
    priorByArm: { [EXPENSIVE]: 0.002, [CHEAP]: 0.0002 },
  });
  assert.ok(Math.abs(raw[EXPENSIVE] - 0.002) < 1e-12, `expensive: ${raw[EXPENSIVE]}`);
  assert.ok(Math.abs(raw[CHEAP] - 0.0002) < 1e-12, `cheap: ${raw[CHEAP]}`);
});

test('attributeArmBurn prices an unseen arm off anchor ratios, not the pool average', () => {
  // First pooled sample ever: 10 expensive runs burn 0.02. The cheap arm
  // never ran, but the cost anchor says it burns ~1/7th of the expensive
  // arm -- its prior must reflect that, not the expensive average.
  const raw = attributeArmBurn({
    deltaPct: 0.02,
    runsByArm: { [EXPENSIVE]: 10 },
    anchorByArm: { [EXPENSIVE]: 0.0021, [CHEAP]: 0.0003 },
  });
  assert.ok(Math.abs(raw[EXPENSIVE] - 0.002) < 1e-12);
  assert.ok(raw[CHEAP] == null, 'arms with no runs get no sample');
});

test('countRunsByArm buckets arm-less runs instead of dropping them', () => {
  assert.deepEqual(countRunsByArm([{ armId: 'a' }, {}]), { a: 1 });
  assert.deepEqual(
    countRunsByArm([{ armId: 'a' }, {}], { unattributed: UNATTRIBUTED_ARM }),
    { a: 1, [UNATTRIBUTED_ARM]: 1 },
  );
});

test('dominantArm tracks the arm serving most runs', () => {
  assert.equal(dominantArm({}), null);
  assert.equal(dominantArm({ [EXPENSIVE]: 8, [CHEAP]: 2 }), EXPENSIVE);
  assert.equal(dominantArm({ [EXPENSIVE]: 2, [CHEAP]: 8 }), CHEAP);
});

test('expensive-to-cheap switch raises slots within one tick of ledger evidence', () => {
  // Tick 1: the pool ran the expensive arm only. One quantum measured
  // E ~= 0.002/run (the Wonder-Full-era burn from the incident).
  const prior = attributeArmBurn({ deltaPct: 0.02, runsByArm: { [EXPENSIVE]: 10 } });
  const anchorByArm = { [EXPENSIVE]: 0.0021, [CHEAP]: 0.0003 };
  const armE = { [EXPENSIVE]: prior[EXPENSIVE] };
  const price = (mixShares) => effectiveBurnForMix({
    armE, mixShares, pooledBurn: prior[EXPENSIVE], anchorByArm,
  });
  const slotsFor = (burn) => computeConcurrencyTarget({
    accounts: [{
      accountId: 'meta:lane1', remainingPct: 0.75, hoursToReset: 32,
      burnPerRunPct: 0.002, measuredBurnPerRunPct: burn,
      calibrationGroup: 'meta:lane1', healthy: true,
    }],
    meanRunDurationHours: 0.186,
  }).perAccount[0].slots;

  const before = slotsFor(price({ [EXPENSIVE]: 1 }));
  // Tick 2: the only new evidence is ledger runs on the cheap arm -- no new
  // meter quantum yet. Pricing must already follow the cheap arm.
  const after = slotsFor(price({ [CHEAP]: 1 }));
  assert.ok(before > 0 && after > 0);
  assert.ok(after > before * 2, `slots must rise within one tick: ${before} -> ${after}`);
});

test('effectiveBurnForMix falls back to the pooled burn with no arm evidence', () => {
  assert.equal(effectiveBurnForMix({ armE: {}, mixShares: {}, pooledBurn: 0.002 }), null);
  assert.ok(Math.abs(effectiveBurnForMix({
    armE: {}, mixShares: { [EXPENSIVE]: 1 }, pooledBurn: 0.002,
  }) - 0.002) < 1e-12);
});
