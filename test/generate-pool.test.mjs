import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPoolPlan } from '../scripts/generate-pool.mjs';

const registry = () => ({companyId:'10000000-0000-4000-8000-000000000001',ownerUserId:'owner',allowMessages:true,pools:[{poolKey:'builder',role:'doer'},{poolKey:'thinker',role:'thinker'}],accounts:[
  {accountKey:'codex-1',prefix:'codex1',provider:'openai',protocol:'responses',harnessProfile:'codex',connectionName:'Codex',pools:{builder:{model:'gpt-6.1-terra'},thinker:{model:'gpt-6.1-sol'}}},
  {accountKey:'claude-1',prefix:'claude1',provider:'anthropic',protocol:'messages',harnessProfile:'acpx',connectionName:'Claude',pools:{builder:{model:'model'}}}
]});
const rows = () => [
  {id:'10000000-0000-4000-8000-000000000011',grantId:'10000000-0000-4000-8000-000000000012',name:'Codex',provider:'openai',method:'api_key',ownership:'shared'},
  {id:'10000000-0000-4000-8000-000000000021',grantId:'10000000-0000-4000-8000-000000000022',name:'Claude',provider:'anthropic',method:'api_key',ownership:'shared'}
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

test('unfinished operator CLI fails closed rather than silently claiming success', async () => {
  const {spawnSync}=await import('node:child_process');
  const r=spawnSync(process.execPath,[new URL('../scripts/generate-pool.mjs',import.meta.url).pathname,'--apply'],{encoding:'utf8'});
  assert.notEqual(r.status,0); assert.match(r.stderr,/not implemented/i);
});
