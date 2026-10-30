import test from 'node:test';
import assert from 'node:assert/strict';
import * as scorecard from '../src/scorecard.mjs';
const MINUTE=60_000,HOUR=60*MINUTE,NOW=Date.parse('2026-10-30T00:00:00Z'),RESET=NOW+6*HOUR;
const account=(overrides={})=>({accountKey:'one',prefix:'one',inScope:true,weeklyResetsAtMs:RESET,weeklyUsed:.4,projectedUsed:.4,quality:'live',observedAtMs:NOW,eligible:true,paceHeld:false,requiredRatePerHour:.1,measuredRatePerHour:.08,measuredRate24h:.09,usage:{epoch:'keeper-1',requests:100,observedAtMs:NOW},...overrides});
function tick(state,nowMs,accounts,extra={}) {assert.equal(typeof scorecard.tickScorecard,'function','scorecard job-side library exists');return scorecard.tickScorecard(state,{nowMs,periodMs:MINUTE,accounts,...extra});}
const rows=state=>scorecard.scorecardRows(state);

test('U16/U23 unavailable-early counters use projected quota, strict >1h boundary, 2x-period gap cap and serializable state',()=>{
  let state=tick(null,NOW,[account({weeklyUsed:.98,projectedUsed:.996,eligible:false})]);
  state=tick(JSON.parse(JSON.stringify(state)),NOW+MINUTE,[account({weeklyUsed:.98,projectedUsed:.996,observedAtMs:NOW+MINUTE,eligible:false})]);
  assert.equal(rows(state)[0].minutesUnavailableEarly,2);
  state=tick(state,NOW+HOUR,[account({weeklyUsed:.98,projectedUsed:.996,observedAtMs:NOW+HOUR,eligible:false})]);
  assert.equal(rows(state)[0].minutesUnavailableEarly,4,'one-hour outage adds at most two minutes');
  const atBoundary=tick(null,RESET-HOUR,[account({weeklyUsed:1,projectedUsed:1,observedAtMs:RESET-HOUR,eligible:false})]);
  assert.equal(rows(atBoundary)[0].minutesUnavailableEarly,0,'exactly one hour is not early');
  assert.deepEqual(tick(state,NOW+HOUR,[]),state,'same tick cannot double count');
  assert.deepEqual(tick(state,NOW,[]),state,'clock rollback cannot double count');
});

test('U16 reset closes and latches the last prior reading permanently; counters never leak into new window',()=>{
  let state=tick(null,RESET-MINUTE,[account({weeklyUsed:.75,observedAtMs:RESET-MINUTE,eligible:false,projectedUsed:1})]);
  const inputState=state,before=structuredClone(state);
  state=tick(state,RESET,[account({weeklyResetsAtMs:RESET+7*24*HOUR,weeklyUsed:.01,projectedUsed:.01,observedAtMs:RESET})]);
  assert.deepEqual(inputState,before,'tick must not mutate its saved input');
  const old=rows(state).find(r=>r.windowResetsAt===new Date(RESET).toISOString());
  assert.equal(old.finalUnusedAtReset,25);assert.equal(old.closed,true);assert.equal(old.minutesEligible,0);
  const current=rows(state).find(r=>!r.closed);assert.equal(current.minutesEligible,0,'the minute before reset belongs to the old window');assert.equal(current.finalUnusedAtReset,null);
  state=tick(state,RESET+MINUTE,[account({weeklyResetsAtMs:RESET+7*24*HOUR,weeklyUsed:.02,observedAtMs:RESET+MINUTE})]);
  assert.deepEqual(rows(state).find(r=>r.closed),old,'new readings cannot revise a closed window');
  assert.equal(rows(state).find(r=>!r.closed).minutesEligible,1);
});

test('U16 no-demand requires eligible-unpicked Keeper evidence, not merely zero runs or idle policy',()=>{
  const unavailable=tick(null,NOW,[account({eligible:false})]);
  assert.equal(rows(unavailable)[0].leftoverReason,null);
  let state=tick(null,NOW,[account()]);
  assert.equal(rows(state)[0].leftoverReason,null,'first cumulative counter is only a baseline');
  state=tick(state,NOW+MINUTE,[account({observedAtMs:NOW+MINUTE,usage:{epoch:'keeper-1',requests:100,observedAtMs:NOW+MINUTE}})]);
  assert.equal(rows(state)[0].leftoverReason,'no-demand');assert.equal(rows(state)[0].minutesEligibleUnpicked,1);
  state=tick(state,NOW+2*MINUTE,[account({observedAtMs:NOW+2*MINUTE,usage:{epoch:'keeper-1',requests:101,observedAtMs:NOW+2*MINUTE}})]);
  assert.equal(rows(state)[0].runsServed,1);assert.equal(rows(state)[0].leftoverReason,null,'served runs invalidate the no-demand explanation');
  const noCounter=tick(null,NOW,[account({usage:null})]);
  assert.notEqual(rows(noCounter)[0].leftoverReason,'no-demand');
});

test('U16 excluded-by-policy and feed-unknown accounts stay visible with unused percent and no eligibility minutes',()=>{
  const state=tick(null,NOW,[account({inScope:false,eligible:true}),account({accountKey:'missing',prefix:'missing',quality:'unknown',weeklyUsed:null,projectedUsed:null})]);
  const excluded=rows(state).find(r=>r.accountKey==='one');
  assert.equal(excluded.status,'excluded-by-policy');assert.equal(excluded.leftoverReason,'excluded');assert.equal(excluded.pctUsedNow,40);assert.equal(excluded.projectedUnusedAtReset,60);assert.equal(excluded.minutesEligible,0);
  const unknown=rows(state).find(r=>r.accountKey==='missing');assert.equal(unknown.status,'feed-unknown');assert.equal(unknown.leftoverReason,'feed-gap');assert.equal(unknown.minutesEligible,0);assert.equal(unknown.pctUsedNow,null);
});

test('Keeper counters are epoch scoped, monotonic-observation only, and compared honestly with ledger window totals',()=>{
  let state=tick(null,NOW,[account()]);
  state=tick(state,NOW+MINUTE,[account({observedAtMs:NOW+MINUTE,usage:{epoch:'keeper-1',requests:110,observedAtMs:NOW+MINUTE},runsServedLedger:9})]);
  assert.equal(rows(state)[0].runsServed,10);assert.equal(rows(state)[0].runsServedLedger,9);assert.equal(rows(state)[0].attributionMismatch,true);assert.ok(state.warnings.some(w=>w.reason==='served-attribution-mismatch'));
  assert.equal(rows(state)[0].waitsCaused,null);assert.deepEqual(rows(state)[0].poolWaitsObserved,{});assert.match(rows(state)[0].waitsNote,/does not expose/);
  state=tick(state,NOW+2*MINUTE,[account({observedAtMs:NOW+2*MINUTE,usage:{epoch:'keeper-2',requests:999,observedAtMs:NOW+2*MINUTE}})]);
  assert.equal(rows(state)[0].runsServed,10,'new epoch is a baseline, not 889 new runs');
  state=tick(state,NOW+3*MINUTE,[account({observedAtMs:NOW+3*MINUTE,usage:{epoch:'keeper-2',requests:1001,observedAtMs:NOW+3*MINUTE}})]);
  assert.equal(rows(state)[0].runsServed,12);
  state=tick(state,NOW+4*MINUTE,[account({observedAtMs:NOW+4*MINUTE,usage:{epoch:'keeper-2',requests:1010,observedAtMs:NOW+2*MINUTE}})]);
  assert.equal(rows(state)[0].runsServed,12,'out-of-order counter cannot invent growth');
});

test('missing/stale ticks cannot manufacture eligibility or no-demand and absent accounts close on reset',()=>{
  let state=tick(null,NOW,[account()]);
  state=tick(state,NOW+MINUTE,[]);
  assert.equal(rows(state)[0].status,'feed-unknown');assert.equal(rows(state)[0].minutesEligible,1);assert.equal(rows(state)[0].leftoverReason,'feed-gap');
  state=tick(state,RESET,[]);
  assert.equal(rows(state)[0].closed,true);assert.equal(rows(state)[0].finalUnusedAtReset,60);
  const stale=tick(null,NOW,[account({observedAtMs:NOW-16*MINUTE})]);assert.equal(rows(stale)[0].minutesEligible,0);
});

test('scorecard bounds reset windows to eight per account and preserves independent account counters',()=>{
  let state=null;
  for(let i=0;i<10;i++) {
    const now=NOW+i*24*HOUR,reset=now+24*HOUR;
    state=tick(state,now,[account({weeklyResetsAtMs:reset,observedAtMs:now,eligible:false,projectedUsed:1}),account({accountKey:'two',prefix:'two',weeklyResetsAtMs:reset,observedAtMs:now})]);
  }
  assert.equal(rows(state).filter(r=>r.accountKey==='one').length,8);assert.equal(rows(state).filter(r=>r.accountKey==='two').length,8);
  assert.ok(rows(state).filter(r=>r.accountKey==='two').every(r=>r.minutesUnavailableEarly===0));
  const publicRows=rows(state);publicRows[0].minutesEligible=999;assert.notEqual(rows(state)[0].minutesEligible,999,'views cannot mutate persisted counters');
});

test('scorecard tracks pace holds and bounded burn intervals without callback writes',()=>{
  let state=tick(null,NOW,[account({eligible:false,paceHeld:true,burn:{active:true,mode:'exclusive',expiresAtMs:NOW+2*MINUTE}})]);
  state=tick(state,NOW+MINUTE,[account({observedAtMs:NOW+MINUTE,eligible:false,paceHeld:true,burn:{active:true,mode:'exclusive',expiresAtMs:NOW+2*MINUTE}})]);
  state=tick(state,NOW+2*MINUTE,[account({observedAtMs:NOW+2*MINUTE,eligible:false,paceHeld:true})]);
  const row=rows(state)[0];assert.equal(row.minutesPaceHeld,3);assert.equal(row.leftoverReason,'pace-held');assert.deepEqual(row.burnWindows,[{from:NOW,to:NOW+2*MINUTE,mode:'exclusive'}]);
});


test('missing Keeper evidence after an eligible-unpicked interval cannot keep claiming no-demand',()=>{
  let state=tick(null,NOW,[account()]);
  state=tick(state,NOW+MINUTE,[account({observedAtMs:NOW+MINUTE,usage:{epoch:'keeper-1',requests:100,observedAtMs:NOW+MINUTE}})]);
  assert.equal(rows(state)[0].leftoverReason,'no-demand');
  state=tick(state,NOW+2*MINUTE,[account({observedAtMs:NOW+2*MINUTE,usage:null})]);
  assert.equal(rows(state)[0].leftoverReason,'feed-gap');
});

test('counter observation before the new window cannot seed a cross-reset delta',()=>{
  const start=RESET+MINUTE;
  let state=tick(null,start,[account({weeklyResetsAtMs:RESET+7*24*HOUR,observedAtMs:start,usage:{epoch:'keeper-1',requests:100,observedAtMs:RESET-1}})]);
  state=tick(state,start+MINUTE,[account({weeklyResetsAtMs:RESET+7*24*HOUR,observedAtMs:start+MINUTE,usage:{epoch:'keeper-1',requests:110,observedAtMs:start+MINUTE}})]);
  assert.equal(rows(state)[0].runsServed,0,'no proved in-window baseline, so do not invent ten in-window runs');
});

test('downtime does not turn a formerly no-demand row into a confidently explained reset miss',()=>{
  let state=tick(null,NOW,[account()]);
  state=tick(state,NOW+MINUTE,[account({observedAtMs:NOW+MINUTE,usage:{epoch:'keeper-1',requests:100,observedAtMs:NOW+MINUTE}})]);
  state=tick(state,RESET,[]);
  assert.equal(rows(state)[0].finalUnusedAtReset,60);
  assert.equal(rows(state)[0].leftoverReason,'feed-gap');
});

test('projected over-cap usage counts as unavailable-early and cannot show negative unused capacity',()=>{
  const row=rows(tick(null,NOW,[account({weeklyUsed:.98,projectedUsed:1.05,eligible:false})]))[0];
  assert.equal(row.minutesUnavailableEarly,1);assert.equal(row.projectedUnusedAtReset,0);
});

test('prefer burn mode is upstream-spec-shaped and a reset after downtime never extends its expiry',()=>{
  let state=tick(null,NOW,[account({burn:{active:true,mode:'prefer',expiresAtMs:NOW+MINUTE}})]);
  state=tick(state,RESET,[]);
  assert.deepEqual(rows(state)[0].burnWindows,[{from:NOW,to:NOW+MINUTE,mode:'prefer'}]);
});

test('window and rolling 24h rates survive short pacing-history pruning and project remaining unused at reset',()=>{
  let state=null;
  const reset=NOW+7*24*HOUR;
  for(let hour=0;hour<=30;hour++) {
    const now=NOW+hour*HOUR,used=hour<=6?.1+hour*.01:.16+(hour-6)*.005;
    state=tick(state,now,[account({weeklyResetsAtMs:reset,weeklyUsed:used,projectedUsed:used,observedAtMs:now,measuredRatePerHour:null,measuredRate24h:null,usage:{epoch:'keeper-1',requests:100,observedAtMs:now}})]);
  }
  const row=rows(state)[0];
  assert.ok(Math.abs(row.measuredRatePerHour-.006)<1e-10,'window: (.28 - .1) / 30h');
  assert.ok(Math.abs(row.measuredRate24h-.005)<1e-10,'24h: (.28 - .16) / 24h');
  assert.ok(Math.abs(row.projectedUnusedAtReset)<1e-10,'window rate reaches full use before reset');
});

test('burn expiry gaps close at the expiry or removal tick and mode switches remain separate',()=>{
  let state=tick(null,NOW,[account({burn:{active:true,mode:'prefer',expiresAtMs:NOW+10*MINUTE}})]);
  state=tick(state,NOW+MINUTE,[account({observedAtMs:NOW+MINUTE,burn:{active:true,mode:'exclusive',expiresAtMs:NOW+10*MINUTE}})]);
  state=tick(state,NOW+2*MINUTE,[account({observedAtMs:NOW+2*MINUTE})]);
  assert.deepEqual(rows(state)[0].burnWindows,[{from:NOW,to:NOW+MINUTE,mode:'prefer'},{from:NOW+MINUTE,to:NOW+2*MINUTE,mode:'exclusive'}]);
});

test('served ledger evidence contradicting a flat Keeper counter cannot claim no-demand',()=>{
  let state=tick(null,NOW,[account({runsServedLedger:0})]);
  state=tick(state,NOW+MINUTE,[account({observedAtMs:NOW+MINUTE,usage:{epoch:'keeper-1',requests:100,observedAtMs:NOW+MINUTE},runsServedLedger:1})]);
  const row=rows(state)[0];assert.equal(row.attributionMismatch,true);assert.notEqual(row.leftoverReason,'no-demand');
});
