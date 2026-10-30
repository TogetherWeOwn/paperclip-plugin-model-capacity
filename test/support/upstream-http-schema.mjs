import assert from 'node:assert/strict';
import { z } from 'zod';
import { createAiConnectionSchema } from '../fixtures/upstream-schemas/ai-connections.js';
import { aiConnectionPoolConfigSchema } from '../fixtures/upstream-schemas/ai-connection-router.js';
import { updateAgentSchema, wakeAgentSchema, resetAgentSessionSchema } from '../fixtures/upstream-schemas/validators/agent.js';
import { putToolConnectionInstallsSchema, updateToolConnectionSchema } from '../fixtures/upstream-schemas/validators/tool-access.js';

// Inline route schemas, verbatim from upstream e2cfdc7e
// server/src/routes/ai-connections.ts:176,184. The pool config itself and
// every other write schema are imported from the upstream validator fixtures.
const savePoolSchema=z.object({pluginKey:z.string().min(1).max(160),id:z.string().uuid().optional(),expectedRevision:z.number().int().positive().optional(),config:aiConnectionPoolConfigSchema}).strict();
const deletePoolSchema=z.object({expectedRevision:z.number().int().positive()}).strict();

/** Parse the actual serialized request, not an invented pre-serialization type.
 * Unknown mutations fail closed so adding a new actuator requires conformance.
 */
export function parseUpstreamWrite(method,path,body) {
  if(method==='GET') {assert.equal(body,undefined);return;}
  if(method==='POST'&&/\/companies\/[^/]+\/ai-connections$/.test(path))return createAiConnectionSchema.parse(body);
  if(method==='POST'&&/\/companies\/[^/]+\/ai-connection-pools$/.test(path))return savePoolSchema.parse(body);
  if(method==='DELETE'&&/\/companies\/[^/]+\/ai-connection-pools\/[^/]+$/.test(path))return deletePoolSchema.parse(body);
  if(method==='PUT'&&/\/tool-connections\/[^/]+\/installs$/.test(path))return putToolConnectionInstallsSchema.parse(body);
  if(method==='PATCH'&&/\/tool-connections\/[^/]+$/.test(path))return updateToolConnectionSchema.parse(body);
  if(method==='DELETE'&&/\/tool-connections\/[^/]+$/.test(path)) {assert.equal(body,undefined);return;}
  if(method==='PATCH'&&/\/agents\/[^/]+$/.test(path))return updateAgentSchema.parse(body);
  if(method==='POST'&&/\/agents\/[^/]+\/wakeup$/.test(path))return wakeAgentSchema.parse(body);
  if(method==='POST'&&/\/agents\/[^/]+\/runtime-state\/reset-session$/.test(path))return resetAgentSessionSchema.parse(body);
  assert.fail(`unverified mutation route: ${method} ${path}`);
}
