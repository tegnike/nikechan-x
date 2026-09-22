import { xMemoryTransientCode } from "./lib-x-memory-transient.mjs";
import { fetchXMemorySnapshot } from './lib-x-memory-snapshot.mjs';
import { groupXBatches } from './lib-x-memory-batches.mjs';
import { extractXBatch } from './lib-x-memory-extraction.mjs';
import { characterEmbeddingModel, validateMemoryVector } from './lib-character-memory-embedding.mjs';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, SupabaseClient } from './lib-memory-search.mjs';
import { createMemoryEmbedder, runMemoryEmbeddingCycle } from './lib-character-memory-embedding.mjs';
import { runXMemoryCycle } from './lib-x-memory-pipeline.mjs';
const env = { ...await loadEnv(process.env.MEMORY_ENV_FILE || resolve('.env')), ...process.env };
const client = new SupabaseClient({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY });
const allowed = new Set(['memory_reconcile_x_origins_v1','memory_x_source_snapshot_v1','memory_x_source_snapshot_page_v1','memory_stage_x_batch_v1',
 'memory_claim_x_batches_v1','memory_publish_x_batch_v1','memory_fail_x_batch_v1','memory_claim_x_batch_embeddings_v1',
 'memory_publish_x_batch_embedding_v1','memory_fail_x_batch_embedding_v1','memory_claim_embeddings_v1','memory_publish_embedding_v1','memory_fail_embedding_v1']);
let publicationTail=Promise.resolve();
const rpc = async (name, body) => {
 let release;
 if(['memory_publish_x_batch_v1','memory_claim_x_batches_v1'].includes(name)){const previous=publicationTail;publicationTail=new Promise(r=>{release=r;});await previous;}
 try {
 if (!allowed.has(name)) throw Error('invalid_x_rpc');
 for(let attempt=0;;attempt++){
  if(name==='memory_publish_x_batch_v1'&&!alive())throw Error('bulk_deadline_reached');
  try{return await client.rpc(name,body,{timeoutMs:30000});}
  catch(error){
   if(name==='memory_x_source_snapshot_page_v1'||!xMemoryTransientCode(error)||attempt>=4||!alive()||stopped)throw error;
   log('db_retry',{rpc:name,attempt:attempt+1,code:xMemoryTransientCode(error)});
   await sleep(Math.min(30000,1000*2**attempt));
  }
 }
 } finally { release?.(); }
};
const model = async (_stage,instructions,input,schema) => {
 const result = await new Promise((ok,fail) => {
  const child = spawn('python3',[resolve(dirname(fileURLToPath(import.meta.url)),'x-memory-codex-model.py')],
   {env:{...process.env,HERMES_HOME:'/profile/profiles/nikechan-x'},stdio:['pipe','pipe','pipe']});
  let output='';const timer=setTimeout(()=>child.kill('SIGKILL'),210000);
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>1000000)child.kill('SIGKILL');});
  child.stderr.resume(); child.on('error',()=>{clearTimeout(timer);fail(Object.assign(Error('model_process_unavailable'),{code:'model_process_unavailable'}));});
  child.on('close',code=>{clearTimeout(timer);try{if(code!==0)throw Error();ok(JSON.parse(output));}catch{fail(Object.assign(Error('model_execution_failed'),{code:'model_execution_failed'}));}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({instructions,input,schema,model:env.X_MEMORY_MODEL||'gpt-5.5'}));
 });
 if(result.error) throw Object.assign(Error(result.error),{code:result.error});return result;
};
const deadline=Date.parse(process.env.X_BULK_DEADLINE||'2026-09-22T08:48:00Z');
const since='2024-12-01T00:00:00Z';
const until=new Date().toISOString();
const log=(type,extra={})=>console.log(JSON.stringify({at:new Date().toISOString(),type,...extra}));
const sleep=ms=>new Promise(r=>setTimeout(r,Math.min(ms,Math.max(0,deadline-Date.now()))));
const alive=()=>Date.now()<deadline;
const embed=createMemoryEmbedder(env.GEMINI_API_KEY);
let stopped=false,stageDone=false;
process.on('SIGTERM',()=>{stopped=true;log('stop_requested');});
const safeCode=e=>{
 const transient=xMemoryTransientCode(e);if(transient)return transient;
 if(String(e.message).includes('"code":"P0001"')&&String(e.message).includes('"message":"segment lease or input changed"'))return 'x_publication_lease_changed';
 const match=String(e.message).match(/"message":"([a-z_]+)"/);if(match)return match[1];
 return /^[a-z_]+$/.test(e.code||e.message||'')?(e.code||e.message):'bulk_operation_failed';
};
log('start',{since,until,deadline:new Date(deadline).toISOString(),concurrency:Number(process.env.X_BULK_CONCURRENCY||3)});
for(const table of (process.env.X_BULK_SKIP_CAPTURE==='1'?[]:['tweet_logs','tweets','my_tweets'])) {
 let after='',total=0,failed=0;
 while(alive()&&!stopped) {
  const page=await rpc('memory_reconcile_x_origins_v1',{p_table:table,p_since:since,p_after:after,p_limit:100});
  if(page.disabled)throw Error('capture_disabled');
  total+=page.processed||0;failed+=page.failed||0;
  log('capture',{table,total,failed,done:page.done});
  if(page.done)break;
  if(page.after===after)throw Error('cursor_stalled');
  after=page.after;
 }
}
async function stage(){
 while(alive()&&!stopped){
  try{
   const rows=await fetchXMemorySnapshot(rpc,since,20000,{shouldStop:()=>stopped||!alive(),onPage:progress=>log('snapshot_page',progress),onTransient:async progress=>{const cooldown=Math.min(60000,2000*2**Math.min(progress.failures-1,5));log('snapshot_cooling',{...progress,cooldown_ms:cooldown});await sleep(cooldown);}});
   log('snapshot_loaded',{sources:rows.length});
   const groupedAt=Date.now();
   const bounded=rows.filter(r=>Date.parse(r.occurred_at)<=Date.parse(until));
   const grouped=groupXBatches(bounded,{reservedRevisionIds:rows.filter(r=>r.reserved).map(r=>r.revision_id)});
   log('grouped',{batches:grouped.batches.length,ms:Date.now()-groupedAt});
   let staged=0,conflicts=0,refresh=false;
   for(const batch of grouped.batches){
    if(!alive()||stopped)break;
    let stageAttempts=0;
    while(alive()&&!stopped){
     try{await rpc('memory_stage_x_batch_v1',{p_batch:batch});staged++;if(staged%100===0)log('stage_progress',{staged,total:grouped.batches.length});break;}
     catch(e){const code=safeCode(e);
      if(['db_statement_timeout','db_transport_timeout','db_transport_unavailable'].includes(code)){stageAttempts++;const cooldown=Math.min(60000,5000*2**Math.min(stageAttempts-1,4));log('stage_cooling',{code,batch_key:batch.batch_key,attempt:stageAttempts,cooldown_ms:cooldown});await sleep(cooldown);continue;}
      conflicts++;log('stage_error',{code,batch_key:batch.batch_key});
      if(['x_primary_already_reserved','x_evidence_unavailable','x_source_not_stable'].includes(code)){refresh=true;break;}
      throw e;
     }
    }
    if(refresh)break;
    await sleep(100);
   }
   const waiting=bounded.filter(r=>!r.reserved&&Date.parse(r.observed_at)>Date.now()-600000).length;
   log('stage',{sources:rows.length,staged,conflicts,rejected:grouped.rejected.length,waiting_stability:waiting});
   if(!waiting&&!refresh){stageDone=true;return;}
   await sleep(60000);
  }catch(e){const code=safeCode(e);if(['db_statement_timeout','db_transport_timeout','db_transport_unavailable'].includes(code)){log('stage_cooling',{code,cooldown_ms:60000});await sleep(60000);continue;}log('stage_fatal',{code,detail:String(e.message).slice(0,800)});stopped=true;return;}
 }
}
async function extract(worker){
 let failures=0;
 while(Date.now()<deadline-600000&&!stopped){
  try{
   const jobs=await rpc('memory_claim_x_batches_v1',{p_limit:1});
   if(!jobs.length){if(stageDone){const remaining=await client.fetchAll('memory_x_batches',{select:'id',limit:1,filters:['status=in.(pending,processing)']});if(!remaining.length){log('worker_drained',{worker});return;}}await sleep(30000);continue;}
   const input=jobs[0];
   try{
    const result=await extractXBatch({input,model});
    await rpc('memory_publish_x_batch_v1',{p_batch_id:input.batch_id,p_input_hash:input.input_hash,p_lease_token:input.lease_token,p_result:result.value,p_extractor:result.model,p_prompt_hash:result.prompt_hash});
    failures=0;log('ready',{worker,batch_id:input.batch_id,memories:result.value.memory_items.length,usage:result.usage});
   }catch(e){
    const code=safeCode(e);if(['db_statement_timeout','db_transport_timeout','db_transport_unavailable','bulk_deadline_reached','x_publication_lease_changed'].includes(code)){log('lease_retry_after_expiry',{worker,batch_id:input.batch_id,code});await sleep(60000);continue;}await rpc('memory_fail_x_batch_v1',{p_batch_id:input.batch_id,p_lease_token:input.lease_token,p_error_code:code});
    failures++;log('failed',{worker,batch_id:input.batch_id,code});
    if(['model_usage_limit','model_authentication'].includes(code)){stopped=true;log('provider_stop',{code});return;}
    await sleep(Math.min(600000,30000*2**Math.min(failures,4)));
   }
  }catch(e){log('worker_error',{worker,code:safeCode(e)});await sleep(60000);}
 }
}
async function embeddings(){
 while(alive()&&!stopped){
  let total=0;
  try{
   for(const job of await rpc('memory_claim_x_batch_embeddings_v1',{p_limit:8})){
    try{
     if(job.model!==characterEmbeddingModel)throw Error('unsupported_embedding_model');
     const vector=validateMemoryVector(await embed(job.text));
     await rpc('memory_publish_x_batch_embedding_v1',{p_batch_id:job.batch_id,p_lease_token:job.lease_token,p_input_hash:job.input_hash,p_vector:JSON.stringify(vector)});total++;
    }catch{await rpc('memory_fail_x_batch_embedding_v1',{p_batch_id:job.batch_id,p_lease_token:job.lease_token,p_error_code:'embedding_unavailable'});log('embedding_failed');}
   }
   const items=await runMemoryEmbeddingCycle({rpc,embed,limit:8});
   if(total||items.length)log('embeddings',{batches:total,items});
  }catch(e){log('embedding_cycle_error',{code:safeCode(e)});}
  if(!total)await sleep(15000);
 }
}
const embeddingTask=embeddings();
await Promise.all([stage(),...Array.from({length:Number(process.env.X_BULK_CONCURRENCY||3)},(_,i)=>extract(i+1))]);
// Allow a bounded final embedding drain after extraction workers finish.
for(let i=0;i<8&&alive()&&!stopped;i++)await sleep(15000);
stopped=true;await embeddingTask;log('finish',{deadlineReached:!alive()});
