import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ARM_MAP,
  parseEffortSuffix,
  effortAllowed,
  providerServes,
  resolveArms,
  armsForProvider,
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
  assert.ok(codexArms.every(a => ['sol', 'luna'].includes(a.family)));
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
