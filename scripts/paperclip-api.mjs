/** Value-free operator client, grounded in upstream e2cfdc7e:
 * server/src/routes/ai-connections.ts (list/create/save/delete pool)
 * server/src/routes/tool-access.ts (get/grants/installs/name-only patch/archive)
 * server/src/routes/agents.ts (get/patch/task-sessions/reset-session/wakeup).
 * No imaginary grant-creation route and no reconnect with altered routing.
 */
import { PLUGIN_KEY } from '../src/registry.mjs';
import { equal, reversibleBinding } from './generator-safety.mjs';
const uuid=id=>typeof id==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
function id(value) {if(!uuid(value))throw new Error('invalid host object ID');return value;}
export function createPaperclipApi({target,companyId,token,secretRefs={},env=process.env,fetchImpl=globalThis.fetch}) {
  id(companyId);
  let url;
  try {
    url=new URL(target);
    if(url.username||url.password||url.search||url.hash||!['/','/api','/api/'].includes(url.pathname)||(url.protocol!=='https:' && !(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new Error();
  } catch {throw new Error('target must be an HTTPS or loopback Paperclip URL without credentials');}
  if(typeof token!=='string'||!token.trim()||token!==token.trim()||/[\r\n]/.test(token))throw new Error('board auth is required from environment');
  const root=`${url.origin}/api`;
  const company=`/companies/${companyId}`;
  async function request(method,path,body,{missing=false}={}) {
    let response;
    try {response=await fetchImpl(root+path,{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(30000)});} catch {throw new Error('Paperclip request failed; response/credentials suppressed');}
    if(missing && response.status===404)return null;
    if(!response.ok)throw new Error(`Paperclip request rejected (HTTP ${response.status}); response suppressed`);
    if(response.status===204)return null;
    try {return await response.json();}catch {throw new Error('invalid Paperclip JSON response');}
  }
  function laneKey(accountKey) {
    const ref=Object.hasOwn(secretRefs,accountKey)?secretRefs[accountKey]:null;
    // This client resolves ENV REFERENCES ONLY; no values, arbitrary files or
    // secret read endpoints in its JSON inputs. A provider may inject a secret
    // into the named environment variable before invoking the operator CLI.
    if(!ref || Object.keys(ref).length!==1 || typeof ref.env!=='string' || !/^[A-Z_][A-Z0-9_]*$/.test(ref.env))throw new Error('missing or invalid lane secret reference');
    const value=Object.hasOwn(env,ref.env)?env[ref.env]:null;
    if(typeof value!=='string'||!value.trim()||value.length>32768)throw new Error('lane secret reference did not resolve');
    return value;
  }
  return {
    target:url.origin,
    assertSecretRefs(accountKeys) {for(const accountKey of accountKeys)laneKey(accountKey);},
    async listConnections(cid) {if(cid!==companyId)throw new Error('company mismatch');return request('GET',`${company}/ai-connections`);},
    async listPools(cid) {if(cid!==companyId)throw new Error('company mismatch');return request('GET',`${company}/ai-connection-pools`);},
    async getConnection(connectionId) {
      const c=await request('GET',`/tool-connections/${id(connectionId)}`,undefined,{missing:true});
      if(!c)return null;
      // Project exactly the fields needed by discovery/recovery. Never retain
      // arbitrary config, headers, credential values or transport settings.
      const ai=c.config?.ai??{};
      return {id:c.id,companyId:c.companyId,name:c.name,enabled:c.enabled,status:c.status,healthStatus:c.healthStatus,createdByUserId:c.createdByUserId,provider:ai.provider,method:ai.method,routing:ai.routing};
    },
    async getGrants(connectionId) {
      const r=await request('GET',`/tool-connections/${id(connectionId)}/grants`);
      if(!Array.isArray(r.grants))throw new Error('invalid grants response');
      return {grants:r.grants.map(g=>({id:g.id,connectionId:g.connectionId,companyId:g.companyId,kind:g.kind,status:g.status,createdByUserId:g.createdByUserId,members:Array.isArray(g.members)?g.members.map(m=>({subjectType:m.subjectType,subjectId:m.subjectId})):null,credentialSecretRefs:(g.credentialSecretRefs??[]).map(ref=>({secretId:ref.secretId,configPath:ref.configPath}))}))};
    },
    async getInstalls(connectionId) {const r=await request('GET',`/tool-connections/${id(connectionId)}/installs`);if(!Array.isArray(r.installs))throw new Error('invalid installs response');return r.installs.map(({targetType,targetId})=>({targetType,targetId}));},
    async createConnection(inputWithoutSecret,accountKey) {if(Object.hasOwn(inputWithoutSecret,'apiKey'))throw new Error('secret-bearing plans are forbidden');return request('POST',`${company}/ai-connections`,{...inputWithoutSecret,apiKey:laneKey(accountKey)});},
    async updateConnection(connectionId,input) {if(Object.keys(input).some(k=>!['name','enabled'].includes(k)))throw new Error('only connection name/enabled updates are supported');return request('PATCH',`/tool-connections/${id(connectionId)}`,input);},
    async putInstalls(connectionId,installs) {return request('PUT',`/tool-connections/${id(connectionId)}/installs`,{installs});},
    async savePool({companyId:cid,id:poolId,expectedRevision,config}) {if(cid!==companyId)throw new Error('company mismatch');return request('POST',`${company}/ai-connection-pools`,{pluginKey:PLUGIN_KEY,...(poolId?{id:id(poolId),expectedRevision}:{}),config});},
    async deletePool(poolId,expectedRevision) {return request('DELETE',`${company}/ai-connection-pools/${id(poolId)}`,{expectedRevision});},
    async deleteConnection(connectionId) {return request('DELETE',`/tool-connections/${id(connectionId)}`);},
    async listAgents(cid) {if(cid!==companyId)throw new Error('company mismatch');return request('GET',`${company}/agents`);},
    async getAgent(agentId) {return request('GET',`/agents/${id(agentId)}`);},
    async listSessions(agentId) {const rows=await request('GET',`/agents/${id(agentId)}/task-sessions`);if(!Array.isArray(rows))throw new Error('invalid session list');return rows.map(({taskKey})=>({taskKey}));},
    async resetSession(agentId,taskKey) {return request('POST',`/agents/${id(agentId)}/runtime-state/reset-session`,{taskKey});},
    async bindAgent(agentId,binding,expectedBinding) {
      if(!reversibleBinding(binding))throw new Error('no reversible native binding update for an absent binding');
      // agents.ts:4162 exposes the HMAC revision only on /configuration.
      // PATCH restoration (:5420) compares against that redacted display, so
      // the runtimeConfig base MUST come from the same response as its revision.
      const a=await request('GET',`/agents/${id(agentId)}/configuration`);
      if(a.companyId!==companyId)throw new Error('agent company mismatch');
      if(expectedBinding!==undefined && !equal(a.runtimeConfig?.aiConnection??null,expectedBinding))throw new Error('agent binding changed before write');
      if(typeof a.configurationRevision!=='string' || !/^[a-f0-9]{64}$/.test(a.configurationRevision))throw new Error('agent configuration revision required');
      const runtimeConfig={...a.runtimeConfig,aiConnection:binding};
      await request('PATCH',`/agents/${id(agentId)}`,{runtimeConfig,expectedConfigurationRevision:a.configurationRevision});
      const saved=await request('GET',`/agents/${id(agentId)}`);
      if(!equal(saved.runtimeConfig?.aiConnection,binding))throw new Error('host did not retain requested binding');
      return {ok:true};
    },
    async wakeAgent(agentId,input) {return request('POST',`/agents/${id(agentId)}/wakeup`,input);},
  };
}
