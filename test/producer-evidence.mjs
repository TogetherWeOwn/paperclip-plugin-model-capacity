import assert from 'node:assert/strict';

const EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertProducerEpoch(capacity) {
  assert.equal(capacity.holdEvidenceVersion, 1);
  assert.match(capacity.reviewAdmissionEpoch, EPOCH);
  assert.ok(Number.isInteger(capacity.reviewAdmissionGeneration) && capacity.reviewAdmissionGeneration >= 0);
}

// Compare two real current producers without equating their process identities.
// Presence/version/generation and every non-epoch field remain observable.
export function projectProducerEpoch(capacity) {
  assertProducerEpoch(capacity);
  return { ...structuredClone(capacity), reviewAdmissionEpoch: '<epoch>' };
}

export function assertWeeklyRouteEvidence(capacity) {
  assertProducerEpoch(capacity);
  const facts = capacity.weeklyRouteFacts;
  assert.deepEqual(Object.keys(facts).sort(), ['accounts', 'hardHeldAccountIds']);
  assert.ok(Array.isArray(facts.accounts) && Array.isArray(facts.hardHeldAccountIds));
  const accounts = new Map(capacity.accounts.map(account => [account.accountId, account]));
  assert.equal(facts.accounts.length, accounts.size);
  assert.equal(new Set(facts.accounts.map(account => account.accountId)).size, facts.accounts.length);
  for (const fact of facts.accounts) {
    assert.deepEqual(Object.keys(fact).sort(),
      ['accountId', 'burn', 'meter', 'models', 'planAhead', 'pool', 'provider', 'quality', 'reactive']);
    const account = accounts.get(fact.accountId);
    assert.ok(account, `published account for ${fact.accountId}`);
    assert.equal(fact.provider, account.provider);
    assert.equal(fact.pool, account.pool);
    assert.equal(fact.planAhead, account.planAhead);
    assert.equal(fact.burn, account.burnMode === true);
    assert.equal(fact.reactive, account.reactive === true);
    assert.ok(fact.models === null || (Array.isArray(fact.models) && fact.models.every(model => typeof model === 'string')));
    assert.deepEqual(fact.models, account.weeklyRouteModels);
  }
  const held = new Set(facts.hardHeldAccountIds);
  assert.equal(held.size, facts.hardHeldAccountIds.length);
  for (const id of held) {
    const account = facts.accounts.find(account => account.accountId === id);
    assert.ok(account && !account.burn && !account.reactive, 'a hard hold cannot relabel burn/reactive work');
  }
  for (const pool of capacity.paceGuard.rawPools) {
    for (const id of pool.hardHeldAccountIds ?? []) assert.ok(held.has(id));
  }
  assert.equal(typeof capacity.reviewerSafeAccountIdsByAgent, 'object');
  for (const [id, safe] of Object.entries(capacity.reviewerSafeAccountIdsByAgent)) {
    assert.equal(new Set(safe).size, safe.length);
    for (const accountId of safe) {
      assert.ok(capacity.reviewerAccountIdsByAgent[id].includes(accountId));
      assert.ok(!held.has(accountId), 'held work is not new safe reviewer capacity');
    }
  }
}

// The immutable pre-cut reference has no versioned route-evidence additions.
// Validate their current contract first, then project ONLY these four known
// fields. Budgets, route outcomes, pool/lane verdicts and unknown fields stay.
export function projectCompatibilityEvidence(result) {
  assertWeeklyRouteEvidence(result.capacity);
  const copy = structuredClone(result);
  copy.capacity.reviewAdmissionEpoch = '<epoch>';
  delete copy.capacity.holdEvidenceVersion;
  delete copy.capacity.weeklyRouteFacts;
  delete copy.capacity.reviewerSafeAccountIdsByAgent;
  for (const account of copy.capacity.accounts) delete account.weeklyRouteModels;
  return copy;
}
