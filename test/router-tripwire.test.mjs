import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routeDecision, routerDiagnostics } from '../src/router.mjs';
import { syntheticRouterRequest } from '../src/quota-refresh.mjs';
import { normalizeRegistry } from '../src/registry.mjs';
import { buildQuotaSnapshot } from '../src/snapshot.mjs';
import { verifiedConfig } from './support/verified-pools.mjs';
import { quotaFeed, NOW } from './support/quota.mjs';

function fixture() {
  const config=verifiedConfig();config.router.enabled=true;
  const registry=normalizeRegistry(config.router),entry=config.router.pools[0];
  const params=syntheticRouterRequest(registry,'builder',NOW);
  params.pool.id=entry.poolId;params.pool.revision=entry.expectedRevision;
  for(const {member} of params.candidates) {
    const {connectionId,grantId}=entry.members.find(m=>m.memberId===member.id);
    Object.assign(member.binding,{connectionId,grantId});
  }
  const snapshot=buildQuotaSnapshot({registry,feed:quotaFeed(),nowMs:NOW,config}).snapshot;
  return {config,params,snapshot};
}
const decide=f=>routeDecision(f.params,f.snapshot,f.config);
const diagnose=f=>routerDiagnostics(f.params,f.snapshot,f.config);

test('attested call routes; authorized subset and pinned calls use the full host member order',()=>{
  const f=fixture();assert.equal(decide(f).kind,'selected');assert.equal(diagnose(f).tripwire,undefined);
  const id=f.params.memberOrder[1];
  f.params.candidates=f.params.candidates.slice(1);f.params.pool.members=f.params.candidates.map(c=>c.member);
  f.params.pinnedMemberId=id;
  assert.deepEqual(decide(f),{kind:'selected',memberId:id});
  assert.equal(diagnose(f).tripwire,undefined);
});

test('each identity, revision, order, membership and binding mismatch trips before pins and quota freshness',()=>{
  const cases=[
    ['unverified-pool',f=>{f.config.router.pools=[];}],
    ['unverified-pool',f=>{f.config={};}],
    ['unverified-pool',f=>{f.config=null;}],
    ['invalid-attestation',f=>{delete f.config.router.pools[0].members;}],
    ['invalid-attestation',f=>{f.config.router.pools[0].expectedRevision=-1;}],
    ['invalid-attestation',f=>{f.config.router.pools[0].expectedRevision='7';}],
    ['invalid-attestation',f=>{f.config.router.pools[0].expectedMemberOrder.push(f.params.memberOrder[0]);}],
    ['invalid-attestation',f=>{f.config.router.pools[0].members[1].memberId=f.params.memberOrder[0];}],
    ['invalid-attestation',f=>{f.config.router.pools[0].members[0].grantId=null;}],
    ['plugin-key-mismatch',f=>{f.params.pool.pluginKey='foreign';}],
    ['revision-mismatch',f=>{f.params.pool.revision++;}],
    ['member-order-mismatch',f=>{f.params.memberOrder.reverse();}],
    ['member-order-mismatch',f=>{f.params.memberOrder.pop();}],
    ['member-order-mismatch',f=>{delete f.params.memberOrder;}],
    ['candidate-member-mismatch',f=>{f.params.candidates[0].member.id='unknown';}],
    ['candidate-binding-mismatch',f=>{f.params.candidates[0].member.binding.connectionId=f.config.router.pools[0].members[1].connectionId;}],
    ['candidate-binding-mismatch',f=>{delete f.params.candidates[0].member.binding.grantId;}],
  ];
  for(const [code,mutate] of cases)for(const pinned of [false,true]) {
    const f=fixture();if(pinned)f.params.pinnedMemberId=f.params.memberOrder[0];mutate(f);
    const expected={kind:'unavailable',skipped:Object.fromEntries(f.params.candidates.map(c=>[c.member.id,'unmapped-member']))};
    assert.deepEqual(decide(f),expected,`${code}, pinned=${pinned}`);
    const d=diagnose(f);assert.equal(d.tripwire,code);assert.equal(d.level,'error');
    const text=JSON.stringify(d);
    for(const m of f.config?.router?.pools?.[0]?.members??[]) {
      if(m.connectionId)assert.equal(text.includes(m.connectionId),false);
      if(m.grantId)assert.equal(text.includes(m.grantId),false);
    }
    f.snapshot=null;assert.deepEqual(decide(f),expected,`${code} must precede cold-start wait`);
  }
});

test('same fresh snapshot cannot preserve an edited or removed attestation',()=>{
  const f=fixture();assert.equal(decide(f).kind,'selected');
  const old=structuredClone(f.config.router.pools);
  f.snapshot={...f.snapshot,expectedPools:old};
  f.config.router.pools[0].expectedRevision++;
  assert.equal(decide(f).kind,'unavailable');assert.equal(diagnose(f).tripwire,'revision-mismatch');
  f.config.router.pools=[];
  assert.equal(decide(f).kind,'unavailable');assert.equal(diagnose(f).tripwire,'unverified-pool');
  f.config.router.pools=old;assert.equal(decide(f).kind,'selected');
});

test('snapshot and router-disabled precedence survive; JS-only synthetic exemption cannot come from config or RPC',()=>{
  const f=fixture();f.snapshot=null;
  assert.equal(decide(f).skipped[f.params.memberOrder[0]],'quota-snapshot-stale');
  f.config.router.pools=[];
  f.config.router.enabled=false;
  assert.equal(decide(f).skipped[f.params.memberOrder[0]],'router-disabled');
  f.params.candidates=[];assert.deepEqual(decide(f),{kind:'unavailable',skipped:{}});
  const g=fixture();g.config.router.pools=[];
  g.config.router.syntheticShadow=true;g.params.syntheticShadow=true;
  assert.equal(decide(g).kind,'unavailable');
  assert.equal(routeDecision(g.params,g.snapshot,g.config,{syntheticShadow:'true'}).kind,'unavailable');
  assert.equal(routeDecision(g.params,g.snapshot,g.config,{syntheticShadow:true}).kind,'selected');
  assert.equal(routerDiagnostics(g.params,g.snapshot,g.config,{syntheticShadow:true}).tripwire,undefined);
  for(const file of ['plugin.mjs','worker.mjs'])assert.doesNotMatch(readFileSync(new URL(`../src/${file}`,import.meta.url),'utf8'),/syntheticShadow/);
});

test('tripwire diagnostics expose only sanitized pool identity and numeric revisions',()=>{
  const f=fixture();f.params.pool.revision=8;
  const d=diagnose(f);
  assert.equal(d.poolId,f.params.pool.id);assert.equal(d.poolKey,'builder');
  assert.equal(d.expectedRevision,7);assert.equal(d.actualRevision,8);
  f.params.pool.revision={secret:'PRIVATE_REVISION'};
  assert.equal(JSON.stringify(diagnose(f)).includes('PRIVATE_REVISION'),false);
});
