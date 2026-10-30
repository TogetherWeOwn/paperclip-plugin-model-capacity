import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPoolPlan } from '../scripts/generate-pool.mjs';

const registry = () => ({companyId:'10000000-0000-4000-8000-000000000001',ownerUserId:'20000000-0000-4000-8000-000000000002',allowMessages:true,pools:[{poolKey:'builder',role:'doer'},{poolKey:'thinker',role:'thinker'}],accounts:[
  {accountKey:'codex-1',prefix:'codex1',provider:'openai',protocol:'responses',harnessProfile:'codex',connectionName:'Codex',pools:{builder:{model:'gpt-6.1-terra'},thinker:{model:'gpt-6.1-sol'}}},
  {accountKey:'claude-1',prefix:'claude1',provider:'anthropic',protocol:'messages',harnessProfile:'acpx',connectionName:'Claude',pools:{builder:{model:'model'}}}
]});
const rows = () => [
  {id:'10000000-0000-4000-8000-000000000011',grantId:'10000000-0000-4000-8000-000000000012',name:'Codex',provider:'openai',method:'api_key',ownership:'shared',status:'connected'},
  {id:'10000000-0000-4000-8000-000000000021',grantId:'10000000-0000-4000-8000-000000000022',name:'Claude',provider:'anthropic',method:'api_key',ownership:'shared',status:'connected'}
];
const verdicts = () => ({'codex-1':{builder:true,thinker:true},'claude-1':{builder:true}});

test('pool plan emits upstream SaveInput with fixed per-membership UUIDs and complete bindings', () => {
  const result=buildPoolPlan(registry(), rows(), verdicts());
  assert.deepEqual(result.pools[0],{companyId:'10000000-0000-4000-8000-000000000001',config:{name:'builder',enabled:false,mode:'round_robin',thresholdPercent:90,members:[
    {id:'23c570bf-10b8-5e93-828c-ea933c890feb',binding:{mode:'shared',provider:'openai',method:'api_key',connectionId:'10000000-0000-4000-8000-000000000011',grantId:'10000000-0000-4000-8000-000000000012'},profile:{provider:'codex',model:'codex1/gpt-6.1-terra'}},
    {id:'9b861387-f719-5493-96ed-d72c2579f494',binding:{mode:'shared',provider:'anthropic',method:'api_key',connectionId:'10000000-0000-4000-8000-000000000021',grantId:'10000000-0000-4000-8000-000000000022'},profile:{provider:'acpx',acpxAgent:'claude',model:'claude1/model'}}
  ]}});
  assert.deepEqual(result.memberIndex['23c570bf-10b8-5e93-828c-ea933c890feb'],{accountKey:'codex-1',poolKey:'builder'});
});

test('planning refuses ambiguous connection or grant discovery and missing quality evidence', () => {
  const duplicate=rows(); duplicate.push({...duplicate[0],id:'10000000-0000-4000-8000-000000000031'}); assert.throws(()=>buildPoolPlan(registry(),duplicate,verdicts()),/ambiguous/);
  const grant=rows(); grant.push({...grant[0],grantId:'10000000-0000-4000-8000-000000000032'}); assert.throws(()=>buildPoolPlan(registry(),grant,verdicts()),/ambiguous/);
  assert.throws(()=>buildPoolPlan(registry(),rows(),{}),/quality/);
});

test('policy-excluded membership is reported and never included in pools', () => {
  const v=verdicts(); v['claude-1'].builder=false; const result=buildPoolPlan(registry(),rows(),v);
  assert.deepEqual(result.excluded,[{accountKey:'claude-1',poolKey:'builder',reason:'excluded-by-policy'}]);
  assert.equal(result.pools[0].config.members.length,1);
});

test('operator CLI refuses apply without required inputs instead of silently claiming success', async () => {
  const {spawnSync}=await import('node:child_process');
  const r=spawnSync(process.execPath,[new URL('../scripts/generate-pool.mjs',import.meta.url).pathname,'--apply'],{encoding:'utf8'});
  assert.notEqual(r.status,0); assert.match(r.stderr,/refused or failed/i);
});

test('planning rejects connections with missing or non-connected status', () => {
  for (const status of [undefined, 'revoked', 'expired', 'needs_attention']) {
    const discovered = rows(); discovered[0].status = status;
    assert.throws(() => buildPoolPlan(registry(), discovered, verdicts()), /connection.*unavailable/i);
  }
});

test('policy-backed pool planning computes and applies membership floors', async () => {
  const { buildPoolPlanFromPolicy } = await import('../scripts/generate-pool.mjs');
  const result = buildPoolPlanFromPolicy(registry(), rows(), {
    arms:[{armId:'terra',model:'gpt-6.1-terra',family:'terra',qFleet:0.3,qFleetThinker:0.3},
      {armId:'sol',model:'gpt-6.1-sol',family:'sol',qFleet:1,qFleetThinker:1},
      {armId:'weak',model:'model',family:'weak',qFleet:-2,qFleetThinker:-2},
      ...Array.from({length:5},(_,i)=>({armId:`f${i}`,model:`f${i}`,family:`f${i}`,qFleet:1,qFleetThinker:1}))],
    roles:{minQuality:{doer:0,thinker:0.4}},records:[],nowMs:10000,roleOf:()=> 'doer',familyOf:r=>r.family,
  });
  assert.deepEqual(result.excluded,[{accountKey:'claude-1',poolKey:'builder',reason:'excluded-by-policy'}]);
  assert.equal(result.pools[0].config.members.length,1);
});

test('policy planner reports gates suspended to keep a pool serving', async () => {
  const {buildPoolPlanFromPolicy}=await import('../scripts/generate-pool.mjs');
  const r=registry(); r.pools=[{poolKey:'thinker',role:'thinker'}]; r.accounts=[r.accounts[0]]; r.accounts[0].pools={thinker:{model:'gpt-6.1-sol'}};
  const arms=Array.from({length:8},(_,i)=>({armId:`arm${i}`,model:i===0?'gpt-6.1-sol':`other${i}`,family:i===0?'sol':`other${i}`,qFleet:0,qFleetThinker:0}));
  const plan=buildPoolPlanFromPolicy(r,rows(),{arms,records:[],nowMs:1000,roleOf:()=> 'thinker',familyOf:x=>x.family});
  assert.equal(plan.pools[0].config.members.length,1);
  assert.ok(plan.policyReports.thinker.roles.thinker.suspendedGates.includes('quality'));
});

test('generated member identities join callback pools independent of host UUID and display name', async () => {
  const {normalizeRegistry} = await import('../src/registry.mjs');
  const {routeDecision,routerDiagnostics} = await import('../src/router.mjs');
  const {snapshotAccountView} = await import('../src/views.mjs');
  const raw=registry(), normalized=normalizeRegistry(raw), plan=buildPoolPlan(raw,rows(),verdicts());
  assert.deepEqual(plan.memberIndex,normalized.memberIndex);
  const now=Date.parse('2026-10-29T12:00:00Z');
  const account={weeklyUsed:.4,weeklyResetsAtMs:now+72*3600000,quality:'live',observedAtMs:now,credentialReady:true,measuredRatePerHour:.002,eligible:true,inFlightBase:0};
  const accounts=Object.fromEntries(raw.accounts.map(a=>[a.accountKey,{...account,view:snapshotAccountView(a.accountKey,account,{nowMs:now})}]));
  const members=plan.pools[0].config.members;
  const candidates=members.map(member=>({member,runtimeConfig:{model:member.profile.model},notes:[]}));
  const params={pool:{id:'9ae3390d-d254-4542-8a71-029c90a19458',revision:7,pluginKey:'togetherweown.model-capacity',name:'builder',members},candidates,memberOrder:members.map(m=>m.id),taskKey:'work',now:new Date(now).toISOString()};
  const snapshot={atMs:now,accounts,memberIndex:normalized.memberIndex,poolRoles:normalized.poolRoles};
  const config={router:{enabled:true,accounts:normalized.accounts,pools:[{poolKey:'builder',role:'doer',poolId:params.pool.id,pluginKey:params.pool.pluginKey,expectedRevision:7,expectedMemberOrder:[...params.memberOrder],members:members.map(m=>({memberId:m.id,accountKey:normalized.memberIndex[m.id].accountKey,connectionId:m.binding.connectionId,grantId:m.binding.grantId}))}]}};
  const selected=routeDecision(params,snapshot,config);
  assert.equal(selected.kind,'selected');
  params.pool.name='changed-label';
  assert.deepEqual(routeDecision(params,snapshot,config),selected);
  assert.equal(routerDiagnostics(params,snapshot,config).poolNameMismatch,true);
  const thinker=plan.pools[1].config.members[0];
  params.candidates.push({member:thinker,runtimeConfig:{model:thinker.profile.model},notes:[]});
  params.pool.members.push(thinker);
  const conflict=routeDecision(params,snapshot,config);
  assert.equal(routerDiagnostics(params,snapshot,config).level,'error');
  assert.deepEqual(Object.values(conflict.skipped),['unmapped-member','unmapped-member','unmapped-member']);
  params.pool.name='builder'; params.candidates=[]; params.pool.members=[];
  assert.equal(routerDiagnostics(params,snapshot,config).poolKey,'builder');
});
