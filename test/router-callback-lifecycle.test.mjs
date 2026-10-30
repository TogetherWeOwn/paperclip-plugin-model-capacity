import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { normalizeRegistry } from '../src/registry.mjs';
import { syntheticRouterRequest } from '../src/quota-refresh.mjs';
import { verifiedConfig } from './support/verified-pools.mjs';
import { NOW, MINUTE, quotaFeed, stateHarness } from './support/quota.mjs';
import { companyId } from './support/native-api.mjs';

async function start({ledger=[], calibration=null, used=.2}={}) {
  const h=stateHarness(),cfg=verifiedConfig(),jobs=new Map(),events=new Map();let now=NOW;
  h.store.set(JSON.stringify({...h.keyFor(companyId),stateKey:'ledger-v1'}),structuredClone(ledger));
  if (calibration) h.store.set(JSON.stringify({...h.keyFor(companyId),stateKey:'smoothing-v1'}),{accountE:calibration});
  cfg.router.enabled=true;cfg.roles={minQuality:{doer:null,thinker:null,other:null}};
  cfg.armMap=[{aaSlug:'terra-high',model:'terra',effort:'high',family:'terra',providers:['codex']},
    {aaSlug:'claude-high',model:'claude',effort:'high',family:'haiku',providers:['claude']}];
  h.store.set(JSON.stringify({...h.keyFor(companyId),stateKey:'aa-snapshot-v1'}),{fetchedAt:new Date(now).toISOString(),rows:[
    {slug:'terra-high',intelligenceIndex:60,intelligenceIndexCostPerTask:5},
    {slug:'claude-high',intelligenceIndex:55,intelligenceIndexCostPerTask:4},
  ]});
  const context={state:h.state,logger:h.logger,config:{get:async()=>cfg},secrets:{resolve:async()=> 'TEST_SECRET_NEVER_LOGGED'},
    http:{fetch:async()=>({status:200,json:async()=>quotaFeed(now,{used})})},jobs:{register:(key,fn)=>jobs.set(key,fn)},events:{on:(key,fn)=>events.set(key,fn)},
    agents:{get:async()=>null,list:async()=>[]},issues:{get:async()=>null,list:async()=>[]}};
  const plugin=createModelCapacityPlugin({clock:()=>now,requirePinnedLaneHost:false});
  await plugin.setup(context);await plugin.onConfigChanged(cfg,{companyId});
  const tick=()=>jobs.get('quota-refresh')({});await tick();
  const params=syntheticRouterRequest(normalizeRegistry(cfg.router),'builder',now),entry=cfg.router.pools[0];
  params.pool.id=entry.poolId;params.pool.revision=entry.expectedRevision;
  for(const {member,runtimeConfig} of params.candidates) {
    const {connectionId,grantId}=entry.members.find(m=>m.memberId===member.id);
    Object.assign(member.binding,{connectionId,grantId});runtimeConfig.modelReasoningEffort='high';
  }
  // model is supplemental observed metadata, NOT a claim that upstream's
  // current lifecycle publisher provides it (the final test uses its real shape).
  const fire=(runId,status,model)=>events.get(`agent.run.${status}`)({companyId,entityId:runId,occurredAt:new Date(now).toISOString(),payload:{runId,agentId:'agent',...(model?{model}:{})}});
  return {...h,plugin,context,cfg,params,tick,fire,setNow:n=>{now=n;params.now=new Date(n).toISOString();},
    route:()=>plugin.onRouteAiConnection(params),capacity:async()=> (await plugin.onApiRequest({companyId,routeKey:'capacity'})).body.nativeRouter};
}

test('native callback uses the real published snapshot and cannot touch SDK IO on repeated host retries',async()=>{
  const s=await start(),first=s.route();assert.equal(first.kind,'selected');assert.equal(first.memberId,s.params.memberOrder[0]);
  const priorWrites=s.writes.length;
  for(const key of ['state','config','secrets','http','agents','issues'])s.context[key]=new Proxy({}, {get(){throw new Error(`callback-io-forbidden:${key}`);}});
  for(let i=0;i<20;i++)assert.deepEqual(s.route(),first);
  assert.equal(s.writes.length,priorWrites);
  assert.equal(JSON.stringify(s.logs).includes('TEST_SECRET_NEVER_LOGGED'),false);
});

test('observed model-attributed run events spread selections without callback reservations and survive a quota tick',async()=>{
  const s=await start(),[a,b]=s.params.memberOrder;
  assert.equal(s.route().memberId,a);
  await s.fire('one-run','started','one/terra');
  assert.equal(s.route().memberId,b,'post-tick start pressure must reach the callback');
  await s.fire('one-run','started','one/terra');assert.equal(s.route().memberId,b);
  s.setNow(NOW+MINUTE);await s.tick();
  assert.equal(s.route().memberId,b,'base count replaces the overlay exactly once');
  await s.fire('one-run','finished');assert.equal(s.route().memberId,a);
  await s.fire('one-run','finished');assert.equal(s.route().memberId,a);
});

test('events during persist are replayed over the new base, and failed ticks never clear the current overlay',async()=>{
  const s=await start(),[a,b]=s.params.memberOrder;let release,entered;
  const blocked=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;}),original=s.context.state.set;
  s.context.state.set=async(key,value)=>{if(key.stateKey==='router-quota-v1'){entered();await blocked;}return original(key,value);};
  s.setNow(NOW+MINUTE);const ticking=s.tick();await started;
  await s.fire('during-persist','started','one/terra');assert.equal(s.route().memberId,b);
  release();await ticking;assert.equal(s.route().memberId,b,'a post-build event cannot vanish at publication');
  s.context.state.set=original;s.setFail(true);s.setNow(NOW+2*MINUTE);await assert.rejects(s.tick());
  assert.equal(s.route().memberId,b);s.setFail(false);
  await s.fire('during-persist','cancelled');assert.equal(s.route().memberId,a);
});

test('validated config revocation affects the next callback even while its refresh is blocked',async()=>{
  const s=await start();assert.equal(s.route().kind,'selected');
  let release;s.context.http.fetch=async()=>{await new Promise(r=>{release=r;});throw new Error('PRIVATE_UPSTREAM_FAILURE');};
  s.cfg.router.pools=s.cfg.router.pools.map(({poolKey,role})=>({poolKey,role}));
  await s.plugin.onConfigChanged(s.cfg,{companyId});
  assert.equal(s.route().kind,'unavailable');
  await new Promise(setImmediate);release();await assert.rejects(s.tick());
});

test('current upstream account-less lifecycle payloads expose the R2 attribution gap instead of inventing accounts',async()=>{
  const s=await start();
  await s.fire('native-shape','started');
  assert.equal((await s.capacity()).unattributedInFlight,1);
  assert.equal(s.logs.filter(l=>l.message==='model-capacity: native route').at(-1)?.details.accountKey,undefined);
  await s.fire('native-shape','failed');assert.equal((await s.capacity()).unattributedInFlight,0);
});

test('agent-config-seeded ledger cannot attribute a model-less lifecycle event or release observed base pressure',async()=>{
  const s=await start({ledger:[{
    runId:'config-seeded',agentId:'agent',status:'running',startedAt:NOW,
    actualModel:'one/terra',actualModelSource:'agent-config',unverified:false,
  }]});
  const [a,b]=s.params.memberOrder;
  const persisted=s.store.get(JSON.stringify({...s.keyFor(companyId),stateKey:'ledger-v1'}));
  const seeded=persisted.find(r=>r.runId==='config-seeded');
  assert.equal(seeded.actualModel,'one/terra');
  assert.equal(seeded.actualModelSource,'agent-config','the fixture must exercise the non-authoritative fallback');

  await s.fire('observed-base','started','one/terra');
  await s.fire('config-seeded','started');
  await s.fire('config-seeded','started');
  assert.equal((await s.capacity()).unattributedInFlight,1,'a configured model is not evidence of the run account');
  assert.equal(s.route().memberId,b,'unattributed starts must not erase observed pressure');

  s.setNow(NOW+MINUTE);await s.tick();
  assert.equal((await s.capacity()).unattributedInFlight,1,'publication cannot silently discard the unattributed run');
  await s.fire('config-seeded','finished');
  await s.fire('config-seeded','finished');
  assert.equal((await s.capacity()).unattributedInFlight,0);
  assert.equal(s.route().memberId,b,'an account-less terminal cannot release the observed base run');
  await s.fire('observed-base','finished');
  s.setNow(NOW+2*MINUTE);await s.tick();
  assert.equal(s.route().memberId,a,'terminal ledger truth clears pressure at the next publication');
});


test('quota job projects validated account calibration onto an attributed active run',async()=>{
  const s=await start({used:.98,ledger:[{runId:'active',status:'running',startedAt:NOW,eventModel:'one/terra'}],
    calibration:{'openai:one':{source:'account-weekly',burnPerRunPct:.02,fiveHourBurnPerRunPct:.03,
      attributedRuns:10,rejectionReason:null,atMs:NOW,epoch:'keeper-1'}}});
  const account=s.store.get(JSON.stringify(s.keyFor(companyId))).snapshot.accounts.one;
  assert.equal(account.inFlightBase,1);
  assert.equal(account.view.projectedUsed,1);
  assert.equal(account.view.projectedFiveHourUsed,.13);
  assert.equal(account.skipReason,'weekly-exhausted');
});

test('fresh worker reconciles a persisted model-less run and subsequent events exactly once',async()=>{
  const s=await start({ledger:[{runId:'persisted',status:'running',startedAt:NOW,unverified:false}]});
  assert.equal((await s.capacity()).unattributedInFlight,1);
  await s.fire('persisted','started');
  assert.equal((await s.capacity()).unattributedInFlight,1);
  await s.fire('persisted','finished');
  assert.equal((await s.capacity()).unattributedInFlight,0);
  s.setNow(NOW+MINUTE);await s.tick();
  assert.equal((await s.capacity()).unattributedInFlight,0);
});

test('quota publication excludes absent, rejected, stale and weak calibration while preserving five-hour-only evidence',async()=>{
  const active=[{runId:'active',status:'running',startedAt:NOW,eventModel:'one/terra'}];
  for (const calibration of [null,
    {'openai:one':{source:'group-prior',burnPerRunPct:.02,atMs:NOW}},
    {'openai:one':{source:'account-weekly',burnPerRunPct:.02,attributedRuns:10,rejectionReason:'low-attributed-runs',atMs:NOW}},
    {'openai:one':{source:'account-weekly',burnPerRunPct:.02,attributedRuns:10,atMs:NOW-7*3600000}},
    {'openai:one':{source:'account-weekly',burnPerRunPct:.02,attributedRuns:1,atMs:NOW}},
  ]) {
    const s=await start({used:.98,ledger:active,calibration});
    const a=s.store.get(JSON.stringify(s.keyFor(companyId))).snapshot.accounts.one;
    assert.equal(a.view.projectedUsed,.98);
    assert.notEqual(a.skipReason,'weekly-exhausted');
  }
  const s=await start({ledger:active,calibration:{'openai:one':{source:'account-five-hour',fiveHourBurnPerRunPct:.04,atMs:NOW}}});
  const a=s.store.get(JSON.stringify(s.keyFor(companyId))).snapshot.accounts.one;
  assert.equal(a.view.projectedUsed,.2);
  assert.equal(a.view.projectedFiveHourUsed,.14);
});

test('a terminal event during publication cannot resurrect a persisted unattributed run',async()=>{
  const s=await start({ledger:[{runId:'persisted',status:'running',startedAt:NOW,unverified:false}]});
  let release,entered;const blocked=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
  const original=s.context.state.set;
  s.context.state.set=async(key,value)=>{if(key.stateKey==='router-quota-v1'){entered();await blocked;}return original(key,value);};
  s.setNow(NOW+MINUTE);const ticking=s.tick();await started;
  await s.fire('persisted','finished');assert.equal((await s.capacity()).unattributedInFlight,0);
  release();await ticking;assert.equal((await s.capacity()).unattributedInFlight,0);
});
