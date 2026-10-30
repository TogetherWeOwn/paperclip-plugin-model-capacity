import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaperclipApi} from '../scripts/paperclip-api.mjs';
const company='10000000-0000-4000-8000-000000000001', agent='10000000-0000-4000-8000-000000000002', rev='10000000-0000-4000-8000-000000000003', newRev='10000000-0000-4000-8000-000000000004';
const before={mode:'responsible_user',provider:'openai',method:'api_key'}, after={mode:'router',connectionId:'10000000-0000-4000-8000-000000000005'};
function setup({restricted=false,concurrent=false,changed=false,forbidden=false,maskedDetail=false,postChanged=false}={}) {
  let config={aiConnection:changed?after:before,unrelated:{n:1},apiKey:'secret-value'}, revisions=[{id:rev}], patches=[], calls=[];
  const fetchImpl=async(url,opt)=>{const path=new URL(url).pathname;calls.push(`${opt.method} ${path}`);let result;
    if(path.endsWith('/configuration')) {if(forbidden)return new Response('{}',{status:403}); result={companyId:company,runtimeConfig:{...config,aiConnection:before,apiKey:'***REDACTED***'}};}
    else if(path.endsWith('/config-revisions')) result=revisions;
    else if(opt.method==='PATCH') {patches.push(JSON.parse(opt.body));config=patches.at(-1).runtimeConfig;if(postChanged)config={...config,unrelated:{n:2}};revisions=[{id:newRev},...(concurrent?[{id:'10000000-0000-4000-8000-000000000006'}]:[]),...revisions];result={};}
    else result={id:agent,companyId:company,updatedAt:'2026-10-30T12:00:00Z',runtimeConfig:restricted?{}:maskedDetail?{...config,apiKey:"***REDACTED***"}:config};
    return new Response(JSON.stringify(result),{status:200});};
  return {api:createPaperclipApi({target:'http://localhost',companyId:company,token:'test',fetchImpl}),patches,calls};
}
test('pinned binding preserves raw secret-named and unrelated values, never masked configuration',async()=>{const f=setup();await f.api.bindAgent(agent,after,before);assert.deepEqual(f.patches,[{runtimeConfig:{aiConnection:after,unrelated:{n:1},apiKey:'secret-value'}}]);assert.ok(f.calls.indexOf(`GET /api/agents/${agent}/config-revisions`)<f.calls.lastIndexOf(`GET /api/agents/${agent}`));});
test('pinned binding refuses restricted detail',async()=>{const f=setup({restricted:true});await assert.rejects(f.api.bindAgent(agent,after,before));assert.equal(f.patches.length,0);});
test('pinned binding detects concurrent revision and fails after write',async()=>{const f=setup({concurrent:true});await assert.rejects(f.api.bindAgent(agent,after,before),/revision/i);assert.equal(f.patches.length,1);});
test('pinned binding refuses stale pre-write binding',async()=>{const f=setup({changed:true});await assert.rejects(f.api.bindAgent(agent,after,before),/binding changed/i);assert.equal(f.patches.length,0);});
test('configuration permission is checked before any detail or patch',async()=>{const f=setup({forbidden:true});await assert.rejects(f.api.bindAgent(agent,after,before),/403/);assert.equal(f.calls.length,1);});

test('pinned binding refuses redacted detail without a write',async()=>{const f=setup({maskedDetail:true});await assert.rejects(f.api.bindAgent(agent,after,before),/redacted/);assert.equal(f.patches.length,0);});
test('pinned binding detects unrelated post-write mutation',async()=>{const f=setup({postChanged:true});await assert.rejects(f.api.bindAgent(agent,after,before),/runtimeConfig/);assert.equal(f.patches.length,1);});
