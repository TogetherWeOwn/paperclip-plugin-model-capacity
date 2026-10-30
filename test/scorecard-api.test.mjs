import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { buildManifest } from '../src/manifest.mjs';
import { companyId } from './support/native-api.mjs';
import { config, quotaFeed, stateHarness, NOW, MINUTE } from './support/quota.mjs';

async function start({h=stateHarness(),failFeed=false}={}) {
  const cfg=config(),jobs=new Map(),events=new Map();let now=NOW;
  cfg.burn={accountKeys:['one'],expiresAt:new Date(NOW-MINUTE).toISOString()};
  cfg.roles={minQuality:{doer:null,thinker:null,other:null}};
  const plugin=createModelCapacityPlugin({clock:()=>now,requirePinnedLaneHost:false});
  await plugin.setup({state:h.state,logger:h.logger,config:{get:async()=>cfg},secrets:{resolve:async()=> 'TEST_SCORECARD_SECRET'},
    http:{fetch:async()=>{if(failFeed)throw new Error('PRIVATE_FEED_ERROR');const f=quotaFeed(now);for(const a of f.accounts)a.usage={epoch:'keeper-1',requests:100,observedAt:new Date(now).toISOString()};return {status:200,json:async()=>f};}},
    jobs:{register:(key,fn)=>jobs.set(key,fn)},events:{on:(key,fn)=>events.set(key,fn)},
    agents:{get:async()=>null,list:async()=>[]},issues:{get:async()=>null,list:async()=>[]}});
  await plugin.onConfigChanged(cfg,{companyId});
  const tick=()=>jobs.get('quota-refresh')({});if(!failFeed)await tick();
  return {...h,plugin,cfg,tick,setNow:n=>{now=n;},get:routeKey=>plugin.onApiRequest({companyId,routeKey})};
}

test('both package variants declare a native company-scoped read-only scorecard route',()=>{
  for(const variant of ['clean','transitional']) {
    const manifest=buildManifest({variant}),route=manifest.apiRoutes.find(r=>r.routeKey==='scorecard');
    assert.deepEqual(route,{routeKey:'scorecard',method:'GET',path:'/scorecard',auth:'board-or-agent',capability:'api.routes.register',checkoutPolicy:'none',companyResolution:{from:'query',key:'companyId'}});
  }
});

test('GET scorecard exposes safe durable rows, honest wait note and expired burn warning, folded identically into capacity',async()=>{
  const s=await start();const api=await s.get('scorecard');assert.equal(api.status,200);assert.equal(api.body.rows.length,2);
  assert.equal(api.body.burn.status,'expired');assert.match(api.body.burn.warning,/inactive.*past/);
  for(const row of api.body.rows) {
    assert.equal(row.waitsCaused,null);assert.match(row.waitsNote,/does not expose/);
    assert.equal(Object.keys(row).some(k=>k.startsWith('_')),false);
    assert.equal(row.burnWindows.some(w=>Object.keys(w).some(k=>k.startsWith('_'))),false);
  }
  const capacity=await s.get('capacity');assert.deepEqual(capacity.body.scorecard,api.body);
  assert.equal(JSON.stringify(api).includes('TEST_SCORECARD_SECRET'),false);
  api.body.rows[0].minutesEligible=999;
  assert.notEqual((await s.get('scorecard')).body.rows[0].minutesEligible,999);
  assert.equal((await s.plugin.onApiRequest({companyId:'other-company',routeKey:'scorecard'})).status,404);
});

test('scorecard survives worker restart before a successful quota tick and returns an empty explicit view on first boot',async()=>{
  const s=await start();s.setNow(NOW+MINUTE);await s.tick();
  const before=(await s.get('scorecard')).body;
  const restarted=await start({h:s,failFeed:true});assert.deepEqual((await restarted.get('scorecard')).body,before);
  const empty=await start({failFeed:true});const api=await empty.get('scorecard');
  assert.equal(api.status,200);assert.deepEqual(api.body.rows,[]);assert.equal(api.body.atMs,null);
});
