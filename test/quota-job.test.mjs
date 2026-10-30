import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { manifest, enforceManifest } from '../src/manifest.mjs';
import { NativeApi, options, scratch, companyId } from './support/native-api.mjs';
import { applyPoolSaga } from '../scripts/pool-saga.mjs';
import { config, quotaFeed, stateHarness, NOW, MINUTE } from './support/quota.mjs';
import { DEFAULT_BASE_URL, DEFAULT_ACCOUNTS_PATH } from '../src/cliproxy.mjs';

async function start(t,{router=true,configure=true,withInspector=true,withPools=true}={}) {
  const host=new NativeApi();
  if(withPools)await applyPoolSaga({...options(host),activate:false,journalPath:await scratch(t)});
  host.writes=[];
  const harness=stateHarness(),jobs=new Map(),events=new Map(),requests=[];let now=NOW,body=quotaFeed(),status=200,block=null;
  const cfg=config();if(!router)delete cfg.router;
  const plugin=createModelCapacityPlugin({clock:()=>now,requirePinnedLaneHost:false,
    ...(withInspector?{inspectPools:async()=>({...options(host),expectedEnabled:false})}:{}),
  });
  const context={
    state:harness.state,logger:harness.logger,config:{get:async()=>cfg},secrets:{resolve:async()=> 'TEST_LANE_KEY'},
    http:{fetch:async(url,init)=>{requests.push({url,init});if(block)await block;return {status,json:async()=>body};}},
    jobs:{register:(key,fn)=>jobs.set(key,fn)},events:{on:(key,fn)=>events.set(key,fn)},
    agents:{get:async()=>null,list:async()=>[]},issues:{get:async()=>null,list:async()=>[]},
  };
  await plugin.setup(context);if(configure)await plugin.onConfigChanged(cfg,{companyId});
  return {...harness,plugin,host,cfg,jobs,requests,context,
    tick:()=>jobs.get('quota-refresh')({}),capacity:()=>plugin.onApiRequest({companyId,routeKey:'capacity'}),
    setNow:n=>{now=n;},setBody:v=>{body=v;},setStatus:v=>{status=v;},blockOn:p=>{block=p;},
  };
}

test('one native quota-refresh schedule replaces shadow-tick in both manifests',()=>{
  for(const m of [manifest,enforceManifest]) {
    assert.equal(m.jobs.find(j=>j.jobKey==='quota-refresh')?.schedule,'* * * * *');
    assert.equal(m.jobs.some(j=>j.jobKey==='shadow-tick'),false);
    assert.ok(m.capabilities.includes('jobs.schedule'));
  }
});

test('quota job fetches one pinned GET with a ten-second timeout and publishes snapshot plus shadow to capacity',async t=>{
  const s=await start(t);assert.equal(typeof s.jobs.get('quota-refresh'),'function');await s.tick();
  assert.equal(s.requests.length,1);
  assert.equal(s.requests[0].url,DEFAULT_BASE_URL+DEFAULT_ACCOUNTS_PATH);
  assert.equal(s.requests[0].init.method,'GET');assert.equal(s.requests[0].init.body,undefined);
  assert.ok(s.requests[0].init.signal instanceof AbortSignal);
  const capacity=(await s.capacity()).body;
  assert.equal(capacity.nativeRouter.snapshotAtMs,NOW);
  assert.equal(capacity.nativeRouter.shadow.length,2);
  assert.equal(capacity.nativeRouter.inspection,'ready');
  assert.deepEqual(s.host.writes,[]);
});

test('U27 M1 worker without an inspector or native pools records quota selections, not configuration unavailability',async t=>{
  // Match worker.mjs: no inspectPools injection, and M1 precedes pool creation.
  const s=await start(t,{withInspector:false,withPools:false});await s.tick();
  const native=(await s.capacity()).body.nativeRouter;
  assert.equal(native.inspection,'operator-check');
  assert.deepEqual(native.unavailablePoolKeys,[],'real routing is gated by the per-call tripwire, not a fabricated inspection failure');
  assert.deepEqual(native.shadow.map(r=>r.poolKey),['builder','thinker']);
  for(const r of native.shadow) {
    assert.equal(r.decision.kind,'selected');
    assert.ok(['one','two'].includes(r.wouldSelect));
    assert.equal(s.cfg.router.enabled,false,'shadow override never mutates real config');
  }
  s.setNow(NOW+MINUTE);s.setBody(quotaFeed(NOW+MINUTE,{used:1}));await s.tick();
  const exhausted=(await s.capacity()).body.nativeRouter.shadow;
  assert.ok(exhausted.every(r=>r.wouldSelect==='exhausted'));
  assert.ok(exhausted.every(r=>Object.values(r.decision.skipped).every(reason=>reason==='weekly-exhausted')));
  const envelope=s.store.get(JSON.stringify(s.keyFor(companyId)));
  assert.equal(envelope.shadow.length,4);
  assert.deepEqual(envelope.currentShadow,exhausted);
  assert.deepEqual(s.host.pools,[]);assert.deepEqual(s.host.writes,[]);
});

test('U27 M1 missing-pool drift cannot poison the quota-only synthetic candidate set',async t=>{
  const s=await start(t,{withPools:false});await s.tick();
  const envelope=s.store.get(JSON.stringify(s.keyFor(companyId)));
  assert.ok(envelope.snapshot.drift.drift.some(d=>d.type==='missing-pool'));
  assert.ok(Object.values(envelope.snapshot.memberSkipReasons).every(reason=>reason==='unmapped-member'));
  assert.ok(envelope.currentShadow.every(r=>r.decision.kind==='selected'));
  assert.ok(envelope.currentShadow.every(r=>['one','two'].includes(r.wouldSelect)));
  assert.deepEqual(s.host.writes,[]);
});

test('M1 quota-only shadow still rejects missing feed members and unusable credentials',async t=>{
  const s=await start(t,{configure:false,withInspector:false,withPools:false});
  const feed=quotaFeed(NOW,{missing:['two']});
  for(const evidence of feed.accounts[0].credentialAvailability.models)evidence.readyCredentials=0;
  s.setBody(feed);await s.plugin.onConfigChanged(s.cfg,{companyId});await s.tick();
  const envelope=s.store.get(JSON.stringify(s.keyFor(companyId)));
  assert.equal(envelope.snapshot.staleMemberIds.length,1);
  assert.ok(envelope.currentShadow.every(r=>r.decision.kind==='exhausted'));
  const reasons=envelope.currentShadow.flatMap(r=>Object.values(r.decision.skipped));
  assert.ok(reasons.every(reason=>reason==='credential-unavailable'),'credential absence takes precedence for missing feed members too');
  assert.equal(envelope.snapshot.accounts.two.skipReason,'account-reading-stale');
  assert.equal(envelope.snapshot.accounts.two.staleSinceMs,NOW);
  assert.equal(reasons.includes('unmapped-member'),false,'remove only deployment poisoning, not quota gates');
});

test('worker suppresses synthetic shadow when a live router binding cannot be mapped without inspection',async t=>{
  const s=await start(t,{configure:false,withInspector:false,withPools:false});
  s.context.agents.list=async()=>[{runtimeConfig:{aiConnection:{mode:'router',connectionId:'40000000-0000-4000-8000-000000009999'}}}];
  await s.plugin.onConfigChanged(s.cfg,{companyId});await s.tick();
  const native=(await s.capacity()).body.nativeRouter;
  assert.deepEqual(native.shadow,[],'an unknown live pool must not be assumed unbound');
  assert.equal(native.shadowSuppressedReason,'pool-bindings-unmapped');
  assert.equal(native.snapshotAtMs,NOW,'binding ambiguity must not prevent fresh quota publication');
  assert.deepEqual(native.unavailablePoolKeys,[]);
  s.setNow(NOW+MINUTE);s.setBody(quotaFeed(NOW+MINUTE));await s.tick();
  assert.equal(s.logs.filter(l=>l.details?.reason==='pool-bindings-unmapped').length,1,'suppression warning is rate limited');
  s.context.agents.list=async()=>[];
  s.setNow(NOW+2*MINUTE);s.setBody(quotaFeed(NOW+2*MINUTE));await s.tick();
  const recovered=(await s.capacity()).body.nativeRouter;
  assert.equal(recovered.shadow.length,2);assert.equal(recovered.shadowSuppressedReason,null);
});

test('first router config launches an async immediate refresh without waiting for HTTP or readiness',async t=>{
  const s=await start(t,{configure:false});let release;s.blockOn(new Promise(r=>{release=r;}));
  await s.plugin.onConfigChanged(s.cfg,{companyId});
  await new Promise(setImmediate);
  assert.equal(s.requests.length,1,'initial refresh has started without a scheduled tick');
  assert.equal((await s.capacity()).body.nativeRouter.snapshotAtMs,null);
  release();await s.tick();assert.equal((await s.capacity()).body.nativeRouter.snapshotAtMs,NOW);
});

test('concurrent scheduled ticks share one lane fetch and one publication per company',async t=>{
  const s=await start(t,{configure:false});let release;s.blockOn(new Promise(r=>{release=r;}));
  await s.plugin.onConfigChanged(s.cfg,{companyId});const a=s.tick(),b=s.tick();
  await new Promise(setImmediate);assert.equal(s.requests.length,1);release();await Promise.all([a,b]);
  const envelope=s.store.get(JSON.stringify(s.keyFor(companyId)));
  assert.equal(envelope.snapshot.version,1);
});

test('network/malformed responses retain publication; repeated failures are rate-limited and sanitized',async t=>{
  const s=await start(t);await s.tick();s.setNow(NOW+MINUTE);s.setStatus(503);
  await assert.rejects(s.tick());await assert.rejects(s.tick());
  assert.equal((await s.capacity()).body.nativeRouter.snapshotAtMs,NOW);
  const warnings=s.logs.filter(l=>l.details?.reason==='cliproxy-http-503');assert.equal(warnings.length,1);
  s.setStatus(200);s.setBody({accounts:'bad'});await assert.rejects(s.tick());
  assert.equal((await s.capacity()).body.nativeRouter.snapshotAtMs,NOW);
});

test('legacy configuration keeps the old hook behavior and does not require native pool inspection',async t=>{
  const s=await start(t,{router:false});await s.tick();
  const answer=await s.plugin.onResolveRunModel({companyId,runId:'legacy',agentId:'a',adapterType:'codex_local'});
  assert.deepEqual(answer,{kind:'keep'});assert.equal(s.requests.length,1);
  assert.equal(s.store.has(JSON.stringify(s.keyFor(companyId))),false);
});

test('quota publisher fences a config change while an old lane fetch is pending',async t=>{
  const s=await start(t,{configure:false});let release;s.blockOn(new Promise(r=>{release=r;}));
  await s.plugin.onConfigChanged(s.cfg,{companyId});await new Promise(setImmediate);
  s.cfg.router.accounts[0].prefix='changed';await s.plugin.onConfigChanged(s.cfg,{companyId});
  release();await s.tick();
  const envelope=s.store.get(JSON.stringify(s.keyFor(companyId)));
  assert.ok(!envelope || envelope.snapshot.accounts.one.credentialReady===false,'old prefix cannot publish ready native state; unaffected account two may stay eligible');
});

test('native scheduled ticks refresh the lane every minute even with a long legacy demand-cache TTL',async t=>{
  const s=await start(t,{configure:false});s.cfg.cliproxy.cacheTtlSec=3600;
  await s.plugin.onConfigChanged(s.cfg,{companyId});await s.tick();
  s.setNow(NOW+MINUTE);s.setBody(quotaFeed(NOW+MINUTE));await s.tick();
  assert.equal(s.requests.length,2,'native quota job must not reuse a long-lived legacy demand cache');
});

test('omitting router.enabled never silently enables the native callback policy',async t=>{
  const {resolveConfig}=await import('../src/plugin.mjs');
  const {routeDecision}=await import('../src/router.mjs');
  const {syntheticRouterRequest}=await import('../src/quota-refresh.mjs');
  const {normalizeRegistry}=await import('../src/registry.mjs');
  const s=await start(t,{configure:false});delete s.cfg.router.enabled;
  await s.plugin.onConfigChanged(s.cfg,{companyId});await s.tick();
  const snapshot=s.store.get(JSON.stringify(s.keyFor(companyId))).snapshot;
  const request=syntheticRouterRequest(normalizeRegistry(s.cfg.router),'builder',NOW);
  const result=routeDecision(request,snapshot,resolveConfig(s.cfg));
  assert.equal(result.kind,'exhausted');assert.ok(Object.values(result.skipped).every(reason=>reason==='router-disabled'));
});
