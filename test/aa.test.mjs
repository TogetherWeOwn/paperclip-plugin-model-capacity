import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAaFetchArgs, fetchAaFreeList, parseAaFreeList, AA_FREE_LIST_URL,
  buildAaLeaderboardFetchArgs, fetchAaLeaderboard, parseAaLeaderboardHtml,
  mergeAaRows, AA_LEADERBOARD_URL,
} from '../src/aa.mjs';

test('free-API URL is the documented endpoint', () => {
  assert.equal(AA_FREE_LIST_URL, 'https://artificialanalysis.ai/api/v2/data/llms/models');
});

test('fetch args require the allowlisted URL and a key', () => {
  assert.throws(() => buildAaFetchArgs({ url: 'https://example.com/models', apiKey: 'k' }), /aa-url-rejected/);
  assert.throws(() => buildAaFetchArgs({ apiKey: 'k', url: 'http://artificialanalysis.ai/api/v2/data/llms/models' }), /aa-url-rejected/);
  assert.throws(() => buildAaFetchArgs({}), /aa-access-denied/);
  const args = buildAaFetchArgs({ apiKey: 'k' });
  assert.equal(args.options.headers['x-api-key'], 'k');
});

test('fetch failures follow the known taxonomy and never throw', async () => {
  const denied = await fetchAaFreeList({
    http: { fetch: async () => ({ status: 401, headers: { get: () => null } }) }, apiKey: 'k',
  });
  assert.deepEqual(denied, { ok: false, error: 'aa-access-denied', status: 401, retryable: false });

  const limited = await fetchAaFreeList({
    http: { fetch: async () => ({ status: 429, headers: { get: () => '30' } }) }, apiKey: 'k',
  });
  assert.equal(limited.error, 'aa-rate-limited');
  assert.equal(limited.retryAfterSeconds, 30);

  const redirected = await fetchAaFreeList({
    http: { fetch: async () => ({ status: 302, redirected: true, headers: { get: () => null } }) }, apiKey: 'k',
  });
  assert.equal(redirected.error, 'aa-redirect-refused');

  const down = await fetchAaFreeList({
    http: { fetch: async () => { throw new Error('boom'); } }, apiKey: 'k',
  });
  assert.equal(down.error, 'aa-request-failed');
});

test('free-API rows normalize evaluations to flat fields', () => {
  const parsed = parseAaFreeList(JSON.stringify({ data: [
    {
      slug: 'claude-haiku-5-5',
      evaluations: { artificial_analysis_intelligence_index: 43.4, terminalbench_hard: 61.2, scicode: 55.0 },
      pricing: {},
      intelligenceIndexCostPerTask: 0.213,
      contextWindowTokens: 1000000,
    },
  ] }));
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].intelligenceIndex, 43.4);
  assert.equal(parsed.rows[0].terminalbenchHard, 61.2);
  assert.equal(parsed.rows[0].intelligenceIndexCostPerTask, 0.213);
  assert.equal(parsed.rows[0].apexAgents, null);
});

test('leaderboard URL is the public page and needs no key', () => {
  assert.equal(AA_LEADERBOARD_URL, 'https://artificialanalysis.ai/leaderboards/models');
  const args = buildAaLeaderboardFetchArgs();
  assert.equal(args.url, AA_LEADERBOARD_URL);
  assert.equal(args.options.headers.Accept, 'text/html');
  assert.throws(() => buildAaLeaderboardFetchArgs({ url: 'https://example.com/x' }), /aa-url-rejected/);
  assert.throws(() => buildAaLeaderboardFetchArgs({ url: 'http://artificialanalysis.ai/leaderboards/models' }), /aa-url-rejected/);
});

test('leaderboard fetch failures never throw', async () => {
  const down = await fetchAaLeaderboard({ http: { fetch: async () => { throw new Error('boom'); } } });
  assert.equal(down.error, 'aa-request-failed');
  const refused = await fetchAaLeaderboard({
    http: { fetch: async () => ({ status: 302, redirected: true }) },
  });
  assert.equal(refused.error, 'aa-redirect-refused');
  const big = await fetchAaLeaderboard({
    http: { fetch: async () => ({ status: 200, text: async () => 'x'.repeat(11) }) },
    maxResponseBytes: 10,
  });
  assert.equal(big.error, 'aa-response-too-large');
});

const leaderboardHtml = (models) => {
  const escaped = JSON.stringify(models).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `<html><head><script>window.__AA__="{\\"models\\":${escaped}}";</script></head></html>`;
};

test('leaderboard parser extracts the embedded models array', () => {
  const html = leaderboardHtml([
    {
      slug: 'glm-4-5v', name: 'GLM 4.5V', intelligenceIndex: 40.1,
      intelligenceIndexCostPerTask: 0.52, price1mInputTokens: 1.0, price1mOutputTokens: 3.0,
      hle: 12.5, terminalbenchV40: 48.0, contextWindowTokens: 200000, isReasoning: true,
    },
    {
      slug: 'claude-opus-5-5', intelligenceIndex: 57.6, scicode: 0.669,
      terminalbenchV40: 0.596, hle: 0.614, lcr: 0.847,
      intelligenceIndexCostPerTask: null, price1mInputTokens: 5, price1mOutputTokens: 25,
    },
  ]);
  const rows = parseAaLeaderboardHtml(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].slug, 'glm-4-5v');
  assert.equal(rows[0].intelligenceIndexCostPerTask, 0.52);
  assert.equal(rows[0].hle, 12.5);
  assert.equal(rows[0].isReasoning, true);
  assert.equal(rows[0].name, 'GLM 4.5V');
  assert.equal(rows[1].intelligenceIndex, 57.6);
  assert.equal(rows[1].intelligenceIndexCostPerTask, null);
  assert.equal(rows[1].lcr, 0.847);
});

test('leaderboard parser rejects unknown shapes', () => {
  assert.equal(parseAaLeaderboardHtml('<html>no data here</html>'), null);
  assert.equal(parseAaLeaderboardHtml(null), null);
  // Anchor present but the array never closes.
  assert.equal(parseAaLeaderboardHtml('prefix "{\\"models\\":[{\\"slug\\":\\"glm-4-5v\\", "x": 1'), null);
});

test('merge: leaderboard wins non-null fields, API fills gaps, union of slugs', () => {
  const api = [
    { slug: 'a', intelligenceIndex: 50, terminalbenchHard: 60, intelligenceIndexCostPerTask: null, price1mInputTokens: 2, price1mOutputTokens: 6 },
    { slug: 'api-only', intelligenceIndex: 10, intelligenceIndexCostPerTask: 0.1 },
  ];
  const board = [
    { slug: 'a', intelligenceIndex: 55, intelligenceIndexCostPerTask: 0.4, hle: 20 },
    { slug: 'board-only', intelligenceIndex: 30, intelligenceIndexCostPerTask: 0.2 },
  ];
  const merged = mergeAaRows(api, board);
  assert.equal(merged.rows.length, 3);
  const a = merged.rows.find(r => r.slug === 'a');
  assert.equal(a.intelligenceIndex, 55);
  assert.equal(a.intelligenceIndexCostPerTask, 0.4);
  assert.equal(a.hle, 20);
  assert.equal(a.terminalbenchHard, 60);
  assert.equal(a.price1mInputTokens, 2);
  assert.ok(merged.leaderboardSlugs.includes('a'));
  assert.ok(merged.leaderboardSlugs.includes('board-only'));
  assert.ok(!merged.leaderboardSlugs.includes('api-only'));
});

test('flat leaderboard-shaped rows pass through; duplicates flagged', () => {
  const parsed = parseAaFreeList(JSON.stringify([
    { slug: 'x-a', intelligenceIndex: 50, intelligenceIndexCostPerTask: 1 },
    { slug: 'x-a', intelligenceIndex: 51, intelligenceIndexCostPerTask: 1.1 },
  ]));
  assert.deepEqual(parsed.duplicateSlugs, ['x-a']);
  assert.equal(parseAaFreeList('not json'), null);
  assert.equal(parseAaFreeList(JSON.stringify({ hello: 1 })), null);
});
