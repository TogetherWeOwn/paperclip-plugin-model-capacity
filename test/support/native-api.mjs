import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const companyId='10000000-0000-4000-8000-000000000001';
export const ownerUserId='20000000-0000-4000-8000-000000000002';
export const agentId='30000000-0000-4000-8000-000000000003';
export const originalBinding={mode:'responsible_user',provider:'openai'};
export const secondAgent='30000000-0000-4000-8000-000000000004';
export const registry={companyId,ownerUserId,allowMessages:true,pools:[{poolKey:'builder',role:'doer'},{poolKey:'thinker',role:'thinker'}],accounts:[
  {accountKey:'one',prefix:'one',connectionName:'One',provider:'openai',protocol:'responses',harnessProfile:'codex',pools:{builder:{model:'terra'},thinker:{model:'sol'}}},
  {accountKey:'two',prefix:'two',connectionName:'Two',provider:'anthropic',protocol:'messages',harnessProfile:'acpx',pools:{builder:{model:'claude'}}},
]};
export const verdicts={one:{builder:true,thinker:true},two:{builder:true}};
export const batch={builder:[agentId],thinker:[secondAgent]};
export const baseUrl='https://gateway.example/v1';
const copy=x=>structuredClone(x);
let next=100;
const uuid=()=>`40000000-0000-4000-8000-${String(++next).padStart(12,'0')}`;

// The double models the actual HTTP service: POST creates grant+installs inline,
// summaries contain grantId, config is immutable for AI PATCH/reconnect, installs
// are replaced, and pool saves use optimistic revisions. No invented grant API.
export class NativeApi {
  connections=[]; pools=[]; writes=[]; reads=[]; agents=new Map(); sessions=new Map(); fail; afterWrite;
  constructor() { for(const id of [agentId,secondAgent]) { this.agents.set(id,{id,companyId,adapterType:'paperclip_runner',status:'idle',configurationRevision:'a'.repeat(64),runtimeConfig:{unrelated:true,aiConnection:copy(originalBinding)}}); this.sessions.set(id,[]); } }
  async mutate(type,action,input) { this.writes.push({type,input:copy(input)}); if(this.fail?.(type,input)) throw new Error('PRIVATE_API_ERROR'); const result=action(); await this.afterWrite?.(type,input,result); return copy(result); }
  async listConnections() { this.reads.push('connections'); return {currentUserId:ownerUserId,canManageConnections:true,connections:this.connections.filter(c=>c.enabled && c.status!=='archived').map(c=>({id:c.id,grantId:c.grantId,companyId,name:c.name,provider:c.provider,method:'api_key',ownership:'shared',status:'connected',routing:c.routing}))}; }
  async getConnection(id) { this.reads.push('detail'); return copy(this.connections.find(c=>c.id===id)??null); }
  async getGrants(id) { const c=this.connections.find(c=>c.id===id); return {grants:c?[{id:c.grantId,connectionId:id,companyId,kind:'organization',status:'active',createdByUserId:ownerUserId,members:c.audience??[],credentialSecretRefs:[{secretId:c.secretId,configPath:'ai.credential'}]}]:[]}; }
  async getInstalls(id) { return copy(this.connections.find(c=>c.id===id)?.installs??[]); }
  async listPools() { this.reads.push('pools'); return copy(this.pools); }
  async getAgent(id) { this.reads.push('agent'); return copy(this.agents.get(id)); }
  async listSessions(id) { this.reads.push('sessions'); return copy(this.sessions.get(id)); }
  async createConnection(input,accountKey) { return this.mutate('create',()=>{ const c={...copy(input),id:uuid(),grantId:uuid(),secretId:uuid(),companyId,createdByUserId:ownerUserId,enabled:true,status:'active',healthStatus:'ok',installs:input.allAgents?[{targetType:'company',targetId:companyId}]:input.agentIds.map(targetId=>({targetType:'agent',targetId}))}; this.connections.push(c); return {connectionId:c.id,grantId:c.grantId}; },{...input,accountKey}); }
  async updateConnection(id,input) { assert.equal(input.config,undefined,'upstream forbids AI config PATCH'); assert.equal(input.routing,undefined,'upstream forbids routing PATCH'); return this.mutate('patch',()=>{const c=this.connections.find(c=>c.id===id); Object.assign(c,copy(input));return c;},{id,...input}); }
  async putInstalls(id,installs) { return this.mutate('installs',()=>{this.connections.find(c=>c.id===id).installs=copy(installs);return {};},{id,installs}); }
  async savePool(input) { return this.mutate('pool',()=>{const old=this.pools.find(p=>p.id===input.id); if(input.id) {assert.ok(old);assert.equal(input.expectedRevision,old.revision);} const row={...copy(input.config),id:old?.id??uuid(),companyId,pluginKey:'togetherweown.model-capacity',revision:(old?.revision??0)+1};this.pools=this.pools.filter(p=>p.id!==row.id);this.pools.push(row);return row;},input); }
  async deletePool(id,revision) { return this.mutate('deletePool',()=>{assert.equal(this.pools.find(p=>p.id===id).revision,revision);this.pools=this.pools.filter(p=>p.id!==id);return {};},{id,revision}); }
  async deleteConnection(id) { return this.mutate('deleteConnection',()=>{this.connections=this.connections.filter(c=>c.id!==id);return {};},{id}); }
  async bindAgent(id,binding) { return this.mutate('bind',()=>{const a=this.agents.get(id); if(binding===null) delete a.runtimeConfig.aiConnection; else a.runtimeConfig.aiConnection=copy(binding);return {};},{id,binding}); }
  async resetSession(id,taskKey) { return this.mutate('reset',()=>{this.sessions.set(id,this.sessions.get(id).filter(s=>s.taskKey!==taskKey));return {};},{id,taskKey}); }
  async wakeAgent(id,input) { return this.mutate('wake',()=>({}),{id,...input}); }
}
export const options=api=>({api,registry,qualityVerdicts:verdicts,batch,baseUrl,sessionPlans:{}});
export async function scratch(t) { const dir=await mkdtemp(join(tmpdir(),'native-pool-'));t.after(()=>rm(dir,{recursive:true,force:true}));return join(dir,'journal.jsonl'); }

