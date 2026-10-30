import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { manifest, enforceManifest } from '../src/manifest.mjs';
import { normalizeRegistry, memberIdFor } from '../src/registry.mjs';
import { validateConfigShape } from '../src/plugin.mjs';
import { config } from './support/quota.mjs';

import { verifiedConfig } from './support/verified-pools.mjs';
const fields=['poolId','pluginKey','expectedRevision','expectedMemberOrder','members'];
const compile=m=>{
  // Match upstream server/src/services/plugin-config-validator.ts, not a
  // hand-rolled substitute for server-side schema validation.
  const ajv=new Ajv({allErrors:true});addFormats(ajv);ajv.addFormat('secret-ref',{validate:()=>true});
  return ajv.compile(m.instanceConfigSchema);
};

test('both manifest schemas compile under upstream Ajv and accept verified and unverified pools',()=>{
  for(const m of [manifest,enforceManifest]) {
    const valid=compile(m);
    assert.equal(valid(config()),true,JSON.stringify(valid.errors));
    assert.equal(valid(verifiedConfig()),true,JSON.stringify(valid.errors));
  }
});

test('server schema rejects partial, mistyped and unknown verified fields',()=>{
  const mutations=[...fields.map(field=>c=>{delete c.router.pools[0][field];}),
    c=>{c.router.pools[0].poolId='bad';},c=>{c.router.pools[0].pluginKey='foreign';},
    c=>{c.router.pools[0].expectedRevision=-1;},c=>{c.router.pools[0].expectedRevision=1.5;},
    c=>{c.router.pools[0].expectedMemberOrder.push(c.router.pools[0].expectedMemberOrder[0]);},
    c=>{c.router.pools[0].expectedMemberOrder[0]='bad';},c=>{c.router.pools[0].members[0].connectionId='bad';},
    c=>{c.router.pools[0].members[0].grantId='bad';},c=>{c.router.pools[0].members[0].memberId='bad';},
    c=>{c.router.pools[0].members[0].secret='not-allowed';},c=>{delete c.router.pools[0].members[0].accountKey;},
  ];
  for(const m of [manifest,enforceManifest]) {
    const valid=compile(m);
    for(const mutate of mutations) {
      const c=verifiedConfig();mutate(c);
      assert.equal(valid(c),false,JSON.stringify(c.router.pools[0]));
      assert.notDeepEqual(validateConfigShape(c),[],JSON.stringify(c.router.pools[0]));
    }
  }
});

test('worker validation enforces verified member identity, set equality and binding uniqueness',()=>{
  assert.deepEqual(validateConfigShape(config()),[]);
  assert.deepEqual(validateConfigShape(verifiedConfig()),[]);
  const mutations=[
    c=>{c.router.pools[0].expectedMemberOrder.pop();},
    c=>{c.router.pools[0].members.pop();},
    c=>{c.router.pools[0].members[0].accountKey='not-in-registry';},
    c=>{c.router.pools[0].members[0].memberId=memberIdFor('thinker','one');c.router.pools[0].expectedMemberOrder[0]=memberIdFor('thinker','one');},
    c=>{c.router.pools[0].members[1].accountKey='one';},
    c=>{c.router.pools[0].members[1].connectionId=c.router.pools[0].members[0].connectionId;},
    c=>{c.router.pools[0].members[1].grantId=c.router.pools[0].members[0].grantId;},
    c=>{c.router.pools[1]={...c.router.pools[0],poolKey:'thinker',role:'thinker'};},
    c=>{const p=c.router.pools[1];Object.assign(p,c.router.pools[0],{poolKey:'thinker',role:'thinker',poolId:'40000000-0000-4000-8000-000000000002'});p.members=[{...p.members[1],memberId:memberIdFor('thinker','two')}];p.expectedMemberOrder=p.members.map(m=>m.memberId);},
  ];
  for(const mutate of mutations) {
    const c=verifiedConfig();mutate(c);
    assert.notDeepEqual(validateConfigShape(c),[],JSON.stringify(c.router.pools));
    assert.throws(()=>normalizeRegistry(c.router));
  }
});

test('normalized verified entries are copied and frozen, without freezing caller config',()=>{
  const c=verifiedConfig(),p=normalizeRegistry(c.router).pools[0];
  assert.deepEqual(p,c.router.pools[0]);
  for(const v of [p,p.members,p.members[0],p.expectedMemberOrder])assert.ok(Object.isFrozen(v));
  c.router.pools[0].members[0].connectionId='changed';
  assert.notEqual(p.members[0].connectionId,'changed');
});

test('example router has one shape-valid, registry-consistent fictitious attestation and unverified peers',async()=>{
  const {readFile}=await import('node:fs/promises');
  const c=JSON.parse(await readFile(new URL('../config.example.json',import.meta.url),'utf8'));
  assert.deepEqual(validateConfigShape({router:c.router}),[]);
  const pools=normalizeRegistry(c.router).pools;
  assert.equal(pools.filter(p=>p.poolId).length,1);
  assert.ok(pools.some(p=>!p.poolId));
});
