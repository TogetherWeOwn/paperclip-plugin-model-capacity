import { memberIdFor, PLUGIN_KEY } from '../../src/registry.mjs';
import { config } from './quota.mjs';

export function verifiedConfig() {
  const c=config();
  c.router.pools[0]={...c.router.pools[0],poolId:'40000000-0000-4000-8000-000000000001',pluginKey:PLUGIN_KEY,expectedRevision:7,
    expectedMemberOrder:['one','two'].map(a=>memberIdFor('builder',a)),
    members:['one','two'].map((accountKey,i)=>({memberId:memberIdFor('builder',accountKey),accountKey,
      connectionId:`50000000-0000-4000-8000-00000000000${i+1}`,grantId:`60000000-0000-4000-8000-00000000000${i+1}`}))};
  return c;
}
