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

test('X-R0: baseline replay self-consistency has only an epoch difference', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const { projectForParity } = await import('../scripts/aa-replay.mjs');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'aa-replay-baseline-'));
  try {
    const archive = execFileSync('git', ['-C', root, 'archive', 'a368f5c', 'src', 'scripts/aa-replay.mjs', 'package.json']);
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    const { replayTick } = await import(pathToFileURL(join(dir, 'scripts/aa-replay.mjs')).href);
    const nowMs = Date.parse('2026-10-29T12:00:00Z');
    const config = { roles: { keepAgentIds: ['review'], doerAgentIds: ['doer'], thinkerAgentIds: ['thinker'] }, reviewerRouting: { agentIds: ['review'], arms: [{ provider: 'codex', model: 'gpt-6.1-sol' }] } };
    const lane = withSyntheticReadiness({ observedAt: new Date(nowMs).toISOString(), accounts: [{ lane: 'codex-a', provider: 'codex', accountKey: 'a', health: 'healthy', models: ['gpt-6.1-sol'], observedAt: new Date(nowMs).toISOString(), quality: 'live', weekly: { used: 0.2, resetsAt: '2026-11-05T12:00:00Z' }, fiveHour: { used: 0.1, resetsAt: '2026-10-29T17:00:00Z' } }] }, nowMs);
    const inputs = { config, lane, states: {}, snapshot: { fetchedAt: new Date(nowMs).toISOString(), rows: [], duplicateSlugs: [] }, demand: { doer: 2, thinker: 1, other: 0 }, nowMs };
    const a = await replayTick(structuredClone(inputs));
    const b = await replayTick(structuredClone(inputs));
    const diff = (x, y, prefix = '') => {
      if (Object.is(x, y)) return [];
      if (x && y && typeof x === 'object' && typeof y === 'object' && Array.isArray(x) === Array.isArray(y)) {
        return [...new Set([...Object.keys(x), ...Object.keys(y)])].flatMap(k => diff(x[k], y[k], prefix ? `${prefix}.${k}` : k));
      }
      return [prefix];
    };
    assert.deepEqual(diff(a.capacity, b.capacity), ['reviewAdmissionEpoch']);
    assert.deepEqual(a.ladders, b.ladders);
    assert.equal(a.capacity.reviewAdmissionGeneration, b.capacity.reviewAdmissionGeneration);
    assert.deepEqual(a.capacity.capacityChange, b.capacity.capacityChange);
    for (const result of [a, b]) assert.match(result.capacity.reviewAdmissionEpoch, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.deepEqual(projectForParity(a), projectForParity(b));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
