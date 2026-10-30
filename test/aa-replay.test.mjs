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

// Weekly-compatible reference: synthetic assembly, never a live capture.
// Implementation is src+package from the pinned weekly revision; harness is the
// unchanged current offline replay script copied into the assembly. The replay
// script did not exist on the pinned revision.
const WEEKLY_IMPLEMENTATION_REVISION = '77d8049bb50b3a8bf15be66873580add9040c66b';
const WEEKLY_IMPLEMENTATION_TREE = '6d7d8c7895e2db20fa4d1a627ad9a947c1dca37b';
const REPLAY_HARNESS_SHA256 = 'adf0d02c908057342e47efdaf985a71f37868807ab130cac69b6f3ebd0063b14';
async function loadWeeklyReference() {
  const { mkdtemp, rm, mkdir, copyFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const { createHash } = await import('node:crypto');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'aa-replay-weekly-'));
  try {
    const tree = execFileSync('git', ['-C', root, 'rev-parse', `${WEEKLY_IMPLEMENTATION_REVISION}^{tree}`], { encoding: 'utf8' }).trim();
    assert.equal(tree, WEEKLY_IMPLEMENTATION_TREE);
    const archive = execFileSync('git', ['-C', root, 'archive', WEEKLY_IMPLEMENTATION_REVISION, 'src', 'package.json']);
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await copyFile(fileURLToPath(new URL('../scripts/aa-replay.mjs', import.meta.url)), join(dir, 'scripts/aa-replay.mjs'));
    const harnessBytes = await readFile(join(dir, 'scripts/aa-replay.mjs'));
    assert.equal(createHash('sha256').update(harnessBytes).digest('hex'), REPLAY_HARNESS_SHA256);
    const mod = await import(pathToFileURL(join(dir, 'scripts/aa-replay.mjs')).href);
    return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
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
  // Disabled newest must match the weekly reference.
  const { mod: weekly, cleanup } = await loadWeeklyReference();
  try {
    input.config.roles.newestVersionOnly = { enabled: false };
    const ref = await weekly.replayTick(structuredClone(input));
    const patched = await replayTick(structuredClone(input));
    assert.deepEqual(projectForParity(ref), projectForParity(patched));
  } finally { await cleanup(); }
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
  // Post-state must match the weekly reference for the same stored state.
  const { mod: weekly, cleanup } = await loadWeeklyReference();
  try {
    const ref = await weekly.replayTick(structuredClone(postInput));
    assert.deepEqual(projectForParity(post), projectForParity(ref));
  } finally { await cleanup(); }
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
  const { replayTick, projectForParity } = await import('../scripts/aa-replay.mjs');
  // Absent/false/malformed flags must match the weekly reference.
  const { mod: weekly, cleanup } = await loadWeeklyReference();
  try {
    for (const features of [{}, { newestVersionOnly: { enabled: false }, accountFallback: { enabled: false } },
      { newestVersionOnly: { enabled: 'true' }, accountFallback: { enabled: 'true' } }]) {
      const input = replayInputs();
      Object.assign(input.config.roles, features);
      const ref = await weekly.replayTick(structuredClone(input));
      const patched = await replayTick(structuredClone(input));
      assert.equal(Object.hasOwn(ref.capacity, 'reviewAdmissionEpoch'), Object.hasOwn(patched.capacity, 'reviewAdmissionEpoch'));
      for (const output of [ref, patched]) assert.match(output.capacity.reviewAdmissionEpoch, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.deepEqual(projectForParity(ref), projectForParity(patched));
    }
  } finally { await cleanup(); }
});

test('Historical-to-weekly migration pins six intended paths for reviewer fixture', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const { projectForParity } = await import('../scripts/aa-replay.mjs');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const histDir = await mkdtemp(join(tmpdir(), 'aa-replay-hist-'));
  const { mod: weekly, cleanup: weeklyCleanup } = await loadWeeklyReference();
  try {
    const archive = execFileSync('git', ['-C', root, 'archive', 'a368f5c', 'src', 'scripts/aa-replay.mjs', 'package.json']);
    execFileSync('tar', ['-x', '-C', histDir], { input: archive });
    const hist = await import(pathToFileURL(join(histDir, 'scripts/aa-replay.mjs')).href);
    const input = replayInputs();
    const old = await hist.replayTick(structuredClone(input));
    const ref = await weekly.replayTick(structuredClone(input));
    const oldProj = projectForParity(old);
    const refProj = projectForParity(ref);
    const diff = (x, y, prefix = '') => {
      if (Object.is(x, y)) return [];
      if (x && y && typeof x === 'object' && typeof y === 'object' && Array.isArray(x) === Array.isArray(y)) {
        return [...new Set([...Object.keys(x), ...Object.keys(y)])].flatMap(k => diff(x[k], y[k], prefix ? `${prefix}.${k}` : k));
      }
      return [prefix];
    };
    const paths = diff(oldProj, refProj);
    // Six intended paths only; undeclared routing/ladder/capacity changes add more.
    assert.deepEqual([...paths].sort(), [
      'capacity.accounts.0.planTargetUsedPct',
      'capacity.accounts.0.spendableRemaining',
      'capacity.paceGuard.holdAheadPts',
      'capacity.paceGuard.rawPools',
      'capacity.paceGuard.roleSafety',
      'capacity.reviewerPaceByAgent',
    ]);
    // Explicit migration literals for this floor=0 fixture (raw and spendable
    // both read 0.8 here; floor-sensitive spendable math is covered elsewhere).
    assert.equal(refProj.capacity.accounts[0].planTargetUsedPct, 1);
    assert.equal(oldProj.capacity.accounts[0].planTargetUsedPct, undefined);
    assert.equal(refProj.capacity.accounts[0].spendableRemaining, 0.8);
    assert.equal(oldProj.capacity.accounts[0].spendableRemaining, undefined);
    assert.equal(refProj.capacity.paceGuard.holdAheadPts, 0.1);
    assert.equal(oldProj.capacity.paceGuard.holdAheadPts, undefined);
    assert.deepEqual(refProj.capacity.paceGuard.roleSafety, []);
    assert.equal(oldProj.capacity.paceGuard.roleSafety, undefined);
    assert.deepEqual(refProj.capacity.paceGuard.rawPools, [{ pool: 'codex', lanes: 1, planAhead: 0.2, pacedSlots: 0, cap: 0, inFlight: 0, ahead: true, paced: true, state: 'hard-held', pacedAccountIds: ['codex:a'], hardHeldAccountIds: ['codex:a'] }]);
    assert.equal(oldProj.capacity.paceGuard.rawPools, undefined);
    assert.deepEqual(refProj.capacity.reviewerPaceByAgent, { review: { holdSuspendedAccountIds: [], pools: [] } });
    assert.equal(oldProj.capacity.reviewerPaceByAgent, undefined);
  } finally {
    await weeklyCleanup();
    await rm(histDir, { recursive: true, force: true });
  }
});

// A widened projection could hide a routing or lifecycle regression even when
// two particular replay fixtures happen to agree. Pin the closed contract with
// independent sentinels, including fields outside Gate H's seven-field subset.
test('X-R0/X-R1: parity projects only the epoch value, never presence or other fields', async () => {
  const { projectForParity } = await import('../scripts/aa-replay.mjs');
  const input = {
    capacity: { reviewAdmissionEpoch: 'instance-epoch', reviewAdmissionGeneration: 2,
      capacityChange: { added: ['account-x'], removed: [] }, target: 7,
      newestVersion: { enabled: true }, perAccount: [{ accountId: 'account-x', inFlight: 3 }] },
    ladders: { ladders: { 'account-x': { supersededArmEvidence: [], rungs: [] } } },
    diagnostics: [],
  };
  const before = structuredClone(input);
  assert.deepEqual(projectForParity(input), {
    capacity: { reviewAdmissionEpoch: '<epoch>', reviewAdmissionGeneration: 2,
      capacityChange: { added: ['account-x'], removed: [] }, target: 7,
      newestVersion: { enabled: true }, perAccount: [{ accountId: 'account-x', inFlight: 3 }] },
    ladders: { ladders: { 'account-x': { supersededArmEvidence: [], rungs: [] } } },
    diagnostics: [],
  });
  assert.deepEqual(input, before, 'the original capture must remain unmodified');
  const absent = { capacity: { target: 7 }, ladders: { ladders: {} } };
  assert.deepEqual(projectForParity(absent), absent, 'a missing epoch must not be manufactured');
  assert.notStrictEqual(projectForParity(absent).capacity, absent.capacity);
});

test('X-R3 offline scope: synthetic tick uses the supplied clock, not wall-clock defaults', async () => {
  const { replayTick, projectForParity } = await import('../scripts/aa-replay.mjs');
  const input = replayInputs();
  const wallClock = Date.now;
  try {
    Date.now = () => { throw new Error('uncontrolled wall-clock read in synthetic replay'); };
    let first, second;
    await assert.doesNotReject(async () => {
      first = await replayTick(structuredClone(input));
      second = await replayTick(structuredClone(input));
    }, 'replay must not fall through to an unpinned wall clock');
    assert.equal(first.capacity.atMs, input.nowMs);
    assert.equal(first.ladders.atMs, input.nowMs);
    assert.deepEqual(projectForParity(first), projectForParity(second));
  } finally { Date.now = wallClock; }
});

test('X-R4(a): provenance also fences the fallback flag and rejects unresolved feature states', async () => {
  const { assertReplayProvenance } = await import('../scripts/aa-replay.mjs');
  const provenance = { implementationRevision: 'producer', newestVersionOnlyEnabled: true,
    accountFallbackEnabled: false, capturedAt: '2026-10-30T00:00:00Z' };
  const options = { replayRevision: 'producer', replayFeatureState: {
    newestVersionOnlyEnabled: true, accountFallbackEnabled: false } };
  assert.doesNotThrow(() => assertReplayProvenance(provenance, options));
  assert.throws(() => assertReplayProvenance(provenance, { ...options,
    replayFeatureState: { ...options.replayFeatureState, accountFallbackEnabled: true } }), /provenance/i);
  for (const unresolved of [undefined, 'false', 0, null]) {
    assert.throws(() => assertReplayProvenance({ ...provenance, accountFallbackEnabled: unresolved }, options), /provenance/i);
    assert.throws(() => assertReplayProvenance(provenance, { ...options,
      replayFeatureState: { ...options.replayFeatureState, accountFallbackEnabled: unresolved } }), /provenance/i);
  }
});
