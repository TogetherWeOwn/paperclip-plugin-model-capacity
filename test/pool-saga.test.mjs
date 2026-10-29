import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as generator from '../scripts/generate-pool.mjs';

const companyId = '10000000-0000-4000-8000-000000000001';
const registry = {companyId,ownerUserId:'owner',pools:[{poolKey:'builder',role:'doer'}],accounts:[{accountKey:'one',prefix:'one',provider:'openai',protocol:'responses',harnessProfile:'codex',connectionName:'One',pools:{builder:{model:'model'}}}]};
const verdicts = {one:{builder:true}};
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
class FakeApi {
  connections=[]; grants=[]; pools=[]; writes=[]; failPool=false;
  async listConnections() { return structuredClone(this.connections); }
  async listGrants(connectionId) { return structuredClone(this.grants.filter(g => g.connectionId === connectionId)); }
  async listPools() { return structuredClone(this.pools); }
  async createConnection(input) { this.writes.push('connection'); const row={...input,id:id(11),status:'connected'}; this.connections.push(row); return structuredClone(row); }
  async createGrant(input) { this.writes.push('grant'); const row={...input,id:id(12)}; this.grants.push(row); return structuredClone(row); }
  async savePool(input) { this.writes.push('pool'); if(this.failPool) throw new Error('injected failure'); const existing=this.pools.find(p=>p.id===input.id); if(existing) assert.equal(input.expectedRevision,existing.revision); const row={...input.config,companyId,pluginKey:'togetherweown.model-capacity',id:input.id??id(13),revision:(existing?.revision??0)+1}; this.pools=this.pools.filter(p=>p.id!==row.id); this.pools.push(row); return structuredClone(row); }
  async deletePool(poolId,revision) { this.writes.push('deletePool'); const p=this.pools.find(p=>p.id===poolId); assert.equal(p.revision,revision); this.pools=this.pools.filter(x=>x.id!==poolId); }
  async deleteGrant(grantId) { this.writes.push('deleteGrant'); this.grants=this.grants.filter(x=>x.id!==grantId); }
  async deleteConnection(connectionId) { this.writes.push('deleteConnection'); this.connections=this.connections.filter(x=>x.id!==connectionId); }
}
async function scratch(t) { const dir=await mkdtemp(join(tmpdir(),'pool-saga-test-')); t.after(()=>rm(dir,{recursive:true,force:true})); return join(dir,'journal.jsonl'); }

test('fake API apply discovers and adopts objects and unchanged rerun performs no writes', async t => {
  assert.equal(typeof generator.applyPoolSaga,'function');
  const api=new FakeApi();
  await generator.applyPoolSaga({api,registry,qualityVerdicts:verdicts,journalPath:await scratch(t)});
  assert.deepEqual(api.connections[0].routing.models,['one/model']);
  assert.equal(api.pools[0].enabled,false);
  api.writes=[];
  await generator.applyPoolSaga({api,registry,qualityVerdicts:verdicts,journalPath:await scratch(t)});
  assert.deepEqual(api.writes,[]);
});

test('ambiguous discovered connection or shared grant aborts before any writes', async t => {
  assert.equal(typeof generator.applyPoolSaga,'function');
  for (const ambiguity of ['connection','grant']) {
    const api=new FakeApi(); api.connections=[{id:id(11),name:'One',status:'connected',provider:'openai',method:'api_key',routing:{models:['one/model']}}];
    api.grants=[{id:id(12),connectionId:id(11),mode:'shared',provider:'openai',method:'api_key'}];
    if (ambiguity==='connection') api.connections.push({...api.connections[0],id:id(21)});
    else api.grants.push({...api.grants[0],id:id(22)});
    await assert.rejects(generator.applyPoolSaga({api,registry,qualityVerdicts:verdicts,journalPath:await scratch(t)}),/ambiguous/i);
    assert.deepEqual(api.writes,[]);
  }
});

test('a failed pool save leaves a non-secret journal and rollback removes only created objects', async t => {
  assert.equal(typeof generator.applyPoolSaga,'function');
  const api=new FakeApi(); api.failPool=true;
  const journalPath=await scratch(t);
  await assert.rejects(generator.applyPoolSaga({api,registry,qualityVerdicts:verdicts,journalPath}),/pool saga failed/);
  const journal=await readFile(journalPath,'utf8');
  assert.match(journal,/connection/); assert.match(journal,/grant/); assert.doesNotMatch(journal,/apiKey/);
  api.connections.push({id:id(99),name:'unrelated'});
  await generator.rollbackPoolSaga({api,journalPath});
  assert.deepEqual(api.writes.slice(-2),['deleteGrant','deleteConnection']);
  assert.deepEqual(api.connections.map(c=>c.id),[id(99)]);
});

test('read-only drift detection reports dropped members without writing', async t => {
  assert.equal(typeof generator.checkPoolDrift,'function');
  const api=new FakeApi(); await generator.applyPoolSaga({api,registry,qualityVerdicts:verdicts,journalPath:await scratch(t)});
  api.pools[0].members=[]; api.writes=[];
  const result=await generator.checkPoolDrift({api,registry,qualityVerdicts:verdicts});
  assert.equal(result.ok,false); assert.ok(result.drift.some(d=>d.type==='missing-member' && d.poolKey==='builder'));
  assert.deepEqual(api.writes,[]);
});

test('rollback validates the entire journal before deleting any object', async t => {
  const {writeFile}=await import('node:fs/promises');
  const api=new FakeApi(), journalPath=await scratch(t);
  api.connections=[{id:id(11),name:'One'}];
  // A malformed older entry must not cause the later valid entry to be deleted.
  await writeFile(journalPath,[{type:'header',version:1,companyId},{type:'created',kind:'unknown',id:id(12)},{type:'created',kind:'connection',id:id(11)}].map(x=>JSON.stringify(x)).join('\n')+'\n');
  await assert.rejects(generator.rollbackPoolSaga({api,journalPath}),/invalid journal/);
  assert.deepEqual(api.writes,[]);
});

test('failure reports the journal and exact created orphan set without leaking API error text', async t => {
  const api=new FakeApi(); api.failPool=true;
  const journalPath=await scratch(t);
  await assert.rejects(generator.applyPoolSaga({api,registry,qualityVerdicts:verdicts,journalPath}),error=>{
    assert.equal(error.journalPath,journalPath);
    assert.deepEqual(error.orphans.map(x=>x.kind),['connection','grant']);
    assert.doesNotMatch(error.message,/injected failure/);
    return true;
  });
});

test('dry plan emits connection model set and pool SaveInput matching the golden fixture without writes', async () => {
  assert.equal(typeof generator.planPoolSaga,'function');
  const api=new FakeApi();
  api.connections=[{id:id(11),name:'One',status:'connected',provider:'openai',method:'api_key',routing:{models:['one/model']}}];
  api.grants=[{id:id(12),connectionId:id(11),mode:'shared',provider:'openai',method:'api_key'}];
  const plan=await generator.planPoolSaga({api,registry,qualityVerdicts:verdicts});
  const golden=JSON.parse(await readFile(new URL('./fixtures/pool-saga-golden.json',import.meta.url),'utf8'));
  assert.deepEqual(plan.connections,[golden.connection]); assert.deepEqual(plan.pools,[golden.pool]);
  assert.deepEqual(api.writes,[]);
});

test('updates an adopted disabled pool with expectedRevision without marking it as an orphan', async t => {
  const api=new FakeApi();
  await generator.applyPoolSaga({api,registry,qualityVerdicts:verdicts,journalPath:await scratch(t)});
  api.pools[0].members=[]; const journalPath=await scratch(t); api.writes=[];
  await generator.applyPoolSaga({api,registry,qualityVerdicts:verdicts,journalPath});
  assert.deepEqual(api.writes,['pool']); assert.equal(api.pools[0].revision,2);
  const journal=await readFile(journalPath,'utf8'); assert.doesNotMatch(journal,/"kind":"pool"/);
  await generator.rollbackPoolSaga({api,journalPath}); assert.equal(api.pools.length,1);
});

test('refuses to update an enabled pool with drift', async t => {
  const api=new FakeApi();
  await generator.applyPoolSaga({api,registry,qualityVerdicts:verdicts,journalPath:await scratch(t)});
  api.pools[0].enabled=true; api.pools[0].members=[]; api.writes=[];
  await assert.rejects(generator.applyPoolSaga({api,registry,qualityVerdicts:verdicts,journalPath:await scratch(t)}));
  assert.deepEqual(api.writes,[]);
});
