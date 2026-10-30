import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRegistry, memberIdFor, validatePoolMember } from '../src/registry.mjs';

const fixture = () => ({companyId:'10000000-0000-4000-8000-000000000001', ownerUserId:'20000000-0000-4000-8000-000000000002', pools:[{poolKey:'builder',role:'doer'},{poolKey:'thinker',role:'thinker'}], accounts:[{accountKey:'codex-1',prefix:'codex1',provider:'openai',protocol:'responses',harnessProfile:'codex',connectionName:'codex-1',pools:{builder:{model:'gpt-6.1-terra',probeEligible:true},thinker:{model:'gpt-6.1-sol'}}}]});

test('registry derives deterministic pool-scoped UUIDs and role joins', () => {
  const r=normalizeRegistry(fixture()); const a=memberIdFor('builder','codex-1'), b=memberIdFor('thinker','codex-1');
  assert.match(a,/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); assert.notEqual(a,b);
  assert.deepEqual(r.memberIndex[a],{accountKey:'codex-1',poolKey:'builder'}); assert.deepEqual(r.poolRoles,{builder:'doer',thinker:'thinker'});
  assert.equal(r.accounts[0].pools.thinker.probeEligible,false); assert.equal(memberIdFor('builder','codex-1'),a);
});

test('registry rejects ambiguous identities and invalid protocol tuples', () => {
  for (const mutate of [
    r=>r.accounts.push({...structuredClone(r.accounts[0]),accountKey:'other',connectionName:'other'}),
    r=>r.accounts[0].protocol='chat',
    r=>r.accounts[0].harnessProfile='acpx',
    r=>{Object.assign(r.accounts[0],{provider:'anthropic',protocol:'messages',harnessProfile:'acpx'});},
    r=>r.accounts[0].probeEligible=true,
    r=>r.accounts[0].pools.builder.model='codex1/already-prefixed',
  ]) {const r=fixture(); mutate(r); assert.throws(()=>normalizeRegistry(r));}
  const excluded=fixture(); excluded.accounts[0].harnessProfile='opencode'; assert.throws(()=>normalizeRegistry(excluded),/lane-excluded-by-policy/);
  const allowed=fixture(); Object.assign(allowed.accounts[0],{provider:'anthropic',protocol:'messages',harnessProfile:'acpx'}); allowed.allowMessages=true; assert.doesNotThrow(()=>normalizeRegistry(allowed));
});

test('pool inspection rejects unprefixed models and incomplete bindings', () => {
  const a=fixture().accounts[0]; const member={binding:{mode:'shared',provider:'openai',method:'api_key',connectionId:'10000000-0000-4000-8000-000000000001',grantId:'20000000-0000-4000-8000-000000000002'},profile:{provider:'codex',model:'codex1/gpt-6.1-terra'}};
  assert.doesNotThrow(()=>validatePoolMember(member,a));
  assert.throws(()=>validatePoolMember({...member,profile:{...member.profile,model:'gpt-6.1-terra'}},a));
  assert.throws(()=>validatePoolMember({...member,binding:{...member.binding,grantId:undefined}},a));
});

test('normalization exports unambiguous account-prefix lookups', () => {
  const r = normalizeRegistry(fixture());
  assert.deepEqual(r.prefixByAccount, {'codex-1':'codex1'});
  assert.deepEqual(r.accountByPrefix, {codex1:'codex-1'});
});

test('rejects duplicate connection names and invalid pool roles', () => {
  const duplicate = fixture(); duplicate.accounts.push({...structuredClone(duplicate.accounts[0]), accountKey:'other', prefix:'other'});
  assert.throws(() => normalizeRegistry(duplicate), /duplicate/);
  const badRole = fixture(); badRole.pools[0].role = 'invalid';
  assert.throws(() => normalizeRegistry(badRole), /pool/);
});

test('member validation rejects responsible-user bindings and harness mismatches', () => {
  const a = fixture().accounts[0];
  const binding = {mode:'shared',provider:'openai',method:'api_key',connectionId:'10000000-0000-4000-8000-000000000001',grantId:'20000000-0000-4000-8000-000000000002'};
  const codex = {binding,profile:{provider:'codex',model:'codex1/model'}};
  assert.throws(() => validatePoolMember({...codex,binding:{...binding,mode:'responsible_user'}},a),/binding/);
  assert.throws(() => validatePoolMember({...codex,profile:{...codex.profile,acpxAgent:'claude'}},a),/harness/);
  const anthropic = {...a,provider:'anthropic',harnessProfile:'acpx'};
  const acpx = {binding:{...binding,provider:'anthropic'},profile:{provider:'acpx',model:'codex1/model'}};
  assert.throws(() => validatePoolMember(acpx,anthropic),/harness/);
  assert.throws(() => validatePoolMember({...acpx,profile:{...acpx.profile,acpxAgent:'grok'}},anthropic),/harness/);
});


test('registry rejects non-UUID identities and explicit null membership flags', () => {
  for (const mutate of [r=>r.companyId='bad',r=>r.ownerUserId='bad',r=>r.accounts[0].pools.builder.probeEligible=null]) {
    const r=fixture(); mutate(r); assert.throws(()=>normalizeRegistry(r));
  }
});

test('shared normalization rejects the same schema violations as plugin config', () => {
  for (const mutate of [r=>r.pools[0].poolKey='x'.repeat(161),r=>r.accounts[0].connectionName='x'.repeat(161),r=>r.accounts[0].feedExempt=null,r=>r.extra=true,r=>r.hardCapWeekly=2]) {
    const r=fixture(); mutate(r); assert.throws(()=>normalizeRegistry(r));
  }
});
