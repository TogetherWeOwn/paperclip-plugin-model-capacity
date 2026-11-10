import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const actionsOnly = {
  skip: process.env.GITHUB_ACTIONS !== 'true' ? 'source comparison runs on GitHub Actions only' : false,
  timeout: 120_000,
};

// Run immutable source controls on Actions, not by rewriting the PR branch or
// running another local suite. CI fetches full history for existing replay tests.
function compareSources(before, cases) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const after = event.pull_request?.head?.sha ?? process.env.GITHUB_SHA;
  assert.match(after, /^[a-f0-9]{40}$/);
  const dir = mkdtempSync(join(tmpdir(), 'retained-census-'));
  // An independent test runner must not inherit the parent's internal child
  // marker: Node otherwise skips it as a recursive node:test invocation.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    for (const [label, sha] of [['before', before], ['corrected', after]]) {
      const source = join(dir, label);
      mkdirSync(source);
      // Write the archive directly to a file: source size must not be limited
      // by execFileSync's stdout buffer (nor require buffering a tar in memory).
      const archive = join(dir, `${label}.tar`);
      execFileSync('git', ['-C', root, 'archive', '--output', archive, sha,
        'src', 'scripts', 'package.json', 'test/synthetic-readiness.mjs'], { timeout: 20_000 });
      execFileSync('tar', ['-xf', archive, '-C', source], { timeout: 20_000 });
      for (const file of new Set(cases.map(c => c.file))) {
        copyFileSync(join(root, file), join(source, file));
      }
      for (const { finding, file } of cases) {
        const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap',
          `--test-name-pattern=^retained census ${finding}:`, join(source, file)], {
          cwd: source, env: childEnv, encoding: 'utf8', timeout: 20_000,
        });
        console.log(`${finding} ${label} source=${sha} regression-input=${after}\n${result.stdout}\n${result.stderr}`);
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, label === 'before' ? 1 : 0, `${finding} ${label} exit`);
        assert.match(result.stdout, label === 'before' ? /# fail 1\b/ : /# pass 1\b/);
        assert.match(result.stdout, new RegExp(`${label === 'before' ? 'not ok' : 'ok'} \\d+ - retained census ${finding}:`));
        if (label === 'before') assert.match(result.stdout, /ERR_ASSERTION/, 'behavioral assertion, not a harness/import failure');
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('retained census: four discriminating Actions source comparisons', actionsOnly, () => {
  compareSources('bb991eed932454ea4ac8d28d5b8ec11df64b8447',
    ['F1', 'F2', 'F3', 'F4'].map(finding => ({ finding, file: 'test/caps.test.mjs' })));
});

test('retained census: admission classification and shadow-history Actions source comparisons', actionsOnly, () => {
  compareSources('f00cb78eca815bb76ba7c1ea6dfd7ef53f8393db', [
    { finding: 'G1', file: 'test/caps.test.mjs' },
    { finding: 'G1 free', file: 'test/free-lanes-plugin.test.mjs' },
    { finding: 'G2', file: 'test/ledger.test.mjs' },
  ]);
});
