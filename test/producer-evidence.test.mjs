import test from 'node:test';
import assert from 'node:assert/strict';
import { drive, lane, config, policy, OPUS, SONNET } from './weekly-compatibility-fixture.mjs';
import { assertWeeklyRouteEvidence, projectProducerEpoch, projectCompatibilityEvidence } from './producer-evidence.mjs';

async function produced() {
  const raw = config(); raw.reviewerRouting.arms.push(policy('claude', SONNET));
  const d = await drive({ raw, accounts: [lane('held', .85, 120), lane('safe', .3, 84, { models: [SONNET] })] });
  await d.tick();
  return { capacity: await d.capacity(), ladders: await d.api('ladder'), diagnostics: [] };
}

test('current producer publishes explicit held and safe route facts, not an account-label affinity claim', async () => {
  const result = await produced(), capacity = result.capacity;
  assertWeeklyRouteEvidence(capacity);
  assert.equal(capacity.holdEvidenceVersion, 1);
  assert.deepEqual(capacity.weeklyRouteFacts, {
    accounts: [
      { accountId: 'claude:held', provider: 'claude', pool: 'claude', models: [OPUS],
        burn: false, reactive: false, meter: null, quality: 'live', planAhead: .5642857142857143 },
      { accountId: 'claude:safe', provider: 'claude', pool: 'claude', models: [SONNET],
        burn: false, reactive: false, meter: null, quality: 'live', planAhead: -.2 },
    ],
    hardHeldAccountIds: ['claude:held'],
  });
  assert.deepEqual(capacity.reviewerSafeAccountIdsByAgent, { review: ['claude:safe'] });
});

test('different real producer instances retain different epochs while all other state remains compared', async () => {
  const a = await produced(), b = await produced();
  assert.notEqual(a.capacity.reviewAdmissionEpoch, b.capacity.reviewAdmissionEpoch);
  assert.deepEqual(projectProducerEpoch(a.capacity), projectProducerEpoch(b.capacity));
});

test('reference evidence projection keeps budgets, lane verdicts, routes and unknown fields visible', async () => {
  const actual = await produced();
  const projected = projectCompatibilityEvidence(actual);
  assert.equal(Object.hasOwn(projected.capacity, 'holdEvidenceVersion'), false);
  assert.equal(Object.hasOwn(projected.capacity, 'weeklyRouteFacts'), false);
  assert.equal(Object.hasOwn(projected.capacity, 'reviewerSafeAccountIdsByAgent'), false);
  assert.equal(Object.hasOwn(projected.capacity.accounts[0], 'weeklyRouteModels'), false);
  for (const mutate of [
    value => { value.capacity.target = 999; },
    value => { value.capacity.paceGuard.rawPools[0].cap = 999; },
    value => { value.capacity.paceGuard.rawPools[0].laneVerdicts[0].allowance = 1; },
    value => { value.capacity.reviewer.routing.preview = { routed: true, accountId: 'claude:held' }; },
    value => { value.capacity.undocumentedHoldEvidence = 'must remain visible'; },
    value => { value.unknownRootState = 'must remain visible too'; },
  ]) {
    const altered = structuredClone(actual); mutate(altered);
    assert.notDeepEqual(projectCompatibilityEvidence(altered), projected);
  }
});

test('a reference projection cannot manufacture missing or unsupported producer evidence', async () => {
  const actual = await produced();
  for (const mutate of [
    value => { delete value.capacity.holdEvidenceVersion; },
    value => { value.capacity.holdEvidenceVersion = 2; },
    value => { delete value.capacity.reviewAdmissionEpoch; },
    value => { value.capacity.reviewAdmissionGeneration = -1; },
    value => { value.capacity.weeklyRouteFacts.unrecognized = true; },
    value => { value.capacity.reviewerSafeAccountIdsByAgent.review.push('claude:held'); },
  ]) {
    const altered = structuredClone(actual); mutate(altered);
    assert.throws(() => projectCompatibilityEvidence(altered));
  }
});
