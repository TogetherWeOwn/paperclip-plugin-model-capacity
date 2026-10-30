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

function replayInputs() {
  const nowMs = Date.parse('2026-10-29T12:00:00Z');
  return {
    nowMs,
    config: { roles: { keepAgentIds: ['review'], doerAgentIds: ['doer'], thinkerAgentIds: ['thinker'] }, reviewerRouting: { agentIds: ['review'], arms: [{ provider: 'codex', model: 'gpt-6.1-sol' }] } },
    lane: withSyntheticReadiness({ observedAt: new Date(nowMs).toISOString(), accounts: [{ lane: 'codex-a', provider: 'codex', accountKey: 'a', health: 'healthy', models: ['gpt-6.1-sol'], observedAt: new Date(nowMs).toISOString(), quality: 'live', weekly: { used: 0.2, resetsAt: '2026-11-05T12:00:00Z' }, fiveHour: { used: 0.1, resetsAt: '2026-10-29T17:00:00Z' } }] }, nowMs),
    states: {}, snapshot: { fetchedAt: new Date(nowMs).toISOString(), rows: [], duplicateSlugs: [] }, demand: { doer: 2, thinker: 1, other: 0 },
  };
}

test('X-R1: lifecycle generation differs in historical fidelity but not identical replays', async () => {
  const { replayTick, assertFidelity, projectForParity } = await import('../scripts/aa-replay.mjs');
  const input = replayInputs();
  const stored = await replayTick({ ...input, configNotifications: 2 });
  const one = await replayTick(input);
  const again = await replayTick(input);
  assert.equal(stored.capacity.reviewAdmissionGeneration, 2);
  assert.equal(one.capacity.reviewAdmissionGeneration, 1);
  assertFidelity(stored, one);
  assert.deepEqual(projectForParity(one), projectForParity(again));
  assert.notDeepEqual(projectForParity(stored), projectForParity(one));
});

test('X-R4(a): provenance requires a recorded producer and matching replay state', async () => {
  const { assertReplayProvenance } = await import('../scripts/aa-replay.mjs');
  const provenance = { implementationRevision: 'abcd1234', newestVersionOnlyEnabled: true, accountFallbackEnabled: false, capturedAt: '2026-10-30T00:00:00Z' };
  const options = { replayRevision: 'abcd1234', replayFeatureState: { newestVersionOnlyEnabled: true, accountFallbackEnabled: false } };
  assert.doesNotThrow(() => assertReplayProvenance(provenance, options));
  assert.throws(() => assertReplayProvenance(null, options), /provenance/i);
  assert.throws(() => assertReplayProvenance({ ...provenance, capturedAt: undefined }, options), /provenance/i);
  assert.throws(() => assertReplayProvenance(provenance, { ...options, replayRevision: 'a368f5c' }), /provenance/i);
  assert.throws(() => assertReplayProvenance(provenance, { ...options, replayFeatureState: { ...options.replayFeatureState, newestVersionOnlyEnabled: false } }), /provenance/i);
  assert.throws(() => assertReplayProvenance(provenance, { ...options, replayFeatureState: {} }), /provenance/i);
});

test('X-R4(b): fidelity rejects even an empty enabled-newest ladder evidence key', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const { assertFidelity } = await import('../scripts/aa-replay.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'aa-replay-baseline-'));
  try {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const archive = execFileSync('git', ['-C', root, 'archive', 'a368f5c', 'src', 'scripts/aa-replay.mjs', 'package.json']);
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    const { replayTick } = await import(pathToFileURL(join(dir, 'scripts/aa-replay.mjs')).href);
    const input = replayInputs();
    const stored = await replayTick(structuredClone(input));
    const replay = await replayTick(structuredClone(input));
    assertFidelity(stored, replay);
    const key = Object.keys(stored.ladders.ladders)[0];
    assert.ok(key, 'fixture must have a ladder');
    stored.ladders.ladders[key].supersededArmEvidence = [];
    assert.throws(() => assertFidelity(stored, replay), /Replay fidelity failed: ladders/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('X-R4(c,d): enabled producer judges itself; its inputs still support disabled baseline parity', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const { replayTick, assertFidelity, assertReplayProvenance, projectForParity } = await import('../scripts/aa-replay.mjs');
  const input = replayInputs();
  input.config.roles.newestVersionOnly = { enabled: true };
  const producer = await replayTick(input);
  const replay = await replayTick(input);
  assert.ok(producer.capacity.newestVersion);
  assert.ok(Object.keys(producer.ladders.ladders).length > 0, 'enabled producer must publish a ladder');
  assert.ok(Object.values(producer.ladders.ladders).every(ladder => Array.isArray(ladder.supersededArmEvidence)));
  assertReplayProvenance({ implementationRevision: 'producer', newestVersionOnlyEnabled: true, accountFallbackEnabled: false, capturedAt: '2026-10-30T00:00:00Z' }, { replayRevision: 'producer', replayFeatureState: { newestVersionOnlyEnabled: true, accountFallbackEnabled: false } });
  assertFidelity(producer, replay);
  const dir = await mkdtemp(join(tmpdir(), 'aa-replay-baseline-'));
  try {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const archive = execFileSync('git', ['-C', root, 'archive', 'a368f5c', 'src', 'scripts/aa-replay.mjs', 'package.json']);
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    const baseline = await import(pathToFileURL(join(dir, 'scripts/aa-replay.mjs')).href);
    input.config.roles.newestVersionOnly = { enabled: false };
    const old = await baseline.replayTick(structuredClone(input));
    const patched = await replayTick(structuredClone(input));
    assert.deepEqual(projectForParity(old), projectForParity(patched));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('X-R2: post-state replay advances capacity change while fidelity holds', async () => {
  const { replayTick, assertFidelity, projectForParity } = await import('../scripts/aa-replay.mjs');
  const input = replayInputs();
  const transition = await replayTick({ ...input, includeState: true });
  assert.ok(transition.capacity.capacityChange.added.includes('codex:a'));
  assert.ok(transition.state['capacity-change-v1'].accounts.some(account => account.accountId === 'codex:a'));
  const postInput = { ...input, states: transition.state };
  const post = await replayTick(postInput);
  assert.ok(!post.capacity.capacityChange.added.includes('codex:a'));
  assertFidelity(transition, post);
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(), 'aa-replay-baseline-'));
  try {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const archive = execFileSync('git', ['-C', root, 'archive', 'a368f5c', 'src', 'scripts/aa-replay.mjs', 'package.json']);
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    const baseline = await import(pathToFileURL(join(dir, 'scripts/aa-replay.mjs')).href);
    const old = await baseline.replayTick(structuredClone(postInput));
    assert.deepEqual(projectForParity(post), projectForParity(old));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('X-R4(a): replay CLI rejects inadmissible captures before loading fidelity fixtures', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(), 'aa-replay-cli-'));
  try {
    const capture = { configs: [{ config_json: {} }], states: [{ stateKey: 'capacity-v1', value: { atMs: 1, roles: { doer: {}, thinker: {}, other: {} } } }, { stateKey: 'ladder-v1', value: { atMs: 1 } }] };
    await writeFile(join(dir, 'lane-body.json'), '{}');
    const script = fileURLToPath(new URL('../scripts/aa-replay.mjs', import.meta.url));
    for (const provenance of [undefined, { implementationRevision: 'another-revision', newestVersionOnlyEnabled: false, accountFallbackEnabled: false, capturedAt: '2026-10-30T00:00:00Z' }]) {
      await writeFile(join(dir, 'fresh-state.json'), JSON.stringify({ ...capture, provenance }));
      const run = spawnSync(process.execPath, [script, dir, join(dir, 'no-fixtures'), 'test-revision'], { encoding: 'utf8' });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /provenance/i);
      assert.doesNotMatch(run.stderr, /fidelity|ENOENT/i);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('synthetic Gate S compares baseline and patched for absent, false and malformed flags', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const { replayTick, projectForParity } = await import('../scripts/aa-replay.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'aa-replay-parity-'));
  try {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const archive = execFileSync('git', ['-C', root, 'archive', 'a368f5c', 'src', 'scripts/aa-replay.mjs', 'package.json']);
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    const baseline = await import(pathToFileURL(join(dir, 'scripts/aa-replay.mjs')).href);
    for (const features of [{}, { newestVersionOnly: { enabled: false }, accountFallback: { enabled: false } },
      { newestVersionOnly: { enabled: 'true' }, accountFallback: { enabled: 'true' } }]) {
      const input = replayInputs();
      Object.assign(input.config.roles, features);
      const old = await baseline.replayTick(structuredClone(input));
      const patched = await replayTick(structuredClone(input));
      assert.equal(Object.hasOwn(old.capacity, 'reviewAdmissionEpoch'), Object.hasOwn(patched.capacity, 'reviewAdmissionEpoch'));
      for (const output of [old, patched]) assert.match(output.capacity.reviewAdmissionEpoch, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.deepEqual(projectForParity(old), projectForParity(patched));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
