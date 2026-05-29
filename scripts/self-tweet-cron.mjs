#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const provider = process.env.HERMES_INFERENCE_PROVIDER || 'xai';
const model = process.env.HERMES_INFERENCE_MODEL || 'grok-3-mini';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: new URL('..', import.meta.url).pathname,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 8,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
    if (fenced) return JSON.parse(fenced[1]);
    const array = text.match(/\[[\s\S]*\]/u);
    if (array) return JSON.parse(array[0]);
    throw new Error(`Hermes did not return JSON: ${text.slice(0, 500)}`);
  }
}

function cli(args) {
  return run(process.execPath, ['scripts/nikechan-x.mjs', ...args]);
}

const state = parseJson(cli(['state', '--json']));
if (state.pending) {
  cli(['notify-pending', '--json']);
  console.log(state.pending.id);
  process.exit(0);
}

const context = parseJson(cli(['context', '--source-mode', 'auto', '--json']));
const prompt = `AIニケちゃんのXセルフツイート候補を2件作ってください。
次のcontextだけを使い、公開して問題ない内容に限定してください。
secret、内部ログ、未公開作業、privateな人物文脈は絶対に含めないでください。
出力はJSON配列だけにしてください。説明文やMarkdownは禁止です。
各要素は {"text":"投稿本文","reason":"狙い","sourceRefs":[{"type":"memory","label":"短い根拠"}]} の形にしてください。

context:
${JSON.stringify(context).slice(0, 12000)}`;

const raw = run('python3', [
  '-m',
  'hermes_cli.main',
  '--provider',
  provider,
  '-m',
  model,
  '--ignore-rules',
  '-z',
  prompt,
]);
const candidates = parseJson(raw);
if (!Array.isArray(candidates) || candidates.length === 0) {
  throw new Error('Hermes returned no candidates');
}

cli(['propose', '--source-mode', context.sourceMode || 'presence', '--candidates-json', JSON.stringify(candidates)]);
cli(['notify-pending', '--json']);
const nextState = parseJson(cli(['state', '--json']));
console.log(nextState.pending?.id || 'pending-created');
