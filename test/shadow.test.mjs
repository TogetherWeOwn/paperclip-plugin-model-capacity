import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowRing, SHADOW_CAPACITY, validRecord } from '../src/shadow.mjs';
import { validateConfigShape, resolveConfig } from '../src/plugin.mjs';

const record = (runId) => ({
  runId, agentId: 'agent-1', actualModel: 'claude-haiku-5-5(max)', wouldModel: 'gpt-6.1-sol(high)',
  account: 'codex:1', accountId: 'codex:1', rung: 1, reason: 'behind schedule: climb one rung', at: 1700000000000,
});

test('ring buffer caps at ~2000, newest wins', () => {
  assert.equal(SHADOW_CAPACITY, 2000);
  const ring = createShadowRing(3);
  for (const id of ['a', 'b', 'c', 'd']) ring.push(record(id));
  assert.equal(ring.size(), 3);
  assert.deepEqual(ring.list(10).map(r => r.runId), ['d', 'c', 'b']);
});

test('invalid records are refused, never stored', () => {
  const ring = createShadowRing();
  assert.equal(validRecord({ runId: 'x' }), false);
  assert.throws(() => ring.push({ runId: 'x' }), /invalid-shadow-record/);
  assert.equal(ring.size(), 0);
});

test('config validation rejects bad secret refs and weights', () => {
  assert.deepEqual(validateConfigShape({}), []);
  assert.ok(validateConfigShape({ cliproxy: { managementKeySecretRef: 'pasted-key' } }).length > 0);
  assert.deepEqual(validateConfigShape({
    cliproxy: { managementKeySecretRef: { type: 'secret_ref', secretId: 'cd121e86-3899-4720-9a04-a89b73e9e1' } },
  }), []);
  assert.ok(validateConfigShape({ pacing: { guardHighPct: 0.4, guardRejoinPct: 0.5 } }).length > 0);
  assert.ok(validateConfigShape({ weights: { terminalBench: -1 } }).length > 0);
});

test('config resolution applies documented defaults', () => {
  const c = resolveConfig({});
  assert.equal(c.cliproxy.baseUrl, 'http://cliproxy:8317');
  assert.equal(c.cliproxy.staleAfterSec, 300);
  assert.equal(c.concurrency.maxTotal, 75);
  assert.equal(c.contextCaps.solLunaMaxTokens, 260000);
  assert.equal(c.armMap.length > 0, true);
});
