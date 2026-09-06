import { createHash, randomUUID } from 'node:crypto';

const allowed = new Set(['memory_recall_v2', 'memory_recall_v1', 'memory_validate_recall_v1', 'memory_delivery_v1']);
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
const snapshotKey = r => JSON.stringify([r.snapshot?.epoch, r.snapshot?.policy_hash, r.snapshot?.mode]);
export class XCharacterMemory {
  constructor({ mode = 'off', rpc, observe = () => {}, embed }) {
    if (!['off', 'shadow', 'live'].includes(mode)) throw Error('invalid_character_memory_mode');
    this.mode = mode; this.rpc = rpc; this.observe = observe; this.embed = embed;
  }
  async context(log) {
    if (this.mode === 'off') return undefined;
    try {
      if (!/^[0-9]+$/.test(String(log.user_id))) throw Error('unresolved_native_author');
      let vector = null;
      if (this.embed) { try { vector = JSON.stringify(await this.embed(String(log.body ?? ''))); } catch {} }
      const recall = async () => this.rpc(this.embed ? 'memory_recall_v2' : 'memory_recall_v1', {
        ...(this.embed ? { p_query_embedding: vector } : {}), p_runtime: 'x-public', p_destination: 'twitter:public',
        p_actor_platform: 'twitter', p_actor_native_id: String(log.user_id), p_query: String(log.body ?? ''),
        p_turn_key: randomUUID(), p_attempt: 1 });
      const reply = await recall();
      if (!reply?.run_id || !Array.isArray(reply.candidates) || reply.snapshot?.mode !== this.mode) throw Error('character_memory_mode_mismatch');
      this.observe({ mode: this.mode, candidates: reply.candidates.length, status: reply.status });
      // Shadow evidence must never reach the drafting model or pending text.
      if (this.mode === 'shadow') return undefined;
      const quote = await recall();
      if (!quote?.run_id || !Array.isArray(quote.candidates) || snapshotKey(quote) !== snapshotKey(reply) ||
          JSON.stringify(quote.candidates.map(c => c.item_id).sort()) !== JSON.stringify(reply.candidates.map(c => c.item_id).sort())) {
        throw Error('character_memory_changed_during_context');
      }
      return { mode: 'live', reply, quote };
    } catch (error) {
      if (this.mode === 'live') throw error;
      this.observe({ mode: 'shadow', status: 'unavailable' });
      return undefined;
    }
  }
  bind(memory, item) {
    if (!memory) {
      if (this.mode === 'live' && (item.replyAction === 'reply' || item.quoteAction === 'quote')) throw Error('character_memory_context_missing');
      return undefined;
    }
    if (memory.mode !== 'live') throw Error('invalid_character_memory_binding');
    const bound = { mode: 'live' };
    for (const action of ['reply', 'quote']) {
      if (item[`${action}Action`] !== action) continue;
      const recall = memory[action], used = item[`${action}UsedMemoryIds`];
      if (!Array.isArray(used) || used.some(id => typeof id !== 'string' || !recall.candidates.some(c => c.item_id === id))) throw Error('invalid_character_memory_evidence');
      bound[action] = { run_id: recall.run_id, used: [...new Set(used)] };
    }
    return bound;
  }
  async validate(item, action) {
    const bound = item.characterMemory;
    if (!bound) {
      if (this.mode === 'live') throw Error('pending_predates_character_memory; regenerate the proposal');
      return;
    }
    const record = bound[action];
    if (bound.mode !== 'live' || !record) throw Error('invalid_character_memory_binding');
    const ok = await this.rpc('memory_validate_recall_v1', { p_run_id: record.run_id, p_used_items: record.used,
      p_reply_hash: createHash('sha256').update(item[`${action}Text`]).digest('hex') });
    if (ok !== true) throw Error('character_memory_changed; regenerate the proposal');
  }
  async delivered(item, action, posted) {
    const record = item.characterMemory?.[action];
    if (!record || posted.dryRun) return;
    try {
      await this.rpc('memory_delivery_v1', { p_run_id: record.run_id, p_state: 'sent', p_message_id: posted.tweetId });
    } catch {
      // Posting already succeeded. Never turn an audit failure into an X retry.
      this.observe({ mode: 'live', status: 'delivery_audit_unknown' });
    }
  }
}


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
