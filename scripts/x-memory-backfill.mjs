#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, SupabaseClient } from './lib-memory-search.mjs';
import { createMemoryEmbedder } from './lib-character-memory-embedding.mjs';
import { extractXBatch } from './lib-x-memory-extraction.mjs';
import { runXMemoryBackfill, serialRpc, safeBackfillError } from './lib-x-memory-backfill.mjs';

const env = { ...await loadEnv(process.env.MEMORY_ENV_FILE || resolve('.env')), ...process.env };
const client = new SupabaseClient({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY });
const allowed = new Set(['memory_claim_x_batches_v1', 'memory_publish_x_batch_v1', 'memory_fail_x_batch_v1',
  'memory_claim_x_batch_embeddings_v1', 'memory_publish_x_batch_embedding_v1', 'memory_fail_x_batch_embedding_v1']);
const rpc = serialRpc((name, body) => {
  if (!allowed.has(name)) throw Error('invalid_x_rpc');
  return client.rpc(name, body, { timeoutMs: 30000 });
});
const model = async (_stage, instructions, input, schema) => {
  const result = await new Promise((ok, fail) => {
    const child = spawn('python3', [resolve(dirname(fileURLToPath(import.meta.url)), 'x-memory-codex-model.py')],
      { env: { ...process.env, HERMES_HOME: '/profile/profiles/nikechan-x' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 210000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 1000000) child.kill('SIGKILL'); });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); fail(Object.assign(Error('model_process_unavailable'), { code: 'model_process_unavailable' })); });
    child.on('close', code => {
      clearTimeout(timer);
      try { if (code !== 0) throw Error(); ok(JSON.parse(output)); }
      catch { fail(Object.assign(Error('model_execution_failed'), { code: 'model_execution_failed' })); }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({ instructions, input, schema, model: env.X_MEMORY_MODEL || 'gpt-5.5' }));
  });
  if (result.error) throw Object.assign(Error(result.error), { code: result.error });
  return result;
};
let stopped = false;
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });
const observe = event => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
try {
  const settings = await client.fetchAll('memory_sync_state', { select: 'cursor', limit: 1, filters: ['source_key=eq.character-memory%3Ax-settings'] });
  if (settings[0]?.cursor?.processing_enabled !== true) throw Error('x_processing_disabled');
  const result = await runXMemoryBackfill({ rpc, extract: job => extractXBatch({ input: job, model }),
    embed: createMemoryEmbedder(env.GEMINI_API_KEY), shouldStop: () => stopped, observe,
    maxExtract: Number(env.X_BACKFILL_EXTRACT_LIMIT || 1000), maxEmbed: Number(env.X_BACKFILL_EMBED_LIMIT || 10000),
    extractConcurrency: Number(env.X_BACKFILL_EXTRACT_CONCURRENCY || 2), embedConcurrency: Number(env.X_BACKFILL_EMBED_CONCURRENCY || 2),
    maxRuntimeMs: Number(env.X_BACKFILL_MINUTES || 120) * 60000 });
  if (result.fatal_code || result.extract_failed || result.embed_failed) process.exitCode = 1;
} catch (error) { observe({ stage: 'fatal', code: safeBackfillError(error) }); process.exitCode = 1; }
