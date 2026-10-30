import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig, validateConfigShape } from '../src/plugin.mjs';
import { manifest } from '../src/manifest.mjs';
const configSchema=manifest.instanceConfigSchema;
import { normalizeRegistry, memberIdFor } from '../src/registry.mjs';
import { buildQuotaSnapshot } from '../src/snapshot.mjs';
import { routeDecision } from '../src/router.mjs';
import { syntheticRouterRequest } from '../src/quota-refresh.mjs';
import { config, quotaFeed, NOW, MINUTE, HOUR } from './support/quota.mjs';
const burn=(extra={})=>({accountKeys:['one'],providers:[],expiresAt:new Date(NOW+2*MINUTE).toISOString(),mode:'prefer',endAtUsedPct:.995,...extra});
const build=(cfg,now=NOW,feed=quotaFeed(now))=>buildQuotaSnapshot({registry:normalizeRegistry(cfg.router),feed,nowMs:now,config:cfg});
const decide=(cfg,snapshot,now=NOW,patch={})=>routeDecision({...syntheticRouterRequest(normalizeRegistry(cfg.router),'builder',now),...patch},snapshot,{...cfg,router:{...cfg.router,enabled:true}},{syntheticShadow:true});

test('native burn config requires explicit parseable expiry; defaults prefer and never changes legacy burnMode',()=>{
  assert.ok(configSchema.properties.burn,'burn is a declared plugin config block');
  for(const expiresAt of [undefined,null,'garbage','2026-10-30T12:00:00']) {
    const cfg={...config(),burn:burn({expiresAt})};
    assert.ok(validateConfigShape(cfg).some(e=>e.includes('burn.expiresAt')));
    assert.throws(()=>resolveConfig(cfg),/burn.expiresAt/);
  }
  for(const extra of [{mode:'forever'},{endAtUsedPct:1.1},{accountKeys:'one'},{providers:[null]},{surprise:true}])assert.ok(validateConfigShape({...config(),burn:burn(extra)}).some(e=>e.startsWith('burn')));
  const cfg={...config(),burn:{accountKeys:['one'],expiresAt:new Date(NOW-MINUTE).toISOString()},burnMode:{accounts:['codex:*']}};
  const resolved=resolveConfig(cfg);
  assert.equal(resolved.burn.mode,'prefer');assert.equal(resolved.burn.endAtUsedPct,.995);
  assert.equal(resolved.burn.expiresAt,cfg.burn.expiresAt,'past expiry is valid config, not an infinite burn');
  assert.deepEqual(resolved.burnMode.accounts,['codex:*']);
});

test('quota snapshot publishes per-account scoped burn with total runtime expiry and standing warning',()=>{
  const cfg={...config(),burn:burn()};
  const live=build(cfg);assert.equal(live.snapshot.accounts.one.burn.active,true);assert.equal(live.snapshot.accounts.two.burn.active,false);
  assert.equal(live.snapshot.accounts.one.burn.expiresAtMs,NOW+2*MINUTE);
  const expired=build(cfg,NOW+2*MINUTE);
  assert.equal(expired.snapshot.accounts.one.burn.active,false);
  assert.ok(expired.warnings.some(w=>w.reason==='burn-expired'));
  assert.equal(expired.snapshot.burn.status,'expired');
  for(const used of [.995,1])assert.equal(build(cfg,NOW,quotaFeed(NOW,{used})).snapshot.accounts.one.burn.active,false);
  const resetFeed=quotaFeed(NOW);resetFeed.accounts[0].weekly.resetsAt=NOW;
  assert.equal(build(cfg,NOW,resetFeed).snapshot.accounts.one.burn.active,false);
  const provider=build({...config(),burn:burn({accountKeys:[],providers:['anthropic']})});
  assert.equal(provider.snapshot.accounts.one.burn.active,false);assert.equal(provider.snapshot.accounts.two.burn.active,true);
});

test('burn selection expires between ticks, is identical to never-burned afterwards and never overrides pins or probes',()=>{
  const cfg={...config(),burn:burn({accountKeys:['two']})};
  const snapshot=structuredClone(build(cfg).snapshot);
  snapshot.accounts.one.view.deficit=.2;snapshot.accounts.two.view.deficit=.01;
  assert.equal(decide(cfg,snapshot).memberId,memberIdFor('builder','two'));
  assert.equal(decide(cfg,snapshot,NOW,{pinnedMemberId:memberIdFor('builder','one')}).memberId,memberIdFor('builder','one'));
  assert.equal(decide(cfg,snapshot,NOW,{taskKey:'__heartbeat__'}).memberId,memberIdFor('builder','one'));
  const expiry=NOW+2*MINUTE;
  assert.deepEqual(decide(cfg,snapshot,expiry),decide(config(),snapshot,expiry));
  const stale=structuredClone(snapshot);stale.accounts.two.quality='unknown';
  assert.equal(decide(cfg,stale).memberId,memberIdFor('builder','one'),'burn never makes a stale target eligible');
});

test('exclusive burn waits for targets or expiry, not an earlier non-target retry',()=>{
  const cfg={...config(),burn:burn({mode:'exclusive',expiresAt:new Date(NOW+10*MINUTE).toISOString()})};
  const snapshot=structuredClone(build(cfg).snapshot);
  snapshot.accounts.one.credentialReady=false;snapshot.accounts.one.nextEligibleAtMs=NOW+HOUR;
  snapshot.accounts.two.nextEligibleAtMs=NOW+MINUTE;
  const d=decide(cfg,snapshot);
  assert.equal(d.kind,'exhausted');assert.equal(d.skipped[memberIdFor('builder','two')],'burn-not-target');
  assert.equal(Date.parse(d.retryAt),NOW+10*MINUTE);
  const eligible=structuredClone(snapshot);eligible.accounts.one.credentialReady=true;
  eligible.accounts.one.eligible=false;eligible.accounts.one.skipReason='pace-held';
  assert.equal(decide(cfg,eligible).memberId,memberIdFor('builder','one'),'burn bypasses pace holds only');
  eligible.accounts.one.view.weeklyUsed=1;
  assert.equal(decide(cfg,eligible).kind,'exhausted','burn cannot override projected hard caps');
});
