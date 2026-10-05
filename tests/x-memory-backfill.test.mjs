import test from 'node:test';
import assert from 'node:assert/strict';
import { runXMemoryBackfill, serialRpc, safeBackfillError, retryTransientEmbedding } from '../scripts/lib-x-memory-backfill.mjs';
import { characterEmbeddingModel } from '../scripts/lib-character-memory-embedding.mjs';
const vector = Array(768).fill(0.1);
const job = id => ({ batch_id: id, input_hash: 'hash', lease_token: 'lease' });
const embedding = id => ({ ...job(id), model: characterEmbeddingModel, text: 'synthetic' });
const result = { value: { memory_items: [] }, model: 'synthetic', prompt_hash: 'hash' };

test('drains only X queues, honors global limits and preserves lease/hash', async () => {
  let ex = 0, em = 0; const publications = [];
  const rpc = async (name, body) => {
    if (name === 'memory_claim_x_batches_v1') return [job(++ex)];
    if (name === 'memory_claim_x_batch_embeddings_v1') return Array.from({ length: body.p_limit }, () => embedding(++em));
    if (name.startsWith('memory_publish_')) { publications.push({name, body}); return true; }
    throw Error('unexpected_rpc');
  };
  const actual = await runXMemoryBackfill({rpc, extract: async () => result, embed: async () => vector,
    maxExtract: 3, maxEmbed: 9, sleep: async () => undefined});
  assert.equal(actual.extracted, 3); assert.equal(actual.embedded, 9);
  assert.equal(ex, 3); assert.equal(em, 9);
  for (const {body} of publications) { assert.equal(body.p_lease_token, 'lease'); assert.equal(body.p_input_hash, 'hash'); }
});

test('embeddings wait for in-flight extraction before declaring queue drained', async () => {
  let claimed = false, complete = false, embedded = false;
  const rpc = async name => {
    if (name === 'memory_claim_x_batches_v1') { if (claimed) return []; claimed = true; return [job(1)]; }
    if (name === 'memory_publish_x_batch_v1') { complete = true; return true; }
    if (name === 'memory_claim_x_batch_embeddings_v1') return complete && !embedded ? [embedding(1)] : [];
    if (name === 'memory_publish_x_batch_embedding_v1') { embedded = true; return true; }
    throw Error('unexpected_rpc');
  };
  const actual = await runXMemoryBackfill({rpc, extract: async () => { await new Promise(r => setTimeout(r, 15)); return result; },
    embed: async () => vector, maxExtract: 2, maxEmbed: 2, sleep: async () => new Promise(r => setTimeout(r, 2))});
  assert.equal(actual.extracted, 1); assert.equal(actual.embedded, 1);
});

test('provider failure stops further extraction and records only safe codes', async () => {
  let calls = 0; const events = [], failures = [];
  const actual = await runXMemoryBackfill({rpc: async (name, body) => {
    if (name === 'memory_claim_x_batches_v1') { calls++; return [job(calls)]; }
    if (name === 'memory_fail_x_batch_v1') { failures.push(body); return; }
    throw Error('unexpected_rpc');
  }, extract: async () => { throw Object.assign(Error('sensitive raw response'), {code:'model_usage_limit'}); },
    maxExtract: 10, maxEmbed: 0, extractConcurrency: 1, observe: e => events.push(e)});
  assert.equal(calls, 1); assert.equal(actual.fatal_code, 'model_usage_limit');
  assert.equal(failures[0].p_error_code, 'model_usage_limit');
  assert.equal(JSON.stringify(events).includes('sensitive'), false);
  assert.equal(safeBackfillError(Error('credentials or original text')), 'backfill_operation_failed');
});

test('stale publication is counted as discarded, never as stored', async () => {
  let claimed = false;
  const actual = await runXMemoryBackfill({rpc: async name => {
    if (name === 'memory_claim_x_batch_embeddings_v1') { if(claimed) return []; claimed = true; return [embedding(1)]; }
    if (name === 'memory_publish_x_batch_embedding_v1') return false;
    throw Error('unexpected_rpc');
  }, embed: async () => vector, maxExtract: 0, maxEmbed: 2, sleep: async () => undefined});
  assert.equal(actual.embedded, 0); assert.equal(actual.embed_discarded, 1);
});

test('deadline reserve and cancellation prevent new claims', async () => {
  let time = 0, claims = 0;
  const actual = await runXMemoryBackfill({rpc: async name => {
    if (name === 'memory_claim_x_batches_v1') { claims++; return [job(1)]; }
    return true;
  }, extract: async () => { time = 600000; return result; }, now: () => time,
    maxRuntimeMs: 600000, maxExtract: 10, maxEmbed: 0, extractConcurrency: 1});
  assert.equal(claims, 1); assert.equal(actual.budget_exhausted, true);
  const stopped = await runXMemoryBackfill({rpc: async () => { throw Error('unexpected'); }, maxExtract: 1, maxEmbed: 1, shouldStop: () => true});
  assert.equal(stopped.extract_claimed, 0); assert.equal(stopped.embed_claimed, 0);
});

test('database calls remain serial even after failure', async () => {
  let active=0, peak=0;
  const rpc=serialRpc(async name => { active++; peak=Math.max(peak,active); await new Promise(r=>setTimeout(r,3)); active--; if(name==='fail')throw Error('synthetic'); return name; });
  const results=await Promise.allSettled([rpc('fail'),rpc('ok'),rpc('ok')]);
  assert.equal(peak,1); assert.equal(results[0].status,'rejected'); assert.equal(results[2].value,'ok');
});


test('transient embedding provider failure retries without leaking response or text', async () => {
  let calls = 0; const delays = [], events = [];
  const v = await retryTransientEmbedding(async () => { if (++calls < 3) throw Error('Gemini embedding failed: 503 sensitive response'); return vector; },
    'sensitive original', {sleep: async ms => delays.push(ms), observe: e => events.push(e)});
  assert.equal(v, vector); assert.equal(calls, 3); assert.deepEqual(delays, [2000,4000]);
  assert.equal(JSON.stringify(events).includes('sensitive'), false);
  assert.equal(events[0].http_status, 503);
});

test('auth, invalid input and quota failures are not automatically retried', async () => {
  for (const status of [400,401,403,429]) {
    let calls = 0;
    await assert.rejects(retryTransientEmbedding(async () => { calls++; throw Error('Gemini embedding failed: '+status+' response'); },
      'synthetic', {sleep: async () => {throw Error('unexpected retry');}}));
    assert.equal(calls,1);
  }
});

test('persistent transient embedding errors have a finite retry limit', async () => {
  let calls = 0;
  await assert.rejects(retryTransientEmbedding(async () => {calls++;throw Error('Gemini embedding failed: 500 response');}, 'synthetic', {sleep: async()=>undefined}));
  assert.equal(calls,3);
});
