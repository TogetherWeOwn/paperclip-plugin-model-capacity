/** Account-scoped structural version comparisons. No routing or I/O lives here. */
import { canonicalModelName, armsForAccount, taskArmId, taskSlugBases, EFFORT_ORDER } from './arms.mjs';
import { compareVersions } from './cross-account.mjs';

export const CHANNEL_PRECEDENCE = Object.freeze(['contributor', 'free']);
export const SUPERSEDED_VERSION_REASON = 'superseded-version';
export const compareParsedVersions = compareVersions;

function canonical(value) {
  const name = canonicalModelName(value);
  return name?.slice(name.lastIndexOf('/') + 1).toLowerCase() || null;
}

export function parseModelLine(input) {
  const obj = input && typeof input === 'object' ? input : null;
  const raw = obj?.model ?? obj?.armId ?? (typeof input === 'string' ? input : null);
  if (typeof raw !== 'string') return null;
  let name = raw;
  if ((!obj?.model) && name.includes('@')) name = name.slice(0, name.lastIndexOf('@'));
  name = canonical(name);
  if (!name) return null;
  const channels = new Set(), effortsPeeled = [];
  const efforts = new Set([...EFFORT_ORDER.filter(e => e !== 'ultra'), ...(typeof obj?.effort === 'string' ? [obj.effort.toLowerCase()] : [])]);
  for (;;) {
    let suffix, kind, value;
    if (name.endsWith(':free')) [suffix, kind, value] = [':free', 'channel', 'free'];
    else if (name.endsWith('-contributor')) [suffix, kind, value] = ['-contributor', 'channel', 'contributor'];
    else if (name.endsWith('-free')) [suffix, kind, value] = ['-free', 'channel', 'free'];
    else {
      const last = name.slice(name.lastIndexOf('-') + 1);
      if (name.includes('-') && efforts.has(last)) [suffix, kind, value] = [`-${last}`, 'effort', last];
    }
    if (!suffix) break;
    const rest = name.slice(0, -suffix.length);
    if (!rest || /[-:]$/.test(rest)) break;
    name = rest;
    if (kind === 'channel') channels.add(value); else effortsPeeled.push(value);
  }
  const product = [], versions = [];
  let build = null, inVersionRun = false;
  for (const token of name.split('-')) {
    if (!token) return null;
    if (/^\d+(?:\.\d+)?[bkm]$/.test(token) || /^a\d+b$/.test(token)) {
      product.push(token); inVersionRun = false; continue;
    }
    if (/^\d{8}$/.test(token) || (versions.length && /^\d{3,}$/.test(token))) {
      build ??= Number(token); inVersionRun = false; continue;
    }
    const numeric = /^v?(\d+(?:\.\d+)*)$/.exec(token);
    if (numeric) {
      if (!versions.length) { versions.push(...numeric[1].split('.').map(Number)); inVersionRun = true; }
      else if (inVersionRun && /^\d{1,2}$/.test(token)) versions.push(Number(token));
      else { product.push(token); inVersionRun = false; }
      continue;
    }
    const glued = /^([a-z][a-z0-9]*?)v?(\d+(?:\.\d+)*)$/.exec(token);
    if (glued && !versions.length) {
      product.push(glued[1]); versions.push(...glued[2].split('.').map(Number)); inVersionRun = true;
    } else { product.push(token); inVersionRun = false; }
  }
  if (!product.length) return null;
  const orderedChannels = CHANNEL_PRECEDENCE.filter(c => channels.has(c));
  return { product: product.join('-'), version: versions.length ? versions : null, build,
    channels: orderedChannels, channel: orderedChannels[0] ?? null, effortsPeeled };
}

function validPin(pin) {
  return pin && typeof pin.product === 'string' && pin.product.length > 0 && Array.isArray(pin.version)
    && pin.version.length > 0 && pin.version.every(n => Number.isSafeInteger(n) && n >= 0);
}
function pinFor(pins, key) {
  if (!key) return null;
  const pin = pins[key] ?? pins[`arm:${key}`];
  return validPin(pin) ? pin : null;
}
function options(cfg) {
  const o = cfg?.overrides ?? {};
  return { keep: Array.isArray(o.keep) ? o.keep.filter(x => typeof x === 'string') : [],
    productAliases: o.productAliases && typeof o.productAliases === 'object' ? o.productAliases : {},
    parsePins: o.parsePins && typeof o.parsePins === 'object' ? o.parsePins : {} };
}
function modelKept(keep, model, product) {
  return keep.includes(model) || keep.includes(`model:${model}`) || keep.includes(`product:${product}`);
}

export function buildAccountSupersession(account, allResolvedArms, cfg = {}) {
  const opts = options(cfg);
  const explicit = Array.isArray(account?.models);
  const source = explicit ? account.models : armsForAccount(allResolvedArms, account).map(a => a.model);
  const models = [...new Set(source.map(canonical).filter(Boolean))].sort();
  const identities = {}, byProduct = {};
  for (const model of models) {
    const parsed = parseModelLine(model);
    const pin = opts.parsePins[`model:${model}`] ?? opts.parsePins[model];
    const aliased = parsed && (typeof opts.productAliases[parsed.product] === 'string' ? opts.productAliases[parsed.product] : parsed.product);
    const identity = { product: validPin(pin) ? pin.product : aliased ?? null,
      version: validPin(pin) ? [...pin.version] : parsed?.version ?? null,
      build: parsed?.build ?? null, channels: parsed?.channels ?? [], parseOk: parsed != null || validPin(pin) };
    Object.defineProperty(identities, model, { value: identity, enumerable: true, configurable: true, writable: true });
    if (!identity.product || !identity.version) continue;
    const group = Object.hasOwn(byProduct, identity.product) ? byProduct[identity.product] : null;
    const cmp = group ? compareVersions(identity.version, group.maxVersion) : 1;
    if (cmp > 0) Object.defineProperty(byProduct, identity.product, { value: { maxVersion: [...identity.version], membersAtMax: [model] }, enumerable: true, configurable: true, writable: true });
    else if (cmp === 0) group.membersAtMax.push(model);
  }
  const verdicts = [], supersededCanonicalModels = [];
  for (const model of models) {
    const i = identities[model], group = byProduct[i.product];
    if (!i.version || !group || compareVersions(i.version, group.maxVersion) >= 0) continue;
    const kept = modelKept(opts.keep, model, i.product);
    verdicts.push({ canonicalModel: model, product: i.product, version: i.version, kept,
      supersededBy: { version: group.maxVersion, canonicalModels: group.membersAtMax }, reason: SUPERSEDED_VERSION_REASON });
    if (!kept) supersededCanonicalModels.push(model);
  }
  // Model pins are baked above. Retain pins for the arm-only helper path.
  return { universeSource: explicit ? 'account-models' : 'inferred-provider-arms', identities, byProduct,
    supersededCanonicalModels, supersededLegacyArmIds: [], supersededTaskArmIds: [], verdicts,
    overrides: { keep: opts.keep.slice(), armParsePins: { ...opts.parsePins } }, rejectedCandidates: [] };
}

export function isSupersededModel(view, modelString) {
  if (!view) return false;
  const model = canonical(modelString), i = view.identities?.[model], group = view.byProduct?.[i?.product];
  return !!(i?.version && group && compareVersions(i.version, group.maxVersion) < 0
    && !modelKept(view.overrides?.keep ?? [], model, i.product));
}

export function isSupersededArm(view, armLike) {
  if (!view || !armLike) return false;
  const arm = typeof armLike === 'string' ? { armId: armLike } : armLike;
  const model = canonical(arm.model), id = typeof arm.armId === 'string' ? arm.armId : null;
  const taskIds = [id?.includes('@') ? id : null, model && arm.effort != null ? taskArmId(model, arm.effort) : null].filter(Boolean);
  const legacyIds = [id && !id.includes('@') ? id : null, ...(Array.isArray(arm.legacyArmIds) ? arm.legacyArmIds : []), arm.aaSlug].filter(x => typeof x === 'string');
  const keep = view.overrides?.keep ?? [];
  let rawModel = model ?? (id ? canonical(id.includes('@') ? id.slice(0, id.lastIndexOf('@')) : id) : null);
  // Legacy arm IDs append an effort to the canonical model. Prefer an exact
  // universe identity, otherwise peel that suffix to recover model-level rules.
  if (!model && id && !id.includes('@') && rawModel && !view.identities?.[rawModel]) {
    const efforts = [...EFFORT_ORDER.filter(e => e !== 'ultra'), ...(typeof arm.effort === 'string' ? [arm.effort.toLowerCase()] : [])];
    const suffix = efforts.find(e => rawModel.endsWith(`-${e}`));
    if (suffix && rawModel.length > suffix.length + 1) rawModel = rawModel.slice(0, -suffix.length - 1);
  }
  // Dotted and channel-decorated model names can share an arm slug. Only
  // recover a canonical identity when the account's universe identifies it uniquely.
  if (!model && rawModel && !Object.hasOwn(view.identities ?? {}, rawModel)) {
    const matches = Object.keys(view.identities ?? {}).filter(key => taskSlugBases(key).includes(rawModel));
    if (matches.length === 1) rawModel = matches[0];
  }
  let identity = model ? view.identities?.[model] : null;
  if (!model && id) {
    const pin = [...taskIds, ...legacyIds, rawModel].map(key => pinFor(view.overrides?.armParsePins ?? {}, key)).find(Boolean);
    identity = pin ?? view.identities?.[rawModel] ?? parseModelLine(id);
  }
  if (!identity?.version || !identity.product) return false;
  const group = view.byProduct?.[identity.product];
  if (!group || compareVersions(identity.version, group.maxVersion) >= 0) return false;
  if (modelKept(keep, rawModel, identity.product)) return false;
  return ![...taskIds, ...legacyIds].some(x => keep.includes(x) || keep.includes(`arm:${x}`));
}
