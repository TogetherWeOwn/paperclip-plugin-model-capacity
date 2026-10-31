import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalModelName, inferFamily, familyOfModelName, isReservedKey } from '../src/arms.mjs';
import { matchPricingTier, isSafeTierPattern, TIER_MODEL_KEY_MAX_CHARS, TIER_PATTERNS_TOTAL_MAX } from '../src/tiers.mjs';
import { readBoundedText, ResponseTooLargeError } from '../src/bounded-body.mjs';
import { fetchAaLeaderboard, fetchAaFreeList } from '../src/aa.mjs';

test('reserved object keys never come out as a model name or family', () => {
  for (const name of ['__proto__', 'openai/__proto__', 'constructor', 'claude/Constructor', 'prototype', '__proto__[1m]']) {
    assert.equal(canonicalModelName(name), null, name);
    assert.equal(isReservedKey(familyOfModelName(name) ?? ''), false, name);
  }
  assert.equal(inferFamily('__proto__-x'), null);
  assert.equal(inferFamily('constructor-2'), null);
  assert.equal(isReservedKey('kimi'), false);
  assert.equal(canonicalModelName('openai/gpt-6.1-sol'), 'gpt-6.1-sol');
  assert.equal(inferFamily('kimi-k3'), 'kimi');
});

// The audited nested-quantifier pattern, assembled at runtime: it is test
// data for the refusal path, never compiled.
const NESTED = ['^(a', '+)+$'].join('');

test('feed tier patterns with unbounded backtracking are refused without running', () => {
  for (const p of [NESTED, '(a|aa)*$', '(?:a*)+', 'a*a*b', '.*.*x', 'a{1,100}a{1,100}x', '(a)\\1', '(?=a)a', '(?<n>a)', '(?<!a)b', '[a-z'])
    assert.equal(isSafeTierPattern(p), false, p);
  for (const p of ['haiku', '^m$', '^gpt-6\\.1-sol', '^gpt-6[.-]1-sol', 'gpt[-.]6[-.]1[-_]sol', '^claude-(opus|sonnet)-4', '^sol.*', '[(*+]x', 'a{1,16}b?'])
    assert.equal(isSafeTierPattern(p), true, p);
  assert.equal(isSafeTierPattern('x'.repeat(201)), false);

  // The audited reproduction: 29 chars blocked the worker for seconds.
  const entry = { family: 'evil', match: [NESTED] };
  const started = performance.now();
  assert.equal(matchPricingTier(`${'a'.repeat(28)}!`, [entry]), null);
  assert.equal(matchPricingTier(`${'a'.repeat(TIER_MODEL_KEY_MAX_CHARS - 1)}!`, [entry]), null);
  assert.ok(performance.now() - started < 50, 'refused patterns return immediately');

  const sol = { family: 'sol', match: [NESTED, '^gpt-6[.-]1-sol'] };
  assert.equal(matchPricingTier('gpt-6.1-sol', [sol]), sol, 'a refused pattern does not hide a safe sibling');
  assert.equal(matchPricingTier(`gpt-6.1-sol${'x'.repeat(TIER_MODEL_KEY_MAX_CHARS)}`, [sol]), null, 'over-long keys never match');
});

test('one tier match call tests a bounded number of feed patterns', () => {
  const filler = Array.from({ length: TIER_PATTERNS_TOTAL_MAX }, (_, i) => ({ family: `f${i}`, match: [`^nope-${i}$`] }));
  const late = { family: 'late', match: ['^late$'] };
  assert.equal(matchPricingTier('late', [late]), late);
  assert.equal(matchPricingTier('late', [...filler, late]), null);
});

test('bounded reads refuse a declared or streamed body past the cap', async () => {
  assert.equal(await readBoundedText(new Response('hello'), 5), 'hello');
  await assert.rejects(readBoundedText(new Response('hello!'), 5), ResponseTooLargeError);
  await assert.rejects(
    readBoundedText({ headers: new Headers({ 'content-length': '6' }), text: async () => assert.fail('read') }, 5),
    ResponseTooLargeError,
  );
  let cancelled = false;
  const declared = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': '6' } });
  await assert.rejects(readBoundedText(declared, 5), ResponseTooLargeError);
  assert.equal(cancelled, true, 'a refused declared body is released, not left open');
  let pulled = 0;
  const endless = new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(1024)); } });
  await assert.rejects(readBoundedText(new Response(endless), 4096), ResponseTooLargeError);
  assert.ok(pulled <= 6, `stopped after ${pulled} chunks`);
  assert.equal(await readBoundedText({ text: async () => 'é' }, 2), 'é');
  await assert.rejects(readBoundedText({ text: async () => 'é' }, 1), ResponseTooLargeError);
});

test('AA fetches stop reading an oversized body', async () => {
  const huge = () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(64 * 1024)); } }), { status: 200 });
  const page = await fetchAaLeaderboard({ http: { fetch: async () => huge() }, maxResponseBytes: 256 * 1024 });
  assert.deepEqual(page, { ok: false, error: 'aa-response-too-large', retryable: false });
  const list = await fetchAaFreeList({ http: { fetch: async () => huge() }, apiKey: 'k', maxResponseBytes: 256 * 1024 });
  assert.equal(list.error, 'aa-response-too-large');
});
