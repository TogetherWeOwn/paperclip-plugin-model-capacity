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
  rebaseSampleToMix,
  UNATTRIBUTED_ARM,
} from '../src/arm-calibration.mjs';
import { computeConcurrencyTarget } from '../src/concurrency.mjs';

const EXPENSIVE = 'wonder-full-era:high';
const CHEAP = 'muse-spark-1.3-contributor:xhigh';

test('armKeyOfRecord keys runs by model+effort', () => {
  // One canonical namespace: enforced and model-confirmed records map the
  // routed arm id to the served model, so a matched pick converges with
  // mismatched/pending records for the same executed arm. Otherwise the key
  // derives from what ran.
  assert.equal(
    armKeyOfRecord({ armId: 'muse-spark-1-3-xhigh', enforced: true }),
    'muse-spark-1.3-contributor:xhigh',
  );
  assert.equal(
    armKeyOfRecord({ armId: 'muse-spark-1-3-xhigh', actualModel: 'muse-spark-1.3-contributor', modelMatch: true }),
    'muse-spark-1.3-contributor:xhigh',
  );
  assert.equal(
    armKeyOfRecord({ armId: null, actualModel: 'muse-spark-1.3-contributor', effort: 'xhigh' }),
    'muse-spark-1.3-contributor:xhigh',
  );
  // A non-enforced shadow guess (wouldModel only) keys nothing: it buckets
  // as unattributed instead of attributing burn to an arm that never ran.
  assert.equal(armKeyOfRecord({ armId: 'shadow-arm', wouldModel: 'muse-spark-1.3-contributor(xhigh)' }), null);
  assert.equal(
    armKeyOfRecord({ armId: null, wouldModel: 'muse-spark-1.3-contributor(xhigh)', enforced: true }),
    'muse-spark-1.3-contributor:xhigh',
  );
  // A shadow pick the observed model contradicts keys by what actually ran.
  assert.equal(
    armKeyOfRecord({
      armId: 'claude-haiku-5-5:max', effort: 'max',
      actualModel: 'claude-opus-5-5', wouldModel: 'claude-haiku-5-5(max)',
      modelMatch: false,
    }),
    'claude-opus-5-5:max',
  );
  // Unknown or pending models yield no key.
  assert.equal(armKeyOfRecord({ armId: null, actualModel: 'unknown' }), null);
  assert.equal(armKeyOfRecord({}), null);
});

test('armKeyOfRecord converges matched, mismatched and pending records of one executed arm', () => {
  // The incident regime: shadow agreement is partial, so half the fleet's
  // records confirm the pick while half disagree or are still pending. All
  // executed muse-spark-1.3-contributor must count under one key, or the 60%
  // dominant-arm gate sees ~50% per alias and blocks a genuine switch.
  const CHEAP_MODEL = 'muse-spark-1.3-contributor';
  const matched = armKeyOfRecord({
    armId: 'muse-spark-1-3-xhigh', effort: 'xhigh',
    actualModel: CHEAP_MODEL, wouldModel: `${CHEAP_MODEL}(xhigh)`,
    modelMatch: true,
  });
  const mismatched = armKeyOfRecord({
    armId: 'claude-sonnet-5-5-high', effort: 'high',
    actualModel: CHEAP_MODEL, wouldModel: 'claude-sonnet-5-5(high)',
    modelMatch: false,
  });
  const pending = armKeyOfRecord({
    armId: 'muse-spark-1-3-xhigh', effort: 'xhigh',
    actualModel: CHEAP_MODEL, wouldModel: `${CHEAP_MODEL}(xhigh)`,
    modelMatch: null,
  });
  assert.equal(matched, 'muse-spark-1.3-contributor:xhigh', `matched: ${matched}`);
  assert.equal(mismatched, 'muse-spark-1.3-contributor:xhigh', `mismatched: ${mismatched}`);
  assert.equal(pending, 'muse-spark-1.3-contributor:xhigh', `pending: ${pending}`);
  // Half-and-half still holds a 100% share under one key.
  const counts = countRunsByArm([
    ...Array.from({ length: 6 }, () => ({
      armId: 'muse-spark-1-3-xhigh', effort: 'xhigh',
      actualModel: CHEAP_MODEL, modelMatch: true,
    })),
    ...Array.from({ length: 6 }, () => ({
      armId: 'claude-sonnet-5-5-high', effort: 'high',
      actualModel: CHEAP_MODEL, modelMatch: false,
    })),
  ]);
  assert.deepEqual(counts, { 'muse-spark-1.3-contributor:xhigh': 12 });
  assert.equal(dominantArm({ 'muse-spark-1.3-contributor:xhigh': 1 }), 'muse-spark-1.3-contributor:xhigh');
});

test('armKeyOfRecord converges sonnet high vs max by observed effort, not shadow pick', () => {
  // Shadow mode does not enforce effort, so a matched model must not confirm
  // the decided effort: twelve runs that all executed bare claude-sonnet-5-5
  // (default effort max) key one way whether the shadow pick agreed or not,
  // or the 60% dominant-arm gate sees 50/50 and blocks a genuine switch.
  const SONNET = 'claude-sonnet-5-5';
  const matched = armKeyOfRecord({
    armId: 'claude-sonnet-5-5-high', effort: 'high',
    actualModel: SONNET, wouldModel: `${SONNET}(high)`,
    modelMatch: true,
  });
  const mismatched = armKeyOfRecord({
    armId: 'claude-opus-5-5-xhigh', effort: 'xhigh',
    actualModel: SONNET, wouldModel: 'claude-opus-5-5(xhigh)',
    modelMatch: false,
  });
  const pending = armKeyOfRecord({
    armId: 'claude-sonnet-5-5-high', effort: 'high',
    actualModel: SONNET, wouldModel: `${SONNET}(high)`,
    modelMatch: null,
  });
  assert.equal(matched, 'claude-sonnet-5-5:max', `matched: ${matched}`);
  assert.equal(mismatched, 'claude-sonnet-5-5:max', `mismatched: ${mismatched}`);
  assert.equal(pending, 'claude-sonnet-5-5:max', `pending: ${pending}`);
  const counts = countRunsByArm([
    ...Array.from({ length: 6 }, () => ({
      armId: 'claude-sonnet-5-5-high', effort: 'high',
      actualModel: SONNET, modelMatch: true,
    })),
    ...Array.from({ length: 6 }, () => ({
      armId: 'claude-opus-5-5-xhigh', effort: 'xhigh',
      actualModel: SONNET, modelMatch: false,
    })),
  ]);
  assert.deepEqual(counts, { 'claude-sonnet-5-5:max': 12 });
  // Enforced records still trust the decided effort (the hook enforced it).
  assert.equal(
    armKeyOfRecord({
      armId: 'claude-sonnet-5-5-high', effort: 'high',
      actualModel: SONNET, modelMatch: false, enforced: true,
    }),
    'claude-sonnet-5-5:high',
  );
  // Decorated observed models converge on the observed effort either way.
  const decorated = 'claude-sonnet-5-5(high)';
  assert.equal(
    armKeyOfRecord({ armId: 'claude-sonnet-5-5-high', effort: 'high', actualModel: decorated, modelMatch: true }),
    'claude-sonnet-5-5:high',
  );
  assert.equal(
    armKeyOfRecord({ armId: 'claude-opus-5-5-xhigh', effort: 'xhigh', actualModel: decorated, modelMatch: false }),
    'claude-sonnet-5-5:high',
  );
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
  assert.deepEqual(countRunsByArm([{ armId: 'a', enforced: true }, {}]), { a: 1 });
  assert.deepEqual(
    countRunsByArm([{ armId: 'a', enforced: true }, {}], { unattributed: UNATTRIBUTED_ARM }),
    { a: 1, [UNATTRIBUTED_ARM]: 1 },
  );
  // A non-enforced shadow guess with no observed model is arm-less too.
  assert.deepEqual(
    countRunsByArm([{ armId: 'a', wouldModel: 'm:a(max)' }], { unattributed: UNATTRIBUTED_ARM }),
    { [UNATTRIBUTED_ARM]: 1 },
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

test('effectiveBurnForMix prices unmeasured arms off the measured arms, not the arm universe', () => {
  // Fleet measured on opus at pooled=0.012; haiku never ran. Anchors are
  // indexed under alias keys (as the tick does). The consistent prior is
  // pooled * haikuAnchor / opusAnchor = 0.012*0.0005/0.00333 ~= 0.0018 --
  // NOT pooled scaled by the universe average (~0.00313, 1.74x too high).
  const priced = effectiveBurnForMix({
    armE: { 'a:max': 0.012 },
    mixShares: { 'h:max': 1 },
    pooledBurn: 0.012,
    anchorByArm: { 'a:max': 0.00333, a: 0.00333, 'h:max': 0.0005, h: 0.0005 },
  });
  assert.ok(Math.abs(priced - 0.0018018) < 1e-4, `mispriced unmeasured arm: ${priced}`);
  // With no measured arm at all, fall back to pooled directly.
  assert.ok(Math.abs(effectiveBurnForMix({
    armE: {}, mixShares: { 'h:max': 1 }, pooledBurn: 0.012,
    anchorByArm: { 'a:max': 0.00333, 'h:max': 0.0005 },
  }) - 0.012) < 1e-12);
});

test('rebaseSampleToMix re-bases a counter estimate onto the mix price', () => {
  // Window implies the old-mix scale (0.006) while the mix price moved to
  // the cheap arm (0.001): the estimate follows the mix, inversely in weight.
  const out = rebaseSampleToMix(
    { source: 'account-weekly', burnPerRunPct: 0.006, capacityWeight: 1, groupMedianBurnPerRunPct: 0.006 },
    { priced: 0.001, pooled: 0.006 },
  );
  assert.ok(Math.abs(out.burnPerRunPct - 0.001) < 1e-12, `${out.burnPerRunPct}`);
  assert.ok(Math.abs(out.capacityWeight - 6) < 1e-12, `${out.capacityWeight}`);
  assert.equal(out.groupMedianBurnPerRunPct, 0.001);
  // Non-weekly samples and missing scales pass through untouched.
  const prior = { source: 'group-prior', burnPerRunPct: 0.006, capacityWeight: 1 };
  assert.equal(rebaseSampleToMix(prior, { priced: 0.001, pooled: 0.006 }), prior);
  const weekly = { source: 'account-weekly', burnPerRunPct: 0.006, capacityWeight: 1 };
  assert.equal(rebaseSampleToMix(weekly, { priced: null, pooled: 0.006 }), weekly);
  assert.equal(rebaseSampleToMix(weekly, { priced: 0.001, pooled: null }), weekly);
  // The rescale clamps at 8x either way.
  const clamped = rebaseSampleToMix(
    { source: 'account-weekly', burnPerRunPct: 0.006, capacityWeight: 1 },
    { priced: 0.00006, pooled: 0.006 },
  );
  assert.ok(Math.abs(clamped.burnPerRunPct - 0.006 / 8) < 1e-15, `${clamped.burnPerRunPct}`);
});

test('effectiveBurnForMix falls back to the pooled burn with no arm evidence', () => {
  assert.equal(effectiveBurnForMix({ armE: {}, mixShares: {}, pooledBurn: 0.002 }), null);
  assert.ok(Math.abs(effectiveBurnForMix({
    armE: {}, mixShares: { [EXPENSIVE]: 1 }, pooledBurn: 0.002,
  }) - 0.002) < 1e-12);
});
