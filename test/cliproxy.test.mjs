import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuthFilesRequest,
  buildApiCallRequest,
  assertAllowedRequest,
  parseAuthFile,
  isStale,
  parseAnthropicUsageBody,
  parseCodexWhamBody,
  CliproxyCache,
  ANTHROPIC_USAGE_URL,
  CODEX_USAGE_URL,
} from '../src/cliproxy.mjs';

// --- HARD RULE: the allowlist ---

test('allowlist permits exactly GET auth-files and POST api-call with usage URLs', () => {
  assert.doesNotThrow(() => buildAuthFilesRequest('http://cliproxy:8317'));
  assert.doesNotThrow(() => buildApiCallRequest('http://cliproxy:8317', { authIndex: 3, provider: 'claude' }));
  assert.doesNotThrow(() => buildApiCallRequest('http://cliproxy:8317', { authIndex: 1, provider: 'codex' }));
});

for (const [name, req] of [
  ['quota reset endpoint', { method: 'POST', url: 'http://cliproxy:8317/v0/management/quota/reset', body: {} }],
  ['reset-quota path', { method: 'POST', url: 'http://cliproxy:8317/reset-quota', body: {} }],
  ['reset nested under api-call path', { method: 'POST', url: 'http://cliproxy:8317/v0/management/api-call/reset', body: {} }],
  ['api-call with non-usage URL', { method: 'POST', url: 'http://cliproxy:8317/v0/management/api-call', body: { auth_index: 1, method: 'GET', url: 'https://api.anthropic.com/v1/messages', header: {} } }],
  ['api-call with POST method override', { method: 'POST', url: 'http://cliproxy:8317/v0/management/api-call', body: { auth_index: 1, method: 'POST', url: ANTHROPIC_USAGE_URL, header: {} } }],
  ['auth-files with body', { method: 'GET', url: 'http://cliproxy:8317/v0/management/auth-files', body: {} }],
  ['config write endpoint', { method: 'POST', url: 'http://cliproxy:8317/v0/management/config', body: {} }],
]) {
  test(`allowlist blocks: ${name}`, () => {
    assert.throws(() => assertAllowedRequest(req), /cliproxy-request-blocked/);
  });
}

test('live pull is unsupported for providers without a usage URL', () => {
  assert.throws(() => buildApiCallRequest('http://cliproxy:8317', { authIndex: 1, provider: 'meta' }), /live-pull-unsupported/);
  assert.equal(ANTHROPIC_USAGE_URL, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(CODEX_USAGE_URL, 'https://chatgpt.com/backend-api/wham/usage');
});

// --- passive auth-file parsing (mirrors the host collector) ---

const NOW = Date.parse('2026-10-08T23:00:00Z');

test('claude passive headers parse (0-1 and 0-100 forms)', () => {
  const auth = {
    provider: 'claude', auth_index: 1,
    quota: {
      observed_at: '2026-10-08T22:58:00Z',
      signals: {
        'Anthropic-Ratelimit-Unified-5h-Utilization': 0.34,
        'Anthropic-Ratelimit-Unified-5h-Reset': 1780000000,
        'Anthropic-Ratelimit-Unified-7d-Utilization': 55,
        'Anthropic-Ratelimit-Unified-7d-Reset': 1780600000,
      },
    },
  };
  const a = parseAuthFile(auth, NOW);
  assert.equal(a.enabled, true);
  assert.equal(a.health, 'healthy');
  assert.ok(Math.abs(a.fiveHour.utilization - 0.34) < 1e-9);
  assert.ok(Math.abs(a.weekly.utilization - 0.55) < 1e-9);
  assert.equal(isStale(a, 300, NOW), false);
  assert.equal(isStale(a, 60, NOW), true);
});

test('disabled accounts are excluded; unavailable degrades', () => {
  assert.equal(parseAuthFile({ provider: 'claude', auth_index: 1, disabled: true }, NOW).enabled, false);
  assert.equal(parseAuthFile({ provider: 'claude', auth_index: 1, status: 'disabled' }, NOW).enabled, false);
  assert.equal(parseAuthFile({ provider: 'codex', auth_index: 2, unavailable: true }, NOW).health, 'degraded');
});

test('codex passive headers map windows by duration', () => {
  const auth = {
    provider: 'codex', auth_index: 2,
    quota: {
      observed_at: '2026-10-08T22:59:00Z',
      signals: {
        'X-Codex-Plan-Type': 'Plus',
        'X-Codex-Primary-Window-Minutes': 300,
        'X-Codex-Primary-Used-Percent': 80,
        'X-Codex-Primary-Reset-At': 1780001000,
        'X-Codex-Secondary-Window-Minutes': 10080,
        'X-Codex-Secondary-Used-Percent': 20,
        'X-Codex-Secondary-Reset-At': 1780600000,
      },
    },
  };
  const a = parseAuthFile(auth, NOW);
  assert.ok(Math.abs(a.fiveHour.utilization - 0.8) < 1e-9);
  assert.ok(Math.abs(a.weekly.utilization - 0.2) < 1e-9);
  assert.equal(a.plan, 'Plus');
});

test('missing signals mean stale (live pull needed)', () => {
  const a = parseAuthFile({ provider: 'claude', auth_index: 1, quota: { signals: {}, observed_at: '2026-10-08T22:59:00Z' } }, NOW);
  assert.equal(a.signalsAtMs, null);
  assert.equal(isStale(a, 300, NOW), true);
});

// --- live body parsers ---

test('anthropic usage body parses five_hour and seven_day', () => {
  const out = parseAnthropicUsageBody({
    five_hour: { utilization: 34, resets_at: 1780000000 },
    seven_day: { utilization: 55, resets_at: 1780600000 },
  });
  assert.ok(Math.abs(out.fiveHour.utilization - 0.34) < 1e-9);
  assert.ok(Math.abs(out.weekly.utilization - 0.55) < 1e-9);
  assert.equal(parseAnthropicUsageBody({}), null);
});

test('codex wham body maps windows and surfaces exhaustion', () => {
  const out = parseCodexWhamBody({
    plan_type: 'Plus',
    rate_limit: {
      limit_reached: false,
      primary_window: { used_percent: 80, reset_at: 1780001000, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 20, reset_at: 1780600000, limit_window_seconds: 604800 },
    },
  });
  assert.equal(out.exhausted, false);
  assert.ok(Math.abs(out.fiveHour.utilization - 0.8) < 1e-9);
  assert.ok(Math.abs(out.weekly.utilization - 0.2) < 1e-9);
});

test('cache honors TTL', () => {
  const c = new CliproxyCache(45000);
  c.set('k', { v: 1 }, NOW);
  assert.deepEqual(c.get('k', NOW + 44000), { v: 1 });
  assert.equal(c.get('k', NOW + 46000), null);
});
