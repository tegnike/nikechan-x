import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const objectSchema = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
export const stringSchema = { type: 'string' };
export const stringsSchema = { type: 'array', items: stringSchema };

export function classifyModelFailure(diagnostic, timedOut = false) {
  if (timedOut) return 'model_timeout';
  if (/context window|too many tokens|maximum context/i.test(diagnostic)) return 'model_input_too_large';
  if (/usage limit|rate.limit|quota|credit|usage.*reset|429/i.test(diagnostic)) return 'model_usage_limit';
  if (/unauthorized|authentication|token.*expired|401|403/i.test(diagnostic)) return 'model_authentication';
  if (/certificate|connection|network|stream.*closed|timed out|502|503|504/i.test(diagnostic)) return 'model_network';
  return 'model_execution_failed';
}

// Each inference is ephemeral, tool-free, and sees only its explicit input.
// Do not use run-external-llm.sh: its error path can notify Discord.
export function createModel({ directory, model = 'gpt-6.1-sol', effort = 'medium', timeoutMs = 180000 }) {
  const pending = new Map();
  const invoke = async (stage, instructions, input, schema) => {
    const key = digest({ version: 1, stage, instructions, input, schema, model, effort });
    const cacheDir = resolve(directory, 'cache');
    await mkdir(cacheDir, { recursive: true });
    const cacheFile = join(cacheDir, `${key}.json`);
    try { return { ...JSON.parse(await readFile(cacheFile, 'utf8')), cached: true }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const work = resolve(directory, 'calls', `${stage}-${randomUUID()}`);
    await mkdir(work, { recursive: true });
    await writeFile(join(work, 'instructions.md'), instructions);
    await writeFile(join(work, 'schema.json'), JSON.stringify(schema));
    await writeFile(join(work, 'input.json'), JSON.stringify(input, null, 2));
    const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--sandbox', 'read-only',
      '--skip-git-repo-check', '--cd', work, '--model', model, '--json',
      '--output-schema', join(work, 'schema.json'), '--output-last-message', join(work, 'answer.json'),
      '-c', `model_reasoning_effort=${JSON.stringify(effort)}`, '-c', 'project_doc_max_bytes=0',
      '-c', 'web_search="disabled"',
      '-c', `model_instructions_file=${JSON.stringify(join(work, 'instructions.md'))}`];
    for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'memories', 'hooks',
      'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'chronicle', 'goals', 'code_mode']) {
      args.push('--disable', feature);
    }
    args.push('-');
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(HOME|PATH|USER|LOGNAME|SHELL|LANG|LC_.*|TMPDIR|CODEX_HOME)$/.test(key)));
    const started = performance.now();
    let usage = null;
    await new Promise((resolveRun, reject) => {
      const child = spawn('codex', args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      let events = '', diagnostic = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
      child.stdout.on('data', chunk => { events += chunk; });
      child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-5000); });
      child.on('error', error => { clearTimeout(timer); error.code = 'model_process_unavailable'; reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) return reject(Object.assign(new Error(`Codex ${stage} failed (exit ${code}); ${diagnostic.slice(-1500)}`), { code: classifyModelFailure(diagnostic, timedOut) }));
        const items = events.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
        const forbidden = items.some(event => event.item && !['reasoning', 'agent_message'].includes(event.item.type));
        if (forbidden) return reject(new Error(`Unexpected tool/event item in tool-free ${stage} inference`));
        usage = items.find(event => event.type === 'turn.completed')?.usage || null;
        resolveRun();
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
    });
    const value = JSON.parse(await readFile(join(work, 'answer.json'), 'utf8'));
    const result = { value, cached: false, duration_ms: Math.round(performance.now() - started), usage, model, effort, prompt_hash: key };
    await writeFile(cacheFile, JSON.stringify(result, null, 2));
    return result;
  };
  // Identical concurrent requests must share one sample and one cache write.
  return (stage, instructions, input, schema) => {
    const key = digest({ stage, instructions, input, schema });
    if (!pending.has(key)) pending.set(key, invoke(stage, instructions, input, schema));
    return pending.get(key);
  };
}
