import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildVariantPackages } from '../scripts/build-variants.mjs';

async function files(dir, prefix = '') {
  const out = [];
  for (const e of await readdir(dir, {withFileTypes:true})) {
    const path = prefix + e.name;
    if (e.isDirectory()) out.push(...await files(join(dir,e.name),path+'/'));
    else out.push(path);
  }
  return out.sort();
}

// Catches a variant stamp/name mismatch, accidental residual-hook shipping,
// or a builder change leaking into shared routing logic (U19).
test('release tarballs identify BOTH variants and differ only on the U19 build allowlist', async t => {
  const dir = await mkdtemp(join(tmpdir(),'mc-release-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const packages = await buildVariantPackages({outputDir:join(dir,'artifacts')});
  const roots = {};
  for (const p of packages) {
    assert.match(p.tarball,new RegExp(`0\\.3\\.0-${p.variant}\\.tgz$`));
    const unpack = join(dir,p.variant); await mkdir(unpack);
    execFileSync('tar',['-xzf',p.tarball,'-C',unpack]); roots[p.variant] = join(unpack,'package');
    const pkg = JSON.parse(await readFile(join(roots[p.variant],'package.json'),'utf8'));
    assert.equal(pkg.version,`0.3.0-${p.variant}`);
    assert.equal(pkg.paperclipPlugin.manifest,`./src/manifest.${p.variant}.mjs`);
    assert.ok((await files(roots[p.variant])).includes('scripts/audit-env-pins.mjs'));
    assert.ok(!(await files(roots[p.variant])).includes('src/manifest.enforce.mjs'));
    const example = JSON.parse(await readFile(join(roots[p.variant],'config.example.json'),'utf8'));
    assert.equal(Object.hasOwn(example,'enforce'),p.variant==='transitional');
    const plugin = await readFile(join(roots[p.variant],'src/plugin.mjs'),'utf8');
    // Execute unchanged U1-U17/router and native lifecycle assertions against
    // EACH unpacked artifact, including the clean terminal-event cleanup path.
    const childEnv = {...process.env}; delete childEnv.NODE_TEST_CONTEXT;
    const smoke = execFileSync(process.execPath,['--test','--test-reporter=tap',
      join(roots[p.variant],'test/router.test.mjs'),
      join(roots[p.variant],'test/router-callback-lifecycle.test.mjs'),
      join(roots[p.variant],'test/snapshot.test.mjs'),
      join(roots[p.variant],'test/router-views.test.mjs'),
      ...(p.variant === 'transitional' ? [
        'devin-default-parity.test.mjs', 'devin-lane.test.mjs', 'reviewer-routing.test.mjs',
      ].map(file => join(roots[p.variant],'test',file)) : []),
    ],{encoding:'utf8',timeout:60000,env:childEnv});
    assert.match(smoke,/# fail 0/);

    if (p.variant === 'clean') {
      for (const token of ['run.model.resolve','onResolveRunModel','model_decision_pending','usage-queue','enforceManifest','deferredRuns','exhaustionStreaks','invalidatedDefer']) {
        for (const path of await files(join(roots.clean,'src'))) {
          assert.ok(!(await readFile(join(roots.clean,'src',path),'utf8')).includes(token),`${path}: retired token ${token}`);
        }
      }
    } else {
      // The exact hook body, not normalized whitespace, must survive packaging.
      const source = await readFile(new URL('../src/plugin.mjs',import.meta.url),'utf8');
      const hook = s => s.slice(s.indexOf('    async onResolveRunModel(params) {'),s.lastIndexOf('\n    },\n  };')+'\n    },'.length);
      assert.equal(hook(plugin),hook(source));
      // §17 pins the read-only 0.2.72 reference and main dc86ae4, not the
      // stale port handoff. Mainline integration must not regress that hook.
      // Re-pinned once for the no-live-view credential-readiness defer (TWO-355).
      assert.equal(createHash('sha256').update(hook(plugin)).digest('hex'),
        '4bcadf4d3129122063aa5e830c205212f4310211854486329b9ecb2449ec7b8d');
      const expected = source.replace("if (!['transitional','clean'].includes(variant))", "if (variant !== 'transitional')")
        .replace("  if (variant === 'clean') delete plugin.onResolveRunModel;\n", '');
      assert.equal(plugin,expected,'transitional helpers changed beyond the build-time factory guard');

    }
  }
  const all = new Set([...await files(roots.clean),...await files(roots.transitional)]);
  const allowed = new Set(['package.json','config.example.json','src/plugin.mjs','src/build-variant.mjs','src/manifest.mjs',
    'src/manifest.clean.mjs','src/manifest.transitional.mjs','src/worker.clean.mjs','src/worker.transitional.mjs']);
  for (const path of all) {
    const a = await readFile(join(roots.clean,path)).catch(()=>null);
    const b = await readFile(join(roots.transitional,path)).catch(()=>null);
    if (!a || !b || !a.equals(b)) assert.ok(allowed.has(path),`non-U19 variant difference: ${path}`);
  }
});

// Mirrors plugin-loader.ts:1352-1371: mtime query on the ENTRY only. Without
// the dependency's ?build= stamp, loading a changed entry still serves stale data.
test('native loader mtime cache-bust plus per-build shim observes same-version manifest replacement', async t => {
  const dir = await mkdtemp(join(tmpdir(),'mc-loader-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const [artifact] = await buildVariantPackages({outputDir:join(dir,'artifacts')});
  const pkg = JSON.parse(await readFile(join(artifact.directory,'package.json'),'utf8'));
  const entry = resolve(artifact.directory,pkg.paperclipPlugin.manifest);
  const load = async file => {
    const url = pathToFileURL(file);
    url.searchParams.set('mtime',String(Math.trunc((await stat(file)).mtimeMs)));
    return (await import(url.href)).default;
  };
  const first = await load(entry);
  const manifest = join(artifact.directory,'src/manifest.mjs');
  const source = await readFile(manifest,'utf8');
  await writeFile(manifest,source.replace('Model Capacity (Transitional)','Reinstalled router'));
  const shim = await readFile(entry,'utf8');
  const stamp = (await stat(entry)).mtimeMs + 2000;
  // Prove the dependency cache really exists before exercising the fix.
  await utimes(entry,stamp/1000,stamp/1000);
  assert.equal((await load(entry)).displayName,first.displayName);
  await writeFile(entry,shim.replace(/\?build=[a-f0-9]+/g,'?build=beef1234'));
  await utimes(entry,(stamp+2000)/1000,(stamp+2000)/1000);
  const changed = await load(entry);
  assert.equal(changed.version,first.version);
  assert.equal(changed.displayName,'Reinstalled router');
});
