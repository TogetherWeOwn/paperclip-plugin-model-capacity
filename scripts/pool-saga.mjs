/** Native HTTP-contract saga; no separate grant writes. See the upstream
 * routes/ai-connections.ts POST (inline grant+installs), routes/tool-access.ts
 * name-only PATCH and PUT installs, and services/ai-connections.ts immutable
 * routing check. Pools are saved LAST, disabled, checked, then activated.
 */
import { normalizeRegistry, memberIdFor, PLUGIN_KEY } from '../src/registry.mjs';
import { buildPoolPlan } from './pool-plan.mjs';
import { planGatewayConnections } from './gateway-batch.mjs';
import { batchAgents, selectableVerdict, sessionEvidence, issueIdForTaskKey, poolConfig, equal, installsFor, orderedInstalls, connectionShape } from './generator-safety.mjs';
import { newJournal, temporaryName, rollbackJournal } from './pool-journal.mjs';

async function discover(options) {
  const {api,registry:raw,batch,baseUrl,allAgents=false,allAgentsApproved=false}=options;
  const registry=normalizeRegistry(raw);
  if(!registry.accounts.length || !registry.pools.length) throw new Error('registry must contain accounts and pools');
  if(registry.pools.some(p=>p.poolKey.length>160))throw new Error('pool name exceeds host limit');
  const desired=planGatewayConnections({registry:raw,batch,baseUrl,allAgents,allAgentsApproved});
  const assignments=batchAgents(batch);
  const listing=await api.listConnections(registry.companyId);
  if(listing.currentUserId!==registry.ownerUserId || listing.canManageConnections!==true || !Array.isArray(listing.connections)) throw new Error('board identity must match ownerUserId with connection management permission');
  const pools=await api.listPools(registry.companyId);
  if(!Array.isArray(pools))throw new Error('invalid host pool list');
  const accounts=[];
  for(const account of registry.accounts) {
    const rows=listing.connections.filter(c=>c.name===account.connectionName);
    const ids=[...new Set(rows.map(c=>c.id))];
    if(ids.length>1) throw new Error(`ambiguous connection: ${account.accountKey}`);
    if(rows.length>1) throw new Error(`ambiguous grant: ${account.accountKey}`);
    const row=rows[0],entry={account,row,input:desired.find(d=>d.accountKey===account.accountKey).inputWithoutSecret};
    if(row) {
      entry.detail=await api.getConnection(row.id);
      const grants=await api.getGrants(row.id);
      const matches=grants.grants.filter(g=>g.kind==='organization' && g.id===row.grantId);
      if(matches.length!==1) throw new Error(`missing or ambiguous shared grant: ${account.accountKey}`);
      entry.grant=matches[0];entry.installs=await api.getInstalls(row.id);
      if(!Array.isArray(entry.installs) || !entry.detail || entry.detail.companyId!==registry.companyId || entry.detail.createdByUserId!==registry.ownerUserId || entry.grant.createdByUserId!==registry.ownerUserId || row.ownership!=='shared' || row.provider!==account.provider || row.method!=='api_key') throw new Error(`connection ownership or provider mismatch: ${account.accountKey}`);
    } else entry.installs=[];
    accounts.push(entry);
  }
  for(const {poolKey} of registry.pools) if(pools.filter(p=>p.name===poolKey).length>1)throw new Error(`ambiguous pool: ${poolKey}`);
  const agents=new Map();
  for(const id of assignments.keys()) {
    const a=await api.getAgent(id);
    if(!a || a.id!==id || a.companyId!==registry.companyId)throw new Error('agent not in company');
    agents.set(id,a);
  }
  return {raw,registry,accounts,pools,assignments,agents};
}
function rowsFor(state,{provisional=false}={}) {
  return state.accounts.map(e=>({id:e.row?.id??memberIdFor('planned-connection',e.account.accountKey),grantId:e.row?.grantId??memberIdFor('planned-grant',e.account.accountKey),name:e.account.connectionName,provider:e.account.provider,method:'api_key',ownership:'shared',status:provisional?'connected':e.row?.status}));
}
function planFor(state,qualityVerdicts) {return buildPoolPlan(state.raw,rowsFor(state,{provisional:true}),qualityVerdicts);}
function verdictsFor(state,plan) {
  const result=[];
  for(const [agentId,poolKey] of state.assignments) for(const member of plan.pools.find(p=>p.config.name===poolKey)?.config.members??[]) {
    const accountKey=state.registry.memberIndex[member.id].accountKey;
    result.push({poolKey,accountKey,...selectableVerdict({agent:state.agents.get(agentId),entry:state.accounts.find(e=>e.account.accountKey===accountKey),member,companyId:state.registry.companyId})});
  }
  return result;
}
function sameConnection(entry) {return entry.row?.status==='connected' && equal(entry.row.routing,entry.input.routing);}
function ensurePools(state,plan) {
  for(const {poolKey} of state.registry.pools) {
    const p=plan.pools.find(p=>p.config.name===poolKey);
    if(!p)throw new Error(`no eligible members for pool: ${poolKey}`);
    if(p.config.members.length>100)throw new Error('pool exceeds host member limit');
  }
}

export async function planPoolSaga(options) {
  const state=await discover(options),plan=planFor(state,options.qualityVerdicts);
  const sessions=await sessionEvidence(options.api,[...state.assignments.keys()],options.sessionPlans);
  const errors=[];
  for(const {poolKey} of state.registry.pools) {
    if(!plan.pools.some(p=>p.config.name===poolKey))errors.push({poolKey,reason:'no-eligible-members'});
    const existing=state.pools.find(p=>p.name===poolKey);
    if(existing?.pluginKey!==undefined && existing.pluginKey!==PLUGIN_KEY)errors.push({poolKey,reason:'plugin-key-drift'});
  }
  return {...plan,connections:state.accounts.map(e=>({accountKey:e.account.accountKey,inputWithoutSecret:e.input,action:!e.row?'create':sameConnection(e)?'adopt':'replace-immutable-routing',identity:e.row?{connectionId:e.row.id,grantId:e.row.grantId}:{provisional:true,connectionId:memberIdFor('planned-connection',e.account.accountKey),grantId:memberIdFor('planned-grant',e.account.accountKey)}})),selectableVerdicts:verdictsFor(state,plan),sessionBlockers:sessions.blockers,resets:sessions.resets,errors,provisional:state.accounts.some(e=>!e.row),expectedEnabled:options.activate!==false};
}
function wakeFor(runId,agentId,taskKey) {return {source:'on_demand',triggerDetail:'manual',reason:'connection-pool-session-adoption',payload:{issueId:issueIdForTaskKey(taskKey)},idempotencyKey:`mc:${runId}:${agentId}:${taskKey}`};}
async function assertSessionsEmpty(api,ids) {
  const evidence=await sessionEvidence(api,ids,{});
  if(!evidence.ready)throw new Error('live session appeared before binding; drain or roll back');
}
async function checkOwnership(state) {
  for(const {poolKey} of state.registry.pools) {
    const p=state.pools.find(p=>p.name===poolKey);
    if(p && p.pluginKey!==PLUGIN_KEY)throw new Error(`wrong pluginKey: ${poolKey}`);
  }
}
export async function applyPoolSaga(options) {
  const {api,journalPath,qualityVerdicts,activate=true}=options;
  if(typeof activate!=='boolean')throw new Error('activate must be boolean');
  let state=await discover(options),plan=planFor(state,qualityVerdicts);
  ensurePools(state,plan);await checkOwnership(state);
  const ids=[...state.assignments.keys()];
  const sessions=await sessionEvidence(api,ids,options.sessionPlans);
  if(sessions.blockers.some(b=>!b.authorized))throw new Error('live session requires an explicit per-agent reset plan; drained requires no sessions');
  if(!activate && sessions.resets.length)throw new Error('cannot reset sessions for a disabled-only batch');
  for(const s of sessions.resets)issueIdForTaskKey(s.taskKey);
  // All immutable-route replacements and membership changes must start with
  // disabled pools. Unchanged enabled pools remain idempotent, not rewritten.
  for(const p of state.pools.filter(p=>state.registry.pools.some(q=>q.poolKey===p.name))) {
    const desired=plan.pools.find(q=>q.config.name===p.name);
    const replacement=state.accounts.some(e=>e.row && !sameConnection(e) && p.members.some(m=>m.binding.connectionId===e.row.id));
    if(p.enabled && (replacement || !equal({...poolConfig(p),enabled:false},desired.config)))throw new Error('disable changed pools through native pool settings before applying registry updates');
  }
  const fatal=verdictsFor(state,plan).filter(v=>!v.selectable && !['pending-connection','not-installed'].includes(v.reason));
  if(fatal.length)throw new Error('negative selectable verdict; repair connection, audience or harness before applying');
  for(const a of state.agents.values()) if(a.status==='running')throw new Error('agent is running; drain batch before applying');
  const journal=await newJournal(journalPath,{companyId:state.registry.companyId,ownerUserId:state.registry.ownerUserId,target:api.target??null});
  const created=[],resets=[];
  try {
    for(const e of state.accounts) {
      if(!e.row || !sameConnection(e)) {
        const made=await journal.step(api,{kind:'connection-create',accountKey:e.account.accountKey,before:null,after:{...e.input,name:temporaryName(journal.header.runId,`account-${e.account.accountKey}`).slice(0,160)}});
        created.push({kind:'connection',id:made.id,grantId:made.grantId});
        if(e.row) {
          const before=connectionShape(e.detail);
          await journal.step(api,{kind:'connection-patch',id:e.row.id,before,after:{name:temporaryName(journal.header.runId,`prior-${e.account.accountKey}`).slice(0,160),enabled:false}});
        }
        const c=await api.getConnection(made.id);
        await journal.step(api,{kind:'connection-patch',id:made.id,before:connectionShape(c),after:{name:e.account.connectionName,enabled:true}});
      } else {
        const desired=orderedInstalls(installsFor(e.input,state.registry.companyId));
        if(!equal(orderedInstalls(e.installs),desired))await journal.step(api,{kind:'installs',id:e.row.id,before:orderedInstalls(e.installs),after:desired});
      }
    }
    state=await discover(options);plan=planFor(state,qualityVerdicts);ensurePools(state,plan);
    const selectableVerdicts=verdictsFor(state,plan);
    if(selectableVerdicts.some(v=>!v.selectable))throw new Error('negative selectable verdict after install');
    for(const s of sessions.resets) {
      const wake=wakeFor(journal.header.runId,s.agentId,s.taskKey);
      await journal.step(api,{kind:'reset',id:s.agentId,taskKey:s.taskKey,wake});resets.push({...s,wake});
    }
    await assertSessionsEmpty(api,ids);
    for(const pool of plan.pools) {
      const old=state.pools.find(p=>p.name===pool.config.name);
      if(old && equal({...poolConfig(old),enabled:false},pool.config) && (activate || !old.enabled))continue;
      if(old)await journal.step(api,{kind:'pool-save',companyId:state.registry.companyId,id:old.id,expectedRevision:old.revision,before:poolConfig(old),after:pool.config});
      else {
        const made=await journal.step(api,{kind:'pool-create',companyId:state.registry.companyId,before:null,after:{...pool.config,name:temporaryName(journal.header.runId,`pool-${pool.config.name}`).slice(0,160)}});
        created.push({kind:'pool',id:made.id});
        const p=(await api.listPools(state.registry.companyId)).find(p=>p.id===made.id);
        await journal.step(api,{kind:'pool-save',companyId:state.registry.companyId,id:p.id,expectedRevision:p.revision,before:poolConfig(p),after:pool.config});
      }
    }
    // The check phase permits unchanged, previously-active pools, but every
    // created/changed pool is still disabled and verified before activation.
    const live=await api.listPools(state.registry.companyId);
    const phases=Object.fromEntries(live.filter(p=>state.registry.pools.some(q=>q.poolKey===p.name)).map(p=>[p.name,p.enabled]));
    const check=await checkPoolDrift({...options,expectedEnabled:phases});
    if(!check.ok)throw new Error('pre-activation drift check failed');
    if(activate) {
      for(const p of live.filter(p=>state.registry.pools.some(q=>q.poolKey===p.name))) if(!p.enabled)await journal.step(api,{kind:'pool-save',companyId:state.registry.companyId,id:p.id,expectedRevision:p.revision,before:poolConfig(p),after:{...poolConfig(p),enabled:true}});
      await assertSessionsEmpty(api,ids);
      for(const [id,poolKey] of state.assignments) {
        const current=await api.getAgent(id),pool=(await api.listPools(state.registry.companyId)).find(p=>p.name===poolKey);
        const before=current.runtimeConfig?.aiConnection??null,after={mode:'router',connectionId:pool.id};
        // Re-list immediately at the binding boundary, not merely at startup.
        await assertSessionsEmpty(api,[id]);
        if(!equal(before,after))await journal.step(api,{kind:'binding',id,before,after});
      }
      for(const {agentId,taskKey,wake} of resets)await journal.step(api,{kind:'wake',id:agentId,taskKey,after:wake});
    }
    const finalState=await discover(options);
    const mapping=finalState.accounts.map(e=>({accountKey:e.account.accountKey,connectionId:e.row.id,grantId:e.row.grantId,memberIds:Object.keys(finalState.registry.memberIndex).filter(id=>finalState.registry.memberIndex[id].accountKey===e.account.accountKey)}));
    await journal.record({type:'mapping',accounts:mapping,pools:(await api.listPools(state.registry.companyId)).filter(p=>state.registry.pools.some(q=>q.poolKey===p.name)).map(p=>({poolKey:p.name,id:p.id,revision:p.revision}))});
    await journal.record({type:'complete'});
    return {...plan,mapping,selectableVerdicts,journalPath,enabled:activate};
  } catch {
    await journal.record({type:'failed'}).catch(()=>{});
    const error=new Error('pool saga failed; inspect journal and recover pending intents with --rollback');
    error.journalPath=journalPath;error.orphans=created;error.pendingIntents=journal.entries.filter(e=>e.type==='intent'&&!journal.entries.some(d=>d.type==='done'&&d.seq===e.seq)).map(({seq,kind})=>({seq,kind}));
    throw error;
  } finally {await journal.close();}
}

export async function checkPoolDrift(options) {
  const {expectedEnabled=true}=options;
  if(typeof expectedEnabled!=='boolean' && (!expectedEnabled || typeof expectedEnabled!=='object' || Array.isArray(expectedEnabled)))throw new Error('invalid expectedEnabled');
  const state=await discover(options),plan=planFor(state,options.qualityVerdicts),drift=[];
  for(const e of state.accounts) {
    if(!e.row)drift.push({type:'missing-connection',accountKey:e.account.accountKey});
    else {
      if(!sameConnection(e))drift.push({type:'connection-drift',accountKey:e.account.accountKey});
      if(e.grant.status!=='active')drift.push({type:'missing-grant',accountKey:e.account.accountKey});
      if(!equal(orderedInstalls(e.installs),orderedInstalls(installsFor(e.input,state.registry.companyId))))drift.push({type:'install-drift',accountKey:e.account.accountKey});
    }
  }
  for(const {poolKey} of state.registry.pools) {
    const current=state.pools.find(p=>p.name===poolKey),desired=plan.pools.find(p=>p.config.name===poolKey);
    if(!current) {drift.push({type:'missing-pool',poolKey});continue;}
    if(current.pluginKey!==PLUGIN_KEY)drift.push({type:'plugin-key-drift',poolKey});
    if(!desired) {drift.push({type:'pool-drift',poolKey});continue;}
    for(const member of desired.config.members) {
      if(!current.members?.some(m=>m.id===member.id))drift.push({type:'missing-member',poolKey,memberId:member.id});
      const accountKey=state.registry.memberIndex[member.id].accountKey;
      if(!state.accounts.find(e=>e.account.accountKey===accountKey)?.row)drift.push({type:'unresolvable-member',poolKey,memberId:member.id});
    }
    const enabled=typeof expectedEnabled==='boolean'?expectedEnabled:expectedEnabled[poolKey];
    if(typeof enabled!=='boolean' || !equal(poolConfig(current),{...desired.config,enabled}))drift.push({type:'pool-drift',poolKey});
  }
  const selectableVerdicts=verdictsFor(state,plan);
  for(const v of selectableVerdicts)if(!v.selectable)drift.push({type:'unselectable-member',poolKey:v.poolKey,memberId:v.memberId,agentId:v.agentId,reason:v.reason});
  return {ok:drift.length===0,drift,selectableVerdicts,primarySignal:'R9 operator drift check'};
}
export async function rollbackPoolSaga(options) {return rollbackJournal({...options,target:options.api.target??null});}
