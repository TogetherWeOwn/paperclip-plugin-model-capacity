import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createModelCapacityPlugin } from '../src/plugin.mjs';
import { runDevinParity } from './devin-default-parity-runner.mjs';

const golden = JSON.parse(await readFile(new URL('./devin-default-parity.golden.json', import.meta.url), 'utf8'));
test('Devin default behavior matches the frozen a368f5c corpus', async () => {
  assert.equal(golden.baseline, 'a368f5c');
  assert.deepEqual(await runDevinParity(createModelCapacityPlugin), golden.cases);
});
test('empty Devin options preserve the frozen corpus', async () => {
  assert.deepEqual(await runDevinParity(createModelCapacityPlugin, { bannedModels: [], trials: { unscoredServedIds: [] }, placement: { freeCostServedIds: {}, duplicateVersionPunctuationFolding: false } }), golden.cases);
});

test('parity corpus exercises decisions, including a dominated drop with shared scored backups', () => {
  for (const [name, entry] of Object.entries(golden.cases)) assert.equal(entry.hook.kind, 'decide', name);
  const shared = golden.cases['dominated-drop-shared-rung'];
  assert.deepEqual(shared.dominated, ['gpt-5.6-sol']);
  assert.deepEqual(shared.ladders['devin:aggregate'], [{ armId: 'glm-5', rung: 0 }, { armId: 'deepseek-v4-pro', rung: 1 }]);
});
