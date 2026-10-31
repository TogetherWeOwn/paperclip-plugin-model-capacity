import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extractRetainedHook, verifyRetainedHook } from './retained-hook.mjs';

const source = await readFile(new URL('../src/plugin.mjs', import.meta.url));
const body = extractRetainedHook(source);
const spans = [
  { name: 'default', historicalOffset: 295, offset: 295, bytes: 473 },
  { name: 'pinned', historicalOffset: 6338, offset: 6811, bytes: 298 },
  { name: 'stale', historicalOffset: 8904, offset: 9675, bytes: 280 },
];
// Independently prescribed spans, not offsets or allowances returned by the verifier.
const historical = Buffer.concat([
  body.subarray(0, 295), body.subarray(768, 6811),
  body.subarray(7109, 9675), body.subarray(9955),
]);
const splice = (bytes, offset, removed, inserted = Buffer.alloc(0)) => Buffer.concat([
  bytes.subarray(0, offset), inserted, bytes.subarray(offset + removed),
]);
const envelope = bytes => Buffer.concat([Buffer.from('const plugin = {\n'), bytes, Buffer.from('\n  };\n')]);
const rejection = { code: 'ERR_ASSERTION' };

// A missing safety guard is forbidden even when the old fingerprint is intact.
// Conversely, the three approved insertions must not permit any other edit.
test('retained hook accepts exactly the approved delta over the historical fingerprint', () => {
  assert.equal(historical.length, 20712);
  assert.equal(createHash('sha256').update(historical).digest('hex'),
    'a88973e149e624c3331b089c710044326847273a86766a5f3af46c3255827da2');
  assert.equal(body.length, 21763);
  assert.deepEqual(verifyRetainedHook(body), historical);
  assert.deepEqual(extractRetainedHook(envelope(body)), body);
});

test('retained hook rejects the unmodified historical body because every new guard is mandatory', () => {
  assert.throws(() => verifyRetainedHook(historical), rejection);
});

for (const span of spans) {
  test(`retained hook rejects a missing ${span.name} guard`, () => {
    assert.throws(() => verifyRetainedHook(splice(body, span.offset, span.bytes)), rejection);
  });

  test(`retained hook rejects a duplicated ${span.name} guard`, () => {
    const block = body.subarray(span.offset, span.offset + span.bytes);
    assert.throws(() => verifyRetainedHook(splice(body, span.offset, 0, block)), rejection);
  });

  for (const shift of [-1, 1]) {
    test(`retained hook rejects a relocated ${span.name} guard (${shift} byte)`, () => {
      const block = body.subarray(span.offset, span.offset + span.bytes);
      const without = splice(body, span.offset, span.bytes);
      const moved = splice(without, span.offset + shift, 0, block);
      assert.equal(moved.length, body.length);
      assert.equal(moved.indexOf(block), span.offset + shift);
      assert.equal(moved.indexOf(block, span.offset + shift + 1), -1);
      assert.throws(() => verifyRetainedHook(moved), {
        code: 'ERR_ASSERTION', message: new RegExp(`${span.name}: mandatory guard bytes at fixed offset`),
      });
    });
  }

  for (const [name, before, after] of [
    ['predicate', 'weeklyRouteHeld', 'weeklyRouteHelp'],
    ['retry', '300000', '000000'],
    ['reason', 'weekly hold', 'weekly skip'],
  ]) {
    test(`retained hook rejects a changed ${span.name} ${name}`, () => {
      const block = body.subarray(span.offset, span.offset + span.bytes);
      const at = block.indexOf(before);
      assert.ok(at >= 0, `${name} mutation must hit the guard`);
      assert.equal(before.length, after.length);
      const changed = splice(body, span.offset + at, before.length, Buffer.from(after));
      assert.equal(changed.length, body.length);
      assert.throws(() => verifyRetainedHook(changed), {
        code: 'ERR_ASSERTION', message: new RegExp(`${span.name}: mandatory guard bytes at fixed offset`),
      });
    });
  }

  test(`retained hook rejects a change to every byte of the ${span.name} guard`, t => {
    for (let byte = 0; byte < span.bytes; byte += 1) {
      const changed = Buffer.from(body);
      changed[span.offset + byte] ^= 1;
      assert.throws(() => verifyRetainedHook(changed), rejection, `${span.name} byte ${byte}`);
    }
    t.diagnostic(`${span.bytes}/${span.bytes} single-byte guard mutations rejected`);
  });
}

for (const [name, mutate] of [
  ['extra insertion', bytes => splice(bytes, 15000, 0, Buffer.from(' '))],
  ['extra deletion', bytes => splice(bytes, 15000, 1)],
  ['retained replacement', bytes => {
    const changed = Buffer.from(bytes); changed[15000] ^= 1; return changed;
  }],
  ['length-preserving insertion and deletion', bytes => splice(splice(bytes, 15000, 1), 5000, 0, Buffer.from(' '))],
  ['UTF-8 replacement', bytes => splice(bytes, 15000, 2, Buffer.from('é'))],
]) {
  test(`retained hook rejects an unapproved ${name}`, () => {
    assert.throws(() => verifyRetainedHook(mutate(body)), rejection);
  });
}

test('retained hook rejects a change to every historical byte, including whitespace', t => {
  for (let byte = 0; byte < 20712; byte += 1) {
    const offset = byte + spans.filter(span => span.historicalOffset <= byte).reduce((n, span) => n + span.bytes, 0);
    const changed = Buffer.from(body);
    changed[offset] ^= 1;
    assert.throws(() => verifyRetainedHook(changed), {
      code: 'ERR_ASSERTION', message: /^historical retained hook fingerprint/,
    }, `historical byte ${byte}, candidate byte ${offset}`);
  }
  t.diagnostic('20712/20712 single-byte retained mutations rejected');
});

const declaration = Buffer.from('    async onResolveRunModel(params) {\n');
const closing = Buffer.from('\n    },\n  };');
for (const [name, candidate, message] of [
  ['missing declaration', Buffer.from('const plugin = {};\n'), 'missing exact hook declaration'],
  ['changed declaration whitespace', splice(envelope(body), 17, 1), 'missing exact hook declaration'],
  ['commented declaration', Buffer.concat([Buffer.from('//'), body, Buffer.from('\n  };\n')]), 'hook declaration must start a line'],
  ['duplicate declaration', Buffer.concat([declaration, envelope(body)]), 'ambiguous hook declaration'],
  ['missing closing boundary', Buffer.concat([Buffer.from('const plugin = {\n'), body]), 'missing exact hook closing boundary'],
  ['closing before declaration only', Buffer.concat([closing, Buffer.from('\n'), declaration]), 'missing exact hook closing boundary'],
  ['duplicate closing boundary', Buffer.concat([envelope(body), closing]), 'ambiguous hook closing boundary'],
  ['CRLF normalization', Buffer.from(envelope(body).toString('utf8').replaceAll('\n', '\r\n')), 'missing exact hook declaration'],
]) {
  test(`retained hook extraction rejects ${name}`, () => {
    assert.throws(() => extractRetainedHook(candidate), { code: 'ERR_ASSERTION', message: new RegExp(`^${message}`) });
  });
}

test('retained hook extraction does not mistake an earlier object closing for the hook boundary', () => {
  assert.deepEqual(extractRetainedHook(Buffer.concat([closing, Buffer.from('\n'), envelope(body)])), body);
});
