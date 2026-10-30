// Weekly-compatible reference: synthetic assembly, never a live capture.
// Implementation is src+package from the pinned weekly revision, carried as a
// self-contained compressed archive fixture in text-safe base64 encoding.
// Harness is the unchanged current offline replay script copied into the
// assembly at test runtime. The replay script did not exist on the pinned revision.
//
// Portable loader: verifies fixture and harness hashes without requiring the
// pinned git object, without network, and without branch or tag fetch.
import assert from 'node:assert/strict';

export const WEEKLY_IMPLEMENTATION_REVISION = '77d8049bb50b3a8bf15be66873580add9040c66b';
export const WEEKLY_IMPLEMENTATION_TREE = '6d7d8c7895e2db20fa4d1a627ad9a947c1dca37b';
export const REPLAY_HARNESS_SHA256 = 'adf0d02c908057342e47efdaf985a71f37868807ab130cac69b6f3ebd0063b14';
export const WEEKLY_ARCHIVE_B64_SHA256 = '7bb009e2a0b925fb3fa72dcc5f8f46cd899cea92ab45922ad896a2c00e429c7f';
export const WEEKLY_ARCHIVE_SHA256 = '732c8257c89c50faf57a9e952b2feeceb3c6d39f39d62288446da9ddb8d65fa7';
export const WEEKLY_ARCHIVE_UNCOMPRESSED_SHA256 = '3f23928b54d5dc8cb145f4563c5d8ca89f5feec4c0a7eb5e1df9c9fdfaeefb8b';

export async function loadWeeklyReference() {
  const { mkdtemp, rm, mkdir, copyFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const { createHash } = await import('node:crypto');
  const { gunzipSync } = await import('node:zlib');
  const fixtureUrl = new URL('./fixtures/weekly-77d8049-src-package.tar.gz.b64', import.meta.url);
  const provenanceUrl = new URL('./fixtures/weekly-77d8049-src-package.provenance.json', import.meta.url);
  const harnessUrl = new URL('../scripts/aa-replay.mjs', import.meta.url);
  const dir = await mkdtemp(join(tmpdir(), 'aa-replay-weekly-'));
  try {
    const provenance = JSON.parse(await readFile(provenanceUrl, 'utf8'));
    assert.equal(provenance.implementation?.revision, WEEKLY_IMPLEMENTATION_REVISION);
    assert.equal(provenance.implementation?.tree, WEEKLY_IMPLEMENTATION_TREE);
    assert.equal(provenance.archive?.base64Sha256, WEEKLY_ARCHIVE_B64_SHA256);
    assert.equal(provenance.archive?.compressedSha256, WEEKLY_ARCHIVE_SHA256);
    assert.equal(provenance.archive?.uncompressedSha256, WEEKLY_ARCHIVE_UNCOMPRESSED_SHA256);
    assert.equal(provenance.harness?.sha256, REPLAY_HARNESS_SHA256);
    const encoded = await readFile(fixtureUrl, 'utf8');
    assert.equal(createHash('sha256').update(encoded, 'utf8').digest('hex'), WEEKLY_ARCHIVE_B64_SHA256);
    const compressed = Buffer.from(encoded.trim(), 'base64');
    assert.equal(createHash('sha256').update(compressed).digest('hex'), WEEKLY_ARCHIVE_SHA256);
    const archive = gunzipSync(compressed);
    assert.equal(createHash('sha256').update(archive).digest('hex'), WEEKLY_ARCHIVE_UNCOMPRESSED_SHA256);
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await copyFile(fileURLToPath(harnessUrl), join(dir, 'scripts/aa-replay.mjs'));
    const harnessBytes = await readFile(join(dir, 'scripts/aa-replay.mjs'));
    assert.equal(createHash('sha256').update(harnessBytes).digest('hex'), REPLAY_HARNESS_SHA256);
    const mod = await import(pathToFileURL(join(dir, 'scripts/aa-replay.mjs')).href);
    return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}
