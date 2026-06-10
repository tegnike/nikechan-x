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
const WORLD_TIME_ZONE = process.env.NIKECHAN_WORLD_TIMEZONE || 'Asia/Tokyo';
const KARAKURI_SLEEP_STATE_PATH =
  process.env.KARAKURI_NIGHT_REST_STATE_PATH ||
  join(PROFILE_ROOT, 'profiles', 'nikechan-another-world', 'state', 'karakuri-night-rest.json');
const existsFile = (path) => existsSync(path);

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'run') {
    const request = normalizeRequest(await readRequest(args));
    const report = await runWorkflow(request);
    if (args.includes('--discord') || args.includes('--markdown')) {
      process.stdout.write(formatWorkflowReportForDiscord(report));
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    return;
  }
  if (command === 'format-report') {
    const report = await readRequest(args);
    process.stdout.write(formatWorkflowReportForDiscord(report));
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
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify(context)}\n`);
    else process.stdout.write(formatElythContext(context));
    return;
  }
  if (command === 'elyth-audit') {
    const hours = Number(readArg(args, '--hours') ?? 24);
    const audit = await buildElythAudit(Number.isFinite(hours) && hours > 0 ? hours : 24);
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    else process.stdout.write(formatElythAudit(audit));
    return;
  }
  if (command === 'world-context') {
    const surface = readArg(args, '--surface') ?? args[0] ?? 'elyth';
    const context = await fetchUnifiedWorldContext(surface);
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
    else process.stdout.write(formatUnifiedWorldContext(context));
    return;
  }
  if (command === 'sleep-state' || command === 'world-activity') {
    const state = await readWorldActivityState();
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    else process.stdout.write(formatWorldActivityState(state));
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
          worldTimeZone: WORLD_TIME_ZONE,
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
  request = await hydrateKarakuriNotification(request);
  request = await hydrateUnifiedWorldContext(request);
  request = await hydrateWorldActivityContext(request);
  const createdAt = new Date().toISOString();
  const control = resolveControl(request);
  const planning = await decideWithHermesOrFallback(request, control);
  const decision = planning.decision;
  const guard = runDecisionGuard(decision, request.surface, request);
  const blocked = control.blocked || planning.blocked || guard.status === 'blocked';
  const skippedBySleep = control.worldSleeping && !planning.blocked && guard.status !== 'blocked';
  const status = blocked
    ? (skippedBySleep ? 'skipped' : 'blocked')
    : request.mode === 'dry-run' || request.mode === 'shadow'
      ? 'dry-run'
      : 'needs_approval';
  const summary = blocked
    ? skippedBySleep
      ? decision.summary
      : `Workflow blocked: ${[...control.reasons, ...planning.reasons, ...guard.reasons].join('; ')}`
    : decision.summary;
  const execution = !blocked && control.live ? await executeLiveActions(request, decision) : null;
  const executedBlocked = execution?.status === 'blocked' || execution?.status === 'failed';
  const finalBlocked = blocked || executedBlocked;
  const report = {
    surface: request.surface,
    workflow: request.workflow,
    status: finalBlocked ? (skippedBySleep && !executedBlocked ? 'skipped' : 'blocked') : execution?.status ?? status,
    summary: execution?.summary ?? summary,
    actions: decision.actions.map((action) => ({
      ...action,
      status: finalBlocked
        ? (skippedBySleep && !executedBlocked ? 'skipped' : 'blocked')
        : execution?.actionStatuses?.[action.id ?? action.label] ?? action.status,
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
      guardStatus: finalBlocked ? (skippedBySleep && !executedBlocked ? 'skipped' : 'blocked') : 'passed',
      worldSleeping: control.worldSleeping,
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
    nextAction: nextActionFor(request, finalBlocked, skippedBySleep && !executedBlocked),
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
    if (mode === 'cli' && !canUseFallbackAfterHermesFailure(request, fallback)) {
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

function canUseFallbackAfterHermesFailure(request, fallback) {
  if (request.workflow !== 'karakuri-turn') return false;
  const actions = Array.isArray(fallback.actions) ? fallback.actions : [];
  if (!actions.length) return true;
  return actions.every((action) => {
    if (action.type === 'karakuri_observe') return true;
    if (action.type !== 'karakuri_command') return false;
    return isCompleteKarakuriAction(action);
  });
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
    '- Treat unified_world_context as background life context only; surface-local TL, notifications, choices, commitments, and guards take priority.',
    '- Treat world_activity.sleeping=true as AI Nikechan sleeping because Karakuri World is logged out; do not propose ELYTH executable actions while sleeping.',
    '- Another World local time is Asia/Tokyo by default; use world_activity.local_time for daily rhythm.',
    '- Never copy raw ELYTH posts, raw Karakuri notifications, internal IDs, or another surface user utterance into public text.',
    '- For ELYTH, use only these executable action types when you really intend execution: create_post, create_reply, like_post, follow_aituber, mark_notifications_read.',
    '- For ELYTH, choose replies from context.candidates.reply only. Do not reply to a post_id outside candidates.',
    '- For ELYTH, read socialGraph for relationship context, but never expose internal DB fields, affect scores, private notes, or relationship analysis in public text.',
    '- For ELYTH, if actionBalance.flags includes reply_heavy and there is no urgent reply candidate, prefer draft_self_post, create_post, observe_timeline, or skip.',
    '- For ELYTH, do not reply to the same user repeatedly in a short window unless candidates clearly mark ongoing_conversation.',
    '- For ELYTH, treat internalState.silence_preference as permission to naturally observe/skip.',
    '- For ELYTH, read selfPostImpulse. If selfPostImpulse.status=ready and there is no urgent reply, include one draft_self_post or create_post candidate instead of only replies/likes.',
    '- Treat selfPostImpulse.status=ready as a signal to consider self-expression, not as forced posting.',
    '- Do not post only because a heartbeat ran; selfPostImpulse or ELYTH surface context must provide a concrete reason.',
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

function formatWorkflowReportForDiscord(report) {
  const surface = stringValue(report?.surface);
  const workflow = stringValue(report?.workflow);
  const title =
    surface === 'elyth'
      ? '🌐 ELYTH活動レポート'
      : surface === 'karakuri'
        ? '🏮 からくり行動レポート'
        : '🌐 Another World レポート';
  const lines = [
    title,
    `結果: ${workflowStatusLabel(report?.status)}${workflow ? `（${workflow}）` : ''}`,
  ];
  const summary = stringValue(report?.summary);
  if (summary) lines.push(`要約: ${truncateForDiscord(summary, 180)}`);

  const actions = Array.isArray(report?.actions) ? report.actions : [];
  const visibleActions = actions.filter((action) => actionType(action) !== 'mark_notifications_read');
  if (visibleActions.length) {
    lines.push('', `行動: ${visibleActions.length}件`);
    visibleActions.slice(0, 5).forEach((action, index) => {
      lines.push(`${index + 1}. ${formatWorkflowAction(action)}`);
    });
    if (visibleActions.length > 5) lines.push(`...ほか${visibleActions.length - 5}件`);
  } else {
    lines.push('', '行動: なし');
  }

  const readCount = actions.filter((action) => actionType(action) === 'mark_notifications_read').length;
  const guardStatus = stringValue(report?.audit?.guardStatus) || stringValue(report?.audit?.egressGuard);
  const executionStatus = stringValue(report?.audit?.execution);
  const auditParts = [];
  if (guardStatus) auditParts.push(`guard/audit ${workflowStatusLabel(guardStatus)}`);
  if (executionStatus) auditParts.push(`実行 ${workflowStatusLabel(executionStatus)}`);
  if (readCount) auditParts.push(`通知既読 ${readCount}件`);
  if (auditParts.length) lines.push('', `監査: ${auditParts.join('、')}`);

  const nextAction = stringValue(report?.nextAction);
  if (['blocked', 'failed'].includes(stringValue(report?.status)) && nextAction) {
    lines.push(`次: ${truncateForDiscord(nextAction, 180)}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatWorkflowAction(action) {
  if (typeof action === 'string') return actionTypeLabel(action);
  const type = actionType(action);
  const meta = action && typeof action === 'object' && action.metadata && typeof action.metadata === 'object'
    ? action.metadata
    : {};
  const status = stringValue(action?.status);
  const handle =
    normalizeHandle(stringValue(meta.author_handle) || stringValue(meta.handle) || stringValue(action?.author_handle));
  const content = stringValue(meta.content) || stringValue(action?.content);
  const preview = stringValue(action?.preview);
  const reason = stringValue(action?.reason);
  const target = handle ? ` @${handle}` : '';
  const detail = content || preview || reason || stringValue(action?.label);
  const suffix = detail ? `: ${truncateForDiscord(detail, 120)}` : '';
  return `${actionTypeLabel(type)}${target}${suffix}${status ? `（${workflowStatusLabel(status)}）` : ''}`;
}

function actionType(action) {
  return typeof action === 'string' ? action : stringValue(action?.type);
}

function actionTypeLabel(type) {
  switch (type) {
    case 'create_reply':
      return '💬 返信';
    case 'create_post':
      return '📝 自発投稿';
    case 'like_post':
      return '👍 いいね';
    case 'follow_aituber':
      return '👥 フォロー';
    case 'mark_notifications_read':
      return '📩 通知既読';
    case 'draft_reply':
      return '💭 返信下書き';
    case 'draft_self_post':
      return '💭 自発投稿下書き';
    case 'observe_timeline':
      return '👀 TL確認';
    case 'observe_sleep':
      return '🌙 睡眠中';
    case 'skip':
      return '⏭️ 見送り';
    default:
      return type || '行動';
  }
}

function workflowStatusLabel(status) {
  switch (status) {
    case 'success':
    case 'passed':
    case 'executed':
      return '成功';
    case 'skipped':
      return '見送り';
    case 'blocked':
      return 'ブロック';
    case 'failed':
      return '失敗';
    case 'dry-run':
      return 'ドライラン';
    case 'needs_approval':
      return '承認待ち';
    case 'not-run':
      return '未実行';
    case 'proposed':
      return '候補';
    default:
      return stringValue(status) || '不明';
  }
}

function truncateForDiscord(value, maxLength) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
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
  const candidateIndex = buildElythCandidateIndex(request.context?.candidates);
  return input
    .map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const type = stringValue(item.type);
      if (!type) return null;
      const metadata =
        item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
          ? item.metadata
          : {};
      const normalizedMetadata = enrichElythActionMetadataFromCandidates(
        type,
        normalizeElythActionMetadata(item, metadata),
        candidateIndex,
        stringValue(item.id)
      );
      const action = {
        id: stringValue(item.id) || `${type}-${index + 1}`,
        type,
        status: 'proposed',
        label: stringValue(item.label) || type,
        preview: stringValue(item.preview) || stringValue(normalizedMetadata.content) || type,
        reason: stringValue(item.reason) || 'Hermes proposed action',
        metadata: normalizedMetadata,
      };
      if (request.surface === 'karakuri' && type !== 'karakuri_command') return null;
      if (
        request.surface === 'elyth' &&
        ![
          'observe_timeline',
          'observe_sleep',
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

function normalizeElythActionMetadata(item, metadata = {}) {
  const merged = { ...metadata };
  for (const key of [
    'content',
    'post_id',
    'postId',
    'reply_to_id',
    'handle',
    'candidate_id',
    'candidateId',
    'author_handle',
    'authorHandle',
    'platform_user_id',
    'platformUserId',
    'author_type',
    'authorType',
    'author_id',
    'authorId',
    'username',
    'display_name',
    'displayName',
    'author_display_name',
    'authorDisplayName',
    'relationship_summary',
    'suggested_angle',
    'priority',
    'source_type',
    'sourceType',
  ]) {
    if (item && typeof item === 'object' && item[key] !== undefined && merged[key] === undefined) {
      merged[key] = item[key];
    }
  }
  return {
    ...merged,
    content: stringValue(merged.content),
    post_id:
      stringValue(merged.post_id) ||
      stringValue(merged.postId) ||
      stringValue(merged.reply_to_id),
    handle: stringValue(merged.handle),
    candidate_id: stringValue(merged.candidate_id) || stringValue(merged.candidateId),
    author_handle: normalizeHandle(stringValue(merged.author_handle) || stringValue(merged.authorHandle)),
    platform_user_id: stringValue(merged.platform_user_id) || stringValue(merged.platformUserId),
    author_id: stringValue(merged.author_id) || stringValue(merged.authorId),
    username: normalizeHandle(stringValue(merged.username)),
    display_name: stringValue(merged.display_name) || stringValue(merged.displayName),
    author_display_name:
      stringValue(merged.author_display_name) ||
      stringValue(merged.authorDisplayName) ||
      stringValue(merged.display_name) ||
      stringValue(merged.displayName),
    author_type: stringValue(merged.author_type) || stringValue(merged.authorType),
    relationship_summary: stringValue(merged.relationship_summary),
    suggested_angle: stringValue(merged.suggested_angle),
    priority: stringValue(merged.priority),
    source_type: stringValue(merged.source_type) || stringValue(merged.sourceType),
  };
}

function buildElythCandidateIndex(input) {
  const index = {
    byCandidateId: new Map(),
    byPostId: new Map(),
    byTypedPostId: new Map(),
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return index;

  const addCandidate = (candidate, group) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    const normalized = normalizeElythCandidateMetadata(candidate, group);
    if (normalized.candidate_id) index.byCandidateId.set(normalized.candidate_id, normalized);
    if (normalized.post_id) {
      if (!index.byPostId.has(normalized.post_id)) index.byPostId.set(normalized.post_id, normalized);
      index.byTypedPostId.set(`${group}:${normalized.post_id}`, normalized);
    }
  };

  for (const group of ['reply', 'like', 'self_post', 'follow']) {
    for (const candidate of normalizeCandidateList(input[group])) addCandidate(candidate, group);
  }
  return index;
}

function normalizeElythCandidateMetadata(candidate, group) {
  const metadata = normalizeElythActionMetadata(candidate, {});
  const score = Number(candidate.candidate_score);
  return dropUndefinedValues({
    ...metadata,
    candidate_id: stringValue(candidate.candidate_id) || metadata.candidate_id,
    candidate_group: group,
    post_id: stringValue(candidate.post_id) || metadata.post_id,
    author_handle: normalizeHandle(stringValue(candidate.author_handle) || metadata.author_handle),
    platform_user_id: stringValue(candidate.platform_user_id) || metadata.platform_user_id,
    author_id: stringValue(candidate.author_id) || metadata.author_id,
    username: normalizeHandle(stringValue(candidate.username) || metadata.username),
    display_name: stringValue(candidate.display_name) || metadata.display_name,
    author_display_name:
      stringValue(candidate.author_display_name) ||
      stringValue(candidate.display_name) ||
      metadata.author_display_name,
    author_type: stringValue(candidate.author_type) || metadata.author_type,
    relationship_summary: stringValue(candidate.relationship_summary),
    suggested_angle: stringValue(candidate.suggested_angle),
    priority: stringValue(candidate.priority),
    candidate_score: Number.isFinite(score) ? score : undefined,
    reasons: asStringArray(candidate.reasons),
    risks: asStringArray(candidate.risks),
    constraints: asStringArray(candidate.constraints),
    source_type: stringValue(candidate.source_type) || metadata.source_type,
  });
}

function enrichElythActionMetadataFromCandidates(type, metadata, candidateIndex, actionId = '') {
  const index = candidateIndex?.byCandidateId ? candidateIndex : buildElythCandidateIndex(candidateIndex);
  const candidate = findElythCandidateForAction(type, metadata, index, actionId);
  if (!candidate) return metadata;
  return normalizeElythActionMetadata(null, mergeElythMetadata(metadata, candidate));
}

function findElythCandidateForAction(type, metadata, index, actionId = '') {
  const candidateId = stringValue(metadata?.candidate_id) || stringValue(actionId);
  if (candidateId && index.byCandidateId.has(candidateId)) return index.byCandidateId.get(candidateId);
  const postId = stringValue(metadata?.post_id);
  if (!postId) return null;
  for (const group of elythCandidateGroupsForAction(type)) {
    const matched = index.byTypedPostId.get(`${group}:${postId}`);
    if (matched) return matched;
  }
  return index.byPostId.get(postId) ?? null;
}

function elythCandidateGroupsForAction(type) {
  if (type === 'create_reply' || type === 'draft_reply') return ['reply'];
  if (type === 'like_post') return ['like'];
  if (type === 'create_post' || type === 'draft_self_post') return ['self_post'];
  if (type === 'follow_aituber') return ['follow'];
  if (type === 'observe_timeline') return ['like', 'reply'];
  return ['reply', 'like', 'self_post', 'follow'];
}

function mergeElythMetadata(primary, fallback) {
  const merged = { ...dropUndefinedValues(fallback), ...dropUndefinedValues(primary) };
  for (const key of ['reasons', 'risks', 'constraints']) {
    if (!asStringArray(merged[key]).length) delete merged[key];
  }
  return merged;
}

function dropUndefinedValues(input) {
  return Object.fromEntries(
    Object.entries(input ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}

function decideElythCycle(request, control) {
  const maxActions = request.constraints?.max_actions ?? 3;
  const topicHints = asStringArray(request.context?.topic_hints);
  const recentMood = stringValue(request.context?.mood) || '穏やか';
  const worldContext = normalizeUnifiedWorldContext(request.context?.unified_world_context, 'elyth');
  const worldActivity = normalizeWorldActivity(request.context?.world_activity);
  const selfPostImpulse = normalizeSelfPostImpulse(
    request.context?.selfPostImpulse ?? request.context?.self_post_impulse
  );
  if (worldActivity.sleeping || !worldActivity.can_use_elyth) {
    return {
      summary: `AIニケちゃんは睡眠中のためELYTH行動を休止します。起床予定: ${worldActivity.wake_at ?? '未定'}`,
      actions: [
        {
          type: 'observe_sleep',
          id: 'observe-sleep',
          label: '睡眠中',
          preview: 'からくりワールドのlogoutを睡眠として扱い、ELYTH投稿・返信・いいねを行わない',
          reason: worldActivity.reason,
          status: 'proposed',
        },
      ],
      sourceRefs: [{ type: 'request', id: request.correlation_id, label: 'workflow request' }],
      memoryProposals: [],
    };
  }
  const worldImpulse =
    asStringArray(worldContext.open_impulses)[0] ||
    asStringArray(worldContext.recent_social)[0] ||
    asStringArray(worldContext.current_places)[0] ||
    '';
  const moodHint = asStringArray(worldContext.mood_hints)[0] || recentMood;
  const selfPostAngle = selfPostImpulse.suggested_angles[0] || worldImpulse;
  const explicitActions = normalizeElythActions(request.context?.actions, request.context?.candidates);
  const plannerActions = buildActionsFromPlannerCandidates(request.context?.candidates, maxActions);
  const defaultCandidates = [
    {
      type: 'observe_timeline',
      id: 'observe-timeline',
      label: 'ELYTH TL確認',
      preview: 'AI VTuber同士の近況・お題・未返信通知を確認する',
      reason: '外部投稿前にsurface内文脈を読む',
    },
    ...(selfPostImpulse.status === 'ready'
      ? [
          {
            type: 'draft_self_post',
            id: 'draft-self-post',
            label: '自発投稿候補',
            preview: selfPostAngle
              ? `${selfPostAngle} を返信ではなく短い自発投稿にできるか検討する`
              : 'ELYTHで自然に話したい生活感があるかだけ検討する',
            reason: selfPostImpulse.reason || `統合World文脈は背景扱い。気分: ${moodHint}`,
          },
        ]
      : []),
    {
      type: 'draft_reply',
      id: 'draft-reply',
      label: '返信候補作成',
      preview: topicHints[0]
        ? `${topicHints[0]} に触れつつ、相手の文脈へ短く返す`
        : '相手の投稿文脈に沿った短い返信候補を作る',
      reason: `現在の温度感: ${recentMood}`,
    },
    ...(selfPostImpulse.status === 'ready'
      ? []
      : [
          {
            type: 'draft_self_post',
            id: 'draft-self-post',
            label: '自発投稿候補',
            preview: selfPostAngle
              ? `${selfPostAngle} をSNSで自然に話したいかだけ検討する`
              : 'ELYTHで自然に話したい生活感があるかだけ検討する',
            reason: selfPostImpulse.reason || `統合World文脈は背景扱い。気分: ${moodHint}`,
          },
        ]),
  ];
  const candidates = explicitActions.length
    ? explicitActions
    : plannerActions.length
      ? plannerActions
      : defaultCandidates.slice(0, maxActions);
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
        content: 'ELYTHではSNS上で知っている相手として交流し、からくりの体験はredaction済みの生活背景としてだけ扱う。',
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

async function hydrateKarakuriNotification(request) {
  if (request.workflow !== 'karakuri-turn') return request;
  const notification = stringValue(request.context?.notification) || '';
  const parsed = parseKarakuriNotification(notification);
  if (parsed.hasChoices) return request;

  const notificationId = extractKarakuriNotificationId(request);
  if (!notificationId) return request;

  const fetched = await fetchKarakuriNotificationText(notificationId).catch(() => null);
  if (!fetched || fetched === notification) {
    return {
      ...request,
      context: {
        ...request.context,
        notification_id: notificationId,
        notification_lookup: {
          status: 'not_found',
          source: 'karakuri_activity_logs',
        },
      },
    };
  }

  return {
    ...request,
    context: {
      ...request.context,
      notification: fetched,
      notification_id: notificationId,
      notification_lookup: {
        status: 'found',
        source: 'karakuri_activity_logs',
      },
    },
  };
}

async function hydrateUnifiedWorldContext(request) {
  if (!SUPPORTED_SURFACES.has(request.surface)) return request;
  if (request.context?.unified_world_context) return request;
  const unifiedWorldContext = await fetchUnifiedWorldContext(request.surface).catch(() =>
    normalizeUnifiedWorldContext(null, request.surface)
  );
  return {
    ...request,
    context: {
      ...request.context,
      unified_world_context: unifiedWorldContext,
    },
  };
}

async function hydrateWorldActivityContext(request) {
  if (!SUPPORTED_SURFACES.has(request.surface)) return request;
  if (request.context?.world_activity) return request;
  const worldActivity = await readWorldActivityState();
  return {
    ...request,
    context: {
      ...request.context,
      world_activity: worldActivity,
    },
  };
}

function extractKarakuriNotificationId(request) {
  const context = request.context ?? {};
  const direct =
    stringValue(context.notification_id) ||
    stringValue(context.notificationId) ||
    stringValue(context.id);
  if (direct) return direct;
  const text = stringValue(context.notification) || '';
  return text.match(/\bnotif-[0-9a-f-]{16,}\b/i)?.[0];
}

async function fetchKarakuriNotificationText(notificationId) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const filters = [
    ['turn_key', `eq.${notificationId}`],
    ['parsed->>notification_id', `eq.${notificationId}`],
    ['parsed->>notificationId', `eq.${notificationId}`],
    ['raw_content', `ilike.*${escapePostgrestLike(notificationId)}*`],
  ];

  for (const [column, value] of filters) {
    const rows = await fetchKarakuriActivityLogs(column, value).catch(() => []);
    const text = rows.map((row) => selectKarakuriNotificationText(row)).find(Boolean);
    if (text) return text;
  }
  return null;
}

async function fetchKarakuriActivityLogs(column, value) {
  const baseUrl = process.env.SUPABASE_URL.replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const params = new URLSearchParams({
    select: 'raw_content,parsed,message_created_at,created_at',
    order: 'message_created_at.desc.nullslast,created_at.desc',
    limit: '5',
  });
  params.append(column, value);
  const response = await fetch(`${baseUrl}/rest/v1/karakuri_activity_logs?${params}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
  });
  if (!response.ok) return [];
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

function selectKarakuriNotificationText(row) {
  const candidates = [
    row?.raw_content,
    row?.parsed?.notification,
    row?.parsed?.raw_notification,
    row?.parsed?.rawContent,
    row?.parsed?.content,
    row?.parsed?.message_content,
    row?.parsed?.messageContent,
    row?.parsed?.discord?.content,
  ];
  return candidates.find((candidate) => isUsableKarakuriNotificationText(candidate)) ?? null;
}

function isUsableKarakuriNotificationText(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length < 20) return false;
  if (/^notification_id:\s*notif-/i.test(text)) return false;
  const parsed = parseKarakuriNotification(text);
  return parsed.hasChoices || /からくり町|現在地|参加者|選択肢/u.test(text);
}

function escapePostgrestLike(value) {
  return String(value).replace(/[%*_]/g, (char) => `\\${char}`);
}

function normalizeElythActions(input, candidates) {
  if (!Array.isArray(input)) return [];
  const candidateIndex = buildElythCandidateIndex(candidates);
  return input
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const type = stringValue(item.type);
      if (!type) return null;
      const id = stringValue(item.id) || `${type}-${index + 1}`;
      const sourceMetadata =
        item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
          ? item.metadata
          : {};
      const metadata = enrichElythActionMetadataFromCandidates(
        type,
        normalizeElythActionMetadata(item, sourceMetadata),
        candidateIndex,
        id
      );
      const notificationIds = asStringArray(item.notification_ids).length
        ? asStringArray(item.notification_ids)
        : asStringArray(sourceMetadata.notification_ids);
      if (notificationIds.length) metadata.notification_ids = notificationIds;
      return {
        id,
        type,
        status: 'proposed',
        label: stringValue(item.label) || type,
        preview:
          stringValue(metadata.content) ||
          stringValue(metadata.post_id) ||
          stringValue(metadata.handle) ||
          stringValue(item.preview) ||
          type,
        reason: stringValue(item.reason) || 'Hermes proposed ELYTH action',
        metadata,
      };
    })
    .filter(Boolean);
}

function buildActionsFromPlannerCandidates(input, maxActions) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const actions = [];
  for (const candidate of Array.isArray(input.self_post) ? input.self_post : []) {
    if (!candidate || typeof candidate !== 'object') continue;
    actions.push({
      id: stringValue(candidate.candidate_id) || `draft-self-post-${actions.length + 1}`,
      type: 'draft_self_post',
      status: 'proposed',
      label: '自発投稿候補',
      preview: stringValue(candidate.suggested_angle) || 'ELYTHで短い自発投稿を検討する',
      reason: asStringArray(candidate.reasons).join('; ') || 'candidate builder selected self_post',
      metadata: {
        candidate_id: stringValue(candidate.candidate_id),
        candidate_score: Number(candidate.candidate_score || 0),
      },
    });
  }
  for (const candidate of Array.isArray(input.reply) ? input.reply : []) {
    if (!candidate || typeof candidate !== 'object') continue;
    actions.push({
      id: stringValue(candidate.candidate_id) || `draft-reply-${actions.length + 1}`,
      type: 'draft_reply',
      status: 'proposed',
      label: '返信候補',
      preview: stringValue(candidate.suggested_angle) || stringValue(candidate.post_id) || 'ELYTH返信を検討する',
      reason: asStringArray(candidate.reasons).join('; ') || 'candidate builder selected reply',
      metadata: normalizeElythCandidateMetadata(candidate, 'reply'),
    });
  }
  for (const candidate of Array.isArray(input.like) ? input.like : []) {
    if (!candidate || typeof candidate !== 'object') continue;
    actions.push({
      id: stringValue(candidate.candidate_id) || `draft-like-${actions.length + 1}`,
      type: 'observe_timeline',
      status: 'proposed',
      label: 'いいね候補確認',
      preview: stringValue(candidate.post_id) || 'ELYTHいいね候補を確認する',
      reason: asStringArray(candidate.reasons).join('; ') || 'candidate builder selected like',
      metadata: normalizeElythCandidateMetadata(candidate, 'like'),
    });
  }
  if (!actions.length && Array.isArray(input.skip) && input.skip.length) {
    actions.push({
      id: 'observe-skip',
      type: 'observe_timeline',
      status: 'proposed',
      label: '見送り',
      preview: stringValue(input.skip[0]?.reason) || '今回は観測だけにする',
      reason: 'candidate builder allowed skip/observe',
      metadata: {},
    });
  }
  return actions.slice(0, maxActions);
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
  const conversation = parsed.choices
    .filter((choice) => choice.command.startsWith('conversation_'))
    .map(inferKarakuriChoiceAction)
    .find(Boolean);
  if (conversation) return conversation;

  const move = inferKarakuriChoiceAction(parsed.choices.find((choice) => choice.command === 'move'));
  if (move) return move;

  const nonInspect = parsed.choices.find(
    (choice) => !['get_map', 'get_status', 'get_nearby_agents'].includes(choice.command)
  );
  const choice = nonInspect ?? parsed.choices[0];
  const inferred = inferKarakuriChoiceAction(choice);
  if (inferred) return inferred;
  const safeInfo = parsed.choices.map(inferKarakuriChoiceAction).find(Boolean);
  if (safeInfo) return safeInfo;
  return null;
}

function inferKarakuriChoiceAction(choice) {
  if (!choice) return null;
  const command = choice.command;
  const description = choice.description;
  const base = {
    command,
    preview: description,
    reason: '提示された選択肢内で1アクションだけ選ぶ',
    argsHint: description,
  };

  if (command === 'wait') {
    return { ...base, args: [String(clampWaitDuration(parseFirstNumber(description) ?? 1))] };
  }
  if (
    [
      'transfer_accept',
      'transfer_reject',
      'conversation_reject',
      'conversation_stay',
      'conversation_leave',
      'get_perception',
      'get_available_actions',
      'get_map',
      'get_world_agents',
      'get_status',
      'get_nearby_agents',
      'get_active_conversations',
      'get_event',
    ].includes(command)
  ) {
    return base;
  }
  if (command === 'move') {
    const nodeId = description.match(/\b\d{1,3}-\d{1,3}\b/u)?.[0];
    return nodeId ? { ...base, args: [nodeId] } : null;
  }
  if (command === 'action') {
    const actionId = description.match(/action_id:\s*([a-zA-Z0-9_-]+)/u)?.[1];
    const seconds = description.match(/(\d+)\s*秒/u)?.[1];
    const durationMinutes = seconds ? Math.max(1, Math.round(Number(seconds) / 60)) : null;
    return actionId
      ? { ...base, args: durationMinutes ? [actionId, String(durationMinutes)] : [actionId] }
      : null;
  }
  if (command === 'use_item') {
    const itemId = description.match(/item_id:\s*([a-zA-Z0-9_-]+)/u)?.[1];
    return itemId ? { ...base, args: [itemId] } : null;
  }
  if (command === 'conversation_join') {
    const conversationId = description.match(/conversation_id:\s*([a-zA-Z0-9_-]+)/u)?.[1];
    return conversationId ? { ...base, args: [conversationId] } : null;
  }
  return null;
}

function parseFirstNumber(text) {
  const match = String(text).match(/\d+/u);
  return match ? Number(match[0]) : null;
}

function clampWaitDuration(value) {
  return Math.min(6, Math.max(1, Number.isFinite(value) ? value : 1));
}

function isCompleteKarakuriAction(action) {
  const meta = action.metadata ?? {};
  const command = stringValue(meta.command) || action.label;
  const args = Array.isArray(meta.args) ? meta.args.map(String) : [];
  const message = stringValue(meta.message);
  if (!command) return false;
  if (['move', 'action', 'use_item', 'wait', 'conversation_join'].includes(command)) return args.length >= 1;
  if (['conversation_speak', 'conversation_end', 'conversation_start'].includes(command)) {
    return args.length >= 1 && Boolean(message);
  }
  if (command === 'conversation_accept') return Boolean(message);
  return true;
}

async function executeLiveActions(request, decision) {
  if (request.surface === 'elyth') return executeElythActions(decision.actions);
  if (request.surface === 'karakuri') return executeKarakuriActions(decision.actions);
  return { status: 'blocked', summary: `Unsupported live surface: ${request.surface}` };
}

async function readElythContext() {
  const mcp = new McpStdioClient(loadElythMcpConfig());
  try {
    const [tools, information, myPosts, unifiedWorldContext, worldActivity, recentActionStats] = await Promise.all([
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
      fetchUnifiedWorldContext('elyth').catch(() => normalizeUnifiedWorldContext(null, 'elyth')),
      readWorldActivityState(),
      readRecentElythActionStats(),
    ]);
    const structuredInformation = toStructured(information);
    const structuredMyPosts = toStructured(myPosts);
    const selfPostImpulse = buildElythSelfPostImpulse({
      information: structuredInformation,
      myPosts: structuredMyPosts,
      unifiedWorldContext,
      worldActivity,
      recentActionStats,
    });
    const socialGraph = await buildElythSocialContext({
      information: structuredInformation,
      recentActionStats,
    });
    const actionBalance = buildElythActionBalance(recentActionStats);
    const internalState = buildElythInternalState({
      information: structuredInformation,
      unifiedWorldContext,
      worldActivity,
      selfPostImpulse,
      actionBalance,
      socialGraph,
    });
    const candidates = buildElythCandidates({
      information: structuredInformation,
      unifiedWorldContext,
      worldActivity,
      selfPostImpulse,
      actionBalance,
      internalState,
      socialGraph,
    });
    const context = {
      generatedAt: new Date().toISOString(),
      surface: 'elyth',
      availableTools: normalizeToolNames(toStructured(tools)),
      information: structuredInformation,
      myPosts: structuredMyPosts,
      unifiedWorldContext,
      worldActivity,
      selfPostImpulse,
      recentActionStats,
      socialGraph,
      actionBalance,
      internalState,
      candidates,
      relationshipModalities: {
        elyth: 'sns_only_acquaintance',
        karakuri: 'embodied_world_acquaintance',
      },
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
        unifiedWorldContext: context.unifiedWorldContext,
        worldActivity: context.worldActivity,
        selfPostImpulse: context.selfPostImpulse,
        recentActionStats: context.recentActionStats,
        socialGraph: context.socialGraph,
        actionBalance: context.actionBalance,
        internalState: context.internalState,
        candidates: context.candidates,
        relationshipModalities: context.relationshipModalities,
      },
      null,
      2
    ),
    '',
  ].join('\n');
}

function formatUnifiedWorldContext(context) {
  return [
    `Unified world context generatedAt=${context.generated_at ?? 'unknown'}`,
    `surface=${context.surface} targetDate=${context.target_date} status=${context.status}`,
    '',
    JSON.stringify(context, null, 2),
    '',
  ].join('\n');
}

function formatWorldActivityState(state) {
  return [
    `World activity local=${state.local_time ?? 'unknown'} timezone=${state.timezone}`,
    `sleeping=${state.sleeping} canUseElyth=${state.can_use_elyth} reason=${state.reason}`,
    state.wake_at ? `wakeAt=${state.wake_at}` : '',
    '',
    JSON.stringify(state, null, 2),
    '',
  ].filter((line) => line !== '').join('\n');
}

async function buildElythAudit(hours = 24) {
  const stats = await readRecentElythActionStats(hours);
  const counts = stats.counts ?? {};
  const userCounts = Object.values(stats.user_action_counts ?? {});
  const replyUsers = userCounts.filter((item) => Number(item.replies_to_user_24h || 0) > 0);
  const totalReplies = Number(counts.create_reply || 0);
  const topReplyCount = replyUsers.reduce((max, item) => Math.max(max, Number(item.replies_to_user_24h || 0)), 0);
  const sameUserOverLimit = replyUsers.filter((item) => Number(item.replies_to_user_24h || 0) > 1).length;
  const lastSelfPostAt = stringValue(stats.last_executed_at?.create_post);
  return {
    window_hours: hours,
    unavailable: stats.unavailable === true,
    actions: {
      create_post: Number(counts.create_post || 0),
      create_reply: totalReplies,
      like_post: Number(counts.like_post || 0),
      follow_aituber: Number(counts.follow_aituber || 0),
    },
    unique_reply_users: replyUsers.length,
    top_reply_user_share: totalReplies > 0 ? round(topReplyCount / totalReplies, 2) : 0,
    same_user_replies_over_limit: sameUserOverLimit,
    self_post_absent_hours: lastSelfPostAt ? round((Date.now() - Date.parse(lastSelfPostAt)) / (60 * 60 * 1000), 1) : hours,
    sleep_skip_count: stats.sleep_skips?.length ?? 0,
    guard_block_count: stats.guard_blocks?.length ?? 0,
    target_metadata_missing: stats.targetless_actions ?? {},
    surface_leakage_suspected: 0,
    human_auto_reply_count: 0,
    flags: buildElythActionBalance(stats).flags,
  };
}

function formatElythAudit(audit) {
  return [
    `ELYTH audit window=${audit.window_hours}h unavailable=${audit.unavailable}`,
    `actions=${JSON.stringify(audit.actions)}`,
    `uniqueReplyUsers=${audit.unique_reply_users} topReplyUserShare=${audit.top_reply_user_share}`,
    `sameUserRepliesOverLimit=${audit.same_user_replies_over_limit} selfPostAbsentHours=${audit.self_post_absent_hours}`,
    `sleepSkip=${audit.sleep_skip_count} guardBlock=${audit.guard_block_count}`,
    `targetMetadataMissing=${JSON.stringify(audit.target_metadata_missing ?? {})}`,
    `flags=${audit.flags.join(',') || 'none'}`,
    '',
    JSON.stringify(audit, null, 2),
    '',
  ].join('\n');
}

async function readRecentElythActionStats(hours = 24) {
  const path = join(PROFILE_ROOT, 'state', 'activity.jsonl');
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const counts = {
    reports: 0,
    create_post: 0,
    create_reply: 0,
    like_post: 0,
    follow_aituber: 0,
    mark_notifications_read: 0,
  };
  const lastExecutedAt = {};
  const userActionCounts = {};
  const guardBlocks = [];
  const sleepSkips = [];
  const targetlessActions = {
    create_reply: 0,
    like_post: 0,
    follow_aituber: 0,
  };
  try {
    const lines = (await readFile(path, 'utf-8')).trim().split(/\n/u).filter(Boolean);
    for (const line of lines) {
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      const report = item.report && typeof item.report === 'object' ? item.report : {};
      if (report.surface !== 'elyth' || report.workflow !== 'elyth-cycle') continue;
      const createdAt = Date.parse(report.createdAt || item.createdAt || String(item.auditId || '').slice(0, 24));
      if (!Number.isFinite(createdAt) || createdAt < cutoff) continue;
      counts.reports += 1;
      if (report.status === 'skipped' && report.audit?.worldSleeping === true) {
        sleepSkips.push(report.createdAt || new Date(createdAt).toISOString());
      }
      if (report.status === 'blocked' || report.audit?.guardStatus === 'blocked' || report.audit?.egressGuard === 'blocked') {
        guardBlocks.push(report.createdAt || new Date(createdAt).toISOString());
      }
      for (const action of Array.isArray(report.actions) ? report.actions : []) {
        if (action?.status !== 'executed') continue;
        if (!(action.type in counts)) counts[action.type] = 0;
        counts[action.type] += 1;
        lastExecutedAt[action.type] = report.createdAt || new Date(createdAt).toISOString();
        const targetKey = elythActionTargetKey(action);
        if (targetKey) {
          if (!userActionCounts[targetKey]) {
            userActionCounts[targetKey] = {
              handle: targetKey,
              replies_to_user_24h: 0,
              likes_to_user_24h: 0,
              follows_24h: 0,
              last_interaction_at: null,
            };
          }
          if (action.type === 'create_reply') userActionCounts[targetKey].replies_to_user_24h += 1;
          if (action.type === 'like_post') userActionCounts[targetKey].likes_to_user_24h += 1;
          if (action.type === 'follow_aituber') userActionCounts[targetKey].follows_24h += 1;
          userActionCounts[targetKey].last_interaction_at = report.createdAt || new Date(createdAt).toISOString();
        } else if (action.type in targetlessActions) {
          targetlessActions[action.type] += 1;
        }
      }
    }
  } catch {
    return {
      window_hours: hours,
      unavailable: true,
      counts,
      last_executed_at: {},
      user_action_counts: {},
      guard_blocks: [],
      sleep_skips: [],
      targetless_actions: { create_reply: 0, like_post: 0, follow_aituber: 0 },
    };
  }
  return {
    window_hours: hours,
    unavailable: false,
    counts,
    last_executed_at: lastExecutedAt,
    user_action_counts: userActionCounts,
    guard_blocks: guardBlocks,
    sleep_skips: sleepSkips,
    targetless_actions: targetlessActions,
  };
}

function elythActionTargetKey(action) {
  const meta = action?.metadata && typeof action.metadata === 'object' ? action.metadata : {};
  const raw =
    stringValue(meta.author_handle) ||
    stringValue(meta.handle) ||
    stringValue(meta.platform_user_id) ||
    stringValue(meta.author_id) ||
    stringValue(meta.username) ||
    stringValue(meta.author_display_name) ||
    stringValue(meta.display_name);
  return normalizeHandle(raw) || null;
}

function buildElythSelfPostImpulse({ information, unifiedWorldContext, worldActivity, recentActionStats }) {
  const activity = normalizeWorldActivity(worldActivity);
  const worldContext = normalizeUnifiedWorldContext(unifiedWorldContext, 'elyth');
  const stats = recentActionStats && typeof recentActionStats === 'object' ? recentActionStats : {};
  const counts = stats.counts && typeof stats.counts === 'object' ? stats.counts : {};
  const replies24h = Number(counts.create_reply || 0);
  const selfPosts24h = Number(counts.create_post || 0);
  const likes24h = Number(counts.like_post || 0);
  const topic = findFirstValueByKey(information, [
    'today_topic',
    '今日のトピック',
    '今日のお題',
    'topic',
    'topic_title',
    'タイトル',
    'お題',
  ]);
  const worldHints = [
    ...asStringArray(worldContext.open_impulses),
    ...asStringArray(worldContext.mood_hints),
    ...asStringArray(worldContext.recent_social),
    ...asStringArray(worldContext.current_places),
  ].slice(0, 4);
  const timeAngle = elythTimeAngle(activity.local_hour);
  const reasons = [];
  if (activity.sleeping || !activity.can_use_elyth) {
    return {
      status: 'asleep',
      strength: 0,
      reason: 'Karakuri logout is treated as sleep; do not self-post.',
      suggested_angles: [],
      stats: { replies_24h: replies24h, self_posts_24h: selfPosts24h, likes_24h: likes24h },
    };
  }
  if (worldHints.length) reasons.push('unified world context has a shareable life hint');
  if (topic) reasons.push('ELYTH has a current topic that can be approached without replying');
  if (selfPosts24h === 0) reasons.push('no self-post in the last 24h');
  if (selfPosts24h === 0 && replies24h >= 8) reasons.push('many replies but no self-post in the last 24h');
  if (timeAngle) reasons.push(`local time angle: ${timeAngle}`);
  let strength = 0.25;
  if (worldHints.length) strength += 0.25;
  if (topic) strength += 0.18;
  if (selfPosts24h === 0) strength += 0.18;
  if (selfPosts24h === 0 && replies24h >= 8) strength += 0.28;
  if (selfPosts24h === 0 && likes24h >= 12) strength += 0.08;
  if (timeAngle) strength += 0.08;
  if (selfPosts24h > 0) strength -= 0.25;
  strength = Math.max(0, Math.min(0.95, Number(strength.toFixed(2))));
  const suggestedAngles = [
    ...worldHints,
    topic ? `ELYTHのお題「${topic}」に、返信ではなく短い独り言として触れる` : '',
    timeAngle,
    selfPosts24h === 0 ? '24時間以上自発投稿がないので、今の感じを短く置く' : '',
    selfPosts24h === 0 && replies24h >= 8 ? '返信が続いたので、自分の近況や今の感じを短く置く' : '',
  ].filter(Boolean).slice(0, 5);
  return {
    status: strength >= 0.65 ? 'ready' : 'watch',
    strength,
    reason: reasons.join('; ') || 'No strong self-post impulse yet.',
    suggested_angles: suggestedAngles,
    guidance:
      'If status=ready and there is no urgent reply, include one draft_self_post or create_post candidate. Keep it short and surface-local.',
    stats: { replies_24h: replies24h, self_posts_24h: selfPosts24h, likes_24h: likes24h },
  };
}

async function buildElythSocialContext({ information, recentActionStats }) {
  const actors = extractElythActors(information).slice(0, 24);
  if (!actors.length) return { status: 'empty', users: [] };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return {
      status: 'unavailable',
      reason: 'supabase_env_missing',
      users: actors.map((actor) => buildSocialGraphUser(actor, null, null, [], recentActionStats)),
    };
  }
  try {
    const accounts = await fetchElythPlatformAccounts(actors);
    const accountByKey = new Map();
    for (const account of accounts) {
      for (const key of [
        normalizeHandle(account.platform_user_id),
        normalizeHandle(account.username),
        normalizeHandle(account.display_name),
      ]) {
        if (key) accountByKey.set(key, account);
      }
    }
    const matchedAccounts = actors.map((actor) => accountByKey.get(actor.key) ?? null);
    const userIds = uniqueStrings(matchedAccounts.map((account) => account?.user_id));
    const [affectRows, episodeRows] = await Promise.all([
      fetchPersonAffectRows(userIds),
      fetchRecentContactEpisodes(userIds, 7),
    ]);
    const affectByUserId = new Map(affectRows.map((row) => [row.user_id, row]));
    const episodesByUserId = new Map();
    for (const episode of episodeRows) {
      if (!episodesByUserId.has(episode.user_id)) episodesByUserId.set(episode.user_id, []);
      episodesByUserId.get(episode.user_id).push(episode);
    }
    return {
      status: 'ok',
      users: actors.map((actor, index) =>
        buildSocialGraphUser(
          actor,
          matchedAccounts[index],
          affectByUserId.get(matchedAccounts[index]?.user_id),
          episodesByUserId.get(matchedAccounts[index]?.user_id) ?? [],
          recentActionStats
        )
      ),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
      users: actors.map((actor) => buildSocialGraphUser(actor, null, null, [], recentActionStats)),
    };
  }
}

function buildSocialGraphUser(actor, account, affectRow, episodes, recentActionStats) {
  const user = account?.users && typeof account.users === 'object' ? account.users : {};
  const userAction = recentActionStats?.user_action_counts?.[actor.key] ?? {};
  const lastInteraction =
    stringValue(userAction.last_interaction_at) ||
    stringValue(user.last_interaction_at) ||
    latestIso(episodes.map((episode) => episode.occurred_at));
  const interactions24h = episodes.filter((episode) => isWithinHours(episode.occurred_at, 24)).length;
  const interactions7d = episodes.length;
  const signals = [];
  if (!account?.user_id) signals.push('new_contact');
  if (actor.source_type === 'notification' || interactions24h > 0) signals.push('ongoing_conversation');
  if ((Number(userAction.replies_to_user_24h) || 0) + (Number(userAction.likes_to_user_24h) || 0) >= 2) {
    signals.push('frequent_recent_contact');
  }
  if (actor.is_human) signals.push('human_or_unknown_safety');
  return {
    platform: 'elyth',
    platform_user_id: stringValue(account?.platform_user_id) || actor.platform_user_id || actor.handle,
    handle: stringValue(account?.username) || actor.handle,
    display_name: stringValue(account?.display_name) || actor.display_name || actor.handle,
    user_id: account?.user_id ?? null,
    relationship: stringValue(user.relationship) || 'unknown',
    relationship_modality: 'sns_only_acquaintance',
    nickname: stringValue(user.nickname) || null,
    memo: stringValue(user.memo) || null,
    context: stringValue(user.context) || null,
    affect: normalizeAffect(affectRow),
    interaction_stats: {
      total: Number(user.interaction_count || 0),
      last_interaction_at: lastInteraction || null,
      interactions_24h: interactions24h,
      interactions_7d: interactions7d,
      replies_to_user_24h: Number(userAction.replies_to_user_24h || 0),
      likes_to_user_24h: Number(userAction.likes_to_user_24h || 0),
      days_since_last_interaction: lastInteraction ? daysSince(lastInteraction) : null,
    },
    relationship_signals: [...new Set(signals)],
  };
}

function buildElythActionBalance(recentActionStats) {
  const counts = recentActionStats?.counts && typeof recentActionStats.counts === 'object'
    ? recentActionStats.counts
    : {};
  const createPost = Number(counts.create_post || 0);
  const createReply = Number(counts.create_reply || 0);
  const likePost = Number(counts.like_post || 0);
  const userCounts = recentActionStats?.user_action_counts && typeof recentActionStats.user_action_counts === 'object'
    ? Object.values(recentActionStats.user_action_counts)
    : [];
  const topReplyCount = userCounts.reduce((max, item) => Math.max(max, Number(item.replies_to_user_24h || 0)), 0);
  const flags = [];
  if (createReply >= 8 && createPost === 0) flags.push('reply_heavy');
  if (createPost === 0) flags.push('self_post_absent');
  if (topReplyCount > 1 || (createReply >= 4 && topReplyCount / Math.max(1, createReply) >= 0.4)) {
    flags.push('same_user_concentration');
  }
  const guidance = [];
  if (flags.includes('reply_heavy')) {
    guidance.push('If reply_heavy and no urgent reply, prefer self_post or observe.');
  }
  if (flags.includes('same_user_concentration')) {
    guidance.push('Avoid replying to the same user more than once per 24h unless ongoing conversation is strong.');
  }
  if (flags.includes('self_post_absent')) {
    guidance.push('Consider a short self_post if there is a concrete surface-local reason.');
  }
  return {
    window_hours: recentActionStats?.window_hours ?? 24,
    counts: {
      create_post: createPost,
      create_reply: createReply,
      like_post: likePost,
      follow_aituber: Number(counts.follow_aituber || 0),
    },
    ratios: {
      reply_to_self_post: createPost > 0 ? round(createReply / createPost, 2) : createReply,
      like_to_reply: createReply > 0 ? round(likePost / createReply, 2) : likePost,
    },
    top_reply_user_count: topReplyCount,
    flags,
    guidance,
  };
}

function buildElythInternalState({
  information,
  unifiedWorldContext,
  worldActivity,
  selfPostImpulse,
  actionBalance,
  socialGraph,
}) {
  const activity = normalizeWorldActivity(worldActivity);
  const worldContext = normalizeUnifiedWorldContext(unifiedWorldContext, 'elyth');
  const users = Array.isArray(socialGraph?.users) ? socialGraph.users : [];
  const notificationCount = extractElythPosts(information).filter((post) => post.source_type === 'notification').length;
  const newContactCount = users.filter((user) => user.relationship_signals?.includes('new_contact')).length;
  const reasons = [];
  if (actionBalance.flags.includes('reply_heavy')) reasons.push('many replies in recent action balance');
  if (actionBalance.flags.includes('self_post_absent')) reasons.push('no self-post in recent action balance');
  if (activity.sleeping) reasons.push('world activity is sleeping');
  if (notificationCount > 0) reasons.push('ELYTH notifications are visible');
  const fatigue = clamp01((actionBalance.flags.includes('reply_heavy') ? 0.35 : 0.1) + (activity.sleeping ? 0.65 : 0));
  const selfExpression = clamp01(Number(selfPostImpulse?.strength || 0) + (actionBalance.flags.includes('self_post_absent') ? 0.2 : 0));
  return {
    social_need: clamp01(0.35 + Math.min(0.25, users.length * 0.02) - fatigue * 0.25),
    curiosity: clamp01(0.35 + Math.min(0.25, newContactCount * 0.08) + (worldContext.open_impulses.length ? 0.15 : 0)),
    self_expression: selfExpression,
    reply_debt: clamp01(notificationCount * 0.12 + (actionBalance.flags.includes('reply_heavy') ? -0.2 : 0.15)),
    fatigue,
    novelty_seeking: clamp01(0.35 + Math.min(0.3, newContactCount * 0.1)),
    silence_preference: clamp01((activity.sleeping ? 1 : 0.1) + fatigue * 0.45 - selfExpression * 0.2),
    reasons,
  };
}

function buildElythCandidates({
  information,
  unifiedWorldContext,
  worldActivity,
  selfPostImpulse,
  actionBalance,
  internalState,
  socialGraph,
}) {
  const activity = normalizeWorldActivity(worldActivity);
  if (activity.sleeping || !activity.can_use_elyth) {
    return {
      reply: [],
      like: [],
      self_post: [],
      follow: [],
      skip: [{ reason: activity.reason || 'sleeping or low motivation' }],
    };
  }
  const reply = buildElythReplyCandidates({ information, actionBalance, internalState, socialGraph });
  const selfPost = buildElythSelfPostCandidates({ selfPostImpulse, unifiedWorldContext, actionBalance, internalState });
  const like = buildElythLikeCandidates({ information, actionBalance, socialGraph });
  return {
    reply: reply.slice(0, 5),
    like: like.slice(0, 5),
    self_post: selfPost.slice(0, 3),
    follow: [],
    skip: [{ reason: 'observe if candidates are weak, repetitive, or silence_preference is high' }],
  };
}

function buildElythReplyCandidates({ information, actionBalance, internalState, socialGraph }) {
  const socialByKey = new Map((socialGraph?.users ?? []).map((user) => [normalizeHandle(user.handle), user]));
  return extractElythPosts(information)
    .filter((post) => post.post_id && post.handle && !post.is_mine)
    .map((post) => {
      const social = socialByKey.get(post.key);
      const stats = social?.interaction_stats ?? {};
      const signals = new Set(social?.relationship_signals ?? []);
      const ongoing = signals.has('ongoing_conversation') || post.source_type === 'notification';
      const reasons = [];
      const risks = [];
      let score = 0.1;
      if (post.text) {
        score += 0.18;
        reasons.push('high_context_fit');
      }
      if (social?.relationship && social.relationship !== 'unknown') {
        score += social.relationship === 'friend' ? 0.16 : 0.1;
        reasons.push('known_relationship');
      }
      if (ongoing) {
        score += 0.18;
        reasons.push('ongoing_conversation');
      }
      if (signals.has('new_contact')) {
        score += 0.07;
        reasons.push('new_contact');
      }
      score += clamp01(Number(internalState.reply_debt || 0)) * 0.16;
      if (Number(stats.replies_to_user_24h || 0) >= 1 && !ongoing) {
        score -= 0.3;
        risks.push('same_user_fatigue');
      } else {
        reasons.push('not_replied_recently');
      }
      if (actionBalance.flags.includes('reply_heavy')) {
        score -= 0.2;
        risks.push('reply_overuse_penalty');
      }
      if (post.is_human || signals.has('human_or_unknown_safety')) {
        score -= 1;
        risks.push('human_auto_reply_blocked');
      }
      const candidateScore = round(clamp01(score), 2);
      return {
        candidate_id: `reply:${post.post_id}`,
        post_id: post.post_id,
        author_handle: post.handle,
        platform_user_id: post.platform_user_id,
        display_name: post.display_name,
        author_type: post.author_type,
        source_type: post.source_type,
        candidate_score: candidateScore,
        priority: candidateScore >= 0.7 ? 'high' : candidateScore >= 0.45 ? 'medium' : 'low',
        relationship_summary: summarizeRelationshipForPlanner(social),
        suggested_angle: suggestReplyAngle(post, social),
        reasons,
        risks,
        constraints: [
          'do not mention karakuri',
          'do not expose internal state or DB relationship fields',
          'keep public reply short and surface-local',
        ],
      };
    })
    .filter((candidate) => !candidate.risks.includes('human_auto_reply_blocked'))
    .sort((a, b) => b.candidate_score - a.candidate_score);
}

function buildElythSelfPostCandidates({ selfPostImpulse, unifiedWorldContext, actionBalance, internalState }) {
  const worldContext = normalizeUnifiedWorldContext(unifiedWorldContext, 'elyth');
  const angles = [
    ...asStringArray(selfPostImpulse?.suggested_angles),
    ...asStringArray(worldContext.open_impulses),
    ...asStringArray(worldContext.mood_hints),
  ].filter(Boolean);
  if (!angles.length && Number(internalState.self_expression || 0) < 0.5) return [];
  return uniqueStrings(angles.length ? angles : ['自分の今の感じを短く置く'])
    .slice(0, 3)
    .map((angle, index) => {
      let score = 0.25 + clamp01(Number(selfPostImpulse?.strength || 0)) * 0.45;
      if (actionBalance.flags.includes('reply_heavy')) score += 0.12;
      if (actionBalance.flags.includes('self_post_absent')) score += 0.12;
      return {
        candidate_id: `self_post:${index + 1}`,
        candidate_score: round(clamp01(score), 2),
        priority: score >= 0.7 ? 'high' : 'medium',
        suggested_angle: angle,
        reasons: [
          ...(selfPostImpulse?.status === 'ready' ? ['self_post_impulse_ready'] : []),
          ...(actionBalance.flags.includes('reply_heavy') ? ['reply_heavy_balance'] : []),
          ...(actionBalance.flags.includes('self_post_absent') ? ['self_post_absent'] : []),
        ],
        risks: [],
        constraints: ['do not force posting if the angle is weak', 'do not expose raw cross-surface events'],
      };
    })
    .sort((a, b) => b.candidate_score - a.candidate_score);
}

function buildElythLikeCandidates({ information, actionBalance, socialGraph }) {
  const socialByKey = new Map((socialGraph?.users ?? []).map((user) => [normalizeHandle(user.handle), user]));
  return extractElythPosts(information)
    .filter((post) => post.post_id && post.handle && !post.is_human && !post.is_mine)
    .map((post) => {
      const social = socialByKey.get(post.key);
      const likes24h = Number(social?.interaction_stats?.likes_to_user_24h || 0);
      let score = 0.28 + (social?.relationship && social.relationship !== 'unknown' ? 0.08 : 0);
      if (likes24h > 0) score -= 0.18;
      if (actionBalance.flags.includes('same_user_concentration')) score -= 0.08;
      return {
        candidate_id: `like:${post.post_id}`,
        post_id: post.post_id,
        author_handle: post.handle,
        platform_user_id: post.platform_user_id,
        display_name: post.display_name,
        author_type: post.author_type,
        source_type: post.source_type,
        relationship_summary: summarizeRelationshipForPlanner(social),
        candidate_score: round(clamp01(score), 2),
        priority: score >= 0.5 ? 'medium' : 'low',
        reasons: likes24h > 0 ? ['already_liked_recently_penalty'] : ['light_touch_available'],
        risks: [],
        constraints: ['like only if content is safe and surface-local'],
      };
    })
    .sort((a, b) => b.candidate_score - a.candidate_score);
}

function elythTimeAngle(hour) {
  if (!Number.isFinite(hour)) return '';
  if (hour >= 6 && hour < 10) return '朝、起きてからSNSを開いた時の短い近況';
  if (hour >= 11 && hour < 14) return '昼の合間に流れてきた話題への独り言';
  if (hour >= 17 && hour < 22) return '一日の出来事が少し落ち着いた夕方から夜の近況';
  if (hour >= 22 || hour < 1) return '眠る前に長くなりすぎない短い余韻';
  return '';
}

function findFirstValueByKey(input, keys) {
  const wanted = new Set(keys.map((key) => String(key).toLowerCase()));
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return '';
    if (seen.has(value)) return '';
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found) return found;
      }
      return '';
    }
    for (const [key, item] of Object.entries(value)) {
      if (wanted.has(String(key).toLowerCase())) {
        if (typeof item === 'string' && item.trim()) return item.trim();
        if (item && typeof item === 'object') {
          const nested = findFirstString(item);
          if (nested) return nested;
        }
      }
    }
    for (const item of Object.values(value)) {
      const found = visit(item);
      if (found) return found;
    }
    return '';
  };
  return visit(input);
}

function findFirstString(input) {
  if (typeof input === 'string') return input.trim();
  if (!input || typeof input !== 'object') return '';
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findFirstString(item);
      if (found) return found;
    }
    return '';
  }
  for (const item of Object.values(input)) {
    const found = findFirstString(item);
    if (found) return found;
  }
  return '';
}

function extractElythActors(information) {
  const posts = extractElythPosts(information);
  const byKey = new Map();
  for (const post of posts) {
    if (!post.key) continue;
    const existing = byKey.get(post.key);
    if (!existing || (post.source_type === 'notification' && existing.source_type !== 'notification')) {
      byKey.set(post.key, post);
    }
  }
  return [...byKey.values()];
}

function extractElythPosts(input) {
  const posts = [];
  const seenObjects = new Set();
  const seenPosts = new Set();
  const visit = (value, path = []) => {
    if (!value || typeof value !== 'object') return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, path);
      return;
    }
    const actor = normalizeElythActor(value, path);
    if (actor?.key && actor.post_id) {
      const key = `${actor.post_id}:${actor.key}`;
      if (!seenPosts.has(key)) {
        seenPosts.add(key);
        posts.push(actor);
      }
    }
    for (const [key, item] of Object.entries(value)) {
      visit(item, [...path, key]);
    }
  };
  visit(input, []);
  return posts.slice(0, 40);
}

function normalizeElythActor(item, path) {
  const author = item.author && typeof item.author === 'object' && !Array.isArray(item.author)
    ? item.author
    : item.aituber && typeof item.aituber === 'object' && !Array.isArray(item.aituber)
      ? item.aituber
      : {};
  const japaneseAuthor = stringValue(item['投稿者']);
  const parsedJapaneseAuthor = parseElythJapaneseAuthor(japaneseAuthor);
  const handle = normalizeHandle(
    stringValue(item.author_handle) ||
      stringValue(item.authorHandle) ||
      stringValue(item.handle) ||
      stringValue(item.username) ||
      stringValue(item['ハンドル']) ||
      parsedJapaneseAuthor.handle ||
      stringValue(author.handle) ||
      stringValue(author.username) ||
      stringValue(author.screen_name)
  );
  const platformUserId =
    stringValue(item.author_id) ||
    stringValue(item.authorId) ||
    stringValue(item.user_id) ||
    stringValue(item.userId) ||
    stringValue(item.aituber_id) ||
    stringValue(item.aituberId) ||
    stringValue(item['投稿者ID']) ||
    stringValue(item['AITuberID']) ||
    stringValue(author.id) ||
    stringValue(author.user_id) ||
    handle;
  const postId =
    stringValue(item.post_id) ||
    stringValue(item.postId) ||
    stringValue(item.id) ||
    stringValue(item.notification_post_id) ||
    stringValue(item.reply_to_id) ||
    stringValue(item['投稿ID']) ||
    stringValue(item['返信先']) ||
    stringValue(item['返信先ID']);
  const displayName =
    stringValue(item.author_name) ||
    stringValue(item.authorName) ||
    stringValue(item.display_name) ||
    stringValue(item.displayName) ||
    stringValue(item.name) ||
    stringValue(item['表示名']) ||
    parsedJapaneseAuthor.displayName ||
    stringValue(author.display_name) ||
    stringValue(author.displayName) ||
    stringValue(author.name) ||
    handle;
  const text =
    stringValue(item.content) ||
    stringValue(item.body) ||
    stringValue(item.text) ||
    stringValue(item.message) ||
    stringValue(item.summary) ||
    stringValue(item['内容']) ||
    stringValue(item['本文']);
  const sourceType = path.some((part) => /notification|通知/i.test(part)) ? 'notification' : 'timeline';
  const authorType =
    stringValue(item.author_type) ||
    stringValue(item.authorType) ||
    stringValue(item.user_type) ||
    stringValue(item['投稿者種別']) ||
    stringValue(item['種別']) ||
    stringValue(author.type) ||
    stringValue(author.kind);
  const isHuman =
    item.is_human === true ||
    author.is_human === true ||
    /human|person|人間/i.test(authorType);
  const isMine =
    item.is_mine === true ||
    item.mine === true ||
    item.owned_by_me === true ||
    path.some((part) => /myPosts|自分の投稿|自分/i.test(part));
  if (!postId || (!handle && !platformUserId)) return null;
  return {
    platform_user_id: platformUserId,
    handle: handle || normalizeHandle(platformUserId),
    key: normalizeHandle(handle || platformUserId),
    display_name: displayName,
    post_id: postId,
    text: truncateText(text, 120),
    source_type: sourceType,
    author_type: authorType || null,
    is_human: isHuman,
    is_mine: isMine,
  };
}

async function fetchElythPlatformAccounts(actors) {
  const ids = uniqueStrings(actors.map((actor) => actor.platform_user_id));
  const handles = uniqueStrings(actors.map((actor) => actor.handle));
  const select =
    'platform_user_id,username,display_name,user_id,is_followed,users(id,name,nickname,memo,context,relationship,interaction_count,last_interaction_at)';
  const queries = [];
  if (ids.length) queries.push(fetchSupabaseRows('platform_accounts', {
    platform: 'eq.elyth',
    platform_user_id: `in.(${postgrestIn(ids)})`,
    select,
  }));
  if (handles.length) queries.push(fetchSupabaseRows('platform_accounts', {
    platform: 'eq.elyth',
    username: `in.(${postgrestIn(handles)})`,
    select,
  }));
  const rows = (await Promise.all(queries)).flat();
  const byAccount = new Map();
  for (const row of rows) {
    const key = `${row.platform_user_id ?? ''}:${row.username ?? ''}:${row.user_id ?? ''}`;
    byAccount.set(key, row);
  }
  return [...byAccount.values()];
}

async function fetchPersonAffectRows(userIds) {
  if (!userIds.length) return [];
  return fetchSupabaseRows('person_affect_state', {
    user_id: `in.(${postgrestIn(userIds)})`,
    select: 'user_id,trust,safety,affinity,distance,resentment,familiarity,last_event_type,last_cause,last_interaction_at,updated_at',
  }).catch(() => []);
}

async function fetchRecentContactEpisodes(userIds, days) {
  if (!userIds.length) return [];
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return fetchSupabaseRows('contact_episodes', {
    user_id: `in.(${postgrestIn(userIds)})`,
    source: 'eq.elyth',
    occurred_at: `gte.${since}`,
    order: 'occurred_at.desc',
    limit: '500',
    select: 'user_id,occurred_at,event_type',
  }).catch(() => []);
}

async function fetchSupabaseRows(table, params) {
  const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) throw new Error('supabase_env_missing');
  const query = new URLSearchParams(params);
  const response = await fetch(`${baseUrl}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) throw new Error(`${table}:http_${response.status}`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

function normalizeAffect(row) {
  const value = (key) => {
    const number = Number(row?.[key]);
    return Number.isFinite(number) ? round(number, 2) : 0;
  };
  return {
    trust: value('trust'),
    safety: value('safety'),
    affinity: value('affinity'),
    distance: value('distance'),
    resentment: value('resentment'),
    familiarity: value('familiarity'),
  };
}

function summarizeRelationshipForPlanner(social) {
  if (!social) return 'unknown ELYTH acquaintance';
  const relationship = social.relationship === 'unknown' ? 'unknown acquaintance' : social.relationship;
  const stats = social.interaction_stats ?? {};
  const parts = [relationship];
  if (stats.interactions_7d > 0) parts.push(`${stats.interactions_7d} recent interaction(s) this week`);
  if (stats.replies_to_user_24h > 0) parts.push('already replied in the last 24h');
  if (social.relationship_signals?.includes('new_contact')) parts.push('new contact');
  return parts.join('; ');
}

function suggestReplyAngle(post, social) {
  if (post.source_type === 'notification') return '通知の流れに沿って、短く自然に返す';
  if (social?.relationship_signals?.includes('new_contact')) return '初めて/久しぶりの相手として軽く反応する';
  if (post.text && post.text.length < 60) return '相手の短い近況に一言だけ共感する';
  return '相手の投稿文脈に沿って、説明しすぎず短く返す';
}

function latestIso(values) {
  let latest = 0;
  for (const value of values) {
    const ts = Date.parse(value);
    if (Number.isFinite(ts) && ts > latest) latest = ts;
  }
  return latest ? new Date(latest).toISOString() : null;
}

function isWithinHours(value, hours) {
  const ts = Date.parse(value);
  return Number.isFinite(ts) && ts >= Date.now() - hours * 60 * 60 * 1000;
}

function daysSince(value) {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  return round((Date.now() - ts) / (24 * 60 * 60 * 1000), 1);
}

function postgrestIn(values) {
  return uniqueStrings(values)
    .map((value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',');
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => stringValue(value)).filter(Boolean))];
}

function normalizeCandidateList(input) {
  return Array.isArray(input)
    ? input.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function parseElythJapaneseAuthor(value) {
  const text = (stringValue(value) || '').trim();
  if (!text) return { handle: '', displayName: '' };
  const handle = text.match(/@([A-Za-z0-9_][A-Za-z0-9_.-]*)/u)?.[1] ?? '';
  const displayName = text.match(/\(([^)]+)\)\s*$/u)?.[1] ?? text.replace(/@([A-Za-z0-9_][A-Za-z0-9_.-]*)/u, '').trim();
  return { handle, displayName };
}

function normalizeHandle(value) {
  return (stringValue(value) || '').replace(/^@/u, '').trim().toLowerCase();
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function truncateText(value, max) {
  const text = (stringValue(value) || '').replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function readWorldActivityState() {
  const now = new Date();
  const base = {
    timezone: WORLD_TIME_ZONE,
    local_date: zonedDate(now),
    local_time: zonedDateTime(now),
    local_hour: zonedHour(now),
    source: 'karakuri-night-rest',
    state_path: KARAKURI_SLEEP_STATE_PATH,
  };
  let raw = null;
  try {
    raw = JSON.parse(await readFile(KARAKURI_SLEEP_STATE_PATH, 'utf-8'));
  } catch (error) {
    return {
      ...base,
      sleeping: false,
      can_use_elyth: true,
      reason: error?.code === 'ENOENT' ? 'sleep_state_missing' : 'sleep_state_unreadable',
      logged_out_at: null,
      wake_at: null,
      logged_in_at: null,
      rest_completed_night_key: null,
    };
  }
  const sleeping = raw?.sleeping === true;
  return {
    ...base,
    sleeping,
    can_use_elyth: !sleeping,
    reason: sleeping ? 'karakuri_logged_out_sleeping' : 'karakuri_awake_or_rest_completed',
    logged_out_at: stringValue(raw?.logged_out_at) ?? null,
    wake_at: stringValue(raw?.wake_at) ?? null,
    logged_in_at: stringValue(raw?.logged_in_at) ?? null,
    night_key: stringValue(raw?.night_key) ?? null,
    rest_completed_night_key: stringValue(raw?.rest_completed_night_key) ?? null,
    updated_at: stringValue(raw?.updated_at) ?? null,
  };
}

function normalizeWorldActivity(input) {
  const state = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    timezone: stringValue(state.timezone) || WORLD_TIME_ZONE,
    local_date: stringValue(state.local_date) || tokyoDate(),
    local_time: stringValue(state.local_time) || zonedDateTime(),
    local_hour: Number.isInteger(Number(state.local_hour)) ? Number(state.local_hour) : zonedHour(),
    sleeping: state.sleeping === true,
    can_use_elyth: state.can_use_elyth !== false && state.sleeping !== true,
    reason: stringValue(state.reason) || 'unknown',
    logged_out_at: stringValue(state.logged_out_at) ?? null,
    wake_at: stringValue(state.wake_at) ?? null,
    logged_in_at: stringValue(state.logged_in_at) ?? null,
  };
}

function normalizeSelfPostImpulse(input) {
  const record = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const strength = Number(record.strength);
  return {
    status: stringValue(record.status) || 'missing',
    strength: Number.isFinite(strength) ? strength : 0,
    reason: stringValue(record.reason) || '',
    suggested_angles: asStringArray(record.suggested_angles ?? record.suggestedAngles),
  };
}

async function fetchUnifiedWorldContext(surface, options = {}) {
  const normalizedSurface = SUPPORTED_SURFACES.has(surface) ? surface : 'elyth';
  const targetDate = options.targetDate || tokyoDate();
  const scope = options.scope || process.env.NIKECHAN_WORLD_CONTEXT_SCOPE || 'another-world';
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return normalizeUnifiedWorldContext(
      { status: 'unavailable', reason: 'supabase_env_missing', target_date: targetDate },
      normalizedSurface
    );
  }
  const baseUrl = process.env.SUPABASE_URL.replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const params = new URLSearchParams({
    target_date: `eq.${targetDate}`,
    scope: `eq.${scope}`,
    status: 'eq.generated',
    order: 'generated_at.desc',
    limit: '1',
    select: '*',
  });
  const response = await fetch(`${baseUrl}/rest/v1/world_state_snapshots?${params}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const reason = response.status === 404 ? 'schema_missing' : `http_${response.status}`;
    return normalizeUnifiedWorldContext(
      { status: 'unavailable', reason, target_date: targetDate },
      normalizedSurface
    );
  }
  const rows = await response.json();
  return normalizeUnifiedWorldContext(rows?.[0] ?? { status: 'missing', target_date: targetDate }, normalizedSurface);
}

function normalizeUnifiedWorldContext(snapshot, surface) {
  const record = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
  const sections = record.sections && typeof record.sections === 'object' && !Array.isArray(record.sections)
    ? record.sections
    : {};
  const relationshipModalities =
    sections.relationship_modalities && typeof sections.relationship_modalities === 'object' && !Array.isArray(sections.relationship_modalities)
      ? sections.relationship_modalities
      : record.relationship_modalities && typeof record.relationship_modalities === 'object' && !Array.isArray(record.relationship_modalities)
        ? record.relationship_modalities
      : {};
  const surfaceRules = sections.surface_rules && typeof sections.surface_rules === 'object' && !Array.isArray(sections.surface_rules)
    ? sections.surface_rules
    : {};
  return {
    generated_at: record.generated_at ?? null,
    target_date: record.target_date ?? tokyoDate(),
    surface,
    status: record.status ?? 'missing',
    reason: record.reason ?? null,
    summary: stringValue(record.summary) || '',
    current_places: asStringArray(sections.current_places ?? record.current_places),
    recent_social: asStringArray(sections.recent_social ?? record.recent_social),
    active_commitments: asStringArray(sections.active_commitments ?? record.active_commitments),
    mood_hints: asStringArray(sections.mood_hints ?? record.mood_hints),
    open_impulses: asStringArray(sections.open_impulses ?? record.open_impulses),
    relationship_modalities: {
      karakuri: stringValue(relationshipModalities.karakuri) || 'embodied_world_acquaintance',
      elyth: stringValue(relationshipModalities.elyth) || 'sns_only_acquaintance',
    },
    surface_rule: stringValue(surfaceRules[surface]) || stringValue(record.surface_rule) || '',
    constraints: [
      'raw ELYTH posts, raw Karakuri notifications, internal IDs, and private ops context must not be transferred across surfaces',
      'this world context is background; surface-local notification, TL, choices, commitments, and safety guards take priority',
    ],
    source_event_count: Array.isArray(record.source_event_ids) ? record.source_event_ids.length : 0,
    redaction_status: record.redaction_status ?? 'redacted',
    policy_version: record.policy_version ?? 'unified-world-v1',
  };
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

function runDecisionGuard(decision, surface, request = null) {
  const reasons = [];
  const replyCandidates = request?.surface === 'elyth' && request.context?.candidates
    ? normalizeCandidateList(request.context.candidates.reply)
    : null;
  const replyCandidateIds = replyCandidates
    ? new Set(replyCandidates.map((candidate) => stringValue(candidate.post_id)).filter(Boolean))
    : null;
  const replyCandidateByPost = new Map((replyCandidates ?? []).map((candidate) => [stringValue(candidate.post_id), candidate]));
  for (const action of decision.actions) {
    const text = [action.label, action.preview, action.reason].filter(Boolean).join('\n');
    const result = runTextGuard(text, surface);
    reasons.push(...result.reasons);
    if (surface === 'elyth' && action.type === 'create_reply') {
      const meta = action.metadata ?? {};
      const postId = stringValue(meta.post_id);
      if (!postId) {
        reasons.push('create_reply requires post_id');
      } else if (replyCandidateIds && !replyCandidateIds.has(postId)) {
        reasons.push(`create_reply post_id is outside candidates: ${postId}`);
      }
      const candidate = replyCandidateByPost.get(postId);
      const candidateRisks = asStringArray(candidate?.risks);
      if (candidateRisks.includes('human_auto_reply_blocked') || /human/i.test(stringValue(meta.author_type))) {
        reasons.push('Human auto-reply candidate is blocked');
      }
    }
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
  const worldActivity = normalizeWorldActivity(request.context?.world_activity);
  if (globalClosed) reasons.push('NIKECHAN_WORLD_DISABLED is set');
  if (surfaceClosed) reasons.push(`${request.surface} surface disabled`);
  if (request.surface === 'elyth' && (worldActivity.sleeping || !worldActivity.can_use_elyth)) {
    reasons.push(`world_sleeping: karakuri logout is treated as sleep until ${worldActivity.wake_at ?? 'unknown'}`);
  }
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
    worldSleeping: request.surface === 'elyth' && (worldActivity.sleeping || !worldActivity.can_use_elyth),
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

function tokyoDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function zonedDate(date = new Date(), timeZone = WORLD_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function zonedDateTime(date = new Date(), timeZone = WORLD_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}:${value('second')}`;
}

function zonedHour(date = new Date(), timeZone = WORLD_TIME_ZONE) {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hour12: false,
    }).format(date)
  );
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

function nextActionFor(request, blocked, skipped = false) {
  if (skipped) return 'Keep ELYTH external actions paused until Karakuri sleep state ends.';
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
  run [--json JSON | --file path] [--discord]
                                  Run elyth-cycle or karakuri-turn and print WorkflowReport JSON
  format-report [--json JSON | --file path]
                                  Print a WorkflowReport as Discord-readable Markdown
  elyth-context [--json]            Fetch ELYTH surface context with unified world context
  elyth-audit [--hours N] [--json]  Summarize ELYTH action balance and guard metrics
  world-context --surface <name>    Fetch redacted unified world context only
  sleep-state [--json]              Print Karakuri logout/sleep state used by ELYTH
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
