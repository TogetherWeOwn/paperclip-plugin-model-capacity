// Experimental, injected fake-API saga. This is not an operator interface:
// host selectability, session and installation gates are not implemented yet.
import { open, readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { normalizeRegistry, PLUGIN_KEY } from '../src/registry.mjs';
import { buildPoolPlan } from './generate-pool.mjs';

function connectionPlan(a) {
  return {name:a.connectionName,provider:a.provider,method:'api_key',routing:{models:[...new Set(Object.values(a.pools).map(p=>`${a.prefix}/${p.model}`))].sort()}};
}
function sameModels(a,b) {
  return Array.isArray(a) && Array.isArray(b) && isDeepStrictEqual([...a].sort(),[...b].sort());
}
async function discover(api, raw, {allowWrongPluginKey=false}={}) {
  const registry=normalizeRegistry(raw);
  const connections=await api.listConnections(registry.companyId);
  const pools=await api.listPools(registry.companyId);
  const accounts=[];
  for (const account of registry.accounts) {
    const found=connections.filter(c=>c.name===account.connectionName);
    if(found.length>1) throw new Error(`ambiguous connection: ${account.connectionName}`);
    const connection=found[0];
    let grant;
    if(connection) {
      const grants=(await api.listGrants(connection.id)).filter(g=>g.mode==='shared' && g.provider===account.provider && g.method==='api_key');
      if(grants.length>1) throw new Error(`ambiguous grant: ${account.connectionName}`);
      grant=grants[0];
    }
    accounts.push({account,connection,grant,desired:connectionPlan(account)});
  }
  for(const {poolKey} of registry.pools) {
    const found=pools.filter(p=>p.name===poolKey);
    if(found.length>1) throw new Error(`ambiguous pool: ${poolKey}`);
    if(!allowWrongPluginKey && found.length && found[0].pluginKey!==PLUGIN_KEY) throw new Error(`wrong pluginKey: ${poolKey}`);
  }
  return {registry,accounts,pools};
}
function rowsFor(accounts) {
  return accounts.filter(x=>x.connection && x.grant).map(({account,connection,grant})=>({id:connection.id,grantId:grant.id,name:account.connectionName,provider:account.provider,method:'api_key',ownership:'shared',status:connection.status}));
}
function poolConfig(pool) { return {name:pool.name,enabled:pool.enabled,mode:pool.mode,thresholdPercent:pool.thresholdPercent,members:pool.members}; }
function comparePool(existing, desired) {
  const actual=poolConfig(existing);
  // An enabled, otherwise identical pool is not drift solely due to activation.
  return isDeepStrictEqual({...actual,enabled:false},desired.config);
}
async function append(handle, entry) {
  await handle.writeFile(`${JSON.stringify(entry)}\n`);
  await handle.sync();
}

// Complete SaveInputs require discovered connection and grant IDs; do not
// fabricate IDs in a dry plan when the target objects have not been created.
export async function planPoolSaga({api,registry,qualityVerdicts}) {
  const state=await discover(api,registry);
  if(state.accounts.some(x=>!x.connection || !x.grant)) throw new Error('complete plan requires discovered connections and grants');
  const plan=buildPoolPlan(registry,rowsFor(state.accounts),qualityVerdicts);
  return {connections:state.accounts.map(x=>x.desired),...plan};
}

export async function applyPoolSaga({api,registry,qualityVerdicts,journalPath}) {
  const state=await discover(api,registry);
  // Validate all evidence, discovered connection health and model drift before
  // the first write. A placeholder UUID lets the pure planner validate inputs.
  const placeholder='10000000-0000-4000-8000-000000000000';
  for(const x of state.accounts) {
    if(x.connection && (x.connection.status!=='connected' || x.connection.provider!==x.account.provider || x.connection.method!=='api_key' || !sameModels(x.connection.routing?.models,x.desired.routing.models))) throw new Error(`connection drift or unavailable: ${x.account.connectionName}`);
  }
  buildPoolPlan(registry,state.accounts.map(x=>({id:x.connection?.id??placeholder,grantId:x.grant?.id??placeholder,name:x.account.connectionName,provider:x.account.provider,method:'api_key',ownership:'shared',status:'connected'})),qualityVerdicts);
  // Creating dependencies alongside an existing pool could make rollback unsafe.
  if(state.pools.some(p=>state.registry.pools.some(q=>q.poolKey===p.name)) && state.accounts.some(x=>!x.connection || !x.grant)) throw new Error('existing pool with missing dependency requires manual reconciliation');
  const handle=await open(journalPath,'wx',0o600);
  const orphans=[];
  try {
    await append(handle,{type:'header',version:1,companyId:state.registry.companyId});
    for(const x of state.accounts) if(!x.connection) {
      x.connection=await api.createConnection(x.desired);
      const entry={type:'created',kind:'connection',id:x.connection.id,name:x.account.connectionName};
      orphans.push(entry); await append(handle,entry);
    }
    for(const x of state.accounts) if(!x.grant) {
      x.grant=await api.createGrant({connectionId:x.connection.id,mode:'shared',provider:x.account.provider,method:'api_key'});
      const entry={type:'created',kind:'grant',id:x.grant.id,connectionId:x.connection.id};
      orphans.push(entry); await append(handle,entry);
    }
    const plan=buildPoolPlan(registry,rowsFor(state.accounts),qualityVerdicts);
    for(const pool of plan.pools) {
      const existing=state.pools.find(p=>p.name===pool.config.name);
      if(existing) {
        if(comparePool(existing,pool)) continue;
        if(existing.enabled) throw new Error('refusing to update enabled pool');
        const saved=await api.savePool({...pool,id:existing.id,expectedRevision:existing.revision});
        await append(handle,{type:'updated',id:saved.id,revision:saved.revision,name:pool.config.name});
        continue;
      }
      const saved=await api.savePool(pool);
      const entry={type:'created',kind:'pool',id:saved.id,revision:saved.revision,name:pool.config.name};
      orphans.push(entry); await append(handle,entry);
    }
    await append(handle,{type:'complete'});
    return plan;
  } catch {
    const failure=new Error('pool saga failed; inspect journal and orphan set');
    failure.journalPath=journalPath; failure.orphans=orphans;
    throw failure;
  } finally { await handle.close(); }
}

export async function checkPoolDrift({api,registry,qualityVerdicts,expectedEnabled=false}) {
  if(typeof expectedEnabled!=='boolean') throw new Error('expectedEnabled must be boolean');
  const state=await discover(api,registry,{allowWrongPluginKey:true}); const drift=[];
  for(const {poolKey} of state.registry.pools) {
    const existing=state.pools.find(p=>p.name===poolKey);
    if(!existing) drift.push({type:'missing-pool',poolKey});
    else if(existing.pluginKey!==PLUGIN_KEY) drift.push({type:'plugin-key-drift',poolKey});
  }
  for(const x of state.accounts) {
    if(!x.connection) drift.push({type:'missing-connection',accountKey:x.account.accountKey});
    else if(x.connection.status!=='connected' || x.connection.provider!==x.account.provider || x.connection.method!=='api_key' || !sameModels(x.connection.routing?.models,x.desired.routing.models)) drift.push({type:'connection-drift',accountKey:x.account.accountKey});
    if(x.connection && !x.grant) drift.push({type:'missing-grant',accountKey:x.account.accountKey});
  }
  if(state.accounts.every(x=>x.connection && x.grant)) {
    const desired=buildPoolPlan(registry,rowsFor(state.accounts).map(x=>({...x,status:'connected'})),qualityVerdicts);
    // Empty desired pools cannot be represented by SaveInput, but their live
    // counterparts must not silently pass drift checks.
    for(const {poolKey} of state.registry.pools) {
      if(!desired.pools.some(p=>p.config.name===poolKey) && state.pools.some(p=>p.name===poolKey)) drift.push({type:'pool-drift',poolKey});
    }
    for(const pool of desired.pools) {
      const existing=state.pools.find(p=>p.name===pool.config.name);
      if(!existing) continue;
      const ids=new Set((existing.members??[]).map(m=>m.id));
      for(const member of pool.config.members) if(!ids.has(member.id)) drift.push({type:'missing-member',poolKey:pool.config.name,memberId:member.id});
      if(existing.enabled!==expectedEnabled || !comparePool(existing,pool)) drift.push({type:'pool-drift',poolKey:pool.config.name});
    }
  }
  return {ok:drift.length===0,drift};
}

export async function rollbackPoolSaga({api,journalPath}) {
  const lines=(await readFile(journalPath,'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  if(lines[0]?.type!=='header' || lines[0].version!==1) throw new Error('invalid journal');
  // Until update compensation is implemented, never remove dependencies of an
  // adopted pool or undo a successful run based on a stale journal.
  if(lines.some(e=>e.type==='complete')) throw new Error('cannot rollback completed journal');
  if(lines.some(e=>e.type==='updated')) throw new Error('cannot rollback journal containing updated objects; manual reconciliation required');
  const entries=lines.filter(e=>e.type==='created');
  if(entries.some(e=>!['pool','grant','connection'].includes(e.kind) || typeof e.id!=='string' || (e.kind==='pool' && (!Number.isInteger(e.revision) || e.revision<1)))) throw new Error('invalid journal object');
  for(const entry of entries.reverse()) {
    if(entry.kind==='pool') await api.deletePool(entry.id,entry.revision);
    else if(entry.kind==='grant') await api.deleteGrant(entry.id);
    else if(entry.kind==='connection') await api.deleteConnection(entry.id);
    else throw new Error('invalid journal object');
  }
}
