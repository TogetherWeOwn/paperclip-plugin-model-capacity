import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ARM_MAP,
  parseEffortSuffix,
  effortAllowed,
  providerServes,
  resolveArms,
  armsForProvider,
  familyOfModelName,
  providerForModelName,
} from '../src/arms.mjs';

const rows = (slugs) => slugs.map(slug => ({ slug }));

test('spec examples map to CLIProxy model ids plus effort', () => {
  const { arms, skipped } = resolveArms(rows(['claude-haiku-5-5', 'gpt-6-1-sol-high']));
  assert.deepEqual(skipped.filter(s => ['claude-haiku-5-5', 'gpt-6-1-sol-high'].includes(s.aaSlug)), []);
  const haiku = arms.find(a => a.armId === 'claude-haiku-5-5');
  assert.deepEqual([haiku.model, haiku.effort], ['claude-haiku-5-5', 'max']);
  const sol = arms.find(a => a.armId === 'gpt-6-1-sol-high');
  assert.deepEqual([sol.model, sol.effort], ['gpt-6.1-sol', 'high']);
});

test('base slug means max effort; suffixed slugs parse', () => {
  assert.equal(parseEffortSuffix('claude-haiku-5-5'), 'max');
  assert.equal(parseEffortSuffix('gpt-6-1-sol-high'), 'high');
  assert.equal(parseEffortSuffix('muse-spark-1-3-contributor-xhigh'), 'xhigh');
});

test('muse contributor rows are capped at xhigh', () => {
  assert.equal(effortAllowed('muse', 'xhigh'), true);
  assert.equal(effortAllowed('muse', 'max'), false);
  assert.equal(effortAllowed('muse', 'ultra'), false);
  assert.equal(effortAllowed('sol', 'max'), true);
});

test('ladders are per account: families never cross providers', () => {
  assert.equal(providerServes('claude', 'sol'), false);
  assert.equal(providerServes('codex', 'haiku'), false);
  assert.equal(providerServes('codex', 'sol'), true);
  const { arms } = resolveArms(rows(DEFAULT_ARM_MAP.map(m => m.aaSlug)));
  const claudeArms = armsForProvider(arms, 'claude');
  assert.ok(claudeArms.length > 0);
  assert.ok(claudeArms.every(a => ['opus', 'sonnet', 'haiku'].includes(a.family)));
  const codexArms = armsForProvider(arms, 'codex');
  assert.ok(codexArms.every(a => ['sol', 'luna', 'astra'].includes(a.family)));
});

test('luna and astra families resolve to gpt-6-luna / gpt-6-astra ids', () => {
  const { arms, skipped } = resolveArms(rows([
    'gpt-6-1-luna', 'gpt-6-1-luna-high',
    'gpt-6-luna', 'gpt-6-luna-xhigh', 'gpt-6-luna-high', 'gpt-6-luna-medium', 'gpt-6-luna-low',
    'gpt-6-astra', 'gpt-6-astra-xhigh', 'gpt-6-astra-high', 'gpt-6-astra-medium', 'gpt-6-astra-low',
  ]));
  assert.deepEqual(skipped.filter(s => ['luna', 'astra'].includes(DEFAULT_ARM_MAP.find(m => m.aaSlug === s.aaSlug)?.family)), []);
  const luna = arms.filter(a => a.family === 'luna');
  assert.deepEqual(luna.map(a => a.effort).sort(), ['high', 'high', 'low', 'max', 'max', 'medium', 'xhigh']);
  const gpt6 = luna.filter(a => a.model === 'gpt-6-luna');
  assert.deepEqual(gpt6.map(a => a.effort).sort(), ['high', 'low', 'max', 'medium', 'xhigh']);
  assert.deepEqual(luna.filter(a => a.model === 'gpt-6.1-luna').map(a => a.effort).sort(), ['high', 'max']);
  const astra = arms.filter(a => a.family === 'astra');
  assert.deepEqual(astra.map(a => a.effort).sort(), ['high', 'low', 'max', 'medium', 'xhigh']);
  assert.ok(astra.every(a => a.model === 'gpt-6-astra'));
  assert.ok(arms.every(a => a.providers.includes('codex')));
});

test('muse base slug is skipped: Contributor has no max effort', () => {
  const { arms, skipped } = resolveArms(rows(['muse-spark-1-3', 'muse-spark-1-3-xhigh']), [
    { aaSlug: 'muse-spark-1-3', model: 'muse-spark-1.3-contributor', effort: 'max', family: 'muse', providers: ['meta'] },
    { aaSlug: 'muse-spark-1-3-xhigh', model: 'muse-spark-1.3-contributor', effort: 'xhigh', family: 'muse', providers: ['meta'] },
  ]);
  assert.deepEqual(arms.map(a => a.armId), ['muse-spark-1-3-xhigh']);
  assert.deepEqual(skipped, [{ aaSlug: 'muse-spark-1-3', reason: 'effort-inexpressible' }]);
});

test('run model strings map to family and provider; unknown stays null', () => {
  assert.equal(familyOfModelName('claude-opus-5-5'), 'opus');
  assert.equal(providerForModelName('claude-opus-5-5'), 'claude');
  assert.equal(familyOfModelName('gpt-6-luna(high)'), 'luna');
  assert.equal(providerForModelName('gpt-6-luna(high)'), 'codex');
  assert.equal(familyOfModelName('muse-spark-1.3-contributor(xhigh)'), 'muse');
  assert.equal(providerForModelName('muse-spark-1.3-contributor(xhigh)'), 'meta');
  // grok is a known hint but no lane provider serves it: family yes, provider null.
  assert.equal(familyOfModelName('grok-4-1-fast'), 'grok');
  assert.equal(providerForModelName('grok-4-1-fast'), null);
  assert.equal(familyOfModelName('something-entirely-new'), null);
  assert.equal(providerForModelName(null), null);
});

test('ambiguous and absent slugs are reported, not silently dropped', () => {
  const { arms, skipped } = resolveArms(
    [{ slug: 'dup' }, { slug: 'dup' }],
    [
      { aaSlug: 'dup', model: 'm', effort: 'max', family: 'sol', providers: ['codex'] },
      { aaSlug: 'gone', model: 'm', effort: 'max', family: 'sol', providers: ['codex'] },
    ],
  );
  assert.equal(arms.length, 0);
  assert.deepEqual(skipped.map(s => s.reason).sort(), ['slug-absent-from-snapshot', 'slug-ambiguous']);
});
