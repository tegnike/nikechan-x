import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTwitterIdentity } from '../scripts/twitter-identity.mjs';
test('recycled handle never reuses the old account', async()=>{
 const calls=[];const result=await resolveTwitterIdentity({platformUserId:'222',username:'same'}, {
  persist:true,findById:async(id)=>{calls.push(id);return null;},createById:async(id)=>({id:'new-user',native:id})});
 assert.equal(result.id,'new-user');assert.deepEqual(calls,['222']);
});
test('unknown native ID never falls back to a handle or creates a row',async()=>{
 const forbidden=async()=>{throw Error('unexpected lookup/write');};
 assert.equal((await resolveTwitterIdentity({username:'same'},{persist:true,findById:forbidden,createById:forbidden})).id,'');
});
test('existing native ID preserves identity across a rename',async()=>{
 const result=await resolveTwitterIdentity({platformUserId:'222',username:'renamed'},{persist:true,findById:async()=>({id:'same-user'}),createById:async()=>{throw Error('unexpected create');}});
 assert.equal(result.id,'same-user');
});
test('dry run does not create a native account',async()=>{
 assert.equal((await resolveTwitterIdentity({platformUserId:'222',username:'same'},{persist:false,findById:async()=>null,createById:async()=>{throw Error('unexpected create');}})).id,'');
});
