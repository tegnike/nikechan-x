#!/usr/bin/env node
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
const rpc = (name, body) => { if (!allowed.has(name)) throw Error('invalid_x_rpc'); return client.rpc(name,body,{timeoutMs:30000}); };
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
try {
 const embed=createMemoryEmbedder(env.GEMINI_API_KEY);
 const settings=await client.fetchAll('memory_sync_state',{select:'cursor',limit:1,filters:['source_key=eq.character-memory%3Ax-settings']});
 const processingEnabled=settings[0]?.cursor?.processing_enabled===true;
 const report=await runXMemoryCycle({rpc,model,embed,since:env.X_MEMORY_CUTOVER||settings[0]?.cursor?.cutover||'2026-09-06T00:00:00Z',
  maxExtract:Number(env.X_MEMORY_EXTRACT_LIMIT||4),reconcile:true,processingEnabled});
 if(processingEnabled)report.item_embeddings=await runMemoryEmbeddingCycle({rpc,embed,limit:8});
 console.log(JSON.stringify(report));
 if(report.capture.some(p=>p.failed)||report.extraction.some(p=>p.status==='failed')||report.embeddings.some(p=>p.status==='failed'))process.exitCode=1;
} catch { console.error(JSON.stringify({error:'x_memory_cycle_failed'}));process.exitCode=1; }
