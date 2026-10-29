import test from 'node:test';
import assert from 'node:assert/strict';
import { routeDecision, routerDiagnostics, taskKeyKind } from '../src/router.mjs';
import { snapshotAccountView } from '../src/views.mjs';

const now = Date.parse('2026-10-29T12:00:00Z');
const mkAccount = (overrides = {}) => ({ weeklyUsed: .4, weeklyResetsAtMs: now + 72 * 3600000, quality: 'live', observedAtMs: now, credentialReady: true, measuredRatePerHour: .002, eligible: true, inFlightBase: 0, ...overrides });
const mk = (options = {}) => {
  const accounts = {a: mkAccount(), b: mkAccount({measuredRatePerHour: .004}), ...(options.accounts ?? {})};
  for (const [key, a] of Object.entries(accounts)) a.view = snapshotAccountView(key, a, {nowMs: now});
  const ids = options.ids ?? ['a', 'b'];
  const candidates = ids.map(id => ({member: {id}, runtimeConfig: {model: `${id}/model`}, notes: []}));
  const params = {pool: {id: 'host-pool-id', pluginKey: 'togetherweown.model-capacity', name: 'builder', members: candidates.map(c => c.member), thresholdPercent: 90}, candidates, memberOrder: options.memberOrder ?? ids, taskKey: options.taskKey ?? 'work', now: new Date(now).toISOString(), ...(options.pin ? {pinnedMemberId: options.pin} : {})};
  const snapshot = {atMs: now, accounts, memberIndex: Object.fromEntries(['a', 'b'].map(id => [id, {accountKey: id, poolKey: 'builder'}])), poolRoles: {builder: 'doer'}};
  const config = {router: {enabled: true, accounts: [{accountKey:'a', prefix:'a', pools:{builder:{probeEligible:true}}}, {accountKey:'b', prefix:'b', pools:{builder:{probeEligible:false}}}]}};
  return {params, snapshot, config};
};
const route = ({params, snapshot, config}) => routeDecision(params, snapshot, config);

test('highest deficit wins and ties are deterministic without depending on host cursor', () => {
  const f = mk(); assert.deepEqual(route(f), {kind:'selected', memberId:'a'});
  const tie = mk({accounts:{b:mkAccount() }, ids:['b','a']});
  assert.equal(route(tie).memberId, 'a');
});
test('pins override ranking; ineligible pins wait and unmapped pins never switch', () => {
  const f = mk({pin:'b'}); assert.equal(route(f).memberId, 'b');
  f.snapshot.accounts.b.eligible = false; f.snapshot.accounts.b.skipReason = 'weekly-exhausted'; f.snapshot.accounts.b.nextEligibleAtMs = now + 7200000; f.snapshot.accounts.b.weeklyResetsAtMs = now + 7200000;
  assert.deepEqual(route(f), {kind:'exhausted', retryAt:new Date(now+7200000).toISOString(), skipped:{b:'weekly-exhausted'}});
  delete f.snapshot.memberIndex.b; f.config.router.accounts = f.config.router.accounts.filter(a => a.accountKey !== 'b');
  assert.deepEqual(route(f), {kind:'exhausted', retryAt:new Date(now+60000).toISOString(), skipped:{b:'unmapped-member'}});
});
test('precedence keeps zero and invalid pools loud before disabled and stale waits', () => {
  const f = mk(); f.params.candidates=[]; f.config.router.enabled=false;
  assert.deepEqual(route(f), {kind:'unavailable', skipped:{}});
  f.params.candidates = [{member:{id:'a'},runtimeConfig:{model:'a/model'}}];
  assert.deepEqual(route(f), {kind:'exhausted', retryAt:new Date(now+60000).toISOString(), skipped:{a:'router-disabled'}});
  f.params.pool.pluginKey='wrong'; assert.deepEqual(route(f), {kind:'unavailable', skipped:{a:'unmapped-member'}});
  f.params.pool.pluginKey='togetherweown.model-capacity'; f.config.router.enabled=true; f.params.pinnedMemberId='missing';
  assert.equal(route(f).kind,'unavailable');
});
test('stale snapshot waits all candidates; stale individual does not block fresh candidate', () => {
  const f=mk(); f.snapshot=null;
  assert.deepEqual(route(f), {kind:'exhausted',retryAt:new Date(now+60000).toISOString(),skipped:{a:'quota-snapshot-stale', b:'quota-snapshot-stale'}});
  const g=mk(); g.snapshot.accounts.a.quality='unknown'; assert.equal(route(g).memberId,'b');
});
test('weekly and five-hour credible resets outrank unknown or expired readings', () => {
  const f=mk({accounts:{a:mkAccount({eligible:false,skipReason:'weekly-exhausted',weeklyUsed:1, weeklyResetsAtMs:now+7200000}),b:mkAccount({eligible:false,skipReason:'five-hour-exhausted',fiveHourUsed:1,fiveHourResetsAtMs:now+3600000})}});
  assert.deepEqual(route(f),{kind:'exhausted',retryAt:new Date(now+3600000).toISOString(),skipped:{a:'weekly-exhausted',b:'five-hour-exhausted'}});
  f.snapshot.accounts.b.quality='unknown'; assert.equal(route(f).retryAt,new Date(now+7200000).toISOString());
});
test('drop detection uses memberOrder, suppresses pin and ambiguous single survivor', () => {
  const f=mk({memberOrder:['a','b','c']}); assert.deepEqual(routerDiagnostics(f.params,f.snapshot).droppedMemberIds,['c']); assert.equal(routerDiagnostics(f.params,f.snapshot).level,'warn');
  f.params.pinnedMemberId='a'; f.params.candidates=f.params.candidates.slice(0,1);
  assert.equal(routerDiagnostics(f.params,f.snapshot).droppedSuppressed,'pinned'); assert.equal(routerDiagnostics(f.params,f.snapshot).level,'info');
  delete f.params.pinnedMemberId; assert.equal(routerDiagnostics(f.params,f.snapshot).droppedSuppressed,'ambiguous-single-candidate');
});
test('pool identity is derived from memberIndex and disagreement fails closed', () => {
  const f=mk(); f.params.pool.name='editable-label'; assert.equal(route(f).memberId,'a'); assert.equal(routerDiagnostics(f.params,f.snapshot).poolNameMismatch,true);
  f.snapshot.memberIndex.b.poolKey='thinker'; assert.equal(route(f).kind,'exhausted');
  assert.equal(routerDiagnostics(f.params,f.snapshot).level,'error');
});
test('task kinds apply per-membership probes only to heartbeat and lifecycle', () => {
  assert.equal(taskKeyKind('__heartbeat__'),'heartbeat'); assert.equal(taskKeyKind('lifecycle:hi'),'lifecycle');
  assert.equal(taskKeyKind('12345678-1234-1234-1234-123456789abc'),'issue'); assert.equal(taskKeyKind('other'),'other'); assert.equal(taskKeyKind(undefined),'other');
  const f=mk({taskKey:'lifecycle:hi',accounts:{b:mkAccount({measuredRatePerHour:0})}}); assert.equal(route(f).memberId,'a');
  f.params.taskKey='12345678-1234-1234-1234-123456789abc'; assert.equal(route(f).memberId,'b');
});
test('burn priority expires and heartbeat does not gain burn priority', () => {
  const f=mk({accounts:{b:mkAccount({burn:{active:true,expiresAtMs:now+3600000}})}}); assert.equal(route(f).memberId,'b');
  f.params.taskKey='__heartbeat__'; assert.equal(route(f).memberId,'a');
  f.params.taskKey='work'; f.snapshot.accounts.b.burn.expiresAtMs=now-1; assert.equal(route(f).memberId,'a');
});
test('reserve tracks hard cap and thresholdPercent is ignored', () => {
  const f=mk({accounts:{a:mkAccount({weeklyUsed:.96}),b:mkAccount({eligible:false,skipReason:'weekly-exhausted'})}});
  for (const threshold of [0,90,100]) { f.params.pool.thresholdPercent=threshold; assert.equal(route(f).memberId,'a'); }
  const g=mk({accounts:{a:mkAccount({weeklyUsed:.996}),b:mkAccount({eligible:false,skipReason:'weekly-exhausted'})}}); assert.equal(route(g).kind,'exhausted');
});
test('pure synchronous decision works with deeply frozen input', () => {
  const f=mk(); const freeze = o => {if(o && typeof o==='object' && !Object.isFrozen(o)) {Object.values(o).forEach(freeze); Object.freeze(o);} return o;};
  freeze(f); const result=route(f); assert.equal(result.kind,'selected'); assert.equal(result instanceof Promise,false);
});

test('pace held members wait for catch-up, never weekly reset or one-run escape', () => {
  const f=mk({ids:['a'],accounts:{a:mkAccount({eligible:false,skipReason:'pace-held',nextEligibleAtMs:now+10*60000})}});
  assert.deepEqual(route(f),{kind:'exhausted',retryAt:new Date(now+10*60000).toISOString(),skipped:{a:'pace-held'}});
});
test('exclusive burn holds other members and wakes no later than expiry', () => {
  const f=mk({accounts:{b:mkAccount({eligible:false,skipReason:'quality-floor',nextEligibleAtMs:now+7200000,burn:{active:true,expiresAtMs:now+3600000}})}});
  f.config.burn={mode:'exclusive'};
  assert.deepEqual(route(f),{kind:'exhausted',retryAt:new Date(now+3600000).toISOString(),skipped:{a:'burn-not-target',b:'quality-floor'}});
});
test('an unknown quality label never grants a usable quota reading', () => {
  const f=mk({ids:['a'], accounts:{a:mkAccount({quality:null})}});
  assert.equal(route(f).skipped.a,'account-reading-stale');
});
test('two exhausted windows on one member wait until both have reset', () => {
  const f=mk({ids:['a'],accounts:{a:mkAccount({weeklyUsed:1,weeklyResetsAtMs:now+3600000,fiveHourUsed:1,fiveHourResetsAtMs:now+7200000})}});
  assert.equal(route(f).retryAt,new Date(now+7200000).toISOString());
});

test('stale-only retry backs off across ticks and caps at thirty minutes', () => {
  for (const [elapsed, delay] of [[0,5],[5,10],[10,20],[15,30],[120,30]]) {
    const f=mk({ids:['a'],accounts:{a:mkAccount({quality:'unknown',staleSinceMs:now-elapsed*60000})}});
    assert.equal(route(f).retryAt,new Date(now+delay*60000).toISOString());
  }
});
test('probe restriction is based on configured membership even if host drops the probe member', () => {
  const f=mk({ids:['b'],taskKey:'__heartbeat__',memberOrder:['a','b']});
  assert.deepEqual(route(f),{kind:'exhausted',retryAt:new Date(now+300000).toISOString(),skipped:{b:'role-excluded'}});
});
test('probe pool with no configured probe members falls back to normal ranking', () => {
  const f=mk({ids:['b'],taskKey:'__heartbeat__'});
  f.config.router.accounts[0].pools.builder.probeEligible=false;
  assert.equal(route(f).memberId,'b');
});
test('overlay finish after a post-tick run was already finished does not subtract base', async () => {
  const {createOverlay,overlayStart,overlayFinish,overlayCount} = await import('../src/overlay.mjs');
  let s=overlayStart(createOverlay(),'a','r2'); s=overlayFinish(s,'a','r2'); s=overlayFinish(s,'a','r2');
  assert.equal(overlayCount(s,'a',1),1);
});

test('burn target stops being active at configured used-percentage boundary', () => {
  const f=mk({accounts:{b:mkAccount({weeklyUsed:.7,burn:{active:true,expiresAtMs:now+3600000}})}});
  f.config.burn={endAtUsedPct:.7,mode:'exclusive'};
  assert.equal(route(f).memberId,'a');
});

test('exclusive burn at the default hard cap expires rather than excluding healthy accounts', () => {
  const f=mk({accounts:{b:mkAccount({weeklyUsed:.995,burn:{active:true,expiresAtMs:now+3600000}})}});
  f.config.burn={mode:'exclusive'};
  assert.equal(route(f).memberId,'a');
});

test('role and task admission gates remain enforced even if snapshot eligible flag drifts', () => {
  const f=mk(); f.snapshot.accounts.a.view.roleEligible=false; f.snapshot.accounts.b.view.taskFeasible=false;
  const r=route(f); assert.equal(r.kind,'exhausted');
  assert.deepEqual(r.skipped,{a:'role-excluded',b:'outcome-gated'});
});
test('an empty pool identity is malformed and fails closed', () => {
  const f=mk(); f.params.pool.id=''; assert.equal(route(f).kind,'unavailable');
});

test('missing snapshot eligibility never admits a member', () => {
  const f=mk({ids:['a']}); delete f.snapshot.accounts.a.eligible;
  assert.equal(route(f).kind,'exhausted'); assert.equal(route(f).skipped.a,'account-reading-stale');
});

test('in-flight projection enforces the five-hour hard cap before its meter catches up', () => {
  const f=mk({ids:['a'],accounts:{a:mkAccount({fiveHourUsed:.98,fiveHourResetsAtMs:now+3600000,inFlightBase:1,meanRunFiveHourPct:.02})}});
  assert.deepEqual(route(f),{kind:'exhausted',retryAt:new Date(now+3600000).toISOString(),skipped:{a:'five-hour-exhausted'}});
});
