import test from 'node:test';
import assert from 'node:assert/strict';
import { replayTick } from '../scripts/aa-replay.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

// Routing fixtures use allowed synthetic versions, retaining the captured
// product ordering and cohort size without bypassing mandatory model bans.
const allowedFixtureText = text => String(text)
  .replaceAll('gpt-6-sol', 'gpt-6.0-sol')
  .replaceAll('gpt-5.6-terra', 'gpt-5.7-terra');

const nowMs = Date.parse('2026-10-29T12:00:00Z');
const models = ['muse-spark-1.3-contributor', 'muse-spark-1.4-contributor'];
const lane = withSyntheticReadiness({ observedAt: new Date(nowMs).toISOString(), accounts: [{ lane: 'sample', provider: 'meta', accountKey: 'sample', health: 'healthy', models, observedAt: new Date(nowMs).toISOString(), quality: 'live', weekly: { used: 0.2, resetsAt: '2026-11-05T12:00:00Z' }, fiveHour: { used: 0.1, resetsAt: '2026-10-29T17:00:00Z' } }] }, nowMs);
const snapshot = { fetchedAt: new Date(nowMs).toISOString(), rows: [{ slug: 'muse-spark-1-3-xhigh', intelligenceIndex: 50, intelligenceIndexCostPerTask: 1 }, { slug: 'muse-spark-1-4-xhigh', intelligenceIndex: 55, intelligenceIndexCostPerTask: 2 }], duplicateSlugs: [] };
const base = { lane, snapshot, states: {}, demand: { doer: 2, thinker: 1, other: 0 }, nowMs };
const config = enabled => ({ roles: { doerAgentIds: ['doer'], thinkerAgentIds: ['thinker'], newestVersionOnly: { enabled } } });
const ladder = result => Object.values(result.ladders.ladders)[0];
const accountView = result => Object.values(result.capacity.newestVersion.accounts)[0];

test('N-T09/T10: older scored arm is excluded even when the newer credential is unavailable', async () => {
  const result = await replayTick({ ...base, config: config(true) });
  const view = accountView(result), l = ladder(result);
  assert.deepEqual(view.supersededCanonicalModels, [models[0]]);
  assert.ok(view.supersededLegacyArmIds.length > 0);
  assert.ok(view.rejectedCandidates.some(c => c.model === models[0]));
  assert.ok(l.supersededArmEvidence.some(e => e.model === models[0] && e.kept === false));
  assert.ok(l.credentialRanking.excludedArmIds.includes(view.supersededLegacyArmIds[0]));
  assert.ok(l.credentialRanking.candidates.every(c => c.model !== models[0]));
  assert.ok(l.rungs.every(c => c.model !== models[0]));
  const unavailable = structuredClone(lane);
  // Preserve the served universe while revoking only the newer credential.
  unavailable.accounts[0].credentialAvailability.models.find(row => row.model === models[1]).readyCredentials = 0;
  const failed = await replayTick({ ...base, lane: unavailable, config: { ...config(true), credentialReadiness: { enforce: true } } });
  assert.equal(failed.capacity.credentialAvailability.alarm, false);
  assert.deepEqual(ladder(failed).rungs, []);
});

test('N-T22: enabling after an off-persisted ladder cannot restore an older arm', async () => {
  const off = await replayTick({ ...base, config: config(false) });
  const on = await replayTick({ ...base, config: config(true), states: { 'ladder-v1': off.ladders } });
  assert.ok(ladder(on).rungs.every(c => c.model !== models[0]));
  assert.ok(ladder(on).credentialRanking.candidates.every(c => c.model !== models[0]));
  assert.ok(accountView(on).supersededLegacyArmIds.length > 0);
});

test('N3: scoped keep retains only its legacy arm and remains evidence, not exclusion', async () => {
  const off = await replayTick({ ...base, config: config(false) });
  const old = ladder(off).credentialRanking.candidates.find(c => c.model === models[0]);
  assert.ok(old);
  const enabled = config(true);
  enabled.roles.newestVersionOnly.overrides = { keep: [`arm:${old.armId}`] };
  const on = await replayTick({ ...base, config: enabled });
  const l = ladder(on), v = accountView(on);
  assert.ok(l.credentialRanking.candidates.some(c => c.armId === old.armId && c.newestVersionKept));
  assert.ok(l.supersededArmEvidence.some(e => e.armId === old.armId && e.kept));
  assert.ok(!v.supersededLegacyArmIds.includes(old.armId));
  assert.ok(!v.rejectedCandidates.some(c => c.armId === old.armId));
});

test('N-T21 legacy: captured fleet has exact per-account supersession sets and retains each product maximum', async () => {
  const { readFile } = await import('node:fs/promises');
  const { accounts } = JSON.parse(allowedFixtureText(await readFile(new URL('./fixtures/newest-served-20261029.json', import.meta.url))));
  const arms = JSON.parse(allowedFixtureText(await readFile(new URL('./fixtures/newest-scored-20261029.json', import.meta.url))));
  const expected = [
    ...Array(4).fill(['claude-haiku-4-5-20251001','claude-sonnet-5']),
    ['gpt-5.7-terra','gpt-6.0-sol'], ['gpt-5.7-terra'], ['gpt-5.7-terra','gpt-6.0-sol'], ['gpt-5.7-terra','gpt-6.0-sol'],
    ['gemini-3-flash','gemini-3.1-flash-lite'], ['gemini-3-flash','gemini-3.1-flash-lite'], [],
    ...Array(3).fill(['muse-spark-1.1','muse-spark-1.2']), [], ['glm-4.7-flash'], [],
    ['deepseek-v4-flash-free','muse-spark-1.2-contributor-free'],
  ];
  const raw = withSyntheticReadiness({ observedAt: new Date(nowMs).toISOString(), accounts: accounts.map(a => ({
    provider: 'fixture', accountKey: a.id, health: 'healthy', meter: 'reactive', models: a.models,
    observedAt: new Date(nowMs).toISOString(), quality: 'live',
  })) }, nowMs);
  const armMap = arms.map(a => ({ aaSlug: a.armId, model: a.model, effort: a.effort, family: 'fixture', providers: ['fixture'] }));
  const scored = { fetchedAt: new Date(nowMs).toISOString(), duplicateSlugs: [], rows: arms.map((a, i) => ({
    slug: a.armId, intelligenceIndex: 40 + i, intelligenceIndexCostPerTask: 1 + i,
  })) };
  const result = await replayTick({ ...base, lane: raw, snapshot: scored, config: { ...config(true), armMap } });
  for (let i = 0; i < accounts.length; i++) {
    const key = `fixture:${accounts[i].id}`;
    const view = result.capacity.newestVersion.accounts[key], l = result.ladders.ladders[key];
    assert.deepEqual(view.supersededCanonicalModels, expected[i], key);
    const actualLegacy = expected[i].filter(model => arms.some(arm => arm.model === model)).sort();
    assert.deepEqual(view.supersededLegacyArmIds, actualLegacy, key);
    assert.ok(l.credentialRanking.candidates.every(c => !actualLegacy.includes(c.armId)), key);
    for (const group of Object.values(view.byProduct)) {
      assert.ok(group.membersAtMax.every(model => !view.supersededCanonicalModels.includes(model)), key);
    }
  }
});

test('N3: cross-account dominance preserves superseded exclusions in the same ladder', async () => {
  const names = ['gpt-5-sol', 'gpt-6.0-sol', 'gpt-6.1-sol'];
  const account = (key, served) => ({ lane: key, provider: 'fixture', accountKey: key, health: 'healthy', models: served,
    observedAt: new Date(nowMs).toISOString(), quality: 'live',
    weekly: { used: 0.2, resetsAt: '2026-11-05T12:00:00Z' },
    fiveHour: { used: 0.1, resetsAt: '2026-10-29T17:00:00Z' } });
  const twoAccounts = withSyntheticReadiness({ observedAt: new Date(nowMs).toISOString(), accounts: [
    account('old', names.slice(0, 2)), account('new', names.slice(2)),
  ] }, nowMs);
  const armMap = names.map(model => ({ aaSlug: model, model, effort: 'max', family: 'sol', providers: ['fixture'] }));
  const scores = { fetchedAt: new Date(nowMs).toISOString(), duplicateSlugs: [], rows: names.map((slug, i) => ({
    slug, intelligenceIndex: 50 + i * 10, intelligenceIndexCostPerTask: 3 - i,
  })) };
  const result = await replayTick({ ...base, lane: twoAccounts, snapshot: scores, config: { ...config(true), armMap } });
  const l = result.ladders.ladders['fixture:old'];
  assert.deepEqual(l.crossAccountDominated, [names[1]]);
  assert.deepEqual(result.capacity.newestVersion.accounts['fixture:old'].supersededLegacyArmIds, [names[0]]);
  assert.deepEqual(new Set(l.credentialRanking.excludedArmIds), new Set(names.slice(0, 2)));
  const reverse = structuredClone(twoAccounts);
  reverse.accounts.reverse();
  const reversed = await replayTick({ ...base, lane: reverse, snapshot: scores, config: { ...config(true), armMap } });
  assert.deepEqual(new Set(reversed.ladders.ladders['fixture:old'].credentialRanking.excludedArmIds), new Set(names.slice(0, 2)));
});

test('X-T03: full-fleet newest and fallback flag matrix preserves supersession boundaries', async t => {
  const { readFile } = await import('node:fs/promises');
  const { accounts } = JSON.parse(allowedFixtureText(await readFile(new URL('./fixtures/newest-served-20261029.json', import.meta.url))));
  const arms = JSON.parse(allowedFixtureText(await readFile(new URL('./fixtures/newest-scored-20261029.json', import.meta.url))));
  const old = 'claude-sonnet-5', newer = 'claude-sonnet-5-5';
  const served = [...accounts, { id: 'matrix-weak', models: [old, newer] }];
  const fleet = withSyntheticReadiness({ observedAt: new Date(nowMs).toISOString(), accounts: served.map(a => ({
    provider: 'fixture', accountKey: a.id, health: 'healthy', meter: 'reactive', models: a.models,
    observedAt: new Date(nowMs).toISOString(), quality: 'live',
  })) }, nowMs);
  const armMap = arms.map(a => ({ aaSlug: a.armId, model: a.model, effort: a.effort, family: a.model === old || a.model === newer ? 'sonnet' : a.armId, providers: ['fixture'] }));
  const scored = { fetchedAt: new Date(nowMs).toISOString(), duplicateSlugs: [], rows: arms.map((a, i) => ({ slug: a.armId, intelligenceIndex: 40 + i, intelligenceIndexCostPerTask: 1 + i })) };
  const results = new Map();
  let disabledConfig;
  for (const newest of [false, true]) for (const fallback of [false, true]) {
    const settings = { armMap, roles: { doerAgentIds: ['doer'], thinkerAgentIds: ['thinker'], minQuality: { doer: 0.12, thinker: null, other: null },
      outcomeGate: { enabled: false }, newestVersionOnly: { enabled: newest }, accountFallback: { enabled: fallback, roles: ['doer'], minQuality: -3 } } };
    const result = await replayTick({ ...base, lane: fleet, snapshot: scored, config: settings });
    if (!newest && !fallback) disabledConfig = settings;
    results.set(`${newest}:${fallback}`, result);
    assert.equal(Object.hasOwn(result.capacity.eligibility, 'accountFallback'), fallback);
    if (newest) {
      const view = result.capacity.newestVersion.accounts['fixture:matrix-weak'];
      assert.deepEqual(view.supersededCanonicalModels, [old]);
      const rows = result.capacity.eligibility.accountFallback?.admitted ?? [];
      assert.ok(rows.every(row => row.accountId !== 'fixture:matrix-weak' || row.armId !== old));
      assert.ok(rows.every(row => row.accountId !== 'fixture:matrix-weak' || !view.rejectedCandidates.some(candidate => candidate.armId === row.armId)));
    }
  }
  const diffPaths = (a, b, path = '') => {
    if (Object.is(a, b)) return [];
    if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
      return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key => diffPaths(a[key], b[key], path ? `${path}.${key}` : key));
    }
    return [path];
  };
  for (const newest of [false, true]) {
    const off = results.get(`${newest}:false`), on = results.get(`${newest}:true`);
    const { projectForParity } = await import('../scripts/aa-replay.mjs');
    const paths = diffPaths(projectForParity(off), projectForParity(on));
    // This fixture exercises a narrow subset of §8's allowlist; fail closed for
    // every other path, including all non-admitted account picks and translated exclusions.
    const allowed = /^(capacity\.eligibility\.accountFallback|capacity\.eligibility\.warnings\.\d+|capacity\.eligibility\.arms\.\d+\.eligible\.(doer|thinker|other)\.reasons\.\d+|capacity\.taskRanking\.routeComparisons\.\d+\.(legacy|current|changed))$/;
    t.diagnostic(`Synthetic E-F newest=${newest} paths: ${JSON.stringify(paths)}`);
    assert.ok(paths.length > 0, 'fallback toggle must exercise the gate');
    assert.deepEqual(paths.filter(path => !allowed.test(path)), [], `E-F newest=${newest}: ${paths.join(', ')}`);
    assert.deepEqual(off.ladders, on.ladders, 'ladder-v1 is literal');
    for (const field of ['reviewer', 'reviewReserve', 'roleExclusions', 'roleExclusionsEffective', 'newestVersion', 'perAccount']) {
      assert.deepEqual(off.capacity[field], on.capacity[field], `E-F denylist ${field}`);
    }
    for (const field of ['minQuality', 'outcomeGate', 'manual']) {
      assert.deepEqual(off.capacity.eligibility[field], on.capacity.eligibility[field], `E-F denylist eligibility.${field}`);
    }
    assert.deepEqual(off.capacity.taskRanking?.translatedExclusions, on.capacity.taskRanking?.translatedExclusions);
    for (const [i, arm] of off.capacity.eligibility.arms.entries()) {
      const changed = on.capacity.eligibility.arms[i];
      for (const role of ['doer', 'thinker', 'other']) {
        assert.equal(arm.eligible[role].ok, changed.eligible[role].ok);
        const added = changed.eligible[role].reasons.filter(reason => !arm.eligible[role].reasons.includes(reason));
        const removed = arm.eligible[role].reasons.filter(reason => !changed.eligible[role].reasons.includes(reason));
        assert.deepEqual(removed, []);
        assert.ok(added.every(reason => typeof reason === 'string' && reason.startsWith('account-fallback-admitted: ')));
      }
    }
    const oldWarnings = off.capacity.eligibility.warnings;
    const newWarnings = on.capacity.eligibility.warnings;
    assert.ok(oldWarnings.every(warning => newWarnings.some(next => JSON.stringify(next) === JSON.stringify(warning))));
    assert.ok(newWarnings.filter(warning => !oldWarnings.some(old => JSON.stringify(old) === JSON.stringify(warning))).every(warning => warning.code.startsWith('account-fallback-')));
  }
  const both = results.get('true:true');
  const weak = both.capacity.eligibility.accountFallback.admitted.find(row => row.accountId === 'fixture:matrix-weak' && row.role === 'doer');
  assert.equal(weak?.armId, 'claude-sonnet-5-5-xhigh');
  const newestOnly = results.get('true:false');
  const expected = [
    ...Array(4).fill(['claude-haiku-4-5-20251001', 'claude-sonnet-5']),
    ['gpt-5.7-terra', 'gpt-6.0-sol'], ['gpt-5.7-terra'], ['gpt-5.7-terra', 'gpt-6.0-sol'], ['gpt-5.7-terra', 'gpt-6.0-sol'],
    ['gemini-3-flash', 'gemini-3.1-flash-lite'], ['gemini-3-flash', 'gemini-3.1-flash-lite'], [],
    ...Array(3).fill(['muse-spark-1.1', 'muse-spark-1.2']), [], ['glm-4.7-flash'], [],
    ['deepseek-v4-flash-free', 'muse-spark-1.2-contributor-free'], [old],
  ];
  for (const [index, account] of served.entries()) {
    const key = `fixture:${account.id}`;
    assert.deepEqual(both.capacity.newestVersion.accounts[key], newestOnly.capacity.newestVersion.accounts[key], key);
    assert.deepEqual(newestOnly.capacity.newestVersion.accounts[key].supersededCanonicalModels, expected[index], key);
  }
  const fallbackOnly = results.get('false:true').capacity.eligibility.accountFallback.admitted.find(row => row.accountId === 'fixture:matrix-weak' && row.role === 'doer');
  assert.equal(fallbackOnly?.armId, 'claude-sonnet-5-5-xhigh');
  assert.equal(Object.hasOwn(results.get('false:false').capacity, 'newestVersion'), false);
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const { projectForParity } = await import('../scripts/aa-replay.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'aa-replay-matrix-'));
  try {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const archive = execFileSync('git', ['-C', root, 'archive', 'a368f5c', 'src', 'scripts/aa-replay.mjs', 'package.json']);
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    const baseline = await import(pathToFileURL(join(dir, 'scripts/aa-replay.mjs')).href);
    const unmodified = await baseline.replayTick({ ...base, lane: fleet, snapshot: scored, config: disabledConfig });
    assert.deepEqual(projectForParity(results.get('false:false')), projectForParity(unmodified));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
