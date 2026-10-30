import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, MODEL_ROUTING_ENV_KEYS, PLUGIN_ID } from '../src/manifest.mjs';

test('both build variants advertise the native router under the stable plugin identity', () => {
  for (const variant of ['transitional', 'clean']) {
    const manifest = buildManifest({variant});
    assert.equal(manifest.id, PLUGIN_ID);
    assert.ok(manifest.capabilities.includes('ai.connections.route'));
    assert.equal(manifest.aiConnectionRouter.name, 'Model Capacity pool');
    assert.ok(manifest.aiConnectionRouter.description.length > 0);
    assert.equal(manifest.instanceConfigSchema.properties.router.properties.companyId.format, 'uuid');
    assert.equal(manifest.instanceConfigSchema.properties.router.properties.ownerUserId.type, 'string');
  }
});

test('only the transitional build retains the old hook declaration and configuration', () => {
  const transitional = buildManifest({variant:'transitional'});
  const clean = buildManifest({variant:'clean'});
  assert.ok(transitional.capabilities.includes('run.model.resolve'));
  assert.deepEqual(transitional.modelRouting.envKeys, MODEL_ROUTING_ENV_KEYS);
  assert.match(transitional.description, /fork-image transitional dual-capability build, exit 2026-11-30/);
  assert.equal(transitional.instanceConfigSchema.properties.enforce.default, false);
  assert.equal(clean.capabilities.includes('run.model.resolve'), false);
  assert.equal(clean.modelRouting, undefined);
  assert.equal(clean.instanceConfigSchema.properties.enforce, undefined);
  assert.notEqual(clean.description, transitional.description);
});

test('unknown build variants fail closed instead of silently removing the hook', () => {
  assert.throws(() => buildManifest({variant:'transitionla'}), /variant/);
});
