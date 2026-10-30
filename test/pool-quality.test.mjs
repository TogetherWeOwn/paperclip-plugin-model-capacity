import test from 'node:test';
import assert from 'node:assert/strict';
import { computePoolQualityVerdicts } from '../src/pool-quality.mjs';

const registry = {companyId:'10000000-0000-4000-8000-000000000001',ownerUserId:'10000000-0000-4000-8000-000000000002',pools:[{poolKey:'builder',role:'doer'},{poolKey:'thinker',role:'thinker'},{poolKey:'reviewer',role:'reviewer'}],accounts:[
  {accountKey:'a',prefix:'p',provider:'openai',protocol:'responses',harnessProfile:'codex',connectionName:'A',pools:{builder:{model:'basic'},thinker:{model:'basic'},reviewer:{model:'strong'}}},
  {accountKey:'b',prefix:'q',provider:'openai',protocol:'responses',harnessProfile:'codex',connectionName:'B',pools:{builder:{model:'strong'},thinker:{model:'strong'},reviewer:{model:'basic'}}}
]};
const arms = [
  {armId:'basic-max',model:'basic',family:'basic',qFleet:0.1,qFleetThinker:0.1},
  {armId:'strong-max',model:'strong',family:'strong',qFleet:1,qFleetThinker:1},
  ...Array.from({length:6},(_,i)=>({armId:`filler-${i}`,model:`filler-${i}`,family:`filler-${i}`,qFleet:1,qFleetThinker:1})),
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

test('small scored fleet does not enforce quality minimum', () => {
  const v=computePoolQualityVerdicts(registry,{...context,arms:arms.slice(0,2)});
  assert.equal(v.a.thinker,true);
});
test('a model qualifies when at least one of its effort variants can serve', () => {
  const variants=[...arms,{armId:'strong-low',model:'strong',family:'strong',qFleet:-2,qFleetThinker:-2}];
  const v=computePoolQualityVerdicts(registry,{...context,arms:variants});
  assert.equal(v.b.thinker,true);
  assert.equal(v.a.reviewer,true);
});
test('a later effort variant can qualify when the first variant fails the floor', () => {
  const variants=[{armId:'strong-low',model:'strong',family:'strong',qFleet:-2,qFleetThinker:-2},
    ...arms.map(a=>a.model==='basic'?{...a,qFleet:0.8,qFleetThinker:0.8}:a)];
  const reports=[];
  const v=computePoolQualityVerdicts(registry,{...context,arms:variants,onReport:(pool,report)=>reports.push([pool,report])});
  assert.equal(v.a.thinker,true);
  assert.equal(v.b.reviewer,true);
  assert.equal(v.b.thinker,true);
  assert.equal(v.a.reviewer,true);
  assert.ok(!reports.find(([pool])=>pool==='thinker')[1].roles.thinker.suspendedGates.includes('quality'));
  assert.ok(!reports.find(([pool])=>pool==='reviewer')[1].roles.other.suspendedGates.includes('quality'));
});
test('minimum boundary is inclusive and untrusted arms are excluded when a trusted alternative serves', () => {
  const variants=arms.map(a=>a.model==='basic'?{...a,qFleetThinker:0.4,roleTrusted:{doer:false}}:a);
  const v=computePoolQualityVerdicts(registry,{...context,arms:variants});
  assert.equal(v.a.thinker,true); assert.equal(v.a.builder,false);
});
test('unknown family membership fails closed even if another membership can serve', () => {
  const r=structuredClone(registry); r.accounts[0].pools.builder.model='mystery';
  const v=computePoolQualityVerdicts(r,{...context,arms:[...arms,{armId:'mystery',model:'mystery',family:'unknown',qFleet:1}]});
  assert.equal(v.a.builder,false); assert.equal(v.b.builder,true);
});
test('empty role suspends quality and manual exclusions and reports the suspension', () => {
  const r=structuredClone(registry); r.accounts=r.accounts.slice(0,1);
  const reports=[];
  const v=computePoolQualityVerdicts(r,{...context,onReport:(poolKey,report)=>reports.push([poolKey,report])});
  assert.equal(v.a.thinker,true);
  assert.ok(reports.find(([key])=>key==='thinker')[1].roles.thinker.suspendedGates.includes('quality'));
  const manual=[];
  const m=computePoolQualityVerdicts(r,{...context,roles:{...context.roles,excludeFamilies:{doer:['basic']}},onReport:(k,report)=>manual.push([k,report])});
  assert.equal(m.a.builder,true);
  assert.deepEqual(manual.find(([key])=>key==='builder')[1].roles.doer.suspendedManual,['basic']);
});
