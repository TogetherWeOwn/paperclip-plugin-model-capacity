import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfigShape } from '../src/plugin.mjs';

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
    c=>{c.router.accounts[0].pools.builder.typo=true},
    c=>{c.router.accounts[0].pools.builder.probeEligible=null},
  ];
  for (const mutate of cases) { const c=good(); mutate(c); assert.notDeepEqual(validateConfigShape(c), [], JSON.stringify(c)); }
});
