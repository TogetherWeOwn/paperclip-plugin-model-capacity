import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { pluginManifestV1Schema } from './fixtures/upstream-schemas/plugin-manifest.js';
import { buildManifest } from '../src/manifest.mjs';
import { stateHarness } from './support/quota.mjs';

const buildTool=new URL('../scripts/build-variants.mjs',import.meta.url);
async function build(t) {
  assert.equal(existsSync(buildTool),true,'variant package build tool is missing');
  const {buildVariantPackages}=await import(buildTool);
  const dir=await mkdtemp(join(tmpdir(),'mc-variant-package-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return {dir,packages:await buildVariantPackages({outputDir:join(dir,'artifacts')})};
}

async function fakeSdk(directory) {
  // Exercise OUR worker's export and build-time factory argument only, not SDK
  // mechanics. No host is launched and no job/network/agent action is possible.
  const sdk=join(directory,'node_modules/@paperclipai/plugin-sdk');await mkdir(sdk,{recursive:true});
  await writeFile(join(sdk,'package.json'),JSON.stringify({type:'module',exports:'./index.mjs'}));
  await writeFile(join(sdk,'index.mjs'),'export const definePlugin = p => p; export const runWorker = () => {};\n');
}

test('G-1 source manifests: pristine upstream accepts clean and explicitly rejects transitional fork capability',()=>{
  const clean=pluginManifestV1Schema.safeParse(buildManifest({variant:'clean'}));
  assert.equal(clean.success,true,JSON.stringify(clean.error?.issues));
  assert.equal(clean.data.aiConnectionRouter.name,'Model Capacity pool');
  const transitional=pluginManifestV1Schema.safeParse(buildManifest({variant:'transitional'}));
  assert.equal(transitional.success,false,'pristine upstream must not silently accept the residual fork capability');
  assert.ok(transitional.error.issues.some(i=>i.path[0]==='capabilities'));
});

test('G-1 actual tarballs preserve plugin identity and bake matching manifest/worker variants without a runtime toggle',async t=>{
  const {dir,packages}=await build(t);assert.equal(packages.length,2);
  const tarballs=new Set();
  for(const artifact of packages) {
    assert.ok(artifact.tarball.endsWith('.tgz'));tarballs.add(artifact.tarball);
    const unpack=join(dir,`unpacked-${artifact.variant}`);await mkdir(unpack);
    execFileSync('tar',['-xzf',artifact.tarball,'-C',unpack]);
    const directory=join(unpack,'package'),pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
    assert.equal(pkg.name,'@togetherweown/paperclip-plugin-model-capacity');
    assert.equal(pkg.version,`0.3.1-${artifact.variant}`);
    assert.notEqual(pkg.paperclipPlugin.manifest,'./src/manifest.enforce.mjs');
    const module=await import(pathToFileURL(resolve(directory,pkg.paperclipPlugin.manifest)));
    const manifest=module.default;
    assert.equal(manifest.version,pkg.version);assert.equal(manifest.id,'togetherweown.model-capacity');
    assert.ok(manifest.capabilities.includes('ai.connections.route'));
    assert.equal(manifest.capabilities.includes('run.model.resolve'),artifact.variant==='transitional');
    const parsed=pluginManifestV1Schema.safeParse(manifest);
    assert.equal(parsed.success,artifact.variant==='clean');
    if(artifact.variant==='transitional')assert.match(pkg.description,/fork-image transitional dual-capability build, exit 2026-11-30/);
    const baked=await import(pathToFileURL(join(directory,'src/manifest.mjs')));
    assert.equal(Object.hasOwn(baked,'MODEL_ROUTING_ENV_KEYS'),artifact.variant==='transitional');
    await fakeSdk(directory);
    const worker=await import(pathToFileURL(resolve(directory,manifest.entrypoints.worker)));
    assert.equal(typeof worker.default.onRouteAiConnection,'function');
    assert.equal(typeof worker.default.onResolveRunModel,artifact.variant==='transitional'?'function':'undefined');
    const {createModelCapacityPlugin}=await import(pathToFileURL(join(directory,'src/plugin.mjs')));
    assert.throws(()=>createModelCapacityPlugin({variant:artifact.variant==='clean'?'transitional':'clean'}),/variant/);
    await t.test(`${artifact.variant} packed worker logs its baked variant at WARN on every boot`,async()=>{
      const expected=artifact.variant==='transitional'
        ? {variant:'transitional',exitDate:'2026-11-30'} : {variant:'clean'};
      // First exercise the packed worker, then a fresh default factory instance:
      // no runtime variant argument, config, or quota job may be needed to warn.
      for(const plugin of [worker.default,createModelCapacityPlugin()]) {
        const h=stateHarness();
        await plugin.setup({state:h.state,logger:h.logger,jobs:{register(){}},events:{on(){}}});
        const warnings=h.logs.filter(log=>log.level==='warn');
        assert.equal(warnings.length,1,'every boot must emit a visible variant self-check before configuration');
        assert.deepEqual(warnings[0].details,expected);
        assert.match(warnings[0].message,new RegExp(`variant=${expected.variant}\\b`));
        if(artifact.variant==='transitional')assert.match(warnings[0].message,/2026-11-30/);
        else assert.doesNotMatch(JSON.stringify(warnings[0]),/exit|2026-11-30/);
      }
    });
    for(const path of ['src/router.mjs','src/overlay.mjs','src/pool-quality.mjs','scripts/pool-saga.mjs','test/fixtures/upstream-schemas/ai-connection-router.js'])
      assert.equal(existsSync(join(directory,path)),true,`tarball missing ${path}`);
  }
  assert.equal(tarballs.size,2,'artifacts must have distinguishable filenames');
});

test('content-stamped manifest shims load a changed manifest at the same path/version in one module cache',async t=>{
  const {dir,packages}=await build(t),artifact=packages.find(p=>p.variant==='clean');
  const pkg=JSON.parse(await readFile(join(artifact.directory,'package.json'),'utf8'));
  const entry=resolve(artifact.directory,pkg.paperclipPlugin.manifest);
  const initial=await import(pathToFileURL(entry));
  assert.equal(initial.default.displayName,'Model Capacity');
  const manifestFile=join(artifact.directory,'src/manifest.mjs');
  const source=await readFile(manifestFile,'utf8');
  await writeFile(manifestFile,source.replace('"displayName": "Model Capacity"','"displayName": "Changed native router"'));
  const shim=await readFile(entry,'utf8');
  assert.match(shim,/\?build=[a-f0-9]+/);
  await writeFile(entry,shim.replace(/\?build=[a-f0-9]+/g,'?build=abcdef123456'));
  const changed=await import(`${pathToFileURL(entry).href}?reinstall=2`);
  assert.equal(changed.default.version,initial.default.version);
  assert.equal(changed.default.displayName,'Changed native router','reinstall must not retain the old cached manifest dependency');
});
