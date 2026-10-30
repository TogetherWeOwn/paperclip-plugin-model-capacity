import test from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../src/pool-quality.mjs';
import { normalizeRegistry } from '../src/registry.mjs';
import { syntheticRouterRequest } from '../src/quota-refresh.mjs';
import { buildQuotaSnapshot, freezeSnapshot } from '../src/snapshot.mjs';
import { verifiedConfig } from './support/verified-pools.mjs';
import { NOW, quotaFeed } from './support/quota.mjs';

function fixture() {
  const config = verifiedConfig();
  config.router.enabled = true;
  config.roles = {minQuality:{doer:.5, thinker:.7, other:.5}, outcomeGate:{enabled:false}};
  const registry = normalizeRegistry(config.router);
  const params = syntheticRouterRequest(registry, 'builder', NOW);
  const snapshot = buildQuotaSnapshot({registry, feed:quotaFeed(), nowMs:NOW, config}).snapshot;
  const evidence = {atMs:NOW, arms:[
    {armId:'terra-low', model:'terra', effort:'low', family:'terra', qFleet:.1},
    {armId:'terra-high', model:'terra', effort:'high', family:'terra', qFleet:.9},
    {armId:'claude-high', model:'claude', effort:'high', family:'claude', qFleet:.8},
  ], records:[], roleOf:()=> 'doer', familyOf:r=>r.family};
  return {config, params, snapshot, evidence};
}
const skips = f => {
  assert.equal(typeof policy.computeRuntimePolicySkips, 'function', 'runtime-effort policy adapter is missing');
  return policy.computeRuntimePolicySkips(f.params, f.snapshot, f.config, f.evidence);
};

test('selection checks the effective effort, not the generation-time existential model verdict', () => {
  const f = fixture(), [a,b] = f.params.memberOrder;
  f.params.candidates[0].runtimeConfig.modelReasoningEffort = 'low';
  f.params.candidates[1].runtimeConfig.modelReasoningEffort = 'high';
  assert.deepEqual(skips(f), {[a]:'quality-floor'});
  f.params.candidates[0].runtimeConfig.modelReasoningEffort = 'high';
  assert.deepEqual(skips(f), {});
  f.params.candidates[0].runtimeConfig.modelReasoningEffort = 'invented';
  assert.equal(skips(f)[a], 'quality-floor');
  assert.equal(skips(f)[b], undefined);
});

test('an unspecified runner default qualifies only if every known effort meets the floor', () => {
  const f = fixture(), [a,b] = f.params.memberOrder;
  assert.deepEqual(skips(f), {[a]:'quality-floor'});
  f.evidence.arms[0].qFleet = .5;
  assert.deepEqual(skips(f), {});
  f.evidence.arms[2].qFleet = null;
  assert.equal(skips(f)[b], 'quality-floor');
});

test('effective runtime model drift and absent, stale or unknown policy evidence fail closed', () => {
  for (const mutate of [
    f=>{f.evidence=null;},
    f=>{f.evidence.atMs=NOW-180001;},
    f=>{f.evidence.arms=[];},
    f=>{f.evidence.arms=f.evidence.arms.map(a=>({...a, family:'unknown'}));},
  ]) {
    const f = fixture(); mutate(f);
    assert.deepEqual(Object.values(skips(f)), ['quality-floor','quality-floor']);
  }
  const f=fixture(), id=f.params.memberOrder[0];
  f.params.candidates[0].runtimeConfig.model='other/terra';
  assert.equal(skips(f)[id], 'unmapped-member');
});

test('current role floors and exclusions apply without mutating frozen inputs or suspending an empty role floor', () => {
  const f=fixture(), [a,b]=f.params.memberOrder;
  f.config.roles.minQuality.doer=2;
  assert.deepEqual(skips(f), {[a]:'quality-floor',[b]:'quality-floor'});
  f.config.roles.minQuality.doer=null;
  f.config.roles.excludeFamilies={doer:['terra']};
  freezeSnapshot(f);
  assert.deepEqual(skips(f), {[a]:'role-excluded'});
});

test('outcome-gated effective families are skipped and reviewers use the configured other-role floor', () => {
  const f=fixture(), [a,b]=f.params.memberOrder;
  f.config.roles.minQuality.doer=0;
  f.config.roles.outcomeGate={enabled:true,minRuns:2,minProgressRate:.5,relativeToBest:.75};
  f.evidence.records=['terra','claude'].flatMap(family=>[0,1].map(i=>({runId:family+i,agentId:'agent',status:'finished',terminalAt:NOW-1,progress:family==='terra'?'noChange':'progressed',family})));
  assert.deepEqual(skips(f), {[a]:'outcome-gated'});
  f.config.router.pools[0].role='reviewer';
  f.config.roles.minQuality.other=.85;
  assert.deepEqual(skips(f), {[a]:'quality-floor',[b]:'quality-floor'});
});
