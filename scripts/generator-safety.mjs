/** Read-only evidence gates. Source: upstream e2cfdc7e server/src/services/
 * ai-connections.ts select()/canUseCredential(), ai-connection-router.ts
 * poolMemberRuntimeConfig(), routes/tool-access.ts grants/installs reads.
 * AI list's agentId is ignored upstream; do NOT treat it as an install verdict.
 */
import { planSessionAdoption } from './gateway-batch.mjs';
export const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function canonical(x) { return Array.isArray(x)?x.map(canonical):x && typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x; }
export const installsFor=(input,companyId)=>input.allAgents?[{targetType:'company',targetId:companyId}]:input.agentIds.map(targetId=>({targetType:'agent',targetId}));
export const orderedInstalls=xs=>xs.map(({targetType,targetId})=>({targetType,targetId})).sort((a,b)=>`${a.targetType}:${a.targetId}`.localeCompare(`${b.targetType}:${b.targetId}`));
export const poolConfig=p=>({name:p.name,enabled:p.enabled,mode:p.mode,thresholdPercent:p.thresholdPercent,members:p.members});
export const connectionShape=c=>({name:c.name,enabled:c.enabled});
export function reversibleBinding(b) {
  const uuid=value=>typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  if(!b || typeof b!=='object' || Array.isArray(b))return false;
  if(b.mode==='router')return uuid(b.connectionId) && Object.keys(b).every(k=>['mode','connectionId'].includes(k));
  if(!['openai','anthropic','openrouter','xai','github','google'].includes(b.provider))return false;
  if(b.mode==='responsible_user')return Object.keys(b).every(k=>['mode','provider'].includes(k));
  return ['shared','delegated'].includes(b.mode) && ['api_key','subscription'].includes(b.method) && uuid(b.connectionId) && uuid(b.grantId) && Object.keys(b).every(k=>['mode','provider','method','connectionId','grantId'].includes(k));
}
export function batchAgents(batch) {
  const assignments=new Map();
  for(const [poolKey,ids] of Object.entries(batch)) for(const id of ids) {
    if(assignments.has(id) && assignments.get(id)!==poolKey) throw new Error('an agent cannot bind to two pools in one batch');
    assignments.set(id,poolKey);
  }
  if(!assignments.size) throw new Error('agent batch must not be empty');
  return assignments;
}
export async function sessionEvidence(api,agentIds,sessionPlans={}) {
  const sessionsByAgent={};
  for(const id of agentIds) {
    const rows=await api.listSessions(id);
    if(!Array.isArray(rows)) throw new Error('invalid session evidence');
    sessionsByAgent[id]=rows.map(s=>({taskKey:s.taskKey}));
  }
  // Validate even the empty-session case and foreign keys, while allowing a
  // dry-run to REPORT unauthorized live sessions rather than throw/exit 1.
  const validationPlans={...sessionPlans};
  for(const id of agentIds) if(sessionsByAgent[id].length && validationPlans[id]===undefined) validationPlans[id]='reset';
  for(const id of agentIds) if(sessionsByAgent[id].length && validationPlans[id]==='drained') validationPlans[id]='reset';
  if(!sessionPlans || typeof sessionPlans!=='object' || Array.isArray(sessionPlans)) throw new Error('invalid session plan');
  planSessionAdoption({agentIds,sessionsByAgent,sessionPlans:validationPlans});
  const blockers=[],resets=[];
  for(const agentId of agentIds) for(const {taskKey} of sessionsByAgent[agentId]) {
    if(blockers.some(b=>b.agentId===agentId && b.taskKey===taskKey)) continue;
    const authorized=sessionPlans[agentId]==='reset';
    blockers.push({agentId,taskKey,sessionPlan:sessionPlans[agentId]??null,authorized,reason:authorized?'reset-required':'live-session'});
    if(authorized) resets.push({agentId,taskKey});
  }
  return {blockers,resets,ready:blockers.length===0};
}
export function issueIdForTaskKey(taskKey) {
  const value=taskKey.startsWith('issue:')?taskKey.slice(6):taskKey;
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error('session taskKey needs an explicit native issue wake mapping');
  return value;
}
export function selectableVerdict({agent,entry,member,companyId}) {
  let reason=null;
  if(!agent || agent.companyId!==companyId) reason='agent-not-in-company';
  else if(!entry.row) reason='pending-connection';
  else if(entry.row.status!=='connected') reason='connection-unavailable';
  else if(entry.row.ownership!=='shared' || entry.grant?.kind!=='organization' || entry.grant?.status!=='active') reason='grant-unavailable';
  // A restricted audience may contain the operator but not the responsible
  // user of the next run. Never infer that all agents can use such a grant.
  else if(!Array.isArray(entry.grant.members) || entry.grant.members.length) reason='restricted-or-unknown-audience';
  else if(!entry.installs.some(i=>(i.targetType==='agent' && i.targetId===agent.id)||(i.targetType==='company' && i.targetId===companyId))) reason='not-installed';
  else if(agent.adapterType!=='paperclip_runner' && agent.adapterType!==(member.profile.provider==='codex'?'codex_local':'claude_local')) reason='incompatible-harness';
  else if(entry.row.routing?.kind!=='gateway' || entry.row.routing.protocol!==(member.profile.provider==='codex'?'responses':'messages')) reason='incompatible-routing';
  return {agentId:agent?.id??null,memberId:member.id,selectable:reason===null,reason:reason??'selectable',source:'host-read-evidence',checks:['ai-summary','organization-grant-audience','connection-installs','pool-harness']};
}
