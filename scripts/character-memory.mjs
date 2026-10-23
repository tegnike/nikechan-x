import { createHash, randomUUID } from 'node:crypto';

const allowed = new Set(['memory_recall_temporal_v1', 'memory_recall_episodes_temporal_v1', 'memory_recall_unresolved_temporal_v1', 'memory_recall_v2', 'memory_recall_v1', 'memory_validate_recall_v1', 'memory_delivery_v1', 'memory_recall_episodes_v1', 'memory_validate_episode_recall_v1', 'memory_person_context_x_v1']);
export function memoryRpc({ url, key, fetcher = fetch }) {
  return async (name, body) => {
    if (!allowed.has(name) || !url || !key) throw Error('character_memory_unavailable');
    const r = await fetcher(`${url.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw Error('character_memory_unavailable');
    return r.status === 204 ? null : r.json();
  };
}
export { XCharacterMemory } from './lib-x-memory-recall.mjs';

// This endpoint creates vectors only; all reply drafting stays on its existing model.
export function queryEmbedding(apiKey, fetcher = fetch) {
  return async text => {
    const r = await fetcher('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ model: 'models/gemini-embedding-001', content: { parts: [{ text }] }, outputDimensionality: 768, taskType: 'RETRIEVAL_QUERY' }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw Error('query_embedding_unavailable');
    const vector = (await r.json()).embedding?.values;
    if (!Array.isArray(vector) || vector.length !== 768 || vector.some(v => typeof v !== 'number' || !Number.isFinite(v)) || !vector.some(v => v !== 0)) throw Error('invalid_query_embedding');
    return vector;
  };
}
