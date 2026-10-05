import { validateMemoryVector } from './lib-character-memory-embedding.mjs';

export function createXBatchEmbedder(apiKey, fetcher = fetch) {
  if (!apiKey) throw Error('embedding_configuration_missing');
  return async texts => {
    if (!Array.isArray(texts) || !texts.length || texts.length > 8 || texts.some(t => typeof t !== 'string' || !t.trim())) throw Error('invalid_embedding_batch');
    const response = await fetcher('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents', {
      method: 'POST', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: texts.map(text => ({ model: 'models/gemini-embedding-001',
        content: { parts: [{ text: text.slice(0,8000) }] }, taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 768 })) }),
      signal: AbortSignal.timeout(45000),
    });
    const doc = await response.json().catch(() => null);
    if (!response.ok) throw Error('Gemini embedding failed: '+response.status+' batch_request_failed');
    if (!Array.isArray(doc?.embeddings) || doc.embeddings.length !== texts.length) throw Error('invalid_embedding_batch');
    return doc.embeddings.map(e => validateMemoryVector(e.values));
  };
}
