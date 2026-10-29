// Read-only planning helpers. They do not install, reset, bind, or wake agents.
import { normalizeRegistry } from '../src/registry.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function agentList(value) {
  if (!Array.isArray(value) || value.length > 1000 || value.some(id => typeof id !== 'string' || !uuid.test(id))) throw new Error('invalid batch agentIds');
  return [...new Set(value)];
}
function gatewayUrl(value) {
  try {
    if (typeof value !== 'string' || value !== value.trim() || value.length > 2048) throw new Error();
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new Error();
    return value;
  } catch { throw new Error('invalid gateway baseUrl'); }
}

// apiKey is deliberately absent: inject the secret only at the API boundary,
// never into a dry-run plan, journal, or log.
export function planGatewayConnections({registry: raw, baseUrl, batch, allAgents=false, allAgentsApproved=false}) {
  const registry=normalizeRegistry(raw), url=gatewayUrl(baseUrl);
  if (typeof allAgents !== 'boolean' || typeof allAgentsApproved !== 'boolean' || allAgents !== allAgentsApproved) throw new Error('allAgents requires explicit flag and approval');
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) throw new Error('invalid batch');
  const poolKeys=registry.pools.map(p=>p.poolKey);
  if (Object.keys(batch).length !== poolKeys.length || poolKeys.some(k=>!Object.hasOwn(batch,k))) throw new Error('batch must contain exactly the configured pools');
  const batches=Object.fromEntries(poolKeys.map(k=>[k,agentList(batch[k])]));
  return registry.accounts.map(account=>{
    const poolMemberships=Object.keys(account.pools);
    if (!poolMemberships.length) throw new Error('account must join a pool');
    const agentIds=allAgents ? [] : agentList(poolMemberships.flatMap(k=>batches[k]));
    const models=[...new Set(Object.values(account.pools).map(p=>`${account.prefix}/${p.model}`))].sort().map(id=>({id}));
    if (models.length > 200) throw new Error('too many routing models');
    return {accountKey:account.accountKey,inputWithoutSecret:{name:account.connectionName,provider:account.provider,method:'api_key',ownership:'shared',routing:{kind:'gateway',protocol:account.protocol,baseUrl:url,auth:'bearer',models},agentIds,allAgents}};
  });
}

// Every returned session is conservatively treated as live. A reset plan is
// only an instruction to the caller, never proof that a reset happened; re-list
// immediately before binding. Unknown/missing evidence always fails closed.
export function planSessionAdoption({agentIds, sessionsByAgent, sessionPlans={}}) {
  const agents=agentList(agentIds);
  if (!agents.length) throw new Error('agent batch must not be empty');
  const plainObject = value => value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  if (!plainObject(sessionsByAgent) || !plainObject(sessionPlans) || Object.keys(sessionsByAgent).some(id=>!agents.includes(id)) || Object.keys(sessionPlans).some(id=>!agents.includes(id))) throw new Error('invalid session evidence or plan');
  const blockers=[], resets=[];
  for(const agentId of agents) {
    const sessions=Object.hasOwn(sessionsByAgent,agentId) ? sessionsByAgent[agentId] : undefined;
    const plan=Object.hasOwn(sessionPlans,agentId) ? sessionPlans[agentId] : undefined;
    if (!Array.isArray(sessions) || (plan !== undefined && !['drained','reset'].includes(plan))) throw new Error('invalid session evidence or plan');
    for(const session of sessions) {
      if (typeof session?.taskKey !== 'string' || !session.taskKey.trim() || session.taskKey !== session.taskKey.trim()) throw new Error('invalid task session');
      if (plan !== 'reset') throw new Error('live session requires explicit reset plan; drained requires no sessions');
      blockers.push({agentId,taskKey:session.taskKey,plan});
      if (!resets.some(r=>r.agentId===agentId && r.taskKey===session.taskKey)) resets.push({agentId,taskKey:session.taskKey});
    }
  }
  return {blockers,resets,ready:blockers.length===0};
}
