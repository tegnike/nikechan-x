import test from 'node:test';
import assert from 'node:assert/strict';
import { xMemoryTransientCode } from '../scripts/lib-x-memory-transient.mjs';
import { fetchXMemorySnapshot } from '../scripts/lib-x-memory-snapshot.mjs';
test('recognizes transport timeout and network reset but rejects unknown/auth/schema/cancellation',()=>{
 assert.equal(xMemoryTransientCode(new DOMException('The operation was aborted due to timeout','TimeoutError')),'db_transport_timeout');
 assert.equal(xMemoryTransientCode(Object.assign(Error('fetch failed'),{cause:{code:'ECONNRESET'}})),'db_transport_unavailable');
 for(const e of [Error('permission denied'),Error('schema missing'),Error('fetch failed'),new DOMException('cancelled','AbortError')])assert.equal(xMemoryTransientCode(e),null);
});
test('transport timeout resumes the same snapshot cursor with accumulated rows',async()=>{
 let calls=0,cooling=0;
 const rows=await fetchXMemorySnapshot(async(_name,body)=>{
  calls++;
  if(calls===1)return Array.from({length:100},(_,i)=>({source_key:String(i).padStart(4,'0')}));
  assert.equal(body.p_after,'0099');
  if(calls===2)throw new DOMException('The operation was aborted due to timeout','TimeoutError');
  return [{source_key:'0100'}];
 },'2024-12-01',20000,{onTransient:async()=>{cooling++;}});
 assert.equal(rows.length,101);assert.equal(cooling,1);
});
