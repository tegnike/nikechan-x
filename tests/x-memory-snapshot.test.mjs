import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchXMemorySnapshot} from '../scripts/lib-x-memory-snapshot.mjs';
test('collect pages with stable keyset cursor and preserve reserved/context metadata',async()=>{
 let calls=0;
 const rows=await fetchXMemorySnapshot(async(name,body)=>{
  assert.equal(name,'memory_x_source_snapshot_page_v1');assert.equal(body.p_limit,100);
  if(++calls===1){assert.equal(body.p_after,'');return Array.from({length:100},(_,i)=>({source_key:String(i).padStart(5,'0'),reserved:true}));}
  assert.equal(body.p_after,'00099');return[{source_key:'00100',reply_key:'00001',reserved:false}];
 },'2024-12-01');
 assert.equal(rows.length,101);assert.equal(rows[0].reserved,true);assert.equal(rows[100].reply_key,'00001');
});
test('reject repeated or out-of-order page keys',async()=>{
 await assert.rejects(fetchXMemorySnapshot(async()=>[{source_key:'a'},{source_key:'a'}],'2024-12-01'),/cursor_stalled/);
 await assert.rejects(fetchXMemorySnapshot(async()=>[{source_key:'b'},{source_key:'a'}],'2024-12-01'),/cursor_stalled/);
});
test('fail visibly at snapshot cap instead of silently dropping old records',async()=>{
 await assert.rejects(fetchXMemorySnapshot(async()=>[{source_key:'a'},{source_key:'b'}],'2024-12-01',1),/limit_reached/);
});
test('reduce page size after DB statement timeout without advancing cursor',async()=>{
 const sizes=[];const rows=await fetchXMemorySnapshot(async(_name,body)=>{
  sizes.push(body.p_limit);assert.equal(body.p_after,'');
  if(sizes.length===1)throw Error('statement timeout 57014');
  return [{source_key:'a'}];
 },'2024-12-01');assert.deepEqual(sizes,[100,50]);assert.equal(rows.length,1);
});
test('bulk cooling retains cursor and accumulated rows through minimum page timeout',async()=>{
 let calls=0;const pauses=[];
 const rows=await fetchXMemorySnapshot(async(_name,b)=>{
  calls++;
  if(calls===1)return Array.from({length:100},(_,i)=>({source_key:String(i).padStart(5,'0')}));
  assert.equal(b.p_after,'00099');
  if(calls<=8)throw Error('57014');
  assert.equal(b.p_limit,10);return[{source_key:'00100'}];
 },'2024-12-01',20000,{onTransient:async p=>pauses.push(p)});
 assert.equal(rows.length,101);assert.equal(pauses.length,7);assert.equal(pauses.at(-1).rows,100);assert.equal(pauses.at(-1).pageSize,10);
});
test('cooling remains cancellable at deadline without resetting or advancing cursor',async()=>{
 let paused=0;
 await assert.rejects(fetchXMemorySnapshot(async()=>{throw Error('57014');},'2024-12-01',20000,{shouldStop:()=>paused>=2,onTransient:async()=>{paused++;}}),/x_snapshot_cancelled/);
 assert.equal(paused,2);
});
test('unknown, schema and authentication errors fail closed instead of cooling forever',async()=>{
 for(const message of ['401 unauthorized','PGRST202 unknown function','unexpected database error']){
  let paused=0;await assert.rejects(fetchXMemorySnapshot(async()=>{throw Error(message);},'2024-12-01',20000,{onTransient:async()=>{paused++;}}));assert.equal(paused,0);
 }
});
