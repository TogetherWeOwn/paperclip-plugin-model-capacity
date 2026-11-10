import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const before = 'bb991eed932454ea4ac8d28d5b8ec11df64b8447';
const root = fileURLToPath(new URL('../', import.meta.url));

// Run immutable source controls on Actions, not by rewriting the PR branch or
// running another local suite. CI fetches full history for existing replay tests.
test('retained census: four discriminating Actions source comparisons', {
  skip: process.env.GITHUB_ACTIONS !== 'true' ? 'source comparison runs on GitHub Actions only' : false,
  timeout: 120_000,
}, () => {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const after = event.pull_request?.head?.sha ?? process.env.GITHUB_SHA;
  assert.match(after, /^[a-f0-9]{40}$/);
  const dir = mkdtempSync(join(tmpdir(), 'retained-census-'));
  try {
    for (const [label, sha] of [['before', before], ['corrected', after]]) {
      const source = join(dir, label);
      mkdirSync(source);
      const archive = execFileSync('git', ['-C', root, 'archive', sha, 'src', 'scripts', 'package.json', 'test/synthetic-readiness.mjs']);
      execFileSync('tar', ['-x', '-C', source], { input: archive });
      copyFileSync(join(root, 'test/caps.test.mjs'), join(source, 'test/caps.test.mjs'));
      for (const finding of ['F1', 'F2', 'F3', 'F4']) {
        const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap',
          `--test-name-pattern=^retained census ${finding}:`, join(source, 'test/caps.test.mjs')], {
          cwd: source, encoding: 'utf8', timeout: 20_000,
        });
        console.log(`${finding} ${label} source=${sha} regression-input=${after}\n${result.stdout}\n${result.stderr}`);
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, label === 'before' ? 1 : 0, `${finding} ${label} exit`);
        assert.match(result.stdout, label === 'before' ? /# fail 1\b/ : /# pass 1\b/);
        assert.match(result.stdout, new RegExp(`${label === 'before' ? 'not ok' : 'ok'} \\d+ - retained census ${finding}:`));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
