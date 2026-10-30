import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { buildManifest } from '../src/manifest.mjs';
import { normalizeRegistry, validatePoolMember } from '../src/registry.mjs';
import { validateConfigShape } from '../src/plugin.mjs';
import { buildPoolPlanFromPolicy } from '../scripts/pool-plan.mjs';
import { planPoolSaga, applyPoolSaga, checkPoolDrift } from '../scripts/pool-saga.mjs';
import { syntheticRouterRequest } from '../src/quota-refresh.mjs';
import { buildQuotaSnapshot } from '../src/snapshot.mjs';
import { createRouterAdapter } from '../src/router.mjs';
import { aiConnectionPoolConfigSchema } from './fixtures/upstream-schemas/ai-connection-router.js';
import { foldPoolMemberEffort } from './fixtures/upstream-schemas/pool-effort.js';
import { NativeApi, options, registry, companyId, agentId, scratch } from './support/native-api.mjs';
import { NOW, quotaFeed, stateHarness } from './support/quota.mjs';

function explicitRegistry() {
  const raw = structuredClone(registry);
  for (const account of raw.accounts) for (const membership of Object.values(account.pools)) membership.effort = 'high';
  return raw;
}
const evidence = () => ({atMs:NOW, nowMs:NOW, roles:{minQuality:{doer:.5, thinker:.5, other:.5}, outcomeGate:{enabled:false}}, records:[],
  roleOf:()=>'doer', familyOf:r=>r.family, arms:[
    {armId:'terra-low', model:'terra', effort:'low', family:'terra', qFleet:.1, qFleetThinker:.1},
    {armId:'terra-high', model:'terra', effort:'high', family:'terra', qFleet:.9, qFleetThinker:.9},
    {armId:'sol-high', model:'sol', effort:'high', family:'sol', qFleet:.9, qFleetThinker:.9},
    {armId:'claude-high', model:'claude', effort:'high', family:'claude', qFleet:.8, qFleetThinker:.8},
    ...Array.from({length:6},(_,i)=>({armId:`filler-${i}`,model:`filler-${i}`,effort:'high',family:`filler-${i}`,qFleet:.8,qFleetThinker:.8})),
  ]});

function serverValidator(variant) {
  const ajv=new Ajv({allErrors:true});addFormats(ajv);ajv.addFormat('secret-ref',{validate:()=>true});
  return ajv.compile(buildManifest({variant}).instanceConfigSchema);
}

// Dropping the membership schema/allowlist or failing to carry the value would
// make an operator's finite-floor pool impossible to configure or regenerate.
test('both variants accept explicit membership effort through server and worker validation', () => {
  const config={router:explicitRegistry()};
  for (const variant of ['clean','transitional']) {
    const valid=serverValidator(variant);
    assert.equal(valid(config),true,JSON.stringify(valid.errors));
  }
  assert.deepEqual(validateConfigShape(config),[]);
  const normalized=normalizeRegistry(config.router);
  assert.equal(normalized.accounts[0].pools.builder.effort,'high');
  assert.equal(normalized.accounts[1].pools.builder.effort,'high');
  assert.equal(Object.hasOwn(normalizeRegistry(registry).accounts[0].pools.builder,'effort'),false,'omission remains an unattested runner default, never a guessed effort');
});

// Upstream looks up the PREFIXED id, not the base catalog id: Codex falls back
// to minimal/low/medium/high/xhigh; Claude to low/medium/high. In particular,
// catalog support for bare-model max/ultra does not prove prefixed support.
test('registry rejects efforts the native prefix-aware path would silently omit', () => {
  for (const [accountIndex,good,bad] of [
    [0,['minimal','low','medium','high','xhigh'],[null,0,'',' high','HIGH','max','ultra','none']],
    [1,['low','medium','high'],[null,0,'','high ','minimal','xhigh','max','ultra']],
  ]) {
    for (const effort of good) {
      const raw=explicitRegistry();raw.accounts[accountIndex].pools.builder.effort=effort;
      assert.equal(normalizeRegistry(raw).accounts[accountIndex].pools.builder.effort,effort);
      const account=raw.accounts[accountIndex];
      const member={binding:{provider:account.provider},profile:{provider:account.harnessProfile,...(account.harnessProfile==='acpx'?{acpxAgent:'claude'}:{}),model:`${account.prefix}/${account.pools.builder.model}`,effort}};
      assert.equal(foldPoolMemberEffort(member,'paperclip_runner').config.modelReasoningEffort,effort,'every accepted prefixed effort must actually fold upstream');
    }
    for (const effort of bad) {
      const raw=explicitRegistry();raw.accounts[accountIndex].pools.builder.effort=effort;
      assert.throws(()=>normalizeRegistry(raw),/effort/,`${accountIndex}: ${JSON.stringify(effort)}`);
      assert.ok(validateConfigShape({router:raw}).some(e=>e.includes('effort')));
    }
  }
});

test('both server schemas reject malformed effort values and non-folding Claude efforts', () => {
  for (const variant of ['clean','transitional']) {
    const valid=serverValidator(variant);
    for (const [accountIndex,effort] of [[0,null],[0,5],[0,''],[0,' high'],[0,'max'],[0,'ultra'],[1,'minimal'],[1,'xhigh']]) {
      const config={router:explicitRegistry()};config.router.accounts[accountIndex].pools.builder.effort=effort;
      assert.equal(valid(config),false,`${variant}: ${accountIndex}/${JSON.stringify(effort)}`);
    }
  }
});

test('planned and synthetic profiles preserve the configured effort and conform to upstream schemas', async () => {
  const raw=explicitRegistry(), plan=await planPoolSaga({...options(new NativeApi()),registry:raw});
  for (const pool of plan.pools) {
    const parsed=aiConnectionPoolConfigSchema.parse(pool.config);
    for (const member of parsed.members) {
      assert.equal(member.profile.effort,'high');
      assert.equal(foldPoolMemberEffort(member,'paperclip_runner').config.modelReasoningEffort,'high','upstream effort-fold block receives a saved effort with NO issue override');
    }
  }
  const request=syntheticRouterRequest(normalizeRegistry(raw),'builder',NOW);
  const {id,companyId,pluginKey,revision,...poolConfig}=request.pool;
  aiConnectionPoolConfigSchema.parse(poolConfig);
  for (const candidate of request.candidates) {
    assert.equal(candidate.member.profile.effort,'high');
    assert.equal(candidate.runtimeConfig.effort,'high','shadow cannot simulate an omitted runner default when the registry fixes effort');
  }
  const codex=plan.pools[0].config.members[0], claude=plan.pools[0].config.members[1];
  assert.equal(foldPoolMemberEffort(codex,'codex_local').config.modelReasoningEffort,'high');
  for (const [member,effort] of [[codex,'max'],[codex,'ultra'],[claude,'xhigh'],[claude,'max']]) {
    const invalid={...member,profile:{...member.profile,effort}};
    assert.equal(foldPoolMemberEffort(invalid,'paperclip_runner').config.modelReasoningEffort,undefined,'native upstream silently discards this prefixed effort');
    const account=raw.accounts.find(a=>a.harnessProfile===member.profile.provider);
    assert.throws(()=>validatePoolMember(invalid,account),/effort/,'inspection must not attest a silently discarded effort');
  }
});

test('generation cannot qualify an explicit effort using a stronger sibling effort', async () => {
  const raw=explicitRegistry();raw.accounts[0].pools.builder.effort='low';
  const plan=await planPoolSaga({...options(new NativeApi()),registry:raw});
  const rows=plan.connections.map(c=>({id:c.identity.connectionId,grantId:c.identity.grantId,name:c.inputWithoutSecret.name,provider:c.inputWithoutSecret.provider,method:'api_key',ownership:'shared',status:'connected'}));
  const policyPlan=buildPoolPlanFromPolicy(raw,rows,evidence());
  assert.deepEqual(policyPlan.excluded,[{accountKey:'one',poolKey:'builder',reason:'excluded-by-policy'}]);
  assert.deepEqual(policyPlan.pools.find(p=>p.config.name==='builder').config.members.map(m=>m.profile.model),['two/claude']);
  raw.accounts[0].pools.builder.effort='high';
  assert.deepEqual(buildPoolPlanFromPolicy(raw,rows,evidence()).excluded,[]);
});

test('effort drift is read-only detectable and reapplying a disabled pool preserves the configured effort', async t => {
  const api=new NativeApi(), raw=explicitRegistry(), opts={...options(api),registry:raw,activate:false};
  await applyPoolSaga({...opts,journalPath:await scratch(t)});
  for (const mutate of [m=>{delete m.profile.effort;},m=>{m.profile.effort='low';}]) {
    const pool=api.pools.find(p=>p.name==='builder');mutate(pool.members[0]);api.writes=[];
    const drift=await checkPoolDrift({...opts,expectedEnabled:false});
    assert.equal(drift.ok,false);
    assert.ok(drift.drift.some(d=>d.type==='pool-drift'&&d.poolKey==='builder'));
    assert.deepEqual(api.writes,[]);
    await applyPoolSaga({...opts,journalPath:await scratch(t)});
    assert.equal(api.pools.find(p=>p.name==='builder').members[0].profile.effort,'high');
    assert.equal((await checkPoolDrift({...opts,expectedEnabled:false})).ok,true);
  }
  api.writes=[];
  await applyPoolSaga({...opts,journalPath:await scratch(t)});
  assert.deepEqual(api.writes,[],'a stable saved effort does not fight apply idempotency');
});

function attest(pool,raw) {
  const normalized=normalizeRegistry(raw);
  return {...raw.pools.find(p=>p.poolKey===pool.name),poolId:pool.id,pluginKey:pool.pluginKey,expectedRevision:pool.revision,
    expectedMemberOrder:pool.members.map(m=>m.id),members:pool.members.map(m=>({memberId:m.id,accountKey:normalized.memberIndex[m.id].accountKey,connectionId:m.binding.connectionId,grantId:m.binding.grantId}))};
}
function hostRequest(pool,overrides={}) {
  return {companyId,agentId,pool,taskKey:'work',memberOrder:pool.members.map(m=>m.id),
    candidates:pool.members.map(member=>({member,runtimeConfig:foldPoolMemberEffort(member,'paperclip_runner',overrides).config,notes:[]})),now:new Date(NOW).toISOString()};
}

test('generated default effort can pass runtime floors, and an effort save requires revision re-attestation', async t => {
  const api=new NativeApi(), raw=explicitRegistry(), opts={...options(api),registry:raw,activate:false};
  await applyPoolSaga({...opts,journalPath:await scratch(t)});
  const saved=structuredClone(api.pools.find(p=>p.name==='builder'));
  const config={router:{...raw,enabled:true,pools:[attest(saved,raw),raw.pools[1]]},roles:evidence().roles};
  const snapshot=buildQuotaSnapshot({registry:normalizeRegistry(raw),feed:quotaFeed(),nowMs:NOW,config}).snapshot;
  const callback=createRouterAdapter({getConfig:()=>config,getSnapshot:()=>snapshot,getPolicy:evidence,getOverlay:()=>({}),logger:stateHarness().logger});
  assert.equal(callback(hostRequest(saved)).kind,'selected','no issue effort override or manual saved-profile edit is needed');
  const low=callback(hostRequest(saved,{modelReasoningEffort:'low'}));
  assert.equal(low.kind,'exhausted');assert.ok(Object.values(low.skipped).every(reason=>reason==='quality-floor'),'a real weak/unscored runtime override still fails closed');
  raw.accounts[0].pools.builder.effort='xhigh';
  await applyPoolSaga({...opts,journalPath:await scratch(t)});
  const changed=api.pools.find(p=>p.name==='builder');
  assert.ok(changed.revision>saved.revision);
  assert.equal((await checkPoolDrift({...opts,expectedEnabled:false})).ok,true);
  assert.equal(callback(hostRequest(changed)).kind,'unavailable','the OLD attestation cannot authorize a profile effort save, even against a fresh quota snapshot');
  config.router.pools[0]=attest(changed,raw);
  const selected=callback(hostRequest(changed));
  assert.equal(selected.kind,'selected');
  assert.equal(selected.memberId,changed.members[1].id,'an unscored xhigh effort cannot borrow high quality evidence after re-attestation');
});
