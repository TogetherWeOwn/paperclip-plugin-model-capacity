import test from 'node:test';
import assert from 'node:assert/strict';
import { manifest, buildManifest, PLUGIN_ID, PLUGIN_VERSION, MODEL_ROUTING_ENV_KEYS } from '../src/manifest.mjs';

test('plugin identity and version', () => {
  assert.equal(manifest.id, PLUGIN_ID);
  assert.equal(PLUGIN_ID, 'togetherweown.model-capacity');
  assert.equal(manifest.version, '0.1.1');
  assert.equal(PLUGIN_VERSION, '0.1.1');
});

test('v0.1.1 shadow declares NO run.model.resolve capability and no modelRouting', () => {
  assert.ok(!manifest.capabilities.includes('run.model.resolve'));
  assert.equal(manifest.modelRouting, undefined);
});

test('v0.2.0 variant enables resolve with declared env keys', () => {
  const v2 = buildManifest({ modelResolve: true });
  assert.ok(v2.capabilities.includes('run.model.resolve'));
  assert.deepEqual(v2.modelRouting.envKeys, MODEL_ROUTING_ENV_KEYS);
  assert.ok(MODEL_ROUTING_ENV_KEYS.includes('CLAUDE_CODE_MAX_CONTEXT_TOKENS'));
});

test('jobs and API routes are declared', () => {
  const jobs = new Map(manifest.jobs.map(j => [j.jobKey, j.schedule]));
  assert.equal(jobs.get('aa-refresh'), '17 4 * * *');
  assert.equal(jobs.get('shadow-tick'), '* * * * *');
  const routes = new Map(manifest.apiRoutes.map(r => [r.routeKey, r.path]));
  assert.deepEqual([...routes.keys()].sort(), ['capacity', 'ladder', 'shadow']);
  assert.equal(routes.get('capacity'), '/capacity');
});

test('shadow entrypoints use no build step', () => {
  assert.equal(manifest.entrypoints.worker, './src/worker.mjs');
});
