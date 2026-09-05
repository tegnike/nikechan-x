import { mkdir, open, rename, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const TABLES = new Set(['tweets', 'twitter_activity_logs']);
export async function prepareOutbox(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `.probe-${randomUUID()}`);
  const handle = await open(file, 'wx', 0o600);
  await handle.close();
  await unlink(file);
}
async function syncDirectory(directory) {
  const h = await open(directory, 'r');
  try { await h.sync(); } finally { await h.close(); }
}
export async function enqueue(directory, table, row) {
  if (!TABLES.has(table)) throw new Error('Unsupported outbox table');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = { version: 1, table, row: { ...row, id: row.id || randomUUID() } };
  const path = join(directory, `${entry.row.id}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const h = await open(temporary, 'wx', 0o600);
  try { await h.writeFile(JSON.stringify(entry)); await h.sync(); } finally { await h.close(); }
  await rename(temporary, path);
  await syncDirectory(directory);
  return entry.row.id;
}
export async function flushOutbox(directory, insert, limit = 25) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let saved = 0;
  const files = (await readdir(directory)).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).sort();
  for (const file of files.slice(0, limit)) {
    const path = join(directory, file);
    try {
      const entry = JSON.parse(await readFile(path, 'utf8'));
      if (entry.version !== 1 || !TABLES.has(entry.table) || `${entry.row?.id}.json` !== file) throw new Error('Invalid outbox entry');
      const result = await insert(entry.table, entry.row);
      if (result?.status !== 'inserted') break;
      await unlink(path);
      saved++;
    } catch (error) {
      // Failed/uncertain DB writes remain queued. Concurrent drain is safe by row PK.
      if (error.code !== 'ENOENT') console.error('storage outbox entry retained');
    }
  }
  if (saved) await syncDirectory(directory);
  return { saved, pending: (await readdir(directory)).filter(n => n.endsWith('.json')).length };
}
export function activityRow(stage, parsed, workflow, status, at = new Date().toISOString()) {
  return {
    workflow, stage, created_at: at, raw_content: JSON.stringify(parsed).slice(0, 3000),
    parsed: { ...(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { payload: parsed }), activity_status: status || (stage === 'error' ? 'failed' : stage === 'execute' ? 'success' : 'needs_approval') },
    created_by: 'nikechan-x',
  };
}
