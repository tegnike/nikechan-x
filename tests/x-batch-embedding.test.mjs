import test from 'node:test';
import assert from 'node:assert/strict';
import { createXBatchEmbedder } from '../scripts/lib-x-batch-embedding.mjs';
import { runXMemoryBackfill, retryTransientEmbedding } from '../scripts/lib-x-memory-backfill.mjs';
import { characterEmbeddingModel } from '../scripts/lib-character-memory-embedding.mjs';
const a=Array(768).fill(0.1), b=Array(768).fill(0.2);

test('one provider call preserves input order, task type, dimension and model',async()=>{
 let calls=0;
 const embed=createXBatchEmbedder('synthetic-key',async(url,options)=>{
  calls++;assert.ok(url.endsWith(':batchEmbedContents'));
  const q=JSON.parse(options.body);assert.equal(q.requests.length,2);
  assert.deepEqual(q.requests.map(r=>r.content.parts[0].text),['first','second']);
  for(const r of q.requests){assert.equal(r.model,'models/gemini-embedding-001');assert.equal(r.taskType,'RETRIEVAL_DOCUMENT');assert.equal(r.outputDimensionality,768);}
  assert.equal(options.body.includes('synthetic-key'),false);
  return {ok:true,json:async()=>({embeddings:[{values:a},{values:b}]})};
 });
 assert.deepEqual(await embed(['first','second']),[a,b]);assert.equal(calls,1);
});

test('missing results and invalid vectors fail closed',async()=>{
 for(const response of [{embeddings:[{values:a}]},{embeddings:[{values:a},{values:[0]}]}]){
  const embed=createXBatchEmbedder('synthetic-key',async()=>({ok:true,json:async()=>response}));
  await assert.rejects(embed(['first','second']));
 }
});

test('provider error response text is never retained in exception',async()=>{
 const embed=createXBatchEmbedder('synthetic-key',async()=>({ok:false,status:429,json:async()=>({error:{message:'sensitive'}})}));
 await assert.rejects(embed(['synthetic']),e=>e.message==='Gemini embedding failed: 429 batch_request_failed');
});

test('batch vectors are published against matching leases and hashes',async()=>{
 let claimed=false,calls=0;const stored=[];
 const rpc=async(name,body)=>{
  if(name==='memory_claim_x_batch_embeddings_v1'){if(claimed)return [];claimed=true;return [1,2].map(id=>({batch_id:id,text:'text'+id,input_hash:'hash'+id,lease_token:'lease'+id,model:characterEmbeddingModel}));}
  if(name==='memory_publish_x_batch_embedding_v1'){stored.push(body);return true;}
  throw Error('unexpected_rpc');
 };
 const result=await runXMemoryBackfill({rpc,maxExtract:0,maxEmbed:2,embedBatch:async texts=>{calls++;assert.deepEqual(texts,['text1','text2']);return [a,b];}});
 assert.equal(result.embedded,2);assert.equal(calls,1);
 stored.sort((x,y)=>x.p_batch_id-y.p_batch_id);
 for(let i=0;i<2;i++){assert.equal(stored[i].p_lease_token,'lease'+(i+1));assert.equal(stored[i].p_input_hash,'hash'+(i+1));assert.deepEqual(JSON.parse(stored[i].p_vector),[a,b][i]);}
});

test('batch count mismatch publishes nothing',async()=>{
 let claimed=false,published=0,failed=0;
 const result=await runXMemoryBackfill({maxExtract:0,maxEmbed:2,embedBatch:async()=>[a],rpc:async name=>{
  if(name==='memory_claim_x_batch_embeddings_v1'){if(claimed)return [];claimed=true;return [1,2].map(id=>({batch_id:id,text:'synthetic',input_hash:'hash',lease_token:'lease',model:characterEmbeddingModel}));}
  if(name==='memory_publish_x_batch_embedding_v1'){published++;return true;}
  if(name==='memory_fail_x_batch_embedding_v1'){failed++;return;}
  throw Error('unexpected_rpc');
 }});
 assert.equal(published,0);assert.equal(failed,2);assert.equal(result.embed_failed,2);
});

test('rate limit cooldown is opt-in for a whole batch and bounded',async()=>{
 let calls=0;const waits=[];
 await assert.rejects(retryTransientEmbedding(async()=>{calls++;throw Error('Gemini embedding failed: 429 batch_request_failed');},['synthetic'],{allowRateLimit:true,sleep:async ms=>waits.push(ms)}));
 assert.equal(calls,3);assert.deepEqual(waits,[60000,120000]);
});
