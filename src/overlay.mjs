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
