import test from 'node:test';import assert from 'node:assert/strict';
import {createPriorityRpcQueue,createXBulkRpc} from '../scripts/lib-x-memory-bulk-rpc.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
test('serial queue prioritizes ready publication over waiting claims and survives rejection',async()=>{
 const queue=createPriorityRpcQueue();let release,active=0,max=0;const order=[];
 const first=queue(async()=>{active++;max=Math.max(max,active);await new Promise(r=>release=r);active--;},2);await tick();
 const claim=queue(async()=>{active++;max=Math.max(max,active);order.push('claim');active--;},2);
 const pub=queue(async()=>{active++;max=Math.max(max,active);order.push('publish');active--;throw Error('expected');},0);const rejected=assert.rejects(pub,/expected/);
 release();await Promise.all([first,claim,rejected]);assert.deepEqual(order,['publish','claim']);assert.equal(max,1);
});
test('aging prevents embedding starvation',async()=>{
 let now=0,release;const order=[];const queue=createPriorityRpcQueue({now:()=>now,maxWaitMs:30});
 const first=queue(()=>new Promise(r=>release=r));await tick();const embed=queue(()=>order.push('embedding'),3);now=31;const pub=queue(()=>order.push('publish'),0);release();await Promise.all([first,embed,pub]);assert.deepEqual(order,['embedding','publish']);
});
const names=['memory_claim_x_batches_v1','memory_publish_x_batch_v1','memory_claim_x_batch_embeddings_v1'];
function setup(overrides={}){return createXBulkRpc({request:async()=>[],allowed:new Set(names),alive:()=>true,stopped:()=>false,claimCutoff:1000000,log:()=>{},sleep:async()=>{},now:()=>0,...overrides});}
test('transient claim enters shared cooldown but publication proceeds',async()=>{
 let now=0,claims=0,pubs=0;const rpc=setup({now:()=>now,request:async(name)=>{if(name===names[0]){claims++;throw Error('57014');}pubs++;return {};}});
 assert.deepEqual(await rpc(names[0],{}),[]);await rpc(names[0],{});await rpc(names[1],{});assert.equal(claims,1);assert.equal(pubs,1);now=5001;await rpc(names[0],{});assert.equal(claims,2);
});
test('retry backoff releases queue to publish and embedding shares same serial queue',async()=>{
 let releaseSleep,attempts=0,pubs=0;const rpc=setup({sleep:()=>new Promise(r=>releaseSleep=r),request:async(name)=>{if(name===names[2]&&++attempts===1)throw Error('57014');if(name===names[1])pubs++;return [];}});
 const embedding=rpc(names[2],{});await tick();await rpc(names[1],{});assert.equal(pubs,1);releaseSleep();await embedding;assert.equal(attempts,2);
});
test('queued claim rechecks stop and cutoff; schema/auth are not retried',async()=>{
 let stopped=false,release,claims=0;const rpc=setup({stopped:()=>stopped,request:async(name)=>{if(name===names[1])await new Promise(r=>release=r);else claims++;return [];}});
 const pub=rpc(names[1],{});await tick();const claim=rpc(names[0],{});stopped=true;release();await pub;assert.deepEqual(await claim,[]);assert.equal(claims,0);
 const cutoff=setup({now:()=>1000001,request:async()=>{throw Error('must not execute');}});assert.deepEqual(await cutoff(names[0],{}),[]);
 let calls=0;const invalid=setup({request:async()=>{calls++;throw Error('permission denied');}});await assert.rejects(invalid(names[1],{}),/permission denied/);assert.equal(calls,1);
});
