import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { NativeApi, options, registry, verdicts, companyId, agentId, secondAgent, ownerUserId, originalBinding, scratch } from './support/native-api.mjs';
import { planPoolSaga, applyPoolSaga, checkPoolDrift, rollbackPoolSaga } from '../scripts/pool-saga.mjs';
const copy=x=>structuredClone(x);
const stripRevisions=xs=>xs.map(({revision,...p})=>p).sort((a,b)=>a.name.localeCompare(b.name));

test('U18 dry plan matches committed full native connections/pool SaveInput golden, without writes',async()=>{
  const api=new NativeApi(),plan=await planPoolSaga(options(api));
  const golden=JSON.parse(await readFile(new URL('./fixtures/pool-saga-golden.json',import.meta.url),'utf8'));
  assert.deepEqual({connections:plan.connections,pools:plan.pools},golden);assert.deepEqual(api.writes,[]);
});

test('ambiguous connection IDs or multiple shared summaries abort before writes',async t=>{
  for(const mode of ['connection','grant']) {
    const api=new NativeApi();await applyPoolSaga({...options(api),activate:false,journalPath:await scratch(t)});
    const original=api.listConnections.bind(api);
    api.listConnections=async()=>{const r=await original();r.connections.push({...r.connections[0],...(mode==='connection'?{id:secondAgent}:{grantId:secondAgent})});return r;};
    api.writes=[];await assert.rejects(applyPoolSaga({...options(api),journalPath:await scratch(t)}),/ambiguous/);assert.deepEqual(api.writes,[]);
  }
});

test('failure leaves mode-0600 non-secret journal, exact creations and sanitized pending intents',async t=>{
  const api=new NativeApi();api.fail=type=>type==='pool';const journalPath=await scratch(t);
  await assert.rejects(applyPoolSaga({...options(api),journalPath}),e=>{
    assert.equal(e.journalPath,journalPath);assert.deepEqual(e.orphans.map(o=>o.kind),['connection','connection']);
    assert.deepEqual(e.pendingIntents.map(o=>o.kind),['pool-create']);assert.doesNotMatch(e.message,/PRIVATE_API_ERROR/);return true;
  });
  assert.equal((await stat(journalPath)).mode&0o777,0o600);
  const text=await readFile(journalPath,'utf8');assert.doesNotMatch(text,/apiKey|PRIVATE_API_ERROR/);assert.match(text,/intent/);
  api.fail=null;await rollbackPoolSaga({api,journalPath});assert.equal(api.connections.length,0);assert.equal(api.pools.length,0);
  assert.deepEqual(api.writes.filter(w=>w.type.startsWith('delete')).map(w=>w.type),['deleteConnection','deleteConnection']);
});

test('rollback permits completed never-activated runs, reports secret refs, and is idempotent',async t=>{
  const api=new NativeApi(),journalPath=await scratch(t);
  await applyPoolSaga({...options(api),activate:false,journalPath});const refs=api.connections.map(c=>c.secretId);
  const result=await rollbackPoolSaga({api,journalPath});assert.deepEqual(result.secretRefs.sort(),refs.sort());assert.equal(api.pools.length,0);assert.equal(api.connections.length,0);
  api.writes=[];assert.equal((await rollbackPoolSaga({api,journalPath})).alreadyRolledBack,true);assert.deepEqual(api.writes,[]);
});

test('completed active journal and any concurrent pool revision change refuse rollback before writes',async t=>{
  for(const active of [true,false]) {
    const api=new NativeApi(),journalPath=await scratch(t);await applyPoolSaga({...options(api),activate:active,journalPath});
    if(!active)api.pools[0].revision++;
    api.writes=[];await assert.rejects(rollbackPoolSaga({api,journalPath}),/active|revision/);assert.deepEqual(api.writes,[]);
  }
});

test('rollback validates all records including header, kind and IDs before deleting anything',async t=>{
  const api=new NativeApi(),journalPath=await scratch(t);await applyPoolSaga({...options(api),activate:false,journalPath});
  const text=await readFile(journalPath,'utf8');
  for(const transform of [s=>s.replace('"version":2','"version":1'),s=>s.replace('"kind":"connection-create"','"kind":"unknown"'),s=>s.replace('"type":"complete"','"type":"forged"'),s=>s.replace('"seq":1','"seq":999')]) {
    await writeFile(journalPath,transform(text));api.writes=[];await assert.rejects(rollbackPoolSaga({api,journalPath}));assert.deepEqual(api.writes,[]);
  }
});

test('write-ahead recovery covers lost create, promotion, pool save and binding responses',async t=>{
  for(const type of ['create','patch','pool','bind']) {
    const api=new NativeApi(),journalPath=await scratch(t);let fired=false;
    api.afterWrite=(kind)=>{if(kind===type&&!fired){fired=true;throw new Error('LOST_RESPONSE_SECRET');}};
    await assert.rejects(applyPoolSaga({...options(api),journalPath}),/pool saga failed/);
    assert.ok(fired,type);api.afterWrite=null;
    const result=await rollbackPoolSaga({api,journalPath});assert.equal(result.ok,true,type);
    assert.equal(api.connections.length,0,type);assert.equal(api.pools.length,0,type);
    assert.deepEqual(api.agents.get(agentId).runtimeConfig.aiConnection,originalBinding,type);
    assert.doesNotMatch(await readFile(journalPath,'utf8'),/LOST_RESPONSE_SECRET/);
  }
});

test('a torn last journal receipt is recovered from its durable intent',async t=>{
  const api=new NativeApi(),journalPath=await scratch(t);api.afterWrite=kind=>{if(kind==='create')throw new Error('lost');};
  await assert.rejects(applyPoolSaga({...options(api),journalPath}));api.afterWrite=null;
  await writeFile(journalPath,(await readFile(journalPath,'utf8'))+'{"type":"done","seq":');
  await rollbackPoolSaga({api,journalPath});assert.equal(api.connections.length,0);
  await rollbackPoolSaga({api,journalPath});
});

test('rollback recovers a lost compensation response and resumes remaining inverses',async t=>{
  const api=new NativeApi(),journalPath=await scratch(t);await applyPoolSaga({...options(api),activate:false,journalPath});
  let fired=false;api.afterWrite=kind=>{if(kind==='deletePool'&&!fired){fired=true;throw new Error('lost');}};
  await assert.rejects(rollbackPoolSaga({api,journalPath}));api.afterWrite=null;
  await rollbackPoolSaga({api,journalPath});assert.equal(api.connections.length,0);assert.equal(api.pools.length,0);
});

test('drift check compares activation phase and reports wrong plugin keys, missing and fully excluded pools',async t=>{
  const api=new NativeApi();await applyPoolSaga({...options(api),activate:false,journalPath:await scratch(t)});
  assert.equal((await checkPoolDrift({...options(api),expectedEnabled:false})).ok,true);
  assert.equal((await checkPoolDrift({...options(api),expectedEnabled:true})).ok,false);
  api.pools[0].pluginKey='other';api.pools.pop();api.writes=[];
  const r=await checkPoolDrift({...options(api),expectedEnabled:false});assert.ok(r.drift.some(d=>d.type==='plugin-key-drift'));assert.ok(r.drift.some(d=>d.type==='missing-pool'));assert.deepEqual(api.writes,[]);
  const v=copy(verdicts);v.one.builder=false;v.two.builder=false;
  assert.ok((await checkPoolDrift({...options(api),qualityVerdicts:v,expectedEnabled:false})).drift.some(d=>d.type==='pool-drift'));
});

test('apply refuses fully excluded pools and enabled membership changes before writes',async t=>{
  const api=new NativeApi(),v=copy(verdicts);v.one.builder=false;v.two.builder=false;
  await assert.rejects(applyPoolSaga({...options(api),qualityVerdicts:v,journalPath:await scratch(t)}),/no eligible members/);assert.deepEqual(api.writes,[]);
  await applyPoolSaga({...options(api),journalPath:await scratch(t)});
  const changed=copy(registry);changed.accounts[0].pools.builder.model='next';api.writes=[];
  await assert.rejects(applyPoolSaga({...options(api),registry:changed,journalPath:await scratch(t)}),/disable changed pools/);assert.deepEqual(api.writes,[]);
});

test('adopted pool updates use revisions, and rollback restores adopted configs and installation scope',async t=>{
  const api=new NativeApi();await applyPoolSaga({...options(api),activate:false,journalPath:await scratch(t)});
  api.connections[0].installs=[{targetType:'agent',targetId:agentId}];
  api.pools[0].thresholdPercent=70;const before=copy(api.pools),installs=copy(api.connections[0].installs);
  api.fail=(type,input)=>type==='pool' && input.config.name==='thinker';api.pools[1].thresholdPercent=70;before[1].thresholdPercent=70;
  const journalPath=await scratch(t);await assert.rejects(applyPoolSaga({...options(api),activate:false,journalPath}));api.fail=null;
  await rollbackPoolSaga({api,journalPath});assert.deepEqual(stripRevisions(api.pools),stripRevisions(before));assert.deepEqual(api.connections[0].installs,installs);
  assert.ok(api.writes.filter(w=>w.type==='pool' && w.input.id).every(w=>Number.isInteger(w.input.expectedRevision)));
});

test('restricted audience, unavailable or foreign-owned connections never pass selectable/binding gates',async t=>{
  for(const mode of ['audience','status','owner','install']) {
    const api=new NativeApi();await applyPoolSaga({...options(api),activate:false,journalPath:await scratch(t)});
    if(mode==='audience')api.connections[0].audience=[{subjectType:'user',subjectId:ownerUserId}];
    if(mode==='owner')api.connections[0].createdByUserId=agentId;
    if(mode==='status') {const list=api.listConnections.bind(api);api.listConnections=async()=>{const r=await list();r.connections[0].status='revoked';return r;};}
    if(mode==='install') {api.connections[0].installs=[];api.putInstalls=async()=>{};}
    api.writes=[];await assert.rejects(applyPoolSaga({...options(api),journalPath:await scratch(t)}));
    assert.equal(api.writes.some(w=>w.type==='bind'),false,mode);
  }
});

test('new live sessions after reset or at binding boundary block binding and native rewake',async t=>{
  const api=new NativeApi();const key='issue:10000000-0000-4000-8000-000000000009';api.sessions.set(agentId,[{taskKey:key}]);
  api.resetSession=async()=>{};const journalPath=await scratch(t);
  await assert.rejects(applyPoolSaga({...options(api),sessionPlans:{[agentId]:'reset'},journalPath}));
  assert.equal(api.writes.some(w=>w.type==='bind'||w.type==='wake'),false);
});

test('apply refuses an unbound agent before writes because upstream cannot clear a router binding on rollback',async t=>{
  const api=new NativeApi();delete api.agents.get(agentId).runtimeConfig.aiConnection;
  await assert.rejects(applyPoolSaga({...options(api),journalPath:await scratch(t)}),/reversible.*binding|binding.*reversible/);
  assert.deepEqual(api.writes,[]);
});

test('all lane secret refs are checked before the first mutation, not halfway through connection creation',async t=>{
  const api=new NativeApi();api.assertSecretRefs=()=>{throw new Error('missing secret reference');};
  await assert.rejects(applyPoolSaga({...options(api),activate:false,journalPath:await scratch(t)}),/secret reference/);
  assert.deepEqual(api.writes,[]);
});

test('rollback reauthorizes journal owner against the live board identity before writes',async t=>{
  const api=new NativeApi(),journalPath=await scratch(t);await applyPoolSaga({...options(api),activate:false,journalPath});
  const list=api.listConnections.bind(api);api.listConnections=async()=>({...await list(),currentUserId:agentId});api.writes=[];
  await assert.rejects(rollbackPoolSaga({api,journalPath}),/identity|owner/);assert.deepEqual(api.writes,[]);
});

test('rollback refuses a binding changed by a concurrent operator and preserves all dependencies',async t=>{
  const api=new NativeApi(),journalPath=await scratch(t);api.fail=type=>type==='wake';
  const taskKey='issue:10000000-0000-4000-8000-000000000009';api.sessions.set(agentId,[{taskKey}]);
  await assert.rejects(applyPoolSaga({...options(api),sessionPlans:{[agentId]:'reset'},journalPath}));
  api.agents.get(agentId).runtimeConfig.aiConnection={mode:'router',connectionId:secondAgent};api.writes=[];api.fail=null;
  await assert.rejects(rollbackPoolSaga({api,journalPath}),/conflict/);assert.deepEqual(api.writes,[]);
});

test('completed activated migration can roll back after exactly revisioned native disable and drain',async t=>{
  const api=new NativeApi(),journalPath=await scratch(t);await applyPoolSaga({...options(api),journalPath});
  for(const p of copy(api.pools))await api.savePool({companyId,id:p.id,expectedRevision:p.revision,config:{name:p.name,enabled:false,mode:p.mode,thresholdPercent:p.thresholdPercent,members:p.members}});
  await rollbackPoolSaga({api,journalPath});
  assert.equal(api.pools.length,0);assert.equal(api.connections.length,0);
  assert.deepEqual(api.agents.get(agentId).runtimeConfig.aiConnection,originalBinding);
});

test('resumed compensation still detects unrelated pool revision changes before deleting remaining objects',async t=>{
  const api=new NativeApi(),journalPath=await scratch(t);await applyPoolSaga({...options(api),activate:false,journalPath});
  let fired=false;api.afterWrite=kind=>{if(kind==='deletePool'&&!fired){fired=true;throw new Error('lost');}};
  await assert.rejects(rollbackPoolSaga({api,journalPath}));api.afterWrite=null;
  api.pools[0].revision++;api.writes=[];
  await assert.rejects(rollbackPoolSaga({api,journalPath}),/revision|compensation.*conflict/);
  assert.deepEqual(api.writes,[]);
});

test('secret-ref cleanup evidence survives a lost archive response and repeated rollback',async t=>{
  const api=new NativeApi(),journalPath=await scratch(t);await applyPoolSaga({...options(api),activate:false,journalPath});
  const refs=api.connections.map(c=>c.secretId).sort();let fired=false;
  api.afterWrite=kind=>{if(kind==='deleteConnection'&&!fired){fired=true;throw new Error('lost');}};
  await assert.rejects(rollbackPoolSaga({api,journalPath}));api.afterWrite=null;
  assert.deepEqual((await rollbackPoolSaga({api,journalPath})).secretRefs.sort(),refs);
  assert.deepEqual((await rollbackPoolSaga({api,journalPath})).secretRefs.sort(),refs);
});

test('rollback checks ownership of a created connection even when later name promotions share its state key',async t=>{
  const api=new NativeApi(),journalPath=await scratch(t);await applyPoolSaga({...options(api),activate:false,journalPath});
  api.connections[0].createdByUserId=agentId;api.writes=[];
  await assert.rejects(rollbackPoolSaga({api,journalPath}),/connection changed|ownership/);assert.deepEqual(api.writes,[]);
});

test('rollback refuses to remove a created connection now referenced by an unrelated live pool',async t=>{
  const api=new NativeApi(),journalPath=await scratch(t);await applyPoolSaga({...options(api),activate:false,journalPath});
  api.pools.push({...copy(api.pools[0]),id:secondAgent,name:'unrelated',enabled:true});api.writes=[];
  await assert.rejects(rollbackPoolSaga({api,journalPath}),/external|unrelated|reference/);assert.deepEqual(api.writes,[]);
});

test('even a staged batch must be session-free at rollback, before removing connection installs',async t=>{
  const api=new NativeApi(),journalPath=await scratch(t);await applyPoolSaga({...options(api),activate:false,journalPath});
  api.sessions.set(agentId,[{taskKey:'issue:10000000-0000-4000-8000-000000000009'}]);api.writes=[];
  await assert.rejects(rollbackPoolSaga({api,journalPath}),/session/);assert.deepEqual(api.writes,[]);
});

test('grant ambiguity includes organization grants hidden from the AI summary by their human audience',async t=>{
  const api=new NativeApi();await applyPoolSaga({...options(api),activate:false,journalPath:await scratch(t)});
  const get=api.getGrants.bind(api);api.getGrants=async id=>{const r=await get(id);r.grants.push({...copy(r.grants[0]),id:secondAgent,members:[{subjectType:'user',subjectId:secondAgent}]});return r;};
  api.writes=[];await assert.rejects(applyPoolSaga({...options(api),journalPath:await scratch(t)}),/ambiguous/);assert.deepEqual(api.writes,[]);
});

test('fleet-wide staged installs still retain batch session gates during rollback',async t=>{
  const api=new NativeApi(),journalPath=await scratch(t);await applyPoolSaga({...options(api),allAgents:true,allAgentsApproved:true,activate:false,journalPath});
  api.sessions.set(agentId,[{taskKey:'issue:10000000-0000-4000-8000-000000000009'}]);api.writes=[];
  await assert.rejects(rollbackPoolSaga({api,journalPath}),/session/);assert.deepEqual(api.writes,[]);
});
