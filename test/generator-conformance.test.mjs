import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createAiConnectionSchema } from './fixtures/upstream-schemas/ai-connections.js';
import { aiConnectionPoolConfigSchema } from './fixtures/upstream-schemas/ai-connection-router.js';
import { planPoolSaga } from '../scripts/pool-saga.mjs';
import * as generator from '../scripts/generate-pool.mjs';
import { NativeApi, options, companyId, ownerUserId } from './support/native-api.mjs';

// Exact route envelope from server/src/routes/ai-connections.ts:175 at e2cfdc7e.
const saveBody=z.object({pluginKey:z.string().min(1).max(160),id:z.string().uuid().optional(),expectedRevision:z.number().int().positive().optional(),config:aiConnectionPoolConfigSchema}).strict();

test('U18 generator requests conform to upstream Zod schemas, including boundary-only secret injection',async()=>{
  assert.equal(typeof generator.createPaperclipApi,'function','real HTTP adapter must be exported');
  const plan=await planPoolSaga(options(new NativeApi()));
  const sent=[];
  const api=generator.createPaperclipApi({target:'https://paperclip.example',companyId,token:'BOARD_DUMMY',secretRefs:{one:{env:'LANE_ONE'},two:{env:'LANE_TWO'}},env:{LANE_ONE:'DUMMY_ONE',LANE_TWO:'DUMMY_TWO'},fetchImpl:async(url,init)=>{
    if(init.method==='GET' && url.endsWith('/grants'))return Response.json({grants:[]});
    const body=JSON.parse(init.body);sent.push({url,body,init});
    if(url.endsWith('/ai-connections'))createAiConnectionSchema.parse(body);
    else saveBody.parse(body);
    return Response.json(url.endsWith('/ai-connections')?{connectionId:companyId,grantId:ownerUserId}:{...body.config,id:companyId,revision:1});
  }});
  for(const connection of plan.connections) {
    assert.equal(createAiConnectionSchema.safeParse(connection.inputWithoutSecret).success,false,'a plan is not a credential-bearing create input');
    await api.createConnection(connection.inputWithoutSecret,connection.accountKey);
    assert.equal(Object.hasOwn(connection.inputWithoutSecret,'apiKey'),false,'injection must not mutate the plan');
  }
  for(const pool of plan.pools)await api.savePool(pool);
  assert.equal(sent[0].body.apiKey,'DUMMY_ONE');assert.equal(sent[1].body.apiKey,'DUMMY_TWO');
  assert.equal(sent[0].init.headers.Authorization,'Bearer BOARD_DUMMY');
  assert.equal(sent[0].init.redirect,'error');
  for(const {body,url} of sent.filter(r=>r.url.endsWith('/ai-connection-pools'))) {assert.equal(body.companyId,undefined);assert.equal(body.pluginKey,'togetherweown.model-capacity');assert.ok(url.includes(`/api/companies/${companyId}/`));}
});

test('HTTP adapter refuses missing secret refs and never exposes provider error bodies',async()=>{
  assert.equal(typeof generator.createPaperclipApi,'function');
  let calls=0;
  const api=generator.createPaperclipApi({target:'http://127.0.0.1:9080/api',companyId,token:'BOARD_DUMMY',secretRefs:{},env:{},fetchImpl:async()=>{calls++;return Response.json({error:'SECRET_ECHO'},{status:422});}});
  await assert.rejects(api.createConnection({name:'x'},'one'),/secret reference/);assert.equal(calls,0);
  await assert.rejects(api.listPools(companyId),e=>{assert.doesNotMatch(e.message,/SECRET_ECHO|BOARD_DUMMY/);return true;});
});
