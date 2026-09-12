import test from 'node:test';
import assert from 'node:assert/strict';
import { XCharacterMemory } from '../scripts/lib-x-memory-recall.mjs';
const fixture=(mode='live')=>{
 const calls=[];let embeddings=0;
 const rpc=async(name,body)=>{calls.push({name,body});const snapshot={epoch:1,policy_hash:'p',mode};
 if(name.startsWith('memory_validate'))return true;
 if(name==='memory_delivery_v1')throw Error('audit unavailable');
 return {run_id:`run-${calls.length}`,snapshot,status:'ok',candidates:name==='memory_recall_episodes_v1'?[{episode_key:'discord:one',summary:'話題'}]:[{item_id:'item-one',summary:'好み'}]};};
 return {memory:new XCharacterMemory({mode,rpc,embed:async()=>{embeddings++;return [1];}}),calls,embeddings:()=>embeddings};
};
test('shadow queries both actions, with one embedding, without returning evidence',async()=>{
 const f=fixture('shadow');assert.equal(await f.memory.context({user_id:'1',body:'題'}),undefined);assert.equal(f.embeddings(),1);assert.equal(f.calls.length,4);
});
test('actual item and episode use separately validated and audited; audit error cannot resend',async()=>{
 const f=fixture(),context=await f.memory.context({user_id:'1',body:'題'});
 const item={replyAction:'reply',quoteAction:'skip',replyUsedMemoryIds:['item-one','discord:one'],replyText:'返答'};
 item.characterMemory=f.memory.bind(context,item);
 await f.memory.validate(item,'reply');
 assert.deepEqual(f.calls.find(c=>c.name==='memory_validate_recall_v1').body.p_used_items,['item-one']);
 assert.deepEqual(f.calls.find(c=>c.name==='memory_validate_episode_recall_v1').body.p_used_episode_keys,['discord:one']);
 await f.memory.delivered(item,'reply',{tweetId:'123'});assert.equal(f.calls.filter(c=>c.name==='memory_delivery_v1').length,2);
});
test('unoffered memory IDs and live recall failures are rejected',async()=>{
 const f=fixture(),context=await f.memory.context({user_id:'1',body:'題'});
 assert.throws(()=>f.memory.bind(context,{replyAction:'reply',replyUsedMemoryIds:['invented']}));
 await assert.rejects(new XCharacterMemory({mode:'live',rpc:async()=>{throw Error('offline');}}).context({user_id:'1',body:'題'}));
});
