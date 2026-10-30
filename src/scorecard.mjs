/** Per-account, per-reset-window accounting, port spec §11 / U16 / U23.
 * Pure JOB-SIDE reducer: no callback accounting, HTTP, timers, or IO. The quota
 * job persists the returned JSON and publishes scorecardRows() on its views.
 *
 * accounts is the job's joined account evidence, including excluded feed rows:
 * {accountKey,prefix,inScope,weeklyResetsAtMs,weeklyUsed,projectedUsed,
 *  quality,observedAtMs,eligible,paceHeld,requiredRatePerHour,
 *  measuredRatePerHour,measuredRate24h,usage:{epoch,requests,observedAtMs},
 *  runsServedLedger?,burn?:{active,mode,expiresAtMs}}.
 * eligible/paceHeld must be the job's freshness/caps/floors/pacing verdicts,
 * NOT callback decisions. Ratios are 0..1; public Used/Unused values are %.
 * Ledger totals are already scoped to THIS account and reset window. Keeper
 * lifetime counters are differenced here only within a window and epoch.
 *
 * Wait attribution is deliberately NOT implemented before staging G3's event
 * shape proof (§11b): null is honest; invented per-account waits are not.
 */
const MINUTE=60_000,HOUR=60*MINUTE;
export const SCORECARD_WINDOWS_PER_ACCOUNT=8;
const ratio=x=>Number.isFinite(x)&&x>=0&&x<=1;
const nonnegative=x=>Number.isFinite(x)&&x>=0;
const fresh=(at,now,maxAge)=>Number.isFinite(at)&&at<=now&&now-at<=maxAge;
const pctUnused=used=>ratio(used)?100*(1-used):null;
const metric=value=>nonnegative(value)?value:null;
const copy=value=>structuredClone(value);

function newWindow(a,reset,now) {
  return {
    accountKey:a.accountKey,prefix:typeof a.prefix==='string'?a.prefix:null,
    windowResetsAt:reset===null?null:new Date(reset).toISOString(),
    pctUsedNow:null,requiredRatePerHour:null,measuredRatePerHour:null,measuredRate24h:null,
    minutesUnavailableEarly:0,minutesEligible:0,minutesPaceHeld:0,minutesEligibleUnpicked:0,
    poolWaitsObserved:{},waitsCaused:null,waitsNote:'host does not expose per-account wait attribution',
    runsServed:0,runsServedLedger:null,attributionMismatch:false,burnWindows:[],
    status:'feed-unknown',projectedUnusedAtReset:null,finalUnusedAtReset:null,
    leftoverReason:null,closed:false,
    _resetMs:reset,_startedAtMs:now,_lastUsed:null,_lastReadingMs:null,
    _usage:null,_previousEligible:false,_feedGap:false,
  };
}
function explanation(row) {
  if(row.status==='excluded-by-policy')return 'excluded';
  if(row.status==='feed-unknown'||row._feedGap)return 'feed-gap';
  const unused=row.closed?row.finalUnusedAtReset:row.projectedUnusedAtReset;
  if(!(unused>0))return null;
  if(row.minutesEligibleUnpicked>0&&row.runsServed===0)return 'no-demand';
  if(row.minutesPaceHeld>0)return 'pace-held';
  return null;
}
function close(row,now) {
  if(row.closed||row._resetMs===null||row._resetMs>now)return;
  row.closed=true;
  row.finalUnusedAtReset=pctUnused(row._lastUsed);
  row.burnWindows=row.burnWindows.map(b=>({...b,to:Math.min(b.to??b._expiresAtMs,row._resetMs)}));
  row.leftoverReason=explanation(row);
}
function keeperDelta(row,usage,now) {
  if(!usage||typeof usage.epoch!=='string'||!usage.epoch||!Number.isSafeInteger(usage.requests)||usage.requests<0||!fresh(usage.observedAtMs,now,2*MINUTE)||usage.observedAtMs<row._startedAtMs) {row._feedGap=true;return null;}
  const old=row._usage;
  if(old&&usage.observedAtMs<=old.observedAtMs)return null;
  row._usage={epoch:usage.epoch,requests:usage.requests,observedAtMs:usage.observedAtMs};
  if(!old)return null;
  if(usage.epoch!==old.epoch||usage.requests<old.requests) {row._feedGap=true;return null;}
  return usage.requests-old.requests;
}
function updateBurn(row,burn,now) {
  const prior=row.burnWindows.at(-1);
  const active=burn?.active===true&&['prefer','exclusive'].includes(burn.mode)&&Number.isFinite(burn.expiresAtMs)&&burn.expiresAtMs>now;
  if(prior?.to===null&&(!active||prior.mode!==burn.mode))prior.to=Math.min(now,prior._expiresAtMs);
  if(active&&(!prior||prior.to!==null))row.burnWindows.push({from:now,to:null,mode:burn.mode,_expiresAtMs:Math.min(burn.expiresAtMs,row._resetMs??Infinity)});
  else if(active&&prior)prior._expiresAtMs=Math.min(burn.expiresAtMs,row._resetMs??Infinity);
}

/** Advance one quota tick. Replayed/out-of-order ticks cannot add time or runs.
 * Downtime contributes <=2 periods, using THIS tick's state as required by §11a.
 * A first tick contributes one period; reset crossing clips to the new window.
 */
export function tickScorecard(saved,{nowMs,periodMs=MINUTE,accounts,hardCapWeekly=.995,accountStaleMs=15*MINUTE}) {
  if(!Number.isFinite(nowMs)||!Number.isFinite(new Date(nowMs).getTime())||!Number.isFinite(periodMs)||periodMs<=0||!ratio(hardCapWeekly)||!nonnegative(accountStaleMs)||!Array.isArray(accounts))throw new Error('invalid scorecard tick');
  const keys=new Set();
  for(const a of accounts) {
    if(!a||typeof a.accountKey!=='string'||!a.accountKey||keys.has(a.accountKey))throw new Error('invalid or duplicate scorecard account');
    keys.add(a.accountKey);
  }
  if(saved&&(saved.version!==1||!Array.isArray(saved.windows)||!Number.isFinite(saved.atMs)))throw new Error('invalid scorecard state');
  if(saved&&nowMs<=saved.atMs)return copy(saved);
  const state=saved?copy(saved):{version:1,atMs:null,windows:[],warnings:[]};
  const elapsed=state.atMs===null?periodMs:Math.min(nowMs-state.atMs,2*periodMs);
  state.warnings=[];
  for(const row of state.windows) {
    if(!row.closed&&state.atMs!==null&&nowMs-state.atMs>2*periodMs)row._feedGap=true;
    close(row,nowMs);
  }
  // Absent accounts remain visible rather than silently disappearing from SLOs.
  for(const row of state.windows.filter(r=>!r.closed&&!keys.has(r.accountKey))) {
    row.status='feed-unknown';row._feedGap=true;row._previousEligible=false;
    row.leftoverReason='feed-gap';updateBurn(row,null,nowMs);
  }
  for(const a of accounts) {
    const reset=Number.isFinite(a.weeklyResetsAtMs)&&Number.isFinite(new Date(a.weeklyResetsAtMs).getTime())?a.weeklyResetsAtMs:null;
    // A delayed old-window reading must never reopen/revise a latched window.
    if(reset!==null&&reset<=nowMs)continue;
    let row=state.windows.find(r=>r.accountKey===a.accountKey&&r._resetMs===reset);
    if(!row) {
      const priorReset=Math.max(-Infinity,...state.windows.filter(r=>r.accountKey===a.accountKey&&r.closed).map(r=>r._resetMs));
      row=newWindow(a,reset,nowMs);row._intervalStartMs=Math.max(nowMs-elapsed,priorReset);
      state.windows.push(row);
      // Unknown-reset placeholders are not historical reset windows.
      if(reset!==null)state.windows=state.windows.filter(r=>r===row||r.accountKey!==a.accountKey||r._resetMs!==null);
    } else row._intervalStartMs=nowMs-elapsed;
    const minutes=Math.max(0,nowMs-row._intervalStartMs)/MINUTE;
    const credible=['live','passive','cached'].includes(a.quality)&&fresh(a.observedAtMs,nowMs,accountStaleMs)&&ratio(a.weeklyUsed)&&reset!==null;
    row.status=a.inScope===false?'excluded-by-policy':a.inScope===true&&credible?'in-scope':'feed-unknown';
    if(row.status==='feed-unknown')row._feedGap=true;
    row.pctUsedNow=credible?100*a.weeklyUsed:null;
    if(credible&&(row._lastReadingMs===null||a.observedAtMs>=row._lastReadingMs)) {row._lastUsed=a.weeklyUsed;row._lastReadingMs=a.observedAtMs;}
    row.requiredRatePerHour=metric(a.requiredRatePerHour);row.measuredRatePerHour=metric(a.measuredRatePerHour);row.measuredRate24h=metric(a.measuredRate24h);
    row.projectedUnusedAtReset=credible&&nonnegative(a.projectedUsed)?pctUnused(Math.min(1,a.projectedUsed)):null;
    const eligible=row.status==='in-scope'&&a.eligible===true&&a.paceHeld!==true&&nonnegative(a.projectedUsed)&&a.projectedUsed<hardCapWeekly;
    if(row.status==='in-scope'&&nonnegative(a.projectedUsed)&&a.projectedUsed>=hardCapWeekly&&reset-nowMs>HOUR)row.minutesUnavailableEarly+=minutes;
    if(eligible)row.minutesEligible+=minutes;
    if(row.status==='in-scope'&&a.paceHeld===true)row.minutesPaceHeld+=minutes;
    const delta=keeperDelta(row,a.usage,nowMs);
    if(delta!==null) {
      row.runsServed+=delta;
      if(eligible&&row._previousEligible&&delta===0)row.minutesEligibleUnpicked+=minutes;
    }
    row._previousEligible=eligible;
    if(Number.isSafeInteger(a.runsServedLedger)&&a.runsServedLedger>=0)row.runsServedLedger=a.runsServedLedger;
    row.attributionMismatch=row.runsServedLedger!==null&&Math.abs(row.runsServed-row.runsServedLedger)/Math.max(1,row.runsServed,row.runsServedLedger)>.02;
    if(row.attributionMismatch)state.warnings.push({accountKey:row.accountKey,windowResetsAt:row.windowResetsAt,reason:'served-attribution-mismatch'});
    updateBurn(row,a.burn,nowMs);row.leftoverReason=explanation(row);
  }
  // Keep only eight windows for EACH account, not eight across the fleet.
  const retained=new Map();
  state.windows.sort((a,b)=>(b._resetMs??Infinity)-(a._resetMs??Infinity));
  state.windows=state.windows.filter(r=>{const n=(retained.get(r.accountKey)??0)+1;retained.set(r.accountKey,n);return n<=SCORECARD_WINDOWS_PER_ACCOUNT;});
  state.atMs=nowMs;
  return state;
}

/** Safe public rows for GET /scorecard and the folded /capacity view. No cursor
 * internals escape and consumers cannot mutate the persisted accounting state.
 */
export function scorecardRows(state) {
  return (state?.windows??[]).map(row=>{
    const out=Object.fromEntries(Object.entries(row).filter(([key])=>!key.startsWith('_')));
    out.burnWindows=row.burnWindows.map(({from,to,mode,_expiresAtMs})=>({from,to:to??Math.min(state.atMs,_expiresAtMs),mode}));
    return copy(out);
  });
}
