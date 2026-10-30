import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAiConnectionSchema } from './fixtures/upstream-schemas/ai-connections.js';
import { aiConnectionPoolConfigSchema } from './fixtures/upstream-schemas/ai-connection-router.js';
import { NativeApi, registry, batch, companyId, ownerUserId, agentId, originalBinding } from './support/native-api.mjs';
import { parseUpstreamWrite } from './support/upstream-http-schema.mjs';
const exec=promisify(execFile),script=new URL('../scripts/generate-pool.mjs',import.meta.url).pathname;
const saveSchema=z.object({pluginKey:z.literal('togetherweown.model-capacity'),id:z.string().uuid().optional(),expectedRevision:z.number().int().positive().optional(),config:aiConnectionPoolConfigSchema}).strict();

async function fixture(t) {
  const api=new NativeApi(),requests=[],errors=[];
  const dir=await mkdtemp(join(tmpdir(),'pool-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const [name,value] of Object.entries({registry,batch:{pools:batch,sessionPlans:{}},quality:{arms:['terra','sol','claude'].map(model=>({model,armId:model,family:model,qFleet:1,qFleetThinker:1})),records:[],roles:{}},refs:{one:{env:'LANE_ONE'},two:{env:'LANE_TWO'}}}))await writeFile(join(dir,`${name}.json`),JSON.stringify(value));
  const server=createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part;
    try {
      assert.equal(req.headers.authorization,'Bearer BOARD_DUMMY');
      const input=body?JSON.parse(body):undefined,path=new URL(req.url,'http://localhost').pathname;
      requests.push({method:req.method,path,input});parseUpstreamWrite(req.method,path,input);let out;
      const tail=path.replace(`/api/companies/${companyId}`,'');
      if(req.method==='GET'&&tail==='/ai-connections')out=await api.listConnections();
      else if(req.method==='GET'&&tail==='/ai-connection-pools')out=await api.listPools();
      else if(req.method==='POST'&&tail==='/ai-connections') {const b=createAiConnectionSchema.parse(input);assert.ok(['DUMMY_ONE','DUMMY_TWO'].includes(b.apiKey));const {apiKey,...safe}=b;out=await api.createConnection(safe);}
      else if(req.method==='POST'&&tail==='/ai-connection-pools') {const b=saveSchema.parse(input);out=await api.savePool({companyId,...b});}
      else if(req.method==='DELETE'&&tail.startsWith('/ai-connection-pools/'))out=await api.deletePool(tail.split('/').at(-1),input.expectedRevision);
      else if(path.startsWith('/api/tool-connections/')) {
        const [, , ,id,sub]=path.split('/');
        if(req.method==='GET'&&!sub) {const c=await api.getConnection(id);if(!c){res.writeHead(404).end('{}');return;}out={...c,config:{ai:{provider:c.provider,method:'api_key',routing:c.routing}}};}
        else if(req.method==='GET'&&sub==='grants')out=await api.getGrants(id);
        else if(req.method==='GET'&&sub==='installs')out={installs:await api.getInstalls(id)};
        else if(req.method==='PUT'&&sub==='installs')out=await api.putInstalls(id,input.installs);
        else if(req.method==='PATCH'&&!sub)out=await api.updateConnection(id,input);
        else if(req.method==='DELETE'&&!sub)out=await api.deleteConnection(id);
        else throw new Error('unrecognized generic route');
      } else if(path.startsWith('/api/agents/')) {
        const [, , ,id,sub]=path.split('/');
        if(req.method==='GET'&&!sub)out=await api.getAgent(id);
        else if(req.method==='GET'&&sub==='configuration')out=await api.getAgentConfiguration(id);
        else if(req.method==='GET'&&sub==='task-sessions')out=await api.listSessions(id);
        else if(req.method==='POST'&&sub==='runtime-state')out=await api.resetSession(id,input.taskKey);
        else if(req.method==='POST'&&sub==='wakeup')out=await api.wakeAgent(id,input);
        else if(req.method==='PATCH'&&!sub) {assert.deepEqual(Object.keys(input).sort(),['expectedConfigurationRevision','runtimeConfig']);assert.equal(input.expectedConfigurationRevision,'a'.repeat(64));out=await api.bindAgent(id,input.runtimeConfig.aiConnection??null);}
        else throw new Error('unrecognized agent route');
      } else throw new Error('unrecognized route');
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(out??{}));
    } catch(e) {errors.push(e);res.writeHead(422,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'SECRET_PROVIDER_ECHO'}));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const target=`http://127.0.0.1:${server.address().port}`;
  const args=['--registry',join(dir,'registry.json'),'--batch',join(dir,'batch.json'),'--quality-evidence',join(dir,'quality.json'),'--target',target,'--gateway-base-url','https://gateway.example/v1'];
  const run=async(extra=[])=>exec(process.execPath,[script,...args,...extra],{env:{...process.env,PAPERCLIP_BOARD_TOKEN:'BOARD_DUMMY',LANE_ONE:'DUMMY_ONE',LANE_TWO:'DUMMY_TWO'},maxBuffer:4*1024*1024});
  return {api,run,dir,requests,errors};
}

test('operator CLI defaults to dry-run: complete member JSON, selectable verdicts and session blockers, exit 0, zero writes',async t=>{
  const f=await fixture(t);f.api.sessions.set(agentId,[{taskKey:'issue:10000000-0000-4000-8000-000000000009'}]);
  const before=await readdir(f.dir),{stdout,stderr}=await f.run(),plan=JSON.parse(stdout);
  assert.equal(stderr,'');assert.equal(plan.pools.length,2);assert.equal(plan.pools[0].config.members[1].profile.acpxAgent,'claude');assert.equal(plan.selectableVerdicts.length,3);assert.equal(plan.sessionBlockers.length,1);
  assert.deepEqual(f.api.writes,[]);assert.ok(f.requests.every(r=>r.method==='GET'));assert.deepEqual(await readdir(f.dir),before);
  assert.doesNotMatch(stdout,/BOARD_DUMMY|DUMMY_ONE|DUMMY_TWO|SECRET_PROVIDER_ECHO|sessionParamsJson/);assert.deepEqual(f.errors,[]);
});

test('CLI saves registry effort without issue overrides and detects lost or edited effort as read-only drift',async t=>{
  const f=await fixture(t),raw=structuredClone(registry);
  for(const account of raw.accounts)for(const membership of Object.values(account.pools))membership.effort='high';
  await writeFile(join(f.dir,'registry.json'),JSON.stringify(raw));
  await writeFile(join(f.dir,'quality.json'),JSON.stringify({arms:['terra','sol','claude'].map(model=>({model,armId:`${model}-high`,effort:'high',family:model,qFleet:1,qFleetThinker:1})),records:[],roles:{}}));
  const dry=JSON.parse((await f.run()).stdout);
  for(const pool of dry.pools)for(const member of pool.config.members)assert.equal(member.profile.effort,'high');
  assert.deepEqual(f.api.writes,[]);
  const apply=journal=>f.run(['--apply','--keep-disabled','--secret-refs',join(f.dir,'refs.json'),'--journal',join(f.dir,journal)]);
  await apply('effort.jsonl');
  assert.equal(JSON.parse((await f.run(['--check','--keep-disabled'])).stdout).ok,true);
  for(const mutate of [m=>{delete m.profile.effort;},m=>{m.profile.effort='low';}]) {
    mutate(f.api.pools.find(p=>p.name==='builder').members[0]);f.api.writes=[];
    await assert.rejects(f.run(['--check','--keep-disabled']),e=>{
      assert.equal(e.code,2);assert.ok(JSON.parse(e.stdout).drift.some(d=>d.type==='pool-drift'&&d.poolKey==='builder'));return true;
    });
    assert.deepEqual(f.api.writes,[]);
    await apply(`repair-${f.requests.length}.jsonl`);
    assert.equal(f.api.pools.find(p=>p.name==='builder').members[0].profile.effort,'high');
  }
  f.api.writes=[];await apply('effort-repeat.jsonl');assert.deepEqual(f.api.writes,[]);
  assert.equal(JSON.parse((await f.run(['--check','--keep-disabled'])).stdout).ok,true);
  assert.deepEqual(f.errors,[]);
});

test('operator --apply, idempotent rerun, R9 --check drift and --rollback use only real upstream HTTP shapes',async t=>{
  const f=await fixture(t),journal=join(f.dir,'journal.jsonl');
  await f.run(['--apply','--keep-disabled','--secret-refs',join(f.dir,'refs.json'),'--journal',journal]);
  assert.equal(f.api.connections.length,2);assert.equal(f.api.pools.length,2);assert.ok(f.api.pools.every(p=>!p.enabled));
  f.api.writes=[];await f.run(['--apply','--keep-disabled','--secret-refs',join(f.dir,'refs.json'),'--journal',join(f.dir,'repeat.jsonl')]);assert.deepEqual(f.api.writes,[]);
  const clean=JSON.parse((await f.run(['--check','--keep-disabled'])).stdout);assert.equal(clean.ok,true);
  const old=f.api.pools[0].members.pop();await assert.rejects(f.run(['--check','--keep-disabled']),e=>{assert.equal(e.code,2);const r=JSON.parse(e.stdout);assert.ok(r.drift.some(d=>d.type==='missing-member'));return true;});f.api.pools[0].members.push(old);
  const rolled=JSON.parse((await f.run(['--rollback',journal])).stdout);assert.equal(rolled.ok,true);assert.equal(f.api.pools.length,0);assert.equal(f.api.connections.length,0);assert.deepEqual(f.errors,[]);
});

test('CLI refuses missing env auth, unknown argv and apply without journal before writes',async t=>{
  const f=await fixture(t);
  await assert.rejects(exec(process.execPath,[script,'--not-a-real-flag'],{env:{}}));
  await assert.rejects(f.run(['--apply']),e=>{assert.doesNotMatch(e.stderr,/BOARD_DUMMY|DUMMY_ONE/);return true;});
  assert.deepEqual(f.api.writes,[]);
});

test('HTTP apply activates, resets only approved sessions, preserves unrelated agent fields and wakes exact issues',async t=>{
  const f=await fixture(t),taskKey='issue:10000000-0000-4000-8000-000000000009';
  f.api.sessions.set(agentId,[{taskKey}]);
  await writeFile(join(f.dir,'batch.json'),JSON.stringify({pools:batch,sessionPlans:{[agentId]:'reset'}}));
  const {stdout}=await f.run(['--apply','--secret-refs',join(f.dir,'refs.json'),'--journal',join(f.dir,'active.jsonl')]);
  assert.equal(JSON.parse(stdout).enabled,true);assert.ok(f.api.pools.every(p=>p.enabled));
  assert.equal(f.api.agents.get(agentId).runtimeConfig.unrelated,true);
  assert.equal(Object.hasOwn(await f.api.getAgent(agentId),'configurationRevision'),false);
  assert.ok(f.requests.some(r=>r.method==='GET'&&r.path.endsWith('/configuration')));
  const wake=f.requests.find(r=>r.path.endsWith('/wakeup'));assert.equal(wake.input.payload.issueId,taskKey.slice(6));
  const reset=f.requests.find(r=>r.path.endsWith('/runtime-state/reset-session'));assert.deepEqual(reset.input,{taskKey});
  assert.equal(f.requests.some(r=>r.path.includes('comment')),false);assert.deepEqual(f.errors,[]);
  // Native drain/disable is required before compensating a completed migration.
  for(const pool of [...f.api.pools])await f.api.savePool({companyId,id:pool.id,expectedRevision:pool.revision,config:{name:pool.name,enabled:false,mode:pool.mode,thresholdPercent:pool.thresholdPercent,members:pool.members}});
  await f.run(['--rollback',join(f.dir,'active.jsonl')]);
  assert.deepEqual(f.api.agents.get(agentId).runtimeConfig.aiConnection,originalBinding);
  assert.equal(f.api.agents.get(agentId).runtimeConfig.unrelated,true);
  assert.deepEqual(f.errors,[]);
  assert.equal(f.api.connections.length,0);assert.equal(f.api.pools.length,0);
});

test('mapping caches reverify connection AND grant IDs; a deleted mapping is never written to',async t=>{
  const f=await fixture(t),journal=join(f.dir,'mapped.jsonl');
  await f.run(['--apply','--keep-disabled','--secret-refs',join(f.dir,'refs.json'),'--journal',journal]);
  const gone=f.api.connections[0].id;f.api.connections.splice(0,1);f.api.writes=[];
  const result=JSON.parse((await f.run(['--dry-run','--mapping-journal',journal])).stdout);
  assert.deepEqual(result.mappingCache.stale,['one']);assert.deepEqual(result.mappingCache.verified,['two']);
  assert.equal(result.connections[0].action,'create');assert.notEqual(result.pools[0].config.members[0].binding.connectionId,gone);
  assert.deepEqual(f.api.writes,[]);
});
