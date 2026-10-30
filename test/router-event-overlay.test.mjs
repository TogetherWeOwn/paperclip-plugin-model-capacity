import test from 'node:test';
import assert from 'node:assert/strict';
import * as overlays from '../src/overlay.mjs';

function runtime() {
  assert.equal(typeof overlays.createRunOverlay, 'function', 'event overlay runtime is missing');
  return overlays.createRunOverlay();
}
const observe=(r,runId,status,accountKey='a')=>r.observe('company',{runId,status,accountKey});

test('observed run IDs add starts and subtract pre-tick finishes exactly once across publication boundaries', () => {
  const r=runtime();
  observe(r,'old','running');
  const checkpoint=r.capture('company');
  r.publish('company',1,checkpoint);
  assert.deepEqual(r.deltas('company',1),{});
  observe(r,'new','running');observe(r,'new','running');
  assert.deepEqual(r.deltas('company',1),{a:1});
  observe(r,'old','finished');observe(r,'old','failed');
  assert.deepEqual(r.deltas('company',1),{a:0});
  r.publish('company',2,r.capture('company'));
  observe(r,'old','cancelled');
  assert.deepEqual(r.deltas('company',2),{},'a terminal duplicate from the previous tick cannot consume a different base run');
  observe(r,'new','finished',null);
  assert.deepEqual(r.deltas('company',2),{a:-1},'a terminal event without model reuses observed start attribution');
  observe(r,'new','running');
  assert.deepEqual(r.deltas('company',2),{a:-1},'late starts cannot revive terminal runs');
});

test('events arriving while a snapshot is persisted survive the atomic base replacement', () => {
  const r=runtime();
  observe(r,'before','running');
  const checkpoint=r.capture('company');
  observe(r,'during','running');observe(r,'before','finished');
  r.publish('company',1,checkpoint);
  assert.deepEqual(r.deltas('company',1),{a:0});
  observe(r,'during','finished');
  assert.deepEqual(r.deltas('company',1),{a:-1});
  assert.deepEqual(r.deltas('other',1),{});
  assert.deepEqual(r.deltas('company',999),{},'an overlay is never applied against a different snapshot base');
});

test('account-less upstream lifecycle events are reported as unattributed, never guessed or reserved by a callback', () => {
  const r=runtime();
  observe(r,'unattributed','running',null);
  assert.equal(r.status('company').unattributedInFlight,1);
  assert.deepEqual(r.deltas('company',0),{});
  observe(r,'unattributed','finished',null);
  assert.equal(r.status('company').unattributedInFlight,0);
  assert.deepEqual(r.deltas('company',0),{});
});
