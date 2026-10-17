import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { parseAaLeaderboardHtml } from '../src/aa.mjs';
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

function drive({ boardHtml }) {
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
        if (String(url).includes('/api/v2/data/llms/models')) {
          return { status: 200, headers: { get: () => null }, text: async () => apiOnlyText };
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
  return { store, jobs, fake, plugin, errors, infos, skey };
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
    if (String(url).includes('/api/v2/data/llms/models')) {
      return { status: 200, headers: { get: () => null }, text: async () => apiOnlyText };
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
