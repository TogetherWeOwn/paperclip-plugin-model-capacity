import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DEFAULT_BASE_URL, isPlaceholderLaneHost, buildLaneRequest } from '../src/cliproxy.mjs';
import { LANE_BASE_URLS } from '../src/lane-host.mjs';
import { LANE_BASE_URL_ALLOWLIST, manifest, enforceManifest } from '../src/manifest.mjs';
import { createModelCapacityPlugin, validateConfigShape, resolveConfig } from '../src/plugin.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// --- the pin: one build-time module feeds every consumer ---

test('every consumer of the lane host reads the single build-time pin', () => {
  assert.ok(LANE_BASE_URLS.length >= 1);
  assert.equal(DEFAULT_BASE_URL, LANE_BASE_URLS[0]);
  assert.deepEqual([...LANE_BASE_URL_ALLOWLIST], [...LANE_BASE_URLS]);
  for (const m of [manifest, enforceManifest]) {
    const baseUrl = m.instanceConfigSchema.properties.cliproxy.properties.baseUrl;
    assert.deepEqual(baseUrl.enum, [...LANE_BASE_URLS]);
    assert.equal(baseUrl.default, LANE_BASE_URLS[0]);
  }
  assert.deepEqual(validateConfigShape({ cliproxy: { baseUrl: LANE_BASE_URLS[0] } }), []);
  assert.equal(resolveConfig({}).cliproxy.baseUrl, LANE_BASE_URLS[0]);
});

test('pin stays a strict allowlist: other origins are rejected and never carry the key', () => {
  for (const other of ['https://lane.example.com', 'https://lane-host.invalid.example.com', 'http://lane-host.invalid']) {
    if (LANE_BASE_URLS.includes(other)) continue;
    assert.ok(validateConfigShape({ cliproxy: { baseUrl: other } }).length > 0, other);
    assert.equal(resolveConfig({ cliproxy: { baseUrl: other } }).cliproxy.baseUrl, LANE_BASE_URLS[0], other);
  }
});

test('every pinned origin is a bare https origin', () => {
  for (const u of LANE_BASE_URLS) {
    const parsed = new URL(u);
    assert.equal(parsed.protocol, 'https:');
    assert.equal(u, parsed.origin);
  }
  assert.doesNotThrow(() => buildLaneRequest());
});

// --- placeholder: an unpinned build is inert and says so ---

test('placeholder detection covers only RFC 2606 .invalid hosts', () => {
  assert.equal(isPlaceholderLaneHost('https://lane-host.invalid'), true);
  assert.equal(isPlaceholderLaneHost('https://a.b.invalid'), true);
  assert.equal(isPlaceholderLaneHost('https://lane.example.com'), false);
  assert.equal(isPlaceholderLaneHost('https://invalid.example.com'), false);
  assert.equal(isPlaceholderLaneHost('not a url'), false);
});

test('onHealth degrades when the build did not pin a lane host', async () => {
  const plugin = createModelCapacityPlugin({ clock: () => Date.parse('2026-10-08T23:00:00Z') });
  const fake = {
    config: { get: async () => ({}) },
    state: { get: async () => null, set: async () => {} },
    secrets: { resolve: async () => 'lane-key' },
    http: { fetch: async () => ({ status: 200, json: async () => ({ accounts: [] }) }) },
    agents: { get: async () => null },
    issues: { get: async () => null },
    jobs: { register() {} },
    events: { on() {} },
    logger: { info() {}, error() {} },
  };
  await plugin.setup(fake);
  await plugin.onConfigChanged({}, { companyId: 'acme' });
  const health = await plugin.onHealth();
  const pinned = !isPlaceholderLaneHost();
  assert.equal(health.details.laneHostPinned, pinned);
  if (pinned) {
    assert.equal(health.status, 'ok');
  } else {
    assert.equal(health.status, 'degraded');
    assert.match(health.message, /Lane host not pinned/);
  }
});

// --- the public tree carries no internal host ---

// Hosts the public tree may name. The deployment's real lane host lives
// only in the package-build overlay of src/lane-host.mjs, never here.
const PUBLIC_HOSTS = new Set([
  'artificialanalysis.ai',
  'cliproxy', // docker service name used as a negative-test input
]);

// RFC 2606 reserved names: never routable to a real deployment.
const isReserved = host => host.endsWith('.invalid') || host === 'example.com' || host.endsWith('.example.com');

function trackedFiles() {
  const out = [join(ROOT, 'README.md'), join(ROOT, 'config.example.json'), join(ROOT, 'package.json')];
  for (const dir of ['src', 'test']) {
    for (const f of readdirSync(join(ROOT, dir))) {
      if (f.endsWith('.mjs')) out.push(join(ROOT, dir, f));
    }
  }
  // lane-host.mjs is the build overlay point: a deployment replaces it.
  return out.filter(f => !f.endsWith(join('src', 'lane-host.mjs')));
}

test('public files name only allowlisted hosts (no internal host in the tree)', () => {
  const offenders = [];
  for (const file of trackedFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)) {
      const host = m[1].toLowerCase();
      if (PUBLIC_HOSTS.has(host) || isReserved(host)) continue;
      offenders.push(`${file.slice(ROOT.length)}: ${host}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('example config pins the placeholder, not a real host', () => {
  const example = JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf8'));
  assert.equal(isPlaceholderLaneHost(example.cliproxy.baseUrl), true);
});
