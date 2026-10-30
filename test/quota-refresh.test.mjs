import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeApi, options, scratch, companyId, agentId } from './support/native-api.mjs';
import { applyPoolSaga } from '../scripts/pool-saga.mjs';
import { normalizeRegistry, memberIdFor } from '../src/registry.mjs';
import { routeDecision } from '../src/router.mjs';
import { aiConnectionPoolConfigSchema } from './fixtures/upstream-schemas/ai-connection-router.js';
import { config, quotaFeed, stateHarness, NOW, MINUTE } from './support/quota.mjs';
const library=await import('../src/quota-refresh.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});

async function start(t,{withInspector=true}={}) {
  const host=new NativeApi();await applyPoolSaga({...options(host),activate:false,journalPath:await scratch(t)});host.writes=[];
  const state=stateHarness();let now=NOW,inspections=0,failInspection=false,agents=[];
  const quota=library.createQuotaRefresh({...state,clock:()=>now,
    inspectPools:withInspector?async()=>{inspections++;if(failInspection)throw new Error('PRIVATE_INSPECTION_ERROR');return {...options(host),expectedEnabled:false};}:null,
    listAgents:async()=>agents,
  });
  const cfg=config();
  return {...state,quota,host,cfg,setNow:n=>{now=n;},setInspectionFailure:v=>{failInspection=v;},setAgents:v=>{agents=v;},get inspections(){return inspections;},
    tick:feed=>quota.refresh(companyId,cfg,{feed:feed??quotaFeed(now),ledger:new Map()}),
  };
}

test('quota refresh publishes an R3 snapshot and consumes read-only checkPoolDrift every tick',async t=>{
  assert.equal(typeof library.createQuotaRefresh,'function');
  const s=await start(t);await s.tick();s.setNow(NOW+MINUTE);await s.tick();
  assert.equal(s.inspections,2);assert.ok(s.host.reads.filter(r=>r==='connections').length>=2);
  assert.equal(s.quota.get(companyId).version,2);assert.deepEqual(s.quota.get(companyId).drift.drift,[]);
  assert.deepEqual(s.host.writes,[],'runtime inspector never mutates native objects');
  assert.equal(s.store.get(JSON.stringify(s.keyFor(companyId))).snapshot.atMs,NOW+MINUTE);
});

test('A1 missing feed members are marked stale and warnings emitted without guessing a free exemption',async t=>{
  const s=await start(t);await s.tick(quotaFeed(NOW,{missing:['two']}));
  assert.deepEqual(s.quota.get(companyId).staleMemberIds,[memberIdFor('builder','two')]);
  assert.ok(s.logs.some(l=>l.level==='warn' && l.details.reason==='account-missing-from-feed' && l.details.accountKey==='two'));
  await s.tick();assert.deepEqual(s.quota.get(companyId).staleMemberIds,[]);
});

test('V0 startup ownership mismatch logs ERROR and rejects an otherwise valid-looking callback',async t=>{
  const s=await start(t);const pool=s.host.pools.find(p=>p.name==='builder');pool.pluginKey='foreign.plugin';
  await s.tick();const snapshot=s.quota.get(companyId);
  assert.ok(s.logs.some(l=>l.level==='error' && l.details.reason==='plugin-key-drift' && l.details.poolId===pool.id));
  assert.ok(snapshot.unavailablePoolIds.includes(pool.id));
  const request=library.syntheticRouterRequest(normalizeRegistry(s.cfg.router),'builder',NOW);
  request.pool.id=pool.id; // Defensive: ownership changed after request construction.
  assert.equal(routeDecision(request,snapshot,{...s.cfg,router:{...s.cfg.router,enabled:true}},{syntheticShadow:true}).kind,'unavailable');
  assert.deepEqual(s.host.writes,[]);
});

test('per-member drift from the real drift checker is applied fail-closed to the next snapshot',async t=>{
  const s=await start(t);await s.tick();
  s.host.pools.find(p=>p.name==='builder').members.pop();s.setNow(NOW+MINUTE);await s.tick();
  const snapshot=s.quota.get(companyId),id=memberIdFor('builder','two');
  assert.equal(snapshot.memberSkipReasons[id],'unmapped-member');
  assert.ok(snapshot.drift.drift.some(d=>d.type==='missing-member' && d.memberId===id));
  const request=library.syntheticRouterRequest(normalizeRegistry(s.cfg.router),'builder',NOW+MINUTE);
  request.pinnedMemberId=id;
  assert.equal(routeDecision(request,snapshot,{...s.cfg,router:{...s.cfg.router,enabled:true}},{syntheticShadow:true}).skipped[id],'unmapped-member');
});

test('A2 default quota path uses operator-check inspection and never fabricates a drift overlay',async t=>{
  const s=await start(t,{withInspector:false});await s.tick();
  for(const key of ['unavailablePoolKeys','unavailablePoolIds','drift','expectedPools'])assert.equal(Object.hasOwn(s.quota.get(companyId),key),false);
  assert.equal(s.quota.status(companyId).inspection,'operator-check');
  assert.equal(s.logs.some(l=>l.details.reason==='pool-inspection-unavailable'),false);
  const request=library.syntheticRouterRequest(normalizeRegistry(s.cfg.router),'builder',NOW);
  assert.equal(routeDecision(request,s.quota.get(companyId),{...s.cfg,router:{...s.cfg.router,enabled:true}}).kind,'unavailable');
});

test('U14 malformed feed or failed state write keeps the previous immutable snapshot and history timestamp',async t=>{
  const s=await start(t);await s.tick();const before=s.quota.get(companyId);
  s.setNow(NOW+MINUTE);await s.tick({broken:true});assert.equal(s.quota.get(companyId),before);
  s.setFail(true);await s.tick();assert.equal(s.quota.get(companyId),before);
  assert.equal(s.quota.status(companyId).lastFailure,'quota-state-failed');
  assert.equal(JSON.stringify(s.logs).includes('PRIVATE_STATE_ERROR'),false);
});

test('inspection failures keep prior state and log once per failure class per ten minutes with no raw errors',async t=>{
  const s=await start(t);await s.tick();const before=s.quota.get(companyId);s.setInspectionFailure(true);
  await s.tick();await s.tick();
  s.setNow(NOW+10*MINUTE);await s.tick();
  assert.equal(s.quota.get(companyId),before);
  assert.equal(s.logs.filter(l=>l.details.reason==='pool-inspection-failed').length,2);
  assert.equal(JSON.stringify(s.logs).includes('PRIVATE_INSPECTION_ERROR'),false);
});

test('U27 shadow runs the same core per pool with enabled overridden true, recording quota exhaustion too',async t=>{
  const s=await start(t);await s.tick();const snapshot=s.quota.get(companyId),records=s.quota.status(companyId).shadow;
  assert.deepEqual(records.map(r=>r.poolKey),['builder','thinker']);
  const registry=normalizeRegistry(s.cfg.router);
  for(const record of records) {
    const request=library.syntheticRouterRequest(registry,record.poolKey,NOW);
    const {id,companyId:cid,pluginKey,revision,...poolConfig}=request.pool;
    assert.equal(cid,companyId);assert.equal(pluginKey,'togetherweown.model-capacity');
    assert.ok(aiConnectionPoolConfigSchema.safeParse(poolConfig).success,'synthetic members conform to real upstream schema');
    assert.deepEqual(record.decision,routeDecision(request,snapshot,{...s.cfg,router:{...s.cfg.router,enabled:true}},{syntheticShadow:true}));
    assert.equal(record.wouldSelect,snapshot.memberIndex[record.decision.memberId].accountKey);
    assert.equal(routeDecision(request,snapshot,s.cfg).kind,'exhausted');
    assert.ok(Object.values(routeDecision(request,snapshot,s.cfg).skipped).every(r=>r==='router-disabled'));
  }
  s.setNow(NOW+MINUTE);await s.tick(quotaFeed(NOW+MINUTE,{used:1}));
  const shadow=s.quota.status(companyId).shadow;
  assert.ok(shadow.every(r=>r.wouldSelect==='exhausted'));
  assert.ok(shadow.every(r=>Object.values(r.decision.skipped).every(reason=>reason==='weekly-exhausted')));
  assert.equal(JSON.stringify(shadow).includes('router-disabled'),false);
  assert.equal(s.store.get(JSON.stringify(s.keyFor(companyId))).shadow.length,4,'bounded history retains both ticks');
});

test('shadow is recorded for unbound pools only; a bound pool is observed via real callback logs',async t=>{
  const s=await start(t);s.setAgents([{id:agentId,runtimeConfig:{aiConnection:{mode:'router',connectionId:s.host.pools.find(p=>p.name==='builder').id}}}]);
  await s.tick();assert.deepEqual(s.quota.status(companyId).shadow.map(r=>r.poolKey),['thinker']);
});

test('config generation fence prevents a late tick publishing under a new registry',async t=>{
  const s=await start(t);let current=true;
  const original=s.host.listConnections.bind(s.host);s.host.listConnections=async(...args)=>{const r=await original(...args);current=false;return r;};
  await s.quota.refresh(companyId,s.cfg,{feed:quotaFeed(),ledger:new Map(),isCurrent:()=>current});
  assert.equal(s.quota.get(companyId),null);assert.equal(s.writes.length,0);
});

test('shadow history is capped and companies cannot consume a registry from a different company',async t=>{
  const s=await start(t);for(let i=0;i<130;i++){s.setNow(NOW+i*MINUTE);await s.tick();}
  const envelope=s.store.get(JSON.stringify(s.keyFor(companyId)));
  assert.ok(envelope.shadow.length<=120);
  const other='10000000-0000-4000-8000-000000000009';
  await s.quota.refresh(other,s.cfg,{feed:quotaFeed(),ledger:new Map()});
  assert.equal(s.quota.get(other),null);assert.equal(s.quota.status(other).lastFailure,'router-company-mismatch');
});

test('ten-second job timeout rejects even when SDK transport ignores AbortSignal; late HTTP results do not win',async t=>{
  assert.equal(typeof library.withQuotaTimeout,'function');
  t.mock.timers.enable({apis:['setTimeout']});
  let release,signal;const pending=library.withQuotaTimeout(s=>{signal=s;return new Promise(r=>{release=r;});});
  await Promise.resolve();const rejected=assert.rejects(pending,/cliproxy-timeout/);
  t.mock.timers.tick(9999);assert.equal(signal.aborted,false);
  t.mock.timers.tick(1);await rejected;assert.equal(signal.aborted,true);
  release({accounts:[]});await Promise.resolve();
});

test('A2 default job maps bound pool UUIDs from verified tick config without inspecting native resources',async t=>{
  const {verifiedConfig}=await import('./support/verified-pools.mjs');
  const s=await start(t,{withInspector:false});
  const verified=verifiedConfig().router.pools[0];Object.assign(s.cfg.router.pools[0],verified);
  s.setAgents([{runtimeConfig:{aiConnection:{mode:'router',connectionId:verified.poolId}}}]);
  await s.tick();
  assert.equal(s.inspections,0);
  assert.equal(s.quota.status(companyId).inspection,'operator-check');
  assert.equal(s.quota.status(companyId).shadowSuppressedReason,null);
  assert.deepEqual(s.quota.status(companyId).shadow.map(r=>r.poolKey),['thinker']);
  assert.equal(JSON.stringify(s.quota.get(companyId)).includes(verified.poolId),false,'quota snapshot carries no attestation');
  assert.deepEqual(s.host.writes,[]);
});
