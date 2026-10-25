import test from 'node:test';
import assert from 'node:assert/strict';
import { manifest, enforceManifest, buildManifest, PLUGIN_ID, PLUGIN_VERSION, MODEL_ROUTING_ENV_KEYS, LANE_BASE_URL_ALLOWLIST } from '../src/manifest.mjs';
import { validateConfigShape } from '../src/plugin.mjs';
import { DEFAULT_REVIEWER, normalizeReviewer } from '../src/reviewer.mjs';
import { LANE_BASE_URLS } from '../src/lane-host.mjs';

test('plugin identity and version', () => {
  assert.equal(manifest.id, PLUGIN_ID);
  assert.equal(PLUGIN_ID, 'togetherweown.model-capacity');
  assert.equal(manifest.version, '0.2.68');
  assert.equal(PLUGIN_VERSION, '0.2.68');
});

test('no database grant: no database block, no db capabilities', () => {
  assert.equal(manifest.database, undefined);
  assert.ok(manifest.capabilities.includes('agents.queued_counts.read'),
    'queued-run demand reads the host-aggregated seam');
  for (const cap of manifest.capabilities) {
    assert.ok(!cap.startsWith('database.'), `db capability ${cap}`);
  }
  assert.deepEqual(buildManifest({ modelResolve: false }).database, undefined);
  assert.ok(buildManifest({ modelResolve: false }).capabilities.includes('agents.queued_counts.read'));
});

test('lane endpoint pinned to the allowlist in schema', () => {
  assert.deepEqual([...LANE_BASE_URL_ALLOWLIST], [...LANE_BASE_URLS]);
  assert.deepEqual(
    manifest.instanceConfigSchema.properties.cliproxy.properties.baseUrl.enum,
    [...LANE_BASE_URLS],
  );
  assert.equal(
    manifest.instanceConfigSchema.properties.cliproxy.properties.baseUrl.default,
    LANE_BASE_URLS[0],
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

test('credential readiness admission is a strict opt-in object', () => {
  const schema = manifest.instanceConfigSchema.properties.credentialReadiness;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['enforce']);
  assert.equal(schema.properties.enforce.type, 'boolean');
  assert.equal(schema.properties.enforce.default, false);
  assert.ok(validateConfigShape({ credentialReadiness: { enforce: false } }).length === 0);
  assert.ok(validateConfigShape({ credentialReadiness: { enforce: 'true' } }).some(e => e.includes('must be a boolean')));
  assert.ok(validateConfigShape({ credentialReadiness: { enforce: false, unknown: true } }).some(e => e.includes('not a known key')));
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

test('v0.2.13 schema declares trials and modelAaOverrides', () => {
  const props = manifest.instanceConfigSchema.properties;
  assert.equal(props.trials.properties.maxInFlightPerAccount.default, 2);
  assert.equal(props.trials.properties.maxInFlightPerFamily.default, 2);
  assert.equal(props.trials.properties.minRuns.default, 10);
  assert.equal(props.trials.properties.minSuccessRate.default, 0.8);
  assert.deepEqual(props.trials.properties.adapters.default, { claude_local: ['*'], 'claude-code': ['*'] });
  assert.deepEqual(props.trials.properties.maxInFlightPerAccountByProvider.default, {});
  assert.deepEqual(props.placement.properties.freeCostProviders.default, []);
  assert.deepEqual(props.modelAaOverrides.default, {});
  assert.deepEqual(buildManifest({ modelResolve: false }).instanceConfigSchema.properties.trials, props.trials);
});

test('package.json version tracks PLUGIN_VERSION (no release drift)', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.version, PLUGIN_VERSION);
});

test('reviewer schema declares every normalized knob (manifest/validator/example parity)', async () => {
  // Paperclip Review probe: the host validates instance config against the
  // manifest schema at the API boundary, so a knob missing here rejects the
  // documented config even though normalizeReviewer and validateConfigShape
  // accept it.
  const schema = manifest.instanceConfigSchema.properties.reviewer;
  assert.equal(schema.additionalProperties, false);
  for (const key of Object.keys(normalizeReviewer(null))) {
    assert.ok(key in schema.properties, `reviewer schema missing ${key}`);
  }
  assert.equal(schema.properties.doerStarvationMarginRuns.type, 'number');
  assert.equal(schema.properties.doerStarvationMarginRuns.default, DEFAULT_REVIEWER.doerStarvationMarginRuns);
  assert.equal(schema.properties.doerStarvationSustainMs.type, 'number');
  assert.equal(schema.properties.doerStarvationSustainMs.default, DEFAULT_REVIEWER.doerStarvationSustainMs);
  const { readFile } = await import('node:fs/promises');
  const example = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url)));
  for (const key of Object.keys(example.reviewer ?? {})) {
    assert.ok(key in schema.properties, `config.example.json reviewer key ${key} rejected by the schema`);
  }
  assert.deepEqual(validateConfigShape({ reviewer: example.reviewer }), []);
});
