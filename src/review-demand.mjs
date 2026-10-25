// Plugin-owned read-only census. Native review history begins AFTER admission,
// so it cannot measure the PR heads waiting outside a slot-metered gate.
const URL = 'https://api.github.com/graphql';
const TTL_MS = 5 * 60_000;
const MAX_PAGES = 50;
async function bounded(operation, timeoutMs) {
  if (timeoutMs <= 0) throw new Error('timeout');
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
const QUERY = `query ReviewDemand($owner:String!,$name:String!,$cursor:String) {
  repository(owner:$owner,name:$name) {
    pullRequests(first:100,after:$cursor,states:OPEN) {
      nodes { number isDraft mergeable headRefOid
        commits(last:1) { nodes { commit { oid statusCheckRollup {
          contexts(first:100) { nodes { __typename
            ... on CheckRun { name status conclusion }
            ... on StatusContext { context state }
          } pageInfo { hasNextPage } }
        } } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export const REVIEW_REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;

export function validateReviewDemand(raw) {
  if (raw == null || raw.enabled === false) return [];
  const errors = [];
  if (!Array.isArray(raw.repositories) || raw.repositories.length < 1 || raw.repositories.length > 25
    || raw.repositories.some(r => typeof r !== 'string' || !REVIEW_REPOSITORY_PATTERN.test(r))) {
    errors.push('reviewDemand.repositories must contain 1-25 owner/repository names');
  }
  if (raw.tokenSecretRef?.type !== 'secret_ref' || typeof raw.tokenSecretRef.secretId !== 'string') {
    errors.push('reviewDemand.tokenSecretRef must be a secret_ref object');
  }
  if (raw.requiredChecks != null && (!Array.isArray(raw.requiredChecks) || raw.requiredChecks.length < 1
    || raw.requiredChecks.length > 50 || raw.requiredChecks.some(c => typeof c !== 'string' || !c.trim() || c.length > 200 || c === 'Paperclip Review'))) {
    errors.push('reviewDemand.requiredChecks must contain 1-50 CI check names, not Paperclip Review');
  }
  return errors;
}

export function normalizeReviewDemand(raw) {
  if (raw == null || raw.enabled === false || validateReviewDemand(raw).length) return null;
  return { repositories: [...new Set(raw.repositories.map(r => r.toLowerCase()))].sort(),
    tokenSecretRef: raw.tokenSecretRef, requiredChecks: [...new Set(raw.requiredChecks ?? ['ci-ok', 'pr-lint'])] };
}

export function eligibleReviewHead(pull, requiredChecks) {
  if (!Number.isSafeInteger(pull?.number) || pull.number < 1 || pull.isDraft !== false || pull.mergeable !== 'MERGEABLE'
    || !/^[a-f0-9]{40}$/i.test(pull.headRefOid ?? '')) return false;
  if (!Array.isArray(pull.commits?.nodes) || pull.commits.nodes.length !== 1) return false;
  const commit = pull.commits.nodes[0]?.commit;
  const contexts = commit?.statusCheckRollup?.contexts;
  if (commit?.oid !== pull.headRefOid || contexts?.pageInfo?.hasNextPage !== false
    || !Array.isArray(contexts.nodes) || contexts.nodes.length > 100) return false;
  const named = new Map();
  for (const c of contexts.nodes) {
    const name = c?.__typename === 'CheckRun' ? c.name : c?.__typename === 'StatusContext' ? c.context : null;
    if (typeof name !== 'string') return false;
    if (!named.has(name)) named.set(name, []);
    named.get(name).push(c);
  }
  if ((named.get('Paperclip Review') ?? []).some(review => review.__typename === 'CheckRun'
    ? review.status === 'COMPLETED' && ['SUCCESS', 'FAILURE'].includes(review.conclusion)
    : ['SUCCESS', 'FAILURE', 'ERROR'].includes(review.state))) return false;
  return requiredChecks.every(name => named.has(name) && named.get(name).every(c =>
    c.__typename === 'CheckRun' ? c.status === 'COMPLETED' && c.conclusion === 'SUCCESS' : c.state === 'SUCCESS'));
}

/** Per-company/config single-flight cache; only counts, never credentials or PR data. */
export function createReviewDemandReader({ clock = Date.now } = {}) {
  const cache = new Map();
  const read = async (ctx, companyId, config) => {
    if (!config) {
      cache.delete(companyId);
      return { status: 'disabled', eligibleHeads: 0 };
    }
    const key = JSON.stringify([companyId, config]);
    const prev = cache.get(companyId);
    if (prev?.key === key && clock() >= prev.atMs && clock() - prev.atMs < TTL_MS) return prev.result;
    const atMs = clock();
    const entry = { key, atMs, result: null };
    cache.set(companyId, entry);
    const assertCurrent = () => {
      if (cache.get(companyId) !== entry) throw new Error('configuration-changed');
    };
    const result = (async () => {
      try {
        const deadline = Date.now() + 20_000;
        const token = await bounded(() => ctx.secrets.resolve(config.tokenSecretRef,
          { companyId, configPath: 'reviewDemand.tokenSecretRef' }), 5_000);
        assertCurrent();
        if (typeof token !== 'string' || !token) throw new Error('unavailable');
        const heads = new Set();
        let pages = 0;
        for (const repository of config.repositories) {
          const [owner, name] = repository.split('/');
          let cursor = null;
          const cursors = new Set();
          do {
            assertCurrent();
            if (++pages > MAX_PAGES) throw new Error('page-limit');
            const body = await bounded(async () => {
              const res = await ctx.http.fetch(URL, { method: 'POST', redirect: 'manual',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'paperclip-model-capacity' },
                body: JSON.stringify({ query: QUERY, variables: { owner, name, cursor } }) });
              if (res.status !== 200 || res.redirected === true) throw new Error('unavailable');
              return res.json();
            }, Math.min(10_000, deadline - Date.now()));
            assertCurrent();
            const prs = body?.data?.repository?.pullRequests;
            if (body?.errors?.length || !Array.isArray(prs?.nodes) || prs.nodes.length > 100
              || typeof prs.pageInfo?.hasNextPage !== 'boolean') throw new Error('incomplete');
            for (const pull of prs.nodes) {
              if (eligibleReviewHead(pull, config.requiredChecks)) heads.add(`${repository}#${pull.number}@${pull.headRefOid}`);
            }
            if (!prs.pageInfo.hasNextPage) break;
            cursor = prs.pageInfo.endCursor;
            if (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || cursors.has(cursor)) throw new Error('incomplete');
            cursors.add(cursor);
          } while (true);
        }
        return { status: 'ok', eligibleHeads: heads.size, atMs, source: 'github-current-head-checks' };
      } catch {
        // Failed/partial reads never keep old positive demand or expose upstream text.
        return { status: 'unavailable', eligibleHeads: 0, atMs, source: 'github-current-head-checks' };
      }
    })();
    entry.result = result;
    return result;
  };
  // Configuration events revoke a generation even when no /caps read follows.
  read.invalidate = companyId => cache.delete(companyId);
  return read;
}
