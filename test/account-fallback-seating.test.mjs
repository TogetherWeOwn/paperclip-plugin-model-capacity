import test from 'node:test';
import assert from 'node:assert/strict';
import * as decision from '../src/decide.mjs';
import * as plugin from '../src/plugin.mjs';
import { buildAccountSupersession } from '../src/newest-version.mjs';

const arm = (armId, Q, C, extra = {}) => ({ armId, model: armId, family: 'sample', Q, C, coverage: 1, ...extra });
const low = arm('sample-1', 1, 1), high = arm('sample-2', 2, 2);
const ranking = (candidates = [low, high], rankingRungs = [{ armId: low.armId, rung: 0, Q: 1, C: 1 }, { armId: high.armId, rung: 1, Q: 2, C: 2 }]) => ({ candidates, rankingRungs, previousRungs: [], excludedArmIds: [] });
const band = { floorRung: 0, ceilingRung: 0 };
const ids = groups => groups.map(g => g.arms.map(a => a.armId));

test('F-T24: seating moves out-of-window arms, revives absent arms and preserves groups and inputs', () => {
  assert.equal(typeof decision.seatFallbackArm, 'function');
  const groups = [{ rung: 0, arms: [low] }, { rung: 1, arms: [{ ...high, maxRung: 1, marker: true }] }, { rung: 2, arms: [] }];
  const before = structuredClone(groups);
  assert.deepEqual(ids(decision.seatFallbackArm(groups, high, band)), [['sample-1', 'sample-2'], [], []]);
  const moved = decision.seatFallbackArm(groups, high, band);
  assert.deepEqual({ rung: moved[0].arms[1].rung, maxRung: moved[0].arms[1].maxRung, marker: moved[0].arms[1].marker }, { rung: 0, maxRung: 1, marker: true });
  const added = decision.seatFallbackArm(groups, arm('backup', 0, 2), { floorRung: 2, ceilingRung: null });
  assert.deepEqual(ids(added), [['sample-1'], ['sample-2'], ['backup']]);
  assert.equal(added[2].arms[0].rung, 2);
  assert.strictEqual(decision.seatFallbackArm(groups, high, { floorRung: 1, ceilingRung: 1 }), groups);
  assert.deepEqual(groups, before);
  const empty = [];
  assert.strictEqual(decision.seatFallbackArm(empty, high, band), empty);
});

test('F-T25: predicate dispositions follow order and fail closed', () => {
  assert.equal(typeof plugin.fallbackSeatCandidate, 'function');
  const f = plugin.fallbackSeatCandidate;
  assert.deepEqual(f(null, 'missing', 1, false), { reason: 'no-benchmark-rungs' });
  assert.deepEqual(f(ranking([], []), 'missing', 1, false), { reason: 'no-benchmark-rungs' });
  assert.deepEqual(f(ranking(), 'missing', 1, false, { newestEnabled: true }), { reason: 'candidate-absent' });
  assert.deepEqual(f(ranking(), low.armId, 1, false, { newestEnabled: true, excludedIds: [low.armId] }), { reason: 'superseded-version' });
  assert.deepEqual(f(ranking(), low.armId, 1, false, { excludedIds: [low.armId] }), { reason: 'cross-account-excluded' });
  const invalid = arm('invalid', NaN, 1);
  assert.deepEqual(f(ranking([invalid]), invalid.armId, 1, true), { reason: 'missing-cost-or-quality' });
  assert.deepEqual(f(ranking(), low.armId, 1, true), { reason: 'not-ready' });
  assert.deepEqual(f(ranking(), low.armId, 1, false), { candidate: low });
  const ready = arm('ready', 1, 1, { credentialEvidence: { status: 'valid', observedAtMs: 0, expiresAtMs: 10, servingCredentials: 1, readyCredentials: 1 } });
  assert.deepEqual(f(ranking([ready]), ready.armId, 1, true), { candidate: ready });
});

test('F-T14/T15 and X-T01/X-T02c: live-shaped per-role seating honors supersession, keeps and duplicate holding', () => {
  assert.equal(typeof plugin.createCredentialGroupHelpers, 'function');
  const { credentialGroupsFor, routableGroupsFor } = plugin.createCredentialGroupHelpers(() => 1);
  const old = arm('sample-0@high', 0, 3, { model: 'sample-0', effort: 'high' });
  const kept = arm('sample-1@max', 0, 4, { model: 'sample-1', effort: 'max' });
  const fresh = arm('sample-2', 1, 1);
  const view = buildAccountSupersession({ models: ['sample-0', 'sample-1', 'sample-2'] }, [], { overrides: { keep: ['arm:sample-1@max', 'model:sample-1'] } });
  const rank = ranking([old, kept, fresh], [{ armId: fresh.armId, rung: 0, Q: 1, C: 1 }]);
  rank.duplicateArmIds = [kept.armId];
  const account = { credentialRanking: rank, taskRankingMode: 'shadow', newestVersion: view };
  const desc = armId => ({ armId, band, newestEnabled: true, supersessionView: account.newestVersion });
  const before = structuredClone(account);
  assert.deepEqual(plugin.fallbackSeatCandidate(rank, old.armId, 1, false, desc(old.armId)), { reason: 'superseded-version' });
  assert.deepEqual(ids(credentialGroupsFor(account, 1, false, 'other', null, null, desc(old.armId))), [['sample-2']]);
  assert.deepEqual(ids(credentialGroupsFor(account, 1, false, 'other', null, null, desc(kept.armId))), [['sample-2', 'sample-1@max']]);
  assert.deepEqual(ids(credentialGroupsFor(account, 1, false, 'doer')), [['sample-2']]);
  assert.deepEqual(ids(routableGroupsFor(account, false, 1, false, 'other', null, null, desc(kept.armId))), [['sample-2']]);
  assert.deepEqual(ids(routableGroupsFor(account, true, 1, false, 'other', null, null, { ...desc(kept.armId), supersessionView: null })), [['sample-2']]);
  assert.ok(view.verdicts.some(row => row.canonicalModel === kept.model && row.kept));
  assert.ok(!view.supersededLegacyArmIds.includes(kept.armId));
  assert.deepEqual(account, before);
});

test('X-T01: real view exposes model-kept verdict while arm-only keep remains effort-scoped', () => {
  const view = buildAccountSupersession({ models: ['sample-0', 'sample-1', 'sample-2'] }, [],
    { overrides: { keep: ['arm:sample-1@max', 'model:sample-0'] } });
  assert.ok(view.verdicts.some(row => row.canonicalModel === 'sample-0' && row.kept === true));
  assert.equal(view.supersededLegacyArmIds.includes('sample-1@max'), false);
  const kept = arm('sample-1@max', 0, 3, { model: 'sample-1', effort: 'max' });
  const unkept = arm('sample-1@high', 0, 3, { model: 'sample-1', effort: 'high' });
  const r = ranking([kept, unkept]);
  const opts = { newestEnabled: true, supersessionView: view, excludedIds: [unkept.armId] };
  assert.deepEqual(plugin.fallbackSeatCandidate(r, kept.armId, 1, false, opts), { candidate: kept });
  const { credentialGroupsFor } = plugin.createCredentialGroupHelpers(() => 1);
  const account = { credentialRanking: r, taskRankingMode: 'shadow', newestVersion: view };
  assert.ok(ids(credentialGroupsFor(account, 1, false, 'other', null, null, { armId: kept.armId, band, ...opts }))[0].includes(kept.armId));
  assert.deepEqual(plugin.fallbackSeatCandidate(r, unkept.armId, 1, false, opts), { reason: 'superseded-version' });
});

test('F-T25: empty benchmark never invents a shell or seats a candidate', () => {
  const { credentialGroupsFor, routableGroupsFor } = plugin.createCredentialGroupHelpers(() => 1);
  const account = { credentialRanking: ranking([high], []) };
  const descriptor = { armId: high.armId, band };
  assert.deepEqual(credentialGroupsFor(account, 1, false, 'other', null, null, descriptor), []);
  assert.deepEqual(routableGroupsFor(account, false, 1, false, 'other', null, null, descriptor), []);
});
