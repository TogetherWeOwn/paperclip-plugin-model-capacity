import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotAccountView, applyInFlightOverlay } from '../src/views.mjs';

const now = Date.parse('2026-10-29T12:00:00Z');
const account = { weeklyUsed: 0.4, weeklyResetsAtMs: now + 36e5 * 60, weeklyPeriodStartMs: now - 36e5 * 108, quality: 'live', observedAtMs: now, credentialReady: true, measuredRatePerHour: 0.002, targetShare: 3, inFlightBase: 1, meanRunWeeklyPct: 0.01, placementQ: 0.8, roleEligible: true, taskFeasible: true };

test('snapshot view maps placement, rates, headroom and schedule without mutating account', () => {
  Object.freeze(account);
  const v = snapshotAccountView('a', account, { nowMs: now });
  assert.equal(v.accountId, 'a');
  assert.equal(v.health, 'healthy');
  assert.ok(Math.abs(v.headroomPct - 0.59) < 1e-12);
  assert.ok(Math.abs(v.requiredRatePerHour - 0.59 / 60) < 1e-12);
  assert.equal(v.measuredRatePerHour, 0.002);
  assert.equal(v.targetShare, 3);
  assert.equal(v.inFlight, 1);
  assert.equal(v.resetAtMs, account.weeklyResetsAtMs);
  assert.equal(v.placementQ, 0.8);
  assert.equal(v.roleEligible, true);
  assert.ok(v.planAhead < 0);
});

test('overlay counts delta once, recomputes projection and never mutates the snapshot view', () => {
  const base = snapshotAccountView('a', account, { nowMs: now });
  Object.freeze(base);
  const withStart = applyInFlightOverlay(base, 1);
  assert.equal(withStart.inFlight, 2);
  assert.ok(withStart.headroomPct < base.headroomPct);
  assert.ok(withStart.requiredRatePerHour < base.requiredRatePerHour);
  assert.equal(applyInFlightOverlay(base, -99).inFlight, 0);
  const nextTick = snapshotAccountView('a', {...account, inFlightBase: 1}, {nowMs: now + 60000});
  assert.equal(applyInFlightOverlay(nextTick, 0).inFlight, 1);
});

test('stale or credential-unready accounts use existing unhealthy vocabulary', () => {
  assert.notEqual(snapshotAccountView('a', {...account, quality: 'unknown'}, {nowMs: now}).health, 'healthy');
  assert.notEqual(snapshotAccountView('a', {...account, credentialReady: false}, {nowMs: now}).health, 'healthy');
});

test('run-id overlay is deduplicated and resets exactly at snapshot boundaries', async () => {
  const { createOverlay, overlayStart, overlayFinish, overlayCount, resetOverlay } = await import('../src/overlay.mjs');
  let s = createOverlay();
  s = overlayStart(s, 'a', 'r2'); s = overlayStart(s, 'a', 'r2');
  assert.equal(overlayCount(s, 'a', 1), 2);
  s = overlayFinish(s, 'a', 'r1'); assert.equal(overlayCount(s, 'a', 1), 1);
  s = resetOverlay(); assert.equal(overlayCount(s, 'a', 1), 1);
  s = overlayFinish(s, 'a', 'r2'); s = overlayFinish(s, 'a', 'r2');
  assert.equal(overlayCount(s, 'a', 1), 0);
  s = overlayFinish(s, 'a', 'unknown'); assert.equal(overlayCount(s, 'a', 1), 0);
});

test('view carries selector cost, provider, fallback, and lane fields unchanged', () => {
  const a={...account, freeCost:true, provider:'example', models:['example/model'], fallbackOnly:false, creditFallback:true, meter:'metered', guardActive:true, laneInFlight:2};
  const v=snapshotAccountView('a',a,{nowMs:now});
  for (const field of ['freeCost','provider','models','fallbackOnly','creditFallback','meter','guardActive','laneInFlight']) assert.deepEqual(v[field],a[field],field);
});
