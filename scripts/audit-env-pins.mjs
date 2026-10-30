#!/usr/bin/env node
/** S1 read-only migration checklist. Native agent work uses MCP; this read is
 * the narrow env-inventory gap: public-mcp/expanded-capabilities.ts deliberately
 * omits env. GET /companies/:companyId/agents (agents.ts:3903) exposes env KEYS
 * to config-reading board callers, but redaction.ts:983 hides plain values.
 * Never resolve secret refs, infer hidden models, update agents or wake runs.
 */
import { pathToFileURL } from 'node:url';
import { createPaperclipApi } from './paperclip-api.mjs';

export const PIN_KEYS = Object.freeze([
  'CLAUDE_CODE_SUBAGENT_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'PAPERCLIP_ASSIGNED_MODEL',
]);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function modelFamily(binding) {
  if (object(binding) && ['secret_ref','user_secret_ref'].includes(binding.type)) return 'secret-ref';
  const value = object(binding) && binding.type === 'plain' ? binding.value : binding;
  if (value === '***REDACTED***') return 'redacted';
  if (typeof value !== 'string') return 'unknown';
  // One optional registry prefix, anchored model grammar; never echo any part
  // of the value. A URL, shell expression or arbitrary secret stays unknown.
  const model = value.replace(/^[a-z0-9._-]+\//i,'');
  for (const [pattern,family] of [
    [/^claude-opus-\d[\w.\-]*(?:\[1m\])?$/i,'claude-opus'],
    [/^claude-sonnet-\d[\w.\-]*(?:\[1m\])?$/i,'claude-sonnet'],
    [/^claude-haiku-\d[\w.\-]*(?:\[1m\])?$/i,'claude-haiku'],
    [/^gpt-\d[\w.\-]*$/i,'gpt'], [/^gemini-\d[\w.\-]*$/i,'gemini'],
    [/^glm-\d[\w.\-]*$/i,'glm'], [/^llama-\d[\w.\-]*$/i,'llama'],
    [/^mistral-[\w.\-]+$/i,'mistral'], [/^deepseek-[\w.\-]+$/i,'deepseek'],
  ]) if (pattern.test(model)) return family;
  return 'unknown';
}
export function auditEnvPins(agents, {companyId}) {
  if (!uuid(companyId) || !Array.isArray(agents)) throw new Error('invalid agent inventory');
  const pinnedAgents = [], ids = new Set();
  for (const agent of agents) {
    if (!object(agent) || !uuid(agent.id) || agent.companyId !== companyId || ids.has(agent.id)) throw new Error('invalid agent inventory');
    ids.add(agent.id);
    const env = agent.adapterConfig?.env;
    const pins = PIN_KEYS.filter(key => object(env) && Object.hasOwn(env,key))
      .map(key => ({key,modelFamily:modelFamily(env[key])}));
    if (pins.length) pinnedAgents.push({agentId:agent.id,pins});
  }
  pinnedAgents.sort((a,b)=>a.agentId.localeCompare(b.agentId));
  return {companyId,agentsScanned:agents.length,pinnedAgents,limitations:[
    'Native agent reads redact plain environment values; redacted and secret-ref families are not inferred or resolved.',
    'Use config-readable board scope. Omitted env on a restricted agent view is not proof of no pins.',
    'Checklist only: migration/session checks, pin removal, child-traffic proof and rollback use Paperclip native mechanisms separately.',
  ]};
}
const usage = `Usage: node scripts/audit-env-pins.mjs --target URL --company-id UUID
Read-only S1 checklist; run against staging first. Auth: PAPERCLIP_BOARD_TOKEN.
Output includes only agent IDs, exact pin keys and allowlisted model families.
No writes, secret resolution, session reset, binding, wakeup or unredacted values.
`;
export async function runAuditEnvPins(argv, {env=process.env,stdout=process.stdout,stderr=process.stderr,fetchImpl=globalThis.fetch}={}) {
  try {
    if (argv.length === 1 && argv[0] === '--help') {stdout.write(usage);return 0;}
    const args = {};
    for (let i=0;i<argv.length;i+=2) {
      const key = argv[i], value = argv[i+1];
      if (!['--target','--company-id'].includes(key) || Object.hasOwn(args,key) || !value || value.startsWith('--')) throw new Error();
      args[key] = value;
    }
    const companyId = args['--company-id'];
    const api = createPaperclipApi({target:args['--target'],companyId,token:env.PAPERCLIP_BOARD_TOKEN,fetchImpl});
    const report = auditEnvPins(await api.listAgents(companyId),{companyId});
    stdout.write(JSON.stringify({target:api.target,...report},null,2)+'\n');
    return 0;
  } catch {
    stderr.write('Environment pin audit refused or failed; inputs, credentials and API responses suppressed.\n');
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runAuditEnvPins(process.argv.slice(2));
