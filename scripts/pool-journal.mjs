/** Write-ahead, fsynced saga journal. Only value-free routing, IDs and bindings.
 * Creations use an unguessable run name so a lost HTTP response is discoverable;
 * no recovery ever adopts an arbitrary object by its ordinary display name.
 */
import { open, readFile, truncate } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { equal, poolConfig, connectionShape, orderedInstalls } from './generator-safety.mjs';
import { PLUGIN_KEY } from '../src/registry.mjs';
const kinds=new Set(['connection-create','connection-patch','installs','pool-create','pool-save','binding','reset','wake']);
const uuid=x=>typeof x==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
export const temporaryName=(runId,label)=>`mc-${runId}-${label}`;
async function append(handle,entry) { await handle.writeFile(`${JSON.stringify(entry)}\n`);await handle.sync(); }
export async function newJournal(path,{companyId,ownerUserId,target=null,batchAgentIds=[]}) {
  const handle=await open(path,'wx',0o600),runId=randomUUID(),entries=[];
  const header={type:'header',version:2,pluginKey:PLUGIN_KEY,companyId,ownerUserId,runId,target,batchAgentIds};
  await append(handle,header);
  return {header,entries,async record(entry){await append(handle,entry);entries.push(entry);},async step(api,operation){
    const op={type:'intent',seq:entries.filter(e=>e.type==='intent').length+1,...operation};
    await this.record(op);const result=await perform(api,op);
    const receipt={type:'done',seq:op.seq,...result};await this.record(receipt);return receipt;
  },async close(){await handle.close();}};
}
export async function perform(api,op) {
  switch(op.kind) {
    case 'connection-create': {
      const r=await api.createConnection(op.after,op.accountKey);
      const grants=await api.getGrants(r.connectionId);
      const secretRefs=grants.grants.flatMap(g=>(g.credentialSecretRefs??[]).map(ref=>ref.secretId));
      return {id:r.connectionId,grantId:r.grantId,secretRefs};
    }
    case 'connection-patch': await api.updateConnection(op.id,op.after);return {id:op.id};
    case 'installs': await api.putInstalls(op.id,op.after);return {id:op.id};
    case 'pool-create': case 'pool-save': { const p=await api.savePool({companyId:op.companyId,...(op.kind==='pool-save'?{id:op.id,expectedRevision:op.expectedRevision}:{}),config:op.after});return {id:p.id,revision:p.revision}; }
    case 'binding': await api.bindAgent(op.id,op.after,op.before);return {id:op.id};
    case 'reset': await api.resetSession(op.id,op.taskKey);return {id:op.id};
    case 'wake': await api.wakeAgent(op.id,op.after);return {id:op.id};
    default: throw new Error('invalid journal operation');
  }
}
function validate(lines) {
  const h=lines[0];
  if(h?.type!=='header' || h.version!==2 || h.pluginKey!==PLUGIN_KEY || !uuid(h.companyId) || !uuid(h.ownerUserId) || !uuid(h.runId)) throw new Error('invalid journal header');
  if(h.batchAgentIds!==undefined && (!Array.isArray(h.batchAgentIds)||h.batchAgentIds.some(id=>!uuid(id))))throw new Error('invalid journal batch agents');
  const intents=new Map(),done=new Map();
  const safe=x=>{if(Array.isArray(x)) return x.every(safe);if(x && typeof x==='object') return Object.entries(x).every(([k,v])=>!/(api.?key|password|authorization|token|credential(?!SecretRefs))/i.test(k) && safe(v));return true;};
  for(const e of lines.slice(1)) {
    if(!safe(e)) throw new Error('invalid journal secret field');
    if(e.type==='intent') {
      if(!Number.isSafeInteger(e.seq)||e.seq!==intents.size+1||!kinds.has(e.kind)) throw new Error('invalid journal operation');
      if(e.kind.endsWith('create')) {
        if(e.before!==null || !e.after?.name?.startsWith(`mc-${h.runId}-`)) throw new Error('invalid journal creation');
      } else if(!uuid(e.id)) throw new Error('invalid journal object');
      if(e.kind.startsWith('pool-') && (e.companyId!==h.companyId || typeof e.after?.enabled!=='boolean' || !Array.isArray(e.after.members))) throw new Error('invalid journal pool');
      if(e.kind==='pool-save' && (!Number.isSafeInteger(e.expectedRevision) || e.expectedRevision<1 || !e.before)) throw new Error('invalid journal revision');
      if(e.kind==='connection-patch' && (!e.before || !e.after || Object.keys(e.after).some(k=>!['name','enabled'].includes(k)))) throw new Error('invalid journal patch');
      if(e.kind==='installs' && (!Array.isArray(e.before)||!Array.isArray(e.after))) throw new Error('invalid journal installs');
      if(e.kind==='reset' && (typeof e.taskKey!=='string'||!e.taskKey)) throw new Error('invalid journal reset');
      intents.set(e.seq,e);
    } else if(e.type==='done' || e.type==='recovered') {
      if(!intents.has(e.seq)||done.has(e.seq)||!uuid(e.id)) throw new Error('invalid journal receipt');
      if(intents.get(e.seq).kind.startsWith('pool-') && (!Number.isSafeInteger(e.revision)||e.revision<1)) throw new Error('invalid journal revision');
      if(e.secretRefs!==undefined && (!Array.isArray(e.secretRefs)||e.secretRefs.some(x=>!uuid(x))))throw new Error('invalid journal secret refs');
      done.set(e.seq,e);
    } else if(!['complete','mapping','failed','undo-intent','undone','rolled-back','secret-refs'].includes(e.type)) throw new Error('invalid journal entry');
    if(e.type==='secret-refs' && (!Array.isArray(e.ids)||e.ids.some(x=>!uuid(x))))throw new Error('invalid journal secret refs');
    if(['undo-intent','undone'].includes(e.type) && !intents.has(e.seq)) throw new Error('invalid journal undo');
  }
  return {header:h,intents,done};
}
export async function readJournal(path) {
  // A torn LAST append can only be the receipt for an already-fsynced intent.
  // Ignore it and recover the intent from the live host; never ignore an
  // invalid complete line or anything in the middle of the journal.
  const text=await readFile(path,'utf8'),parts=text.split('\n');
  let torn=false;
  if(parts.at(-1)!=='') {parts.pop();torn=true;} else parts.pop();
  const lines=parts.map(line=>JSON.parse(line));
  return {...validate(lines),lines,torn,text:parts.join('\n')+'\n'};
}
async function creation(api,op,header) {
  if(op.kind==='pool-create') {
    const found=(await api.listPools(header.companyId)).filter(p=>p.name===op.after.name);
    if(found.length>1) throw new Error('ambiguous crash-window pool');
    const p=found[0];if(!p)return null;
    if(p.pluginKey!==PLUGIN_KEY || !equal(poolConfig(p),op.after)) throw new Error('crash-window pool changed');
    return {id:p.id,revision:p.revision};
  }
  const list=await api.listConnections(header.companyId);
  const found=[...new Set(list.connections.filter(c=>c.name===op.after.name).map(c=>c.id))];
  if(found.length>1) throw new Error('ambiguous crash-window connection');
  if(!found.length)return null;
  const c=await api.getConnection(found[0]),rows=list.connections.filter(r=>r.id===c.id);
  if(c.companyId!==header.companyId || c.createdByUserId!==header.ownerUserId || rows.length!==1 || !equal(c.routing,op.after.routing) || c.provider!==op.after.provider) throw new Error('crash-window connection changed');
  const secretRefs=(await api.getGrants(c.id)).grants.flatMap(g=>(g.credentialSecretRefs??[]).map(ref=>ref.secretId));
  return {id:c.id,grantId:rows[0].grantId,secretRefs};
}
async function current(api,op,id,header) {
  if(op.kind==='connection-create') {
    const c=await api.getConnection(id);if(!c || c.status==='archived')return null;
    if(c.companyId!==header.companyId || c.createdByUserId!==header.ownerUserId || c.provider!==op.after.provider || !equal(c.routing,op.after.routing)) throw new Error('created connection changed');
    return {name:c.name,enabled:c.enabled};
  }
  if(op.kind==='connection-patch') {const c=await api.getConnection(id);if(!c || c.companyId!==header.companyId)throw new Error('connection missing or foreign');return connectionShape(c);}
  if(op.kind==='installs') return orderedInstalls(await api.getInstalls(id));
  if(op.kind.startsWith('pool-')) {const p=(await api.listPools(header.companyId)).find(p=>p.id===id);if(!p)return null;if(p.pluginKey!==PLUGIN_KEY)throw new Error('pool ownership changed');return poolConfig(p);}
  if(op.kind==='binding') {const a=await api.getAgent(id);if(!a || a.companyId!==header.companyId)throw new Error('agent missing or foreign');return a.runtimeConfig?.aiConnection??null;}
  return null;
}
function expectedAfter(op) {return op.kind==='connection-create'?{name:op.after.name,enabled:true}:op.kind==='installs'?orderedInstalls(op.after):op.after;}
function keyFor(op,id) {return `${op.kind==='binding'?'agent':op.kind==='installs'?'installs':op.kind.startsWith('pool-')?'pool':'connection'}:${id}`;}

export async function rollbackJournal({api,journalPath,target=null}) {
  const j=await readJournal(journalPath);
  if(j.header.target!==target) throw new Error('journal target mismatch');
  const actor=await api.listConnections(j.header.companyId);
  if(actor.currentUserId!==j.header.ownerUserId || actor.canManageConnections!==true)throw new Error('rollback board identity must match journal owner');
  const recordedRefs=[...new Set([...j.done.values()].flatMap(e=>e.secretRefs??[]).concat(j.lines.filter(e=>e.type==='secret-refs').flatMap(e=>e.ids)))];
  if(j.lines.some(e=>e.type==='rolled-back')) return {ok:true,alreadyRolledBack:true,secretRefs:recordedRefs};
  const recovered=[];
  for(const op of j.intents.values()) if(!j.done.has(op.seq)) {
    let receipt;
    if(op.kind.endsWith('create')) receipt=await creation(api,op,j.header);
    else if(op.kind==='reset') { if(!(await api.listSessions(op.id)).some(s=>s.taskKey===op.taskKey)) receipt={id:op.id}; }
    else if(op.kind==='wake') receipt={id:op.id}; // Native idempotency key handles rewake below.
    else {const value=await current(api,op,op.id,j.header);if(equal(value,expectedAfter(op))) {
      receipt={id:op.id};if(op.kind==='pool-save')receipt.revision=(await api.listPools(j.header.companyId)).find(p=>p.id===op.id).revision;
    } else if(!equal(value,op.before)) throw new Error('pending write conflicts with live state');}
    if(receipt) {const e={type:'recovered',seq:op.seq,...receipt};j.done.set(op.seq,e);recovered.push(e);}
  }
  const undone=new Set(j.lines.filter(e=>e.type==='undone').map(e=>e.seq));
  const expectedVersions=new Map();
  for(const op of j.intents.values())if(op.kind.startsWith('pool-')&&j.done.has(op.seq))expectedVersions.set(j.done.get(op.seq).id,j.done.get(op.seq).revision);
  for(const e of j.lines)if(e.type==='undone'&&Object.hasOwn(e,'revision'))expectedVersions.set(j.done.get(e.seq).id,e.revision);
  // A completed activation must be disabled NATIVELY before teardown. That
  // save necessarily increments the revision: recognize exactly one disable,
  // with every other config field unchanged, as the inverse of our final
  // activation. Arbitrary revisions/config edits still fail closed.
  if(j.lines.some(e=>e.type==='complete')) {
    const latest=new Map();
    for(const op of j.intents.values())if(op.kind.startsWith('pool-') && j.done.has(op.seq))latest.set(j.done.get(op.seq).id,op);
    const pools=await api.listPools(j.header.companyId);
    for(const [id,op] of latest) {
      const p=pools.find(p=>p.id===id),receipt=j.done.get(op.seq);
      if(op.kind==='pool-save' && op.before.enabled===false && op.after.enabled===true && p?.enabled===false && equal(poolConfig(p),op.before) && p.revision===receipt.revision+1) {
        undone.add(op.seq);expectedVersions.set(id,p.revision);
      }
    }
  }
  const inverses=j.lines.filter(e=>e.type==='undo-intent' && !undone.has(e.seq));
  for(const inverse of inverses) {
    const op=j.intents.get(inverse.seq),receipt=j.done.get(inverse.seq);
    const value=await current(api,op,receipt.id,j.header);
    if(equal(value,inverse.after)) {
      if(op.kind.startsWith('pool-')) {
        const p=(await api.listPools(j.header.companyId)).find(p=>p.id===receipt.id);
        const expected=op.kind==='pool-create'?null:inverse.expectedRevision+1;
        if((p?.revision??null)!==expected)throw new Error('pending compensation revision conflict');
        expectedVersions.set(receipt.id,expected);
      }
      undone.add(op.seq);
    } else {
      if(!equal(value,inverse.before))throw new Error('pending compensation conflicts with live state');
      if(op.kind.startsWith('pool-')) {
        const p=(await api.listPools(j.header.companyId)).find(p=>p.id===receipt.id);
        if(p?.revision!==inverse.expectedRevision)throw new Error('pending compensation revision conflict');
      }
    }
  }
  const steps=[...j.intents.values()].filter(o=>j.done.has(o.seq)&&!undone.has(o.seq)&&!['reset','wake'].includes(o.kind)).reverse();
  // Check creations independently: later promotion operations share the same
  // state key, but their narrow name/enabled projection cannot prove ownership.
  const createdConnections=steps.filter(o=>o.kind==='connection-create');
  const createdIds=new Set(createdConnections.map(o=>j.done.get(o.seq).id));
  const managedPoolIds=new Set([...j.intents.values()].filter(o=>o.kind.startsWith('pool-')&&j.done.has(o.seq)).map(o=>j.done.get(o.seq).id));
  for(const op of createdConnections) {
    const id=j.done.get(op.seq).id;
    await current(api,op,id,j.header);
    if(!equal(orderedInstalls(await api.getInstalls(id)),orderedInstalls(op.after.allAgents?[{targetType:'company',targetId:j.header.companyId}]:op.after.agentIds.map(targetId=>({targetType:'agent',targetId})))))throw new Error('created connection installs changed');
  }
  for(const p of await api.listPools(j.header.companyId))if(!managedPoolIds.has(p.id) && p.members?.some(m=>createdIds.has(m.binding?.connectionId)))throw new Error('external pool now references a created connection');
  // Validate every inverse against a simulated reverse state before ANY writes.
  const simulated=new Map(),versions=new Map();
  for(const op of steps) {
    const receipt=j.done.get(op.seq),id=receipt.id,key=keyFor(op,id);
    if(!simulated.has(key)) {
      simulated.set(key,await current(api,op,id,j.header));
      if(op.kind.startsWith('pool-')) {
        const live=(await api.listPools(j.header.companyId)).find(p=>p.id===id);
        if(live && live.revision!==expectedVersions.get(id))throw new Error('pool revision changed since saga');
        versions.set(id,live?.revision);
        if(j.lines.some(e=>e.type==='complete') && live?.enabled) throw new Error('cannot rollback completed active journal; drain and disable pools first');
      }
    }
    if(!equal(simulated.get(key),expectedAfter(op))) throw new Error('rollback conflicts with live state');
    simulated.set(key,op.before);
  }
  const batchIds=new Set([...(j.header.batchAgentIds??[]),...[...j.intents.values()].filter(o=>['binding','reset'].includes(o.kind)).map(o=>o.id)]);
  for(const op of j.intents.values()) {
    if(op.kind==='connection-create')for(const id of op.after.agentIds)batchIds.add(id);
    if(op.kind==='installs')for(const i of op.after)if(i.targetType==='agent')batchIds.add(i.targetId);
  }
  for(const id of batchIds)if((await api.listSessions(id)).length)throw new Error('rollback requires session-free agents');
  const secretRefs=[...new Set(recordedRefs.concat([...j.done.values()].flatMap(e=>e.secretRefs??[])))];
  // Drop only the torn suffix, preserving every previously fsynced byte.
  if(j.torn)await truncate(journalPath,Buffer.byteLength(j.text));
  const handle=await open(journalPath,'a',0o600);
  try {
    for(const e of recovered)await append(handle,e);
    await append(handle,{type:'secret-refs',ids:secretRefs});
    for(const seq of undone) if(!j.lines.some(e=>e.type==='undone'&&e.seq===seq)) {
      const op=j.intents.get(seq),id=j.done.get(seq).id;
      await append(handle,{type:'undone',seq,...(op.kind.startsWith('pool-')?{revision:expectedVersions.get(id)}:{})});
    }
    for(const op of steps) {
      const receipt=j.done.get(op.seq),id=receipt.id;
      const before=await current(api,op,id,j.header);
      if(!equal(before,expectedAfter(op)))throw new Error('rollback conflicts with live state');
      await append(handle,{type:'undo-intent',seq:op.seq,before,after:op.before,...(op.kind.startsWith('pool-')?{expectedRevision:versions.get(id)}:{})});
      if(op.kind==='pool-create') {await api.deletePool(id,versions.get(id));versions.delete(id);}
      else if(op.kind==='connection-create')await api.deleteConnection(id);
      else if(op.kind==='pool-save') {const p=await api.savePool({companyId:j.header.companyId,id,expectedRevision:versions.get(id),config:op.before});versions.set(id,p.revision);}
      else if(op.kind==='connection-patch')await api.updateConnection(id,op.before);
      else if(op.kind==='installs')await api.putInstalls(id,op.before);
      else if(op.kind==='binding')await api.bindAgent(id,op.before,op.after);
      await append(handle,{type:'undone',seq:op.seq,...(op.kind.startsWith('pool-')?{revision:versions.get(id)??null}:{})});
    }
    // Resets have no inverse: restore bindings first, then native rewake with
    // the SAME idempotency key as the forward saga (including crash recovery).
    for(const op of j.intents.values()) if(op.kind==='reset' && j.done.has(op.seq)) await api.wakeAgent(op.id,op.wake);
    await append(handle,{type:'rolled-back'});
    return {ok:true,secretRefs:[...new Set(secretRefs)],secretRefAction:'delete via native secrets API after checking consumers'};
  } finally {await handle.close();}
}
