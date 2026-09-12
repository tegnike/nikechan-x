import test from 'node:test';
import assert from 'node:assert/strict';
import { runXMemoryCycle } from '../scripts/lib-x-memory-pipeline.mjs';
import { extractXBatch } from '../scripts/lib-x-memory-extraction.mjs';
const input={messages:[{revision_id:'r',content:'図書館が好き',author_account_id:'a',time_basis:'provider'}],context:[],grouping_kind:'activity'};
const valid={batch_summary:'図書館の話',topics:[],memory_items:[],no_memory_reason:'no_durable_fact'};
test('no work makes zero model and embedding calls', async()=>{
 const calls=[];const report=await runXMemoryCycle({rpc:async(name)=>{calls.push(name);return name==='memory_reconcile_x_origins_v1'?{done:true,processed:0}:[];},
 model:()=>{throw Error('must not call');},embed:()=>{throw Error('must not call');}});
 assert.equal(report.staged,0);assert.equal(report.extraction.length,0);
});
test('processing off still reconciles all three archives',async()=>{
 const calls=[];await runXMemoryCycle({processingEnabled:false,rpc:async(name)=>{calls.push(name);return {done:true};}});
 assert.deepEqual(calls,Array(3).fill('memory_reconcile_x_origins_v1'));
});
test('structural error gets exactly one repair',async()=>{
 let calls=0;const result=await extractXBatch({input,model:async()=>({value:++calls===1?{}:valid,model:'fixture'})});
 assert.equal(calls,2);assert.equal(result.repaired,true);
});
test('provider outage never consumes a structural repair',async()=>{
 let calls=0;await assert.rejects(extractXBatch({input,model:async()=>{calls++;throw Object.assign(Error('unavailable'),{code:'model_usage_limit'});}}));assert.equal(calls,1);
});
