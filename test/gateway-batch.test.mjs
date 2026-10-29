import test from 'node:test';
import assert from 'node:assert/strict';
import { planGatewayConnections, planSessionAdoption } from '../scripts/gateway-batch.mjs';

const a='10000000-0000-4000-8000-000000000001', b='10000000-0000-4000-8000-000000000002';
const registry={companyId:a,ownerUserId:'owner',pools:[{poolKey:'builder',role:'doer'},{poolKey:'thinker',role:'thinker'}],accounts:[{accountKey:'one',prefix:'one',connectionName:'One',provider:'openai',protocol:'responses',harnessProfile:'codex',pools:{builder:{model:'terra'},thinker:{model:'sol'}}}]};

test('gateway plan uses the upstream routing and install wire shape with the union of batch agents',()=>{
 const plan=planGatewayConnections({registry,baseUrl:'https://gateway.example/v1',batch:{builder:[a],thinker:[b,a]}});
 assert.deepEqual(plan,[{accountKey:'one',inputWithoutSecret:{name:'One',provider:'openai',method:'api_key',ownership:'shared',routing:{kind:'gateway',protocol:'responses',baseUrl:'https://gateway.example/v1',auth:'bearer',models:[{id:'one/sol'},{id:'one/terra'}]},agentIds:[a,b],allAgents:false}}]);
});

test('fleet-wide installation requires both flag and approval and valid batch inputs',()=>{
 for(const opts of [{allAgents:true},{allAgentsApproved:true}]) assert.throws(()=>planGatewayConnections({registry,baseUrl:'https://gateway.example',batch:{builder:[a],thinker:[]},...opts}),/allAgents/);
 assert.equal(planGatewayConnections({registry,baseUrl:'https://gateway.example',batch:{builder:[a],thinker:[]},allAgents:true,allAgentsApproved:true})[0].inputWithoutSecret.allAgents,true);
 for(const batch of [{builder:[a]}, {builder:['bad'],thinker:[]}, {builder:[a],thinker:[],extra:[]}]) assert.throws(()=>planGatewayConnections({registry,baseUrl:'https://gateway.example',batch}),/batch|agent/i);
 const credentialUrl=new URL('https://example.com'); credentialUrl.username='u'; credentialUrl.password='p';
 for(const baseUrl of ['http://example.com',credentialUrl.href,'https://example.com/?secret=foo']) assert.throws(()=>planGatewayConnections({registry,baseUrl,batch:{builder:[a],thinker:[]}}),/baseUrl/);
});

test('session adoption reports live blockers, requires explicit reset and never treats drained as proof',()=>{
 const sessions={[a]:[{taskKey:'issue:1',sessionId:'session'}],[b]:[]};
 const result=planSessionAdoption({agentIds:[a,b],sessionsByAgent:sessions,sessionPlans:{[a]:'reset'}});
 assert.deepEqual(result,{blockers:[{agentId:a,taskKey:'issue:1',plan:'reset'}],resets:[{agentId:a,taskKey:'issue:1'}],ready:false});
 for(const sessionPlans of [{},{[a]:'drained'},{[a]:'invalid'}]) assert.throws(()=>planSessionAdoption({agentIds:[a,b],sessionsByAgent:sessions,sessionPlans}),/session/i);
 assert.deepEqual(planSessionAdoption({agentIds:[a,b],sessionsByAgent:{[a]:[],[b]:[]},sessionPlans:{[a]:'drained'}}),{blockers:[],resets:[],ready:true});
 assert.throws(()=>planSessionAdoption({agentIds:[a,b],sessionsByAgent:{[a]:[]}}),/session/i);
});

test('gateway plan excludes secrets structurally and rejects accounts with no memberships',()=>{
 const options={registry,baseUrl:'https://gateway.example',batch:{builder:[a],thinker:[]}};
 const plan=planGatewayConnections(options)[0];
 assert.equal(plan.input,undefined);
 assert.equal(plan.inputWithoutSecret.routing.auth,'bearer');
 assert.equal(Object.hasOwn(plan.inputWithoutSecret,'apiKey'),false);
 const poolless=structuredClone(registry); poolless.accounts[0].pools={};
 assert.throws(()=>planGatewayConnections({...options,registry:poolless}),/membership|pool/i);
});

test('session safety evidence rejects empty batches, arrays, foreign agents and malformed task keys',()=>{
 assert.throws(()=>planSessionAdoption({agentIds:[],sessionsByAgent:{}}),/agent/i);
 assert.throws(()=>planSessionAdoption({agentIds:[a],sessionsByAgent:{[a]:[]},sessionPlans:[]}),/session/i);
 assert.throws(()=>planSessionAdoption({agentIds:[a],sessionsByAgent:{[a]:[],[b]:[]}}),/session/i);
 assert.throws(()=>planSessionAdoption({agentIds:[a],sessionsByAgent:{[a]:[{taskKey:' '}]},sessionPlans:{[a]:'reset'}}),/session/i);
});

test('gateway URL accepts loopback HTTP but rejects fragments',()=>{
 const batch={builder:[a],thinker:[]};
 assert.doesNotThrow(()=>planGatewayConnections({registry,baseUrl:'http://localhost:8317/v1',batch}));
 assert.throws(()=>planGatewayConnections({registry,baseUrl:'https://gateway.example/v1#fragment',batch}),/baseUrl/);
});

test('fleet-wide plans do not misleadingly list individual installs',()=>{
 const [plan]=planGatewayConnections({registry,baseUrl:'https://gateway.example',batch:{builder:[a],thinker:[b]},allAgents:true,allAgentsApproved:true});
 assert.deepEqual(plan.inputWithoutSecret.agentIds,[]);
});
