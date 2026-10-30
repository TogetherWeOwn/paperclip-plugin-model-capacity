import test from 'node:test';
import assert from 'node:assert/strict';
import { replayTick } from '../scripts/aa-replay.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const nowMs = Date.parse('2026-10-29T12:00:00Z');
const models = ['gpt-6-luna', 'gpt-6.1-luna'];
const metrics = n => ({ terminalbenchV40: n, scicode: n, lcr: n, ifbench: n, omniscienceNonHallucination: n, hle: n, gpqa: n, critpt: n, gdpvalNormalized: n });
const lane = withSyntheticReadiness({ observedAt: new Date(nowMs).toISOString(), accounts: [{
  lane: 'one', provider: 'codex', accountKey: 'one', health: 'healthy', quality: 'live', models,
  observedAt: new Date(nowMs).toISOString(), weekly: { used: .1, resetsAt: '2026-11-05T12:00:00Z' },
  fiveHour: { used: .1, resetsAt: '2026-10-29T17:00:00Z' },
}] }, nowMs);
const armMap = models.map((model, i) => ({ aaSlug: ['gpt-6-luna-high', 'gpt-6-1-luna-high'][i], model, effort: 'high', family: 'luna', providers: ['codex'] }));
const snapshot = { fetchedAt: new Date(nowMs).toISOString(), duplicateSlugs: [], rows: armMap.map((a, i) => ({
  slug: a.aaSlug, intelligenceIndex: 50 + i * 10, intelligenceIndexCostPerTask: 1 + i, ...metrics(.6 + .1 * i),
})) };
const run = (mode, { enabled = true, keep = [], states = {}, feed = lane, enforceReadiness = false } = {}) => replayTick({ lane: feed, snapshot, states, nowMs, demand: { doer: 1 }, config: {
  armMap, credentialReadiness: { enforce: enforceReadiness }, roles: { newestVersionOnly: { enabled, overrides: { keep } }, minQuality: { doer: null, thinker: null, other: null } }, taskRanking: { mode },
} });

test('N-T11/T24: shadow and enforce mark older task arms and fence every role frontier', async () => {
  for (const mode of ['shadow', 'enforce']) {
    const result = await run(mode);
    const view = result.capacity.newestVersion.accounts['codex:one'];
    const ladder = result.ladders.ladders['codex:one'];
    assert.deepEqual(view.supersededTaskArmIds, ['gpt-6-luna@high']);
    for (const role of ['doer', 'thinker', 'other', 'reviewer']) {
      const ranking = ladder.taskRoles[role];
      const old = ranking.candidates.find(c => c.armId === 'gpt-6-luna@high');
      const newest = ranking.candidates.find(c => c.armId === 'gpt-6-1-luna@high');
      assert.ok(old, role);
      assert.ok(newest, role);
      for (const [candidate, version] of [[old, [6]], [newest, [6, 1]]]) {
        assert.equal(candidate.productLine, 'gpt-luna', role);
        assert.deepEqual(candidate.parsedVersion, version, role);
        assert.equal(candidate.newestVersionManaged, true, role);
      }
      assert.equal(old.selectionReason, 'superseded-version');
      assert.equal(old.eligible, false);
      assert.equal(old.benchmarkEligible, false);
      assert.ok(ranking.excludedArmIds.includes(old.armId));
      assert.ok(ranking.rankingRungs.every(r => r.armId !== old.armId));
      assert.ok(ranking.rankingRungs.some(r => r.armId === 'gpt-6-1-luna@high'), role);
    }
  }
});


test('task arm keep is effort-scoped and remains out of superseded exclusions', async () => {
  const result = await run('enforce', { keep: ['arm:gpt-6-luna@high'] });
  const view = result.capacity.newestVersion.accounts['codex:one'];
  const role = result.ladders.ladders['codex:one'].taskRoles.doer;
  const old = role.candidates.find(c => c.armId === 'gpt-6-luna@high');
  assert.equal(old.newestVersionKept, true);
  assert.equal(old.eligible, true);
  assert.ok(!view.supersededTaskArmIds.includes(old.armId));
  assert.ok(!role.excludedArmIds.includes(old.armId));
});

test('N-T24: enabling with an old persisted task ladder cannot revive it when the newer credential loses readiness', async () => {
  const off = await run('enforce', { enabled: false });
  const feed = structuredClone(lane);
  feed.accounts[0].credentialAvailability.models.find(a => a.model === models[1]).readyCredentials = 0;
  const on = await run('enforce', { states: { 'ladder-v1': off.ladders }, feed, enforceReadiness: true });
  const ranking = on.ladders.ladders['codex:one'].taskRoles.doer;
  assert.ok(ranking.excludedArmIds.includes('gpt-6-luna@high'));
  const comparisons = on.capacity.taskRanking.routeComparisons;
  assert.ok(comparisons.length);
  assert.ok(comparisons.every(c => c.proposed?.model !== models[0]));
});

test('enabled accounts with no task candidates still publish empty task exclusion lists', async () => {
  const result = await replayTick({ lane, snapshot: { ...snapshot, rows: [] }, states: {}, nowMs, demand: { doer: 1 }, config: {
    armMap, roles: { newestVersionOnly: { enabled: true } }, taskRanking: { mode: 'shadow' },
  } });
  const ladder = result.ladders.ladders['codex:one'];
  for (const role of ['doer', 'thinker', 'other', 'reviewer'])
    assert.deepEqual(ladder.taskRoles[role].excludedArmIds, []);
});
