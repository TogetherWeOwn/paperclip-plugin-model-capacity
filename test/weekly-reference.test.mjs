import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

async function portableReference(t) {
  const dir = await mkdtemp(join(tmpdir(), 'weekly-reference-portable-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'test/fixtures'), { recursive: true });
  for (const path of [
    'weekly-reference.mjs',
    'generate-weekly-reference.mjs',
    'fixtures/weekly-77d8049-src-package.tar.gz.b64',
    'fixtures/weekly-77d8049-src-package.provenance.json',
    'fixtures/weekly-77d8049-aa-replay.mjs',
  ]) {
    await copyFile(new URL(path, import.meta.url), join(dir, 'test', path));
  }
  const { loadWeeklyReference } = await import(pathToFileURL(join(dir, 'test/weekly-reference.mjs')).href);
  return { dir, loadWeeklyReference };
}

test('weekly reference ignores absent or changed moving harnesses without git history', async t => {
  const { dir, loadWeeklyReference } = await portableReference(t);
  for (const movingHarnessPresent of [false, true]) {
    if (movingHarnessPresent) {
      await mkdir(join(dir, 'scripts'));
      await writeFile(join(dir, 'scripts/aa-replay.mjs'), 'throw new Error("moving harness executed");\n');
    }
    const reference = await loadWeeklyReference();
    t.after(reference.cleanup);
    const output = execFileSync(process.execPath, [join(dir, 'test/generate-weekly-reference.mjs')], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.match(output, /pinned git object absent; regeneration skipped, fixture check stands alone/);
    assert.match(output, /weekly reference check passed/);
  }
});

test('weekly reference rejects a changed frozen harness before executing it', async t => {
  const { dir, loadWeeklyReference } = await portableReference(t);
  const harness = join(dir, 'test/fixtures/weekly-77d8049-aa-replay.mjs');
  await writeFile(harness, Buffer.concat([
    await readFile(harness),
    Buffer.from('\nthrow new Error("unverified harness executed");\n'),
  ]));
  await assert.rejects(loadWeeklyReference(), { code: 'ERR_ASSERTION' });
  assert.throws(() => execFileSync(process.execPath, [join(dir, 'test/generate-weekly-reference.mjs')], {
    cwd: dir,
    encoding: 'utf8',
    stdio: 'pipe',
  }), error => {
    assert.equal(error.status, 1);
    assert.match(error.stdout, /FAIL harness hash:/);
    assert.match(error.stderr, /weekly reference check failed \(1\)/);
    return true;
  });
});
