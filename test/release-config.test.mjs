import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { buildManifest } from '../src/manifest.mjs';
import { normalizeRegistry } from '../src/registry.mjs';
import { validateConfigShape } from '../src/plugin.mjs';

test('release example has two fictitious accounts, disabled native routing, empty burn scope and valid variant schemas',async()=>{
  const config = JSON.parse(await readFile(new URL('../config.example.json',import.meta.url),'utf8'));
  assert.equal(config.router.accounts.length,2);
  assert.equal(config.router.enabled,false);assert.equal(config.router.allowMessages,false);
  assert.deepEqual(config.burn.accountKeys,[]);assert.deepEqual(config.burn.providers,[]);
  assert.deepEqual(validateConfigShape(config),[]);
  assert.equal(normalizeRegistry(config.router).accounts.length,2);
  for (const variant of ['clean','transitional']) {
    const example=structuredClone(config);if(variant==='clean')delete example.enforce;
    const ajv=new Ajv({allErrors:true});addFormats(ajv);ajv.addFormat('secret-ref',{validate:()=>true});
    const check=ajv.compile(buildManifest({variant}).instanceConfigSchema);
    assert.equal(check(example),true,JSON.stringify(check.errors));
  }
});
