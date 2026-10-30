import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as eligibility from '../src/eligibility.mjs';
import { resolveConfig } from '../src/plugin.mjs';
import { manifest } from '../src/manifest.mjs';

test('F-T1 fallback normalization defaults safely and strips unsupported roles', () => {
  assert.equal(typeof eligibility.normalizeAccountFallback, 'function');
  const normalize = eligibility.normalizeAccountFallback;
  const defaults = { enabled: false, roles: ['doer', 'other'], minQuality: -0.5 };
  for (const value of [undefined, null, true, 'true', { enabled: 'true', minQuality: NaN }, { enabled: 1, roles: 'doer', minQuality: Infinity }]) {
    assert.deepEqual(normalize(value), defaults);
  }
  const input = { enabled: true, roles: ['thinker', 'other', 'bogus', 'doer'], minQuality: -0.8 };
  const expected = { enabled: true, roles: ['other', 'doer'], minQuality: -0.8 };
  assert.deepEqual(normalize(input), expected);
  assert.deepEqual(resolveConfig({ roles: { accountFallback: input } }).roles.accountFallback, expected);
  assert.deepEqual(normalize({ enabled: true, roles: ['thinker', 'bogus'], minQuality: -Infinity }), { enabled: true, roles: [], minQuality: -0.5 });
  assert.deepEqual(normalize({ roles: [], minQuality: 0 }), { enabled: false, roles: [], minQuality: 0 });
  const result = normalize(input);
  input.roles.push('doer');
  assert.deepEqual(result, expected);
});

test('fallback config schema and example expose default-off settings', async () => {
  const schema = manifest.instanceConfigSchema.properties.roles.properties.accountFallback;
  assert.equal(schema.properties.enabled.default, false);
  assert.deepEqual(schema.properties.roles.default, ['doer', 'other']);
  assert.deepEqual(schema.properties.roles.items.enum, ['doer', 'other']);
  assert.equal(schema.properties.minQuality.default, -0.5);
  const example = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(resolveConfig(example).roles.accountFallback, { enabled: false, roles: ['doer', 'other'], minQuality: -0.5 });
});


test('duplicate fallback roles normalize to one entry each', () => {
  const normalized = eligibility.normalizeAccountFallback({ enabled: true, roles: ['other', 'doer', 'other', 'doer'] });
  assert.deepEqual(normalized.roles, ['other', 'doer']);
});
