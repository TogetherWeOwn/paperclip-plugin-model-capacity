import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('package contains the slice-3 drift library and its local dependencies', () => {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {cwd:root, encoding:'utf8'}));
  const files = new Set(pack.files.map(file => file.path));
  for (const path of ['src/registry.mjs', 'scripts/pool-saga.mjs', 'scripts/pool-plan.mjs', 'scripts/gateway-batch.mjs', 'scripts/generator-safety.mjs', 'scripts/pool-journal.mjs']) {
    assert.ok(files.has(path), `package missing ${path}`);
  }
});
