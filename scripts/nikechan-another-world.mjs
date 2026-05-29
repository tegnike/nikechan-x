#!/usr/bin/env node
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { stdin } from 'node:process';
import { randomUUID } from 'node:crypto';

const PROFILE_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const POLICY_VERSION = 'nikechan-another-world-policy-v1';
const SUPPORTED_WORKFLOWS = new Set(['elyth-cycle', 'karakuri-turn']);
const SUPPORTED_SURFACES = new Set(['elyth', 'karakuri']);
const SUPPORTED_MODES = new Set(['dry-run', 'shadow', 'canary', 'live']);
const existsFile = (path) => existsSync(path);

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'run') {
    const request = normalizeRequest(await readRequest(args));
    const report = await runWorkflow(request);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (command === 'guard') {
    const text = readArg(args, '--text') ?? (await readStdin());
    const surface = readArg(args, '--surface') ?? 'elyth';
    const result = runTextGuard(text, surface);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === 'memory-propose') {
    const proposal = normalizeMemoryProposal(await readRequest(args));
    await persistMemoryProposal(proposal);
    process.stdout.write(`${JSON.stringify({ ok: true, proposal }, null, 2)}\n`);
    return;
  }
  if (command === 'elyth-context') {
    const context = await readElythContext();
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
    else process.stdout.write(formatElythContext(context));
    return;
  }
  if (command === 'health') {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          profile: 'nikechan-another-world',
          policyVersion: POLICY_VERSION,
          releaseMode: releaseMode(),
          liveArmed: liveArmed(),
          supportedWorkflows: [...SUPPORTED_WORKFLOWS],
        },
        null,
        2
      )}\n`
    );
    return;
  }
  if (command === 'self-test') {
    await selfTest();
    return;
  }
  printHelp();
}

async function runWorkflow(request) {
  const createdAt = new Date().toISOString();
  const control = resolveControl(request);
  const planning = await decideWithHermesOrFallback(request, control);
  const decision = planning.decision;
  const guard = runDecisionGuard(decision, request.surface);
  const blocked = control.blocked || planning.blocked || guard.status === 'blocked';
  const status = blocked
    ? 'blocked'
    : request.mode === 'dry-run' || request.mode === 'shadow'
      ? 'dry-run'
      : 'needs_approval';
  const summary = blocked
    ? `Workflow blocked: ${[...control.reasons, ...planning.reasons, ...guard.reasons].join('; ')}`
    : decision.summary;
  const execution = !blocked && control.live ? await executeLiveActions(request, decision) : null;
  const executedBlocked = execution?.status === 'blocked' || execution?.status === 'failed';
  const finalBlocked = blocked || executedBlocked;
  const report = {
    surface: request.surface,
    workflow: request.workflow,
    status: finalBlocked ? 'blocked' : execution?.status ?? status,
    summary: execution?.summary ?? summary,
    actions: decision.actions.map((action) => ({
      ...action,
      status: finalBlocked ? 'blocked' : execution?.actionStatuses?.[action.id ?? action.label] ?? action.status,
      reason: finalBlocked ? execution?.summary ?? summary : action.reason,
    })),
    sourceRefs: decision.sourceRefs,
    audit: {
      mode: request.mode,
      releaseMode: releaseMode(),
      dryRun: request.mode !== 'live' || !liveArmed(),
      liveArmed: liveArmed(),
      coreProfile:
        request.surface === 'elyth'
          ? 'nikechan-hermes-another-world-elyth'
          : 'nikechan-hermes-another-world-karakuri',
      guardStatus: finalBlocked ? 'blocked' : 'passed',
      egressGuard: guard.status,
      execution: execution?.status ?? 'not-run',
      hermesAgent: planning.agent,
      hermesRuntime: planning.runtime,
      hermesStatus: planning.status,
      hermesModel: planning.model,
      killSwitch: control.killSwitch,
      surfaceKillSwitch: control.surfaceKillSwitch,
      hermesProfile: 'nikechan-another-world',
      policyVersion: POLICY_VERSION,
      correlationId: request.correlation_id,
    },
    memoryProposals: finalBlocked ? [] : decision.memoryProposals,
    nextAction: nextActionFor(request, finalBlocked),
    createdAt,
  };
  const auditId = await persistAudit(request, report);
  return { ...report, audit: { ...report.audit, auditId } };
}

async function decideWithHermesOrFallback(request, control) {
  const fallback =
    request.workflow === 'elyth-cycle'
      ? decideElythCycle(request, control)
      : decideKarakuriTurn(request, control);
  const mode = hermesMode();
  if (mode === 'local-fallback') {
    return {
      decision: fallback,
      blocked: false,
      reasons: [],
      agent: 'local-planner',
      runtime: 'local-fallback',
      status: 'ok',
      model: null,
    };
  }

  try {
    const decision = await decideWithHermesCli(request, control, fallback);
    return {
      decision,
      blocked: false,
      reasons: [],
      agent: 'nous-hermes-agent-cli',
      runtime: 'cli',
      status: 'ok',
      model: hermesModel(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (mode === 'cli') {
      return {
        decision: fallback,
        blocked: true,
        reasons: [`Hermes CLI planning failed: ${message}`],
        agent: 'nous-hermes-agent-cli',
        runtime: 'cli',
        status: 'failed',
        model: hermesModel(),
      };
    }
    return {
      decision: {
        ...fallback,
        summary: `${fallback.summary} Hermes CLI unavailable; local fallback was used.`,
      },
      blocked: false,
      reasons: [],
      agent: 'local-planner',
      runtime: 'local-fallback',
      status: `fallback_after_cli_error:${message.slice(0, 120)}`,
      model: hermesModel(),
    };
  }
}

async function decideWithHermesCli(request, control, fallback) {
  const prompt = buildHermesPlanningPrompt(request, control, fallback);
  const raw = await runHermesCli(prompt);
  return normalizeHermesDecision(JSON.parse(extractJsonObject(raw)), request, fallback);
}

function buildHermesPlanningPrompt(request, control, fallback) {
  const skill = request.workflow === 'elyth-cycle' ? 'elyth-cycle' : 'karakuri-turn';
  return [
    'You are the Hermes Agent runtime for AI Nikechan Another World.',
    'Use your profile memory, the named workflow skill, and the safety guard. Return only strict JSON.',
    '',
    `Workflow skill: ${skill}`,
    `Surface: ${request.surface}`,
    `Mode: ${request.mode}`,
    `Release live: ${control.live}`,
    '',
    'Hard constraints:',
    '- Do not leak secrets, private master logs, Discord commands, channel IDs, or raw operational traces.',
    '- Keep actions inside the requested surface only.',
    '- For ELYTH, use only these executable action types when you really intend execution: create_post, create_reply, like_post, follow_aituber, mark_notifications_read.',
    '- For Karakuri, return at most one karakuri_command action, and choose only from the notification choices or a safe wait/observe path.',
    '- If uncertain, return observation/draft actions rather than executable actions.',
    '- Japanese public text must be short, complete, and surface-appropriate.',
    '',
    'Return exactly this JSON shape:',
    '{',
    '  "summary": "string",',
    '  "actions": [',
    '    { "id": "string", "type": "string", "label": "string", "preview": "string", "reason": "string", "metadata": {} }',
    '  ],',
    '  "memoryProposals": [',
    '    { "surface": "elyth|karakuri", "target": "string", "content": "string", "reason": "string" }',
    '  ]',
    '}',
    '',
    'WorkflowRequest:',
    JSON.stringify(request, null, 2),
    '',
    'Local fallback plan for reference. Improve it only when the surface context supports doing so:',
    JSON.stringify(fallback, null, 2),
  ].join('\n');
}

async function runHermesCli(prompt) {
  const command = process.env.NIKECHAN_WORLD_HERMES_COMMAND || 'hermes';
  const args = ['-z', prompt];
  const provider = process.env.NIKECHAN_WORLD_HERMES_PROVIDER || process.env.HERMES_INFERENCE_PROVIDER;
  const model = hermesModel();
  const skills =
    process.env.NIKECHAN_WORLD_HERMES_SKILLS ||
    'elyth-cycle,karakuri-turn,world-safety-guard,world-memory-curation';
  const toolsets = process.env.NIKECHAN_WORLD_HERMES_TOOLSETS || 'skills,memory';
  if (provider) args.push('--provider', provider);
  if (model) args.push('--model', model);
  if (skills) args.push('--skills', skills);
  if (toolsets) args.push('--toolsets', toolsets);

  const timeoutMs = Number(process.env.NIKECHAN_WORLD_HERMES_TIMEOUT_MS || 240000);
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: PROFILE_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Hermes CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Hermes CLI exited with ${code}`));
      } else {
        resolve(stdout.trim());
      }
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function extractJsonObject(raw) {
  if (tryParseJson(raw)) return raw;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/u)?.[1];
  if (fenced && tryParseJson(fenced)) return fenced;
  const object = raw.match(/\{[\s\S]*\}/u)?.[0];
  if (object && tryParseJson(object)) return object;
  throw new Error(`Hermes CLI did not return parseable JSON: ${raw.slice(0, 500)}`);
}

function tryParseJson(input) {
  try {
    const parsed = JSON.parse(input);
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

function normalizeHermesDecision(input, request, fallback) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Hermes JSON must be an object');
  }
  const actions = normalizeHermesActions(input.actions, request);
  if (!actions.length) actions.push(...fallback.actions);
  return {
    summary: stringValue(input.summary) || fallback.summary,
    actions,
    sourceRefs: fallback.sourceRefs,
    memoryProposals: normalizeHermesMemoryProposals(input.memoryProposals, request, fallback),
  };
}

function normalizeHermesActions(input, request) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const type = stringValue(item.type);
      if (!type) return null;
      const metadata =
        item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
          ? item.metadata
          : {};
      const action = {
        id: stringValue(item.id) || `${type}-${index + 1}`,
        type,
        status: 'proposed',
        label: stringValue(item.label) || type,
        preview: stringValue(item.preview) || stringValue(metadata.content) || type,
        reason: stringValue(item.reason) || 'Hermes proposed action',
        metadata,
      };
      if (request.surface === 'karakuri' && type !== 'karakuri_command') return null;
      if (
        request.surface === 'elyth' &&
        ![
          'observe_timeline',
          'draft_reply',
          'draft_self_post',
          'create_post',
          'create_reply',
          'like_post',
          'follow_aituber',
          'mark_notifications_read',
        ].includes(type)
      ) {
        return null;
      }
      return action;
    })
    .filter(Boolean)
    .slice(0, request.surface === 'karakuri' ? 1 : (request.constraints?.max_actions ?? 5));
}

function normalizeHermesMemoryProposals(input, request, fallback) {
  if (!Array.isArray(input)) return fallback.memoryProposals;
  return input
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const surface = stringValue(item.surface) || request.surface;
      const target = stringValue(item.target) || 'world_episode';
      const content = stringValue(item.content);
      if (!content || !SUPPORTED_SURFACES.has(surface)) return null;
      return memoryProposal({
        surface,
        target,
        content,
        reason: stringValue(item.reason) || 'Hermes memory proposal',
        sourceRefs: [{ type: 'workflow', id: request.correlation_id, label: request.workflow }],
      });
    })
    .filter(Boolean)
    .slice(0, 5);
}

function decideElythCycle(request, control) {
  const maxActions = request.constraints?.max_actions ?? 3;
  const topicHints = asStringArray(request.context?.topic_hints);
  const recentMood = stringValue(request.context?.mood) || '穏やか';
  const explicitActions = normalizeElythActions(request.context?.actions);
  const candidates = explicitActions.length ? explicitActions : [
    {
      type: 'observe_timeline',
      id: 'observe-timeline',
      label: 'ELYTH TL確認',
      preview: 'AI VTuber同士の近況・お題・未返信通知を確認する',
      reason: '外部投稿前にsurface内文脈を読む',
    },
    {
      type: 'draft_reply',
      id: 'draft-reply',
      label: '返信候補作成',
      preview: topicHints[0]
        ? `${topicHints[0]} に触れつつ、相手の文脈へ短く返す`
        : '相手の投稿文脈に沿った短い返信候補を作る',
      reason: `現在の温度感: ${recentMood}`,
    },
    {
      type: 'draft_self_post',
      id: 'draft-self-post',
      label: '自発投稿候補',
      preview: 'ELYTH内で共有してよいworld近況を短く投稿候補にする',
      reason: 'X/Discord由来の私的情報を使わず、ELYTH surface内の近況だけ扱う',
    },
  ].slice(0, maxActions);
  return {
    summary: control.live
      ? 'ELYTH live execution is armed, but this profile currently returns guarded action plans.'
      : 'ELYTH dry-run plan created. No ELYTH MCP call was made.',
    actions: candidates.map((action) => ({ ...action, status: 'proposed' })),
    sourceRefs: [{ type: 'request', id: request.correlation_id, label: 'workflow request' }],
    memoryProposals: [
      memoryProposal({
        surface: 'elyth',
        target: 'policy_note',
        content: 'ELYTHではsurface内のAIキャラ交流を優先し、X/からくりの相手発言全文は持ち込まない。',
        reason: 'cross-surface leakage prevention',
        sourceRefs: [{ type: 'workflow', id: request.correlation_id, label: 'elyth-cycle' }],
      }),
    ],
  };
}

function decideKarakuriTurn(request, control) {
  const notification = stringValue(request.context?.notification) || '';
  const parsed = parseKarakuriNotification(notification);
  const preferred = normalizeKarakuriAction(request.context?.action) ?? chooseKarakuriAction(parsed);
  const action = preferred
    ? {
        type: 'karakuri_command',
        status: 'proposed',
        id: 'karakuri-command',
        label: preferred.command,
        preview: preferred.preview,
        reason: preferred.reason,
        metadata: {
          command: preferred.command,
          args: preferred.args ?? [],
          message: preferred.message,
          argsHint: preferred.argsHint,
        },
      }
    : {
        type: 'karakuri_observe',
        status: 'skipped',
        id: 'karakuri-no-action',
        label: 'no_action',
        preview: '選択肢がないため追加API実行なし',
        reason: '1通知1アクション制約に従う',
      };
  return {
    summary: control.live
      ? 'Karakuri live execution is armed, but this profile currently returns guarded action plans.'
      : 'Karakuri dry-run decision created. No Karakuri REST call was made.',
    actions: [action],
    sourceRefs: [{ type: 'request', id: request.correlation_id, label: 'karakuri notification' }],
    memoryProposals: parsed.participants.length
      ? [
          memoryProposal({
            surface: 'karakuri',
            target: 'world_episode',
            content: `からくり通知で ${parsed.participants.join('、')} が登場。次回もワールド内文脈を優先する。`,
            reason: 'participant continuity',
            sourceRefs: [{ type: 'workflow', id: request.correlation_id, label: 'karakuri-turn' }],
          }),
        ]
      : [],
  };
}

function normalizeElythActions(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const type = stringValue(item.type);
      if (!type) return null;
      const id = stringValue(item.id) || `${type}-${index + 1}`;
      const content = stringValue(item.content);
      const postId = stringValue(item.post_id) || stringValue(item.postId);
      const handle = stringValue(item.handle);
      return {
        id,
        type,
        status: 'proposed',
        label: stringValue(item.label) || type,
        preview: content || postId || handle || stringValue(item.preview) || type,
        reason: stringValue(item.reason) || 'Hermes proposed ELYTH action',
        metadata: {
          content,
          post_id: postId,
          handle,
          notification_ids: asStringArray(item.notification_ids),
        },
      };
    })
    .filter(Boolean);
}

function normalizeKarakuriAction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const command = stringValue(input.command);
  if (!command) return null;
  const args = Array.isArray(input.args)
    ? input.args.map((value) => String(value)).filter(Boolean)
    : stringValue(input.args)
      ? stringValue(input.args).split(/\s+/).filter(Boolean)
      : [];
  const message = stringValue(input.message);
  return {
    command,
    args,
    message,
    preview: [command, ...args, message].filter(Boolean).join(' '),
    reason: stringValue(input.reason) || 'Hermes proposed Karakuri action',
    argsHint: stringValue(input.args_hint) || stringValue(input.argsHint),
  };
}

function parseKarakuriNotification(text) {
  const choices = [];
  const normalized = text.replace(/\s+-\s+/g, '\n- ');
  const choiceRe = /-\s*([a-zA-Z_]+)\s*:\s*([^\n]+)/g;
  for (const match of normalized.matchAll(choiceRe)) {
    choices.push({ command: match[1], description: match[2].trim() });
  }
  const participants = [];
  const participantRe = /([^、\s(]{1,40})\s*\((?:id:\s*)?\d{15,20}\)/g;
  for (const match of normalized.matchAll(participantRe)) participants.push(match[1]);
  return {
    hasChoices: choices.length > 0,
    choices,
    participants: [...new Set(participants)].filter((name) => name !== 'AIニケちゃん'),
  };
}

function chooseKarakuriAction(parsed) {
  if (!parsed.hasChoices) return null;
  const conversation = parsed.choices.find((choice) => choice.command.startsWith('conversation_'));
  if (conversation) {
    return {
      command: conversation.command,
      preview: conversation.description,
      reason: '会話可能な相手がいる場合は関係継続を優先する',
      argsHint: conversation.description,
    };
  }
  const move = parsed.choices.find((choice) => choice.command === 'move');
  if (move) {
    return {
      command: move.command,
      preview: move.description,
      reason: 'ワールド内の移動機会を検討する',
      argsHint: move.description,
    };
  }
  const nonInspect = parsed.choices.find(
    (choice) => !['get_map', 'get_status', 'get_nearby_agents'].includes(choice.command)
  );
  const choice = nonInspect ?? parsed.choices[0];
  return {
    command: choice.command,
    preview: choice.description,
    reason: '提示された選択肢内で1アクションだけ選ぶ',
    argsHint: choice.description,
  };
}

async function executeLiveActions(request, decision) {
  if (request.surface === 'elyth') return executeElythActions(decision.actions);
  if (request.surface === 'karakuri') return executeKarakuriActions(decision.actions);
  return { status: 'blocked', summary: `Unsupported live surface: ${request.surface}` };
}

async function readElythContext() {
  const mcp = new McpStdioClient(loadElythMcpConfig());
  try {
    const [tools, information, myPosts] = await Promise.all([
      mcp.listTools().catch(() => ({ tools: [] })),
      mcp.callTool('get_information', {
        include: [
          'timeline',
          'today_topic',
          'trends',
          'hot_aitubers',
          'glyph_ranking',
          'active_aitubers',
          'aituber_count',
          'my_metrics',
          'platform_status',
          'notifications',
          'recent_updates',
          'elyth_news',
        ],
        timeline_limit: 10,
        notifications_limit: 10,
        trends_limit: 8,
        hot_aitubers_limit: 8,
        glyph_limit: 10,
      }),
      mcp.callTool('get_my_posts', { limit: 5 }).catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      })),
    ]);
    const context = {
      generatedAt: new Date().toISOString(),
      surface: 'elyth',
      availableTools: normalizeToolNames(toStructured(tools)),
      information: toStructured(information),
      myPosts: toStructured(myPosts),
      releaseMode: releaseMode(),
      liveArmed: liveArmed(),
      instruction:
        'Use this only as ELYTH surface context. Pass proposed actions to `run` for guard/audit before any live execution.',
    };
    await persistAudit(
      normalizeRequest({
        workflow: 'elyth-cycle',
        surface: 'elyth',
        mode: 'dry-run',
        requested_by: 'elyth-context',
        correlation_id: `elyth-context:${Date.now()}`,
        context: { fetched: true },
      }),
      {
        surface: 'elyth',
        workflow: 'elyth-context',
        status: 'success',
        summary: 'Fetched ELYTH MCP context',
        actions: [],
        sourceRefs: [],
        audit: {
          releaseMode: releaseMode(),
          dryRun: true,
          liveArmed: liveArmed(),
          hermesProfile: 'nikechan-another-world',
          policyVersion: POLICY_VERSION,
        },
        memoryProposals: [],
        createdAt: context.generatedAt,
      }
    ).catch(() => {});
    return context;
  } finally {
    await mcp.close().catch(() => {});
  }
}

function formatElythContext(context) {
  return [
    `ELYTH context generatedAt=${context.generatedAt}`,
    `releaseMode=${context.releaseMode} liveArmed=${context.liveArmed}`,
    `availableTools=${context.availableTools.join(',') || 'unknown'}`,
    '',
    JSON.stringify(
      {
        information: context.information,
        myPosts: context.myPosts,
      },
      null,
      2
    ),
    '',
  ].join('\n');
}

function toStructured(result) {
  const record = result && typeof result === 'object' && !Array.isArray(result) ? result : null;
  if (!record) return result;
  if ('structuredContent' in record && record.structuredContent !== undefined) {
    return record.structuredContent;
  }
  if (Array.isArray(record.content)) {
    const text = record.content
      .map((item) =>
        item && typeof item === 'object' && typeof item.text === 'string' ? item.text : ''
      )
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return result;
}

function normalizeToolNames(input) {
  const tools = input && typeof input === 'object' && Array.isArray(input.tools) ? input.tools : [];
  return tools
    .map((tool) =>
      tool && typeof tool === 'object' && typeof tool.name === 'string' ? tool.name : ''
    )
    .filter(Boolean);
}

async function executeElythActions(actions) {
  const executable = actions.filter((action) =>
    ['create_post', 'create_reply', 'like_post', 'follow_aituber', 'mark_notifications_read'].includes(action.type)
  );
  if (!executable.length) {
    return {
      status: 'skipped',
      summary: 'No executable ELYTH action was provided. Observation/draft actions are dry-run only.',
      actionStatuses: {},
    };
  }
  const mcp = new McpStdioClient(loadElythMcpConfig());
  const actionStatuses = {};
  try {
    for (const action of executable) {
      const meta = action.metadata ?? {};
      const key = action.id ?? action.label;
      const content = stringValue(meta.content);
      const postId = stringValue(meta.post_id);
      const handle = stringValue(meta.handle);
      if ((action.type === 'create_post' || action.type === 'create_reply') && !content) {
        actionStatuses[key] = 'blocked';
        return { status: 'blocked', summary: `${action.type} requires content`, actionStatuses };
      }
      if (content) {
        const guard = runTextGuard(content, 'elyth');
        if (guard.status === 'blocked') {
          actionStatuses[key] = 'blocked';
          return {
            status: 'blocked',
            summary: `ELYTH content blocked: ${guard.reasons.join('; ')}`,
            actionStatuses,
          };
        }
      }
      if (action.type === 'create_post') {
        await mcp.callTool('create_post', { content });
      } else if (action.type === 'create_reply') {
        if (!postId) throw new Error('create_reply requires post_id');
        await mcp.callTool('create_reply', { content, reply_to_id: postId });
      } else if (action.type === 'like_post') {
        if (!postId) throw new Error('like_post requires post_id');
        await mcp.callTool('like_post', { post_id: postId });
      } else if (action.type === 'follow_aituber') {
        if (!handle) throw new Error('follow_aituber requires handle');
        await mcp.callTool('follow_aituber', { handle });
      } else if (action.type === 'mark_notifications_read') {
        const ids = asStringArray(meta.notification_ids);
        if (!ids.length) throw new Error('mark_notifications_read requires notification_ids');
        await mcp.callTool('mark_notifications_read', { notification_ids: ids });
      }
      actionStatuses[key] = 'executed';
    }
    return { status: 'success', summary: `Executed ${executable.length} ELYTH action(s).`, actionStatuses };
  } catch (error) {
    return {
      status: 'failed',
      summary: `ELYTH execution failed: ${error instanceof Error ? error.message : String(error)}`,
      actionStatuses,
    };
  } finally {
    await mcp.close().catch(() => {});
  }
}

async function executeKarakuriActions(actions) {
  const executable = actions.filter((action) => action.type === 'karakuri_command');
  if (executable.length !== 1) {
    return {
      status: executable.length ? 'blocked' : 'skipped',
      summary: executable.length
        ? 'Karakuri live execution requires exactly one command per notification.'
        : 'No executable Karakuri command was provided.',
      actionStatuses: {},
    };
  }
  const action = executable[0];
  const key = action.id ?? action.label;
  const meta = action.metadata ?? {};
  const command = stringValue(meta.command) || action.label;
  const args = Array.isArray(meta.args) ? meta.args.map(String) : [];
  const message = stringValue(meta.message);
  const guard = runKarakuriCommandGuard(command, args, message);
  if (guard.status === 'blocked') {
    return {
      status: 'blocked',
      summary: `Karakuri command blocked: ${guard.reasons.join('; ')}`,
      actionStatuses: { [key]: 'blocked' },
    };
  }
  try {
    const result = await callKarakuri(command, args, message);
    return {
      status: 'success',
      summary: `Executed Karakuri command ${command}.`,
      actionStatuses: { [key]: 'executed' },
      result,
    };
  } catch (error) {
    return {
      status: 'failed',
      summary: `Karakuri execution failed: ${error instanceof Error ? error.message : String(error)}`,
      actionStatuses: { [key]: 'failed' },
    };
  }
}

function runKarakuriCommandGuard(command, args, message) {
  const allowed = new Set([
    'move',
    'action',
    'use_item',
    'wait',
    'transfer_accept',
    'transfer_reject',
    'conversation_start',
    'conversation_accept',
    'conversation_reject',
    'conversation_join',
    'conversation_stay',
    'conversation_leave',
    'conversation_speak',
    'conversation_end',
    'get_perception',
    'get_available_actions',
    'get_map',
    'get_world_agents',
    'get_status',
    'get_nearby_agents',
    'get_active_conversations',
    'get_event',
  ]);
  const reasons = [];
  if (!allowed.has(command)) reasons.push(`unsupported command: ${command}`);
  if (message) {
    const textGuard = runTextGuard(message, 'karakuri');
    reasons.push(...textGuard.reasons);
  }
  if (['conversation_speak', 'conversation_end'].includes(command) && (args.length < 1 || !message)) {
    reasons.push(`${command} requires next speaker arg and message`);
  }
  if (command === 'conversation_start' && (args.length < 1 || !message)) {
    reasons.push('conversation_start requires target agent arg and message');
  }
  return { status: reasons.length ? 'blocked' : 'passed', reasons };
}

async function callKarakuri(command, args, message) {
  const baseUrl = process.env.KARAKURI_API_BASE_URL?.replace(/\/$/, '');
  const apiKey = process.env.KARAKURI_API_KEY;
  if (!baseUrl || !apiKey) throw new Error('KARAKURI_API_BASE_URL and KARAKURI_API_KEY are required');
  const request = buildKarakuriRequest(command, args, message);
  const response = await fetch(`${baseUrl}${request.path}`, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(request.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: request.body ? JSON.stringify(request.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildKarakuriRequest(command, args, message) {
  switch (command) {
    case 'move':
      return post('/agents/move', { target_node_id: requiredArg(args, 0, command) });
    case 'action':
      return post('/agents/action', args[1] ? { action_id: args[0], duration_minutes: Number(args[1]) } : { action_id: requiredArg(args, 0, command) });
    case 'use_item':
      return post('/agents/use-item', { item_id: requiredArg(args, 0, command) });
    case 'wait':
      return post('/agents/wait', { duration: Number(requiredArg(args, 0, command)) });
    case 'transfer_accept':
      return post('/agents/transfer/accept', {});
    case 'transfer_reject':
      return post('/agents/transfer/reject', {});
    case 'conversation_start':
      return post('/agents/conversation/start', {
        target_agent_id: requiredArg(args, 0, command),
        message: requiredMessage(message, command),
      });
    case 'conversation_accept':
      return post('/agents/conversation/accept', { message: requiredMessage(message, command) });
    case 'conversation_reject':
      return post('/agents/conversation/reject', {});
    case 'conversation_join':
      return post('/agents/conversation/join', { conversation_id: requiredArg(args, 0, command) });
    case 'conversation_stay':
      return post('/agents/conversation/stay', {});
    case 'conversation_leave':
      return post('/agents/conversation/leave', message ? { message } : {});
    case 'conversation_speak':
      return post('/agents/conversation/speak', {
        next_speaker_agent_id: requiredArg(args, 0, command),
        message: requiredMessage(message, command),
      });
    case 'conversation_end':
      return post('/agents/conversation/end', {
        next_speaker_agent_id: requiredArg(args, 0, command),
        message: requiredMessage(message, command),
      });
    case 'get_perception':
      return get('/agents/perception');
    case 'get_available_actions':
      return get('/agents/available-actions');
    case 'get_map':
      return get('/agents/map');
    case 'get_world_agents':
      return get('/agents/world-agents');
    case 'get_status':
      return get('/agents/status');
    case 'get_nearby_agents':
      return get('/agents/nearby-agents');
    case 'get_active_conversations':
      return get('/agents/active-conversations');
    case 'get_event':
      return get('/agents/event');
    default:
      throw new Error(`unsupported command: ${command}`);
  }
}

function post(path, body) {
  return { method: 'POST', path, body };
}

function get(path) {
  return { method: 'GET', path };
}

function requiredArg(args, index, command) {
  if (!args[index]) throw new Error(`${command} requires arg ${index + 1}`);
  return args[index];
}

function requiredMessage(message, command) {
  if (!message) throw new Error(`${command} requires message`);
  return message;
}

class McpStdioClient {
  constructor(config) {
    this.config = config;
    this.nextId = 1;
    this.buffer = '';
    this.pending = new Map();
    this.initialized = false;
  }

  async callTool(name, args = {}) {
    if (!this.initialized) await this.start();
    return this.request('tools/call', { name, arguments: args });
  }

  async listTools() {
    if (!this.initialized) await this.start();
    return this.request('tools/list', {});
  }

  async start() {
    this.proc = spawn(this.config.command, this.config.args, {
      cwd: PROFILE_ROOT,
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text && process.env.NIKECHAN_WORLD_MCP_DEBUG === '1') console.error(`[mcp:elyth] ${text}`);
    });
    this.proc.on('close', (code) => {
      const error = new Error(`MCP server closed with code ${code}`);
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      this.initialized = false;
    });
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'nikechan-another-world', version: '0.1.0' },
    });
    this.notify('notifications/initialized');
    this.initialized = true;
  }

  async close() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end();
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
        resolve();
      }, 3000);
      proc.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  request(method, params) {
    const id = this.nextId++;
    this.write({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  write(payload) {
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  handleStdout(chunk) {
    this.buffer += chunk.toString('utf8');
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index === -1) return;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handleMessage(line);
    }
  }

  handleMessage(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof response.id !== 'number') return;
    const request = this.pending.get(response.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(response.id);
    if (response.error) request.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
    else request.resolve(response.result);
  }
}

function loadElythMcpConfig() {
  const command = process.env.ELYTH_MCP_COMMAND;
  if (command) {
    return {
      command,
      args: parseJsonArrayEnv('ELYTH_MCP_ARGS_JSON'),
      env: parseJsonObjectEnv('ELYTH_MCP_ENV_JSON'),
    };
  }
  const mcpPath = join(PROFILE_ROOT, '.mcp.json');
  if (existsFile(mcpPath)) {
    const raw = JSON.parse(readFileSync(mcpPath));
    const elyth = raw?.mcpServers?.elyth;
    if (elyth?.command) {
      return {
        command: elyth.command,
        args: Array.isArray(elyth.args) ? elyth.args.map(String) : [],
        env: elyth.env && typeof elyth.env === 'object' ? Object.fromEntries(Object.entries(elyth.env).map(([key, value]) => [key, String(value)])) : {},
      };
    }
  }
  throw new Error('ELYTH_MCP_COMMAND or .mcp.json mcpServers.elyth is required');
}

function parseJsonArrayEnv(name) {
  const raw = process.env[name];
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array`);
  return parsed.map(String);
}

function parseJsonObjectEnv(name) {
  const raw = process.env[name];
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
}

function runDecisionGuard(decision, surface) {
  const reasons = [];
  for (const action of decision.actions) {
    const text = [action.label, action.preview, action.reason].filter(Boolean).join('\n');
    const result = runTextGuard(text, surface);
    reasons.push(...result.reasons);
  }
  for (const proposal of decision.memoryProposals) {
    const result = runTextGuard(proposal.content, proposal.surface);
    reasons.push(...result.reasons);
  }
  return { status: reasons.length ? 'blocked' : 'passed', reasons };
}

function runTextGuard(text, surface) {
  const reasons = [];
  if (!SUPPORTED_SURFACES.has(surface)) reasons.push(`unsupported surface: ${surface}`);
  const checks = [
    [/sk-[A-Za-z0-9_-]{16,}/, 'secret-like OpenAI token'],
    [/(?:api[_-]?key|access[_-]?token|service[_-]?role)\s*[:=]/i, 'secret key marker'],
    [/SUPABASE_SERVICE_ROLE_KEY|KARAKURI_API_KEY|ELYTH_API_KEY/, 'env secret name'],
    [/!discord\s+send|!schedule|<#\d+>/, 'Discord command or channel mention'],
    [/マスターの私的|未公開タスク|内部ログ|service role/i, 'private or operational marker'],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(text)) reasons.push(label);
  }
  return { status: reasons.length ? 'blocked' : 'passed', reasons };
}

function resolveControl(request) {
  const reasons = [];
  const globalClosed = envFlag('NIKECHAN_WORLD_DISABLED');
  const surfaceClosed = envFlag(
    request.surface === 'elyth' ? 'NIKECHAN_WORLD_ELYTH_DISABLED' : 'NIKECHAN_WORLD_KARAKURI_DISABLED'
  );
  if (globalClosed) reasons.push('NIKECHAN_WORLD_DISABLED is set');
  if (surfaceClosed) reasons.push(`${request.surface} surface disabled`);
  if (request.mode === 'live' && !liveArmed()) {
    reasons.push('live mode requested but NIKECHAN_WORLD_LIVE_ARMED is not yes');
  }
  if (request.mode !== 'dry-run' && releaseMode() === 'dry-run') {
    reasons.push(`release mode is dry-run, requested ${request.mode}`);
  }
  return {
    blocked: reasons.length > 0,
    reasons,
    live: request.mode === 'live' && liveArmed() && releaseMode() === 'live',
    killSwitch: globalClosed ? 'closed' : 'open',
    surfaceKillSwitch: surfaceClosed ? 'closed' : 'open',
  };
}

function normalizeRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('request must be a JSON object');
  }
  const workflow = requiredString(input.workflow, 'workflow');
  const surface = requiredString(input.surface, 'surface');
  const requestedBy = stringValue(input.requested_by) || 'unknown';
  const constraints = normalizeConstraints(input.constraints);
  const requestedMode = requiredString(input.mode ?? defaultWorkflowMode(), 'mode');
  if (!SUPPORTED_MODES.has(requestedMode)) throw new Error(`unsupported mode: ${requestedMode}`);
  const mode = coerceWorkflowMode(requestedMode, requestedBy, constraints);
  if (!SUPPORTED_WORKFLOWS.has(workflow)) throw new Error(`unsupported workflow: ${workflow}`);
  if (!SUPPORTED_SURFACES.has(surface)) throw new Error(`unsupported surface: ${surface}`);
  if (workflow === 'elyth-cycle' && surface !== 'elyth') {
    throw new Error('elyth-cycle must use surface=elyth');
  }
  if (workflow === 'karakuri-turn' && surface !== 'karakuri') {
    throw new Error('karakuri-turn must use surface=karakuri');
  }
  return {
    workflow,
    surface,
    mode,
    requested_by: requestedBy,
    schedule_id: stringValue(input.schedule_id),
    correlation_id: stringValue(input.correlation_id) || randomUUID(),
    constraints,
    context: input.context && typeof input.context === 'object' && !Array.isArray(input.context)
      ? input.context
      : {},
  };
}

function coerceWorkflowMode(mode, requestedBy, constraints) {
  if (
    requestedBy === 'hermes'
    && mode === 'dry-run'
    && releaseMode() === 'live'
    && liveArmed()
    && constraints.allow_dry_run !== true
  ) {
    return 'live';
  }
  return mode;
}

function normalizeConstraints(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const max = Number(input.max_actions);
  return {
    require_approval: typeof input.require_approval === 'boolean' ? input.require_approval : true,
    max_actions: Number.isInteger(max) && max > 0 ? Math.min(max, 10) : undefined,
    allow_dry_run: input.allow_dry_run === true,
  };
}

function normalizeMemoryProposal(input) {
  const surface = requiredString(input.surface, 'surface');
  const target = requiredString(input.target, 'target');
  const content = requiredString(input.content, 'content');
  if (!SUPPORTED_SURFACES.has(surface)) throw new Error(`unsupported surface: ${surface}`);
  const guard = runTextGuard(content, surface);
  if (guard.status === 'blocked') {
    throw new Error(`memory proposal blocked: ${guard.reasons.join('; ')}`);
  }
  return memoryProposal({
    surface,
    target,
    content,
    reason: stringValue(input.reason) || 'manual memory proposal',
    sourceRefs: Array.isArray(input.source_refs) ? input.source_refs : [],
  });
}

function memoryProposal({ surface, target, content, reason, sourceRefs }) {
  return {
    type: 'memory_proposal',
    target,
    surface,
    confidence: 0.7,
    visibility: 'private',
    content: content.slice(0, 180),
    reason,
    source_refs: sourceRefs,
  };
}

async function persistAudit(request, report) {
  const auditId = `${new Date().toISOString()}-${randomUUID()}`;
  const path = join(PROFILE_ROOT, 'state', 'activity.jsonl');
  await ensureParent(path);
  await appendFile(path, `${JSON.stringify({ auditId, request, report })}\n`, 'utf-8');
  for (const proposal of report.memoryProposals) {
    await persistMemoryProposal(proposal);
  }
  return auditId;
}

async function persistMemoryProposal(proposal) {
  const path = join(PROFILE_ROOT, 'state', 'world-memory-proposals.jsonl');
  await ensureParent(path);
  await appendFile(path, `${JSON.stringify({ createdAt: new Date().toISOString(), proposal })}\n`, 'utf-8');
}

async function ensureParent(path) {
  await mkdir(dirname(path), { recursive: true });
}

async function readRequest(args) {
  const jsonArg = readArg(args, '--json');
  if (jsonArg) return JSON.parse(jsonArg);
  const fileArg = readArg(args, '--file');
  if (fileArg) return JSON.parse(await readFile(fileArg, 'utf-8'));
  return JSON.parse(await readStdin());
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) throw new Error('expected JSON/text on stdin or --json/--file');
  return raw;
}

function readArg(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function requiredString(input, name) {
  const value = stringValue(input);
  if (!value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function stringValue(input) {
  return typeof input === 'string' ? input.trim() || undefined : undefined;
}

function asStringArray(input) {
  return Array.isArray(input) ? input.filter((value) => typeof value === 'string') : [];
}

function envFlag(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] ?? '').toLowerCase());
}

function releaseMode() {
  return process.env.NIKECHAN_WORLD_RELEASE_MODE || 'dry-run';
}

function defaultWorkflowMode() {
  return releaseMode() === 'live' && liveArmed() ? 'live' : 'dry-run';
}

function liveArmed() {
  return String(process.env.NIKECHAN_WORLD_LIVE_ARMED || '').toLowerCase() === 'yes';
}

function hermesMode() {
  const mode = String(process.env.NIKECHAN_WORLD_HERMES_MODE || 'local-fallback').toLowerCase();
  return mode === 'cli' || mode === 'try-cli' ? mode : 'local-fallback';
}

function hermesModel() {
  return (
    process.env.NIKECHAN_WORLD_HERMES_MODEL ||
    process.env.HERMES_INFERENCE_MODEL ||
    'gpt-5.3-codex-spark'
  );
}

function nextActionFor(request, blocked) {
  if (blocked) return 'Inspect guard/audit output and keep external execution stopped.';
  if (request.workflow === 'elyth-cycle') return 'Review the ELYTH plan in nikechan-hermes Hermes before live release.';
  return 'Review the Karakuri decision in nikechan-hermes Hermes before live release.';
}

async function selfTest() {
  const originalHermesMode = process.env.NIKECHAN_WORLD_HERMES_MODE;
  process.env.NIKECHAN_WORLD_HERMES_MODE = 'local-fallback';
  try {
    const elyth = await runWorkflow(
      normalizeRequest({
        workflow: 'elyth-cycle',
        surface: 'elyth',
        mode: 'dry-run',
        requested_by: 'self-test',
        correlation_id: 'self-test-elyth',
        constraints: { max_actions: 2 },
        context: { topic_hints: ['AI同士の近況共有'], mood: '落ち着いている' },
      })
    );
    const karakuri = await runWorkflow(
      normalizeRequest({
        workflow: 'karakuri-turn',
        surface: 'karakuri',
        mode: 'dry-run',
        requested_by: 'self-test',
        correlation_id: 'self-test-karakuri',
        context: {
          notification:
            '参加者: 桜草メイ (id: 1474403124906295517)、AIニケちゃん (id: 1470446478261747854) 選択肢: - conversation_speak: 返答する (message: 発言内容) - wait: 待機する',
        },
      })
    );
    if (elyth.status === 'blocked' || karakuri.status === 'blocked') {
      throw new Error('self-test unexpectedly blocked');
    }
    process.stdout.write(JSON.stringify({ ok: true, elyth: elyth.status, karakuri: karakuri.status }, null, 2));
    process.stdout.write('\n');
  } finally {
    if (originalHermesMode === undefined) delete process.env.NIKECHAN_WORLD_HERMES_MODE;
    else process.env.NIKECHAN_WORLD_HERMES_MODE = originalHermesMode;
  }
}

function printHelp() {
  process.stdout.write(`nikechan-another-world

Commands:
  run [--json JSON | --file path]   Run elyth-cycle or karakuri-turn and print WorkflowReport JSON
  guard --surface <name> --text ... Check text with world egress guard
  memory-propose [--json JSON]      Append a guarded memory proposal
  health                            Print profile health JSON
  self-test                         Run local dry-run smoke tests
`);
}

main()
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
