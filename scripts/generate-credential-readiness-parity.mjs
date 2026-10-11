import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPluginFactory, runParityCorpus } from '../test/credential-readiness-parity-runner.mjs';

const baselineRoot = process.argv[2];
if (!baselineRoot) {
  throw new Error('usage: node scripts/generate-credential-readiness-parity.mjs <0dfe5cb-worktree>');
}
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const createModelCapacityPlugin = await loadPluginFactory(resolve(baselineRoot));
const corpus = await runParityCorpus(createModelCapacityPlugin, resolve(baselineRoot));
await writeFile(
  resolve(root, 'test/credential-readiness-parity.golden.json'),
  `${JSON.stringify({ baseline: '0dfe5cb', cases: corpus }, null, 2)}\n`,
);
process.stdout.write('Wrote test/credential-readiness-parity.golden.json from baseline 0dfe5cb.\n');
