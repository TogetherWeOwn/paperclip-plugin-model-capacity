import test from 'node:test';
import assert from 'node:assert/strict';
import { manifest, enforceManifest, buildManifest, PLUGIN_ID, PLUGIN_VERSION, MODEL_ROUTING_ENV_KEYS, LANE_BASE_URL_ALLOWLIST } from '../src/manifest.mjs';

test('plugin identity and version', () => {
  assert.equal(manifest.id, PLUGIN_ID);
  assert.equal(PLUGIN_ID, 'togetherweown.model-capacity');
  assert.equal(manifest.version, '0.2.8');
  assert.equal(PLUGIN_VERSION, '0.2.8');
});

test('no database grant: no database block, no db capabilities', () => {
  assert.equal(manifest.database, undefined);
  for (const cap of manifest.capabilities) {
    assert.ok(!cap.startsWith('database.'), `db capability ${cap}`);
  }
  assert.deepEqual(buildManifest({ modelResolve: false }).database, undefined);
});

test('lane endpoint pinned to the allowlist in schema', () => {
  assert.deepEqual([...LANE_BASE_URL_ALLOWLIST], ['https://router.infextion.net']);
  assert.deepEqual(
    manifest.instanceConfigSchema.properties.cliproxy.properties.baseUrl.enum,
    ['https://router.infextion.net'],
  );
});

test('default manifest is shadow-only: no run.model.resolve, no modelRouting', () => {
  assert.ok(!manifest.capabilities.includes('run.model.resolve'));
  assert.equal(manifest.modelRouting, undefined);
  assert.deepEqual(manifest, buildManifest({ modelResolve: false }));
  assert.deepEqual(manifest, buildManifest());
});

test('opt-in enforceManifest holds run.model.resolve with the exact env keys', () => {
  assert.ok(enforceManifest.capabilities.includes('run.model.resolve'));
  // Exactly the env keys decide may set: nothing more, nothing less.
  assert.deepEqual(MODEL_ROUTING_ENV_KEYS, [
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  ]);
  assert.deepEqual(enforceManifest.modelRouting.envKeys, MODEL_ROUTING_ENV_KEYS);
  // The only capability the enforce variant adds over the default.
  assert.deepEqual(
    enforceManifest.capabilities.filter(c => !manifest.capabilities.includes(c)),
    ['run.model.resolve'],
  );
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

test('v0.2.8 schema declares trials and modelAaOverrides', () => {
  const props = manifest.instanceConfigSchema.properties;
  assert.equal(props.trials.properties.maxInFlightPerAccount.default, 2);
  assert.equal(props.trials.properties.maxInFlightPerFamily.default, 2);
  assert.equal(props.trials.properties.minRuns.default, 10);
  assert.equal(props.trials.properties.minSuccessRate.default, 0.8);
  assert.deepEqual(props.trials.properties.adapters.default, { claude_local: ['*'], 'claude-code': ['*'] });
  assert.deepEqual(props.modelAaOverrides.default, {});
  assert.deepEqual(buildManifest({ modelResolve: false }).instanceConfigSchema.properties.trials, props.trials);
});
