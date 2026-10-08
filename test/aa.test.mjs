import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAaFetchArgs, fetchAaFreeList, parseAaFreeList, AA_FREE_LIST_URL } from '../src/aa.mjs';

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

test('flat leaderboard-shaped rows pass through; duplicates flagged', () => {
  const parsed = parseAaFreeList(JSON.stringify([
    { slug: 'x-a', intelligenceIndex: 50, intelligenceIndexCostPerTask: 1 },
    { slug: 'x-a', intelligenceIndex: 51, intelligenceIndexCostPerTask: 1.1 },
  ]));
  assert.deepEqual(parsed.duplicateSlugs, ['x-a']);
  assert.equal(parseAaFreeList('not json'), null);
  assert.equal(parseAaFreeList(JSON.stringify({ hello: 1 })), null);
});
