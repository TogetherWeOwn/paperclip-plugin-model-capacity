import test from 'node:test';
import assert from 'node:assert/strict';
import * as routing from '../src/router.mjs';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { normalizeRegistry } from '../src/registry.mjs';
import { syntheticRouterRequest } from '../src/quota-refresh.mjs';
import { buildQuotaSnapshot, freezeSnapshot } from '../src/snapshot.mjs';
import { verifiedConfig } from './support/verified-pools.mjs';
import { NOW, quotaFeed, stateHarness } from './support/quota.mjs';
import { companyId } from './support/native-api.mjs';

function fixture() {
  const config=verifiedConfig();config.router.enabled=true;
  config.roles={minQuality:{doer:0,thinker:0,other:0},outcomeGate:{enabled:false}};
  const registry=normalizeRegistry(config.router), entry=config.router.pools[0];
  const params=syntheticRouterRequest(registry,'builder',NOW);
  params.pool.id=entry.poolId;params.pool.revision=entry.expectedRevision;
  for(const {member} of params.candidates) {
    const {connectionId,grantId}=entry.members.find(m=>m.memberId===member.id);
    Object.assign(member.binding,{connectionId,grantId});
  }
  const snapshot=buildQuotaSnapshot({registry,feed:quotaFeed(),nowMs:NOW,config}).snapshot;
  const evidence={atMs:NOW,arms:[{armId:'terra-high',model:'terra',effort:'high',family:'terra',qFleet:.8},{armId:'claude-high',model:'claude',effort:'high',family:'claude',qFleet:.7}],records:[]};
  const h=stateHarness();let delta={},reads=0;
  assert.equal(typeof routing.createRouterAdapter,'function','native callback adapter is missing');
  const callback=routing.createRouterAdapter({getConfig:id=>{assert.equal(id,companyId);reads++;return config;},getSnapshot:()=>snapshot,getPolicy:()=>evidence,getOverlay:()=>delta,logger:h.logger});
  return {config,params,snapshot,evidence,callback,logs:h.logs,reads:()=>reads,setDelta:d=>{delta=d;}};
}

test('adapter selects synchronously from memory, logs R8 facts, and never reserves a retry or mutates inputs', () => {
  const f=fixture();freezeSnapshot(f.params);freezeSnapshot(f.snapshot);freezeSnapshot(f.config);freezeSnapshot(f.evidence);
  const first=f.callback(f.params),second=f.callback(f.params);
  assert.equal(first instanceof Promise,false);assert.deepEqual(second,first);assert.equal(first.kind,'selected');
  assert.equal(f.reads(),2,'config is acquired at call time, not retained from a tick');
  const info=f.logs.filter(l=>l.level==='info');assert.equal(info.length,2);
  assert.equal(info[0].details.kind,'selected');assert.equal(info[0].details.chosenMemberId,first.memberId);
  assert.equal(info[0].details.accountKey,'one');assert.equal(info[0].details.poolKey,'builder');
  assert.equal(info[0].details.snapshotAgeMs,0);assert.equal(info[0].details.candidateCount,2);assert.equal(info[0].details.memberOrderCount,2);
  assert.deepEqual(info[0].details.droppedMemberIds,[]);assert.deepEqual(info[0].details.topSkipReasons,[]);
  for(const field of ['poolMemberCount','model','runtimeConfig','binding'])assert.equal(info[0].details[field],undefined);
});

test('runtime floor skips, including a pin, reach the real decision and sanitized diagnostics', () => {
  const f=fixture(),[a,b]=f.params.memberOrder;
  f.evidence.arms[0].qFleet=-1;
  assert.equal(f.callback(f.params).memberId,b);
  assert.deepEqual(f.logs.find(l=>l.level==='info').details.topSkipReasons,[{reason:'quality-floor',count:1}]);
  f.params.pinnedMemberId=a;f.params.candidates=f.params.candidates.slice(0,1);f.params.pool.members=f.params.candidates.map(c=>c.member);
  const answer=f.callback(f.params);assert.equal(answer.kind,'exhausted');assert.equal(answer.skipped[a],'quality-floor');
  assert.equal(f.logs.at(-1).details.droppedSuppressed,'pinned');
});

test('adapter uses live attestations and read-only event deltas, not RPC overlay or config snapshots', () => {
  const f=fixture();
  assert.equal(f.callback(f.params).accountKey,undefined);
  f.setDelta({one:1});
  f.params.overlayDelta={two:99};
  assert.equal(f.callback(f.params).memberId,f.params.memberOrder[1]);
  f.config.router.pools=[];
  assert.equal(f.callback(f.params).kind,'unavailable');
  assert.equal(f.logs.at(-1).level,'error');assert.equal(f.logs.at(-1).details.tripwire,'unverified-pool');
});

test('zero survivors report configuration failure even when disabled; dropped and ambiguous subsets use R9 levels', () => {
  const f=fixture();f.config.router.enabled=false;f.params.candidates=[];f.params.pool.members=[];
  assert.deepEqual(f.callback(f.params),{kind:'unavailable',skipped:{}});assert.equal(f.logs.at(-1).level,'error');
  assert.deepEqual(f.logs.at(-1).details.droppedMemberIds,f.params.memberOrder);
  const g=fixture();g.params.candidates=g.params.candidates.slice(1);g.params.pool.members=g.params.candidates.map(c=>c.member);
  g.callback(g.params);assert.equal(g.logs.at(-1).level,'info');assert.equal(g.logs.at(-1).details.droppedSuppressed,'ambiguous-single-candidate');
});

test('plugin registers both native callback variants but exports the old resolver only in transitional', async () => {
  for(const variant of ['transitional','clean']) {
    const plugin=createModelCapacityPlugin({variant,requirePinnedLaneHost:false,clock:()=>NOW});
    const h=stateHarness(),jobs=new Map();
    await plugin.setup({state:h.state,logger:h.logger,jobs:{register:(k,fn)=>jobs.set(k,fn)},events:{on(){}}});
    assert.equal(typeof plugin.onRouteAiConnection,'function');
    assert.equal(typeof plugin.onResolveRunModel,variant==='transitional'?'function':'undefined');
    if(variant==='transitional')assert.deepEqual(await plugin.onResolveRunModel({companyId:'unknown',adapterType:'codex_local'}),{kind:'keep'});
    const config=verifiedConfig(),registry=normalizeRegistry(config.router),params=syntheticRouterRequest(registry,'builder',NOW);
    assert.equal(plugin.onRouteAiConnection(params).kind,'unavailable','unknown companies have no operator-attested pool authority');
  }
});
