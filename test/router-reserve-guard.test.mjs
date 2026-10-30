import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Port-owned call sites only; legacy plugin sites are not changed by this slice.
// Calls must be on one line, with an explicit reservePct in the options. This
// deliberately conservative grep fails closed on multiline calls and aliases.
function unpinned(source) {
  return source.split('\n').filter(line => {
    if (/^\s*(?:\/\/|\*|import\b|export\s+(?:async\s+)?function\b)/.test(line)) return false;
    return /\b(?:orderAccountsWithPacing|orderAccountsForRun)\s*\(/.test(line)
      && !/\breservePct\s*:/.test(line);
  });
}

test('port selector calls pin reservePct explicitly', () => {
  for (const name of ['router.mjs','views.mjs','overlay.mjs']) {
    const source = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
    assert.deepEqual(unpinned(source), [], name);
    assert.doesNotMatch(source, /\b(?:orderAccountsWithPacing|orderAccountsForRun)\s+as\s+\w+/);
  }
});
test('reserve guard detects an omitted option', () => {
  assert.equal(unpinned('const x = orderAccountsWithPacing(views, {placement});').length, 1);
  assert.equal(unpinned('const x = orderAccountsWithPacing(views, {reservePct: 1 - cap});').length, 0);
});
