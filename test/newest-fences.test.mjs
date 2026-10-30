import test from 'node:test';
import assert from 'node:assert/strict';
import { crossAccountDominated } from '../src/cross-account.mjs';
import { buildLadder, ladderDominates } from '../src/ladder.mjs';
import { replayTick } from '../scripts/aa-replay.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const flash = { accountId: 'a', armId: 'gemini-3-flash', model: 'gemini-3-flash', family: 'gemini', productLine: 'gemini-flash', parsedVersion: [3], Q: 50, C: 1 };
const lite = { accountId: 'b', armId: 'gemini-3.5-flash-lite', model: 'gemini-3.5-flash-lite', family: 'gemini', productLine: 'gemini-flash-lite', parsedVersion: [3, 5], Q: 50, C: 1 };
const qualified = new Set(['a', 'b']);
const fenced = { requireSameProductForNewer: true };

test('N-T17: cross-account newer gate is opt-in, product-scoped, and does not alter strict dominance', () => {
  assert.equal(crossAccountDominated([flash, lite], qualified).length, 1);
  assert.deepEqual(crossAccountDominated([flash, lite], qualified, fenced), []);
  const newer = { ...lite, productLine: flash.productLine };
  assert.equal(crossAccountDominated([flash, newer], qualified, fenced)[0].armId, flash.armId);
  assert.equal(crossAccountDominated([flash, { ...lite, Q: 51 }], qualified, fenced)[0].armId, flash.armId);
  for (const missing of [{ productLine: null }, { parsedVersion: null }]) {
    assert.deepEqual(crossAccountDominated([flash, { ...newer, ...missing }], qualified, fenced), []);
    assert.equal(crossAccountDominated([flash, { ...newer, ...missing, Q: 51 }], qualified, fenced).length, 1);
  }
  const allowedKeys = new Set([`a\0${flash.armId}`]);
  assert.deepEqual(crossAccountDominated([flash, newer], qualified, { ...fenced, allowedKeys }), []);
});

test('N-T18/T18b: unmanaged tiebreak remains; managed keep survives ties but not strict Pareto', () => {
  const older = { ...flash, accountId: undefined };
  const newer = { ...lite, accountId: undefined };
  assert.deepEqual(buildLadder([older, newer]).rungs.map(r => r.armId), [newer.armId]);
  const managedOld = { ...older, newestVersionManaged: true, newestVersionKept: true };
  const managedNew = { ...newer, newestVersionManaged: true };
  assert.deepEqual(new Set(buildLadder([managedOld, managedNew]).rungs.map(r => r.armId)), new Set([older.armId, newer.armId]));
  assert.equal(ladderDominates(managedNew, managedOld), false);
  assert.equal(ladderDominates({ ...managedNew, Q: 51 }, managedOld), true);
  assert.deepEqual(buildLadder([managedOld, { ...managedNew, Q: 51 }]).dominated, [older.armId]);
});

const nowMs = Date.parse('2026-10-29T12:00:00Z');
const account = (key, models) => ({ lane: key, provider: 'fixture', accountKey: key, health: 'healthy', models, observedAt: new Date(nowMs).toISOString(), quality: 'live', weekly: { used: .2, resetsAt: '2026-11-05T12:00:00Z' }, fiveHour: { used: .1, resetsAt: '2026-10-29T17:00:00Z' } });
async function tick(accounts, enabled, names = [flash.model, lite.model], families = ['gemini', 'gemini']) {
  const lane = withSyntheticReadiness({ observedAt: new Date(nowMs).toISOString(), accounts }, nowMs);
  const armMap = names.map((model, i) => ({ aaSlug: model, model, effort: 'high', family: families[i], providers: ['fixture'] }));
  const snapshot = { fetchedAt: new Date(nowMs).toISOString(), duplicateSlugs: [], rows: names.map(slug => ({ slug, intelligenceIndex: 50, intelligenceIndexCostPerTask: 1 })) };
  return replayTick({ lane, snapshot, states: {}, nowMs, demand: { doer: 1 }, config: { armMap, roles: { newestVersionOnly: { enabled } } } });
}

test('N-T20b: enabled flash and flash-lite survive equal-cost ties on one or two accounts', async () => {
  const names = [flash.model, lite.model];
  const single = [account('one', names)];
  const off = await tick(single, false), on = await tick(single, true);
  assert.equal(off.ladders.ladders['fixture:one'].rungs.length, 1);
  assert.deepEqual(new Set(on.ladders.ladders['fixture:one'].rungs.map(r => r.model)), new Set(names));
  const split = [account('a', [names[0]]), account('b', [names[1]])];
  const offSplit = await tick(split, false), onSplit = await tick(split, true);
  assert.equal(offSplit.ladders.ladders['fixture:a'].rungs.length, 0);
  assert.equal(onSplit.ladders.ladders['fixture:a'].rungs.length, 1);
});

test('N-T20: unrelated families retain identical ladder routing with newest enabled', async () => {
  const names = ['gpt-6-sol', 'gemini-3-flash'];
  const accounts = [account('one', names)];
  const off = await tick(accounts, false, names, ['sol', 'gemini']);
  const on = await tick(accounts, true, names, ['sol', 'gemini']);
  assert.deepEqual(on.ladders.ladders['fixture:one'].rungs.map(r => [r.armId, r.Q, r.C]), off.ladders.ladders['fixture:one'].rungs.map(r => [r.armId, r.Q, r.C]));
  assert.deepEqual(on.capacity.taskRanking?.routeComparisons, off.capacity.taskRanking?.routeComparisons);
});
