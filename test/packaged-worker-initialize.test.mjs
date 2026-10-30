import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildVariantPackages } from '../scripts/build-variants.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('each packaged worker starts as the host entrypoint and initializes via real SDK RPC', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mc-worker-rpc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const packages = await buildVariantPackages({ outputDir: join(dir, 'artifacts') });
  for (const artifact of packages) {
    await t.test(artifact.variant, async () => {
      const unpack = join(dir, artifact.variant);
      await mkdir(unpack);
      execFileSync('tar', ['-xzf', artifact.tarball, '-C', unpack]);
      const directory = join(unpack, 'package');
      // The host supplies the SDK as a peer; use the locked real SDK, not a stub.
      await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      const manifest = (await import(pathToFileURL(resolve(directory, pkg.paperclipPlugin.manifest)))).default;
      const entrypoint = resolve(directory, manifest.entrypoints.worker);
      assert.equal(entrypoint, resolve(directory, pkg.paperclipPlugin.worker));
      const child = spawn(process.execPath, [entrypoint], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
      const closed = new Promise(resolveExit => child.once('close', resolveExit));
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.stdin.on('error', () => {});
      const lines = createInterface({ input: child.stdout });
      try {
        const response = await new Promise((resolveResponse, reject) => {
          const timeout = setTimeout(() => reject(new Error(`initialize timed out: ${stderr}`)), 5000);
          const finish = fn => value => { clearTimeout(timeout); fn(value); };
          const succeed = finish(resolveResponse), fail = finish(reject);
          child.once('error', fail);
          child.once('exit', (code, signal) => fail(new Error(`worker exited before initialize: code=${code} signal=${signal} stderr=${stderr}`)));
          lines.on('line', line => {
            try {
              const message = JSON.parse(line);
              if (message.id === 'init' && !message.method) succeed(message);
            } catch (error) { fail(error); }
          });
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: {
            manifest, config: {}, instanceInfo: {}, apiVersion: 1, databaseNamespace: null,
          } }) + '\n');
        });
        assert.equal(response.error, undefined, JSON.stringify(response.error));
        assert.equal(response.result?.ok, true);
        assert.ok(response.result.supportedMethods.includes('routeAiConnection'));
      } finally {
        lines.close();
        child.kill();
        await closed;
      }
    });
  }
});
