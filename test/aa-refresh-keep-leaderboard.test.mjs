import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { parseAaLeaderboardHtml, mergeAaRowsGapFill } from '../src/aa.mjs';
import { fleetStallAlarms } from '../src/concurrency.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const TICK = Date.parse('2026-10-17T05:00:00Z');

// Good snapshot: leaderboard-derived rows carry the quality + cost fields the
// ladders need. Fresh API rows below carry the same slugs but no metrics, so
// an API-only merge would leave Q/C null and empty every ladder.
const GOOD_ROWS = [
  { slug: 'claude-opus-5-5', intelligenceIndex: 57.6, intelligenceIndexCostPerTask: 5.9, price1mInputTokens: 4, price1mOutputTokens: 20, scicode: 0.66, terminalbenchV40: 0.59, hle: 0.61, lcr: 0.84 },
  { slug: 'claude-sonnet-5-5-high', intelligenceIndex: 46.7, intelligenceIndexCostPerTask: 0.88, price1mInputTokens: 2, price1mOutputTokens: 10, scicode: 0.53, terminalbenchV40: 0.43, hle: 0.45, lcr: 0.78 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 44.1, intelligenceIndexCostPerTask: 0.4, price1mInputTokens: 1, price1mOutputTokens: 4, scicode: 0.5, terminalbenchV40: 0.4, hle: 0.42, lcr: 0.75 },
];
const GOOD_SLUGS = GOOD_ROWS.map(r => r.slug);

const apiOnlyText = JSON.stringify({
  data: GOOD_SLUGS.map(slug => ({ slug, evaluations: {}, pricing: {} })),
});

const rawAcct = () => ({
  lane: 'claude-1',
  provider: 'claude',
  accountKey: 'a1',
  health: 'healthy',
  meter: null,
  models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  weekly: { used: 0.3, resetsAt: '2026-10-24T05:00:00Z' },
  fiveHour: { used: 0.1, resetsAt: '2026-10-17T10:00:00Z' },
  observedAt: new Date(TICK).toISOString(),
  quality: 'live',
});

function drive({ boardHtml, apiText = apiOnlyText, apiStatus = 200 }) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  const errors = [];
  const infos = [];
  let now = TICK;
  const lane = { observedAt: new Date(now).toISOString(), accounts: [rawAcct()] };
  const fake = {
    config: {
      get: async () => ({
        cliproxy: { laneKeySecretRef: SECRET },
        aa: { apiKeySecretRef: SECRET },
      }),
    },
    state: {
      get: async k => store.get(skey(k)) ?? null,
      set: async (k, v) => { store.set(skey(k), v); },
    },
    secrets: { resolve: async () => 'test-key' },
    http: {
      fetch: async (url) => {
        if (String(url).includes('/api/v2/language/models/free')) {
          const api = JSON.parse(apiText);
          return { status: apiStatus, headers: { get: () => null }, text: async () => JSON.stringify({ ...api, intelligence_index_version: '5.0', pagination: { page: 1, total_pages: 1, has_more: false } }) };
        }
        if (String(url).includes('/leaderboards/models')) {
          return { status: 200, headers: { get: () => null }, text: async () => boardHtml };
        }
        return { status: 200, json: async () => withSyntheticReadiness(lane, now) };
      },
    },
    agents: { get: async () => null },
    issues: {
      get: async () => null,
      list: async () => [],
    },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on: (n, fn) => { handlers.set(n, fn); } },
    logger: {
      info: (...a) => { infos.push(a); },
      error: (...a) => { errors.push(a); },
    },
  };
  const plugin = createModelCapacityPlugin({ clock: () => now, requirePinnedLaneHost: false });
  return { store, jobs, fake, plugin, errors, infos, skey, setNow: ms => { now = ms; } };
}

test('2026-10-17 fixture parses the current initialModels page', () => {
  const html = readFileSync(join(HERE, 'fixtures', 'aa-leaderboard-20261017.html'), 'utf8');
  const rows = parseAaLeaderboardHtml(html);
  assert.ok(rows && rows.length === 4, 'fixture yields 4 rows');
  const slugs = rows.map(r => r.slug);
  assert.ok(slugs.includes('claude-opus-5-5'), 'fleet slug present');
  const opus = rows.find(r => r.slug === 'claude-opus-5-5');
  // Renamed fields backfill the canonical names the quality composite reads.
  assert.equal(opus.terminalbenchV40, opus.terminalBench40);
  assert.ok(typeof opus.terminalbenchV40 === 'number', 'V40 backfilled from terminalBench40');
  assert.ok(typeof opus.outputTokensPerSecondP5 === 'number', 'P5 backfilled from percentile05');
});

test('leaderboard parse failure keeps prior leaderboard rows, ladders and target', async () => {
  const { store, jobs, fake, plugin, errors, skey } = drive({ boardHtml: '<html>no data here</html>' });
  await plugin.setup(fake);
  await plugin.onConfigChanged(
    { cliproxy: { laneKeySecretRef: SECRET }, aa: { apiKeySecretRef: SECRET } },
    { companyId: 'acme' },
  );
  const AA_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
  store.set(skey(AA_KEY), {
    fetchedAt: '2026-10-16T04:17:00.000Z',
    rows: GOOD_ROWS.map(r => ({ ...r })),
    duplicateSlugs: [],
    leaderboardRows: GOOD_ROWS.map(r => ({ ...r })),
    leaderboardSlugs: [...GOOD_SLUGS],
    leaderboardAt: '2026-10-16T04:17:00.000Z',
    lastAttemptAt: '2026-10-16T04:17:00.000Z',
    lastError: null,
    lastLeaderboardError: null,
  });

  await jobs.get('aa-refresh')({});
  const after = store.get(skey(AA_KEY));
  assert.ok(after, 'snapshot still stored');
  assert.ok(
    Array.isArray(after.leaderboardSlugs) && after.leaderboardSlugs.length > 0,
    'never stores an empty leaderboardSlugs over a non-empty one',
  );
  for (const slug of GOOD_SLUGS) {
    assert.ok(after.leaderboardSlugs.includes(slug), `${slug} kept`);
  }
  assert.equal(after.lastLeaderboardError, 'aa-leaderboard-parse-failed');
  // Leaderboard-derived quality/cost survive the failed refresh.
  const opus = after.rows.find(r => r.slug === 'claude-opus-5-5');
  assert.equal(opus?.intelligenceIndex, 57.6);
  assert.equal(opus?.intelligenceIndexCostPerTask, 5.9);
  assert.ok(errors.some(([msg]) => String(msg).includes('kept prior leaderboard rows')),
    'refresh logs the keep at error level');

  // The kept rows still build non-empty ladders with sustainable share.
  // (Fleet target reads null until measured runs calibrate burn -- weak, not
  // stalled. The 10-17 stall read target 0 with empty ladders; this asserts
  // the opposite: ladders non-empty, per-account share positive, target never 0.)
  await jobs.get('shadow-tick')({});
  const LADDER_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'ladder-v1' };
  const CAP_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'capacity-v1' };
  const ladders = store.get(skey(LADDER_KEY))?.ladders ?? {};
  const keys = Object.keys(ladders);
  assert.ok(keys.length > 0, 'at least one account ladder');
  assert.ok(keys.some(k => (ladders[k]?.rungs ?? []).length > 0), 'ladders stay non-empty after the failed refresh');
  const cap = store.get(skey(CAP_KEY));
  assert.ok(cap, 'capacity report persisted');
  assert.notEqual(cap.target, 0, `fleet target must not stall at 0 (got ${cap?.target})`);
  const acctView = (cap.accounts ?? []).find(a => a.accountId === 'claude:a1');
  assert.ok(acctView, 'healthy account still reported');
  assert.ok((acctView.arms ?? []).length > 0, 'healthy account keeps routable arms');
  assert.ok((acctView.targetShare ?? 0) > 0, `healthy account keeps a positive target share (got ${acctView?.targetShare})`);
});

test('leaderboard fetch failure also keeps prior leaderboard rows', async () => {
  const { store, jobs, fake, plugin, skey } = drive({ boardHtml: null });
  // Null board html simulates a failed fetch body; override fetch for this case.
  fake.http.fetch = async (url) => {
    if (String(url).includes('/api/v2/language/models/free')) {
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ ...JSON.parse(apiOnlyText), intelligence_index_version: '5.0', pagination: { page: 1, total_pages: 1, has_more: false } }) };
    }
    if (String(url).includes('/leaderboards/models')) {
      return { status: 500, headers: { get: () => null }, text: async () => '' };
    }
    const lane = { observedAt: new Date(TICK).toISOString(), accounts: [rawAcct()] };
    return { status: 200, json: async () => withSyntheticReadiness(lane, TICK) };
  };
  await plugin.setup(fake);
  await plugin.onConfigChanged(
    { cliproxy: { laneKeySecretRef: SECRET }, aa: { apiKeySecretRef: SECRET } },
    { companyId: 'acme' },
  );
  const AA_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
  store.set(skey(AA_KEY), {
    fetchedAt: '2026-10-16T04:17:00.000Z',
    rows: GOOD_ROWS.map(r => ({ ...r })),
    duplicateSlugs: [],
    leaderboardRows: GOOD_ROWS.map(r => ({ ...r })),
    leaderboardSlugs: [...GOOD_SLUGS],
    leaderboardAt: '2026-10-16T04:17:00.000Z',
    lastAttemptAt: '2026-10-16T04:17:00.000Z',
    lastError: null,
    lastLeaderboardError: null,
  });
  await jobs.get('aa-refresh')({});
  const after = store.get(skey(AA_KEY));
  assert.ok(after.leaderboardSlugs.length > 0, 'fetch failure keeps slugs');
  assert.ok(after.rows.some(r => r.slug === 'claude-opus-5-5' && r.intelligenceIndex === 57.6),
    'fetch failure keeps leaderboard row values');
});

// Review round 2 (finding 1): the previous snapshot's MERGED rows must not
// overwrite fresh API data while the leaderboard is failing. Prior merged
// opus: intelligenceIndex 50, prices 2/6, codingIndex 40. Fresh API: 60,
// 1/3, codingIndex 55. The stored row must carry the fresh values, with
// leaderboard-only fields (scicode, cost per task) gap-filled from the
// kept raw leaderboard layer.
test('leaderboard failure keeps the raw layer gap-fill only: fresh API values win', async () => {
  const freshApiText = JSON.stringify({
    data: [
      {
        slug: 'claude-opus-5-5',
        evaluations: { artificial_analysis_intelligence_index: 60, artificial_analysis_coding_index: 55 },
        pricing: {},
        price1mInputTokens: 1,
        price1mOutputTokens: 3,
      },
      ...GOOD_SLUGS.filter(s => s !== 'claude-opus-5-5').map(slug => ({ slug, evaluations: {}, pricing: {} })),
    ],
  });
  const { store, jobs, fake, plugin, skey } = drive({ boardHtml: '<html>no data here</html>', apiText: freshApiText });
  await plugin.setup(fake);
  await plugin.onConfigChanged(
    { cliproxy: { laneKeySecretRef: SECRET }, aa: { apiKeySecretRef: SECRET } },
    { companyId: 'acme' },
  );
  const AA_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
  const staleOpus = { ...GOOD_ROWS[0], intelligenceIndex: 50, price1mInputTokens: 2, price1mOutputTokens: 6 };
  store.set(skey(AA_KEY), {
    fetchedAt: '2026-10-16T04:17:00.000Z',
    rows: [{ ...staleOpus, codingIndex: 40 }, ...GOOD_ROWS.slice(1).map(r => ({ ...r }))],
    duplicateSlugs: [],
    leaderboardRows: [staleOpus, ...GOOD_ROWS.slice(1).map(r => ({ ...r }))],
    leaderboardSlugs: [...GOOD_SLUGS],
    leaderboardAt: '2026-10-16T04:17:00.000Z',
    lastAttemptAt: '2026-10-16T04:17:00.000Z',
    lastError: null,
    lastLeaderboardError: null,
  });

  await jobs.get('aa-refresh')({});
  const after = store.get(skey(AA_KEY));
  const opus = after.rows.find(r => r.slug === 'claude-opus-5-5');
  assert.equal(opus?.intelligenceIndex, 60, 'fresh API intelligenceIndex wins over the stale layer');
  assert.equal(opus?.price1mInputTokens, 1, 'fresh API input price wins');
  assert.equal(opus?.price1mOutputTokens, 3, 'fresh API output price wins');
  assert.equal(opus?.codingIndex, 55, 'API-only field lands fresh, not frozen at the stale merged value');
  assert.equal(opus?.scicode, 0.66, 'leaderboard-only field is gap-filled from the kept layer');
  assert.equal(opus?.intelligenceIndexCostPerTask, 5.9, 'leaderboard cost field is gap-filled');
  assert.ok(after.leaderboardSlugs.includes('claude-opus-5-5'), 'kept slugs survive');
  const keptOpus = (after.leaderboardRows ?? []).find(r => r.slug === 'claude-opus-5-5');
  assert.equal(keptOpus?.intelligenceIndex, 50, 'stored raw layer stays the kept leaderboard layer, not merged rows');
});

test('successful refresh stores the raw leaderboard layer for later failures', async () => {
  const html = readFileSync(join(HERE, 'fixtures', 'aa-leaderboard-20261017.html'), 'utf8');
  const { store, jobs, fake, plugin, skey } = drive({ boardHtml: html });
  await plugin.setup(fake);
  await plugin.onConfigChanged(
    { cliproxy: { laneKeySecretRef: SECRET }, aa: { apiKeySecretRef: SECRET } },
    { companyId: 'acme' },
  );
  const AA_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
  await jobs.get('aa-refresh')({});
  const after = store.get(skey(AA_KEY));
  assert.ok(Array.isArray(after.leaderboardRows) && after.leaderboardRows.length === 4,
    'raw leaderboard rows persisted separately from merged rows');
  assert.ok(after.leaderboardRows.some(r => r.slug === 'claude-opus-5-5'), 'fleet slug in the raw layer');
  assert.equal(after.lastLeaderboardError, null);
});

test('mergeAaRowsGapFill: API wins non-null fields, kept layer fills nulls and new slugs', () => {
  const merged = mergeAaRowsGapFill(
    [{ slug: 'm1', intelligenceIndex: 60, codingIndex: 55, scicode: null }],
    [
      { slug: 'm1', intelligenceIndex: 50, scicode: 0.66 },
      { slug: 'm2', intelligenceIndex: 44 },
    ],
  );
  const m1 = merged.rows.find(r => r.slug === 'm1');
  assert.equal(m1.intelligenceIndex, 60);
  assert.equal(m1.codingIndex, 55);
  assert.equal(m1.scicode, 0.66);
  assert.ok(merged.rows.some(r => r.slug === 'm2' && r.intelligenceIndex === 44), 'kept-only slug still appears');
  assert.deepEqual([...merged.leaderboardSlugs].sort(), ['m1', 'm2']);
});

// Review round 2 (finding 2): the target-0 alarm must stay silent during
// the designed all-guarded shed (and for zero-headroom accounts), and fire
// only when an account that could actually serve sees target 0.
test('fleetStallAlarms: target-0 fires with headroom, silent when all guarded or spent', () => {
  const ladders = { 'claude:a1': { rungs: [{ armId: 'x' }] } };
  const withHeadroom = fleetStallAlarms({
    ladders, accountCount: 1, target: 0,
    accounts: [{ accountId: 'claude:a1', healthy: true, guardActive: false, remainingPct: 0.5 }],
  });
  assert.deepEqual(withHeadroom, [{ code: 'target-zero-with-headroom', accountIds: ['claude:a1'] }]);

  const allGuarded = fleetStallAlarms({
    ladders, accountCount: 1, target: 0,
    accounts: [{ accountId: 'claude:a1', healthy: true, guardActive: true, remainingPct: 0.5 }],
  });
  assert.deepEqual(allGuarded, [], 'all-guarded shed reads target 0 by design: no alarm');

  const allSpent = fleetStallAlarms({
    ladders, accountCount: 1, target: 0,
    accounts: [{ accountId: 'claude:a1', healthy: true, guardActive: false, remainingPct: 0 }],
  });
  assert.deepEqual(allSpent, [], 'zero headroom sustains nothing: no alarm');

  const weak = fleetStallAlarms({
    ladders, accountCount: 1, target: null,
    accounts: [{ accountId: 'claude:a1', healthy: true, guardActive: false, remainingPct: 0.5 }],
  });
  assert.deepEqual(weak, [], 'weak/null target is not a stall');

  const empty = fleetStallAlarms({
    ladders: { 'claude:a1': { rungs: [] } }, accountCount: 1, target: 3,
    accounts: [{ accountId: 'claude:a1', healthy: true, guardActive: true, remainingPct: 0.5 }],
  });
  assert.deepEqual(empty, [{ code: 'all-ladders-empty' }], 'empty ladders alarm regardless of guard state');
});

test('all-ladders-empty alarm fires once across repeated ticks (rate-limited)', async () => {
  const { jobs, fake, plugin, errors, setNow } = drive({ boardHtml: '<html>unused</html>' });
  await plugin.setup(fake);
  await plugin.onConfigChanged(
    { cliproxy: { laneKeySecretRef: SECRET }, aa: { apiKeySecretRef: SECRET } },
    { companyId: 'acme' },
  );
  // No AA snapshot seeded: every ladder is empty.
  await jobs.get('shadow-tick')({});
  setNow(TICK + 60 * 1000);
  await jobs.get('shadow-tick')({});
  const alarms = errors.filter(([msg]) => String(msg).includes('all account ladders empty'));
  assert.equal(alarms.length, 1, `alarm logged once across two ticks (got ${alarms.length})`);
});

// Nit (target-0 alarm call-site wiring): only the helper decision and the
// sibling all-ladders-empty branch were covered. A calibrated account with
// headroom but no servable arm (empty ladders) reads target 0, so the tick
// must page through the target-zero branch of the call site too.
test('target-zero-with-headroom alarm fires through the tick when calibrated capacity cannot serve', async () => {
  const { store, jobs, fake, plugin, errors, skey } = drive({ boardHtml: '<html>unused</html>' });
  await plugin.setup(fake);
  await plugin.onConfigChanged(
    { cliproxy: { laneKeySecretRef: SECRET }, aa: { apiKeySecretRef: SECRET } },
    { companyId: 'acme' },
  );
  // No AA snapshot seeded: every ladder is empty.
  // One fresh usage point plus the measured individual estimate a previous
  // tick persisted: with no new evidence the tick carries the knowledge
  // (accountE), so the fleet calibrates without a multi-tick history.
  const SMOOTH_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'smoothing-v1' };
  store.set(skey(SMOOTH_KEY), {
    accountUsage: {
      'claude:a1': [{
        atMs: TICK - 60 * 1000, epoch: 'e1', requests: 100,
        weekly: 0.3, weeklyReset: Date.parse('2026-10-24T05:00:00Z'),
        fiveHour: 0.1, fiveHourReset: Date.parse('2026-10-17T10:00:00Z'),
      }],
    },
    accountE: {
      'claude:a1': {
        burnPerRunPct: 0.002, capacityWeight: 1, source: 'account-weekly',
        atMs: TICK - 60 * 1000, epoch: 'e1',
      },
    },
  });
  await jobs.get('shadow-tick')({});
  const empty = errors.filter(([msg]) => String(msg).includes('all account ladders empty'));
  assert.equal(empty.length, 1, 'empty ladders alarm fires');
  const alarms = errors.filter(([msg]) => String(msg).includes('capacity target is 0 with healthy accounts'));
  assert.equal(alarms.length, 1, `target-0 alarm logged once (got ${alarms.length}): ${JSON.stringify(errors)}`);
  assert.equal(alarms[0][1].code, 'target-zero-with-headroom');
  assert.deepEqual(alarms[0][1].healthyAccounts, ['claude:a1']);
});


test('API failure retains old freshness, publishes fresh leaderboard, and fails the job', async () => {
  const html = readFileSync(join(HERE, 'fixtures', 'aa-leaderboard-20261017.html'), 'utf8');
  const {store,jobs,fake,plugin,skey} = drive({boardHtml:html,apiStatus:410});
  await plugin.setup(fake);
  await plugin.onConfigChanged({cliproxy:{laneKeySecretRef:SECRET},aa:{apiKeySecretRef:SECRET}},{companyId:'acme'});
  const key={scopeKind:'company',scopeId:'acme',namespace:'model-capacity',stateKey:'aa-snapshot-v1'};
  store.set(skey(key),{fetchedAt:'2026-10-01T00:00:00.000Z',rows:GOOD_ROWS,leaderboardRows:[],leaderboardSlugs:[]});
  await assert.rejects(jobs.get('aa-refresh')({}), /aa-refresh-failed/);
  const state=store.get(skey(key));
  assert.equal(state.fetchedAt,'2026-10-01T00:00:00.000Z');
  assert.ok(state.leaderboardRows.length > 0);
  assert.equal(state.lastError,'aa-http-failed');
});

test('new index major publishes fresh data without carrying old benchmarks, prices, slugs or stale leaderboard', async () => {
  const {store,jobs,fake,plugin,skey} = drive({boardHtml:'<html>no data</html>'});
  await plugin.setup(fake);
  await plugin.onConfigChanged({cliproxy:{laneKeySecretRef:SECRET},aa:{apiKeySecretRef:SECRET}},{companyId:'acme'});
  const key={scopeKind:'company',scopeId:'acme',namespace:'model-capacity',stateKey:'aa-snapshot-v1'};
  store.set(skey(key),{fetchedAt:'2026-10-01T00:00:00.000Z',intelligenceIndexVersion:'4.0',rows:[...GOOD_ROWS, {slug:'old-only', scicode:0.9}],leaderboardRows:GOOD_ROWS,leaderboardSlugs:GOOD_SLUGS});
  await jobs.get('aa-refresh')({});
  const state=store.get(skey(key));
  assert.equal(state.intelligenceIndexVersion,'5.0');
  assert.equal(state.fetchedAt,new Date(TICK).toISOString());
  assert.equal(state.rows.find(r => r.slug === GOOD_SLUGS[0]).scicode, null);
  assert.equal(state.rows.find(r => r.slug === GOOD_SLUGS[0]).intelligenceIndexCostPerTask, null);
  assert.ok(!state.rows.some(r => r.slug === 'old-only'));
  assert.deepEqual(state.leaderboardSlugs, []);
});


test('refresh job reports pages, coverage and previous snapshot age', async () => {
  const html=readFileSync(join(HERE, 'fixtures', 'aa-leaderboard-20261017.html'), 'utf8');
  const {store,jobs,fake,plugin,skey}=drive({boardHtml:html});
  await plugin.setup(fake);
  await plugin.onConfigChanged({cliproxy:{laneKeySecretRef:SECRET},aa:{apiKeySecretRef:SECRET}},{companyId:'acme'});
  const key={scopeKind:'company',scopeId:'acme',namespace:'model-capacity',stateKey:'aa-snapshot-v1'};
  store.set(skey(key),{fetchedAt:new Date(TICK-7200000).toISOString(),rows:[...GOOD_ROWS, {slug:'only-old', scicode:0.5, fieldObservedAt:{scicode:new Date(TICK-86400000).toISOString()}}]});
  const result=await jobs.get('aa-refresh')({});
  assert.equal(result[0].pagesFetched,1);
  assert.equal(result[0].previousSnapshotAgeHours,2);
  assert.equal(result[0].oldestCarriedAgeHours,24);
  assert.ok(result[0].coverage.totalRows >= 3);
  assert.ok(result[0].coverage.benchmarkRows > 0);
  assert.ok(result[0].coverage.configuredArms > 0);
});
