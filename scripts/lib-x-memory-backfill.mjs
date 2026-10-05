import { characterEmbeddingModel, validateMemoryVector } from './lib-character-memory-embedding.mjs';
import { xMemoryTransientCode } from './lib-x-memory-transient.mjs';

export function safeBackfillError(error) {
  const http = embeddingHttpStatus(error);
  if (http === 429) return 'embedding_provider_rate_limit';
  if (http === 401 || http === 403) return 'embedding_provider_authentication';
  if (http >= 500 || http === 408) return 'embedding_provider_unavailable';
  if (http) return 'embedding_provider_invalid_request';
  const transient = xMemoryTransientCode(error);
  if (transient) return transient;
  if (/^model_[a-z_]+$/.test(error?.code ?? '')) return error.code;
  if (/^model_[a-z_]+$/.test(error?.message ?? '')) return error.message;
  for (const code of ['unsupported_embedding_model', 'invalid_embedding_vector', 'x_evidence_unavailable', 'invalid_embedding_claim', 'invalid_extraction_claim', 'invalid_embedding_batch']) {
    if (error?.message === code) return code;
  }
  return 'backfill_operation_failed';
}

export function embeddingHttpStatus(error) {
  return Number(String(error?.message ?? '').match(/^Gemini embedding failed: (\d{3}) /)?.[1]) || null;
}

// Retry only idempotent provider requests, never database publications. No auth,
// invalid-input or rate-limit retry loop, and no raw response/body logging.
export async function retryTransientEmbedding(embed, text, { sleep = ms => new Promise(r => setTimeout(r, ms)), observe = () => undefined, allowRateLimit = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await embed(text); }
    catch (error) {
      const status = embeddingHttpStatus(error);
      const transport = error?.cause?.code ?? error?.code;
      const rateLimit = allowRateLimit && status === 429;
      const transient = rateLimit || status === 408 || status >= 500 || (!status && (error?.name === 'TimeoutError'
        || ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'].includes(transport)));
      if (!transient || attempt >= 2) throw error;
      const delay = rateLimit ? 60000 * (attempt + 1) : 2000 * 2 ** attempt;
      observe({ stage: 'embedding_retry', code: safeBackfillError(error), http_status: status, retry: attempt + 1, delay_ms: delay });
      await sleep(delay);
    }
  }
}

// Serialize database calls while provider requests run in a bounded parallel pool.
// This reduces DB contention without weakening the existing claim/lease/hash checks.
export function serialRpc(request) {
  let tail = Promise.resolve();
  return (name, body) => {
    const result = tail.then(() => request(name, body));
    tail = result.catch(() => undefined);
    return result;
  };
}

export async function runXMemoryBackfill({ rpc, extract, embed, embedBatch, maxExtract = 1000, maxEmbed = 10000,
  extractConcurrency = 2, embedConcurrency = 2, maxRuntimeMs = 120 * 60000,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), shouldStop = () => false,
  observe = () => undefined }) {
  for (const [value, max] of [[maxExtract, 2000], [maxEmbed, 20000], [extractConcurrency, 4], [embedConcurrency, 4]]) {
    if (!Number.isInteger(value) || value < 0 || value > max) throw Error('invalid_backfill_configuration');
  }
  if ((maxExtract && !extractConcurrency) || (maxEmbed && !embedConcurrency) || !Number.isFinite(maxRuntimeMs) || maxRuntimeMs < 600000 || maxRuntimeMs > 4 * 3600000) throw Error('invalid_backfill_configuration');
  const started = now(), deadline = started + maxRuntimeMs;
  const stats = { extracted: 0, memories: 0, extract_failed: 0, embedded: 0, embed_failed: 0, embed_discarded: 0, extract_claimed: 0, embed_claimed: 0 };
  let fatal = null, extractionEnded = maxExtract === 0, activeExtraction = 0, consecutiveExtractFailures = 0;
  const stop = () => Boolean(fatal || shouldStop());
  const pulse = stage => observe({ stage, ...stats, elapsed_ms: now() - started });
  const claimExtraction = serialRpc(async () => {
    if (stop() || stats.extract_claimed >= maxExtract || now() >= deadline - 8 * 60000) return [];
    const jobs = await rpc('memory_claim_x_batches_v1', { p_limit: 1 });
    if (!Array.isArray(jobs) || jobs.length > 1) throw Error('invalid_extraction_claim');
    stats.extract_claimed += jobs.length;
    return jobs;
  });
  async function extractionLane() {
    while (!stop()) {
      const jobs = await claimExtraction();
      if (!jobs.length) return;
      const job = jobs[0]; activeExtraction++;
      try {
        const result = await extract(job);
        await rpc('memory_publish_x_batch_v1', { p_batch_id: job.batch_id, p_input_hash: job.input_hash,
          p_lease_token: job.lease_token, p_result: result.value, p_extractor: result.model, p_prompt_hash: result.prompt_hash });
        stats.extracted++; stats.memories += result.value.memory_items.length; consecutiveExtractFailures = 0;
      } catch (error) {
        const code = safeBackfillError(error);
        stats.extract_failed++; consecutiveExtractFailures++;
        await rpc('memory_fail_x_batch_v1', { p_batch_id: job.batch_id, p_lease_token: job.lease_token, p_error_code: code });
        observe({ stage: 'extraction_failed', code });
        if (code.startsWith('model_') || consecutiveExtractFailures >= 3) fatal = code;
      } finally {
        activeExtraction--; pulse('extraction_progress');
      }
    }
  }
  const extractionTask = Promise.all(Array.from({ length: maxExtract ? extractConcurrency : 0 }, extractionLane))
    .catch(error => { fatal = safeBackfillError(error); observe({ stage: 'extraction_stopped', code: fatal }); })
    .finally(() => { extractionEnded = true; });
  const embeddingTask = (async () => {
    while (!stop() && stats.embed_claimed < maxEmbed && now() < deadline - 2 * 60000) {
      const requested = Math.min(8, maxEmbed - stats.embed_claimed);
      const jobs = await rpc('memory_claim_x_batch_embeddings_v1', { p_limit: requested });
      if (!Array.isArray(jobs) || jobs.length > requested) throw Error('invalid_embedding_claim');
      if (!jobs.length) {
        if (extractionEnded && activeExtraction === 0) break;
        await sleep(3000); continue;
      }
      stats.embed_claimed += jobs.length;
      let batchVectors;
      if (embedBatch) {
        try {
          if (jobs.some(j => j.model !== characterEmbeddingModel)) throw Error('unsupported_embedding_model');
          batchVectors = await retryTransientEmbedding(embedBatch, jobs.map(j => j.text), {sleep, observe, allowRateLimit:true});
          if (!Array.isArray(batchVectors) || batchVectors.length !== jobs.length) throw Error('invalid_embedding_batch');
          batchVectors = batchVectors.map(validateMemoryVector);
        } catch (error) {
          const code = safeBackfillError(error);
          for (const job of jobs) await rpc('memory_fail_x_batch_embedding_v1', {p_batch_id:job.batch_id,p_lease_token:job.lease_token,p_error_code:code});
          stats.embed_failed += jobs.length; fatal = 'embedding_batch_failed';
          observe({stage:'embedding_failed',code,phase:'batch_provider',http_status:embeddingHttpStatus(error),count:jobs.length});
          pulse('embedding_progress'); break;
        }
      }
      let index = 0;
      const failedBefore = stats.embed_failed;
      await Promise.all(Array.from({ length: Math.min(embedConcurrency, jobs.length) }, async () => {
        while (index < jobs.length) {
          const jobIndex = index++; const job = jobs[jobIndex];
          let phase = 'validation';
          try {
            if (job.model !== characterEmbeddingModel) throw Error('unsupported_embedding_model');
            phase = 'provider';
            const vector = batchVectors ? batchVectors[jobIndex] : validateMemoryVector(await retryTransientEmbedding(embed, job.text, {sleep, observe}));
            phase = 'publication';
            const ready = await rpc('memory_publish_x_batch_embedding_v1', { p_batch_id: job.batch_id,
              p_lease_token: job.lease_token, p_input_hash: job.input_hash, p_vector: JSON.stringify(vector) });
            if (ready === true) stats.embedded++; else stats.embed_discarded++;
          } catch (error) {
            stats.embed_failed++;
            const code = safeBackfillError(error);
            await rpc('memory_fail_x_batch_embedding_v1', { p_batch_id: job.batch_id, p_lease_token: job.lease_token, p_error_code: code });
            observe({ stage: 'embedding_failed', code, phase, http_status: embeddingHttpStatus(error) });
          }
        }
      }));
      pulse('embedding_progress');
      if (stats.embed_failed > failedBefore) { fatal = 'embedding_batch_failed'; break; }
      await sleep(250);
    }
  })().catch(error => { fatal = safeBackfillError(error); observe({ stage: 'embedding_stopped', code: fatal }); });
  await Promise.all([extractionTask, embeddingTask]);
  const result = { ...stats, elapsed_ms: now() - started, stopped: Boolean(shouldStop()), fatal_code: fatal,
    budget_exhausted: now() >= deadline - 8 * 60000, limits_reached: (maxExtract > 0 && stats.extract_claimed >= maxExtract) || (maxEmbed > 0 && stats.embed_claimed >= maxEmbed) };
  observe({ stage: 'finish', ...result });
  return result;
}
