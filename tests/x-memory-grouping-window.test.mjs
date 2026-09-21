import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {groupXBatches} from '../scripts/lib-x-memory-batches.mjs';
const rows=Array.from({length:500},(_,i)=>({source_key:`twitter:post:${100000+i}`,revision_id:`r${i}`,content:`Codex AITuberKit #project${i%4} ${'x'.repeat(i%31===0?7000:60)} ${i}`,author_account_id:`a${i%7}`,occurred_at:new Date(Date.UTC(2025,0,1)+i*600000).toISOString(),observed_at:'2025-01-01T00:00:00Z',time_basis:'provider',lifecycle:'active',retention_state:'retained',post_kind:'tweet',reasons:[],actor_kind:i%3?'master':'other',reply_key:i%5===0?`twitter:post:${100000+i-1}`:null,quote_key:i%13===0?`twitter:post:${100000+i-3}`:null,direct_with_nike_verified:i%2===0}));
// Digests were generated from the pre-optimization full-history search.
const expected = {"1":"590669c18a4f329fd55c6d668a0c943297ad0fff9338fb30e7f2cb37602bdf34","3":"973d19ded1f2c001dc880cb6359fe1a13b4801c667a19a431a22ee034fdf5d30","6":"320df85dda757cf954438109685e65f87e6e76c9dc3308d8ad2ace207f139b83"};
for(const hours of [1,3,6])test(`equivalent full batches at ${hours}h incl exact boundaries, actors, roots, reserved and text cap`,()=>{
 const options={now:new Date('2026-01-01'),maxHours:hours,reservedRevisionIds:rows.filter((_,i)=>i%17===0).map(r=>r.revision_id)};
 const result=groupXBatches(rows,options);
 assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'),expected[hours]);
});
export {rows};
