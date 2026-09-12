import test from 'node:test';
import assert from 'node:assert/strict';
import { groupXBatches } from '../scripts/lib-x-memory-batches.mjs';
const now = new Date('2026-09-12T20:00:00Z');
const row = (id, extra = {}) => ({source_key:`twitter:post:${id}`,revision_id:`revision-${id}`,content:'別々の話',
  author_account_id:'a',occurred_at:'2026-09-12T12:00:00Z',observed_at:'2026-09-12T12:01:00Z',time_basis:'provider',
  retention_state:'retained',reasons:[],actor_kind:'nike',...extra});
test('time alone does not join unrelated posts', () => assert.equal(groupXBatches([row(1),row(2)],{now}).batches.length,2));
test('explicit topic joins authored activity and unrelated topics stay apart', () => {
 const r=groupXBatches([row(1,{content:'#Demo リリース'}),row(2,{content:'#Demo 修正'}),row(3)],{now});
 assert.deepEqual(r.batches.map(b=>b.messages.length),[2,1]);
});
test('thread structure wins; processed parent remains context, never primary', () => {
 const r=groupXBatches([row(1),row(2,{reply_key:'twitter:post:1'}),row(3,{reply_key:'twitter:post:2'})],{now,reservedRevisionIds:['revision-1']});
 assert.equal(r.batches.length,1);assert.equal(r.batches[0].messages.length,2);
 assert.equal(r.batches[0].context[0].revision_id,'revision-1');
});
test('unstable posts, retweets, conflicts and missing authors do not get extracted', () => {
 const r=groupXBatches([row(1,{observed_at:now.toISOString()}),row(2,{post_kind:'retweet'}),row(3,{reasons:['conflict']}),row(4,{author_account_id:null})],{now});
 assert.equal(r.batches.length,0);
});
test('split 41 replies without losing a primary or exceeding character budget', () => {
 const rows=Array.from({length:41},(_,i)=>row(i+1,{reply_key:'twitter:post:999',content:'あ'.repeat(300)}));
 const r=groupXBatches(rows,{now});assert.equal(r.primary_count,41);assert.equal(r.batches.length,2);
 assert.ok(r.batches.every(b=>b.character_count<=12000 && b.messages.length<=40));
 assert.deepEqual(groupXBatches(rows.toReversed(),{now}).batches,r.batches);
});
test('days-later replies are new incremental episodes',()=>{
 const r=groupXBatches([row(1,{reply_key:'twitter:post:999',occurred_at:'2026-09-10T12:00:00Z'}),row(2,{reply_key:'twitter:post:999'})],{now});
 assert.equal(r.batches.length,2);
});
test('verified direct exchanges on separate roots join only for same person and topic',()=>{
 const r=groupXBatches([row(1,{actor_kind:'other',author_account_id:'friend',content:'AITuberKitを熱く紹介して',reply_key:'twitter:post:98',direct_with_nike_verified:true}),
 row(2,{actor_kind:'other',author_account_id:'friend',content:'AITuberKitの熱量をもっと',reply_key:'twitter:post:99',direct_with_nike_verified:true}),
 row(3,{actor_kind:'other',author_account_id:'someone-else',content:'AITuberKitの感想',reply_key:'twitter:post:97',direct_with_nike_verified:true})],{now});
 assert.equal(r.batches.length,2);assert.equal(r.batches[0].grouping_kind,'person_interaction');assert.equal(r.batches[0].messages.length,2);
});
