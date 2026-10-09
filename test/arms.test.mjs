import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ARM_MAP,
  MODEL_AA_OVERRIDES,
  PROVEN_FAMILIES,
  parseEffortSuffix,
  effortAllowed,
  resolveArms,
  canonicalModelName,
  inferFamily,
  familyOfModelName,
  slugCandidates,
  dynamicEffort,
  buildDynamicBindings,
  resolveDynamicArms,
  armsForAccount,
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

test('canonical names strip provider prefixes; non-strings stay null', () => {
  assert.equal(canonicalModelName('antigravity/gemini-3-flash'), 'gemini-3-flash');
  assert.equal(canonicalModelName('gemini-3-flash'), 'gemini-3-flash');
  assert.equal(canonicalModelName(null), null);
  assert.equal(canonicalModelName(''), null);
});

test('family inference: proven families, trial generations, first-segment fallback', () => {
  assert.equal(inferFamily('claude-opus-5-5'), 'opus');
  assert.equal(inferFamily('claude-sonnet-4-6'), 'claude-4-6');
  assert.equal(inferFamily('claude-opus-4-6-thinking'), 'claude-4-6');
  assert.equal(inferFamily('claude-haiku-5-5'), 'haiku');
  assert.equal(inferFamily('gpt-6.1-sol'), 'sol');
  assert.equal(inferFamily('gpt-6-luna'), 'luna');
  assert.equal(inferFamily('gpt-6-astra'), 'astra');
  assert.equal(inferFamily('gpt-oss-120b-medium'), 'oss');
  assert.equal(inferFamily('gemini-2-5-flash'), 'gemini');
  assert.equal(inferFamily('kimi-k3-256k'), 'kimi');
  assert.equal(inferFamily('grok-4-20-0309-reasoning'), 'grok');
  assert.equal(inferFamily('muse-spark-1.3-contributor'), 'muse');
  assert.equal(inferFamily('deepseek-v4-1'), 'deepseek');
  // Novel ids get their own first-segment family: never merged into an
  // unrelated trial budget or success history.
  assert.equal(inferFamily('something-entirely-new'), 'something');
  assert.equal(inferFamily(null), null);
  assert.ok(PROVEN_FAMILIES.includes('opus'));
  assert.ok(!PROVEN_FAMILIES.includes('claude-4-6'));
  assert.ok(!PROVEN_FAMILIES.includes('gemini'));
});

test('run model strings map to family; shadow labels and prefixed ids work', () => {
  assert.equal(familyOfModelName('claude-opus-5-5'), 'opus');
  assert.equal(familyOfModelName('gpt-6-luna(high)'), 'luna');
  assert.equal(familyOfModelName('antigravity/gemini-3-flash'), 'gemini');
  assert.equal(familyOfModelName('muse-spark-1.3-contributor(xhigh)'), 'muse');
  assert.equal(familyOfModelName('grok-4-1-fast'), 'grok');
  assert.equal(familyOfModelName('something-entirely-new'), 'something');
  assert.equal(familyOfModelName(null), null);
});

test('slug candidates: dots to dashes, suffix strips, contributor to xhigh', () => {
  assert.deepEqual(slugCandidates('gpt-6.1-sol'), ['gpt-6.1-sol', 'gpt-6-1-sol']);
  assert.deepEqual(slugCandidates('zen-free'), ['zen-free', 'zen']);
  assert.deepEqual(slugCandidates('muse-spark-1.3-contributor'),
    ['muse-spark-1.3-contributor', 'muse-spark-1-3-contributor', 'muse-spark-1-3-xhigh']);
  assert.deepEqual(slugCandidates('grok-4-20-0309'), ['grok-4-20-0309']);
  assert.equal(dynamicEffort('muse-spark-1.3-contributor'), 'xhigh');
  assert.equal(dynamicEffort('gemini-2-5-flash'), 'max');
});

test('override table holds only verified mismatches', () => {
  assert.equal(MODEL_AA_OVERRIDES['gpt-oss-120b-medium'], 'gpt-oss-120b');
  assert.equal(MODEL_AA_OVERRIDES['kimi-k3-256k'], 'kimi-k3');
  assert.equal(MODEL_AA_OVERRIDES['claude-opus-4-6-thinking'], 'claude-opus-4-6');
});

test('dynamic bindings: covered models skipped, overrides bypass candidates, non-chat unscored', () => {
  const { bindings, unscored } = buildDynamicBindings(
    ['claude-opus-5-5', 'antigravity/gpt-oss-120b-medium', 'test-private-eval', 'gemini-2-5-flash'],
    { coveredModels: ['claude-opus-5-5'] },
  );
  assert.ok(!bindings.some(b => b.model === 'claude-opus-5-5'));
  assert.ok(!unscored.some(u => u.model === 'claude-opus-5-5'));
  const oss = bindings.find(b => b.model === 'gpt-oss-120b-medium');
  assert.deepEqual([oss.aaSlug, oss.family, oss.dynamic], ['gpt-oss-120b', 'oss', true]);
  const gemini = bindings.find(b => b.model === 'gemini-2-5-flash');
  assert.deepEqual(gemini.slugCandidates, ['gemini-2-5-flash']);
  assert.deepEqual(unscored, [{ model: 'test-private-eval', reason: 'non-chat-model', tried: [] }]);
});

test('operator modelAaOverrides extend the built-in table', () => {
  const { bindings } = buildDynamicBindings(['my-model-1'], {
    overrides: { 'my-model-1': 'my-aa-slug' },
  });
  assert.equal(bindings[0].aaSlug, 'my-aa-slug');
});

test('dynamic arms join AA rows; misses are unscored, never invented', () => {
  const aaRows = rows(['gemini-2-5-flash', 'gpt-6-1-sol']);
  const { bindings } = buildDynamicBindings(['gemini-2-5-flash', 'no-such-model-9'], {});
  const { arms, unscored } = resolveDynamicArms(aaRows, bindings);
  assert.equal(arms.length, 1);
  assert.deepEqual([arms[0].armId, arms[0].family, arms[0].effort], ['gemini-2-5-flash', 'gemini', 'max']);
  assert.equal(unscored.length, 1);
  assert.deepEqual([unscored[0].model, unscored[0].reason], ['no-such-model-9', 'no-aa-match']);
});

test('ambiguous AA slugs never bind a dynamic arm', () => {
  const { bindings } = buildDynamicBindings(['dup-model'], {});
  const { arms, unscored } = resolveDynamicArms(
    [{ slug: 'dup-model' }, { slug: 'dup-model' }], bindings);
  assert.equal(arms.length, 0);
  assert.equal(unscored[0].reason, 'no-aa-match');
});

test('ladders are per account: models membership, no provider list', () => {
  const arms = [
    { armId: 'a', model: 'm-a', family: 'sol', providers: ['codex'] },
    { armId: 'b', model: 'm-b', family: 'gemini', providers: null, dynamic: true },
  ];
  // Feed with models lists: membership decides, classic binding included.
  const acct = { provider: 'antigravity', models: ['m-a', 'm-b'] };
  assert.deepEqual(armsForAccount(arms, acct).map(a => a.armId), ['a', 'b']);
  // A model the feed stops serving leaves every ladder automatically.
  assert.deepEqual(armsForAccount(arms, { provider: 'antigravity', models: ['m-b'] }).map(a => a.armId), ['b']);
  // Classic arms still match by provider on feeds that predate `models`;
  // dynamic arms require a list (never served anywhere = never eligible).
  const legacy = { provider: 'codex' };
  assert.deepEqual(armsForAccount(arms, legacy).map(a => a.armId), ['a']);
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
