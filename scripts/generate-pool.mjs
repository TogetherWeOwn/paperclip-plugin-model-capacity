/** Operator entry point. Default dry-run is read-only, including the filesystem.
 * Native contract and schema provenance live beside the client and in tests.
 */
import { pathToFileURL } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { normalizeRegistry } from '../src/registry.mjs';
import { computePoolQualityVerdicts } from '../src/pool-quality.mjs';
import { createPaperclipApi } from './paperclip-api.mjs';
import { planPoolSaga, applyPoolSaga, checkPoolDrift, rollbackPoolSaga } from './pool-saga.mjs';
import { readJournal } from './pool-journal.mjs';
export { buildPoolPlan, buildPoolPlanFromPolicy } from './pool-plan.mjs';
export { createPaperclipApi, planPoolSaga, applyPoolSaga, checkPoolDrift, rollbackPoolSaga };

const usage=`Usage: node scripts/generate-pool.mjs [--dry-run | --apply | --check | --rollback JOURNAL]
  --target URL                         Paperclip HTTPS or loopback target
  --registry FILE --batch FILE          registry and {pools, sessionPlans, allAgentsApproved}
  --gateway-base-url URL                gateway HTTPS or loopback base URL
  --quality-evidence FILE               {arms, roles, records}; policy computed locally
  --secret-refs FILE                    {accountKey: {env: "LANE_ENV_NAME"}} (apply)
  --journal FILE                        new write-ahead journal (required for apply)
  --mapping-journal FILE                optional prior mapping cache, always reverified
  --keep-disabled                      stage only; no binding/reset/wake (check expects disabled)
  --all-agents                         requires allAgentsApproved:true in the batch
Board auth: PAPERCLIP_BOARD_TOKEN environment variable. Never put keys in argv or JSON.
Exit codes: 0 plan/success, 2 drift, 1 refusal/failure. Dry-run never writes files or APIs.
Routing models are immutable upstream: update via disabled-pool replacement, never config PATCH.
`;
function argsFor(argv) {
  const values=new Set(['--target','--registry','--batch','--gateway-base-url','--quality-evidence','--secret-refs','--journal','--mapping-journal']);
  const flags=new Set(['--keep-disabled','--all-agents']);
  const out={mode:'--dry-run'},seen=new Set();let mode;
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];if(seen.has(arg))throw new Error('duplicate generator argument');seen.add(arg);
    if(['--dry-run','--apply','--check','--rollback'].includes(arg)) {if(mode)throw new Error('choose one generator mode');out.mode=mode=arg;if(arg==='--rollback'){out.rollback=argv[++i];if(!out.rollback || out.rollback.startsWith('--'))throw new Error('rollback journal required');}}
    else if(values.has(arg)){const value=argv[++i];if(!value||value.startsWith('--'))throw new Error('missing generator argument');out[arg.slice(2)]=value;}
    else if(flags.has(arg))out[arg.slice(2)]=true;
    else if(arg==='--help')out.help=true;
    else throw new Error('unknown generator argument');
  }
  return out;
}
async function jsonFile(path) {
  if(!path)throw new Error('required input file missing');
  if((await stat(path)).size>8*1024*1024)throw new Error('input file too large');
  return JSON.parse(await readFile(path,'utf8'));
}
export async function runGenerator(argv,{env=process.env,stdout=process.stdout,stderr=process.stderr,fetchImpl=globalThis.fetch}={}) {
  try {
    const args=argsFor(argv);if(args.help){stdout.write(usage);return 0;}
    if(!args.target)throw new Error('target required');
    if(args.mode==='--apply'&&!args.journal)throw new Error('apply journal required');
    const refs=args['secret-refs']?await jsonFile(args['secret-refs']):{};
    let raw,batch,evidence,companyId;
    if(args.mode==='--rollback')companyId=(await readJournal(args.rollback)).header.companyId;
    else {
      raw=await jsonFile(args.registry);companyId=normalizeRegistry(raw).companyId;
      batch=await jsonFile(args.batch);evidence=await jsonFile(args['quality-evidence']);
      if(!batch || typeof batch!=='object' || Array.isArray(batch) || Object.keys(batch).some(k=>!['pools','sessionPlans','allAgentsApproved'].includes(k)))throw new Error('invalid batch file');
    }
    const api=createPaperclipApi({target:args.target,companyId,token:env.PAPERCLIP_BOARD_TOKEN,secretRefs:refs,env,fetchImpl});
    if(args.mode==='--rollback') {stdout.write(JSON.stringify(await rollbackPoolSaga({api,journalPath:args.rollback}),null,2)+'\n');return 0;}
    const qualityVerdicts=computePoolQualityVerdicts(raw,{...evidence,nowMs:Date.now(),roleOf:r=>r.role,familyOf:r=>r.family});
    const options={api,registry:raw,batch:batch.pools,sessionPlans:batch.sessionPlans??{},baseUrl:args['gateway-base-url'],qualityVerdicts,allAgents:args['all-agents']??false,allAgentsApproved:batch.allAgentsApproved??false,activate:!args['keep-disabled']};
    let cache;
    if(args['mapping-journal']) {
      const prior=await readJournal(args['mapping-journal']);
      if(prior.header.companyId!==companyId||prior.header.target!==api.target)throw new Error('mapping cache target mismatch');
      cache={verified:[],stale:[]};
      const mapping=prior.lines.filter(e=>e.type==='mapping').at(-1)?.accounts??[];
      const live=await api.listConnections(companyId);
      for(const m of mapping) {
        const c=await api.getConnection(m.connectionId);
        // A cache miss is not an authority to write a dangling ID. The saga
        // always re-discovers by configured name and authoritative summary.
        (c && c.companyId===companyId && c.status!=='archived' && live.connections.some(r=>r.id===m.connectionId&&r.grantId===m.grantId)?cache.verified:cache.stale).push(m.accountKey);
      }
    }
    let result;
    if(args.mode==='--apply')result=await applyPoolSaga({...options,journalPath:args.journal});
    else if(args.mode==='--check')result=await checkPoolDrift({...options,expectedEnabled:!args['keep-disabled']});
    else result=await planPoolSaga(options);
    stdout.write(JSON.stringify({...result,...(cache?{mappingCache:cache}:{})},null,2)+'\n');
    return args.mode==='--check'&&!result.ok?2:0;
  } catch(error) {
    // Do not echo JSON parse snippets, API error bodies, fetch URLs, auth env,
    // lane keys or arbitrary provider messages, even on partial saga failure.
    stderr.write(JSON.stringify({error:'generator refused or failed; credentials and API responses suppressed',...(error.journalPath?{journalPath:error.journalPath,orphans:error.orphans??[],pendingIntents:error.pendingIntents??[]}:{})})+'\n');
    return 1;
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await runGenerator(process.argv.slice(2));
