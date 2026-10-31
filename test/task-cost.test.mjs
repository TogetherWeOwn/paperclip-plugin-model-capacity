import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceCost, calibrateTaskCost, compareTaskCosts } from '../src/task-cost.mjs';

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

test('reasoning tokens are charged once: included in output, separately when disjoint, refused when ambiguous', () => {
  const prices = { verified: true, freshInputPerMillion: 2, cacheReadPerMillion: .1, outputPerMillion: 10, reasoningPerMillion: 20 };
  const base = { freshInputTokens: 0, cacheReadTokens: 0, outputTokens: 1000000, reasoningTokens: 500000 };
  assert.equal(resourceCost({ ...base, reasoningIncludedInOutput: true }, prices), 10);
  assert.equal(resourceCost({ ...base, reasoningIncludedInOutput: false }, prices), 20);
  assert.equal(resourceCost(base, prices), null, 'unknown overlap is not silently treated as included');
  assert.equal(resourceCost({ ...base, reasoningIncludedInOutput: false }, { ...prices, reasoningPerMillion: undefined }), null);
  assert.equal(resourceCost({ ...base, reasoningTokens: 0 }, { ...prices, reasoningPerMillion: undefined }), 10,
    'no reasoning tokens needs no reasoning price');
});

test('a token count with no verified price, or a missing required count, prices to null, never zero', () => {
  const prices = { verified: true, freshInputPerMillion: 2, cacheReadPerMillion: .1, outputPerMillion: 10 };
  const usage = { freshInputTokens: 1000000, cacheReadTokens: 0, outputTokens: 0 };
  assert.equal(resourceCost(usage, prices), 2);
  assert.equal(resourceCost({ ...usage, cacheWriteTokens: 1000 }, prices), null, 'cache writes need a cache-write price');
  assert.equal(resourceCost({ ...usage, cacheWriteTokens: 1000000 }, { ...prices, cacheWritePerMillion: 3 }), 5);
  assert.equal(resourceCost({ freshInputTokens: 1000000, cacheReadTokens: 0 }, prices), null, 'missing output count');
  assert.equal(resourceCost({ ...usage, outputTokens: Infinity }, prices), null);
  assert.equal(resourceCost({ ...usage, freshInputTokens: -1 }, prices), null);
  assert.equal(resourceCost(usage, { ...prices, freshInputPerMillion: -2 }), null);
  assert.equal(resourceCost(null, prices), null);
});

test('conflicting duplicate evidence, future close times and reused attempts refuse the cohort', () => {
  const episodes = Array.from({ length: 40 }, (_, i) => episode(i));
  const conflicting = calibrateTaskCost({ episodes: [...episodes, { ...episode(0), acceptance: 'rejected' }], cohort, nowMs, aaProxy: 1 });
  assert.equal(conflicting.ready, false);
  assert.ok(conflicting.reasons.includes('conflicting-episode'));
  assert.equal(conflicting.observedPerAcceptedTask, null);

  const future = calibrateTaskCost({ episodes: [...episodes, { ...episode('f'), closedAtMs: nowMs + 1 }], cohort, nowMs, aaProxy: 1 });
  assert.equal(future.ready, false);
  assert.ok(future.reasons.includes('invalid-episode-time'));

  const reused = episode('r');
  reused.attempts[0] = { ...episodes[1].attempts[0] };
  const doubled = calibrateTaskCost({ episodes: [...episodes, reused], cohort, nowMs, aaProxy: 1 });
  assert.equal(doubled.ready, false);
  assert.ok(doubled.reasons.includes('conflicting-attempt'));
  assert.equal(doubled.attempts, 81, 'a reused attempt is not counted twice');

  const foreign = Array.from({ length: 40 }, (_, i) => episode(i));
  foreign[0].attempts[0].cohort = { ...cohort, model: 'model-b' };
  const mixed = calibrateTaskCost({ episodes: foreign, cohort, nowMs, aaProxy: 1 });
  assert.equal(mixed.ready, false);
  assert.ok(mixed.reasons.includes('unresolved-attribution'));
});

test('episodes outside the window are dropped and a missing AA proxy blocks the estimate', () => {
  const episodes = Array.from({ length: 40 }, (_, i) => episode(i));
  const old = { ...episode('old', true, [1000]), closedAtMs: nowMs - 8 * 86400000 };
  const r = calibrateTaskCost({ episodes: [...episodes, old], cohort, nowMs, aaProxy: 1 });
  assert.equal(r.closedTasks, 40);
  assert.equal(r.observedPerAcceptedTask, 3);
  for (const aaProxy of [undefined, 0, -1, NaN]) {
    const missing = calibrateTaskCost({ episodes, cohort, nowMs, aaProxy });
    assert.equal(missing.ready, false);
    assert.ok(missing.reasons.includes('missing-aa-proxy'));
    assert.equal(missing.estimatedApiEquivalentPerAcceptedTask, null);
  }
});

test('task-cost comparison never mixes a calibrated estimate with a proxy, or null with zero', () => {
  const cal = (estimate, proxy, basis = 'api-equivalent-v1') => ({ estimatedApiEquivalentPerAcceptedTask: estimate,
    taskCostProxy: proxy, calibration: { ready: true, comparisonBasis: basis } });
  const proxyOnly = proxy => ({ taskCostProxy: proxy, calibration: { ready: false } });
  assert.equal(compareTaskCosts(cal(1, 10), cal(5, 2)), -4, 'same basis compares calibrated estimates');
  assert.equal(compareTaskCosts(cal(1, 10), cal(5, 2, 'other-basis')), 8, 'different basis falls back to the proxy');
  assert.equal(compareTaskCosts(cal(1, 10), proxyOnly(2)), 8, 'one calibrated side falls back to the proxy');
  assert.equal(compareTaskCosts(cal(1, 10, null), cal(5, 2, null)), 8, 'no basis is not a shared basis');
  assert.equal(compareTaskCosts(proxyOnly(null), proxyOnly(0)), 0, 'unknown cost is not ranked against free');
  assert.equal(compareTaskCosts(proxyOnly(-1), proxyOnly(3)), 0);
  assert.equal(compareTaskCosts(proxyOnly(2), undefined), 0);
});
