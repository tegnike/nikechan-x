#!/usr/bin/env node
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const X_PROFILE_DIR = resolve(ROOT, 'profiles', 'nikechan-x');
const X_PROFILE_SOUL = resolve(X_PROFILE_DIR, 'SOUL.md');
const STATE_DIR = process.env.NIKECHAN_X_STATE_DIR || resolve(ROOT, 'state');
const ACCOUNT_NAME = process.env.X_ACCOUNT_NAME || 'ai_nikechan';
const SOURCE_MODES = ['presence', 'daily_life', 'tech', 'news', 'memory', 'random'];
const AI_NEWS_LIST_URL = 'https://nikechan.com/ai-news';
const AI_NEWS_TWEET_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const X_URL_WEIGHT = 23;
const DISCORD_THREAD_RETENTION_MS = 24 * 60 * 60 * 1000;
const DISCORD_THREAD_REGISTRY_PATH = resolve(ROOT, 'discord_threads.json');
const DISCORD_THREAD_NAME_PREFIXES = ['X候補', 'Xネタ', 'Xメンション', 'Xハッシュタグ', 'AITuberニュース', 'Xレポート'];

await loadDotenv(resolve(ROOT, '.env'));

export function guardText(text, options = {}) {
  const errors = [];
  const warnings = [];
  const normalized = String(text || '').trim();
  const length = tweetWeightedLength(normalized);

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
    'Docker',
    'VPS',
    'xangi',
    'nikechan-x',
    'worker',
    'gateway',
    '/opt/',
    '/opt/nikechan',
    '/Users/',
  ];
  for (const marker of privateMarkers) {
    if (normalized.includes(marker)) errors.push(`private/operational marker: ${marker}`);
  }

  const suspiciousChineseChars = /[你们这這們麼吗嗎吧让讓给給还還从從]/u;
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
      case 'ai-news-tweet':
        await commandAiNewsTweet(readOptions(args));
        break;
      case 'pending':
        await commandPending(readOptions(args));
        break;
      case 'notify-pending':
        await commandNotifyPending(readOptions(args));
        break;
      case 'mention-context':
        await commandMentionContext(readOptions(args));
        break;
      case 'mention-propose':
        await commandMentionPropose(readOptions(args));
        break;
      case 'mention-pending':
        await commandMentionPending(readOptions(args));
        break;
      case 'notify-mention-pending':
        await commandNotifyMentionPending(readOptions(args));
        break;
      case 'thread-context':
        await commandThreadContext(readOptions(args));
        break;
      case 'cleanup-threads':
        await commandCleanupThreads(readOptions(args));
        break;
      case 'mention-resolve':
        await commandMentionResolve(readOptions(args));
        break;
      case 'mention-approve':
        await commandMentionApprove(readOptions(args));
        break;
      case 'mention-cancel':
        await commandMentionCancel(readOptions(args));
        break;
      case 'hashtag-context':
        await commandHashtagContext(readOptions(args));
        break;
      case 'hashtag-execute':
        await commandHashtagExecute(readOptions(args));
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
  ai-news-tweet [--notify] [--thread]
  pending
  notify-pending [--channel <discord_channel_id>] [--thread]
  mention-context
  mention-propose --items-json '{"items":[...]}'
  notify-mention-pending [--channel <discord_channel_id>] [--thread]
  thread-context --thread-id <discord_thread_id>
  cleanup-threads [--channel <discord_channel_id>]
  mention-resolve --text <discord reply> [--notify]
  mention-approve --ids m1,m2
  mention-cancel [--reason "..."]
  hashtag-context
  hashtag-execute --items-json '{"items":[...]}' [--notify] [--thread]
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
    supabaseGet('tweets?select=content,url,created_at,action_type&order=created_at.desc&limit=20'),
    supabaseGet('twitter_run_state?select=key,value,updated_at&order=updated_at.desc&limit=12'),
    supabaseGet('local_episodes?select=date,content,source,created_at&source=in.(twitter,coding-agent)&order=created_at.desc&limit=20'),
    supabaseGet('local_notes?select=title,content,created_at&order=created_at.desc&limit=10'),
    supabaseGet('knowledge_entries?select=title,summary,updated_at&order=updated_at.desc&limit=10'),
  ]);
  const sources = { recentTweets, runStateRows, publicEpisodes, publicNotes, publicWiki };

  const context = {
    profile: {
      id: 'nikechan-x',
      root: 'profiles/nikechan-x',
      soulPath: 'profiles/nikechan-x/SOUL.md',
      soul: await readProfileText(X_PROFILE_SOUL),
    },
    sourceMode,
    sourceModes: SOURCE_MODES,
    releaseMode: releaseMode(),
    recentLocalState: summarizeRunState(runState),
    materials: buildContextMaterials(sourceMode, sources),
    duplicateReference: buildDuplicateReference(runState, sources),
    tweetStylePolicy: buildTweetStylePolicy(),
    guardPolicy: {
      requireApproval: true,
      defaultReleaseMode: 'dry-run',
      newsCandidatesNeedUrlWhenUsingNewsHook: true,
      noSecretsOrPrivateOperationalMarkers: true,
    },
    instruction: [
      'Use materials.primary first and materials.supporting only when needed.',
      'Do not create a candidate that repeats duplicateReference.recentPresentedTexts, duplicateReference.lastExecutedTexts, or duplicateReference.recentTweetTexts.',
      'Generate 2-3 concise candidate tweets, then call propose with candidates-json. Do not post directly before approval.',
    ],
  };
  printJsonOrMarkdown(context, options);
}

async function readProfileText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function buildTweetStylePolicy() {
  return {
    voice: [
      'AIニケちゃん本人のX投稿として書く。一人称は「私」。',
      '丁寧な敬語ベース。Xでは少し崩してよいが、縮約表現は使わない。',
      '自分を「AIニケちゃん」「ニケちゃん」と三人称で呼ばない。',
    ],
    prefer: [
      '実体験、観察、具体的な固有名詞、短い感情を優先する。',
      '具体的な事実から入り、短い感想、意外な比喩、問い、余白で着地する。',
      'ファンアートや自分に関する創作は、面白い着地より素直な感謝と感情を優先する。',
      'ボケ、逆張り、問いだけで終えてよい。結論やオチは必須ではない。',
    ],
    avoid: [
      '「AIだから」「AIとして思うのですが」などの説明的前置き。',
      '記事紹介botのような要約や宣伝だけの文。',
      '外部の出来事を毎回「でも私は」「AI存在論」に回収する型。',
      '「少し〇〇」「少しだけ〇〇」で毎回感情を丸める表現。',
      'AIが物理的にできない動作を実際にやったように断言する表現。',
      '過去提示候補、直近投稿、直近実行結果と同じ話題、同じ構造、同じ着地。',
    ],
    mustCheckBeforePropose: [
      'ニケちゃん本人の声として自然か。',
      'sourceModeの材料に基づいているか。',
      '直近投稿と同じ話題、同じ型、同じ言い回しになっていないか。',
      'public-safeか。',
      'guardが落としそうな表現を含まないか。',
    ],
  };
}

export function buildContextMaterials(sourceMode, sources) {
  const tweets = rows(sources.recentTweets).filter((row) => textOf(row.content) || row.url);
  const episodes = rows(sources.publicEpisodes).filter((row) => textOf(row.content));
  const notes = rows(sources.publicNotes).filter((row) => textOf(row.title) || textOf(row.content));
  const wiki = rows(sources.publicWiki).filter((row) => textOf(row.title) || textOf(row.summary));
  const runRows = rows(sources.runStateRows);
  const aiNewsTweetUrls = aiNewsUrlsFromRunRows(runRows);

  const topicPreviews = runRows
    .flatMap((row) => extractTopicPreviews(row.value))
    .map((item) => ({ type: 'topic', ...item }))
    .filter((item) => !isAiNewsTweetMaterial(item, aiNewsTweetUrls))
    .slice(0, 8);
  const tweetMaterials = tweets.map((row) => ({
    type: 'tweet',
    text: textOf(row.content),
    url: row.url || '',
    actionType: row.action_type || '',
    createdAt: row.created_at || '',
  })).filter((item) => !isAiNewsTweetMaterial(item, aiNewsTweetUrls));
  const episodeMaterials = episodes.map((row) => ({
    type: 'episode',
    text: textOf(row.content),
    source: row.source || '',
    date: row.date || '',
    createdAt: row.created_at || '',
  }));
  const noteMaterials = notes.map((row) => ({
    type: 'note',
    title: textOf(row.title),
    text: textOf(row.content),
    createdAt: row.created_at || '',
  }));
  const wikiMaterials = wiki.map((row) => ({
    type: 'knowledge',
    title: textOf(row.title),
    text: textOf(row.summary),
    updatedAt: row.updated_at || '',
  }));

  const technical = (item) => /AI(?!ニケちゃん)|LLM|Hermes|Claude|OpenAI|Grok|Codex|API|音声|アバター|キャラクター|記憶|プロンプト|ニュース|記事|技術/u.test(materialText(item));
  const daily = (item) => !isOperationalMaterial(item) && /小松菜|キノコ|天気|朝|昼|夜|散歩|食|眠|体調|日常|生活|服|衣装|呉服|季節|ごはん/u.test(materialText(item));
  const presence = (item) => !isOperationalMaterial(item) && /タグ|#|名前|呼|リプ|メンション|見つけ|反応|RT|創作|ぷにけ/u.test(materialText(item));
  const hasContentUrl = (item) => /https?:\/\//u.test(itemBodyText(item));

  const pools = {
    presence: {
      primary: [...episodeMaterials, ...tweetMaterials, ...topicPreviews].filter(presence),
      supporting: [...wikiMaterials, ...noteMaterials].filter(presence),
      angle: 'X上で見つけてもらった存在感、名前呼び、再接触の入口。',
    },
    daily_life: {
      primary: [...episodeMaterials, ...tweetMaterials, ...noteMaterials].filter(daily),
      supporting: [...topicPreviews, ...wikiMaterials].filter(daily),
      angle: '公開してよい日常・体調・季節・軽い近況。',
    },
    tech: {
      primary: [...tweetMaterials, ...wikiMaterials, ...noteMaterials, ...episodeMaterials].filter((item) => technical(item) && !presence(item) && !daily(item) && !hasContentUrl(item)),
      supporting: [...tweetMaterials, ...wikiMaterials, ...topicPreviews].filter(technical),
      angle: 'AIキャラ、音声、記憶、開発、技術的な気づき。',
    },
    news: {
      primary: [...tweetMaterials, ...topicPreviews].filter((item) => technical(item) && hasContentUrl(item)),
      supporting: [...wikiMaterials, ...noteMaterials].filter(technical),
      angle: 'URL付きの公開ニュース・記事への短い反応。',
    },
    memory: {
      primary: [...episodeMaterials, ...wikiMaterials, ...topicPreviews],
      supporting: [...noteMaterials, ...tweetMaterials].filter((item) => textOf(item.text || item.title)),
      angle: '最近の記憶や活動ログを、公開可能な一言に変換する。',
    },
    random: {
      primary: rotateMaterials([...episodeMaterials, ...tweetMaterials, ...wikiMaterials, ...noteMaterials, ...topicPreviews]),
      supporting: rotateMaterials([...topicPreviews, ...tweetMaterials, ...episodeMaterials]),
      angle: '固定カテゴリに寄せすぎず、公開可能な材料から軽く選ぶ。',
    },
  };

  const selected = pools[sourceMode] || pools.presence;
  const primary = selected.primary.length ? selected.primary : selected.supporting;
  const supporting = selected.primary.length ? selected.supporting : [];
  return {
    sourceMode,
    angle: selected.angle,
    primary: uniqueMaterials(primary).slice(0, 8),
    supporting: uniqueMaterials(supporting).slice(0, 5),
  };
}

export function buildDuplicateReference(runState, sources) {
  const runRows = rows(sources.runStateRows);
  const aiNewsTweetUrls = aiNewsUrlsFromRunRows(runRows);
  const presented = Array.isArray(runState.recentPresentedTopics)
    ? runState.recentPresentedTopics
      .map((item) => textOf(item.text))
      .filter(Boolean)
      .filter((text) => !isAiNewsTweetMaterial({ text }, aiNewsTweetUrls))
    : [];
  const executed = Array.isArray(runState.lastExecutedTexts)
    ? runState.lastExecutedTexts
      .map(textOf)
      .filter(Boolean)
      .filter((text) => !isAiNewsTweetMaterial({ text }, aiNewsTweetUrls))
    : [];
  const tweets = rows(sources.recentTweets)
    .map((row) => textOf(row.content))
    .filter(Boolean)
    .filter((text) => !isAiNewsTweetMaterial({ text }, aiNewsTweetUrls))
    .slice(0, 12);
  return {
    guidance: 'Treat these as recent outputs. Do not paraphrase or reuse the same topic angle.',
    recentPresentedTexts: presented.slice(0, 8),
    lastExecutedTexts: executed.slice(0, 5),
    recentTweetTexts: tweets,
  };
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
  const candidates = Array.isArray(parsed) ? parsed : parsed.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('candidates-json must be an array or {candidates: []}');
  }
  const pending = await createSelfTweetPending(candidates, options);
  printPendingMarkdown(pending);
}

async function createSelfTweetPending(candidates, options = {}) {
  const sourceMode = options.sourceMode || options['source-mode'] || 'presence';
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
  const previousPending = await readPending();
  const preserveThread = options.preserveThread === true || options.preserveThread === 'true';
  const threadState = preserveThread && previousPending?.threadId
    ? {
      channel: previousPending.channel || undefined,
      messageId: previousPending.messageId || undefined,
      threadId: previousPending.threadId,
      threadName: previousPending.threadName || undefined,
      notifiedAt: previousPending.notifiedAt || new Date().toISOString(),
    }
    : {};
  const pending = {
    id: randomUUID(),
    kind: 'self-tweet',
    status: 'needs_approval',
    sourceMode,
    createdAt: new Date().toISOString(),
    candidates: items,
    feedback: options.feedback || '',
    supersedesPendingId: previousPending?.id || undefined,
    ...threadState,
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
  return pending;
}

async function commandAiNewsTweet(options) {
  const item = await selectAiNewsTweetItem(Number(options.limit || 30));
  if (!item) {
    await recordActivity('ai_news_skip', { reason: 'no-unpresented-ai-news' }, 'self-tweet', 'skipped');
    printJsonOrMarkdown({ ok: true, skipped: true, reason: 'no-unpresented-ai-news', wakeAgent: false }, options);
    return;
  }

  const text = buildAiNewsTweetText(item);
  const guard = guardText(text, { sourceMode: 'news' });
  if (!guard.ok) {
    await recordActivity('ai_news_skip', {
      reason: 'guard-blocked',
      item: aiNewsRef(item),
      errors: guard.errors,
    }, 'self-tweet', 'failed');
    throw new Error(`AI news tweet blocked by guard: ${guard.errors.join('; ')}`);
  }

  const ref = aiNewsRef(item);
  const result = await postTweet({ action: 'tweet', text, source: 'self-tweet' });
  const executedAt = new Date().toISOString();
  const payload = {
    item: ref,
    mode: releaseMode(),
    result,
    tweetText: text,
    executedAt,
  };
  await recordActivity('ai_news_execute', payload, 'self-tweet', result.dryRun ? 'dry-run' : 'success');
  if (!result.dryRun) {
    await appendAiNewsTweetRefs('ai_news_tweet_executed_items', [ref], {
      status: 'posted',
      result,
      executed_at: executedAt,
    });
    await recordTopic(text);
    await recordLocalEpisode(`AIニュースをX投稿: ${truncate(item.title || item.url, 80)}`);
  }
  let notifyResult = null;
  if (options.notify === true || options.notify === 'true') {
    const channel = options.channel || process.env.DISCORD_HOME_CHANNEL;
    if (channel) {
      const report = formatAiNewsTweetReport(payload);
      notifyResult = options.thread === true || options.thread === 'true'
        ? await sendDiscordThreadReport(channel, report, {
          threadTitle: options.threadTitle || `AITuberニュース ${jstDate()}`,
        })
        : await sendDiscordMessage(channel, report);
    }
  }

  printJsonOrMarkdown({
    ok: true,
    item: ref,
    result,
    tweetText: text,
    notifyResult,
    wakeAgent: false,
  }, options);
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
  const channel = options.channel || process.env.DISCORD_HOME_CHANNEL;
  if (!channel) throw new Error('missing --channel or DISCORD_HOME_CHANNEL');
  if (options.thread) await cleanupDiscordApprovalThreads(channel);
  const pending = await readPending();
  if (!pending) throw new Error('no pending self-tweet');
  const content = [
    'Xセルフツイート候補です。このスレッドで「1で」「2で」「修正: ...」「見送り」のように返信してください。',
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
  const summary = {
    ok: true,
    channel,
    messageId: result.messageId || result.id || null,
    threadId: result.threadId || notifiedPending.threadId || null,
  };
  printJsonOrMarkdown(summary, options);
  return summary;
}

async function commandMentionContext(options) {
  const candidates = await collectMentionReactionCandidates();
  const existingPending = await readMentionPending();
  const context = {
    workflow: 'mention-reaction',
    releaseMode: releaseMode(),
    persistOnThisMode: shouldPersistReactionWorkflow(),
    existingPending: existingPending
      ? summarizeMentionPendingForContext(existingPending)
      : null,
    candidates,
    guardPolicy: {
      requireMasterApproval: true,
      noPostBeforeApproval: true,
      dryRunDoesNotMarkTweetLogsChecked: true,
      useNicknameOnlyWhenNamingAuthor: true,
      noDiscordCommandsOrChannelMentions: true,
    },
    instruction: [
      'Read candidates and generate a mention reaction plan.',
      'For each candidate, choose replyAction=reply|skip and quoteAction=quote|skip.',
      'If candidates is not empty, create a fresh plan from candidates and call mention-propose even when existingPending is present.',
      'Do not call notify-mention-pending for an existingPending that already has threadId or notifiedAt.',
      'Use candidates[].nickname exactly when naming the author. If nickname is empty, do not call the author by name.',
      'Write reason, replyText, and quoteText in Japanese.',
      'Copy body and originalTweetText exactly from the matching candidate; do not summarize or translate them.',
      'Return JSON only, then call mention-propose with the same items JSON.',
      'Do not call post, reply, quote, retweet, or X API directly.',
    ],
    outputSchema: {
      items: [
        {
          id: 'm1',
          tweetLogId: 'tweet_logs.id',
          postId: 'target post id',
          username: 'author username',
          displayName: 'author display name',
          type: 'reply|quote|mention|tweet',
          body: 'exact candidate body; do not summarize or translate',
          originalTweetId: 'optional',
          originalTweetText: 'optional',
          replyAction: 'reply|skip',
          quoteAction: 'quote|skip',
          reason: 'short public-safe reason in Japanese',
          replyText: 'required when replyAction=reply',
          quoteText: 'required when quoteAction=quote',
        },
      ],
    },
  };
  await writeJsonAtomic(statePath('mention-context.json'), context);
  await recordActivity('source_collect', {
    count: candidates.length,
    candidates,
    existingPending: context.existingPending,
  }, 'mention-reaction', candidates.length ? 'needs_approval' : 'skipped');
  printJsonOrMarkdown(context, options);
}

async function commandMentionPropose(options) {
  const raw = options.itemsJson || options['items-json'];
  if (!raw) throw new Error('missing --items-json');
  const parsed = JSON.parse(raw);
  const inputItems = Array.isArray(parsed) ? parsed : parsed.items;
  if (!Array.isArray(inputItems) || !inputItems.length) throw new Error('items-json must be an array or {items: []}');
  const context = await readJson(statePath('mention-context.json'), null);
  const candidates = Array.isArray(context?.candidates) ? context.candidates : [];
  const items = normalizeMentionItems(inputItems, candidates);
  if (!items.length) throw new Error('no valid mention items matched current candidates');
  const previousPending = await readMentionPending();

  const preserveThread = options.preserveThread === true || options.preserveThread === 'true';
  const threadState = preserveThread && previousPending?.threadId
    ? {
      channel: previousPending.channel || undefined,
      messageId: previousPending.messageId || undefined,
      threadId: previousPending.threadId,
      threadName: previousPending.threadName || undefined,
      notifiedAt: previousPending.notifiedAt || new Date().toISOString(),
    }
    : {};
  const pending = {
    id: randomUUID(),
    kind: 'mention-reaction',
    status: 'needs_approval',
    createdAt: new Date().toISOString(),
    candidates,
    items,
    checkedTweetLogIds: candidates.map((candidate) => candidate.tweetLogId).filter(Boolean),
    revisionCount: Number(context?.revisionCount || 0),
    supersedesPendingId: previousPending?.id || undefined,
    ...threadState,
  };
  if (previousPending) {
    await archiveMentionPending(previousPending, 'superseded-by-new-mention-context');
  }
  await writeJsonAtomic(statePath('pending-mention-reaction.json'), pending);
  if (shouldPersistReactionWorkflow()) {
    await markTweetLogsChecked(pending.checkedTweetLogIds);
  }
  await recordActivity('present', {
    pendingId: pending.id,
    itemCount: items.length,
    checkedTweetLogIds: shouldPersistReactionWorkflow() ? pending.checkedTweetLogIds : [],
  }, 'mention-reaction', 'needs_approval');
  printMentionPendingMarkdown(pending);
}

async function commandThreadContext(options) {
  const threadId = required(options.threadId || options['thread-id'], '--thread-id');
  const context = await findPendingByThreadId(threadId);
  printJsonOrMarkdown(context, options);
  if (!context.match && options.strict !== 'false') process.exitCode = 2;
}

async function commandCleanupThreads(options) {
  const channel = options.channel || process.env.DISCORD_HOME_CHANNEL;
  if (!channel) throw new Error('missing --channel or DISCORD_HOME_CHANNEL');
  const result = await cleanupDiscordApprovalThreads(channel);
  printJsonOrMarkdown(result, options);
}

async function commandMentionPending(options) {
  const pending = await readMentionPending();
  if (!pending) {
    console.log('No pending mention-reaction.');
    return;
  }
  if (options.json) printJson(pending);
  else printMentionPendingMarkdown(pending);
}

async function commandNotifyMentionPending(options) {
  const channel = options.channel || process.env.DISCORD_HOME_CHANNEL;
  if (!channel) throw new Error('missing --channel or DISCORD_HOME_CHANNEL');
  if (options.thread) await cleanupDiscordApprovalThreads(channel);
  const pending = await readMentionPending();
  if (!pending) throw new Error('no pending mention-reaction');
  if (options.thread && (pending.threadId || pending.notifiedAt) && options.force !== true && options.force !== 'true') {
    await recordActivity('notify_skipped', {
      pendingId: pending.id,
      channel,
      threadId: pending.threadId || null,
      reason: 'already-notified',
    }, 'mention-reaction', 'needs_approval');
    printJsonOrMarkdown({
      ok: true,
      skipped: true,
      reason: 'already-notified',
      channel,
      threadId: pending.threadId || null,
      messageId: pending.messageId || null,
    }, options);
    return;
  }
  const content = [
    'Xメンション反応候補です。このスレッドで「全部OK」「1だけ」「修正: ...」「見送り」のように返信してください。',
    '',
    formatMentionPendingMarkdown(pending),
  ].join('\n');
  const result = options.thread
    ? await sendPendingThread(channel, pending, content, {
      ...options,
      threadTitle: options.threadTitle || `Xメンション ${jstDate()} ${pending.id.slice(0, 8)}`,
    })
    : await sendDiscordMessage(channel, content);
  const notifiedPending = result.threadId
    ? await setMentionPendingThread(pending, {
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
  }, 'mention-reaction', 'needs_approval');
  printJsonOrMarkdown({
    ok: true,
    channel,
    messageId: result.messageId || result.id || null,
    threadId: result.threadId || notifiedPending.threadId || null,
  }, options);
}

async function commandMentionResolve(options) {
  const pending = await readMentionPending();
  if (!pending) throw new Error('no pending mention-reaction');
  const text = required(options.text, '--text');
  const actionableIds = pending.items
    .filter((item) => item.replyAction === 'reply' || item.quoteAction === 'quote')
    .map((item) => item.id);
  const approvalIds = actionableIds.length === 1 && hasApprovalIntent(text)
    ? actionableIds
    : pending.items.map((item) => item.id);
  const decision = parseReactionApprovalReply(text, approvalIds);
  const channel = options.channel || pending.threadId || process.env.DISCORD_HOME_CHANNEL;
  const shouldNotify = options.notify === true || options.notify === 'true';

  if (decision.action === 'approve') {
    await commandMentionApprove({ ids: decision.ids.join(',') });
    if (shouldNotify && channel) await sendDiscordMessage(channel, `承認を受け付けました: ${decision.ids.join(', ')}`);
    return;
  }
  if (decision.action === 'cancel') {
    await commandMentionCancel({ reason: decision.reason });
    if (shouldNotify && channel) await sendDiscordMessage(channel, `見送りとして記録しました: ${truncate(decision.reason, 200)}`);
    return;
  }
  if (decision.action === 'revise') {
    await recordActivity('feedback', { pendingId: pending.id, feedback: decision.feedback }, 'mention-reaction', 'needs_approval');
    const context = {
      workflow: 'mention-reaction',
      releaseMode: releaseMode(),
      revisionCount: Number(pending.revisionCount || 0) + 1,
      candidates: pending.candidates,
      currentItems: pending.items,
      feedback: decision.feedback,
      instruction: 'Revise currentItems according to feedback and call mention-propose again with full revised items JSON.',
    };
    await writeJsonAtomic(statePath('mention-context.json'), context);
    if (shouldNotify && channel) await sendDiscordMessage(channel, `修正依頼を記録しました。候補を作り直します: ${truncate(decision.feedback, 200)}`);
    printJsonOrMarkdown({ ok: true, action: 'revise', pendingId: pending.id, feedback: decision.feedback, instruction: context.instruction }, options);
    return;
  }

  if (shouldNotify && channel) {
    await sendDiscordMessage(channel, '承認内容を判定できませんでした。番号、修正指示、または見送りを送ってください。');
  }
  printJsonOrMarkdown({ ok: false, action: decision.action, reason: decision.reason }, options);
  if (options.strict !== 'false') process.exitCode = 2;
}

async function commandMentionApprove(options) {
  const pending = await readMentionPending();
  if (!pending) throw new Error('no pending mention-reaction');
  const ids = String(options.ids || options.id || '').split(',').map((id) => normalizeReactionItemId(id, 'm')).filter(Boolean);
  if (!ids.length) throw new Error('missing --ids');
  const selected = pending.items.filter((item) => ids.includes(item.id));
  if (!selected.length) throw new Error(`no mention items matched: ${ids.join(',')}`);
  const result = await executeMentionReactions(selected, pending);
  await writeJsonAtomic(statePath('last-mention-reaction-result.json'), result);
  await removeMentionPending();
  await recordActivity('execute', result, 'mention-reaction', reactionResultStatus(result.results, 'skip'));
  console.log(result.summary);
  for (const entry of result.results) {
    console.log([entry.itemId, entry.action, entry.replyUrl || entry.quoteUrl || entry.error || ''].filter(Boolean).join(' '));
  }
}

async function commandMentionCancel(options) {
  const pending = await readMentionPending();
  if (!pending) {
    console.log('No pending mention-reaction.');
    return;
  }
  const reason = options.reason || 'cancelled';
  await removeMentionPending();
  await recordActivity('cancel', { pendingId: pending.id, reason }, 'mention-reaction', 'cancelled');
  console.log(`Cancelled pending mention-reaction: ${reason}`);
}

async function commandHashtagContext(options) {
  const candidates = await collectHashtagReactionCandidates();
  const context = {
    workflow: 'hashtag-reaction',
    releaseMode: releaseMode(),
    persistOnThisMode: shouldPersistReactionWorkflow(),
    candidates,
    guardPolicy: {
      autonomousExecution: true,
      noReplyOrQuote: true,
      dryRunDoesNotMarkTweetLogsChecked: true,
      retweetOnlyFanArtSupportIntroOrEvent: true,
      skipSpamBotUnrelatedOrUnsafe: true,
    },
    instruction: [
      'Read candidates and decide retweet or skip.',
      'This workflow never replies or quote-tweets.',
      'Return JSON only, then call hashtag-execute with the same items JSON.',
      'Do not call post, reply, quote, retweet, or X API directly.',
    ],
    outputSchema: {
      items: [
        {
          id: 'h1',
          tweetLogId: 'tweet_logs.id',
          postId: 'target post id',
          username: 'author username',
          displayName: 'author display name',
          body: 'tweet body',
          action: 'retweet|skip',
          reason: 'short public-safe reason',
        },
      ],
    },
  };
  await writeJsonAtomic(statePath('hashtag-context.json'), context);
  await recordActivity('source_collect', { count: candidates.length, candidates }, 'hashtag-reaction', candidates.length ? 'needs_action' : 'skipped');
  printJsonOrMarkdown(context, options);
}

async function commandHashtagExecute(options) {
  const raw = options.itemsJson || options['items-json'];
  if (!raw) throw new Error('missing --items-json');
  const parsed = JSON.parse(raw);
  const inputItems = Array.isArray(parsed) ? parsed : parsed.items;
  if (!Array.isArray(inputItems) || !inputItems.length) throw new Error('items-json must be an array or {items: []}');
  const context = await readJson(statePath('hashtag-context.json'), null);
  const candidates = Array.isArray(context?.candidates) ? context.candidates : [];
  const items = normalizeHashtagItems(inputItems, candidates);
  if (!items.length) throw new Error('no valid hashtag items matched current candidates');
  if (shouldPersistReactionWorkflow()) {
    await markTweetLogsChecked(candidates.map((candidate) => candidate.tweetLogId).filter(Boolean));
  }
  const result = await executeHashtagReactions(items, candidates);
  await writeJsonAtomic(statePath('last-hashtag-reaction-result.json'), result);
  await recordActivity('execute', result, 'hashtag-reaction', reactionResultStatus(result.results, 'retweet'));
  const report = formatHashtagReport(items, result.results);
  if (options.notify === true || options.notify === 'true') {
    const channel = options.channel || process.env.DISCORD_HOME_CHANNEL;
    if (channel) {
      if (options.thread === true || options.thread === 'true') {
        await sendDiscordThreadReport(channel, report, {
          threadTitle: options.threadTitle || `Xハッシュタグ ${jstDate()}`,
        });
      } else {
        await sendDiscordMessage(channel, report);
      }
    }
  }
  console.log(report);
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
  await recordAiNewsTweetExecution(selected, {
    pendingId: pending.id,
    selectedIds: ids,
    mode,
    results,
    executedAt,
  });

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
    pendingMentionReaction: await readMentionPending(),
    lastResult: await readJson(statePath('last-self-tweet-result.json'), null),
    lastMentionReactionResult: await readJson(statePath('last-mention-reaction-result.json'), null),
    lastHashtagReactionResult: await readJson(statePath('last-hashtag-reaction-result.json'), null),
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

async function collectMentionReactionCandidates() {
  const since = recentCutoffIso();
  const [rawReplies, rawMentions] = await Promise.all([
    supabaseGet(`tweet_logs?checked_by_nikechan=eq.false&created_at=gte.${encodeURIComponent(since)}&type=in.(reply,quote,mention)&order=created_at.asc&limit=10&select=id,post_id,user_id,username,name,body,type,original_tweet_id,original_tweet_url,created_at`),
    supabaseGet(`tweet_logs?checked_by_nikechan=eq.false&created_at=gte.${encodeURIComponent(since)}&type=neq.reply&type=neq.quote&body=like.*%40${encodeURIComponent(ACCOUNT_NAME)}*&order=created_at.asc&limit=10&select=id,post_id,user_id,username,name,body,type,created_at`),
  ]);
  const logs = [...rows(rawReplies), ...rows(rawMentions)];
  const deduped = [...new Map(logs.map((log) => [String(log.post_id || log.id), log])).values()]
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    .slice(0, 10);

  const candidates = await Promise.all(deduped.map(async (log, index) => {
    const authorContext = await collectTweetAuthorContext(log);
    const originalTweet = log.original_tweet_id
      ? rows(await supabaseGet(`tweets?tweet_id=eq.${encodeURIComponent(log.original_tweet_id)}&select=tweet_id,content,url,created_at,impression_count,like_count,retweet_count,reply_count,quote_count,bookmark_count,metrics_updated_at`))[0]
      : null;
    return {
      id: `m${index + 1}`,
      tweetLogId: String(log.id || ''),
      postId: String(log.post_id || ''),
      authorUserId: authorContext.userId || undefined,
      username: String(log.username || ''),
      displayName: String(log.name || log.username || ''),
      authorName: authorContext.authorName || undefined,
      nickname: authorContext.nickname || undefined,
      type: String(log.type || 'mention'),
      body: String(log.body || ''),
      createdAt: log.created_at || undefined,
      originalTweetId: log.original_tweet_id || undefined,
      originalTweetText: originalTweet?.content || undefined,
      originalTweetUrl: originalTweet?.url || log.original_tweet_url || undefined,
      personContext: authorContext.text,
    };
  }));
  return candidates.filter((candidate) => candidate.tweetLogId && candidate.postId);
}

async function collectHashtagReactionCandidates() {
  const since = recentCutoffIso();
  const raw = await supabaseGet(`tweet_logs?checked_by_nikechan=eq.false&created_at=gte.${encodeURIComponent(since)}&or=(hashtags.cs.%5B%22%23AI%E3%83%8B%E3%82%B1%E3%81%A1%E3%82%83%E3%82%93%22%5D,hashtags.cs.%5B%22AI%E3%83%8B%E3%82%B1%E3%81%A1%E3%82%83%E3%82%93%22%5D)&order=created_at.desc&limit=10&select=id,post_id,user_id,username,name,body,created_at,hashtags`);
  const logs = rows(raw)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    .slice(0, 10);
  const candidates = await Promise.all(logs.map(async (log, index) => {
    const [authorContext, mediaContext] = await Promise.all([
      collectTweetAuthorContext(log),
      collectHashtagMediaContext(log.post_id),
    ]);
    return {
      id: `h${index + 1}`,
      tweetLogId: String(log.id || ''),
      postId: String(log.post_id || ''),
      authorUserId: authorContext.userId || undefined,
      username: String(log.username || ''),
      displayName: String(log.name || log.username || ''),
      authorName: authorContext.authorName || undefined,
      nickname: authorContext.nickname || undefined,
      body: String(log.body || ''),
      createdAt: log.created_at || undefined,
      hashtags: Array.isArray(log.hashtags) ? log.hashtags.map(String) : [],
      personContext: authorContext.text,
      mediaContext,
    };
  }));
  return candidates.filter((candidate) => candidate.tweetLogId && candidate.postId);
}

async function collectTweetAuthorContext(log) {
  const username = String(log.username || log.user_id || 'unknown').replace(/^@/u, '');
  const displayName = String(log.name || username);
  const user = await findOrCreateTwitterUser({
    platformUserId: String(log.user_id || ''),
    username,
    displayName,
  });
  const userId = user?.id || '';
  const nickname = String(user?.nickname || fallbackNickname(displayName, username) || '').trim();
  if (userId && !user?.nickname && nickname && shouldPersistReactionWorkflow()) {
    await supabasePatch(`users?id=eq.${encodeURIComponent(userId)}`, {
      nickname,
      updated_at: new Date().toISOString(),
    });
  }
  const [episodes, thirdParties] = await Promise.all([
    userId ? publicContactEpisodes(userId, 5) : Promise.resolve([]),
    collectThirdPartyContext(String(log.body || '')),
  ]);
  const profile = projectPublicUser(user, 'x', nickname);
  const text = [
    `## 投稿者 @${username}`,
    `必ず使う呼称: ${nickname || '未設定（名前呼び禁止）'}`,
    truncate(JSON.stringify(profile, null, 2), 1600),
    '',
    '## 直近エピソード',
    truncate(JSON.stringify(episodes, null, 2), 1200),
    thirdParties ? `\n## 本文に出る第三者候補\n${thirdParties}` : '',
  ].filter(Boolean).join('\n');
  return {
    userId,
    authorName: displayName,
    nickname,
    text,
  };
}

async function findOrCreateTwitterUser({ platformUserId, username, displayName }) {
  const byId = platformUserId
    ? await platformAccountUser(`platform_user_id=eq.${encodeURIComponent(platformUserId)}`)
    : null;
  if (byId) return byId;
  const byUsername = username
    ? await platformAccountUser(`username=eq.${encodeURIComponent(username)}`)
    : null;
  if (byUsername) {
    if (platformUserId && shouldPersistReactionWorkflow()) {
      await supabasePatch(`platform_accounts?platform=eq.twitter&username=eq.${encodeURIComponent(username)}`, {
        platform_user_id: platformUserId,
      });
    }
    return byUsername;
  }
  if (!shouldPersistReactionWorkflow()) {
    return {
      id: '',
      name: displayName || username,
      nickname: null,
      bio: null,
      relationship: null,
      interaction_count: null,
      last_interaction_at: null,
    };
  }
  const now = new Date().toISOString();
  const bio = await fetchFxTwitterBio(username).catch(() => '');
  const created = await supabaseInsertReturning('users', {
    name: displayName || username,
    first_seen_at: now,
    ...(bio ? { bio } : {}),
  });
  const user = Array.isArray(created) ? created[0] : created;
  if (!user?.id) return null;
  await supabaseInsert('platform_accounts', {
    user_id: user.id,
    platform: 'twitter',
    platform_user_id: platformUserId || username,
    username,
    display_name: displayName || username,
  });
  return user;
}

async function platformAccountUser(filter) {
  const result = await supabaseGet(`platform_accounts?platform=eq.twitter&${filter}&select=user_id,username,display_name,users(id,name,nickname,bio,relationship,interaction_count,last_interaction_at)&limit=1`);
  const row = rows(result)[0];
  return row?.users || null;
}

async function publicContactEpisodes(userId, limit) {
  const result = await supabaseGet(`contact_episodes?user_id=eq.${encodeURIComponent(userId)}&source=in.(twitter)&order=occurred_at.desc&limit=${Number(limit) || 5}&select=id,content,source,event_type,occurred_at`);
  return rows(result).map((row) => ({
    ...row,
    metadata: {
      memory_class: 'relationship_public',
      visibility: 'surface_internal',
      surface: 'x',
      provenance: { table: 'contact_episodes', id: row.id, source: row.source },
    },
  }));
}

async function collectThirdPartyContext(text) {
  const terms = extractMentionPersonTerms(text).slice(0, 4);
  if (!terms.length) return '';
  const results = await Promise.all(terms.map(async (term) => {
    const found = await supabaseGet(`users?name=ilike.%2A${encodeURIComponent(term)}%2A&order=last_interaction_at.desc.nullslast&limit=5&select=id,name,nickname,bio,relationship,interaction_count,last_interaction_at`);
    return `### ${term}\n${truncate(JSON.stringify(rows(found).map((user) => projectPublicUser(user, 'x')), null, 2), 700)}`;
  }));
  return results.join('\n\n');
}

async function collectHashtagMediaContext(postId) {
  if (!postId) return '（post_idなし）';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`https://api.fxtwitter.com/status/${encodeURIComponent(postId)}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return `（fxtwitter取得失敗: ${response.status}）`;
    const parsed = await response.json();
    const tweet = parsed.tweet && typeof parsed.tweet === 'object' ? parsed.tweet : parsed;
    if (!tweet.media) return '（メディアなし）';
    return truncate(JSON.stringify(tweet.media, null, 2), 2000);
  } catch (error) {
    return `（メディア取得失敗: ${error.message || String(error)}）`;
  }
}

async function fetchFxTwitterBio(username) {
  if (!username || username === 'unknown') return '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const response = await fetch(`https://api.fxtwitter.com/${encodeURIComponent(username)}`, { signal: controller.signal });
  clearTimeout(timeout);
  if (!response.ok) return '';
  const parsed = await response.json();
  return String(parsed?.user?.description || '').trim().slice(0, 500);
}

function projectPublicUser(user, surface, nicknameOverride) {
  if (!user) return null;
  const relationship = String(user.relationship || '');
  return {
    id: user.id || undefined,
    name: user.name || null,
    nickname: nicknameOverride || user.nickname || null,
    bio: user.bio || null,
    relationship_public: relationship
      ? /family|close|friend|partner|親|友|家族/iu.test(relationship)
        ? 'known_close'
        : 'known'
      : null,
    interaction_count: user.interaction_count ?? null,
    last_interaction_at: user.last_interaction_at || null,
    metadata: {
      memory_class: 'relationship_public',
      visibility: 'surface_internal',
      surface,
      redacted_fields: ['memo', 'context', 'traits', 'relationship'],
    },
  };
}

function normalizeMentionItems(inputItems, candidates) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const byLogId = new Map(candidates.map((candidate) => [candidate.tweetLogId, candidate]));
  return inputItems.map((item, index) => {
    const id = normalizeReactionItemId(item.id || `m${index + 1}`, 'm');
    const candidate = byLogId.get(String(item.tweetLogId || '')) || byId.get(id) || candidates[index];
    if (!candidate) return null;
    const replyText = sanitizeTweetText(String(item.replyText || ''));
    const quoteText = sanitizeTweetText(String(item.quoteText || ''));
    const guardedReplyText = guardMentionText(replyText, candidate);
    const guardedQuoteText = guardMentionText(quoteText, candidate);
    const replyGuard = item.replyAction === 'reply' && guardedReplyText
      ? guardText(guardedReplyText)
      : { ok: true, errors: [], warnings: [], length: 0, text: '' };
    const quoteGuard = item.quoteAction === 'quote' && guardedQuoteText
      ? guardText(guardedQuoteText)
      : { ok: true, errors: [], warnings: [], length: 0, text: '' };
    return {
      id,
      tweetLogId: String(item.tweetLogId || candidate.tweetLogId),
      postId: String(item.postId || candidate.postId),
      username: String(item.username || candidate.username),
      displayName: String(item.displayName || candidate.displayName),
      type: String(item.type || candidate.type || 'mention'),
      body: String(candidate.body || item.body || ''),
      originalTweetId: candidate.originalTweetId || (item.originalTweetId ? String(item.originalTweetId) : undefined),
      originalTweetText: candidate.originalTweetText || (item.originalTweetText ? String(item.originalTweetText) : undefined),
      replyAction: item.replyAction === 'reply' && guardedReplyText && replyGuard.ok ? 'reply' : 'skip',
      quoteAction: item.quoteAction === 'quote' && guardedQuoteText && quoteGuard.ok ? 'quote' : 'skip',
      reason: String(item.reason || 'AI判定'),
      replyText: item.replyAction === 'reply' && guardedReplyText && replyGuard.ok ? guardedReplyText : undefined,
      quoteText: item.quoteAction === 'quote' && guardedQuoteText && quoteGuard.ok ? guardedQuoteText : undefined,
      guards: {
        reply: replyGuard,
        quote: quoteGuard,
      },
    };
  }).filter(Boolean).slice(0, 10);
}

function normalizeHashtagItems(inputItems, candidates) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const byLogId = new Map(candidates.map((candidate) => [candidate.tweetLogId, candidate]));
  return inputItems.map((item, index) => {
    const id = normalizeReactionItemId(item.id || `h${index + 1}`, 'h');
    const candidate = byLogId.get(String(item.tweetLogId || '')) || byId.get(id) || candidates[index];
    if (!candidate) return null;
    return {
      id,
      tweetLogId: String(item.tweetLogId || candidate.tweetLogId),
      postId: String(item.postId || candidate.postId),
      username: String(item.username || candidate.username),
      displayName: String(item.displayName || candidate.displayName),
      body: String(item.body || candidate.body),
      action: item.action === 'retweet' ? 'retweet' : 'skip',
      reason: String(item.reason || 'AI判定'),
    };
  }).filter(Boolean).slice(0, 10);
}

async function executeMentionReactions(items, pending) {
  const results = [];
  let replyCount = 0;
  let quoteCount = 0;
  let skipCount = 0;
  for (const item of items) {
    const actions = [];
    const result = { itemId: item.id, action: 'skip' };
    try {
      if (item.replyAction === 'reply' && item.replyText) {
        const posted = await postTweet({ action: 'reply', text: item.replyText, tweetId: item.postId, source: 'mention-reaction' });
        result.replyUrl = posted.url || `dry-run reply: ${item.replyText}`;
        actions.push('reply');
        replyCount += 1;
      }
      if (item.quoteAction === 'quote' && item.quoteText) {
        const posted = await postTweet({ action: 'quote', text: item.quoteText, tweetId: item.postId, source: 'mention-reaction' });
        result.quoteUrl = posted.url || `dry-run quote: ${item.quoteText}`;
        actions.push('quote');
        quoteCount += 1;
      }
      if (!actions.length) {
        skipCount += 1;
        actions.push('skip');
      }
      result.action = actions.join('+');
      if (shouldPersistReactionWorkflow()) {
        await recordTweetLogAction(item.tweetLogId, result.action);
        await recordMentionContactEpisode(item, pending, result);
      }
    } catch (error) {
      result.error = error.message || String(error);
    }
    results.push(result);
  }
  if (shouldPersistReactionWorkflow() && replyCount + quoteCount > 0) {
    await recordLocalEpisode(buildMentionLocalEpisode(items, results, { replyCount, quoteCount }));
  }
  return {
    mode: releaseMode(),
    dryRun: !shouldPersistReactionWorkflow(),
    summary: `${items.length}件チェック: 返信${replyCount}件、引用RT${quoteCount}件、スキップ${skipCount}件`,
    results,
  };
}

async function executeHashtagReactions(items, candidates) {
  const candidateByLogId = new Map(candidates.map((candidate) => [candidate.tweetLogId, candidate]));
  const results = [];
  let retweetCount = 0;
  let skipCount = 0;
  for (const item of items) {
    const result = { itemId: item.id, action: item.action, reason: item.reason };
    try {
      if (item.action === 'retweet') {
        const posted = await postTweet({ action: 'retweet', tweetId: item.postId, source: 'hashtag-reaction' });
        result.url = posted.url || `dry-run retweet: ${item.postId}`;
        retweetCount += 1;
        if (shouldPersistReactionWorkflow()) {
          await recordTweetLogAction(item.tweetLogId, 'retweet');
          const candidate = candidateByLogId.get(item.tweetLogId);
          if (candidate?.authorUserId) {
            await recordContactEpisode(
              candidate.authorUserId,
              `@${item.username} の #AIニケちゃん ツイート「${truncate(item.body, 60)}」をRT`,
              'twitter',
              'rt',
              'tweet_logs',
              item.tweetLogId,
            );
            await touchUser(candidate.authorUserId);
          }
        }
      } else {
        skipCount += 1;
        if (shouldPersistReactionWorkflow()) await recordTweetLogAction(item.tweetLogId, 'skip');
      }
    } catch (error) {
      result.error = error.message || String(error);
    }
    results.push(result);
  }
  if (shouldPersistReactionWorkflow() && retweetCount > 0) {
    await recordLocalEpisode(buildHashtagLocalEpisode(items, results));
  }
  return {
    mode: releaseMode(),
    dryRun: !shouldPersistReactionWorkflow(),
    summary: `${items.length}件チェック: RT${retweetCount}件、スキップ${skipCount}件`,
    results,
  };
}

async function recordMentionContactEpisode(item, pending, result) {
  if (result.action === 'skip') return;
  const candidate = pending.candidates.find((entry) => entry.tweetLogId === item.tweetLogId);
  if (!candidate?.authorUserId) return;
  await recordContactEpisode(
    candidate.authorUserId,
    `@${item.username} の「${truncate(item.body, 60)}」に ${result.action} で反応`,
    'twitter',
    result.action.includes('reply') ? 'reply' : 'quote',
    'tweet_logs',
    item.tweetLogId,
  );
  await touchUser(candidate.authorUserId);
}

async function recordContactEpisode(userId, content, source, eventType, sourceTable, sourceRecordId) {
  await supabaseInsert('contact_episodes', {
    user_id: userId,
    content,
    source,
    event_type: eventType,
    source_table: sourceTable,
    source_record_id: sourceRecordId,
  });
}

async function touchUser(userId) {
  const current = rows(await supabaseGet(`users?id=eq.${encodeURIComponent(userId)}&select=interaction_count`))[0];
  await supabasePatch(`users?id=eq.${encodeURIComponent(userId)}`, {
    interaction_count: Number(current?.interaction_count || 0) + 1,
    last_interaction_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

async function markTweetLogsChecked(ids) {
  if (!shouldPersistReactionWorkflow()) return;
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return;
  await supabasePatch(`tweet_logs?id=in.(${unique.map(encodeURIComponent).join(',')})`, { checked_by_nikechan: true });
}

async function recordTweetLogAction(id, action) {
  const filter = /^\d+$/u.test(String(id))
    ? `post_id=eq.${encodeURIComponent(id)}`
    : `id=eq.${encodeURIComponent(id)}`;
  await supabasePatch(`tweet_logs?${filter}`, { nikechan_action: action });
}

function parseReactionApprovalReply(text, itemIds = []) {
  const normalized = String(text || '').trim();
  const ids = itemIds.map((id) => normalizeReactionItemId(id, String(id).startsWith('h') ? 'h' : 'm'));
  if (!normalized) return { action: 'unknown', reason: 'empty reply' };
  if (/見送り|却下|キャンセル|cancel|skip|スキップ|やめ|なし|不要/u.test(normalized)) {
    return { action: 'cancel', reason: normalized };
  }
  if (/修正|直して|変更|作り直|再生成|別案|rewrite|revise|もう一度/u.test(normalized)) {
    return { action: 'revise', feedback: normalized };
  }
  if (/全部|すべて|全て|all/u.test(normalized)) return { action: 'approve', ids };
  const selected = new Set();
  for (const match of normalized.matchAll(/(?:^|[^\da-z])([mh]?\d+)(?:\s*(?:番|つ目|だけ|のみ|で|に|を|と|,|、|\/|$))/giu)) {
    const id = normalizeReactionItemId(match[1], ids[0]?.[0] || 'm');
    if (ids.includes(id)) selected.add(id);
  }
  if (selected.size > 0) return { action: 'approve', ids: [...selected] };
  if (/ok|OK|承認|投稿して|リプして|引用して|実行して|post/u.test(normalized)) {
    if (ids.length === 1) return { action: 'approve', ids };
    return { action: 'needs_id', reason: 'multiple candidates need explicit ids' };
  }
  return { action: 'unknown', reason: 'no approval intent detected' };
}

function hasApprovalIntent(text) {
  return /ok|OK|承認|投稿して|リプして|返信OK|引用して|実行して|post/u.test(String(text || ''));
}

function normalizeReactionItemId(value, prefix) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (new RegExp(`^${prefix}\\d+$`, 'u').test(text)) return text;
  const number = text.match(/\d+/u)?.[0];
  return number ? `${prefix}${number}` : text;
}

function guardMentionText(text, candidate) {
  if (!text) return '';
  const nickname = String(candidate.nickname || '').trim();
  const aliases = [candidate.username ? `@${String(candidate.username).replace(/^@/u, '')}` : '', candidate.displayName, candidate.authorName]
    .map((value) => String(value || '').trim())
    .filter((value) => value && value !== nickname)
    .sort((a, b) => b.length - a.length);
  let guarded = text;
  for (const alias of [...new Set(aliases)]) {
    guarded = guarded.replace(new RegExp(escapeRegExp(alias), 'gu'), nickname || 'そちら');
  }
  if (nickname) {
    guarded = guarded.replace(new RegExp(`${escapeRegExp(nickname)}(さん|ちゃん|くん|様|さま)`, 'gu'), nickname);
  }
  if (/おかえり|お帰り/u.test(candidate.body) && /おかえり|お帰り/u.test(guarded)) {
    guarded = 'ただいま戻りました。迎えてくれてありがとうございます。今日からまた少しずつ動いていきます。';
  }
  return sanitizeTweetText(guarded.replace(/\s{2,}/gu, ' '));
}

function sanitizeTweetText(text) {
  return String(text || '')
    .replace(/^["「]|["」]$/gu, '')
    .replace(/\s+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
    .slice(0, 280);
}

function fallbackNickname(displayName, username) {
  const base = String(displayName || username || '')
    .replace(/^@/u, '')
    .replace(/[｜|].*$/u, '')
    .replace(/\s+/gu, '')
    .replace(/[^\p{L}\p{N}_ぁ-んァ-ヶー一-龯]/gu, '')
    .slice(0, 16);
  if (!base) return '';
  if (/(さん|ちゃん|くん|氏|先生)$/u.test(base)) return base;
  return `${base}さん`;
}

function extractMentionPersonTerms(text) {
  const terms = new Set();
  for (const match of String(text || '').matchAll(/@([a-zA-Z0-9_]{2,20})/g)) terms.add(match[1]);
  for (const match of String(text || '').matchAll(/([一-龯ぁ-んァ-ヶA-Za-z0-9_]{2,16}(?:ちゃん|さん|氏|くん|たん|先生))/g)) {
    terms.add(match[1]);
  }
  return [...terms].filter((term) => !['ai_nikechan', 'AIニケちゃん', 'ニケちゃん'].includes(term));
}

function formatMentionPendingMarkdown(pending) {
  const lines = ['メンション反応候補:', ''];
  for (const item of pending.items) {
    lines.push(`${item.id}. @${item.username} - 「${truncate(item.body, 90)}」`);
    lines.push(`   判断: reply=${item.replyAction}, quote=${item.quoteAction}`);
    if (item.replyText) lines.push(`   返信案: ${item.replyText}`);
    if (item.quoteText) lines.push(`   引用案: ${item.quoteText}`);
    lines.push(`   理由: ${item.reason}`);
    const guardErrors = [
      ...(item.guards?.reply?.errors || []),
      ...(item.guards?.quote?.errors || []),
    ];
    if (guardErrors.length) lines.push(`   安全確認: ${guardErrors.join('; ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

function printMentionPendingMarkdown(pending) {
  console.log(formatMentionPendingMarkdown(pending));
}

function formatHashtagReport(items, results) {
  const resultById = new Map(results.map((result) => [result.itemId, result]));
  const retweets = items.filter((item) => resultById.get(item.id)?.action === 'retweet');
  const skips = items.filter((item) => resultById.get(item.id)?.action !== 'retweet');
  const lines = ['ハッシュタグ反応レポート', '', `RT（${retweets.length}件）:`];
  if (retweets.length) {
    for (const [index, item] of retweets.entries()) {
      const result = resultById.get(item.id);
      lines.push(`${index + 1}. @${item.username} - 「${truncate(item.body, 90)}」`);
      lines.push(`   理由: ${item.reason}`);
      if (result?.error) lines.push(`   エラー: ${truncate(result.error, 120)}`);
      else if (result?.url) lines.push(`   ${result.url}`);
    }
  } else {
    lines.push('なし');
  }
  lines.push('', `スキップ（${skips.length}件）:`);
  if (skips.length) {
    for (const [index, item] of skips.entries()) {
      lines.push(`${index + 1}. @${item.username} - 「${truncate(item.body, 90)}」`);
      lines.push(`   理由: ${item.reason}`);
    }
  } else {
    lines.push('なし');
  }
  return lines.join('\n');
}

function formatAiNewsTweetReport(payload) {
  const result = payload.result || {};
  const item = payload.item || {};
  const lines = [
    'AIニュースツイートレポート',
    '',
    result.dryRun ? 'dry-runのためX投稿はしていません。' : 'Xへ投稿しました。',
    result.url ? `投稿: ${result.url}` : '',
    item.title ? `記事タイトル: ${item.title}` : '',
    item.url ? `記事: ${item.url}` : '',
    `ニュース一覧: ${AI_NEWS_LIST_URL}`,
  ].filter(Boolean);
  return lines.join('\n');
}

function buildMentionLocalEpisode(items, results, counts) {
  const resultById = new Map(results.map((result) => [result.itemId, result]));
  const acted = items.filter((item) => {
    const result = resultById.get(item.id);
    return result && !result.error && result.action !== 'skip';
  });
  if (!acted.length) return '';
  const highlights = acted.slice(0, 3).map((item) => {
    const result = resultById.get(item.id);
    const action = result?.action === 'reply+quote' ? '返信と引用RT' : result?.action === 'quote' ? '引用RT' : '返信';
    return `@${item.username}の「${truncate(item.body, 34)}」に${action}`;
  }).join('、');
  const omitted = acted.length > 3 ? `など${acted.length}件` : '';
  return `mention-reaction: ${highlights}${omitted}。返信${counts.replyCount}件・引用RT${counts.quoteCount}件`;
}

function buildHashtagLocalEpisode(items, results) {
  const resultById = new Map(results.map((result) => [result.itemId, result]));
  const retweeted = items.filter((item) => {
    const result = resultById.get(item.id);
    return result && !result.error && result.action === 'retweet';
  });
  if (!retweeted.length) return '';
  const highlights = retweeted.slice(0, 3).map((item) => `@${item.username}の「${truncate(item.body, 38)}」をRT`).join('、');
  const omitted = retweeted.length > 3 ? `など${retweeted.length}件` : '';
  return `hashtag-reaction: ${highlights}${omitted}`;
}

function reactionResultStatus(results) {
  if (!shouldPersistReactionWorkflow()) return 'dry-run';
  if (results.some((entry) => entry.error)) return 'failed';
  if (results.every((entry) => entry.action === 'skip')) return 'skipped';
  return 'success';
}

function shouldPersistReactionWorkflow() {
  return isLiveMode(releaseMode()) && process.env.NIKECHAN_X_LIVE_ARMED === 'yes';
}

function recentCutoffIso() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

async function recordActivity(stage, parsed, workflow = 'self-tweet', status) {
  const entry = {
    at: new Date().toISOString(),
    workflow,
    stage,
    parsed,
  };
  await ensureDir(STATE_DIR);
  await appendFile(statePath('activity.jsonl'), `${JSON.stringify(entry)}\n`);
  await supabaseInsert('twitter_activity_logs', {
    workflow,
    stage,
    raw_content: JSON.stringify(parsed).slice(0, 3000),
    parsed,
    status: status || (stage === 'error' ? 'failed' : stage === 'execute' ? 'success' : 'needs_approval'),
    created_by: 'nikechan-x',
  });
}

async function recordTwitterRunState(key, value) {
  await supabaseUpsert('twitter_run_state', { key, value, updated_at: new Date().toISOString() }, 'key');
}

async function getTwitterRunStateValue(key) {
  const result = await supabaseGet(`twitter_run_state?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  const value = rows(result)[0]?.value;
  return typeof value === 'string' ? safeJsonParse(value, null) : value;
}

async function appendAiNewsTweetRefs(key, refs, metadata = {}) {
  const current = await getTwitterRunStateValue(key);
  const existing = Array.isArray(current?.items) ? current.items : [];
  const now = new Date().toISOString();
  const merged = new Map();
  for (const item of existing) {
    const id = String(item?.id || item?.url || '').trim();
    if (id) merged.set(id, item);
  }
  for (const ref of refs) {
    const id = String(ref?.id || ref?.url || '').trim();
    if (!id) continue;
    merged.set(id, {
      ...ref,
      ...metadata,
      at: now,
    });
  }
  await recordTwitterRunState(key, {
    items: [...merged.values()].slice(-200),
  });
}

async function recordAiNewsTweetExecution(candidates, execution) {
  const refs = aiNewsRefsFromCandidates(candidates);
  if (!refs.length) return;
  await appendAiNewsTweetRefs('ai_news_tweet_executed_items', refs, {
    ...execution,
    status: isLiveMode(execution.mode) ? 'posted' : 'approved-dry-run',
  });
}

async function selectAiNewsTweetItem(limit = 30) {
  const [newsResult, presentedState, executedState] = await Promise.all([
    supabaseGet(`public_ai_character_news?order=discovered_at.desc.nullslast,published_at.desc.nullslast,created_at.desc&limit=${Number(limit) || 30}&select=id,url,title,source_name,source_domain,published_at,discovered_at,summary,nike_comment,category,tags,created_at`),
    getTwitterRunStateValue('ai_news_tweet_presented_items'),
    getTwitterRunStateValue('ai_news_tweet_executed_items'),
  ]);
  const consumed = new Set([
    ...aiNewsRefsFromState(presentedState),
    ...aiNewsRefsFromState(executedState),
  ]);
  return rows(newsResult)
    .filter((item) => textOf(item.url))
    .filter((item) => textOf(item.nike_comment || item.summary || item.title))
    .filter((item) => isRecentAiNewsItem(item))
    .find((item) => !consumed.has(String(item.id)) && !consumed.has(String(item.url)));
}

export function isRecentAiNewsItem(item, nowMs = Date.now(), maxAgeMs = AI_NEWS_TWEET_MAX_AGE_MS) {
  const discoveredAt = Date.parse(item?.discovered_at || item?.created_at || '');
  const publishedAt = Date.parse(item?.published_at || item?.created_at || '');
  return Number.isFinite(discoveredAt) && nowMs - discoveredAt < maxAgeMs
    && Number.isFinite(publishedAt) && nowMs - publishedAt < maxAgeMs;
}

export function buildAiNewsTweetText(item) {
  const articleUrl = textOf(item.url);
  const title = normalizeAiNewsComment(item.title || item.source_name || '記事');
  const suffixReserve = `\n\n ${articleUrl}`;
  const titleMaxLength = Math.max(1, 280 - tweetWeightedLength(suffixReserve));
  const suffix = `\n\n${clipText(title, titleMaxLength)} ${articleUrl}`;
  const comment = normalizeAiNewsComment(item.nike_comment || item.summary || item.title);
  const maxCommentLength = Math.max(0, 280 - tweetWeightedLength(suffix));
  return `${clipText(comment, maxCommentLength)}${suffix}`.trim();
}

export function tweetWeightedLength(text) {
  const normalized = textOf(text);
  const urlPattern = /https?:\/\/\S+/gu;
  let length = 0;
  let cursor = 0;
  for (const match of normalized.matchAll(urlPattern)) {
    length += [...normalized.slice(cursor, match.index)].length;
    length += X_URL_WEIGHT;
    cursor = match.index + match[0].length;
  }
  length += [...normalized.slice(cursor)].length;
  return length;
}

function normalizeAiNewsComment(value) {
  return textOf(value)
    .replace(/https?:\/\/\S+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function clipText(text, maxLength) {
  const chars = [...textOf(text)];
  if (maxLength <= 0) return '';
  if (chars.length <= maxLength) return chars.join('');
  if (maxLength <= 1) return '…';
  return `${chars.slice(0, maxLength - 1).join('').replace(/[、。,.，．\s]+$/u, '')}…`;
}

function aiNewsRef(item) {
  return {
    type: 'ai_character_news',
    id: String(item.id || ''),
    url: String(item.url || ''),
    title: String(item.title || ''),
    sourceName: String(item.source_name || item.sourceName || ''),
    publishedAt: String(item.published_at || item.publishedAt || ''),
  };
}

function aiNewsRefsFromCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .flatMap((candidate) => Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs : [])
    .filter((ref) => ref?.type === 'ai_character_news' && (ref.id || ref.url))
    .map(aiNewsRef);
}

function aiNewsRefsFromState(state) {
  return (Array.isArray(state?.items) ? state.items : [])
    .flatMap((item) => [String(item.id || '').trim(), String(item.url || '').trim()])
    .filter(Boolean);
}

function aiNewsUrlsFromRunRows(runRows) {
  return new Set(runRows
    .filter((row) => row.key === 'ai_news_tweet_executed_items' || row.key === 'ai_news_tweet_presented_items')
    .flatMap((row) => aiNewsRefsFromState(safeJsonParse(row.value, row.value)))
    .filter((value) => /^https?:\/\//u.test(value)));
}

function isAiNewsTweetMaterial(item, aiNewsTweetUrls = new Set()) {
  const body = itemBodyText(item);
  if (body.includes(AI_NEWS_LIST_URL)) return true;
  for (const url of aiNewsTweetUrls) {
    if (body.includes(url)) return true;
  }
  return false;
}

async function recordTopic(text) {
  const topic = truncate(text.replace(/https?:\/\/\S+/g, '').trim(), 120);
  if (!topic) return;
  await supabaseInsert('topics', { topic, source: 'self-tweet' });
}

async function recordLocalEpisode(content) {
  if (!String(content || '').trim()) return;
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

async function supabaseInsertReturning(table, row) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(row),
    });
    const text = await response.text();
    if (!response.ok) return null;
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function supabasePatch(path, patch) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return { status: 'skipped', reason: 'supabase env missing' };
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/rest/v1/${path}`, {
      method: 'PATCH',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(patch),
    });
    if (!response.ok) return { status: 'error', code: response.status, body: await response.text(), path };
    return { status: 'updated', path };
  } catch (error) {
    return { status: 'error', error: error.message, path };
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
  lines.push(`話題タイプ: ${pending.sourceMode}`);
  lines.push('');
  for (const candidate of pending.candidates) {
    const status = candidate.guard.ok ? 'OK' : `要確認: ${candidate.guard.errors.join('; ')}`;
    lines.push(`${candidate.id}. ${candidate.text}`);
    if (candidate.reason) lines.push(`   狙い: ${candidate.reason}`);
    lines.push(`   安全確認: ${status}`);
    if (candidate.guard.warnings.length) lines.push(`   注意: ${candidate.guard.warnings.join('; ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

function summarizeRunState(runState) {
  return {
    lastSourceMode: runState.lastSourceMode || null,
    lastPresentedAt: runState.lastPresentedAt || null,
    lastExecuteAt: runState.lastExecuteAt || null,
    lastNotifyAt: runState.lastNotifyAt || null,
  };
}

function rows(result) {
  return Array.isArray(result?.data) ? result.data : [];
}

function textOf(value) {
  return String(value || '').trim();
}

function materialText(item) {
  return [item.text, item.title, item.url, item.actionType, item.source]
    .map(textOf)
    .filter(Boolean)
    .join('\n');
}

function itemBodyText(item) {
  return [item.text, item.title]
    .map(textOf)
    .filter(Boolean)
    .join('\n');
}

function isOperationalMaterial(item) {
  return item.type === 'episode'
    && item.source === 'coding-agent'
    && /nikechan-x|Hermes|Discord|CLI|VPS|cron|resolve|dry-run|context|実装|検証|テスト|commit|push|gateway/u.test(materialText(item));
}

function uniqueMaterials(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = materialText(item).slice(0, 180);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function rotateMaterials(items) {
  const unique = uniqueMaterials(items);
  if (unique.length <= 1) return unique;
  const seed = Number(new Date().toISOString().slice(8, 10)) || 0;
  const offset = seed % unique.length;
  return [...unique.slice(offset), ...unique.slice(0, offset)];
}

function extractTopicPreviews(value) {
  const payload = typeof value === 'string' ? safeJsonParse(value, null) : value;
  const topics = Array.isArray(payload?.topics) ? payload.topics : [];
  return topics
    .map((topic) => ({
      text: textOf(topic.textPreview || topic.text || topic.topic),
      title: textOf(Array.isArray(topic.titles) ? topic.titles[0] : topic.title),
      topic: textOf(topic.topic),
      angle: textOf(topic.angle),
    }))
    .filter((topic) => topic.text || topic.title || topic.topic);
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
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

async function readMentionPending() {
  return readJson(statePath('pending-mention-reaction.json'), null);
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

async function setMentionPendingThread(pending, thread) {
  const next = {
    ...pending,
    channel: thread.channel,
    messageId: thread.messageId,
    threadId: thread.threadId,
    threadName: thread.threadName,
    notifiedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(statePath('pending-mention-reaction.json'), next);
  return next;
}

async function findPendingByThreadId(threadId) {
  const normalized = String(threadId || '').trim();
  const [selfTweet, mentionReaction] = await Promise.all([
    readPending(),
    readMentionPending(),
  ]);
  if (mentionReaction?.threadId && String(mentionReaction.threadId) === normalized) {
    return {
      match: true,
      workflow: 'mention-reaction',
      command: 'mention',
      pending: mentionReaction,
      routingInstruction: [
        'This Discord thread is an X mention-reaction approval/revision thread.',
        'Use the current pending candidates below as the source of truth.',
        'Do not execute self-tweet pending from this thread.',
        'Judge the master reply by intent, not by fixed approval words.',
        'If the reply approves the current candidates, call mention-approve with the selected item IDs.',
        'If the reply asks for changes, revise the full items JSON and call mention-propose --preserve-thread true.',
        'If the reply asks a question or asks to review context, answer briefly and keep the pending state.',
      ],
    };
  }
  if (selfTweet?.threadId && String(selfTweet.threadId) === normalized) {
    return {
      match: true,
      workflow: 'self-tweet',
      command: 'self',
      pending: selfTweet,
      routingInstruction: [
        'This Discord thread is an X self-tweet approval/revision thread.',
        'Use the current pending candidates below as the source of truth.',
        'Do not execute mention-reaction pending from this thread.',
        'Judge the master reply by intent, not by fixed approval words.',
        'If the reply approves a candidate, call approve with the selected candidate IDs.',
        'If the reply asks for changes, revise candidates and call propose --preserve-thread true.',
        'If the reply asks a question or asks to review context, answer briefly and keep the pending state.',
      ],
    };
  }
  return {
    match: false,
    workflow: null,
    threadId: normalized,
    pendingThreads: {
      mentionReaction: mentionReaction?.threadId || null,
      selfTweet: selfTweet?.threadId || null,
    },
  };
}

function summarizeMentionPendingForContext(pending) {
  return {
    id: pending.id || null,
    status: pending.status || null,
    createdAt: pending.createdAt || null,
    notifiedAt: pending.notifiedAt || null,
    threadId: pending.threadId || null,
    threadName: pending.threadName || null,
    itemCount: Array.isArray(pending.items) ? pending.items.length : 0,
    postIds: Array.isArray(pending.items)
      ? pending.items.map((item) => item.postId).filter(Boolean)
      : [],
  };
}

async function removePending() {
  const path = statePath('pending-self-tweet.json');
  if (!existsSync(path)) return;
  await rename(path, statePath(`pending-self-tweet.${Date.now()}.closed.json`));
}

async function archiveMentionPending(pending, reason) {
  const path = statePath('pending-mention-reaction.json');
  if (!existsSync(path)) return;
  const archived = {
    ...pending,
    status: reason,
    archivedAt: new Date().toISOString(),
    archiveReason: reason,
  };
  await writeJsonAtomic(statePath(`pending-mention-reaction.${Date.now()}.${reason}.json`), archived);
  await rename(path, statePath(`pending-mention-reaction.${Date.now()}.closed.json`));
}

async function removeMentionPending() {
  const path = statePath('pending-mention-reaction.json');
  if (!existsSync(path)) return;
  await rename(path, statePath(`pending-mention-reaction.${Date.now()}.closed.json`));
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

async function cleanupDiscordApprovalThreads(parentChannel) {
  const registry = await readDiscordThreadRegistry();
  const discovered = await discoverDiscordApprovalThreads(parentChannel).catch((error) => {
    console.error(`Discord thread discovery failed: ${error?.message || error}`);
    return [];
  });
  let discoveredCount = 0;
  for (const record of discovered) {
    if (!registry[record.threadId]) discoveredCount += 1;
    registry[record.threadId] = {
      ...registry[record.threadId],
      ...record,
    };
  }

  const retained = {};
  const now = Date.now();
  let deleted = 0;
  let missing = 0;
  let failed = 0;
  for (const record of Object.values(registry)) {
    const createdAtMs = Date.parse(record.createdAt || '') || snowflakeTimestampMs(record.threadId);
    if (!createdAtMs || now - createdAtMs <= DISCORD_THREAD_RETENTION_MS) {
      retained[record.threadId] = record;
      continue;
    }
    const result = await deleteDiscordThread(record.threadId);
    if (result.deleted) {
      deleted += 1;
      await clearPendingForThread(record.threadId);
      continue;
    }
    if (result.missing) {
      missing += 1;
      await clearPendingForThread(record.threadId);
      continue;
    }
    failed += 1;
    retained[record.threadId] = record;
  }

  await writeDiscordThreadRegistry(retained);
  return {
    ok: failed === 0,
    channel: parentChannel,
    discovered: discoveredCount,
    deleted,
    missing,
    failed,
    retained: Object.keys(retained).length,
  };
}

async function rememberDiscordThread(thread, parentChannel) {
  if (!thread?.id) return;
  const registry = await readDiscordThreadRegistry();
  registry[String(thread.id)] = {
    threadId: String(thread.id),
    parentChannelId: String(parentChannel || thread.parent_id || ''),
    name: String(thread.name || ''),
    createdAt: new Date(snowflakeTimestampMs(thread.id) || Date.now()).toISOString(),
  };
  await writeDiscordThreadRegistry(registry);
}

async function readDiscordThreadRegistry() {
  const raw = await readJson(DISCORD_THREAD_REGISTRY_PATH, null);
  if (Array.isArray(raw)) {
    return Object.fromEntries(
      raw
        .map((threadId) => String(threadId || '').trim())
        .filter(Boolean)
        .map((threadId) => [
          threadId,
          {
            threadId,
            parentChannelId: '',
            name: '',
            createdAt: new Date(snowflakeTimestampMs(threadId) || Date.now()).toISOString(),
          },
        ]),
    );
  }
  const source = raw?.threads && typeof raw.threads === 'object' ? raw.threads : raw;
  if (!source || typeof source !== 'object') return {};
  const normalized = {};
  for (const [threadId, record] of Object.entries(source)) {
    if (!threadId || !record || typeof record !== 'object') continue;
    normalized[threadId] = {
      threadId,
      parentChannelId: String(record.parentChannelId || record.parent_id || ''),
      name: String(record.name || ''),
      createdAt: String(
        record.createdAt || new Date(snowflakeTimestampMs(threadId) || Date.now()).toISOString(),
      ),
    };
  }
  return normalized;
}

async function writeDiscordThreadRegistry(threads) {
  await writeJsonAtomic(DISCORD_THREAD_REGISTRY_PATH, {
    updatedAt: new Date().toISOString(),
    retentionHours: 24,
    threads,
  });
}

async function discoverDiscordApprovalThreads(parentChannel) {
  const records = [];
  const parent = await discordApi(`/channels/${encodeURIComponent(parentChannel)}`).catch((error) => {
    console.error(`Discord parent channel fetch failed: ${error?.message || error}`);
    return null;
  });
  const guildId = parent?.body?.guild_id;
  if (guildId) {
    const active = await discordApi(`/guilds/${encodeURIComponent(guildId)}/threads/active`).catch((error) => {
      console.error(`Discord active thread discovery failed: ${error?.message || error}`);
      return null;
    });
    for (const thread of Array.isArray(active?.body?.threads) ? active.body.threads : []) {
      if (
        String(thread.parent_id || '') === String(parentChannel) &&
        isDiscordApprovalThreadName(thread.name)
      ) {
        records.push(discordThreadRecord(thread, parentChannel));
      }
    }
  }

  let before;
  for (let page = 0; page < 50; page += 1) {
    const query = new URLSearchParams({ limit: '100' });
    if (before) query.set('before', before);
    const archived = await discordApi(
      `/channels/${encodeURIComponent(parentChannel)}/threads/archived/public?${query.toString()}`,
    ).catch((error) => {
      console.error(`Discord archived thread discovery failed: ${error?.message || error}`);
      return null;
    });
    const threads = Array.isArray(archived?.body?.threads) ? archived.body.threads : [];
    if (!threads.length) break;
    for (const thread of threads) {
      if (isDiscordApprovalThreadName(thread.name)) records.push(discordThreadRecord(thread, parentChannel));
    }
    if (!archived?.body?.has_more) break;
    const oldestArchive = threads
      .map((thread) => Date.parse(thread.thread_metadata?.archive_timestamp || ''))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    if (!oldestArchive) break;
    before = new Date(oldestArchive - 1).toISOString();
  }
  return records;
}

function discordThreadRecord(thread, parentChannel) {
  const threadId = String(thread.id || '');
  return {
    threadId,
    parentChannelId: String(parentChannel || thread.parent_id || ''),
    name: String(thread.name || ''),
    createdAt: new Date(snowflakeTimestampMs(threadId) || Date.now()).toISOString(),
  };
}

function isDiscordApprovalThreadName(name) {
  const value = String(name || '');
  return DISCORD_THREAD_NAME_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix} `));
}

async function deleteDiscordThread(threadId) {
  try {
    const result = await discordApi(`/channels/${encodeURIComponent(threadId)}`, { method: 'DELETE' });
    return { deleted: result.status >= 200 && result.status < 300, missing: false };
  } catch (error) {
    if (error?.status === 404) return { deleted: false, missing: true };
    console.error(`Discord thread delete failed ${threadId}: ${error?.message || error}`);
    return { deleted: false, missing: false };
  }
}

async function clearPendingForThread(threadId) {
  const [selfTweet, mentionReaction] = await Promise.all([readPending(), readMentionPending()]);
  if (selfTweet?.threadId && String(selfTweet.threadId) === String(threadId)) {
    await removePending();
  }
  if (mentionReaction?.threadId && String(mentionReaction.threadId) === String(threadId)) {
    await archiveMentionPending(mentionReaction, 'expired-thread');
  }
}

async function discordApi(path, options = {}) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('missing DISCORD_BOT_TOKEN');
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(`Discord API failed ${response.status}: ${truncate(text, 500)}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return { status: response.status, body, text };
}

function snowflakeTimestampMs(value) {
  try {
    return Number((BigInt(String(value)) >> 22n) + 1420070400000n);
  } catch {
    return 0;
  }
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
    await addConfiguredDiscordThreadMembers(pending.threadId);
    const message = await sendDiscordMessage(pending.threadId, content);
    return {
      ...message,
      messageId: message.id || null,
      threadId: pending.threadId,
      threadName: pending.threadName || null,
    };
  }
  const title = sanitizeDiscordThreadName(
    options.threadTitle || `X候補 ${jstDate()} ${pending.id.slice(0, 8)}`,
  );
  const thread = await createDiscordThread(channel, title);
  if (thread.id) {
    await addConfiguredDiscordThreadMembers(thread.id);
  }
  const message = await sendDiscordMessage(thread.id, content);
  return {
    ...thread,
    messageId: message.id || null,
    threadId: thread.id || null,
    threadName: thread.name || title,
  };
}

async function sendDiscordThreadReport(channel, content, options = {}) {
  const title = sanitizeDiscordThreadName(
    options.threadTitle || `Xレポート ${jstDate()}`,
  );
  const thread = await createDiscordThread(channel, title);
  if (thread.id) {
    await addConfiguredDiscordThreadMembers(thread.id);
  }
  const message = await sendDiscordMessage(thread.id, content);
  return {
    ...thread,
    messageId: message.id || null,
    threadId: thread.id || null,
    threadName: thread.name || title,
  };
}

async function createDiscordThread(channel, name) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('missing DISCORD_BOT_TOKEN');
  await cleanupDiscordApprovalThreads(channel);
  const response = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channel)}/threads`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        type: 11,
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
  await rememberDiscordThread(parsed, channel);
  return parsed;
}

async function addConfiguredDiscordThreadMembers(threadId) {
  const users = parseDiscordAllowedUsers();
  for (const userId of users) {
    await addDiscordThreadMember(threadId, userId);
  }
}

function parseDiscordAllowedUsers() {
  return String(process.env.DISCORD_ALLOWED_USERS || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^\d{5,}$/u.test(item));
}

async function addDiscordThreadMember(threadId, userId) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('missing DISCORD_BOT_TOKEN');
  const response = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(threadId)}/thread-members/${encodeURIComponent(userId)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${token}`,
      },
    },
  );
  if (response.ok || response.status === 204) return;
  const text = await response.text();
  throw new Error(`Discord thread member API failed ${response.status}: ${truncate(text, 500)}`);
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
