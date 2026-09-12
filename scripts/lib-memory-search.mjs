import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
export const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const execFileAsync = promisify(execFile);

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export async function loadEnv(path = join(PROJECT_ROOT, '.env')) {
  const env = {};
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return env;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index);
    let value = line.slice(index + 1).trim();
    value = value.replace(/^['"]|['"]$/g, '');
    env[key] = value;
  }
  return env;
}

export function requireConfig(env, keys) {
  const missing = keys.filter((key) => !env[key] && !process.env[key]);
  if (missing.length) throw new Error(`${missing.join(', ')} are required`);
  return Object.fromEntries(keys.map((key) => [key, process.env[key] || env[key]]));
}

export class SupabaseClient {
  constructor({ url, key }) {
    this.url = url.replace(/\/$/, '');
    this.key = key;
    this.api = `${this.url}/rest/v1`;
  }

  async request(method, path, body = undefined, options = {}) {
    const headers = {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {}),
    };
    const retries = method === 'GET' ? Number(options.retries ?? 2) : 0;
    let res;
    for (let attempt = 0; ; attempt += 1) {
      try {
        res = await fetch(`${this.api}/${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
        });
      } catch (error) {
        if (attempt >= retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      if (attempt >= retries || ![408, 429].includes(res.status) && res.status < 500) break;
      await res.arrayBuffer().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Supabase ${method} ${path} failed: ${res.status} ${truncate(text, 700)}`);
    }
    if (!text) return null;
    return JSON.parse(text);
  }

  async rpc(name, body, options = {}) {
    return this.request('POST', `rpc/${name}`, body, options);
  }

  async fetchPage(table, { select = '*', order, limit = 1000, offset = 0, filters = [] }) {
    const params = [`select=${encodeURIComponent(select)}`, `limit=${limit}`, `offset=${offset}`];
    if (order) params.push(`order=${encodeURIComponent(order)}`);
    params.push(...filters);
    return this.request('GET', `${table}?${params.join('&')}`);
  }

  async fetchAll(table, opts) {
    const limit = opts.limit && opts.limit < 1000 ? Number(opts.limit) : 1000;
    const max = opts.limit ? Number(opts.limit) : Infinity;
    const rows = [];
    for (let offset = 0; rows.length < max; offset += limit) {
      const page = await this.fetchPage(table, { ...opts, limit: Math.min(limit, max - rows.length), offset });
      rows.push(...page);
      if (page.length < limit) break;
    }
    return rows;
  }
}

export async function generateGeminiEmbedding(text, { apiKey, dimension = 768, taskType }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is required for embedding');
  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text: truncate(text, 8000) }] },
      outputDimensionality: dimension,
      ...(taskType ? { taskType } : {}),
    }),
    signal: AbortSignal.timeout(Number(process.env.MEMORY_EMBED_TIMEOUT_MS || 45000)),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Gemini embedding failed: ${res.status} ${truncate(JSON.stringify(json), 700)}`);
  }
  const values = json?.embedding?.values;
  if (!Array.isArray(values) || values.length !== dimension) {
    throw new Error(`Gemini embedding returned invalid vector: ${truncate(JSON.stringify(json), 700)}`);
  }
  return values;
}

export async function callCodexJson(prompt, {
  system = 'Return valid JSON only.',
  timeoutMs = Number(process.env.MEMORY_LLM_TIMEOUT_MS || process.env.MEMORY_CODEX_TIMEOUT_MS || 90000),
} = {}) {
  const promptFile = join(PROJECT_ROOT, 'tmp', `memory-json-prompt-${process.pid}.txt`);
  await mkdir(dirname(promptFile), { recursive: true });
  await writeFile(promptFile, `${system}\n\n${prompt}`, 'utf-8');
  try {
    const { stdout } = await execFileAsync(
      'bash',
      [join(SCRIPT_DIR, 'run-external-llm.sh'), 'memory-json', '-p', promptFile],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      }
    );
    return parseJsonObject(stdout);
  } finally {
    await unlink(promptFile).catch(() => {});
  }
}

export function parseJsonObject(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`No JSON object found: ${truncate(trimmed, 500)}`);
    return JSON.parse(match[0]);
  }
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function vectorLiteral(values) {
  return `[${values.map((value) => Number(value).toFixed(8)).join(',')}]`;
}

export function splitSourceList(value) {
  const raw = value || 'all';
  return String(raw).split(',').map((item) => item.trim()).filter(Boolean);
}

export function truncate(text, max = 1000) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

export function nonEmptyJoin(parts, separator = '\n') {
  return parts
    .flatMap((part) => Array.isArray(part) ? part : [part])
    .filter((part) => part !== null && part !== undefined && String(part).trim() !== '')
    .map((part) => typeof part === 'string' ? part : JSON.stringify(part))
    .join(separator);
}

export async function logJsonl(filePath, event, data = {}) {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`);
}

export function uri(value) {
  return encodeURIComponent(String(value));
}
