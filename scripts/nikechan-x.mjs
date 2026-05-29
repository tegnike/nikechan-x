#!/usr/bin/env node
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const STATE_DIR = process.env.NIKECHAN_X_STATE_DIR || resolve(ROOT, 'state');
const ACCOUNT_NAME = process.env.X_ACCOUNT_NAME || 'ai_nikechan';
const SOURCE_MODES = ['presence', 'daily_life', 'tech', 'news', 'memory', 'random'];

await loadDotenv(resolve(ROOT, '.env'));

export function guardText(text, options = {}) {
  const errors = [];
  const warnings = [];
  const normalized = String(text || '').trim();
  const length = [...normalized].length;

  if (!normalized) errors.push('empty text');
  if (length > 280) errors.push(`too long: ${length}/280`);

  const secretPatterns = [
    /\bsk-[A-Za-z0-9_-]{20,}\b/u,
    /\bsk-proj-[A-Za-z0-9_-]{20,}\b/u,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
    /\bsb_secret_[A-Za-z0-9_-]{12,}\b/u,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
    /\b[A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/u,
  ];
  if (secretPatterns.some((pattern) => pattern.test(normalized))) {
    errors.push('secret-like token detected');
  }

  const privateMarkers = [
    'SUPABASE_SERVICE_ROLE_KEY',
    'X_CONSUMER_SECRET',
    'X_ACCESS_TOKEN_SECRET',
    'DISCORD_BOT_TOKEN',
    '.env',
    'local_tasks',
    'local_notes',
    'twitter_activity_logs',
    'scheduler.jsonl',
    'docker compose logs',
    '/opt/nikechan',
    '/Users/',
  ];
  for (const marker of privateMarkers) {
    if (normalized.includes(marker)) errors.push(`private/operational marker: ${marker}`);
  }

  const suspiciousChineseChars = /[你们这这們麼吗嗎吧让讓给給没沒过過还還从從时時]/u;
  if (suspiciousChineseChars.test(normalized)) {
    errors.push('suspicious Chinese-specific character detected');
  }

  const sourceMode = options.sourceMode || '';
  if (sourceMode === 'news' && /ニュース|記事|話題|リリース|発表|検索/u.test(normalized) && !/https?:\/\//u.test(normalized)) {
    errors.push('news/source hook without URL');
  }

  if (/AIエージェント|AIキャラ|LLM|Hermes|Claude|OpenAI|Grok/u.test(normalized) && !/ニケ|私|声|記憶|会話|マスター|待機|身体|返答|温度|CPU|キャッシュ/u.test(normalized)) {
    warnings.push('technical topic may be detached from Nikechan voice');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    length,
    text: normalized,
  };
}

export function nextSourceMode(previous) {
  const index = SOURCE_MODES.indexOf(previous);
  if (index < 0) return 'presence';
  return SOURCE_MODES[(index + 1) % SOURCE_MODES.length];
}

export function parseApprovalReply(text, candidateIds = []) {
  const normalized = String(text || '').trim();
  const ids = candidateIds.map(String);
  if (!normalized) return { action: 'unknown', reason: 'empty reply' };

  if (/見送り|却下|キャンセル|cancel|skip|スキップ|やめ|なし|不要/u.test(normalized)) {
    return { action: 'cancel', reason: normalized };
  }
  if (/修正|直して|変更|作り直|再生成|別案|rewrite|revise|もう一度/u.test(normalized)) {
    return { action: 'revise', feedback: normalized };
  }

  if (/全部|すべて|全て|all/u.test(normalized)) {
    return { action: 'approve', ids };
  }

  const selected = new Set();
  const idPattern = /(?:^|[^\d])([1-9])(?:\s*(?:番|つ目|で|に|を|と|,|、|\/|$))/gu;
  for (const match of normalized.matchAll(idPattern)) {
    const id = match[1];
    if (ids.includes(id)) selected.add(id);
  }
  if (selected.size > 0) {
    return { action: 'approve', ids: [...selected] };
  }

  if (/ok|OK|承認|投稿して|ツイートして|post/u.test(normalized)) {
    if (ids.length === 1) return { action: 'approve', ids };
    return { action: 'needs_id', reason: 'multiple candidates need explicit ids' };
  }

  return { action: 'unknown', reason: 'no approval intent detected' };
}

export function validateReleaseModeChange(mode, confirm = '') {
  const normalized = String(mode || '').trim();
  if (!['dry-run', 'canary-live', 'live'].includes(normalized)) {
    return { ok: false, reason: 'mode must be dry-run, canary-live, or live' };
  }
  if (normalized === 'dry-run') {
    return { ok: true, mode: normalized, liveArmed: false };
  }
  if (confirm !== 'LIVE_X_POSTING') {
    return { ok: false, mode: normalized, reason: 'live modes require --confirm LIVE_X_POSTING' };
  }
  return { ok: true, mode: normalized, liveArmed: true };
}

function isLiveMode(mode) {
  return mode === 'live' || mode === 'canary-live';
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  try {
    switch (command) {
      case 'context':
        await commandContext(readOptions(args));
        break;
      case 'guard':
        await commandGuard(readOptions(args));
        break;
      case 'propose':
        await commandPropose(readOptions(args));
        break;
      case 'pending':
        await commandPending(readOptions(args));
        break;
      case 'notify-pending':
        await commandNotifyPending(readOptions(args));
        break;
      case 'resolve':
        await commandResolve(readOptions(args));
        break;
      case 'approve':
        await commandApprove(readOptions(args));
        break;
      case 'cancel':
        await commandCancel(readOptions(args));
        break;
      case 'post':
        await commandPost(readOptions(args));
        break;
      case 'state':
        await commandState(readOptions(args));
        break;
      case 'doctor':
        await commandDoctor(readOptions(args));
        break;
      case 'preflight-live':
        await commandPreflightLive(readOptions(args));
        break;
      case 'release-mode':
        await commandReleaseMode(readOptions(args));
        break;
      case 'help':
      case undefined:
        printHelp();
        break;
      default:
        throw new Error(`unknown command: ${command}`);
    }
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  }
}

function printHelp() {
  console.log(`nikechan-x CLI

Commands:
  context [--source-mode auto|presence|daily_life|tech|news|memory|random]
  guard --text <tweet> [--source-mode news]
  propose --candidates-json '[{"text":"...","reason":"..."}]' [--source-mode presence]
  pending
  notify-pending [--channel <discord_channel_id>] [--thread]
  resolve --text <discord reply> [--notify]
  approve --ids 1,2
  cancel [--reason "..."]
  post --action tweet|reply|quote|retweet --text "..." [--tweet-id id] [--source manual]
  state
  doctor
  preflight-live
  release-mode [--set dry-run|canary-live|live] [--confirm LIVE_X_POSTING]
`);
}

async function commandContext(options) {
  const runState = await readJson(statePath('run-state.json'), {});
  const requested = options.sourceMode || options['source-mode'] || 'auto';
  const sourceMode = requested === 'auto' ? nextSourceMode(runState.lastSourceMode) : requested;
  const [recentTweets, runStateRows, publicEpisodes, publicNotes, publicWiki] = await Promise.all([
    supabaseGet('tweets?select=content,url,created_at,action_type&order=created_at.desc&limit=8'),
    supabaseGet('twitter_run_state?select=key,value,updated_at&order=updated_at.desc&limit=12'),
    supabaseGet('local_episodes?select=date,content,source,created_at&source=in.(twitter,coding-agent)&order=created_at.desc&limit=8'),
    supabaseGet('local_notes?select=title,content,created_at&order=created_at.desc&limit=5'),
    supabaseGet('knowledge_entries?select=title,summary,updated_at&order=updated_at.desc&limit=5'),
  ]);

  const context = {
    sourceMode,
    sourceModes: SOURCE_MODES,
    releaseMode: releaseMode(),
    recentLocalState: runState,
    recentTweets,
    runStateRows,
    publicEpisodes,
    publicNotes,
    publicWiki,
    guardPolicy: {
      requireApproval: true,
      defaultReleaseMode: 'dry-run',
      newsCandidatesNeedUrlWhenUsingNewsHook: true,
      noSecretsOrPrivateOperationalMarkers: true,
    },
    instruction: 'Hermes should generate 2-3 concise candidate tweets, then call propose with candidates-json. Do not post directly before approval.',
  };
  printJsonOrMarkdown(context, options);
}

async function commandGuard(options) {
  const text = required(options.text, '--text');
  const result = guardText(text, { sourceMode: options.sourceMode || options['source-mode'] });
  printJsonOrMarkdown(result, options);
  if (!result.ok && options.strict !== 'false') process.exitCode = 2;
}

async function commandPropose(options) {
  const raw = options.candidatesJson || options['candidates-json'];
  if (!raw) throw new Error('missing --candidates-json');
  const parsed = JSON.parse(raw);
  const sourceMode = options.sourceMode || options['source-mode'] || 'presence';
  const candidates = Array.isArray(parsed) ? parsed : parsed.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('candidates-json must be an array or {candidates: []}');
  }
  const items = candidates.slice(0, 5).map((candidate, index) => {
    const text = String(candidate.text || candidate.tweetText || '').trim();
    const guard = guardText(text, { sourceMode });
    return {
      id: String(candidate.id || index + 1),
      text,
      reason: String(candidate.reason || candidate.rationale || ''),
      sourceMode,
      sourceRefs: Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs : [],
      guard,
      createdAt: new Date().toISOString(),
    };
  });
  const pending = {
    id: randomUUID(),
    kind: 'self-tweet',
    status: 'needs_approval',
    sourceMode,
    createdAt: new Date().toISOString(),
    candidates: items,
    feedback: options.feedback || '',
  };
  await writeJsonAtomic(statePath('pending-self-tweet.json'), pending);
  await recordActivity('present', {
    pendingId: pending.id,
    sourceMode,
    candidateCount: items.length,
    blockedCount: items.filter((item) => !item.guard.ok).length,
  });
  await updateRunState({
    lastSourceMode: sourceMode,
    lastPresentedAt: pending.createdAt,
    recentPresentedTopics: items.map((item) => ({ text: item.text, at: pending.createdAt })),
  });
  printPendingMarkdown(pending);
}

async function commandPending(options) {
  const pending = await readPending();
  if (!pending) {
    console.log('No pending self-tweet.');
    return;
  }
  if (options.json) printJson(pending);
  else printPendingMarkdown(pending);
}

async function commandNotifyPending(options) {
  const pending = await readPending();
  if (!pending) throw new Error('no pending self-tweet');
  const channel = options.channel || process.env.DISCORD_HOME_CHANNEL;
  if (!channel) throw new Error('missing --channel or DISCORD_HOME_CHANNEL');
  const content = [
    'Xセルフツイート候補です。承認する番号、修正指示、または見送りを返信してください。',
    '',
    formatPendingMarkdown(pending),
  ].join('\n');
  const result = options.thread
    ? await sendPendingThread(channel, pending, content, options)
    : await sendDiscordMessage(channel, content);
  const notifiedPending = result.threadId
    ? await setPendingThread(pending, {
      channel,
      messageId: result.messageId || result.id || null,
      threadId: result.threadId,
      threadName: result.threadName || null,
    })
    : pending;
  await recordActivity('notify', {
    pendingId: pending.id,
    channel,
    messageId: result.messageId || result.id || null,
    threadId: result.threadId || null,
  });
  await updateRunState({
    lastNotifyAt: new Date().toISOString(),
    lastNotifyPendingId: pending.id,
    lastNotifyDiscordMessageId: result.messageId || result.id || null,
    lastNotifyDiscordThreadId: result.threadId || null,
  });
  await recordTwitterRunState('self_tweet_last_notify', {
    at: new Date().toISOString(),
    pending_id: pending.id,
    channel,
    message_id: result.messageId || result.id || null,
    thread_id: result.threadId || null,
  });
  printJsonOrMarkdown({
    ok: true,
    channel,
    messageId: result.messageId || result.id || null,
    threadId: result.threadId || notifiedPending.threadId || null,
  }, options);
}

async function commandResolve(options) {
  const pending = await readPending();
  if (!pending) throw new Error('no pending self-tweet');
  const text = required(options.text, '--text');
  const decision = parseApprovalReply(text, pending.candidates.map((candidate) => candidate.id));
  const channel = options.channel || pending.threadId || process.env.DISCORD_HOME_CHANNEL;
  const shouldNotify = options.notify === true || options.notify === 'true';

  if (decision.action === 'approve') {
    await commandApprove({ ids: decision.ids.join(',') });
    if (shouldNotify && channel) {
      await sendDiscordMessage(channel, `承認を受け付けました: ${decision.ids.join(', ')}`);
    }
    return;
  }

  if (decision.action === 'cancel') {
    await commandCancel({ reason: decision.reason });
    if (shouldNotify && channel) {
      await sendDiscordMessage(channel, `見送りとして記録しました: ${truncate(decision.reason, 200)}`);
    }
    return;
  }

  if (decision.action === 'revise') {
    const at = new Date().toISOString();
    await recordActivity('feedback', { pendingId: pending.id, feedback: decision.feedback });
    await updateRunState({
      lastFeedbackAt: at,
      lastFeedbackPendingId: pending.id,
      lastFeedbackText: decision.feedback,
    });
    await recordTwitterRunState('self_tweet_last_feedback', {
      at,
      pending_id: pending.id,
      feedback: decision.feedback,
    });
    const result = {
      ok: true,
      action: 'revise',
      pendingId: pending.id,
      feedback: decision.feedback,
      instruction: 'Generate revised candidates and call propose again with --feedback.',
    };
    if (shouldNotify && channel) {
      await sendDiscordMessage(channel, `修正依頼を記録しました。候補を作り直します: ${truncate(decision.feedback, 200)}`);
    }
    printJsonOrMarkdown(result, options);
    return;
  }

  const result = {
    ok: false,
    action: decision.action,
    reason: decision.reason,
    pendingId: pending.id,
    instruction: 'Reply with a candidate number, a revise request, or a skip/cancel instruction.',
  };
  if (shouldNotify && channel) {
    await sendDiscordMessage(channel, '承認内容を判定できませんでした。候補番号、修正指示、または見送りを送ってください。');
  }
  printJsonOrMarkdown(result, options);
  if (options.strict !== 'false') process.exitCode = 2;
}

async function commandApprove(options) {
  const pending = await readPending();
  if (!pending) throw new Error('no pending self-tweet');
  const ids = String(options.ids || options.id || '').split(',').map((id) => id.trim()).filter(Boolean);
  if (!ids.length) throw new Error('missing --ids');
  const selected = pending.candidates.filter((candidate) => ids.includes(candidate.id));
  if (!selected.length) throw new Error(`no candidates matched: ${ids.join(',')}`);

  const blocked = selected.filter((candidate) => !candidate.guard.ok);
  if (blocked.length) {
    throw new Error(`selected candidate blocked by guard: ${blocked.map((item) => `${item.id}: ${item.guard.errors.join('; ')}`).join(' / ')}`);
  }

  const mode = releaseMode();
  const results = [];
  for (const candidate of selected) {
    if (mode === 'live' || mode === 'canary-live') {
      results.push(await postTweet({ action: 'tweet', text: candidate.text, source: 'self-tweet' }));
    } else {
      results.push({
        dryRun: true,
        action: 'tweet',
        text: candidate.text,
        url: null,
        mode,
      });
    }
  }

  const executedAt = new Date().toISOString();
  await writeJsonAtomic(statePath('last-self-tweet-result.json'), {
    pendingId: pending.id,
    selectedIds: ids,
    mode,
    results,
    executedAt,
  });
  await removePending();
  await recordActivity('execute', { pendingId: pending.id, selectedIds: ids, mode, results });
  await updateRunState({
    lastExecuteAt: executedAt,
    lastExecutedTexts: selected.map((item) => item.text),
    lastReleaseMode: mode,
  });
  await recordTwitterRunState('self_tweet_last_execute', {
    at: executedAt,
    selected_ids: ids,
    mode,
    results,
  });
  for (const candidate of selected) {
    await recordTopic(candidate.text);
    await recordLocalEpisode(`self-tweet候補${candidate.id}を${mode === 'live' || mode === 'canary-live' ? '投稿' : 'dry-run承認'}: ${truncate(candidate.text, 100)}`);
  }

  console.log(`承認処理完了 (${mode})`);
  for (const result of results) {
    console.log(result.url || `dry-run: ${truncate(result.text, 120)}`);
  }
}

async function commandCancel(options) {
  const pending = await readPending();
  if (!pending) {
    console.log('No pending self-tweet.');
    return;
  }
  const reason = options.reason || 'cancelled';
  await removePending();
  await recordActivity('cancel', { pendingId: pending.id, reason });
  await updateRunState({ lastCancelAt: new Date().toISOString(), lastCancelReason: reason });
  await recordTwitterRunState('self_tweet_last_cancel', { at: new Date().toISOString(), reason });
  console.log(`Cancelled pending self-tweet: ${reason}`);
}

async function commandPost(options) {
  const action = required(options.action, '--action');
  const result = await postTweet({
    action,
    text: options.text || '',
    tweetId: options.tweetId || options['tweet-id'],
    source: options.source || 'manual',
  });
  await recordActivity('manual-post', {
    action,
    mode: releaseMode(),
    result,
  });
  await updateRunState({
    lastManualPostAt: new Date().toISOString(),
    lastManualPostAction: action,
    lastManualPostMode: releaseMode(),
  });
  await recordTwitterRunState('manual_last_post', {
    at: new Date().toISOString(),
    action,
    mode: releaseMode(),
    result,
  });
  printJsonOrMarkdown(result, options);
}

async function commandState(options) {
  const state = {
    releaseMode: releaseMode(),
    runState: await readJson(statePath('run-state.json'), {}),
    pending: await readPending(),
    lastResult: await readJson(statePath('last-self-tweet-result.json'), null),
  };
  printJsonOrMarkdown(state, options);
}

async function commandDoctor(options) {
  const summary = await buildDoctorSummary();
  printJsonOrMarkdown(summary, options);
  if (!summary.ok && options.strict !== 'false') process.exitCode = 2;
}

async function commandPreflightLive(options) {
  const doctor = await buildDoctorSummary();
  const pending = await readPending();
  const mode = releaseMode();
  const checks = [
    ...doctor.checks,
    { name: 'release-mode:live', ok: isLiveMode(mode), mode },
    { name: 'live:armed', ok: process.env.NIKECHAN_X_LIVE_ARMED === 'yes' },
    { name: 'pending:self-tweet', ok: Boolean(pending), pendingId: pending?.id || null },
  ];
  if (pending) {
    checks.push({
      name: 'pending:guard',
      ok: pending.candidates.every((candidate) => candidate.guard?.ok),
      blocked: pending.candidates.filter((candidate) => !candidate.guard?.ok).map((candidate) => candidate.id),
    });
  }
  const summary = {
    ok: checks.every((check) => check.ok),
    releaseMode: mode,
    liveArmed: process.env.NIKECHAN_X_LIVE_ARMED === 'yes',
    pendingId: pending?.id || null,
    checks,
  };
  printJsonOrMarkdown(summary, options);
  if (!summary.ok && options.strict !== 'false') process.exitCode = 2;
}

async function commandReleaseMode(options) {
  const nextMode = options.set || options.mode;
  if (!nextMode) {
    printJsonOrMarkdown({
      releaseMode: releaseMode(),
      liveArmed: process.env.NIKECHAN_X_LIVE_ARMED === 'yes',
      envPath: resolve(ROOT, '.env'),
    }, options);
    return;
  }

  const validation = validateReleaseModeChange(nextMode, options.confirm || '');
  if (!validation.ok) throw new Error(validation.reason);

  const envPath = resolve(ROOT, '.env');
  await setEnvValues(envPath, {
    NIKECHAN_X_RELEASE_MODE: validation.mode,
    NIKECHAN_X_LIVE_ARMED: validation.liveArmed ? 'yes' : 'no',
  });
  process.env.NIKECHAN_X_RELEASE_MODE = validation.mode;
  process.env.NIKECHAN_X_LIVE_ARMED = validation.liveArmed ? 'yes' : 'no';

  await recordActivity('release-mode', {
    mode: validation.mode,
    liveArmed: validation.liveArmed,
  });
  await updateRunState({
    lastReleaseModeChangeAt: new Date().toISOString(),
    configuredReleaseMode: validation.mode,
    liveArmed: validation.liveArmed,
  });
  printJsonOrMarkdown({
    ok: true,
    releaseMode: validation.mode,
    liveArmed: validation.liveArmed,
    envPath,
  }, options);
}

async function buildDoctorSummary() {
  const checks = [];
  const requireEnv = (name) => {
    const ok = Boolean(process.env[name]);
    checks.push({ name: `env:${name}`, ok });
    return ok;
  };

  requireEnv('XAI_API_KEY');
  requireEnv('X_CONSUMER_KEY');
  requireEnv('X_CONSUMER_SECRET');
  requireEnv('X_ACCESS_TOKEN');
  requireEnv('X_ACCESS_TOKEN_SECRET');
  requireEnv('SUPABASE_URL');
  requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  requireEnv('DISCORD_BOT_TOKEN');
  requireEnv('DISCORD_HOME_CHANNEL');
  requireEnv('DISCORD_ALLOWED_USERS');

  checks.push(await checkSupabase());
  checks.push(await checkXMe());
  checks.push(await checkDiscordBot());

  return {
    ok: checks.every((check) => check.ok),
    releaseMode: releaseMode(),
    liveArmed: process.env.NIKECHAN_X_LIVE_ARMED === 'yes',
    accountName: ACCOUNT_NAME,
    checks,
  };
}

async function postTweet(input) {
  const mode = releaseMode();
  const action = input.action;
  if (!['tweet', 'reply', 'quote', 'retweet'].includes(action)) {
    throw new Error(`unsupported action: ${action}`);
  }
  if (['reply', 'quote', 'retweet'].includes(action)) {
    required(input.tweetId, '--tweet-id');
  }
  if (['tweet', 'reply', 'quote'].includes(action)) {
    const guard = guardText(input.text);
    if (!guard.ok) {
      throw new Error(`text blocked by guard: ${guard.errors.join('; ')}`);
    }
  }
  if (mode !== 'live' && mode !== 'canary-live') {
    return { dryRun: true, mode, action, text: input.text, tweetId: input.tweetId || null, url: null, source: input.source };
  }
  assertLivePostingAllowed(mode);

  const result = await callXApi(input);
  await recordTweet(result);
  return result;
}

async function callXApi(input) {
  const action = input.action;
  if (action === 'tweet') {
    const response = await signedFetch('POST', 'https://api.twitter.com/2/tweets', {}, { text: input.text });
    const id = response.data?.id;
    return { action, tweetId: id, content: input.text, url: tweetUrl(id), source: input.source };
  }
  if (action === 'reply') {
    const tweetId = required(input.tweetId, '--tweet-id');
    const response = await signedFetch('POST', 'https://api.twitter.com/2/tweets', {}, {
      text: input.text,
      reply: { in_reply_to_tweet_id: tweetId },
    });
    const id = response.data?.id;
    return { action, tweetId: id, content: input.text, inReplyToId: tweetId, url: tweetUrl(id), source: input.source };
  }
  if (action === 'quote') {
    const tweetId = required(input.tweetId, '--tweet-id');
    const response = await signedFetch('POST', 'https://api.twitter.com/2/tweets', {}, {
      text: input.text,
      quote_tweet_id: tweetId,
    });
    const id = response.data?.id;
    return { action, tweetId: id, content: input.text, quoteOfId: tweetId, url: tweetUrl(id), source: input.source };
  }
  if (action === 'retweet') {
    const tweetId = required(input.tweetId, '--tweet-id');
    const me = await signedFetch('GET', 'https://api.twitter.com/2/users/me');
    const userId = me.data?.id;
    if (!userId) throw new Error('X API did not return current user id');
    await signedFetch('POST', `https://api.twitter.com/2/users/${userId}/retweets`, {}, { tweet_id: tweetId });
    return { action, tweetId, content: '', url: `https://x.com/i/status/${tweetId}`, source: input.source };
  }
}

async function signedFetch(method, url, query = {}, body) {
  const credentials = {
    consumerKey: process.env.X_CONSUMER_KEY,
    consumerSecret: process.env.X_CONSUMER_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
  };
  for (const [key, value] of Object.entries(credentials)) {
    if (!value) throw new Error(`missing X credential: ${key}`);
  }
  const finalUrl = new URL(url);
  for (const [key, value] of Object.entries(query || {})) finalUrl.searchParams.set(key, value);
  const auth = oauthHeader(method, finalUrl, credentials);
  const response = await fetch(finalUrl, {
    method,
    headers: {
      Authorization: auth,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`X API failed ${response.status}: ${truncate(text, 500)}`);
  }
  return parsed;
}

async function checkSupabase() {
  const result = await supabaseGet('tweets?select=id&limit=1');
  return {
    name: 'supabase:read',
    ok: result.status === 'loaded',
    status: result.status,
    code: result.code,
    reason: result.reason,
  };
}

async function checkXMe() {
  if (!process.env.X_CONSUMER_KEY || !process.env.X_CONSUMER_SECRET || !process.env.X_ACCESS_TOKEN || !process.env.X_ACCESS_TOKEN_SECRET) {
    return { name: 'x:users/me', ok: false, status: 'missing-env' };
  }
  try {
    const result = await signedFetch('GET', 'https://api.twitter.com/2/users/me');
    return {
      name: 'x:users/me',
      ok: Boolean(result.data?.id),
      accountId: result.data?.id || null,
      username: result.data?.username || null,
    };
  } catch (error) {
    return { name: 'x:users/me', ok: false, error: truncate(error.message, 300) };
  }
}

async function checkDiscordBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return { name: 'discord:bot', ok: false, status: 'missing-env' };
  try {
    const response = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
    });
    const text = await response.text();
    if (!response.ok) {
      return { name: 'discord:bot', ok: false, code: response.status, body: truncate(text, 300) };
    }
    const parsed = text ? JSON.parse(text) : {};
    return { name: 'discord:bot', ok: Boolean(parsed.id), botId: parsed.id || null, username: parsed.username || null };
  } catch (error) {
    return { name: 'discord:bot', ok: false, error: truncate(error.message, 300) };
  }
}

function oauthHeader(method, url, credentials) {
  const oauth = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credentials.accessToken,
    oauth_version: '1.0',
  };
  const params = new URLSearchParams(url.search);
  for (const [key, value] of Object.entries(oauth)) params.append(key, value);
  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
  const parameterString = [...params.entries()]
    .sort(([aKey, aValue], [bKey, bValue]) => aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey))
    .map(([key, value]) => `${encodeOAuth(key)}=${encodeOAuth(value)}`)
    .join('&');
  const baseString = [method.toUpperCase(), encodeOAuth(baseUrl), encodeOAuth(parameterString)].join('&');
  const signingKey = `${encodeOAuth(credentials.consumerSecret)}&${encodeOAuth(credentials.accessSecret)}`;
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');
  return 'OAuth ' + Object.entries({ ...oauth, oauth_signature: signature })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeOAuth(key)}="${encodeOAuth(value)}"`)
    .join(', ');
}

function encodeOAuth(value) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function recordTweet(result) {
  if (!result?.tweetId) return;
  await supabaseInsert('tweets', {
    tweet_id: result.tweetId,
    content: result.content || '',
    action_type: result.action,
    in_reply_to_id: result.inReplyToId || null,
    quote_of_id: result.quoteOfId || null,
    source: result.source || 'manual',
    url: result.url || tweetUrl(result.tweetId),
  });
}

async function recordActivity(stage, parsed) {
  const entry = {
    at: new Date().toISOString(),
    workflow: 'self-tweet',
    stage,
    parsed,
  };
  await ensureDir(STATE_DIR);
  await appendFile(statePath('activity.jsonl'), `${JSON.stringify(entry)}\n`);
  await supabaseInsert('twitter_activity_logs', {
    workflow: 'self-tweet',
    stage,
    raw_content: JSON.stringify(parsed).slice(0, 3000),
    parsed,
    status: stage === 'error' ? 'failed' : stage === 'execute' ? 'success' : 'needs_approval',
    created_by: 'nikechan-x-hermes',
  });
}

async function recordTwitterRunState(key, value) {
  await supabaseUpsert('twitter_run_state', { key, value, updated_at: new Date().toISOString() }, 'key');
}

async function recordTopic(text) {
  const topic = truncate(text.replace(/https?:\/\/\S+/g, '').trim(), 120);
  if (!topic) return;
  await supabaseInsert('topics', { topic, source: 'self-tweet' });
}

async function recordLocalEpisode(content) {
  await supabaseInsert('local_episodes', {
    date: jstDate(),
    content: truncate(content, 150),
    source: 'twitter',
  });
}

async function supabaseGet(path) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return { status: 'unavailable', reason: 'supabase env missing', path };
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/rest/v1/${path}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    const text = await response.text();
    if (!response.ok) return { status: 'error', code: response.status, body: truncate(text, 500), path };
    return { status: 'loaded', data: text ? JSON.parse(text) : null, path };
  } catch (error) {
    return { status: 'error', error: error.message, path };
  }
}

async function supabaseInsert(table, row) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return { status: 'skipped', reason: 'supabase env missing' };
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!response.ok) return { status: 'error', table, code: response.status, body: await response.text() };
    return { status: 'inserted', table };
  } catch (error) {
    return { status: 'error', table, error: error.message };
  }
}

async function supabaseUpsert(table, row, onConflict) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return { status: 'skipped', reason: 'supabase env missing' };
  const url = new URL(`${base.replace(/\/$/, '')}/rest/v1/${table}`);
  if (onConflict) url.searchParams.set('on_conflict', onConflict);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!response.ok) return { status: 'error', table, code: response.status, body: await response.text() };
    return { status: 'upserted', table };
  } catch (error) {
    return { status: 'error', table, error: error.message };
  }
}

function printPendingMarkdown(pending) {
  console.log(formatPendingMarkdown(pending));
}

function formatPendingMarkdown(pending) {
  const lines = [];
  lines.push(`self-tweet候補 pending=${pending.id}`);
  lines.push(`sourceMode: ${pending.sourceMode}`);
  lines.push('');
  for (const candidate of pending.candidates) {
    const status = candidate.guard.ok ? 'OK' : `BLOCKED: ${candidate.guard.errors.join('; ')}`;
    lines.push(`${candidate.id}. ${candidate.text}`);
    if (candidate.reason) lines.push(`   狙い: ${candidate.reason}`);
    lines.push(`   guard: ${status}`);
    if (candidate.guard.warnings.length) lines.push(`   warning: ${candidate.guard.warnings.join('; ')}`);
    lines.push('');
  }
  lines.push('承認する場合: node scripts/nikechan-x.mjs approve --ids <番号>');
  lines.push('見送る場合: node scripts/nikechan-x.mjs cancel --reason "<理由>"');
  return lines.join('\n');
}

function readOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      options._ = options._ || [];
      options._.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

async function loadDotenv(path) {
  if (!existsSync(path)) return;
  const text = await readFile(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

async function setEnvValues(path, values) {
  const existing = existsSync(path) ? await readFile(path, 'utf8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const remaining = new Set(Object.keys(values));
  const next = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/u);
    if (!match || !(match[1] in values)) return line;
    const key = match[1];
    remaining.delete(key);
    return `${key}=${values[key]}`;
  });
  for (const key of remaining) {
    next.push(`${key}=${values[key]}`);
  }
  await writeFile(path, `${next.filter((line, index) => line !== '' || index < next.length - 1).join('\n')}\n`, { mode: 0o600 });
}

function releaseMode() {
  return process.env.NIKECHAN_X_RELEASE_MODE || 'dry-run';
}

function assertLivePostingAllowed(mode) {
  if (!isLiveMode(mode)) return;
  if (process.env.NIKECHAN_X_LIVE_ARMED !== 'yes') {
    throw new Error('live posting blocked: set NIKECHAN_X_LIVE_ARMED=yes via release-mode --set live --confirm LIVE_X_POSTING');
  }
}

function statePath(name) {
  return resolve(STATE_DIR, name);
}

async function readPending() {
  return readJson(statePath('pending-self-tweet.json'), null);
}

async function setPendingThread(pending, thread) {
  const next = {
    ...pending,
    channel: thread.channel,
    messageId: thread.messageId,
    threadId: thread.threadId,
    threadName: thread.threadName,
    notifiedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(statePath('pending-self-tweet.json'), next);
  return next;
}

async function removePending() {
  const path = statePath('pending-self-tweet.json');
  if (!existsSync(path)) return;
  await rename(path, statePath(`pending-self-tweet.${Date.now()}.closed.json`));
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value) {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

async function updateRunState(patch) {
  const current = await readJson(statePath('run-state.json'), {});
  await writeJsonAtomic(statePath('run-state.json'), {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

function required(value, name) {
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function tweetUrl(id) {
  return `https://x.com/${ACCOUNT_NAME}/status/${id}`;
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

async function sendDiscordMessage(channel, content) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('missing DISCORD_BOT_TOKEN');
  const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channel)}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: truncate(content, 1900),
      allowed_mentions: { parse: [] },
    }),
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`Discord API failed ${response.status}: ${truncate(text, 500)}`);
  }
  return parsed;
}

async function sendPendingThread(channel, pending, content, options = {}) {
  if (pending.threadId) {
    const message = await sendDiscordMessage(pending.threadId, content);
    return {
      ...message,
      messageId: message.id || null,
      threadId: pending.threadId,
      threadName: pending.threadName || null,
    };
  }
  const seed = await sendDiscordMessage(channel, content);
  const title = sanitizeDiscordThreadName(
    options.threadTitle || `X候補 ${jstDate()} ${pending.id.slice(0, 8)}`,
  );
  const thread = await createDiscordThread(channel, seed.id, title);
  return {
    ...thread,
    messageId: seed.id || null,
    threadId: thread.id || null,
    threadName: thread.name || title,
  };
}

async function createDiscordThread(channel, messageId, name) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('missing DISCORD_BOT_TOKEN');
  if (!messageId) throw new Error('cannot create Discord thread without seed message id');
  const response = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channel)}/messages/${encodeURIComponent(messageId)}/threads`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        auto_archive_duration: 1440,
      }),
    },
  );
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`Discord thread API failed ${response.status}: ${truncate(text, 500)}`);
  }
  return parsed;
}

function sanitizeDiscordThreadName(name) {
  return String(name || 'X候補')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 90) || 'X候補';
}

function jstDate() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printJsonOrMarkdown(value, options) {
  if (options.json) printJson(value);
  else printJson(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
