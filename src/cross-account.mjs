/**
 * Cross-account routing rules (pure; shared by the tick, hook and event-time
 * paths so observation and enforcement agree).
 *
 * Two owner-reported failure modes live here:
 *
 * 1. Cross-account dominance: `dominated` in ladder.mjs is
 *    computed per account, so a model dominated on Codex (old Sol) stays
 *    eligible on Devin. Drop a rung when the same family has a newer or
 *    better arm (higher fleet Q, cost <=) on any qualified account with
 *    headroom.
 *
 * 2. Aggregator fallback-only (owner rule 2026-09-17, still in force):
 *    Devin is an aggregator/duplicate account. For models a native plan
 *    also serves it is fallback-only: used only when no native account
 *    serving that model qualifies. Devin-unique models (swe-*, etc.) keep
 *    band 1.
 *
 * Qualification mirrors select.mjs: healthy + (reactive OR headroom above
 * the reserve). Reactive accounts carry no headroom signal, so a reactive
 * account never counts as "with headroom" for dominance -- only metered
 * accounts with a known headroom fraction do.
 */

import { canonicalModelName } from './arms.mjs';
import { isReactiveAccount } from './cliproxy.mjs';

/** Providers treated as aggregator/duplicate accounts (lowercase). */
export const AGGREGATOR_PROVIDERS = Object.freeze(['devin']);

/** True when the view/account is an aggregator (Devin). */
export function isAggregatorAccount(view) {
  for (const key of ['provider', 'laneProvider']) {
    const provider = String(view?.[key] ?? '').toLowerCase();
    if (provider && AGGREGATOR_PROVIDERS.includes(provider)) return true;
  }
  const id = String(view?.accountId ?? '').toLowerCase();
  return id === 'devin' || id.startsWith('devin:');
}

/** True when the view passes the select.mjs qualification gate. */
export function isQualifiedView(view, reservePct = 0.05) {
  if (view == null || view.health !== 'healthy') return false;
  if (isReactiveAccount(view)) return true;
  return view.headroomPct != null && view.headroomPct > reservePct;
}

/** True when the view is qualified AND carries a metered headroom signal. */
export function hasHeadroom(view, reservePct = 0.05) {
  if (view == null || view.health !== 'healthy') return false;
  if (isReactiveAccount(view)) return false;
  return view.headroomPct != null && view.headroomPct > reservePct;
}

/** Canonical model key for duplicate comparison (null when unmappable). */
export function canonicalKey(model) {
  const canon = canonicalModelName(model);
  return typeof canon === 'string' && canon.length > 0 ? canon.toLowerCase() : null;
}

/** Canonical models a view serves, from its `models` list (raw or canonical ids). */
export function modelsOfView(view) {
  const out = new Set();
  for (const m of view?.models ?? []) {
    const k = canonicalKey(m);
    if (k) out.add(k);
  }
  return out;
}

/**
 * Union of canonical models served by qualified NATIVE (non-aggregator)
 * views. Views without a `models` list contribute nothing (fail open: an
 * unknown model set never marks an aggregator as duplicate).
 */
export function nativeQualifiedModels(views, reservePct = 0.05) {
  const out = new Set();
  for (const v of views ?? []) {
    if (isAggregatorAccount(v)) continue;
    if (!isQualifiedView(v, reservePct)) continue;
    for (const k of modelsOfView(v)) out.add(k);
  }
  return out;
}

/**
 * True when an aggregator view is fallback-only for this run: it serves no
 * model a qualified native does not also serve (every served canonical
 * model is in `nativeModels`). A view with no `models` list is never
 * fallback-only (fail open). Devin-unique models (swe-*, etc.) keep band 1.
 *
 * Callers may pass a precomputed `fallbackOnly` boolean on the view instead;
 * orderAccountsForRun honors an explicit boolean and only computes this
 * when it is absent.
 */
export function isFallbackOnlyView(view, nativeModels) {
  if (!isAggregatorAccount(view)) return false;
  if (typeof view?.fallbackOnly === 'boolean') return view.fallbackOnly;
  const served = modelsOfView(view);
  if (served.size === 0) return false;
  for (const k of served) {
    if (!nativeModels?.has?.(k)) return false;
  }
  return true;
}

/** Numeric version tuple parsed from a model id, e.g. gpt-6.1-sol -> [6, 1]. */
export function versionTuple(model) {
  if (typeof model !== 'string') return null;
  // Dash-separated minors count: gpt-5-4 -> [5, 4] so gpt-5-5 reads newer
  // (the old dot-only pattern read both as [5] and never compared).
  const m = /(\d+(?:[.-]\d+)+|\d+)/.exec(model);
  if (!m) return null;
  const parts = m[1].split(/[.-]/).map(Number);
  if (parts.some(n => !Number.isFinite(n)) || parts.length === 0) return null;
  return parts;
}

/** Compare two version tuples: negative / zero / positive. Nulls never compare. */
export function compareVersions(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Cross-account dominated arms.
 *
 * arms: [{ accountId, armId, family, model, Q, C, breaker? }] where Q/C are
 * fleet-comparable (fleet Q, effective cost). Null Q/C arms never dominate
 * and are never dropped here (the per-account ladder already reports them).
 * qualifiedWithHeadroom: Set of accountIds that are qualified WITH a
 * metered headroom signal AND a known weekly remaining (see hasHeadroom;
 * the tick additionally requires remainingPct != null because the candidate
 * loop skips metered accounts without one). Only those dominate.
 * opts.allowedKeys (optional Set of `accountId\0armId`): when present, only
 * listed arms may dominate. Arms carrying a `breaker` other than 'closed'
 * never dominate (an open/half-open arm cannot route, so it must not drop
 * working arms elsewhere); a missing breaker fails open for older callers.
 *
 * An arm is dominated when the SAME family has another arm on a qualified
 * account with (higher Q and cost <=) OR (a newer version with Q >= and
 * cost <=). The dominator and the dominated arm are never the same
 * (accountId, armId) pair; family comparison is case-insensitive.
 *
 * Returns [{ accountId, armId, dominatedBy, reason }].
 */
export function crossAccountDominated(arms, qualifiedWithHeadroom, opts = {}) {
  const qualified = qualifiedWithHeadroom instanceof Set
    ? qualifiedWithHeadroom
    : new Set(qualifiedWithHeadroom ?? []);
  const allowedKeys = opts?.allowedKeys instanceof Set ? opts.allowedKeys : null;
  const usable = (arms ?? []).filter(a =>
    a != null && a.Q != null && a.C != null && a.family != null && a.armId != null);
  const byFamily = new Map();
  for (const a of usable) {
    const fam = String(a.family).toLowerCase();
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam).push(a);
  }
  const dominatorUsable = (a) => {
    if (!qualified.has(a.accountId)) return false;
    if (a.breaker != null && a.breaker !== 'closed') return false;
    if (allowedKeys && !allowedKeys.has(`${a.accountId}\u0000${a.armId}`)) return false;
    return true;
  };
  const out = [];
  for (const [, group] of byFamily) {
    const dominators = group.filter(dominatorUsable);
    if (dominators.length === 0) continue;
    for (const m of group) {
      const mVer = versionTuple(m.model ?? m.armId);
      let winner = null;
      for (const o of dominators) {
        if (o.accountId === m.accountId && o.armId === m.armId) continue;
        const better = o.Q > m.Q && o.C <= m.C;
        let newer = false;
        if (!better && mVer) {
          const oVer = versionTuple(o.model ?? o.armId);
          if (oVer && compareVersions(oVer, mVer) > 0 && o.Q >= m.Q && o.C <= m.C) newer = true;
        }
        if (better || newer) {
          if (!winner || winner.Q < o.Q || (winner.Q === o.Q && winner.C > o.C)) winner = o;
        }
      }
      if (winner) {
        out.push({
          accountId: m.accountId,
          armId: m.armId,
          dominatedBy: `${winner.accountId}:${winner.armId}`,
          reason: winner.Q > m.Q
            ? `cross-account-dominated: ${winner.armId} on ${winner.accountId} scores higher (Q ${winner.Q} > ${m.Q}, C ${winner.C} <= ${m.C})`
            : `cross-account-dominated: ${winner.armId} on ${winner.accountId} is newer with Q >= and C <=`,
        });
      }
    }
  }
  return out;
}
