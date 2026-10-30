import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { replayTick } from '../scripts/aa-replay.mjs';
import { withSyntheticReadiness } from './synthetic-readiness.mjs';
import * as eligibility from '../src/eligibility.mjs';
import { resolveConfig } from '../src/plugin.mjs';
import { manifest } from '../src/manifest.mjs';

const nowMs = Date.parse('2026-10-29T12:00:00Z');
const baseConfig = { roles: { doerAgentIds: ['doer'], thinkerAgentIds: ['thinker'] }, reviewReserve: { agentIds: ['reviewer'] } };
const lane = withSyntheticReadiness({ observedAt: new Date(nowMs).toISOString(), accounts: [{ lane: 'sample', provider: 'meta', accountKey: 'sample', health: 'healthy', models: ['muse-spark-1.3-contributor', 'muse-spark-1.4-contributor'], observedAt: new Date(nowMs).toISOString(), quality: 'live', weekly: { used: 0.2, resetsAt: '2026-11-05T12:00:00Z' }, fiveHour: { used: 0.1, resetsAt: '2026-10-29T17:00:00Z' } }] }, nowMs);
const snapshot = { fetchedAt: new Date(nowMs).toISOString(), rows: [{ slug: 'muse-spark-1-3-xhigh', intelligenceIndex: 50, intelligenceIndexCostPerTask: 1 }, { slug: 'muse-spark-1-4-xhigh', intelligenceIndex: 55, intelligenceIndexCostPerTask: 2 }], duplicateSlugs: [] };
const inputs = { lane, snapshot, states: {}, demand: { doer: 2, thinker: 1, other: 0 }, nowMs };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function project(result) {
  const copy = structuredClone({ capacity: result.capacity, ladders: result.ladders });
  assert.match(copy.capacity.reviewAdmissionEpoch, uuid);
  copy.capacity.reviewAdmissionEpoch = '<epoch>';
  return copy;
}

// The checked-in golden was captured from a368f5c's behavior before N2.
test('N-T19 Gate S: off, false and malformed configurations preserve full published state', async () => {
  const golden = JSON.parse(await readFile(new URL('./fixtures/newest-config-off-golden.json', import.meta.url), 'utf8'));
  const baseline = await replayTick({ ...inputs, config: baseConfig });
  const again = await replayTick({ ...inputs, config: baseConfig });
  assert.notEqual(baseline.capacity.reviewAdmissionEpoch, again.capacity.reviewAdmissionEpoch);
  assert.deepEqual(project(baseline), project(again));
  assert.deepEqual(JSON.parse(JSON.stringify(project(baseline))), golden);
  for (const newestVersionOnly of [undefined, { enabled: false }, { enabled: 'true', overrides: { keep: 42, parsePins: [] } }, null, 'true']) {
    const config = { ...baseConfig, roles: { ...baseConfig.roles, ...(newestVersionOnly === undefined ? {} : { newestVersionOnly }) } };
    const result = await replayTick({ ...inputs, config });
    assert.deepEqual(project(result), project(baseline));
    assert.deepEqual(JSON.parse(JSON.stringify(project(result))), golden);
  }
});

test('newest normalizer defaults off and drops malformed overrides', () => {
  assert.equal(typeof eligibility.normalizeNewestVersionOnly, 'function');
  const normalize = eligibility.normalizeNewestVersionOnly;
  const empty = { enabled: false, overrides: { keep: [], productAliases: {}, parsePins: {} } };
  for (const value of [undefined, null, true, 'yes', { enabled: 'true' }, { enabled: 1 }]) assert.deepEqual(normalize(value), empty);
  const input = { enabled: true, overrides: {
    keep: ['arm:foo@high', 'model:foo', 'product:foo', 'foo', '', 'arm:', 1, null],
    productAliases: { foo: 'bar', bad: '', empty: 1 },
    parsePins: { 'model:foo': { product: 'bar', version: [1, 2] }, 'arm:foo@high': { product: 'bar', version: [2] }, bad: { product: '', version: [1] }, bad2: { product: 'x', version: [-1] }, bad3: { product: 'x', version: [] }, bad4: null },
  } };
  const expected = { enabled: true, overrides: { keep: ['arm:foo@high', 'model:foo', 'product:foo', 'foo'], productAliases: { foo: 'bar' }, parsePins: { 'model:foo': { product: 'bar', version: [1, 2] }, 'arm:foo@high': { product: 'bar', version: [2] } } } };
  assert.deepEqual(normalize(input), expected);
  assert.deepEqual(resolveConfig({ roles: { newestVersionOnly: input } }).roles.newestVersionOnly, expected);
  input.overrides.parsePins['model:foo'].version.push(9);
  assert.deepEqual(expected.overrides.parsePins['model:foo'].version, [1, 2]);
});

test('newest configuration is exposed default-off in manifest and example', async () => {
  const schema = manifest.instanceConfigSchema.properties.roles.properties.newestVersionOnly;
  assert.equal(schema.properties.enabled.default, false);
  assert.ok(schema.properties.overrides.properties.keep);
  assert.ok(schema.properties.overrides.properties.productAliases);
  assert.ok(schema.properties.overrides.properties.parsePins);
  const example = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(resolveConfig(example).roles.newestVersionOnly, { enabled: false, overrides: { keep: [], productAliases: {}, parsePins: {} } });
});
