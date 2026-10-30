import { registry, companyId } from './native-api.mjs';
export const NOW=Date.parse('2026-10-30T03:00:00Z'), MINUTE=60_000, HOUR=60*MINUTE;
export const routerConfig = () => ({...structuredClone(registry),enabled:false});
export const config = () => ({router:routerConfig(),cliproxy:{laneKeySecretRef:{type:'secret_ref',secretId:'10000000-0000-4000-8000-000000000099'}}});
export function quotaFeed(now=NOW,{used=.2,missing=[]}={}) {
  return {observedAt:new Date(now).toISOString(),servedModels:['one/terra','one/sol','two/claude'],accounts:registry.accounts.filter(a=>!missing.includes(a.accountKey)).map(a=>({
    accountKey:a.accountKey,provider:a.provider,quality:'live',health:'healthy',models:Object.values(a.pools).map(m=>`${a.prefix}/${m.model}`),observedAt:new Date(now).toISOString(),
    weekly:{used,resetsAt:NOW+84*HOUR},fiveHour:{used:.1,resetsAt:NOW+4*HOUR},
    credentialAvailability:{version:1,models:Object.values(a.pools).map(m=>({model:`${a.prefix}/${m.model}`,provider:a.provider,accountId:`${a.provider}:${a.accountKey}`,servingCredentials:1,readyCredentials:1,observedAt:new Date(now).toISOString(),expiresAt:new Date(now+2*MINUTE).toISOString()}))},
  }))};
}
export function stateHarness() {
  const store=new Map(),writes=[],logs=[];let fail=false;
  return {store,writes,logs,setFail:value=>{fail=value;},
    state:{get:async k=>store.get(JSON.stringify(k))??null,set:async(k,v)=>{if(fail)throw new Error('PRIVATE_STATE_ERROR');writes.push([k,v]);store.set(JSON.stringify(k),structuredClone(v));}},
    logger:Object.fromEntries(['info','warn','error'].map(level=>[level,(message,details)=>logs.push({level,message,details})])),
    keyFor:(id=companyId)=>({scopeKind:'company',scopeId:id,namespace:'model-capacity',stateKey:'router-quota-v1'}),
  };
}
