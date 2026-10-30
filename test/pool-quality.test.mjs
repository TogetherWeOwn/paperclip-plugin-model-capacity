import test from 'node:test';
import assert from 'node:assert/strict';
import { computePoolQualityVerdicts } from '../src/pool-quality.mjs';

const registry = {companyId:'c',ownerUserId:'o',pools:[{poolKey:'builder',role:'doer'},{poolKey:'thinker',role:'thinker'},{poolKey:'reviewer',role:'reviewer'}],accounts:[
  {accountKey:'a',prefix:'p',provider:'openai',protocol:'responses',harnessProfile:'codex',connectionName:'A',pools:{builder:{model:'basic'},thinker:{model:'basic'},reviewer:{model:'strong'}}},
  {accountKey:'b',prefix:'q',provider:'openai',protocol:'responses',harnessProfile:'codex',connectionName:'B',pools:{builder:{model:'strong'},thinker:{model:'strong'},reviewer:{model:'basic'}}}
]};
const arms = [
  {armId:'basic-max',model:'basic',family:'basic',qFleet:0.1,qFleetThinker:0.1},
  {armId:'strong-max',model:'strong',family:'strong',qFleet:1,qFleetThinker:1},
];
const context = {arms, roles:{minQuality:{doer:0,thinker:0.4,other:0.5}}, records:[], nowMs:10000, roleOf:()=> 'doer', familyOf:r=>r.family};

test('role pool verdicts enforce configured floors and map reviewer to other', () => {
  assert.deepEqual(computePoolQualityVerdicts(registry,context), {a:{builder:true,thinker:false,reviewer:true},b:{builder:true,thinker:true,reviewer:false}});
});
test('manual family and arm exclusions and unknown evidence never qualify', () => {
  const v=computePoolQualityVerdicts(registry,{...context,arms:[...arms,{armId:'unknown',model:'unknown',family:'unknown'}],roles:{...context.roles,excludeFamilies:{doer:['strong'],thinker:['arm:strong-max']}}});
  assert.equal(v.b.builder,false); assert.equal(v.b.thinker,false);
  const missing=computePoolQualityVerdicts(registry,{...context,arms:[]});
  assert.equal(missing.a.builder,false);
});
test('outcome gate uses only comparable families in each pool', () => {
  const records = ['basic','strong'].flatMap(family => [0,1].map(i=>({status:'finished',progress:family==='basic'?'noChange':'progressed',terminalAt:9000,agentId:'x',runId:family+i,family})));
  const v=computePoolQualityVerdicts(registry,{...context,records,roles:{...context.roles,outcomeGate:{minRuns:2,minProgressRate:0.5,relativeToBest:0.75}}});
  assert.equal(v.a.builder,false); assert.equal(v.b.builder,true);
  const solo={...registry,accounts:[{...registry.accounts[0],pools:{builder:{model:'basic'}}}]};
  assert.equal(computePoolQualityVerdicts(solo,{...context,records,roles:{...context.roles,outcomeGate:{minRuns:2}}}).a.builder,true);
});
