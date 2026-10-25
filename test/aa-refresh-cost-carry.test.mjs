import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { fillCosts } from '../src/cost.mjs';
import { carryForwardCosts } from '../src/aa.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';

// 2026-10-22: the daily AA refresh kept every row but published the Muse slugs
// with cost AND prices null. fillCosts returned C: null, a null-cost arm never
// gets a ladder rung, and every Meta lane emptied (fleet target 32.9 -> 0.03).

test('null-cost arm with no prices takes its family median, marked estimated', () => {
  const filled = fillCosts([
    { armId: 'muse-a', family: 'muse', cost: 1.6, priceIn: 1.25, priceOut: 4.25 },
    { armId: 'muse-b', family: 'muse', cost: null, priceIn: null, priceOut: null },
    { armId: 'opus-a', family: 'opus', cost: 10.0, priceIn: 4, priceOut: 20 },
  ]);
  assert.deepEqual(filled.get('muse-a'), { C: 1.6, estimated: false });
  assert.deepEqual(filled.get('muse-b'), { C: 1.6, estimated: true });
});

test('falls back to the fleet median when the family has no measured cost', () => {
  const filled = fillCosts([
    { armId: 'muse-a', family: 'muse', cost: null, priceIn: null, priceOut: null },
    { armId: 'muse-b', family: 'muse', cost: null, priceIn: null, priceOut: null },
    { armId: 'opus-a', family: 'opus', cost: 4.0, priceIn: 4, priceOut: 20 },
  ]);
  assert.deepEqual(filled.get('muse-a'), { C: 4.0, estimated: true });
  assert.deepEqual(filled.get('muse-b'), { C: 4.0, estimated: true });
});

test('median pool widens the fallback beyond the account entries', () => {
  const filled = fillCosts(
    [{ armId: 'muse-a', family: 'muse', cost: null, priceIn: null, priceOut: null }],
    { medianPool: [{ armId: 'opus-a', family: 'opus', cost: 4.0 }] },
  );
  assert.deepEqual(filled.get('muse-a'), { C: 4.0, estimated: true });
});

test('C stays null only when nothing anywhere is measured', () => {
  const filled = fillCosts(
    [
      { armId: 'a', family: 'muse', cost: null, priceIn: null, priceOut: null },
      { armId: 'b', family: 'opus', cost: null, priceIn: null, priceOut: null },
    ],
    { medianPool: [] },
  );
  assert.deepEqual(filled.get('a'), { C: null, estimated: false });
  assert.deepEqual(filled.get('b'), { C: null, estimated: false });
});

test('price-based estimate still wins over the median when prices exist', () => {
  // Profile 1/(1+3) = 0.25 prices the arm at 0.25*8 = 2.0; the family median
  // (1.0) must not win while the arm carries its own price signal.
  const filled = fillCosts([
    { armId: 'measured', family: 'muse', cost: 1.0, priceIn: 1, priceOut: 3 },
    { armId: 'priced', family: 'muse', cost: null, priceIn: 4, priceOut: 4 },
  ]);
  assert.deepEqual(filled.get('priced'), { C: 2.0, estimated: true });
});

test('carryForwardCosts restores dropped cost fields and marks the row', () => {
  const prev = [{
    slug: 'muse-spark-1-3', intelligenceIndex: 55.1,
    intelligenceIndexCostPerTask: 1.6, price1mInputTokens: 1.25, price1mOutputTokens: 4.25,
  }];
  const rows = carryForwardCosts(
    [{ slug: 'muse-spark-1-3', intelligenceIndex: 55.2,
      intelligenceIndexCostPerTask: null, price1mInputTokens: null, price1mOutputTokens: null }],
    prev,
    '2026-10-21T04:17:00.000Z',
  );
  assert.deepEqual(rows, [{
    slug: 'muse-spark-1-3', intelligenceIndex: 55.2,
    intelligenceIndexCostPerTask: 1.6, price1mInputTokens: 1.25, price1mOutputTokens: 4.25,
    costCarriedFrom: '2026-10-21T04:17:00.000Z',
    costFieldObservedAt: { intelligenceIndexCostPerTask: '2026-10-21T04:17:00.000Z',
      price1mInputTokens: '2026-10-21T04:17:00.000Z', price1mOutputTokens: '2026-10-21T04:17:00.000Z' },
  }]);
  assert.equal(prev[0].costCarriedFrom, undefined, 'previous rows are never marked');
});

test('carryForwardCosts carries per field and leaves complete rows untouched', () => {
  const prev = [
    { slug: 'partial', intelligenceIndexCostPerTask: 1.6, price1mInputTokens: 1.25, price1mOutputTokens: 4.25 },
    { slug: 'complete', intelligenceIndexCostPerTask: 5.9, price1mInputTokens: 4, price1mOutputTokens: 20 },
  ];
  const rows = carryForwardCosts(
    [
      // Fresh input price wins; only the dropped output price is carried.
      { slug: 'partial', intelligenceIndexCostPerTask: 1.7, price1mInputTokens: 1.5, price1mOutputTokens: null },
      { slug: 'complete', intelligenceIndexCostPerTask: 5.9, price1mInputTokens: 4, price1mOutputTokens: 20 },
      { slug: 'brand-new', intelligenceIndexCostPerTask: null, price1mInputTokens: null, price1mOutputTokens: null },
    ],
    prev,
    '2026-10-21T04:17:00.000Z',
  );
  const partial = rows.find(r => r.slug === 'partial');
  assert.equal(partial.intelligenceIndexCostPerTask, 1.7, 'fresh cost wins');
  assert.equal(partial.price1mInputTokens, 1.5, 'fresh price wins');
  assert.equal(partial.price1mOutputTokens, 4.25, 'dropped price carried');
  assert.equal(partial.costCarriedFrom, '2026-10-21T04:17:00.000Z');
  const complete = rows.find(r => r.slug === 'complete');
  assert.equal(complete.costCarriedFrom, undefined, 'complete row carries no marker');
  const fresh = rows.find(r => r.slug === 'brand-new');
  assert.equal(fresh.intelligenceIndexCostPerTask, null, 'no previous row: nothing to carry');
  assert.equal(fresh.costCarriedFrom, undefined);
});

test('carryForwardCosts strips a stale marker when the fresh row is complete', () => {
  const rows = carryForwardCosts(
    [{ slug: 'm', intelligenceIndexCostPerTask: 1.6, price1mInputTokens: 1.25,
      price1mOutputTokens: 4.25, costCarriedFrom: '2026-10-20T04:17:00.000Z' }],
    [{ slug: 'm', intelligenceIndexCostPerTask: 1.6, price1mInputTokens: 1.25, price1mOutputTokens: 4.25 }],
    '2026-10-21T04:17:00.000Z',
  );
  assert.equal(rows[0].costCarriedFrom, undefined, 'marker describes this row, not its history');
});

// --- Refresh-level regression test: 2026-10-22 fleet stall ---

const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const TICK = Date.parse('2026-10-22T05:00:00Z');
const PREV_FETCHED_AT = '2026-10-21T04:17:00.000Z';

const MUSE_ROWS = [
  { slug: 'muse-spark-1-3', intelligenceIndex: 45.2, intelligenceIndexCostPerTask: 1.60, price1mInputTokens: 1.25, price1mOutputTokens: 4.25, scicode: 0.52, terminalbenchV40: 0.41, hle: 0.44, lcr: 0.76 },
  { slug: 'muse-spark-1-3-xhigh', intelligenceIndex: 47.8, intelligenceIndexCostPerTask: 1.37, price1mInputTokens: 1.25, price1mOutputTokens: 4.25, scicode: 0.55, terminalbenchV40: 0.45, hle: 0.47, lcr: 0.79 },
];
const CLAUDE_ROWS = [
  { slug: 'claude-sonnet-5-5', intelligenceIndex: 46.7, intelligenceIndexCostPerTask: 0.88, price1mInputTokens: 2, price1mOutputTokens: 10, scicode: 0.53, terminalbenchV40: 0.43, hle: 0.45, lcr: 0.78 },
  { slug: 'claude-haiku-5-5', intelligenceIndex: 44.1, intelligenceIndexCostPerTask: 0.4, price1mInputTokens: 1, price1mOutputTokens: 4, scicode: 0.5, terminalbenchV40: 0.4, hle: 0.42, lcr: 0.75 },
];
const ALL_SLUGS = [...MUSE_ROWS, ...CLAUDE_ROWS].map(r => r.slug);

const rawAcct = (lane, provider, accountKey, models) => ({
  lane, provider, accountKey, health: 'healthy', meter: null, models,
  weekly: { used: 0.3, resetsAt: '2026-10-29T05:00:00Z' },
  fiveHour: { used: 0.1, resetsAt: '2026-10-22T10:00:00Z' },
  observedAt: new Date(TICK).toISOString(),
  quality: 'live',
});

// Synthetic leaderboard page: the escaped initialModels embed the parser reads.
function leaderboardHtml(rows) {
  const esc = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `<html><body><script>self.__next_f.push([1,"{\\"initialModels\\":${esc(JSON.stringify(rows))}}"])</script></body></html>`;
}

function drive(feed) {
  const store = new Map();
  const jobs = new Map();
  const handlers = new Map();
  const skey = k => JSON.stringify(k);
  const errors = [];
  const infos = [];
  const now = TICK;
  const lane = { observedAt: new Date(now).toISOString(), accounts: feed };
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
          return { status: 200, headers: { get: () => null }, text: async () => feed.apiText };
        }
        if (String(url).includes('/leaderboards/models')) {
          return { status: 200, headers: { get: () => null }, text: async () => feed.boardHtml };
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

const usagePoint = accountId => ({
  atMs: TICK - 60 * 1000, epoch: 'e1', requests: 100,
  weekly: 0.3, weeklyReset: Date.parse('2026-10-29T05:00:00Z'),
  fiveHour: 0.1, fiveHourReset: Date.parse('2026-10-22T10:00:00Z'),
});

test('refresh that nulls one family costs keeps that family ladders and the target within 10%', async () => {
  const feed = {
    apiText: JSON.stringify({ data: ALL_SLUGS.map(slug => ({ slug, evaluations: {}, pricing: {} })) }),
    boardHtml: '<html>unused before the refresh</html>',
  };
  const accounts = [
    rawAcct('meta-1', 'meta', 'meta-1', ['muse-spark-1.3-contributor']),
    rawAcct('claude-1', 'claude', 'claude-1', ['claude-sonnet-5-5', 'claude-haiku-5-5']),
  ];
  const { store, jobs, fake, plugin, errors, skey } = drive({});
  // The AA fetch closure below reads the mutable `feed` box, so the refresh
  // inputs can be swapped between the pre-refresh tick and the refresh.
  await plugin.setup({
    ...fake,
    http: {
      fetch: async (url) => {
        if (String(url).includes('/api/v2/data/llms/models')) {
          return { status: 200, headers: { get: () => null }, text: async () => feed.apiText };
        }
        if (String(url).includes('/leaderboards/models')) {
          return { status: 200, headers: { get: () => null }, text: async () => feed.boardHtml };
        }
        const lane = { observedAt: new Date(TICK).toISOString(), accounts };
        return { status: 200, json: async () => withSyntheticReadiness(lane, TICK) };
      },
    },
  });
  await plugin.onConfigChanged(
    { cliproxy: { laneKeySecretRef: SECRET }, aa: { apiKeySecretRef: SECRET } },
    { companyId: 'acme' },
  );
  const AA_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
  const SMOOTH_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'smoothing-v1' };
  const CAP_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'capacity-v1' };
  const LADDER_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'ladder-v1' };
  const goodRows = [...MUSE_ROWS, ...CLAUDE_ROWS].map(r => ({ ...r }));
  store.set(skey(AA_KEY), {
    fetchedAt: PREV_FETCHED_AT,
    rows: goodRows.map(r => ({ ...r })),
    duplicateSlugs: [],
    leaderboardRows: goodRows.map(r => ({ ...r })),
    leaderboardSlugs: [...ALL_SLUGS],
    leaderboardAt: PREV_FETCHED_AT,
    lastAttemptAt: PREV_FETCHED_AT,
    lastError: null,
    lastLeaderboardError: null,
  });
  // Calibrated burn so the fleet target is a concrete number, not weak/null.
  store.set(skey(SMOOTH_KEY), {
    accountUsage: {
      'meta:meta-1': [usagePoint('meta:meta-1')],
      'claude:claude-1': [usagePoint('claude:claude-1')],
    },
    accountE: {
      'meta:meta-1': { burnPerRunPct: 0.002, capacityWeight: 1, source: 'account-weekly', atMs: TICK - 60 * 1000, epoch: 'e1' },
      'claude:claude-1': { burnPerRunPct: 0.002, capacityWeight: 1, source: 'account-weekly', atMs: TICK - 60 * 1000, epoch: 'e1' },
    },
  });

  await jobs.get('shadow-tick')({});
  const before = store.get(skey(CAP_KEY));
  assert.ok(before && before.target > 0, `pre-refresh target must be concrete and positive (got ${before?.target})`);

  // The 10-22 refresh: every row kept, Muse cost fields all null.
  const nulledMuse = MUSE_ROWS.map(r => ({
    ...r, intelligenceIndexCostPerTask: null, price1mInputTokens: null, price1mOutputTokens: null,
  }));
  feed.boardHtml = leaderboardHtml([...nulledMuse, ...CLAUDE_ROWS]);
  await jobs.get('aa-refresh')({});
  const after = store.get(skey(AA_KEY));
  assert.equal(after.lastLeaderboardError, null, 'the leaderboard parses: the old guard would have saved this as good');
  for (const slug of MUSE_ROWS.map(r => r.slug)) {
    const row = after.rows.find(r => r.slug === slug);
    assert.ok(row.intelligenceIndexCostPerTask > 0, `${slug} cost carried forward`);
    assert.equal(row.costCarriedFrom, PREV_FETCHED_AT, `${slug} marked with the source snapshot`);
  }
  for (const slug of CLAUDE_ROWS.map(r => r.slug)) {
    const row = after.rows.find(r => r.slug === slug);
    assert.equal(row.costCarriedFrom, undefined, `${slug} measured its own costs: no marker`);
  }
  assert.ok(errors.some(([msg]) => String(msg).includes('carried forward from previous snapshot')),
    'refresh logs the carry at error level');

  await jobs.get('shadow-tick')({});
  const ladders = store.get(skey(LADDER_KEY))?.ladders ?? {};
  const metaKeys = Object.keys(ladders).filter(k => k.startsWith('meta:'));
  assert.ok(metaKeys.length > 0, 'meta lane still has a ladder entry');
  for (const k of metaKeys) {
    assert.ok((ladders[k]?.rungs ?? []).length > 0, `meta ladder ${k} stays non-empty`);
  }
  const cap = store.get(skey(CAP_KEY));
  assert.ok(cap.target > 0, `fleet target must not stall (got ${cap?.target})`);
  const drift = Math.abs(cap.target - before.target) / before.target;
  assert.ok(drift <= 0.10, `target within 10% of the previous tick (was ${before.target}, now ${cap.target})`);
  const metaView = (cap.accounts ?? []).find(a => a.provider === 'meta');
  assert.ok(metaView && metaView.arms.length > 0, 'meta account keeps routable arms on the capacity view');
  assert.ok(metaView.arms.every(a => a.costCarriedFrom === PREV_FETCHED_AT),
    'every meta arm on the capacity view carries the marker');
  const claudeView = (cap.accounts ?? []).find(a => a.provider === 'claude');
  assert.ok((claudeView?.arms ?? []).every(a => a.costCarriedFrom == null),
    'measured arms carry no marker');
});

test('costless new slug with no carry source stays laddered via the median backstop, marked estimated', async () => {
  const accounts = [
    rawAcct('meta-1', 'meta', 'meta-1', ['muse-spark-1.3-contributor']),
    rawAcct('claude-1', 'claude', 'claude-1', ['claude-sonnet-5-5', 'claude-haiku-5-5']),
  ];
  const { store, jobs, fake, plugin, skey } = drive({});
  await plugin.setup({
    ...fake,
    http: {
      fetch: async () => {
        const lane = { observedAt: new Date(TICK).toISOString(), accounts };
        return { status: 200, json: async () => withSyntheticReadiness(lane, TICK) };
      },
    },
  });
  await plugin.onConfigChanged(
    { cliproxy: { laneKeySecretRef: SECRET }, aa: { apiKeySecretRef: SECRET } },
    { companyId: 'acme' },
  );
  const AA_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
  const CAP_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'capacity-v1' };
  // Fresh install: no previous snapshot to carry from, and the Muse rows
  // arrived with no cost fields at all.
  store.set(skey(AA_KEY), {
    fetchedAt: new Date(TICK).toISOString(),
    rows: [
      ...MUSE_ROWS.map(r => ({
        ...r, intelligenceIndexCostPerTask: null, price1mInputTokens: null, price1mOutputTokens: null,
      })),
      ...CLAUDE_ROWS.map(r => ({ ...r })),
    ],
    duplicateSlugs: [],
    leaderboardSlugs: [...ALL_SLUGS],
    lastAttemptAt: new Date(TICK).toISOString(),
    lastError: null,
    lastLeaderboardError: null,
  });

  await jobs.get('shadow-tick')({});
  const cap = store.get(skey(CAP_KEY));
  const metaView = (cap.accounts ?? []).find(a => a.provider === 'meta');
  assert.ok(metaView && metaView.arms.length > 0, 'costless arms keep their ladder rungs');
  // Fleet median over the measured Claude costs (0.88, 0.4): no Muse arm
  // measured a cost, so the family pool is empty and the fleet pool wins.
  for (const arm of metaView.arms) {
    assert.equal(arm.costEstimated, true, `${arm.armId} marked estimated`);
    assert.equal(arm.costCarriedFrom, undefined, `${arm.armId} carried nothing: no marker`);
    assert.equal(arm.costBase, (0.88 + 0.4) / 2, `${arm.armId} priced at the fleet median`);
  }
  const claudeView = (cap.accounts ?? []).find(a => a.provider === 'claude');
  assert.ok((claudeView?.arms ?? []).every(a => a.costEstimated == null),
    'measured arms carry no estimated mark');
});

test('costless arm with a measured same-family sibling prices at the family median, not the fleet median', async () => {
  // Plugin-level pin for the family wiring into fillCosts: only the
  // higher-quality Muse sibling loses its costs, so the nulled xhigh arm must
  // price at the Muse family median (1.60, the surviving sibling) instead of
  // the fleet median (0.88 over 1.60/0.88/0.40). Nulling the higher-Q sibling
  // keeps the nulled arm Pareto-alive: it strictly dominates its sibling at
  // equal cost, so a missing arm here is a real regression, not dominance.
  const accounts = [
    rawAcct('meta-1', 'meta', 'meta-1', ['muse-spark-1.3-contributor']),
    rawAcct('claude-1', 'claude', 'claude-1', ['claude-sonnet-5-5', 'claude-haiku-5-5']),
  ];
  const { store, jobs, fake, plugin, skey } = drive({});
  await plugin.setup({
    ...fake,
    http: {
      fetch: async () => {
        const lane = { observedAt: new Date(TICK).toISOString(), accounts };
        return { status: 200, json: async () => withSyntheticReadiness(lane, TICK) };
      },
    },
  });
  await plugin.onConfigChanged(
    { cliproxy: { laneKeySecretRef: SECRET }, aa: { apiKeySecretRef: SECRET } },
    { companyId: 'acme' },
  );
  const AA_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };
  const CAP_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'capacity-v1' };
  store.set(skey(AA_KEY), {
    fetchedAt: new Date(TICK).toISOString(),
    rows: [
      { ...MUSE_ROWS[0] },
      { ...MUSE_ROWS[1], intelligenceIndexCostPerTask: null, price1mInputTokens: null, price1mOutputTokens: null },
      ...CLAUDE_ROWS.map(r => ({ ...r })),
    ],
    duplicateSlugs: [],
    leaderboardSlugs: [...ALL_SLUGS],
    lastAttemptAt: new Date(TICK).toISOString(),
    lastError: null,
    lastLeaderboardError: null,
  });

  await jobs.get('shadow-tick')({});
  const cap = store.get(skey(CAP_KEY));
  const metaView = (cap.accounts ?? []).find(a => a.provider === 'meta');
  const arms = metaView?.arms ?? [];
  const nulled = arms.find(a => a.armId === 'muse-spark-1-3-xhigh');
  assert.ok(nulled, `nulled xhigh arm stays laddered (arms: ${arms.map(a => a.armId).join(', ')})`);
  assert.equal(nulled.costEstimated, true, 'nulled arm marked estimated');
  assert.equal(nulled.costCarriedFrom, undefined, 'no carry source: no marker');
  assert.equal(nulled.costBase, 1.6, 'priced at the family median (1.60), not the fleet median (0.88)');
});
