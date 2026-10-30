import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as generator from '../scripts/generate-pool.mjs';

import { NativeApi, registry, verdicts, batch, companyId, ownerUserId, agentId, secondAgent, options, scratch } from './support/native-api.mjs';
const copy=x=>structuredClone(x);

// Removing provisional discovery breaks fresh-target dry-run, not just its text.
test('U18 fresh-target dry plan contains full bindings, acpx and per-agent verdicts with zero writes',async()=>{
  const api=new NativeApi();
  const plan=await generator.planPoolSaga(options(api));
  assert.equal(plan.pools.length,2);
  assert.equal(plan.pools[0].config.members[1].profile.acpxAgent,'claude');
  for(const p of plan.pools) for(const m of p.config.members) { assert.match(m.binding.connectionId,/^[a-f0-9-]{36}$/);assert.match(m.binding.grantId,/^[a-f0-9-]{36}$/); }
  assert.equal(plan.selectableVerdicts.length,3);
  assert.ok(plan.selectableVerdicts.every(v=>v.selectable===false && v.reason==='pending-connection'));
  assert.deepEqual(plan.sessionBlockers,[]);
  assert.deepEqual(api.writes,[]);
  assert.equal(plan.connections[0].inputWithoutSecret.routing.kind,'gateway');
  assert.deepEqual(plan.connections[0].inputWithoutSecret.routing.models,[{id:'one/sol'},{id:'one/terra'}]);
  assert.doesNotMatch(JSON.stringify(plan),/apiKey|PRIVATE_API_ERROR/);
});

test('apply uses inline grants/installs, checks disabled pools, then activates and binds; rerun is zero writes',async t=>{
  const api=new NativeApi(),journalPath=await scratch(t);
  await generator.applyPoolSaga({...options(api),journalPath});
  assert.equal(api.connections.length,2);
  assert.ok(api.pools.every(p=>p.enabled));
  assert.ok(api.agents.get(agentId).runtimeConfig.aiConnection.connectionId===api.pools.find(p=>p.name==='builder').id);
  assert.ok(api.writes.filter(w=>w.type==='create').every(w=>w.input.ownership==='shared' && w.input.allAgents===false));
  assert.deepEqual(api.connections[0].installs,[{targetType:'agent',targetId:agentId},{targetType:'agent',targetId:secondAgent}]);
  api.writes=[];
  await generator.applyPoolSaga({...options(api),journalPath:await scratch(t)});
  assert.deepEqual(api.writes,[]);
  const text=await readFile(journalPath,'utf8');assert.doesNotMatch(text,/apiKey|PRIVATE_API_ERROR/);assert.match(text,/intent/);assert.match(text,/complete/);
});

test('update path converges new-account growth and immutable-routing model changes on disabled pools',async t=>{
  const api=new NativeApi();
  const small=copy(registry);small.accounts.pop();
  await generator.applyPoolSaga({...options(api),registry:small,activate:false,journalPath:await scratch(t)});
  await generator.applyPoolSaga({...options(api),activate:false,journalPath:await scratch(t)});
  assert.equal(api.pools.find(p=>p.name==='builder').members.length,2);
  const changed=copy(registry);changed.accounts[0].pools.builder.model='terra2';
  await generator.applyPoolSaga({...options(api),registry:changed,activate:false,journalPath:await scratch(t)});
  const active=api.connections.filter(c=>c.name==='One');assert.equal(active.length,1);
  assert.deepEqual(active[0].routing.models,[{id:'one/sol'},{id:'one/terra2'}]);
  assert.equal(api.pools.find(p=>p.name==='builder').members[0].binding.connectionId,active[0].id);
  assert.equal((await generator.checkPoolDrift({...options(api),registry:changed,expectedEnabled:false})).ok,true);
});

test('session blockers appear in dry-run; apply requires explicit reset, re-lists before bind, then wakes natively',async t=>{
  const api=new NativeApi();api.sessions.set(agentId,[{taskKey:'issue:10000000-0000-4000-8000-000000000009'}]);
  const plan=await generator.planPoolSaga(options(api));assert.equal(plan.sessionBlockers.length,1);assert.deepEqual(api.writes,[]);
  await assert.rejects(generator.applyPoolSaga({...options(api),journalPath:await scratch(t)}),/session/);
  assert.deepEqual(api.writes,[]);
  await generator.applyPoolSaga({...options(api),sessionPlans:{[agentId]:'reset'},journalPath:await scratch(t)});
  const events=api.writes.map(w=>w.type);assert.ok(events.indexOf('reset')<events.indexOf('bind'));assert.ok(events.indexOf('bind')<events.indexOf('wake'));
  assert.equal(api.writes.find(w=>w.type==='wake').input.payload.issueId,'10000000-0000-4000-8000-000000000009');
  assert.equal(api.writes.find(w=>w.type==='wake').input.source,'on_demand');
});

test('R9 drift reports revoked grants, missing members, pool names, activation, plugin ownership and routing without writes',async t=>{
  const api=new NativeApi();await generator.applyPoolSaga({...options(api),activate:false,journalPath:await scratch(t)});
  api.pools.find(p=>p.name==='builder').members.pop();api.pools.find(p=>p.name==='thinker').pluginKey='wrong';api.connections[0].routing.models.pop();api.writes=[];
  const result=await generator.checkPoolDrift({...options(api),expectedEnabled:false});
  assert.equal(result.ok,false);for(const kind of ['missing-member','plugin-key-drift','connection-drift']) assert.ok(result.drift.some(d=>d.type===kind),kind);
  assert.deepEqual(api.writes,[]);
});

test('a mid-saga failure restores updated adopted pools and installs and deletes only this run creations',async t=>{
  const api=new NativeApi();await generator.applyPoolSaga({...options(api),activate:false,journalPath:await scratch(t)});
  const before=copy(api.pools);api.pools[0].thresholdPercent=80;const prior=copy(api.pools);
  api.fail=(type,input)=>type==='pool' && input.config.name==='thinker';
  // Change both pools so the second write fails after the first update.
  const changed=copy(registry);changed.accounts[0].pools.thinker.model='sol2';
  const journalPath=await scratch(t);
  await assert.rejects(generator.applyPoolSaga({...options(api),registry:changed,activate:false,journalPath}),e=>{assert.equal(e.journalPath,journalPath);assert.doesNotMatch(e.message,/PRIVATE/);return true;});
  api.fail=null;
  await generator.rollbackPoolSaga({api,journalPath});
  assert.deepEqual(api.pools.map(({revision,...p})=>p).sort((a,b)=>a.name.localeCompare(b.name)),prior.map(({revision,...p})=>p).sort((a,b)=>a.name.localeCompare(b.name)));
  assert.equal(api.connections.filter(c=>c.name==='One').length,1);
  assert.deepEqual(api.connections.find(c=>c.name==='One').routing.models,[{id:'one/sol'},{id:'one/terra'}]);
  assert.equal(api.connections.length,2);
  assert.equal(before.length,2);
});
