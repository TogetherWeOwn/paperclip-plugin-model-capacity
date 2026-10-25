import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DEFAULT_BASE_URL, isPlaceholderLaneHost, assertLaneHostPinned, buildLaneRequest } from '../src/cliproxy.mjs';
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

test('assertLaneHostPinned throws only for a placeholder host', () => {
  assert.throws(() => assertLaneHostPinned('https://lane-host.invalid'), /cliproxy-lane-host-unpinned/);
  assert.throws(() => assertLaneHostPinned('https://a.b.invalid'), /cliproxy-lane-host-unpinned/);
  assert.doesNotThrow(() => assertLaneHostPinned('https://lane.example.com'));
  // The default argument is the build pin: an unpinned build throws.
  if (isPlaceholderLaneHost()) assert.throws(() => assertLaneHostPinned(), /cliproxy-lane-host-unpinned/);
  else assert.doesNotThrow(() => assertLaneHostPinned());
});

const SECRET = { type: 'secret_ref', secretId: '11111111-2222-3333-4444-555555555555' };
const AA_STATE_KEY = { scopeKind: 'company', scopeId: 'acme', namespace: 'model-capacity', stateKey: 'aa-snapshot-v1' };

test('the lane secret is read only after the pin check, by default', async () => {
  const now = Date.parse('2026-10-08T23:00:00Z');
  const store = new Map();
  const jobs = new Map();
  const calls = { resolve: 0, fetch: [], errors: [] };
  const fake = {
    config: { get: async () => ({ cliproxy: { laneKeySecretRef: SECRET } }) },
    state: { get: async k => store.get(JSON.stringify(k)) ?? null, set: async (k, v) => { store.set(JSON.stringify(k), v); } },
    secrets: { resolve: async () => { calls.resolve += 1; return 'lane-key'; } },
    http: { fetch: async url => { calls.fetch.push(url); return { status: 200, json: async () => ({ accounts: [] }) }; } },
    agents: { get: async () => null },
    issues: { get: async () => null },
    jobs: { register: (n, fn) => { jobs.set(n, fn); } },
    events: { on() {} },
    logger: { info() {}, error: (_m, e) => calls.errors.push(e?.error) },
  };
  // No requirePinnedLaneHost override: this is the deployed configuration.
  const plugin = createModelCapacityPlugin({ clock: () => now });
  await plugin.setup(fake);
  store.set(JSON.stringify(AA_STATE_KEY), { fetchedAt: new Date(now).toISOString(), rows: [], duplicateSlugs: [] });
  await plugin.onConfigChanged({ cliproxy: { laneKeySecretRef: SECRET } }, { companyId: 'acme' });
  if (isPlaceholderLaneHost()) {
    await assert.rejects(() => jobs.get('shadow-tick')({}), /shadow-tick-failed/);
    assert.deepEqual(calls.errors, ['cliproxy-lane-host-unpinned']);
    assert.equal(calls.resolve, 0, 'unpinned build must not resolve the lane secret');
    assert.deepEqual(calls.fetch, [], 'unpinned build must not issue any request');
  } else {
    await jobs.get('shadow-tick')({});
    assert.equal(calls.resolve, 1);
    assert.equal(calls.fetch.length, 1);
    assert.ok(calls.fetch[0].startsWith(LANE_BASE_URLS[0]));
  }
});

test('the worker entry never disables the pin guard', () => {
  const worker = readFileSync(join(ROOT, 'src', 'worker.mjs'), 'utf8');
  assert.match(worker, /createModelCapacityPlugin\(\)/);
  assert.doesNotMatch(worker, /requirePinnedLaneHost/);
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
// only in the package-build overlay of the pin file, never here.
const PUBLIC_HOSTS = new Set([
  'artificialanalysis.ai',
  'api.github.com', // fixed read-only reviewer-demand census, not a lane host
  'cliproxy', // docker service name used as a negative-test input
  'z.ai', // model provider named in an error-path fixture, not a lane host
  'codex-reset.com', // public Codex free-reset timeline feeding burnHorizon history, not a lane host
]);

// Reserved names: never routable to a real deployment.
const isReserved = host =>
  host.endsWith('.invalid') ||
  host === 'example.com' ||
  host.endsWith('.example.com') ||
  host.endsWith('.example') ||
  host.endsWith('.test') ||
  host === 'localhost' ||
  host.endsWith('.localhost');

// Suffixes a bare dotted token must end in to count as a host candidate.
// Kept tight so code chains (which end in words like "model" or "read")
// never match; only real host suffixes do.
const BARE_HOST_SUFFIX = new Set([
  'com', 'net', 'org', 'io', 'dev', 'app', 'cloud', 'ai',
  'co', 'us', 'uk', 'de', 'fr', 'jp', 'xyz', 'me', 'so', 'sh', 'cc',
  'internal', 'corp', 'local', 'lan', 'home', 'intranet', 'private',
  'invalid', 'example', 'test', 'localhost',
]);

function collectUrlHosts(text) {
  const hosts = [];
  for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)) {
    hosts.push(m[1].toLowerCase());
  }
  return hosts;
}

function collectBareHosts(text) {
  const hosts = [];
  for (const m of text.matchAll(/\b([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+)(:[0-9]{2,5})?\b/g)) {
    const dotted = m[1].toLowerCase();
    const tld = dotted.split('.').pop();
    if (!BARE_HOST_SUFFIX.has(tld)) continue;
    if (!/[a-z]/.test(tld)) continue; // skip version-like numeric tails
    hosts.push(dotted);
  }
  return hosts;
}

function isAllowlistedHost(host) {
  return PUBLIC_HOSTS.has(host) || isReserved(host);
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, out);
    else if (st.isFile()) out.push(full);
  }
  return out;
}

function trackedFiles() {
  // Every file in the worktree except the build overlay point: prose,
  // workflows and scripts are where a host typically comes back.
  const overlay = join(ROOT, 'src', 'lane-host.mjs');
  return walkFiles(ROOT).filter(f => f !== overlay);
}

test('public files name only allowlisted hosts (no internal host in the tree)', () => {
  const offenders = [];
  const seen = new Set();
  for (const file of trackedFiles()) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const host of [...collectUrlHosts(text), ...collectBareHosts(text)]) {
      if (isAllowlistedHost(host)) continue;
      const key = `${file.slice(ROOT.length)}: ${host}`;
      if (seen.has(key)) continue;
      seen.add(key);
      offenders.push(key);
    }
  }
  assert.deepEqual(offenders, []);
});

test('host guard scans workflows and scripts, not just src and docs', () => {
  const files = trackedFiles().map(f => f.slice(ROOT.length));
  assert.ok(files.some(f => f.endsWith(join('.github', 'workflows', 'ci.yml'))));
  assert.ok(files.some(f => f.endsWith(join('scripts', 'check-public-pin.mjs'))));
  assert.ok(!files.some(f => f.endsWith(join('src', 'lane-host.mjs'))));
});

test('host collectors catch bare and port forms and ignore code chains', () => {
  const corpNet = '.corp-internal' + '.net';
  assert.deepEqual(
    collectUrlHosts('see ' + 'https://' + 'metrics' + corpNet + '/x'),
    ['metrics' + corpNet],
  );
  assert.deepEqual(
    collectBareHosts('lane at ' + 'router' + corpNet + ':8443'),
    ['router' + corpNet],
  );
  assert.deepEqual(collectBareHosts('lane at ' + 'router' + corpNet), ['router' + corpNet]);
  assert.deepEqual(collectBareHosts('payload.modelDecision.model and issue.comments.read'), []);
  assert.deepEqual(collectBareHosts('managed ' + 'Z' + '.ai capacity remains'), ['z.ai']);
  assert.ok(isAllowlistedHost('z.ai'));
  assert.ok(!isAllowlistedHost('metrics' + corpNet));
});

test('the public census hostname exception is exact and does not alter the lane allowlist', () => {
  assert.ok(isAllowlistedHost('api.github.com'));
  for (const other of ['prefix.' + 'api.github.com', 'api.github.com' + '.evil' + '.net', 'uploads.' + 'github' + '.com']) {
    assert.equal(isAllowlistedHost(other), false);
  }
  for (const baseUrl of LANE_BASE_URL_ALLOWLIST) {
    assert.notEqual(new URL(baseUrl).hostname, 'api.github.com');
  }
});

test('example config validates against any pin: it does not set baseUrl', () => {
  const example = JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf8'));
  assert.equal(example.cliproxy.baseUrl, undefined);
  assert.deepEqual(validateConfigShape(example), []);
  assert.equal(resolveConfig(example).cliproxy.baseUrl, LANE_BASE_URLS[0]);
});
