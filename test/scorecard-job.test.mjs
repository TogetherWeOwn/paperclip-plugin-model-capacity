import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuotaRefresh } from '../src/quota-refresh.mjs';
import { scorecardView } from '../src/scorecard.mjs';
import { companyId } from './support/native-api.mjs';
import { config, quotaFeed, stateHarness, NOW, MINUTE, HOUR } from './support/quota.mjs';
const policy=now=>({atMs:now,records:[],arms:[
  {armId:'terra-high',model:'terra',effort:'high',family:'terra',quality:60},
  {armId:'sol-high',model:'sol',effort:'high',family:'sol',quality:60},
  {armId:'claude-high',model:'claude',effort:'high',family:'haiku',quality:55},
]});
function start({h=stateHarness(),now=NOW,deny=false}={}) {
  let time=now,blocked=deny;
  const cfg=config();cfg.roles={minQuality:{doer:null,thinker:null,other:null}};
  const quota=createQuotaRefresh({...h,clock:()=>time,getPolicy:()=>blocked?null:policy(time)});
  const feed=(extra={})=>{
    const f=quotaFeed(time,extra);
    for(const a of f.accounts)a.usage={epoch:'keeper-1',requests:100,observedAt:new Date(time).toISOString()};
    return f;
  };
  return {...h,cfg,quota,setNow:n=>{time=n;},setBlocked:x=>{blocked=x;},feed,
    tick:(f=feed(),ledger=new Map())=>quota.refresh(companyId,cfg,{feed:f,ledger}),
    rows:()=>quota.scorecard(companyId).rows};
}

test('native quota job persists incremental per-account rows, usage deltas, honest wait nulls and only a count of unregistered feed accounts',async()=>{
  const s=start();let f=s.feed();
  f.accounts.push({...structuredClone(f.accounts[0]),accountKey:'other-company'});
  await s.tick(f);
  assert.equal(typeof s.quota.scorecard,'function','scorecard is exposed by the native quota coordinator');
  assert.equal(s.rows().find(r=>r.accountKey==='one').minutesEligible,1);
  assert.equal(s.rows().some(r=>r.accountKey==='other-company'),false,'unregistered feed accounts are not published');
  assert.equal(s.quota.scorecard(companyId).unregisteredFeedAccounts,1);
  assert.doesNotMatch(JSON.stringify(s.store.get(JSON.stringify(s.keyFor(companyId))).scorecard),/other-company/,'nor persisted');
  s.setNow(NOW+MINUTE);f=s.feed();f.accounts[0].usage.requests=105;
  const ledger=new Map([['r1',{runId:'r1',startedAt:NOW+1000,actualModel:'one/terra'}],['shadow',{runId:'shadow',startedAt:NOW+1000,wouldModel:'one/terra'}]]);
  await s.tick(f,ledger);
  const row=s.rows().find(r=>r.accountKey==='one');
  assert.equal(row.minutesEligible,2);assert.equal(row.runsServed,5);assert.equal(row.runsServedLedger,1);
  assert.equal(row.attributionMismatch,true);assert.equal(row.waitsCaused,null);assert.match(row.waitsNote,/does not expose/);
  assert.ok(s.logs.some(l=>l.details.reason==='served-attribution-mismatch'));
  assert.equal(s.rows().find(r=>r.accountKey==='two').leftoverReason,'no-demand');
  s.setNow(NOW+2*MINUTE);await s.tick(s.feed(),ledger);
  assert.equal(s.rows().find(r=>r.accountKey==='one').runsServedLedger,1,'same ledger run is not counted twice');
  assert.equal(s.store.get(JSON.stringify(s.keyFor(companyId))).scorecard.atMs,NOW+2*MINUTE);
});

test('job-side eligibility requires actual quality evidence and never explains blocked capacity as no demand',async()=>{
  const s=start({deny:true});await s.tick();s.setNow(NOW+MINUTE);await s.tick();
  const row=s.rows().find(r=>r.accountKey==='one');
  assert.equal(row.minutesEligible,0);assert.notEqual(row.leftoverReason,'no-demand');
  s.setBlocked(false);s.setNow(NOW+2*MINUTE);await s.tick();
  assert.equal(s.rows().find(r=>r.accountKey==='one').minutesEligible,1);
});

test('failed publication cannot advance accounting; restart resumes durable window counters and reset latches',async()=>{
  const s=start();await s.tick();s.setNow(NOW+MINUTE);await s.tick();
  const before=s.rows();s.setFail(true);s.setNow(NOW+2*MINUTE);await s.tick();
  assert.deepEqual(s.rows(),before);
  s.setFail(false);
  const restarted=start({h:s,now:NOW+2*MINUTE});await restarted.tick();
  assert.equal(restarted.rows().find(r=>r.accountKey==='one').minutesEligible,3);
  restarted.setNow(NOW+84*HOUR);const next=restarted.feed();
  for(const a of next.accounts){a.weekly={used:.01,resetsAt:NOW+84*HOUR+7*24*HOUR};a.fiveHour.resetsAt=NOW+85*HOUR;}
  await restarted.tick(next);
  const old=restarted.rows().find(r=>r.accountKey==='one'&&r.closed);
  assert.equal(old.finalUnusedAtReset,80);assert.equal(old.minutesEligible,3);assert.equal(old.leftoverReason,'feed-gap');
});

test('missing feed account stays in its known reset window and never fabricates a second unknown window',async()=>{
  const s=start();await s.tick();s.setNow(NOW+MINUTE);await s.tick(s.feed({missing:['one']}));
  const rows=s.rows().filter(r=>r.accountKey==='one');
  assert.equal(rows.length,1);assert.equal(rows[0].status,'feed-unknown');assert.equal(rows[0].leftoverReason,'feed-gap');
  assert.equal(rows[0].minutesEligible,1);
});

test('native burn expiry is visible in job diagnostics and persisted scorecard burn windows',async()=>{
  const s=start();s.cfg.burn={accountKeys:['one'],mode:'exclusive',expiresAt:new Date(NOW+MINUTE).toISOString()};
  await s.tick();s.setNow(NOW+MINUTE);await s.tick();
  assert.deepEqual(s.rows().find(r=>r.accountKey==='one').burnWindows,[{from:NOW,to:NOW+MINUTE,mode:'exclusive'}]);
  assert.equal(s.quota.status(companyId).burn.status,'expired');assert.match(s.quota.status(companyId).burn.warning,/inactive.*past/);
  assert.ok(s.logs.some(l=>l.details.reason==='burn-exclusive'));
  assert.ok(s.logs.some(l=>l.details.reason==='burn-expired'));
});

for (const shared of [false,true]) test(`exclusive burn preserves eligibility in a non-fenced pool (${shared?'shared':'disjoint'} membership)`,async()=>{
  const s=start();s.cfg.burn={accountKeys:['two'],mode:'exclusive',expiresAt:new Date(NOW+10*MINUTE).toISOString()};
  if (!shared) delete s.cfg.router.accounts[0].pools.builder;
  await s.tick();s.setNow(NOW+MINUTE);await s.tick();
  const row=s.rows().find(r=>r.accountKey==='one');
  assert.equal(row.minutesEligible,2);
  assert.equal(row.minutesEligibleUnpicked,1);
  assert.equal(row.leftoverReason,'no-demand');
});

test('an unfenced but policy-blocked membership cannot make a burn-fenced account eligible',async()=>{
  const s=start();s.cfg.burn={accountKeys:['two'],mode:'exclusive',expiresAt:new Date(NOW+10*MINUTE).toISOString()};
  s.cfg.roles.excludeFamilies={thinker:['sol']};
  await s.tick();s.setNow(NOW+MINUTE);await s.tick();
  const row=s.rows().find(r=>r.accountKey==='one');
  assert.equal(row.minutesEligible,0);
  assert.equal(row.minutesEligibleUnpicked,0);
  assert.notEqual(row.leftoverReason,'no-demand');
});

test('exclusive burn non-targets cannot accumulate eligible-unpicked minutes or a no-demand explanation',async()=>{
  const s=start();s.cfg.burn={accountKeys:['one'],mode:'exclusive',expiresAt:new Date(NOW+10*MINUTE).toISOString()};
  await s.tick();s.setNow(NOW+MINUTE);await s.tick();
  const row=s.rows().find(r=>r.accountKey==='two');
  assert.equal(row.minutesEligible,0);assert.equal(row.minutesEligibleUnpicked,0);assert.notEqual(row.leftoverReason,'no-demand');
  s.setNow(NOW+10*MINUTE);await s.tick();
  assert.equal(s.rows().find(r=>r.accountKey==='two').minutesEligible,2,'after expiry the gap-capped ordinary eligibility returns');
});

test('excluded rows persisted by an earlier build are dropped from the view and the next tick',async()=>{
  const s=start();await s.tick();
  const key=JSON.stringify(s.keyFor(companyId)),saved=s.store.get(key);
  const leaked={...structuredClone(saved.scorecard.windows[0]),accountKey:'other-company',prefix:'other-company',status:'excluded-by-policy',pctUsedNow:40};
  saved.scorecard.windows.push(leaked);s.store.set(key,saved);
  const restarted=createQuotaRefresh({state:s.state,logger:s.logger,keyFor:s.keyFor,clock:()=>NOW+MINUTE,getPolicy:()=>policy(NOW+MINUTE)});
  assert.equal(scorecardView(saved).rows.some(r=>r.accountKey==='other-company'),false,'legacy row hidden before the next tick');
  await restarted.refresh(companyId,s.cfg,{feed:s.feed(),ledger:new Map()});
  assert.equal(s.store.get(key).scorecard.windows.some(r=>r.accountKey==='other-company'),false,'legacy row pruned on the next tick');
  assert.ok(restarted.scorecard(companyId).rows.some(r=>r.accountKey==='one'));
});
