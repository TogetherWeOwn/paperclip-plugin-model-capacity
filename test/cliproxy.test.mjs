import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BASE_URL,
  DEFAULT_ACCOUNTS_PATH,
  LANE_KEY_HEADER,
  buildLaneRequest,
  assertLaneRequest,
  usedRatio,
  parseLaneAccount,
  parseLaneBody,
  CliproxyCache,
} from '../src/cliproxy.mjs';

const LANE = { baseUrl: DEFAULT_BASE_URL, accountsPath: DEFAULT_ACCOUNTS_PATH };
const LANE_URL = `${DEFAULT_BASE_URL}${DEFAULT_ACCOUNTS_PATH}`;

// --- HARD RULE: exactly one outbound read ---

test('lane request is the single GET with defaults', () => {
  assert.equal(DEFAULT_BASE_URL, 'https://router.infextion.net');
  assert.equal(DEFAULT_ACCOUNTS_PATH, '/telemetry/cliproxy/live/accounts.json');
  assert.equal(LANE_KEY_HEADER, 'X-Api-Key');
  assert.deepEqual(buildLaneRequest(), { method: 'GET', url: LANE_URL });
  assert.doesNotThrow(() => assertLaneRequest({ method: 'GET', url: LANE_URL, body: null }, LANE));
  assert.doesNotThrow(() => assertLaneRequest({ method: 'GET', url: LANE_URL, body: undefined }, LANE));
});

for (const [name, req] of [
  ['old direct base URL', { method: 'GET', url: 'http://cliproxy:8317/v0/management/auth-files', body: null }],
  ['old api-call path', { method: 'POST', url: 'http://cliproxy:8317/v0/management/api-call', body: {} }],
  ['lane URL with POST', { method: 'POST', url: LANE_URL, body: null }],
  ['lane URL with body', { method: 'GET', url: LANE_URL, body: {} }],
  ['lane URL with query suffix', { method: 'GET', url: `${LANE_URL}?debug=1`, body: null }],
  ['different path on same host', { method: 'GET', url: `${DEFAULT_BASE_URL}/telemetry/other.json`, body: null }],
  ['http downgrade', { method: 'GET', url: LANE_URL.replace('https://', 'http://'), body: null }],
]) {
  test(`allowlist blocks: ${name}`, () => {
    assert.throws(() => assertLaneRequest(req, LANE), /cliproxy-request-blocked/);
  });
}

test('non-https lane bases fail closed', () => {
  assert.throws(() => buildLaneRequest('http://cliproxy:8317', DEFAULT_ACCOUNTS_PATH), /cliproxy-request-blocked/);
});

// --- ratio + body parsing ---

test('usedRatio keeps 0..1, drops the rest', () => {
  assert.equal(usedRatio(0.34), 0.34);
  assert.equal(usedRatio(0), 0);
  assert.equal(usedRatio(1), 1);
  assert.equal(usedRatio(null), null);
  assert.equal(usedRatio(undefined), null);
  assert.equal(usedRatio(55), null);
  assert.equal(usedRatio(-0.1), null);
  assert.equal(usedRatio('x'), null);
});

const NOW = Date.parse('2026-10-08T23:00:00Z');

const body = {
  observedAt: '2026-10-08T22:59:00Z',
  accounts: [
    {
      lane: 'codex-1', provider: 'codex', accountKey: 'a1', health: 'healthy',
      weekly: { used: 0.2, resetsAt: '2026-10-15T22:59:00Z' },
      fiveHour: { used: 0.8, resetsAt: '2026-10-09T03:59:00Z' },
      observedAt: '2026-10-08T22:59:00Z', quality: 'live',
    },
    {
      lane: 'claude-2', provider: 'claude', accountKey: 'b2', health: 'degraded',
      weekly: { used: null, resetsAt: null },
      fiveHour: { used: null, resetsAt: null },
      observedAt: '2026-10-08T22:40:00Z', quality: 'cached',
    },
    {
      lane: 'odd', provider: 'meta', accountKey: 'c3', health: 'unknown',
      weekly: { used: 55, resetsAt: 123 },
      observedAt: 'not-a-date', quality: 'unknown',
    },
  ],
};

test('lane body parses to account snapshots; gaps stay null', () => {
  const parsed = parseLaneBody(body, NOW);
  assert.equal(parsed.source, 'cliproxy-lane');
  assert.equal(parsed.accounts.length, 3);
  const [live, cached, odd] = parsed.accounts;
  assert.equal(live.accountId, 'codex:a1');
  assert.equal(live.fiveHour.utilization, 0.8);
  assert.equal(live.weekly.utilization, 0.2);
  assert.equal(live.weekly.resetsAtMs, Date.parse('2026-10-15T22:59:00Z'));
  assert.equal(live.quality, 'live');
  assert.equal(cached.weekly.utilization, null);
  assert.equal(cached.fiveHour.utilization, null);
  assert.equal(odd.weekly.utilization, null);
  assert.equal(odd.weekly.resetsAt, null);
  assert.equal(odd.signalsAtMs, NOW);
});

test('lane body with no accounts array is rejected', () => {
  assert.equal(parseLaneBody({}, NOW), null);
  assert.equal(parseLaneBody({ accounts: 'x' }, NOW), null);
});

test('single account parse keeps identity fields', () => {
  const a = parseLaneAccount(body.accounts[0], NOW);
  assert.equal(a.lane, 'codex-1');
  assert.equal(a.provider, 'codex');
  assert.equal(a.health, 'healthy');
});

test('cache honors TTL', () => {
  const c = new CliproxyCache(45000);
  c.set('k', { v: 1 }, NOW);
  assert.deepEqual(c.get('k', NOW + 44000), { v: 1 });
  assert.equal(c.get('k', NOW + 46000), null);
});
