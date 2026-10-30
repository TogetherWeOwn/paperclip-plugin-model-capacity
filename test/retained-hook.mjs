import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const declaration = Buffer.from('    async onResolveRunModel(params) {\n');
const closing = Buffer.from('\n    },\n  };');
const hookClosing = Buffer.from('\n    },');
const historicalBytes = 20712;
const historicalSha256 = 'a88973e149e624c3331b089c710044326847273a86766a5f3af46c3255827da2';

// Independent historical offsets and literal approved deltas, never inferred
// from the candidate. Every other byte of the retained hook stays frozen.
const insertions = [
  {
    name: 'default', historicalOffset: 295, currentOffset: 295, bytes: 473, lines: 6,
    sha256: 'd9d5cf248c0cf9aa45a53abfc77368e10fcdde9ce38346bdfad066438da97ec7',
    text: `        if (live?.enforce === true && enforceCompanies.has(params?.companyId)
          && !(typeof params?.issueOverrideModel === 'string' && params.issueOverrideModel.length > 0)
          && weeklyRouteHeld(live, params?.agentDefaultModel ?? live.keptByAgent?.[params?.agentId]?.model)) {
          return { kind: 'defer', retryAfterMs: live.paceGuard?.retryAfterMs ?? 300000,
            reason: 'weekly hold: default emission can reach a held credential' };
        }
`,
  },
  {
    name: 'pinned', historicalOffset: 6338, currentOffset: 6811, bytes: 298, lines: 4,
    sha256: '10705cb0d96e767043d2ab865dd7b55f4ed5b583c0b25f6854d9f87462e82922',
    text: `        if (weeklyRouteHeld(live, params.agentDefaultModel ?? live.keptByAgent?.[params.agentId]?.model)) {
          return deferred({ kind: 'defer', retryAfterMs: live.paceGuard?.retryAfterMs ?? 300000,
            reason: 'weekly hold: pinned emission can reach a held credential' });
        }
`,
  },
  {
    name: 'stale', historicalOffset: 8904, currentOffset: 9675, bytes: 280, lines: 3,
    sha256: '05bc4d7834aff670435e8635ff498db6ba647af9e0b51dfcbc45d2feb4934f21',
    text: `        if (weeklyRouteHeld(live, params.agentDefaultModel)) return deferred({ kind: 'defer',
          retryAfterMs: live.paceGuard?.retryAfterMs ?? 300000,
          reason: 'weekly hold: stale default emission can reach a held credential' }, { countTowardExhaustion: false });
`,
  },
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function extractRetainedHook(source) {
  assert.ok(Buffer.isBuffer(source), 'hook source must be raw bytes');
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, 'missing exact hook declaration');
  assert.ok(start === 0 || source[start - 1] === 10, 'hook declaration must start a line');
  assert.equal(source.indexOf(declaration, start + declaration.length), -1, 'ambiguous hook declaration');
  const end = source.indexOf(closing, start + declaration.length);
  assert.ok(end >= 0, 'missing exact hook closing boundary');
  assert.equal(source.indexOf(closing, end + closing.length), -1, 'ambiguous hook closing boundary');
  return source.subarray(start, end + hookClosing.length);
}

export function verifyRetainedHook(body) {
  assert.ok(Buffer.isBuffer(body), 'hook body must be raw bytes');
  assert.equal(body.length, 21763, 'retained hook plus mandatory guards byte length');
  const kept = [];
  let cursor = 0;
  let insertedBytes = 0;
  for (const insertion of insertions) {
    const block = Buffer.from(insertion.text);
    assert.equal(block.length, insertion.bytes, `${insertion.name}: pinned byte length`);
    assert.equal(block.filter(byte => byte === 10).length, insertion.lines, `${insertion.name}: pinned line count`);
    assert.equal(sha256(block), insertion.sha256, `${insertion.name}: pinned literal fingerprint`);
    assert.equal(insertion.currentOffset, insertion.historicalOffset + insertedBytes, `${insertion.name}: insertion boundary`);
    assert.ok(insertion.currentOffset >= cursor, `${insertion.name}: non-overlapping span`);
    assert.deepEqual(body.subarray(insertion.currentOffset, insertion.currentOffset + block.length), block,
      `${insertion.name}: mandatory guard bytes at fixed offset`);
    assert.equal(body.indexOf(block), insertion.currentOffset, `${insertion.name}: first occurrence`);
    assert.equal(body.indexOf(block, insertion.currentOffset + 1), -1, `${insertion.name}: duplicate guard`);
    kept.push(body.subarray(cursor, insertion.currentOffset));
    cursor = insertion.currentOffset + block.length;
    insertedBytes += block.length;
  }
  kept.push(body.subarray(cursor));
  const retained = Buffer.concat(kept);
  assert.equal(retained.length, historicalBytes, 'historical retained hook byte length');
  assert.equal(sha256(retained), historicalSha256, 'historical retained hook fingerprint');

  const restored = [];
  cursor = 0;
  for (const insertion of insertions) {
    restored.push(retained.subarray(cursor, insertion.historicalOffset), Buffer.from(insertion.text));
    cursor = insertion.historicalOffset;
  }
  restored.push(retained.subarray(cursor));
  assert.deepEqual(Buffer.concat(restored), body, 'approved delta must reconstruct the complete candidate');
  return retained;
}
