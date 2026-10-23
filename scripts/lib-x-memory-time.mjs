import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveMemoryTime } from './lib-memory-time.mjs';

// Uses the X profile's existing Codex OAuth helper. No new provider or credential.
// The helper is a fixed trusted executable; post text is sent on stdin, never a shell command.
export function createXMemoryTimeResolver({ python = 'python3', helper = fileURLToPath(new URL('./x-memory-codex-model.py', import.meta.url)),
  model = 'gpt-6-luna', timezone = 'Europe/Warsaw', recentDays = 7, timeoutMs = 8000, hermesHome, generate } = {}) {
  const request = generate ?? ((prompt, schema) => new Promise((resolve, reject) => {
    const child = spawn(python, [helper], { stdio: ['pipe', 'pipe', 'pipe'],
      ...(hermesHome ? { env: { ...process.env, HERMES_HOME: hermesHome } } : {}) });
    let output = '', settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { child.kill('SIGKILL'); reject(error); } else resolve(result);
    };
    const timer = setTimeout(() => finish(Error('time_interpretation_timeout')), timeoutMs);
    child.once('error', () => finish(Error('time_interpretation_unavailable')));
    child.stdout.on('data', data => {
      output += data.toString();
      if (Buffer.byteLength(output) > 128 * 1024) finish(Error('time_interpretation_invalid'));
    });
    child.stderr.resume();
    child.once('exit', code => {
      if (code !== 0) { finish(Error('time_interpretation_unavailable')); return; }
      try {
        const result = JSON.parse(output);
        if (result.error || !result.value) throw Error('invalid');
        finish(null, JSON.stringify(result.value));
      } catch { finish(Error('time_interpretation_invalid')); }
    });
    child.stdin.on('error', () => finish(Error('time_interpretation_unavailable')));
    child.stdin.end(JSON.stringify({ model, effort: 'low',
      instructions: 'Interpret the requested memory search period. Return only JSON following the schema. Do not use tools.',
      input: { request: prompt }, schema }));
  }));
  // Candidate material is built in parallel: bound model processes and queue wait.
  let active = 0;
  const waiting = [];
  const limited = async (prompt, schema) => {
    if (active >= 2) {
      if (waiting.length >= 16) throw Error('time_interpretation_busy');
      await new Promise((resolve, reject) => {
        const item = { start: () => { clearTimeout(timer); resolve(); } };
        const timer = setTimeout(() => {
          const index = waiting.indexOf(item); if (index >= 0) waiting.splice(index, 1);
          reject(Error('time_interpretation_busy'));
        }, timeoutMs);
        waiting.push(item);
      });
    } else active++;
    try { return await request(prompt, schema); }
    finally { const next = waiting.shift(); if (next) next.start(); else active--; }
  };
  return async query => await resolveMemoryTime(query, { generate: limited, timezone, recentDays });
}
