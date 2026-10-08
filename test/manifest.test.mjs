import test from 'node:test';
import assert from 'node:assert/strict';
import { manifest, buildManifest, PLUGIN_ID, PLUGIN_VERSION, MODEL_ROUTING_ENV_KEYS } from '../src/manifest.mjs';

test('plugin identity and version', () => {
  assert.equal(manifest.id, PLUGIN_ID);
  assert.equal(PLUGIN_ID, 'togetherweown.model-capacity');
  assert.equal(manifest.version, '0.2.0');
  assert.equal(PLUGIN_VERSION, '0.2.0');
});

test('heartbeat read: database declaration plus paired capabilities, never write', () => {
  assert.deepEqual(manifest.database, {
    namespaceSlug: 'model_capacity',
    migrationsDir: './migrations',
    coreReadTables: ['heartbeat_runs'],
  });
  assert.ok(manifest.capabilities.includes('database.namespace.read'));
  // Declared-but-unexercised: the host schema validator pairs migrate
  // with read for any manifest declaring `database`.
  assert.ok(manifest.capabilities.includes('database.namespace.migrate'));
  assert.ok(!manifest.capabilities.includes('database.namespace.write'));
  assert.deepEqual(buildManifest({ modelResolve: true }).database, manifest.database);
});

test('v0.2.0 default manifest holds run.model.resolve with the exact env keys', () => {
  assert.ok(manifest.capabilities.includes('run.model.resolve'));
  // Exactly the env keys decide may set: nothing more, nothing less.
  assert.deepEqual(MODEL_ROUTING_ENV_KEYS, [
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  ]);
  assert.deepEqual(manifest.modelRouting.envKeys, MODEL_ROUTING_ENV_KEYS);
});

test('shadow variant still builds without resolve for comparison tests', () => {
  const shadow = buildManifest({ modelResolve: false });
  assert.ok(!shadow.capabilities.includes('run.model.resolve'));
  assert.equal(shadow.modelRouting, undefined);
  assert.deepEqual(shadow.database, manifest.database);
});

test('enforce kill switch defaults false in schema', () => {
  assert.equal(manifest.instanceConfigSchema.properties.enforce.default, false);
  assert.equal(
    manifest.instanceConfigSchema.properties.contextCaps.properties.autoCompactEnvKey.default,
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  );
});

test('jobs and API routes are declared', () => {
  const jobs = new Map(manifest.jobs.map(j => [j.jobKey, j.schedule]));
  assert.equal(jobs.get('aa-refresh'), '17 4 * * *');
  assert.equal(jobs.get('shadow-tick'), '* * * * *');
  const routes = new Map(manifest.apiRoutes.map(r => [r.routeKey, r.path]));
  assert.deepEqual([...routes.keys()].sort(), ['capacity', 'caps', 'ladder', 'shadow']);
  assert.equal(routes.get('caps'), '/caps');
});

test('shadow entrypoints use no build step', () => {
  assert.equal(manifest.entrypoints.worker, './src/worker.mjs');
});
