/** Native quota job coordinator. All IO stays here, never in routeDecision.
 * Full drift inspection belongs to the operator's generator --check: upstream
 * has no SDK inspection client or producer for the generator's operator inputs.
 * inspectPools remains a TEST/OPERATOR seam only, never a production default.
 * Without it the tick publishes quota only; current config attestation and
 * host call metadata are checked by the pure per-call tripwire instead.
 */
import { normalizeRegistry, memberIdFor, poolHasExpectedPluginKey, PLUGIN_KEY } from './registry.mjs';
import { checkPoolDrift } from '../scripts/pool-saga.mjs';
import { buildQuotaSnapshot, createSnapshotPublisher, freezeSnapshot } from './snapshot.mjs';
import { tickScorecard, scorecardView, scorecardAccounts } from './scorecard.mjs';
import { computeRuntimePolicySkips } from './pool-quality.mjs';
import { routeDecision } from './router.mjs';
import { MIN_ATTRIBUTED_RUNS } from './calibration.mjs';
import { parseLaneBody } from './cliproxy.mjs';

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
    profile:{provider:a.harnessProfile,...(a.harnessProfile==='acpx'?{acpxAgent:'claude'}:{}),model:`${a.prefix}/${a.pools[poolKey].model}`,...(a.pools[poolKey].effort !== undefined ? {effort:a.pools[poolKey].effort} : {})},
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

export function createQuotaRefresh({state,logger,clock=Date.now,keyFor,inspectPools=null,getPolicy=()=>null,listAgents=async()=>[],captureOverlay=()=>0,onPublished=()=>{}}) {
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
  async function tick(companyId,config,{feed,ledger=new Map(),calibration={},isCurrent=()=>true}={}) {
    if (!config.router) return {status:'disabled'};
    let registry;
    try {registry=normalizeRegistry(config.router);} catch {return failure(companyId,'router-registry-invalid');}
    if (registry.companyId!==companyId) return failure(companyId,'router-company-mismatch');
    let previous;
    try {previous=publisher.envelope(companyId)??await state.get(keyFor(companyId));} catch {return failure(companyId,'quota-state-failed');}
    if(!isCurrent())return {status:'superseded'};
    let pools=[],drift,inspection='operator-check';
    if(typeof inspectPools==='function') {
      inspection='ready';
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
    let built;
    const overlayCheckpoint=captureOverlay(companyId);
    const nowMs=clock(), meanRunWeeklyPctByAccount={}, meanRunFiveHourPctByAccount={};
    let feedByKey;
    try {feedByKey=new Map((parseLaneBody(feed,nowMs)?.accounts ?? []).map(a=>[a.accountKey,a]));}
    catch {return failure(companyId,'quota-feed-invalid');}
    for (const account of registry.accounts) {
      // Calibration is keyed by the parsed feed identity (codex/claude), not
      // the gateway binding provider (openai/anthropic). Join by accountKey.
      // Only validated, fresh individual measurements are evidence, not a
      // guessed group prior or a rejected sample.
      const feedAccount=feedByKey.get(account.accountKey);
      const sample=feedAccount ? calibration?.accountE?.[feedAccount.accountId] : null;
      const age=nowMs-sample?.atMs;
      if (!sample || !Number.isFinite(age) || age<0 || age>(config.smoothing?.staleHours ?? 6)*3_600_000
          || sample.rejectionReason != null || !['account-weekly','account-five-hour'].includes(sample.source)
          || (sample.source==='account-weekly' && !(sample.attributedRuns>=MIN_ATTRIBUTED_RUNS))) continue;
      if (sample.source==='account-weekly' && Number.isFinite(sample.burnPerRunPct) && sample.burnPerRunPct>0)
        meanRunWeeklyPctByAccount[account.accountKey]=sample.burnPerRunPct;
      if (Number.isFinite(sample.fiveHourBurnPerRunPct) && sample.fiveHourBurnPerRunPct>0)
        meanRunFiveHourPctByAccount[account.accountKey]=sample.fiveHourBurnPerRunPct;
    }
    try {built=buildQuotaSnapshot({registry,feed,nowMs,previous:previous?.snapshot,histories:previous?.histories,controllers:previous?.controllers,ledger,config,meanRunWeeklyPctByAccount,meanRunFiveHourPctByAccount});}
    catch {return failure(companyId,'quota-feed-invalid');}
    // M1 simulates registry members before native pools even exist. Preserve
    // all quota/feed/credential gates, but do not treat deployment drift as a
    // quota decision. Only the published, real-routing snapshot gets that
    // enforcement overlay; neither this view nor shadow can authorize a run.
    const quotaState={...built.snapshot};
    for (const key of ['unavailablePoolIds','unavailablePoolKeys','drift']) delete quotaState[key];
    const shadowSnapshot=freezeSnapshot(quotaState);
    built={...built,snapshot:shadowSnapshot};
    if (drift) {
      const wrongPools=pools.filter(p=>registry.pools.some(r=>r.poolKey===p?.name) && !poolHasExpectedPluginKey(p));
      built={...built,snapshot:freezeSnapshot({...shadowSnapshot,drift,
        unavailablePoolIds:wrongPools.map(p=>p.id),unavailablePoolKeys:wrongPools.map(p=>p.name),
        memberSkipReasons:{...shadowSnapshot.memberSkipReasons,...driftMemberReasons(registry,drift.drift)}})};
    }
    for(const warning of built.warnings)report(companyId,warning.reason,{accountKey:warning.accountKey});
    for(const row of drift?.drift??[])report(companyId,'pool-drift',{type:row.type,...(row.accountKey?{accountKey:row.accountKey}:{}),...(row.poolKey?{poolKey:row.poolKey}:{}),...(row.memberId?{memberId:row.memberId}:{})});
    let agents;
    try {agents=await listAgents(companyId);if(!Array.isArray(agents))throw new Error();} catch {return failure(companyId,'pool-bindings-unavailable');}
    const boundIds=new Set(agents.filter(a=>a?.runtimeConfig?.aiConnection?.mode==='router').map(a=>a.runtimeConfig.aiConnection.connectionId));
    // Operator-attested config supplies the ID -> key map in production.
    // Unknown live bindings still suppress synthetic evidence conservatively.
    const shadowPools=inspection==='operator-check'
      ? registry.pools.filter(p=>p.poolId).map(p=>({id:p.poolId,name:p.poolKey})) : pools;
    const boundKeys=new Set(shadowPools.filter(p=>boundIds.has(p.id)).map(p=>p.name));
    const shadowSuppressedReason=[...boundIds].some(id=>!shadowPools.some(p=>p.id===id))?'pool-bindings-unmapped':null;
    if(shadowSuppressedReason)report(companyId,shadowSuppressedReason);
    const atMs=built.snapshot.atMs,shadow=[];
    for(const {poolKey} of registry.pools) {
      if(shadowSuppressedReason || boundKeys.has(poolKey))continue;
      const params=syntheticRouterRequest(registry,poolKey,atMs);
      const decision=routeDecision(params,shadowSnapshot,{...config,router:{...config.router,enabled:true}},{syntheticShadow:true});
      shadow.push({poolKey,wouldSelect:decision.kind==='selected'?shadowSnapshot.memberIndex[decision.memberId].accountKey:decision.kind,atMs,decision});
    }
    const shadowHistory=[...(previous?.shadow??[]),...shadow].slice(-SHADOW_CAP);
    let scorecard;
    try {
      const memberPolicySkips={};
      const evidence=getPolicy(companyId);
      for (const {poolKey} of registry.pools) Object.assign(memberPolicySkips,
        computeRuntimePolicySkips(syntheticRouterRequest(registry,poolKey,atMs),built.snapshot,config,evidence));
      scorecard=tickScorecard(previous?.scorecard ?? null,{nowMs:atMs,
        hardCapWeekly:config.router.hardCapWeekly ?? .995,accountStaleMs:config.router.accountStaleMs ?? 900_000,
        accounts:scorecardAccounts({registry,snapshot:built.snapshot,feed,previous:previous?.scorecard,ledger,memberPolicySkips,nowMs:atMs,
          hardCapWeekly:config.router.hardCapWeekly ?? .995,hardCapFiveHour:config.router.hardCapFiveHour ?? .99})});
    } catch {return failure(companyId,'scorecard-invalid');}
    for (const warning of scorecard.warnings) report(companyId,warning.reason,{accountKey:warning.accountKey,windowResetsAt:warning.windowResetsAt});
    const envelope={...built,scorecard,shadow:shadowHistory,currentShadow:shadow,inspection,shadowSuppressedReason};
    try {
      if(!await publisher.publish(companyId,envelope,{isCurrent,onPublish:()=>onPublished(companyId,built.snapshot,overlayCheckpoint)}))return {status:'superseded'};
    } catch {return failure(companyId,'quota-state-failed');}
    lastFailure.delete(companyId);
    return {status:'ok',snapshot:built.snapshot};
  }
  return {
    get:publisher.get,
    scorecard(companyId) {
      return scorecardView(publisher.envelope(companyId));
    },
    status(companyId) {
      const e=publisher.envelope(companyId);
      return {snapshotAtMs:e?.snapshot?.atMs??null,inspection:e?.inspection??'pending',burn:e?.snapshot?.burn??null,lastFailure:lastFailure.get(companyId)??null,shadow:e?.currentShadow??[],shadowSuppressedReason:e?.shadowSuppressedReason??null,unavailablePoolKeys:e?.snapshot?.unavailablePoolKeys??[]};
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
