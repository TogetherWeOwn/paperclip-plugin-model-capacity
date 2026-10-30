import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { buildLaneRequest, assertLaneRequest, DEFAULT_BASE_URL, DEFAULT_ACCOUNTS_PATH } from '../src/cliproxy.mjs';

const expected={method:'GET',url:DEFAULT_BASE_URL+DEFAULT_ACCOUNTS_PATH};
test('U15 lane job builder emits only the pinned accounts GET even under hostile configuration',()=>{
  assert.deepEqual(buildLaneRequest(),expected);
  for(const path of ['/v0/management/usage-queue','/v0/management/usage-queue/peek','/subscribe',DEFAULT_ACCOUNTS_PATH+'?debug=1','/telemetry/../other.json','//other.example/accounts.json','',null]) {
    assert.throws(()=>buildLaneRequest(DEFAULT_BASE_URL,path),/cliproxy-request-blocked/);
    // A caller cannot make a forbidden request legal by changing the validator's config.
    assert.throws(()=>assertLaneRequest({method:'GET',url:DEFAULT_BASE_URL+path},{baseUrl:DEFAULT_BASE_URL,accountsPath:path}),/cliproxy-request-blocked/);
  }
  for(const origin of ['https://other.example',DEFAULT_BASE_URL+'/',DEFAULT_BASE_URL+'/prefix','http://lane-host.invalid','https://'+'user:pass@lane-host.invalid',DEFAULT_BASE_URL+'?q=']) {
    assert.throws(()=>buildLaneRequest(origin),/cliproxy-request-blocked/);
  }
  for(const method of ['POST','PUT','DELETE','SUBSCRIBE'])assert.throws(()=>assertLaneRequest({...expected,method}),/cliproxy-request-blocked/);
  assert.throws(()=>assertLaneRequest({...expected,body:{}}),/cliproxy-request-blocked/);
});

test('U15 source has no direct queue path or RESP command; native events capability is not a lane subscription',async()=>{
  async function scan(dir) {
    for(const entry of await readdir(dir,{withFileTypes:true})) {
      const file=new URL(entry.name+(entry.isDirectory()?'/':''),dir);
      if(entry.isDirectory())await scan(file);
      else if(entry.name.endsWith('.mjs')) {
        const source=await readFile(file,'utf8');
        assert.doesNotMatch(source,/usage-queue/i,file.pathname);
        // The required Paperclip 'events.subscribe' capability is distinct from
        // a RESP SUBSCRIBE command. Reject standalone quoted wire commands.
        assert.doesNotMatch(source,/["'`]subscribe["'`]/i,file.pathname);
      }
    }
  }
  await scan(new URL('../src/',import.meta.url));
});
