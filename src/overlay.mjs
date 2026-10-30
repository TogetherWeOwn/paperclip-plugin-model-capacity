/** Tick-local run-id overlay. All transitions return new state; no callback writes. */
export const createOverlay = () => ({});
export const resetOverlay = () => createOverlay();
const sets = (state, key) => {
  const entry = state[key] ?? {};
  return {post: new Set(entry.post), finishedPost: new Set(entry.finishedPost), finishedPre: new Set(entry.finishedPre)};
};
export function overlayStart(state, accountKey, runId) {
  const entry = sets(state, accountKey);
  if (!entry.finishedPost.has(runId) && !entry.finishedPre.has(runId)) entry.post.add(runId);
  return {...state, [accountKey]: entry};
}
export function overlayFinish(state, accountKey, runId) {
  const entry = sets(state, accountKey);
  if (entry.post.delete(runId)) entry.finishedPost.add(runId);
  else if (!entry.finishedPost.has(runId)) entry.finishedPre.add(runId);
  return {...state, [accountKey]: entry};
}
export function overlayDelta(state, accountKey) {
  const e = state[accountKey];
  return e ? e.post.size - e.finishedPre.size : 0;
}
export function overlayCount(state, accountKey, base) {
  return Math.max(0, (Number.isFinite(base) ? base : 0) + overlayDelta(state, accountKey));
}

/** Event-owned runtime overlay. capture/publish belong to the quota job; the
 * routing callback only calls deltas/status. Sequence checkpoints, rather than
 * wall-clock comparisons, preserve events received during state persistence
 * and distinguish events sharing the snapshot's millisecond.
 */
export function createRunOverlay() {
  const companies = new Map();
  const company = id => {
    if (!companies.has(id)) companies.set(id, {version:0,sequence:0,runs:new Map(),journal:[],baseRuns:{},seeded:new Set(),overlay:createOverlay()});
    return companies.get(id);
  };
  const apply = (state,event,baseRuns) => {
    if (event.status === 'running') return overlayStart(state,event.accountKey,event.runId);
    // F_pre contains only runs actually included in this published base. An
    // unknown terminal must not release another running member's pressure.
    if (state[event.accountKey]?.post.has(event.runId) || baseRuns[event.runId] === event.accountKey)
      return overlayFinish(state,event.accountKey,event.runId);
    return state;
  };
  return {
    observe(companyId,{runId,status,accountKey=null}) {
      if (typeof runId !== 'string' || !runId || runId === 'unknown') return;
      const s=company(companyId), prior=s.runs.get(runId);
      if (prior && (prior.status !== 'running' || status === 'running')) return;
      const key=prior?.accountKey ?? accountKey;
      s.runs.set(runId,{status,accountKey:key});
      if (!key) return; // Native lifecycle events may lack run-account metadata.
      const event={runId,status,accountKey:key,sequence:++s.sequence};
      s.journal.push(event);
      s.overlay=apply(s.overlay,event,s.baseRuns);
    },
    capture(companyId) { return company(companyId).sequence; },
    publish(companyId,version,checkpoint,baseRuns={},unattributedRunIds=[]) {
      const s=company(companyId), census=new Set(unattributedRunIds);
      for (const id of s.seeded) {
        if (!census.has(id) && s.runs.get(id)?.status === 'running') s.runs.delete(id);
      }
      s.seeded.clear();
      for (const id of census) {
        if (!s.runs.has(id)) {s.runs.set(id,{status:'running',accountKey:null});s.seeded.add(id);}
        else if (s.runs.get(id)?.status === 'running' && !s.runs.get(id)?.accountKey) s.seeded.add(id);
      }
      s.journal=s.journal.filter(e=>e.sequence>checkpoint);
      s.baseRuns=baseRuns;
      s.overlay=s.journal.reduce((overlay,event)=>apply(overlay,event,baseRuns),resetOverlay());
      s.version=version;
      // Keep cross-tick duplicate suppression bounded. Active runs are never
      // evicted by a burst of terminal records.
      if (s.runs.size>25_000) for (const [id,r] of s.runs) {
        if (r.status !== 'running') s.runs.delete(id);
        if (s.runs.size<=25_000) break;
      }
    },
    deltas(companyId,version) {
      const s=companies.get(companyId);
      return !s || s.version!==version ? {} : Object.fromEntries(Object.keys(s.overlay).map(key=>[key,overlayDelta(s.overlay,key)]));
    },
    status(companyId) {
      const s=companies.get(companyId);
      return {unattributedInFlight:s ? [...s.runs.values()].filter(r=>r.status==='running' && !r.accountKey).length : 0};
    },
  };
}
