import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAggregatorAccount,
  isFallbackOnlyView,
  nativeQualifiedModels,
  crossAccountDominated,
  versionTuple,
  compareVersions,
  hasHeadroom,
} from '../src/cross-account.mjs';
import { orderAccountsForRun } from '../src/select.mjs';

const view = (accountId, partial = {}) => ({
  accountId,
  resetAtMs: null,
  headroomPct: 0.9,
  health: 'healthy',
  measuredRatePerHour: null,
  requiredRatePerHour: null,
  ...partial,
});

test('aggregator detection: devin provider, laneProvider, or account prefix', () => {
  assert.equal(isAggregatorAccount(view('devin:lane-1', { provider: 'devin' })), true);
  assert.equal(isAggregatorAccount(view('x', { provider: 'Devin' })), true);
  assert.equal(isAggregatorAccount(view('y', { laneProvider: 'devin' })), true);
  assert.equal(isAggregatorAccount(view('devin:lane-9')), true);
  assert.equal(isAggregatorAccount(view('codex:codex-lane-1', { provider: 'codex' })), false);
  assert.equal(isAggregatorAccount(view('claude:a', { provider: 'claude' })), false);
});

test('native qualified models: only healthy headroom natives count, never aggregators', () => {
  const models = nativeQualifiedModels([
    view('codex:lane-1', { provider: 'codex', models: ['gpt-6.1-sol'] }),
    view('devin:lane-1', { provider: 'devin', meter: 'reactive', headroomPct: null, models: ['gpt-6-sol'] }),
    view('claude:dead', { provider: 'claude', health: 'exhausted', models: ['claude-opus-5-5'] }),
    view('claude:thin', { provider: 'claude', headroomPct: 0.04, models: ['claude-haiku-5-5'] }),
  ]);
  assert.deepEqual([...models].sort(), ['gpt-6.1-sol']);
});

test('fallback-only: aggregator serving only duplicated models; unique keeps band 1', () => {
  const native = new Set(['gpt-6-sol']);
  assert.equal(
    isFallbackOnlyView(view('devin:lane-1', { provider: 'devin', models: ['devin/gpt-6-sol'] }), native),
    true,
    'provider-prefixed id canonicalizes to the native model',
  );
  assert.equal(
    isFallbackOnlyView(view('devin:lane-1', { provider: 'devin', models: ['gpt-6-sol', 'swe-2'] }), native),
    false,
    'a unique model (swe-*) keeps band 1',
  );
  assert.equal(
    isFallbackOnlyView(view('devin:lane-1', { provider: 'devin' }), native),
    false,
    'no models list fails open',
  );
  assert.equal(
    isFallbackOnlyView(view('codex:lane-1', { provider: 'codex', models: ['gpt-6-sol'] }), native),
    false,
    'natives are never fallback-only',
  );
  assert.equal(
    isFallbackOnlyView(view('devin:lane-1', { provider: 'devin', models: ['gpt-6-sol'], fallbackOnly: false }), native),
    false,
    'explicit flag wins',
  );
});

test('fallback-only aggregator sorts after metered-ahead; unique stays reactive', () => {
  const ids = (views) => orderAccountsForRun(views).map(v => v.accountId);
  assert.deepEqual(ids([
    view('codex:ahead', {
      provider: 'codex', models: ['gpt-6.1-sol'],
      measuredRatePerHour: 0.011, requiredRatePerHour: 0.01,
    }),
    view('devin:dup', { provider: 'devin', meter: 'reactive', headroomPct: null, models: ['gpt-6.1-sol'] }),
  ]), ['codex:ahead', 'devin:dup']);
  assert.deepEqual(ids([
    view('codex:ahead', {
      provider: 'codex', models: ['gpt-6.1-sol'],
      measuredRatePerHour: 0.011, requiredRatePerHour: 0.01,
    }),
    view('devin:unique', { provider: 'devin', meter: 'reactive', headroomPct: null, models: ['swe-2'] }),
  ]), ['devin:unique', 'codex:ahead']);
});

test('hasHeadroom: metered with headroom only; reactive never counts', () => {
  assert.equal(hasHeadroom(view('a', { headroomPct: 0.9 })), true);
  assert.equal(hasHeadroom(view('b', { headroomPct: 0.04 })), false);
  assert.equal(hasHeadroom(view('c', { meter: 'reactive', headroomPct: null })), false);
  assert.equal(hasHeadroom(view('d', { health: 'exhausted', headroomPct: 0.9 })), false);
});

test('version parsing compares dotted generations', () => {
  assert.deepEqual(versionTuple('gpt-6.1-sol'), [6, 1]);
  assert.deepEqual(versionTuple('gpt-6-sol'), [6]);
  assert.ok(compareVersions(versionTuple('gpt-6.1-sol'), versionTuple('gpt-6-sol')) > 0);
  assert.equal(compareVersions(versionTuple('gpt-6-sol'), versionTuple('gpt-6-sol')), 0);
  assert.deepEqual(versionTuple('swe-2'), [2]);
});

const arm = (accountId, armId, family, model, Q, C) => ({ accountId, armId, family, model, Q, C });

test('cross-account dominance: better Sol on qualified Codex drops old Sol on Devin', () => {
  const dominated = crossAccountDominated([
    arm('codex:codex-lane-1', 'gpt-6-1-sol', 'sol', 'gpt-6.1-sol', 0.35, 0.72),
    arm('devin:devin-lane-1', 'gpt-6-sol', 'sol', 'gpt-6-sol', 0.10, 0.72),
  ], new Set(['codex:codex-lane-1']));
  assert.equal(dominated.length, 1);
  assert.equal(dominated[0].accountId, 'devin:devin-lane-1');
  assert.equal(dominated[0].armId, 'gpt-6-sol');
});

test('no dominance when the better arm has no headroom, costs more, or is another family', () => {
  const better = arm('codex:codex-lane-1', 'gpt-6-1-sol', 'sol', 'gpt-6.1-sol', 0.35, 0.72);
  const old = arm('devin:devin-lane-1', 'gpt-6-sol', 'sol', 'gpt-6-sol', 0.10, 0.72);
  assert.equal(crossAccountDominated([better, old], new Set()).length, 0, 'unqualified dominator');
  assert.equal(
    crossAccountDominated([better, old], new Set(['devin:devin-lane-1'])).length, 0,
    'reactive-only qualification never dominates',
  );
  assert.equal(
    crossAccountDominated([
      { ...better, C: 0.90 },
      old,
    ], new Set(['codex:codex-lane-1'])).length, 0,
    'higher cost never dominates',
  );
  assert.equal(
    crossAccountDominated([
      arm('codex:codex-lane-1', 'gpt-6-1-luna', 'luna', 'gpt-6.1-luna', 0.90, 0.10),
      old,
    ], new Set(['codex:codex-lane-1'])).length, 0,
    'another family never dominates',
  );
  assert.equal(
    crossAccountDominated([
      arm('codex:codex-lane-1', 'gpt-6-1-sol', 'sol', 'gpt-6.1-sol', 0.05, 0.72),
      old,
    ], new Set(['codex:codex-lane-1'])).length, 0,
    'lower Q never dominates',
  );
});

test('newer version with equal Q and cost still dominates', () => {
  const dominated = crossAccountDominated([
    arm('codex:codex-lane-1', 'gpt-6-1-sol', 'sol', 'gpt-6.1-sol', 0.30, 0.72),
    arm('devin:devin-lane-1', 'gpt-6-sol', 'sol', 'gpt-6-sol', 0.30, 0.72),
  ], new Set(['codex:codex-lane-1']));
  assert.equal(dominated.length, 1);
});

test('null Q/C arms never dominate and are never dropped here', () => {
  const dominated = crossAccountDominated([
    arm('codex:codex-lane-1', 'ghost', 'sol', 'ghost-sol', null, 0.10),
    arm('devin:devin-lane-1', 'gpt-6-sol', 'sol', 'gpt-6-sol', 0.10, 0.72),
  ], new Set(['codex:codex-lane-1']));
  assert.equal(dominated.length, 0);
});

test('10-11 regression: ahead-of-plan Codex with 91% left beats reactive Devin old Sol', () => {
  // codex-lane-1: 9% used (headroom 0.91) but measured ahead of plan, so
  // band 2. Devin: healthy reactive serving only old Sol, band 1.
  const codex = view('codex:codex-lane-1', {
    provider: 'codex', models: ['gpt-6.1-sol'],
    headroomPct: 0.91, measuredRatePerHour: 0.011, requiredRatePerHour: 0.01,
    placementQ: 0.35,
  });
  const devin = view('devin:devin-lane-1', {
    provider: 'devin', meter: 'reactive', headroomPct: null,
    models: ['gpt-6-sol'], placementQ: 0.10,
  });
  // Dominance removes old Sol from Devin: Codex is qualified with headroom
  // and its Sol scores higher at equal-or-lower cost.
  const dominated = crossAccountDominated([
    arm('codex:codex-lane-1', 'gpt-6-1-sol', 'sol', 'gpt-6.1-sol', 0.35, 0.72),
    arm('devin:devin-lane-1', 'gpt-6-sol', 'sol', 'gpt-6-sol', 0.10, 0.72),
  ], new Set(['codex:codex-lane-1']));
  assert.equal(dominated.length, 1);
  // Devin's ladder is now empty for the role, so the candidate loop skips
  // it and the run lands on Codex gpt-6.1-sol even though Devin orders first.
  const devinArmsLeft = 0;
  const order = orderAccountsForRun([codex, devin]).map(v => v.accountId);
  assert.deepEqual(order[0], 'devin:devin-lane-1', 'bands unchanged: reactive still orders first');
  const eligible = (accountId) => (accountId === 'devin:devin-lane-1' ? devinArmsLeft : 1);
  const pick = order.find(id => eligible(id) > 0);
  assert.equal(pick, 'codex:codex-lane-1', 'empty Devin ladder is skipped: Codex serves gpt-6.1-sol');
});
