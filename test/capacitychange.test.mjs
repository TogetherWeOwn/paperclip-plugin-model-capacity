import test from 'node:test';
import assert from 'node:assert/strict';
import { diffCapacityFeed, WARMUP_MIN_SPAN_MS, isWarmupSpan, predictGuard } from '../src/capacitychange.mjs';

// capacity-change events own the upward fast path. New accounts,
// resets/free resets and cooldown ends must bypass the rung cooldown; downward
// transitions debounce as today (no bypass).

test('new account ids are upward transitions that bypass cooldown', () => {
  const prev = [{ accountId: 'claude:a1' }];
  const curr = [{ accountId: 'claude:a1' }, { accountId: 'claude:n1' }];
  const d = diffCapacityFeed(prev, curr, { nowMs: 1000 });
  assert.deepEqual(d.added, ['claude:n1']);
  assert.ok(d.upwardIds.has('claude:n1'));
  assert.equal(d.shouldBypassCooldown('claude:n1'), true);
  assert.equal(d.shouldBypassCooldown('claude:a1'), false);
});

test('weekly reset (used drop with forward reset) is upward', () => {
  const prev = [{ accountId: 'meta:m1', weeklyUsed: 0.9, resetAtMs: 1000 }];
  const curr = [{ accountId: 'meta:m1', weeklyUsed: 0.05, resetAtMs: 1000 + 7 * 24 * 3600 * 1000 }];
  const d = diffCapacityFeed(prev, curr, { nowMs: 2000 });
  assert.ok(d.upwardIds.has('meta:m1'));
  assert.equal(d.shouldBypassCooldown('meta:m1'), true);
});

test('guard end (guardActive true->false) is upward; guard start is not', () => {
  const ended = diffCapacityFeed(
    [{ accountId: 'claude:a1', guardActive: true }],
    [{ accountId: 'claude:a1', guardActive: false }],
    { nowMs: 1000 },
  );
  assert.ok(ended.upwardIds.has('claude:a1'));
  const started = diffCapacityFeed(
    [{ accountId: 'claude:a1', guardActive: false }],
    [{ accountId: 'claude:a1', guardActive: true }],
    { nowMs: 1000 },
  );
  assert.ok(!started.upwardIds.has('claude:a1'));
  assert.deepEqual([...started.downwardIds], ['claude:a1']);
});

test('removed and newly unhealthy accounts are downward only', () => {
  const d = diffCapacityFeed(
    [{ accountId: 'a', health: 'healthy' }, { accountId: 'b', health: 'healthy' }],
    [{ accountId: 'a', health: 'unavailable' }],
    { nowMs: 1000 },
  );
  assert.deepEqual(d.removed, ['b']);
  assert.ok(d.downwardIds.has('a'));
  assert.ok(d.downwardIds.has('b'));
  assert.equal(d.upwardIds.size, 0);
});

test('unknown health never counts as recovery or loss', () => {
  const rec = diffCapacityFeed(
    [{ accountId: 'a', health: null }],
    [{ accountId: 'a', health: 'healthy' }],
    { nowMs: 1000 },
  );
  assert.ok(!rec.upwardIds.has('a'));
  const loss = diffCapacityFeed(
    [{ accountId: 'a', health: 'healthy' }],
    [{ accountId: 'a', health: null }],
    { nowMs: 1000 },
  );
  assert.ok(!loss.downwardIds.has('a'));
  const real = diffCapacityFeed(
    [{ accountId: 'a', health: 'unavailable' }],
    [{ accountId: 'a', health: 'healthy' }],
    { nowMs: 1000 },
  );
  assert.ok(real.upwardIds.has('a'));
});

test('meter restatement without a reset is not a reset; epsilon drops are not resets', () => {
  const restated = diffCapacityFeed(
    [{ accountId: 'm', weeklyUsed: 0.9, resetAtMs: 1000 }],
    [{ accountId: 'm', weeklyUsed: 0.5, resetAtMs: 1000 }],
    { nowMs: 2000 },
  );
  assert.ok(!restated.upwardIds.has('m'));
  const epsilon = diffCapacityFeed(
    [{ accountId: 'm', weeklyUsed: 0.9, resetAtMs: 1000 }],
    [{ accountId: 'm', weeklyUsed: 0.899, resetAtMs: 1000 + 2 * 3600 * 1000 }],
    { nowMs: 2000 },
  );
  assert.ok(!epsilon.upwardIds.has('m'));
  const collapse = diffCapacityFeed(
    [{ accountId: 'm', weeklyUsed: 0.9, resetAtMs: 1000 }],
    [{ accountId: 'm', weeklyUsed: 0.05, resetAtMs: 1000 }],
    { nowMs: 2000 },
  );
  assert.ok(collapse.upwardIds.has('m'));
});

test('first tick seeds without waking the fleet', () => {
  const d = diffCapacityFeed(
    [{ accountId: 'a' }],
    [{ accountId: 'a' }, { accountId: 'b' }],
    { nowMs: 1000, firstTick: true },
  );
  assert.deepEqual(d.added, ['b']);
  assert.equal(d.upwardIds.size, 0);
  assert.equal(d.shouldBypassCooldown('b'), false);
  assert.equal(d.changed, false);
});

test('predictGuard mirrors the controller: trip, hold, release, release-on-null', () => {
  const cfg = { guardHigh: 0.8, guardRejoin: 0.5 };
  assert.equal(predictGuard(false, 0.85, cfg), true);
  assert.equal(predictGuard(false, 0.5, cfg), false);
  assert.equal(predictGuard(true, 0.7, cfg), true);
  assert.equal(predictGuard(true, 0.4, cfg), false);
  assert.equal(predictGuard(true, null, cfg), false);
  assert.equal(predictGuard(false, null, cfg), false);
});

test('warmup span: histories under 60 min are not trusted', () => {
  assert.equal(WARMUP_MIN_SPAN_MS, 60 * 60 * 1000);
  assert.equal(isWarmupSpan(5 * 60 * 1000), true);
  assert.equal(isWarmupSpan(59 * 60 * 1000), true);
  assert.equal(isWarmupSpan(60 * 60 * 1000), false);
  assert.equal(isWarmupSpan(90 * 60 * 1000), false);
});
