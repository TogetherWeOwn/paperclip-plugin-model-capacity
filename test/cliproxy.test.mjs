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
  isReactiveAccount,
  resetAtMsOf,
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

test('reset timestamps accept ISO, epoch ms, and epoch s', () => {
  assert.equal(resetAtMsOf('2026-10-09T19:00:00Z'), Date.parse('2026-10-09T19:00:00Z'));
  assert.equal(resetAtMsOf(1760046000000), 1760046000000);
  assert.equal(resetAtMsOf(1760046000), 1760046000000);
  assert.equal(resetAtMsOf(123), null);
  assert.equal(resetAtMsOf('not-a-date'), null);
  assert.equal(resetAtMsOf(null), null);
  assert.equal(resetAtMsOf(undefined), null);
});

test('numeric resets survive parsing instead of being dropped', () => {
  const a = parseLaneAccount({
    lane: 'claude-1', provider: 'claude', accountKey: 'a1',
    weekly: { used: 0.66, resetsAt: 1760046000000 },
    fiveHour: { used: 0.1, resetsAt: '2026-10-09T03:59:00Z' },
  }, NOW);
  assert.equal(a.weekly.utilization, 0.66);
  assert.equal(a.weekly.resetsAt, 1760046000000);
  assert.equal(a.weekly.resetsAtMs, 1760046000000);
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

test('lane accounts carry models, meter, and pool; reactive detection', () => {
  const a = parseLaneAccount({
    lane: 'k', provider: 'kimi', accountKey: 'k1', health: 'healthy',
    meter: 'reactive', pool: null, models: ['kimi-k3-256k'],
    weekly: { used: null, resetsAt: null }, fiveHour: { used: null, resetsAt: null },
    observedAt: '2026-10-08T22:59:00Z', quality: 'reactive',
  });
  assert.deepEqual(a.models, ['kimi-k3-256k']);
  assert.equal(a.meter, 'reactive');
  assert.equal(isReactiveAccount(a), true);
  // Quality-reactive counts too; feeds that predate the meter field (null)
  // count as metered; metered accounts never count.
  assert.equal(isReactiveAccount({ meter: null, quality: 'reactive' }), true);
  assert.equal(isReactiveAccount({ meter: null, quality: 'live' }), false);
  assert.equal(isReactiveAccount({ meter: 'metered', quality: 'live' }), false);
  assert.equal(isReactiveAccount(null), false);
  // Feeds that predate `models` carry null (classic provider binding applies).
  const legacy = parseLaneAccount({
    lane: 'c', provider: 'codex', accountKey: 'k9', health: 'healthy',
    weekly: { used: 0.3, resetsAt: null }, fiveHour: { used: 0.1, resetsAt: null },
    observedAt: '2026-10-08T22:59:00Z', quality: 'live',
  });
  assert.equal(legacy.models, null);
  assert.equal(legacy.meter, null);
});
