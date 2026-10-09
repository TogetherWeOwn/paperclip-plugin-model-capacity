/**
 * Shadow ledger: what the plugin WOULD have decided for recently started
 * runs. Bounded ring buffer (~2000 entries); newest wins on overflow.
 * v0.1.0 writes this and serves it on GET /shadow -- it changes nothing.
 */

export const SHADOW_CAPACITY = 2000;

const REQUIRED = ['runId', 'agentId', 'wouldModel', 'accountId', 'rung', 'reason'];

export function validRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (typeof record.at !== 'number' || !Number.isFinite(record.at)) return false;
  return REQUIRED.every(k => typeof record[k] === 'string' || typeof record[k] === 'number');
}

export function createShadowRing(capacity = SHADOW_CAPACITY) {
  const entries = [];
  return {
    push(record) {
      if (!validRecord(record)) throw new Error('invalid-shadow-record');
      entries.push({ ...record });
      while (entries.length > capacity) entries.shift();
      return entries.length;
    },
    list(limit = 100) {
      return entries.slice(-Math.max(0, limit)).reverse().map(e => ({ ...e }));
    },
    size() {
      return entries.length;
    },
    // Drop every entry matching pred (startup/upgrade reconciliation uses
    // this to evict carried entries that verify against nothing). Returns
    // the number removed.
    prune(pred) {
      let removed = 0;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (pred(entries[i])) {
          entries.splice(i, 1);
          removed += 1;
        }
      }
      return removed;
    },
    toJSON() {
      return entries.map(e => ({ ...e }));
    },
    load(saved) {
      entries.length = 0;
      for (const e of Array.isArray(saved) ? saved.slice(-capacity) : []) {
        if (validRecord(e)) entries.push({ ...e });
      }
    },
  };
}
