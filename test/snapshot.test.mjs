import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRegistry, memberIdFor } from '../src/registry.mjs';
import { routeDecision } from '../src/router.mjs';
const api = await import('../src/snapshot.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
const NOW = Date.parse('2026-10-30T03:00:00Z'), MIN = 60_000, HOUR = 60 * MIN;
const registry = () => normalizeRegistry({companyId:'10000000-0000-4000-8000-000000000001', ownerUserId:'20000000-0000-4000-8000-000000000002', pools:[{poolKey:'builder',role:'doer'}], accounts:[{accountKey:'one',prefix:'p1',connectionName:'One',provider:'openai',protocol:'responses',harnessProfile:'codex',pools:{builder:{model:'model',probeEligible:true}}}]});
const row = (patch={}) => ({accountKey:'one',provider:'openai',health:'healthy',quality:'live',observedAt:new Date(NOW).toISOString(),weekly:{used:.2,resetsAt:new Date(NOW+84*HOUR).toISOString()},fiveHour:{used:.1,resetsAt:new Date(NOW+4*HOUR).toISOString()},credentialAvailability:{version:1,models:[{model:'p1/model',provider:'openai',accountId:'openai:one',servingCredentials:1,readyCredentials:1,observedAt:new Date(NOW).toISOString(),expiresAt:new Date(NOW+2*MIN).toISOString()}]},...patch});
const feed = (accounts=[row()],at=NOW) => ({observedAt:new Date(at).toISOString(),accounts});
const build = options => api.buildQuotaSnapshot({registry:registry(),feed:feed(),nowMs:NOW,...options});
const params = () => {const id=memberIdFor('builder','one');const m={id,profile:{provider:'codex',model:'p1/model'}};return {now:new Date(NOW).toISOString(),pool:{id:'host-pool',name:'builder',pluginKey:'togetherweown.model-capacity',members:[m]},candidates:[{member:m,runtimeConfig:{model:'p1/model'}}],memberOrder:[id],taskKey:'10000000-0000-4000-8000-000000000099'};};

test('snapshot builds immutable R3 accounts, registry joins, selector views and bounded controller state', () => {
  assert.equal(typeof api.buildQuotaSnapshot,'function');
  const result=build(); const s=result.snapshot,a=s.accounts.one;
  assert.equal(s.version,1); assert.equal(s.atMs,NOW);
  assert.deepEqual(s.memberIndex[memberIdFor('builder','one')],{accountKey:'one',poolKey:'builder'});
  assert.deepEqual(s.poolRoles,{builder:'doer'});
  assert.equal(a.weeklyUsed,.2); assert.equal(a.weeklyResetsAtMs,NOW+84*HOUR);
  assert.equal(a.observedAtMs,NOW); assert.equal(a.quality,'live'); assert.equal(a.credentialReady,true);
  assert.equal(a.eligible,true); assert.equal(a.skipReason,null); assert.equal(a.staleSinceMs,null);
  assert.equal(a.view.accountId,'one'); assert.equal(a.view.health,'healthy'); assert.equal(a.view.headroomPct,.8);
  assert.equal(a.requiredRatePerHour,.8/84); assert.equal(a.measuredRatePerHour,null);
  assert.equal(a.burn.active,false); assert.equal(a.paceState.pointer,0);
  assert.ok(Object.isFrozen(s) && Object.isFrozen(a.view) && Object.isFrozen(s.memberIndex));
  assert.throws(()=>{a.weeklyUsed=.9;},TypeError);
  assert.equal(result.histories.one.weekly.length,1);
  assert.equal(routeDecision(params(),s,{router:{enabled:true,accounts:registry().accounts}}).kind,'selected');
});

test('U14 cached vendor 429 retains last-good utilization; vendor error text is not quota evidence', () => {
  const s=build({feed:feed([row({quality:'cached',lastError:{status:429,message:'exhausted'},weekly:{used:.4,resetsAt:NOW+84*HOUR}})])}).snapshot;
  assert.equal(s.accounts.one.quality,'cached'); assert.equal(s.accounts.one.weeklyUsed,.4);
  assert.equal(s.accounts.one.eligible,true); assert.notEqual(s.accounts.one.skipReason,'weekly-exhausted');
  assert.equal(JSON.stringify(s).includes('lastError'),false);
});

test('U14 observation older than 120 seconds is stale even though snapshot tick is fresh', () => {
  const s=build({feed:feed([row({observedAt:new Date(NOW-120_001).toISOString()})])}).snapshot;
  assert.equal(s.atMs,NOW); assert.equal(s.accounts.one.eligible,false);
  assert.equal(s.accounts.one.skipReason,'account-reading-stale');
  assert.equal(s.accounts.one.staleSinceMs,NOW);
  assert.equal(routeDecision(params(),s,{router:{enabled:true}}).skipped[memberIdFor('builder','one')],'account-reading-stale');
});

test('fresh body cannot refresh stale account; fresh account cannot refresh stale body', () => {
  for(const f of [feed([row()],NOW-121*1000),feed([row({observedAt:'bad'})]),{accounts:[row({observedAt:undefined})]}]) {
    assert.equal(build({feed:f}).snapshot.accounts.one.skipReason,'account-reading-stale');
  }
  const s=build({feed:feed([row({observedAt:undefined})])}).snapshot;
  assert.equal(s.accounts.one.observedAtMs,NOW,'credible body time may cover an absent account time');
});

test('unknown weekly meter and future clocks fail closed rather than inventing headroom', () => {
  for(const r of [row({weekly:{used:null}}),row({quality:'unknown'}),row({observedAt:new Date(NOW+60_001).toISOString()}),row({weekly:{used:1.4}})]) {
    assert.equal(build({feed:feed([r])}).snapshot.accounts.one.skipReason,'account-reading-stale');
  }
});

test('missing registry accounts warn each tick, publish stale member IDs, and recover on reappearance', () => {
  const result=build({feed:feed([])}),id=memberIdFor('builder','one');
  assert.deepEqual(result.warnings,[{accountKey:'one',reason:'account-missing-from-feed'}]);
  assert.deepEqual(result.snapshot.staleMemberIds,[id]);
  const again=build({feed:feed([]),previous:result.snapshot,nowMs:NOW+MIN});
  assert.equal(again.snapshot.accounts.one.staleSinceMs,NOW);
  const recovery=build({previous:again.snapshot});
  assert.deepEqual(recovery.snapshot.staleMemberIds,[]); assert.equal(recovery.snapshot.accounts.one.staleSinceMs,null);
  assert.equal(recovery.snapshot.accounts.one.eligible,true);
});

test('feed exemption suppresses join warning, never invents an eligible meter', () => {
  const r=registry();r.accounts[0].feedExempt=true;
  const result=build({registry:r,feed:feed([])});
  assert.deepEqual(result.warnings,[]); assert.deepEqual(result.snapshot.staleMemberIds,[]);
  assert.equal(result.snapshot.accounts.one.eligible,false);
});

test('malformed and duplicate feed identities reject the whole tick', () => {
  for(const f of [null,{}, {accounts:{}},feed([null]),feed([row(),row()]),feed([row({accountKey:' one'})])]) {
    assert.throws(()=>build({feed:f}),/feed/);
  }
});

test('projection uses ledger run truth by prefix, ignores shadow-decided account and terminal runs', () => {
  const ledger=new Map([
    ['live',{status:'running',startedAt:NOW-MIN,actualModel:'p1/model',decidedAccount:'wrong-shadow'}],
    ['done',{status:'finished',startedAt:NOW-MIN,actualModel:'p1/model'}],
    ['unverified',{status:'running',startedAt:NOW-MIN,actualModel:'p1/model',unverified:true}],
  ]);
  const s=build({ledger,meanRunWeeklyPctByAccount:{one:.01}}).snapshot;
  assert.equal(s.accounts.one.inFlightBase,1); assert.equal(s.accounts.one.view.inFlight,1);
  assert.ok(Math.abs(s.accounts.one.view.projectedUsed-.21)<1e-12); assert.ok(Math.abs(s.accounts.one.view.headroomPct-.79)<1e-12);
});

test('rate history measures actual observations and resets with the weekly window', () => {
  const old=build({nowMs:NOW-30*MIN,feed:feed([row({observedAt:new Date(NOW-30*MIN).toISOString(),weekly:{used:.1,resetsAt:NOW+84*HOUR}})],NOW-30*MIN)});
  const result=build({histories:old.histories,controllers:old.controllers,previous:old.snapshot});
  assert.equal(result.snapshot.accounts.one.measuredRatePerHour,.2);
  assert.equal(result.histories.one.weekly.length,2);
  const duplicate=build({histories:result.histories,controllers:result.controllers});
  assert.equal(duplicate.histories.one.weekly.length,2);
  const reset=build({histories:result.histories,feed:feed([row({weekly:{used:.01,resetsAt:NOW+168*HOUR}})])});
  assert.equal(reset.snapshot.accounts.one.view.weeklyMeasuredRatePerHour,null,'reset weekly history is thin; five-hour rate may still be measured');
  assert.equal(reset.histories.one.weekly.length,1);
});

test('rate/tick histories are bounded and removed accounts do not accumulate', () => {
  const points=Array.from({length:150},(_,i)=>({atMs:NOW-(150-i)*1000,usedPct:.19+i/100000}));
  const r=build({histories:{one:{weekly:points,weeklyResetsAtMs:NOW+84*HOUR},retired:{weekly:points}}});
  assert.ok(r.histories.one.weekly.length<=120);assert.ok(r.histories.one.weeklyTicks.length<=64);
  assert.deepEqual(Object.keys(r.histories),['one']);
});

test('ahead of plan and over required rate means held with no at-least-one-run escape', () => {
  const old=build({nowMs:NOW-30*MIN,feed:feed([row({observedAt:new Date(NOW-30*MIN).toISOString(),weekly:{used:.7,resetsAt:NOW+84*HOUR}})],NOW-30*MIN)});
  const result=build({histories:old.histories,feed:feed([row({weekly:{used:.8,resetsAt:NOW+84*HOUR}})])});
  assert.equal(result.snapshot.accounts.one.skipReason,'pace-held');assert.equal(result.snapshot.accounts.one.eligible,false);
  assert.ok(result.snapshot.accounts.one.nextEligibleAtMs>=NOW+MIN);
  assert.ok(result.snapshot.accounts.one.nextEligibleAtMs<=NOW+30*MIN);
});

test('binding weekly/five-hour hard caps and exact credential evidence are enforced', () => {
  for(const [patch,reason] of [
    [{weekly:{used:.995,resetsAt:NOW+HOUR}},'weekly-exhausted'],
    [{fiveHour:{used:.99,resetsAt:NOW+HOUR}},'five-hour-exhausted'],
    [{credentialAvailability:undefined},'credential-unavailable'],
  ])assert.equal(build({feed:feed([row(patch)])}).snapshot.accounts.one.skipReason,reason);
});

test('snapshot staleness helpers reject absence/future clocks and obey strict age boundary', () => {
  assert.equal(api.snapshotIsStale(null,NOW),true);
  assert.equal(api.snapshotIsStale({atMs:NOW-180_000},NOW),false);
  assert.equal(api.snapshotIsStale({atMs:NOW-180_001},NOW),true);
  assert.equal(api.snapshotIsStale({atMs:NOW+60_001},NOW),true);
});

test('publisher persists snapshot and bounded histories before exposing a frozen replacement', async () => {
  const writes=[];let release;
  const state={set:async(k,v)=>{writes.push([k,v]);await new Promise(r=>{release=r;});}};
  const publisher=api.createSnapshotPublisher({state,keyFor:companyId=>({companyId})});
  const result=build(),pending=publisher.publish('one',result);
  await Promise.resolve();assert.equal(publisher.get('one'),null);
  release();await pending;
  assert.equal(publisher.get('one'),result.snapshot);
  assert.deepEqual(writes[0][1].histories,result.histories);
  assert.equal(Object.isFrozen(writes[0][1].snapshot.accounts.one),true);
});

test('state failure and superseded generation never replace the last published snapshot', async () => {
  let fail=false;const state={set:async()=>{if(fail)throw new Error('state-unavailable');}};
  const publisher=api.createSnapshotPublisher({state,keyFor:companyId=>({companyId})});
  const first=build();await publisher.publish('one',first);
  fail=true;await assert.rejects(publisher.publish('one',build({previous:first.snapshot,nowMs:NOW+MIN})),/state-unavailable/);
  assert.equal(publisher.get('one'),first.snapshot);
  fail=false;await publisher.publish('one',build({nowMs:NOW+2*MIN}),{isCurrent:()=>false});
  assert.equal(publisher.get('one'),first.snapshot);
  assert.equal(publisher.get('other'),null);
});

test('account staleness helper retains the oldest body/account observation, not the tick or newer peer', () => {
  const a=build({feed:feed([row()],NOW-121_000)}).snapshot.accounts.one;
  assert.equal(a.observedAtMs,NOW-121_000);
  assert.equal(api.accountReadingIsStale(a,NOW),true);
});
