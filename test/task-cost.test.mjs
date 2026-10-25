import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceCost, calibrateTaskCost } from '../src/task-cost.mjs';

const cohort = { model: 'model-a', effort: 'high', endpoint: 'api-a', pricingVersion: 'v1',
  role: 'doer', taskClass: 'coding', contextClass: 'standard' };
const nowMs = Date.parse('2026-10-25T00:00:00Z');
const episode = (id, accepted = true, costs = [1, 2]) => ({ episodeId: String(id), cohort, closed: true,
  closedAtMs: nowMs - 3600000, acceptance: accepted ? 'accepted' : 'rejected', acceptanceVerified: true,
  observationWindowComplete: true, attributionComplete: true, attempts: costs.map((c, i) => ({ attemptId: `${id}-${i}`,
    resourceCostUsd: c, pricingVerified: true, identityVerified: true, usageComplete: true })) });

test('verified fresh/cache/output resource cost uses each charge once and is never inferred cash', () => {
  const out = resourceCost({ freshInputTokens: 1000000, cacheReadTokens: 1000000, outputTokens: 1000000,
    reasoningTokens: 1000000, reasoningIncludedInOutput: true },
  { verified: true, freshInputPerMillion: 2, cacheReadPerMillion: .1, outputPerMillion: 10 });
  assert.equal(out, 12.1);
  assert.equal(resourceCost({ freshInputTokens: 10 }, { verified: false, freshInputPerMillion: 2 }), null);
  assert.equal(resourceCost({ freshInputTokens: 10, cacheReadTokens: 5, outputTokens: 1 },
    { verified: true, freshInputPerMillion: 2, outputPerMillion: 10 }), null, 'cache price is required');
});

test('P/A includes failures and rework exactly once, shrinks at episode level', () => {
  const episodes = Array.from({ length: 40 }, (_, i) => episode(i, i % 4 !== 0));
  const result = calibrateTaskCost({ episodes: [...episodes, episodes[0]], cohort, nowMs, aaProxy: 1 });
  assert.equal(result.ready, true);
  assert.equal(result.closedTasks, 40);
  assert.equal(result.attempts, 80);
  assert.equal(result.acceptedTasks, 30);
  assert.equal(result.observedPerAcceptedTask, 4);
  assert.equal(result.perAttempt * result.attemptsPerAcceptedTask, result.observedPerAcceptedTask);
  assert.equal(result.tokenProfileMultiplier, 1.5);
  assert.ok(Math.abs(result.estimatedApiEquivalentPerAcceptedTask - (1 + 40 / 70 * 3)) < 1e-12);
  assert.equal(result.cashUsdPerAcceptedTask, null);
  assert.ok(result.relativeCiHalfWidth <= .5);
});

test('zero acceptance is unusable, not zero dollars', () => {
  const r = calibrateTaskCost({ episodes: Array.from({ length: 40 }, (_, i) => episode(i, false)), cohort, nowMs, aaProxy: 1 });
  assert.equal(r.ready, false);
  assert.equal(r.observedPerAcceptedTask, null);
  assert.equal(r.estimatedApiEquivalentPerAcceptedTask, null);
  assert.ok(r.reasons.includes('no-accepted-outcomes'));
});

test('missing failed-attempt usage and unresolved mixed-model attribution disqualify the whole cohort', () => {
  const episodes = Array.from({ length: 40 }, (_, i) => episode(i));
  episodes[0].attempts[0].usageComplete = false;
  episodes[1].attributionComplete = false;
  const r = calibrateTaskCost({ episodes, cohort, nowMs, aaProxy: 1 });
  assert.equal(r.ready, false);
  assert.equal(r.estimatedApiEquivalentPerAcceptedTask, null);
  assert.equal(r.observedPerAcceptedTask, null, 'a partial cost sum is not an observed accepted-output cost');
  assert.ok(r.reasons.includes('incomplete-cost-coverage'));
  assert.ok(r.reasons.includes('unresolved-attribution'));
});

test('cohort identity, observation window, pending episodes and uncertainty are explicit', () => {
  const episodes = Array.from({ length: 40 }, (_, i) => episode(i, true, [i === 0 ? 10000 : 1]));
  const pending = { ...episode('pending'), closed: false };
  const other = { ...episode('other'), cohort: { ...cohort, effort: 'low' } };
  const r = calibrateTaskCost({ episodes: [...episodes, pending, other], cohort, nowMs, aaProxy: 1 });
  assert.equal(r.closedTasks, 40);
  assert.equal(r.pendingTasks, 1);
  assert.equal(r.ready, false);
  assert.ok(r.reasons.includes('uncertainty-too-wide'));
  const unadjudicated = calibrateTaskCost({ episodes: [{ ...episode(1), acceptanceVerified: false }], cohort, nowMs, aaProxy: 1 });
  assert.equal(unadjudicated.ready, false);
  assert.ok(unadjudicated.reasons.includes('unverified-acceptance'));
});


test('malformed reasoning usage cannot silently reduce attributable resource cost', () => {
  const usage = { freshInputTokens: 10, cacheReadTokens: 0, outputTokens: 10, reasoningTokens: -1 };
  assert.equal(resourceCost(usage, { verified: true, freshInputPerMillion: 2, outputPerMillion: 10 }), null);
});
