import { generateGeminiEmbedding } from './lib-memory-search.mjs';
export const characterEmbeddingModel = 'gemini-embedding-001:768:retrieval';
export function validateMemoryVector(values) {
  if (!Array.isArray(values) || values.length !== 768 || values.some(v => typeof v !== 'number' || !Number.isFinite(v)) ||
      !values.some(v => v !== 0)) throw Error('invalid_embedding_vector');
  return values;
}
export function createMemoryEmbedder(apiKey) {
  return async text => validateMemoryVector(await generateGeminiEmbedding(text, { apiKey, dimension: 768, taskType: 'RETRIEVAL_DOCUMENT' }));
}
export async function runMemoryEmbeddingCycle({ rpc, embed, limit = 4 }) {
  const jobs = await rpc('memory_claim_embeddings_v1', { p_limit: limit });
  if (!Array.isArray(jobs)) throw Error('invalid_embedding_claim');
  const results = [];
  for (const job of jobs) {
    try {
      if (job.model !== characterEmbeddingModel) throw Error('unsupported_embedding_model');
      const vector = validateMemoryVector(await embed(job.text));
      const published = await rpc('memory_publish_embedding_v1', { p_item_id: job.item_id, p_lease_token: job.lease_token,
        p_input_hash: job.input_hash, p_vector: JSON.stringify(vector) });
      results.push({ item_id: job.item_id, status: published === true ? 'ready' : 'discarded_stale_result' });
    } catch (error) {
      const code = /^[a-z_]+$/.test(error.message) ? error.message : 'embedding_provider_or_publication_failed';
      await rpc('memory_fail_embedding_v1', { p_item_id: job.item_id, p_lease_token: job.lease_token, p_error_code: code });
      results.push({ item_id: job.item_id, status: 'failed', code });
    }
  }
  return results;
}
