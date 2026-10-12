import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { runParityCorpus } from './credential-readiness-parity-runner.mjs';

const golden = JSON.parse(await readFile(new URL('./credential-readiness-parity.golden.json', import.meta.url), 'utf8'));

test('credential-readiness off mode matches the seeded 0dfe5cb parity corpus', async () => {
  assert.equal(golden.baseline, '0dfe5cb');
  const actual = await runParityCorpus(createModelCapacityPlugin, fileURLToPath(new URL('..', import.meta.url)));
  assert.deepEqual(actual, golden.cases);
});
