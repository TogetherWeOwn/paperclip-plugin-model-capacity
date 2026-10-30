import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
const moduleUrl = new URL('../scripts/audit-env-pins.mjs',import.meta.url);
const companyId = '00000000-0000-4000-8000-000000000001';
const agentId = '00000000-0000-4000-8000-000000000002';
const keyList = ['CLAUDE_CODE_SUBAGENT_MODEL','ANTHROPIC_SMALL_FAST_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','PAPERCLIP_ASSIGNED_MODEL'];
async function tool() {
  assert.equal(existsSync(moduleUrl),true,'read-only audit CLI missing');
  return import(moduleUrl);
}
function io() {
  let out='',err='';
  return {stdout:{write:s=>{out+=s;}},stderr:{write:s=>{err+=s;}},get out(){return out;},get err(){return err;}};
}
function agent(env, extra={}) {return {id:agentId,companyId,name:'never print this name',adapterConfig:{env},...extra};}

test('S1 lists all six exact pin keys and only allowlisted model families, never model values',async()=>{
  const {auditEnvPins,PIN_KEYS} = await tool();
  assert.deepEqual(PIN_KEYS,keyList);
  const env = Object.fromEntries(keyList.map((key,i)=>[key,['lane/claude-opus-5-5',
    {type:'plain',value:'lane/claude-haiku-5-5'},'prefix/claude-sonnet-5-5[1m]',
    'prefix/gpt-6.1-sol',{type:'secret_ref',secretId:'secret-should-not-appear'},'random-secret-model-value'][i]]));
  env.OTHER_ENV = 'secret-env';
  const report = auditEnvPins([agent(env),agent({}, {id:'00000000-0000-4000-8000-000000000003'})],{companyId});
  assert.equal(report.agentsScanned,2); assert.equal(report.pinnedAgents.length,1);
  assert.deepEqual(report.pinnedAgents[0],{agentId,pins:keyList.map((key,i)=>({key,modelFamily:
    ['claude-opus','claude-haiku','claude-sonnet','gpt','secret-ref','unknown'][i]}))});
  const output = JSON.stringify(report);
  for(const secret of ['lane/','prefix/','random-secret-model-value','secret-should-not-appear','secret-env','never print this name']) assert.ok(!output.includes(secret));
});

test('S1 redacted, malformed and deceptive values are unknown, never inferred from the agent model or key name',async()=>{
  const {auditEnvPins} = await tool();
  for (const [value,family] of [[{type:'plain',value:'***REDACTED***'},'redacted'],['***REDACTED***','redacted'],
    [null,'unknown'],[17,'unknown'],['token-containing-claude-opus','unknown'],['https://leak.test/gpt-6.1-sol','unknown'],
    [{type:'plain',value:{secret:'x'}},'unknown'],['z/gemini-3-pro','gemini'],['z/glm-5.1','glm']]) {
    const report = auditEnvPins([agent({ANTHROPIC_DEFAULT_OPUS_MODEL:value})],{companyId});
    assert.equal(report.pinnedAgents[0].pins[0].modelFamily,family);
  }
  assert.throws(()=>auditEnvPins([agent({}, {companyId:'00000000-0000-4000-8000-000000000009'})],{companyId}),/agent/);
  assert.throws(()=>auditEnvPins({}, {companyId}),/agent/);
});

test('S1 live CLI uses one native GET, suppresses server data and credentials, and never follows redirects',async()=>{
  const {runAuditEnvPins} = await tool(); const capture = io(),calls=[];
  const code = await runAuditEnvPins(['--target','http://127.0.0.1:3100','--company-id',companyId],{
    ...capture,env:{PAPERCLIP_BOARD_TOKEN:'board-super-secret'},fetchImpl:async(url,init)=>{
      calls.push({url,init});return {ok:true,json:async()=>[agent({PAPERCLIP_ASSIGNED_MODEL:{type:'plain',value:'***REDACTED***'}})]};
    },
  });
  assert.equal(code,0);assert.equal(capture.err,'');assert.equal(calls.length,1);
  assert.equal(calls[0].url,`http://127.0.0.1:3100/api/companies/${companyId}/agents`);
  assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.redirect,'error');assert.equal(calls[0].init.body,undefined);
  const result = JSON.parse(capture.out); assert.equal(result.target,'http://127.0.0.1:3100');
  assert.equal(result.pinnedAgents[0].pins[0].modelFamily,'redacted');
  assert.ok(result.limitations.some(l=>l.includes('redact')));
  assert.doesNotMatch(capture.out,/board-super-secret|never print this name/);
});

test('S1 failures and invalid arguments never echo input or perform writes',async()=>{
  const {runAuditEnvPins} = await tool();
  for(const argv of [[],['--apply'],['--target','https://example.test:password@example.test','--company-id',companyId],
    ['--target','http://remote.test','--company-id',companyId],['--target','https://example.test/?token=secret','--company-id',companyId]]) {
    const capture=io();let calls=0;
    assert.equal(await runAuditEnvPins(argv,{...capture,env:{PAPERCLIP_BOARD_TOKEN:'token'},fetchImpl:()=>{calls++;throw Error('NO');}}),1);
    assert.equal(calls,0);assert.equal(capture.out,'');assert.doesNotMatch(capture.err,/password|token=secret|remote.test/);
  }
  const capture=io();
  assert.equal(await runAuditEnvPins(['--target','https://example.test','--company-id',companyId],{
    ...capture,env:{PAPERCLIP_BOARD_TOKEN:'token'},fetchImpl:async()=>{throw Error('secret body');},
  }),1);
  assert.equal(capture.out,'');assert.doesNotMatch(capture.err,/secret body/);
});
