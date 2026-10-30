import { writeFile } from 'node:fs/promises';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { runDevinParity } from './devin-default-parity-runner.mjs';
const cases = await runDevinParity(createModelCapacityPlugin);
await writeFile(new URL('./devin-default-parity.golden.json', import.meta.url), `${JSON.stringify({ baseline: 'a368f5c', cases }, null, 2)}\n`);
