import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfigShape } from '../src/plugin.mjs';
import { verifiedConfig } from './support/verified-pools.mjs';

const good = () => ({router:{enabled:false,companyId:'10000000-0000-4000-8000-000000000001',ownerUserId:'10000000-0000-4000-8000-000000000002',pools:[{poolKey:'builder',role:'doer'}],accounts:[{accountKey:'a',prefix:'p',provider:'openai',protocol:'responses',harnessProfile:'codex',connectionName:'A',pools:{builder:{model:'model',probeEligible:true}}}]}});

test('router config validation accepts valid registry and legacy config', () => {
  assert.deepEqual(validateConfigShape(good()), []);
  assert.deepEqual(validateConfigShape({}), []);
});
test('router config validation rejects malformed identity, matrix, membership and timing', () => {
  const cases = [
    c=>{c.router.companyId='bad'},
    c=>{c.router.ownerUserId='bad'},
    c=>{c.router.accounts[0].protocol='messages'},
    c=>{c.router.accounts[0].probeEligible=true},
    c=>{c.router.accounts[0].acpxAgent=null},
    c=>{c.router.accounts.push({...c.router.accounts[0]})},
    c=>{c.router.accounts[0].pools.builder.model='p/model'},
    c=>{c.router.hardCapWeekly=1.1},
    c=>{c.router.staleSnapshotMs=0},
    c=>{c.router.allowMessages='true'},
    c=>{c.router.typo=true},
    c=>{c.router.pools[0].poolKey='x'.repeat(161)},
    c=>{c.router.accounts[0].connectionName='x'.repeat(161)},
    c=>{c.router.accounts[0].pools.builder.typo=true},
    c=>{c.router.accounts[0].pools.builder.probeEligible=null},
  ];
  for (const mutate of cases) { const c=good(); mutate(c); assert.notDeepEqual(validateConfigShape(c), [], JSON.stringify(c)); }
});


test('schema properties and validator key allowlists stay in parity at each router level', async () => {
  const {manifest}=await import('../src/manifest.mjs');
  const schema=manifest.instanceConfigSchema.properties.router;
  const levels=[
    [schema.properties,c=>c.router,'router'],
    [schema.properties.pools.items.properties,c=>c.router.pools[0],'router.pools[]'],
    [schema.properties.pools.items.properties.members.items.properties,c=>c.router.pools[0].members[0],'router.pools[].members[]'],
    [schema.properties.accounts.items.properties,c=>c.router.accounts[0],'router.accounts[]'],
    [schema.properties.accounts.items.properties.pools.additionalProperties.properties,c=>c.router.accounts[0].pools.builder,'router membership'],
  ];
  for (const [properties,get,path] of levels) {
    for (const key of Object.keys(properties)) {
      const c=verifiedConfig(); get(c)[key]=undefined;
      assert.ok(!validateConfigShape(c).includes(`${path}.${key} is not a known key`),`${path}.${key}`);
    }
    const c=verifiedConfig(); get(c).notInSchema=true;
    assert.ok(validateConfigShape(c).includes(`${path}.notInSchema is not a known key`));
  }
});

test('validator allowlists equal manifest schema keys in both directions', async () => {
  const {ROUTER_CONFIG_KEYS}=await import('../src/registry.mjs');
  const {manifest}=await import('../src/manifest.mjs');
  const s=manifest.instanceConfigSchema.properties.router;
  const schemas={router:s.properties,pool:s.properties.pools.items.properties,account:s.properties.accounts.items.properties,membership:s.properties.accounts.items.properties.pools.additionalProperties.properties,verifiedMember:s.properties.pools.items.properties.members.items.properties};
  for (const [level,properties] of Object.entries(schemas)) {
    assert.deepEqual([...ROUTER_CONFIG_KEYS[level]].sort(),Object.keys(properties).sort(),level);
  }
});
