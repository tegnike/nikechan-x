import { groupXBatches } from './lib-x-memory-batches.mjs';
import { extractXBatch } from './lib-x-memory-extraction.mjs';
import { characterEmbeddingModel, validateMemoryVector } from './lib-character-memory-embedding.mjs';

export async function runXMemoryCycle({ rpc, model, embed, since = '2026-09-06T00:00:00Z', now = new Date(),
  reconcile = true, processingEnabled = true, maxExtract = 4, maxRuntimeMs = 20 * 60_000 }) {
  const started = Date.now(), report = { capture: [], staged: 0, rejected: 0, extraction: [], embeddings: [] };
  if (reconcile) for (const table of ['tweet_logs', 'tweets', 'my_tweets']) {
    let after = '', pages = 0;
    while (++pages <= 200) {
      const page = await rpc('memory_reconcile_x_origins_v1', { p_table: table, p_since: since, p_after: after, p_limit: 100 });
      report.capture.push({ table, processed: page.processed ?? 0, failed: page.failed ?? 0 });
      if (page.disabled || page.done) break;
      if (page.after === after) throw Error('x_reconcile_cursor_stalled');
      after = page.after;
      if (Date.now() - started > maxRuntimeMs) return { ...report, budget_exhausted: true };
    }
    if (pages > 200) throw Error('x_reconcile_limit_reached');
  }
  if (!processingEnabled) return { ...report, processing_disabled: true };
  const rows = await rpc('memory_x_source_snapshot_v1', { p_since: since, p_limit: 20000 });
  const grouped = groupXBatches(rows, { now, reservedRevisionIds: rows.filter(r => r.reserved).map(r => r.revision_id) });
  report.rejected = grouped.rejected.length;
  for (const batch of grouped.batches) {
    await rpc('memory_stage_x_batch_v1', { p_batch: batch }); report.staged++;
  }
  for (let index = 0; index < maxExtract && Date.now() - started < maxRuntimeMs; index++) {
    const jobs = await rpc('memory_claim_x_batches_v1', { p_limit: 1 });
    if (!jobs.length) break;
    const input = jobs[0];
    try {
      const extraction = await extractXBatch({ input, model });
      await rpc('memory_publish_x_batch_v1', { p_batch_id: input.batch_id, p_input_hash: input.input_hash,
        p_lease_token: input.lease_token, p_result: extraction.value, p_extractor: extraction.model,
        p_prompt_hash: extraction.prompt_hash });
      report.extraction.push({ batch_id: input.batch_id, status: 'ready', memories: extraction.value.memory_items.length,
        repaired: extraction.repaired, usage: extraction.usage ?? null });
    } catch (error) {
      const code = /^model_[a-z_]+$/u.test(error.code ?? '') ? error.code :
        /^[a-z_]+$/u.test(error.message ?? '') ? error.message : 'x_extraction_or_publish_failed';
      await rpc('memory_fail_x_batch_v1', { p_batch_id: input.batch_id, p_lease_token: input.lease_token, p_error_code: code });
      report.extraction.push({ batch_id: input.batch_id, status: 'failed', code });
      if (code.startsWith('model_')) break;
    }
  }
  for (const job of await rpc('memory_claim_x_batch_embeddings_v1', { p_limit: 8 })) {
    try {
      if (job.model !== characterEmbeddingModel) throw Error('unsupported_embedding_model');
      const vector = validateMemoryVector(await embed(job.text));
      const ready = await rpc('memory_publish_x_batch_embedding_v1', { p_batch_id: job.batch_id,
        p_lease_token: job.lease_token, p_input_hash: job.input_hash, p_vector: JSON.stringify(vector) });
      report.embeddings.push({ batch_id: job.batch_id, status: ready ? 'ready' : 'discarded' });
    } catch {
      await rpc('memory_fail_x_batch_embedding_v1', { p_batch_id: job.batch_id, p_lease_token: job.lease_token, p_error_code: 'embedding_unavailable' });
      report.embeddings.push({ batch_id: job.batch_id, status: 'failed' });
    }
  }
  report.duration_ms = Date.now() - started;
  return report;
}
