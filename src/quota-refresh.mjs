/** Native quota job coordinator. All IO stays here, never in routeDecision.
 * Upstream's SDK currently has no pool-inspection client. inspectPools is an
 * explicit integration seam, NOT a fabricated ctx API or a board-token fallback.
 * Without it all native pools are unavailable (the retained hook is untouched).
 */
import { normalizeRegistry, memberIdFor, poolHasExpectedPluginKey, PLUGIN_KEY } from './registry.mjs';
import { checkPoolDrift } from '../scripts/pool-saga.mjs';
import { buildQuotaSnapshot, createSnapshotPublisher } from './snapshot.mjs';
import { routeDecision } from './router.mjs';

const WARNING_INTERVAL_MS = 10 * 60_000;
const SHADOW_CAP = 120;

/** The SDK transport strips RequestInit.signal (worker-rpc-host.ts:605-641).
 * Enforce the job deadline locally too; an eventual RPC answer is discarded.
 * This timer is job-local, never a host schedule or a callback-side timer. */
export function withQuotaTimeout(operation,timeoutMs=10_000) {
  const controller=new AbortController();let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('cliproxy-timeout'));},timeoutMs);});
  return Promise.race([Promise.resolve().then(()=>operation(controller.signal)),deadline]).finally(()=>clearTimeout(timer));
}

/** A registry-derived request for local policy simulation only. Synthetic
 * binding/pool/agent UUIDs never leave this process or mutate native objects.
 * The member and pool config shapes conform to the committed upstream schemas.
 */
export function syntheticRouterRequest(registry,poolKey,nowMs) {
  const members=registry.accounts.filter(a=>a.pools[poolKey]).map(a=>({
    id:memberIdFor(poolKey,a.accountKey),
    binding:{mode:'shared',provider:a.provider,method:'api_key',connectionId:memberIdFor('shadow-connection',a.accountKey),grantId:memberIdFor('shadow-grant',a.accountKey)},
    profile:{provider:a.harnessProfile,...(a.harnessProfile==='acpx'?{acpxAgent:'claude'}:{}),model:`${a.prefix}/${a.pools[poolKey].model}`},
  }));
  return {companyId:registry.companyId,agentId:memberIdFor('shadow-agent',poolKey),
    pool:{id:memberIdFor('shadow-pool',poolKey),companyId:registry.companyId,pluginKey:PLUGIN_KEY,revision:1,name:poolKey,enabled:true,mode:'round_robin',thresholdPercent:90,members},
    taskKey:memberIdFor('shadow-task',poolKey),lastMemberId:null,cursorVersion:0,
    memberOrder:members.map(m=>m.id),candidates:members.map(member=>({member,runtimeConfig:{...member.profile},notes:[]})),now:new Date(nowMs).toISOString()};
}

function readonlyInspection(api,pools) {
  const methods=['listConnections','getConnection','getGrants','getInstalls','getAgent'];
  if (!api || methods.some(m=>typeof api[m]!=='function')) throw new Error('invalid pool inspection');
  return Object.freeze({...Object.fromEntries(methods.map(m=>[m,api[m].bind(api)])),listPools:async()=>pools});
}
function driftMemberReasons(registry,drift) {
  const reasons={};
  for (const row of drift) {
    if (row.type==='plugin-key-drift') continue; // Loud pool-level unavailable.
    for (const [id,member] of Object.entries(registry.memberIndex)) {
      if (row.memberId ? row.memberId===id : row.accountKey ? row.accountKey===member.accountKey : row.poolKey===member.poolKey) reasons[id]='unmapped-member';
    }
  }
  return reasons;
}

export function createQuotaRefresh({state,logger,clock=Date.now,keyFor,inspectPools=null,listAgents=async()=>[]}) {
  const publisher=createSnapshotPublisher({state,keyFor}),failures=new Map(),lastFailure=new Map(),queues=new Map();
  function report(companyId,reason,details={},level='warn',message='model-capacity: native quota refresh') {
    const nowMs=clock(),key=JSON.stringify([companyId,reason,details.accountKey??details.poolId??details.poolKey??null]);
    const prior=failures.get(key);
    if (prior!=null && nowMs>=prior && nowMs-prior<WARNING_INTERVAL_MS) return;
    failures.delete(key);failures.set(key,nowMs);
    if(failures.size>1000)failures.delete(failures.keys().next().value);
    (logger[level]??logger.info).call(logger,message,{companyId,reason,...details});
  }
  function failure(companyId,reason,message) {
    lastFailure.set(companyId,reason);report(companyId,reason,{},'error',message);
    return {status:'error',reason};
  }
  async function tick(companyId,config,{feed,ledger=new Map(),isCurrent=()=>true}={}) {
    if (!config.router) return {status:'disabled'};
    let registry;
    try {registry=normalizeRegistry(config.router);} catch {return failure(companyId,'router-registry-invalid');}
    if (registry.companyId!==companyId) return failure(companyId,'router-company-mismatch');
    let previous;
    try {previous=publisher.envelope(companyId)??await state.get(keyFor(companyId));} catch {return failure(companyId,'quota-state-failed');}
    if(!isCurrent())return {status:'superseded'};
    let pools=[],drift,inspection='ready';
    if(typeof inspectPools!=='function') {
      inspection='unavailable';
      drift={ok:false,drift:registry.pools.map(p=>({type:'pool-inspection-unavailable',poolKey:p.poolKey})),selectableVerdicts:[],primarySignal:'unavailable'};
      report(companyId,'pool-inspection-unavailable',{},'error');
    } else {
      try {
        const input=await inspectPools({companyId,registry,config});
        pools=await input.api.listPools(companyId);
        if(!Array.isArray(pools))throw new Error('invalid pool inspection');
        // Ownership is checked before discovery can reject a different field;
        // a wrong pluginKey must always produce the V0 startup ERROR.
        for(const p of pools)if(registry.pools.some(r=>r.poolKey===p?.name) && !poolHasExpectedPluginKey(p))report(companyId,'plugin-key-drift',{poolId:p.id,poolKey:p.name},'error');
        drift=await checkPoolDrift({...input,api:readonlyInspection(input.api,pools),registry:config.router});
      } catch {return failure(companyId,'pool-inspection-failed');}
    }
    if(!isCurrent())return {status:'superseded'};
    const wrongPools=pools.filter(p=>registry.pools.some(r=>r.poolKey===p?.name) && !poolHasExpectedPluginKey(p));
    const unavailablePoolIds=wrongPools.map(p=>p.id);
    const unavailablePoolKeys=inspection==='unavailable'?registry.pools.map(p=>p.poolKey):wrongPools.map(p=>p.name);
    let built;
    try {built=buildQuotaSnapshot({registry,feed,nowMs:clock(),previous:previous?.snapshot,histories:previous?.histories,controllers:previous?.controllers,ledger,config,
      unavailablePoolIds,unavailablePoolKeys,memberSkipReasons:driftMemberReasons(registry,drift.drift),drift});}
    catch {return failure(companyId,'quota-feed-invalid');}
    for(const warning of built.warnings)report(companyId,warning.reason,{accountKey:warning.accountKey});
    for(const row of drift.drift)report(companyId,'pool-drift',{type:row.type,...(row.accountKey?{accountKey:row.accountKey}:{}),...(row.poolKey?{poolKey:row.poolKey}:{}),...(row.memberId?{memberId:row.memberId}:{})});
    let agents;
    try {agents=await listAgents(companyId);if(!Array.isArray(agents))throw new Error();} catch {return failure(companyId,'pool-bindings-unavailable');}
    const boundIds=new Set(agents.filter(a=>a?.runtimeConfig?.aiConnection?.mode==='router').map(a=>a.runtimeConfig.aiConnection.connectionId));
    const boundKeys=new Set(pools.filter(p=>boundIds.has(p.id)).map(p=>p.name));
    const atMs=built.snapshot.atMs,shadow=[];
    for(const {poolKey} of registry.pools) {
      if(boundKeys.has(poolKey))continue;
      const params=syntheticRouterRequest(registry,poolKey,atMs);
      const decision=routeDecision(params,built.snapshot,{...config,router:{...config.router,enabled:true}});
      shadow.push({poolKey,wouldSelect:decision.kind==='selected'?built.snapshot.memberIndex[decision.memberId].accountKey:decision.kind,atMs,decision});
    }
    const shadowHistory=[...(previous?.shadow??[]),...shadow].slice(-SHADOW_CAP);
    const envelope={...built,shadow:shadowHistory,currentShadow:shadow,inspection};
    try {
      if(!await publisher.publish(companyId,envelope,{isCurrent}))return {status:'superseded'};
    } catch {return failure(companyId,'quota-state-failed');}
    lastFailure.delete(companyId);
    return {status:'ok',snapshot:built.snapshot};
  }
  return {
    get:publisher.get,
    status(companyId) {
      const e=publisher.envelope(companyId);
      return {snapshotAtMs:e?.snapshot?.atMs??null,inspection:e?.inspection??'pending',lastFailure:lastFailure.get(companyId)??null,shadow:e?.currentShadow??[],unavailablePoolKeys:e?.snapshot?.unavailablePoolKeys??[]};
    },
    failure,
    refresh(companyId,config,input) {
      // Serialize publication even if a config change admits a second refresh.
      const previous=queues.get(companyId)??Promise.resolve();
      const pending=previous.catch(()=>{}).then(()=>tick(companyId,config,input));
      queues.set(companyId,pending);
      const clear=()=>{if(queues.get(companyId)===pending)queues.delete(companyId);};
      pending.then(clear,clear);
      return pending;
    },
  };
}
