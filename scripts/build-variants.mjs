#!/usr/bin/env node
/** Local package build only. Never installs, publishes, or touches a host service. */
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildManifest, LANE_BASE_URL_ALLOWLIST, MODEL_ROUTING_ENV_KEYS } from '../src/manifest.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
async function sourceStamp(directory,hash=createHash('sha256')) {
  for (const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const path=join(directory,entry.name);hash.update(entry.name);
    if (entry.isDirectory()) await sourceStamp(path,hash);
    else if (entry.isFile()) hash.update(await readFile(path));
    else throw new Error('unsupported source entry');
  }
  return hash;
}

function cut(source,start,end) {
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  if(a<0 || b<0 || source.indexOf(start,a+start.length)>=0) throw new Error('hook-only build boundary changed; review clean extraction');
  return source.slice(0,a)+source.slice(b);
}

function bakePlugin(source,variant) {
  if (variant==='clean') {
    const start=source.indexOf('    async onResolveRunModel(params) {');
    const end=source.lastIndexOf('\n    },\n  };');
    if (start<0 || end<=start) throw new Error('retained hook boundary changed; review clean build extraction');
    source=source.slice(0,start)+source.slice(end+'\n    },'.length);
    // Remove the hook's retry/deferral state and private entry helpers too.
    // Shared pacing still counts executing runs, but no clean run can be
    // deferred by this plugin. Guarded boundaries fail the build on refactors.
    source=cut(source,'  // Runs the enforcing hook deferred,','  /**\n   * Pooled in-flight for the pace guard:');
    source=cut(source,'  /**\n   * Pooled in-flight for the pace guard:','  const runEventStats =');
    const census=`  // Clean build: all non-terminal ledger runs count; no hook retry marks.
  const paceInFlightByPool = (companyId, ledger, { nowMs, horizonMs, selfRunId = null, poolOf }) => {
    const self = selfRunId != null ? String(selfRunId) : null;
    const census = physicalCensus(ledger, { nowMs, horizonMs, skip: r => r?.runId === self });
    const pools = {};
    for (const [id, n] of Object.entries(census.byAccount)) {
      const p = poolOf(id);
      pools[p] = (pools[p] ?? 0) + n;
    }
    return { pools, byAccount: census.byAccount, unattributed: census.unattributed };
  };
`;
    source=source.replace('  const runEventStats =',census+'  const runEventStats =');
    source=cut(source,'  const invalidatedDefer =','  // Live view per company,');
    source=cut(source,'  function routeFreeRun(params, live, role, ledger) {','  function credentialReadinessEnforced(companyId) {');
    source=cut(source,'  /**\n   * Deferral-exhaustion answer (Design B, memory-only).','  // A pinned agent\'s run, counted on the account serving its configured');
    source=source.replace('          clearDeferred(companyId, entry.runId);\n','');
    // Retired identifiers in historical comments must not masquerade as live
    // clean surfaces in the runtime-artifact grep proof. Never rewrite code.
    source=source.split('\n').filter(line=>!/^\s*(?:\*|\/\/)/.test(line)
      || !/run\.model\.resolve|onResolveRunModel|deferredRuns/.test(line)).join('\n');
  }
  // The artifact's factory cannot be flipped by runtime options either.
  source=source.replace("variant = 'transitional'",`variant = '${variant}'`)
    .replace("if (!['transitional','clean'].includes(variant))",`if (variant !== '${variant}')`)
    .replace("  if (variant === 'clean') delete plugin.onResolveRunModel;\n",'');
  return source;
}

export async function buildVariantPackages({outputDir}) {
  if (!outputDir) throw new Error('outputDir required');
  outputDir=resolve(outputDir);
  await mkdir(outputDir,{recursive:true});
  const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const stamp=(await sourceStamp(join(root,'src'))).update(JSON.stringify(pkg))
    .update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
  const source=await readFile(join(root,'src/plugin.mjs'),'utf8'), artifacts=[];
  for (const variant of ['transitional','clean']) {
    const directory=join(outputDir,variant);
    // Refuse overwriting an earlier artifact, particularly a pinned host build.
    await mkdir(directory);
    for (const file of pkg.files) await cp(join(root,file),join(directory,file),{recursive:true});
    const manifest=buildManifest({variant});
    manifest.entrypoints.worker=`./src/worker.${variant}.mjs`;
    const variantStamp=createHash('sha256').update(stamp).update(variant).digest('hex');
    const manifestEntry=`./src/manifest.${variant}.mjs`;
    const baked=`/** Build-time ${variant} manifest. Do not edit installed artifacts. */\n`
      +`export const manifest = ${JSON.stringify(manifest,null,2)};\n`
      +`export const PLUGIN_ID = ${JSON.stringify(manifest.id)};\n`
      +`export const PLUGIN_VERSION = ${JSON.stringify(manifest.version)};\n`
      +`export const LANE_BASE_URL_ALLOWLIST = ${JSON.stringify(LANE_BASE_URL_ALLOWLIST)};\n`
      +(variant==='transitional'?`export const MODEL_ROUTING_ENV_KEYS = ${JSON.stringify(MODEL_ROUTING_ENV_KEYS)};\n`:'')
      +'export default manifest;\n';
    await writeFile(join(directory,'src/manifest.mjs'),baked);
    await writeFile(join(directory,manifestEntry),`export * from './manifest.mjs?build=${variantStamp}';\nexport { default } from './manifest.mjs?build=${variantStamp}';\n`);
    await writeFile(join(directory,manifest.entrypoints.worker),`import { runWorker } from '@paperclipai/plugin-sdk';\nimport plugin from './worker.mjs?build=${variantStamp}';\nexport default plugin;\nrunWorker(plugin, import.meta.url);\n`);
    await writeFile(join(directory,'src/build-variant.mjs'),`export const BUILD_VARIANT = '${variant}';\n`);
    await writeFile(join(directory,'src/plugin.mjs'),bakePlugin(source,variant));
    const example=JSON.parse(await readFile(join(directory,'config.example.json'),'utf8'));
    if(variant==='clean') delete example.enforce;
    await writeFile(join(directory,'config.example.json'),JSON.stringify(example,null,2)+'\n');
    const variantPackage={...pkg,version:manifest.version,description:manifest.description,
      paperclipPlugin:{manifest:manifestEntry,worker:manifest.entrypoints.worker}};
    await writeFile(join(directory,'package.json'),JSON.stringify(variantPackage,null,2)+'\n');
    const [packed]=JSON.parse(execFileSync('npm',['pack','--json','--ignore-scripts','--pack-destination',outputDir],{cwd:directory,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
    artifacts.push({variant,directory,tarball:join(outputDir,packed.filename),stamp:variantStamp});
  }
  return artifacts;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const args=process.argv.slice(2);
  if (args.length!==2 || args[0]!=='--out-dir') throw new Error('usage: build-variants.mjs --out-dir <new artifact directory>');
  console.log(JSON.stringify(await buildVariantPackages({outputDir:args[1]}),null,2));
}
