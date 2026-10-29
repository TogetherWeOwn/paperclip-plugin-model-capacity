import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

test('offline replay executes the real shadow tick with supplied AA snapshots', async () => {
  const path = new URL('../scripts/aa-replay.mjs', import.meta.url);
  assert.ok(existsSync(path), 'offline replay harness must exist');
  const { replayTick } = await import(path);
  const now = Date.parse('2026-10-29T12:00:00Z');
  const config = { roles: { doerAgentIds: ['doer'], thinkerAgentIds: ['thinker'] } };
  const lane = withSyntheticReadiness({ observedAt: new Date(now).toISOString(), accounts: [{ lane: 'sample', provider: 'meta', accountKey: 'sample', health: 'healthy', models: ['muse-spark-1.3-contributor'], observedAt: new Date(now).toISOString(), quality: 'live', weekly: { used: 0.2, resetsAt: '2026-11-05T12:00:00Z' }, fiveHour: { used: 0.1, resetsAt: '2026-10-29T17:00:00Z' } }] }, now);
  const snapshot = { fetchedAt: new Date(now).toISOString(), rows: [], duplicateSlugs: [] };
  const result = await replayTick({ config, lane, states: {}, snapshot, demand: { doer: 2, thinker: 1, other: 0 }, nowMs: now });
  assert.equal(result.capacity.atMs, now);
  assert.equal(result.ladders.atMs, now);
  assert.equal(result.capacity.demandSource, 'issues');
  assert.equal(result.capacity.supplySignal.doerStarvation.doerDemand, 2);
  const changed = await replayTick({ config, lane, states: {}, snapshot: { ...snapshot, rows: [{ slug: 'muse-spark-1-3-xhigh', intelligenceIndex: 50, intelligenceIndexCostPerTask: 1 }] }, demand: { doer: 2, thinker: 1, other: 0 }, nowMs: now });
  assert.equal(result.capacity.eligibility.arms.length, 0);
  assert.ok(changed.capacity.eligibility.arms.some(arm => arm.armId === 'muse-spark-1-3-xhigh'));
  assert.equal(result.capacity.atMs, changed.capacity.atMs);
});

test('fidelity gate rejects changed capacity before successor comparison', async () => {
  const { assertFidelity } = await import('../scripts/aa-replay.mjs');
  const capacity = { target: 1, targetRaw: 1, roles: {}, eligibility: {}, reviewer: { routing: { arms: [] } }, perAccount: [] };
  const ladders = { ladders: {} };
  assert.doesNotThrow(() => assertFidelity({ capacity, ladders }, { capacity, ladders }));
  assert.throws(() => assertFidelity({ capacity, ladders }, { capacity: { ...capacity, target: 2 }, ladders }), /fidelity/i);
});

test('fidelity gate rejects missing required baseline fields', async () => {
  const { assertFidelity } = await import('../scripts/aa-replay.mjs');
  const incomplete = { capacity: {}, ladders: {} };
  assert.throws(() => assertFidelity(incomplete, incomplete), /fidelity/i);
});

test('buildSuccessor refreshes recorded pages and leaderboard rather than cloning baseline', async () => {
  const {readFile} = await import('node:fs/promises');
  const {buildSuccessor} = await import('../scripts/aa-replay.mjs');
  const pages = await Promise.all([1,2,3,4].map(n => readFile(new URL(`./fixtures/aa-free-20261029-page-${n}.json`, import.meta.url),'utf8')));
  const leaderboard = await readFile(new URL('./fixtures/aa-leaderboard-20261029.html', import.meta.url),'utf8');
  const nowMs = Date.parse('2026-10-29T12:00:00Z');
  const snapshot = {fetchedAt:'2026-10-01T00:00:00Z',intelligenceIndexVersion:'4.0',rows:[{slug:'obsolete-test-model',intelligenceIndex:1}],leaderboardSlugs:[]};
  const next = await buildSuccessor({config:{},states:{},snapshot,nowMs,pages,leaderboard});
  assert.equal(next.fetchedAt,new Date(nowMs).toISOString());
  assert.equal(next.intelligenceIndexVersion,JSON.parse(pages[0]).intelligence_index_version);
  assert.equal(next.pagesFetched,4);
  assert.ok(next.rows.length >= 718);
  assert.ok(next.rows.some(r=>r.slug==='jt-35b-flash' && r.gpqa!=null));
  assert.ok(!next.rows.some(r=>r.slug==='obsolete-test-model'));
  assert.equal(next.leaderboardRows.find(r=>r.slug==='jt-35b-flash').fieldSources.gpqa,'public-leaderboard');
});
