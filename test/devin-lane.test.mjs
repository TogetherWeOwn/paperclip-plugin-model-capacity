import test from 'node:test';
import assert from 'node:assert/strict';
import * as arms from '../src/arms.mjs';
import { resolveConfig, validateConfigShape } from '../src/plugin.mjs';

test('mandatory banned models cannot create dynamic, classic, or task arms', () => {
  for (const model of ['gpt-6-sol', 'devin/gpt-6-sol', 'gpt-5.6-terra', 'gpt-5-6-terra', 'devin/gpt-5-6-terra']) {
    const bare = arms.canonicalModelName(model);
    const row = { slug: bare.replaceAll('.', '-'), intelligenceIndex: 50, intelligenceIndexCostPerTask: 1 };
    const binding = { aaSlug: row.slug, model: bare, family: 'terra', effort: 'max', providers: ['devin'] };
    assert.equal(arms.isBannedModel(model, []), true, model);
    assert.equal(arms.buildDynamicBindings([model]).unscored[0].reason, 'banned-model');
    assert.equal(arms.resolveArms([row], [binding]).skipped[0].reason, 'banned-model');
    assert.equal(arms.discoverTaskArms([row], [model]).unscored[0].reason, 'banned-model');
  }
  for (const model of ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-5.6-sol', 'swe-2']) assert.equal(arms.isBannedModel(model, []), false, model);
  assert.equal(arms.isBannedModel('devin/kimi-k3', ['kimi-k3']), true);
});

test('additional banned model configuration only widens mandatory bans', () => {
  assert.ok(validateConfigShape({ bannedModels: ['devin/kimi-k3'] }).some(e => e.includes('bannedModels')));
  assert.ok(validateConfigShape({ bannedModels: [null] }).some(e => e.includes('bannedModels')));
  assert.deepEqual(resolveConfig({ bannedModels: ['kimi-k3', 'kimi-k3'] }).bannedModels, ['kimi-k3']);
  assert.deepEqual(validateConfigShape({ bannedModels: [] }), []);
});
