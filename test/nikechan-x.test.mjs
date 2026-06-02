import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildAiNewsTweetText,
  buildContextMaterials,
  buildDuplicateReference,
  guardText,
  isRecentAiNewsItem,
  nextSourceMode,
  parseApprovalReply,
  validateReleaseModeChange,
} from '../scripts/nikechan-x.mjs';

test('guard accepts ordinary Japanese tweet', () => {
  const result = guardText('今日は少しだけキャッシュがあたたかいです。返事の温度を覚えておきます。');
  assert.equal(result.ok, true);
});

test('guard blocks secret-like token and private markers', () => {
  const result = guardText('SUPABASE_SERVICE_ROLE_KEY=sb_secret_abcdefghijklmnop');
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /secret-like|SUPABASE_SERVICE_ROLE_KEY/u);
});

test('guard blocks private operational runtime markers', () => {
  const result = guardText('VPSでold X workerを再起動しました。');
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /private\/operational marker/u);
});

test('guard accepts common Japanese kanji that looked like Chinese false positives', () => {
  const result = guardText('音声と身体性の没入感を考える時、返事の間が大事になります。');
  assert.equal(result.ok, true);
});

test('news guard requires URL for source hook', () => {
  const result = guardText('新しいAIエージェントの記事を読んで、声の間が気になりました。', { sourceMode: 'news' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /without URL/u);
});

test('source mode rotates deterministically', () => {
  assert.equal(nextSourceMode(undefined), 'presence');
  assert.equal(nextSourceMode('presence'), 'daily_life');
  assert.equal(nextSourceMode('random'), 'presence');
});

test('approval replies parse into explicit actions', () => {
  assert.deepEqual(parseApprovalReply('2番でお願いします', ['1', '2']), { action: 'approve', ids: ['2'] });
  assert.equal(parseApprovalReply('今回は見送りで', ['1', '2']).action, 'cancel');
  assert.equal(parseApprovalReply('もう少し柔らかく修正して', ['1', '2']).action, 'revise');
  assert.equal(parseApprovalReply('OK', ['1', '2']).action, 'needs_id');
  assert.deepEqual(parseApprovalReply('OK', ['1']), { action: 'approve', ids: ['1'] });
});

test('release mode changes require explicit live confirmation', () => {
  assert.deepEqual(validateReleaseModeChange('dry-run'), { ok: true, mode: 'dry-run', liveArmed: false });
  assert.equal(validateReleaseModeChange('canary-live').ok, false);
  assert.equal(validateReleaseModeChange('live').ok, false);
  assert.deepEqual(validateReleaseModeChange('live', 'LIVE_X_POSTING'), { ok: true, mode: 'live', liveArmed: true });
});

test('context materials are partitioned by source mode', () => {
  const sources = {
    recentTweets: {
      data: [
        { content: 'Claude Codeのプロンプトキャッシュ記事を読みました。 https://zenn.dev/example', url: 'https://x.com/ai_nikechan/status/1', action_type: 'tweet' },
        { content: 'だーちゃん、AIタグの説明です。', url: 'https://x.com/ai_nikechan/status/2', action_type: 'reply' },
        { content: '#ぷにけ の話題で呼んでもらいました。', url: '', action_type: 'reply' },
        { content: '小松菜とキノコで体調を整えました。', url: '', action_type: 'reply' },
        { content: 'AIニュース専用枠の投稿です。\n\n記事: https://example.com/ai-news\nニュース一覧: https://nikechan.com/ai-news', url: 'https://x.com/ai_nikechan/status/3', action_type: 'tweet' },
      ],
    },
    runStateRows: {
      data: [
        {
          key: 'ai_news_tweet_executed_items',
          value: {
            items: [
              { id: 'news-1', url: 'https://example.com/ai-news' },
            ],
          },
        },
      ],
    },
    publicEpisodes: { data: [] },
    publicNotes: { data: [{ title: 'Hermesの記憶', content: '記憶とプロンプトの設計を整理しました。' }] },
    publicWiki: { data: [] },
  };

  const presence = buildContextMaterials('presence', sources);
  const daily = buildContextMaterials('daily_life', sources);
  const tech = buildContextMaterials('tech', sources);
  const news = buildContextMaterials('news', sources);

  assert.match(presence.primary.map((item) => item.text).join('\n'), /ぷにけ/u);
  assert.doesNotMatch(presence.primary.map((item) => item.text).join('\n'), /小松菜/u);
  assert.match(daily.primary.map((item) => item.text).join('\n'), /小松菜/u);
  assert.match(news.primary.map((item) => item.text).join('\n'), /https:\/\/zenn/u);
  assert.doesNotMatch(news.primary.map((item) => item.text).join('\n'), /AIタグの説明/u);
  assert.doesNotMatch(news.primary.map((item) => item.text).join('\n'), /nikechan\.com\/ai-news|example\.com\/ai-news/u);
  assert.match(tech.primary.map((item) => `${item.title || ''}\n${item.text || ''}`).join('\n'), /Hermes/u);
  assert.doesNotMatch(tech.primary.map((item) => item.text).join('\n'), /AIタグの説明/u);
});

test('duplicate reference exposes recent outputs without separate manual list', () => {
  const result = buildDuplicateReference(
    {
      recentPresentedTopics: [
        { text: '前回の候補です。' },
        { text: 'AIニュース候補です。\n\n記事: https://example.com/ai-news\nニュース一覧: https://nikechan.com/ai-news' },
      ],
      lastExecutedTexts: ['投稿済みです。', '投稿済みAIニュース https://example.com/ai-news'],
    },
    {
      recentTweets: {
        data: [
          { content: '直近ツイートです。' },
          { content: 'AIニュース専用投稿です。\n\n記事: https://example.com/ai-news\nニュース一覧: https://nikechan.com/ai-news' },
        ],
      },
      runStateRows: {
        data: [
          {
            key: 'ai_news_tweet_executed_items',
            value: { items: [{ id: 'news-1', url: 'https://example.com/ai-news' }] },
          },
        ],
      },
    },
  );

  assert.deepEqual(result.recentPresentedTexts, ['前回の候補です。']);
  assert.deepEqual(result.lastExecutedTexts, ['投稿済みです。']);
  assert.deepEqual(result.recentTweetTexts, ['直近ツイートです。']);
});

test('AI news tweet text uses comment and title URL format', () => {
  const text = buildAiNewsTweetText({
    title: 'グラッドキューブ、ハイブリッド型AIアバター接客「SiTest AIコンシェルジュ」の提供開始',
    url: 'https://corp.glad-cube.com/news/pressrelease/1256/',
    nike_comment: 'ウェブと実店舗モニターをRAGで繋ぐハイブリッド構成、回答精度とキャラクター愛着を同時に狙う点がSiTestの既存ツールとの違いとして際立ちそうです。',
  });

  assert.match(text, /^ウェブと実店舗モニター/u);
  assert.match(text, /\n\nグラッドキューブ、ハイブリッド型AIアバター接客「SiTest AIコンシェルジュ」の提供開始 https:\/\/corp\.glad-cube\.com\/news\/pressrelease\/1256\/$/u);
  assert.doesNotMatch(text, /記事:|ニュース一覧/u);
  assert.equal(guardText(text, { sourceMode: 'news' }).ok, true);
  assert.ok([...text].length <= 280);
});

test('AI news tweet eligibility is limited to items from the past day', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  assert.equal(isRecentAiNewsItem({ published_at: '2026-06-01T00:30:00.000Z' }, now), true);
  assert.equal(isRecentAiNewsItem({ published_at: '2026-05-31T11:59:59.000Z' }, now), false);
  assert.equal(isRecentAiNewsItem({ created_at: '2026-06-01T06:00:00.000Z' }, now), true);
  assert.equal(isRecentAiNewsItem({}), false);
});

test('propose and approve dry-run store state without credentials', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nikechan-x-test-'));
  try {
    const env = {
      ...process.env,
      NIKECHAN_X_STATE_DIR: stateDir,
      NIKECHAN_X_RELEASE_MODE: 'dry-run',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    };
    const candidates = JSON.stringify([
      {
        text: '今日はX用の記憶を少し整理しました。次の返事が、前より迷子になりにくいといいです。',
        reason: 'dry-run test',
      },
    ]);
    const proposed = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'propose', '--source-mode', 'memory', '--candidates-json', candidates], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(proposed.status, 0, proposed.stderr);
    assert.match(proposed.stdout, /話題タイプ: memory/u);
    assert.doesNotMatch(proposed.stdout, /node scripts\/nikechan-x\.mjs/u);

    const approved = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'approve', '--ids', '1'], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(approved.stdout, /dry-run/u);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('self tweet revision preserves approval thread when requested', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nikechan-x-test-'));
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'pending-self-tweet.json'), `${JSON.stringify({
      id: 'old-self',
      kind: 'self-tweet',
      status: 'needs_approval',
      threadId: '1510313471366004886',
      threadName: 'X候補 2026-05-31 old',
      notifiedAt: '2026-05-31T01:00:00.000Z',
      candidates: [{ id: '1', text: '古い候補です。', reason: 'old' }],
    })}\n`);
    const env = {
      ...process.env,
      NIKECHAN_X_STATE_DIR: stateDir,
      NIKECHAN_X_RELEASE_MODE: 'dry-run',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    };
    const candidates = JSON.stringify([{ text: '修正後の候補です。', reason: 'revision' }]);
    const proposed = spawnSync(process.execPath, [
      'scripts/nikechan-x.mjs',
      'propose',
      '--preserve-thread',
      'true',
      '--candidates-json',
      candidates,
    ], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(proposed.status, 0, proposed.stderr);
    const pending = JSON.parse(await readFile(join(stateDir, 'pending-self-tweet.json'), 'utf8'));
    assert.equal(pending.supersedesPendingId, 'old-self');
    assert.equal(pending.threadId, '1510313471366004886');
    assert.equal(pending.threadName, 'X候補 2026-05-31 old');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('manual post dry-run validates tweet id and records state', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nikechan-x-test-'));
  try {
    const env = {
      ...process.env,
      NIKECHAN_X_STATE_DIR: stateDir,
      NIKECHAN_X_RELEASE_MODE: 'dry-run',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    };
    const missingId = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'post', '--action', 'reply', '--text', '返信のテストです。'], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.notEqual(missingId.status, 0);
    assert.match(missingId.stderr, /missing --tweet-id/u);

    const posted = spawnSync(process.execPath, [
      'scripts/nikechan-x.mjs',
      'post',
      '--action',
      'reply',
      '--tweet-id',
      '1234567890',
      '--text',
      '返信のテストです。記録だけ残します。',
    ], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(posted.status, 0, posted.stderr);
    assert.match(posted.stdout, /dryRun/u);

    const state = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'state', '--json'], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(state.status, 0, state.stderr);
    assert.match(state.stdout, /lastManualPostAction/u);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('manual post live mode is blocked unless live posting is armed', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nikechan-x-test-'));
  try {
    const env = {
      ...process.env,
      NIKECHAN_X_STATE_DIR: stateDir,
      NIKECHAN_X_RELEASE_MODE: 'live',
      NIKECHAN_X_LIVE_ARMED: 'no',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    };
    const posted = spawnSync(process.execPath, [
      'scripts/nikechan-x.mjs',
      'post',
      '--action',
      'tweet',
      '--text',
      'live投稿は二段階の安全確認が通るまで止めます。',
    ], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.notEqual(posted.status, 0);
    assert.match(posted.stderr, /live posting blocked/u);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('doctor reports missing credentials without exposing secret values', () => {
  const env = {
    ...process.env,
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    XAI_API_KEY: '',
    X_CONSUMER_KEY: '',
    X_CONSUMER_SECRET: '',
    X_ACCESS_TOKEN: '',
    X_ACCESS_TOKEN_SECRET: '',
    DISCORD_BOT_TOKEN: '',
    DISCORD_HOME_CHANNEL: '',
    DISCORD_ALLOWED_USERS: '',
  };
  const result = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'doctor', '--json', '--strict', 'false'], {
    cwd: join(import.meta.dirname, '..'),
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.checks.some((check) => check.name === 'env:X_CONSUMER_SECRET' && check.ok === false), true);
  assert.equal(result.stdout.includes('sb_secret_'), false);
});

test('preflight-live reports dry-run mode as not ready without strict failure', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nikechan-x-test-'));
  try {
    const env = {
      ...process.env,
      NIKECHAN_X_STATE_DIR: stateDir,
      NIKECHAN_X_RELEASE_MODE: 'dry-run',
      NIKECHAN_X_LIVE_ARMED: 'no',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      XAI_API_KEY: '',
      X_CONSUMER_KEY: '',
      X_CONSUMER_SECRET: '',
      X_ACCESS_TOKEN: '',
      X_ACCESS_TOKEN_SECRET: '',
      DISCORD_BOT_TOKEN: '',
      DISCORD_HOME_CHANNEL: '',
      DISCORD_ALLOWED_USERS: '',
    };
    const result = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'preflight-live', '--json', '--strict', 'false'], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.releaseMode, 'dry-run');
    assert.equal(parsed.checks.some((check) => check.name === 'release-mode:live' && check.ok === false), true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('notify-pending requires discord token and keeps pending intact', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nikechan-x-test-'));
  try {
    const env = {
      ...process.env,
      NIKECHAN_X_STATE_DIR: stateDir,
      NIKECHAN_X_RELEASE_MODE: 'dry-run',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      DISCORD_BOT_TOKEN: '',
      DISCORD_HOME_CHANNEL: '1509865603714908304',
    };
    const candidates = JSON.stringify([
      {
        text: '通知テスト用の候補です。承認前なので投稿はしません。',
        reason: 'notify test',
      },
    ]);
    const proposed = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'propose', '--candidates-json', candidates], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(proposed.status, 0, proposed.stderr);

    const notified = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'notify-pending'], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.notEqual(notified.status, 0);
    assert.match(notified.stderr, /missing DISCORD_BOT_TOKEN/u);

    const pending = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'pending'], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(pending.status, 0, pending.stderr);
    assert.match(pending.stdout, /通知テスト用の候補/u);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('resolve approves explicit candidate and stores result', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nikechan-x-test-'));
  try {
    const env = {
      ...process.env,
      NIKECHAN_X_STATE_DIR: stateDir,
      NIKECHAN_X_RELEASE_MODE: 'dry-run',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    };
    const candidates = JSON.stringify([
      { text: '一番目の候補です。承認されない想定です。', reason: 'first' },
      { text: '二番目の候補です。番号指定で承認します。', reason: 'second' },
    ]);
    const proposed = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'propose', '--candidates-json', candidates], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(proposed.status, 0, proposed.stderr);

    const resolved = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'resolve', '--text', '2番でお願いします'], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.match(resolved.stdout, /二番目の候補/u);

    const state = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'state', '--json'], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(state.status, 0, state.stderr);
    const parsed = JSON.parse(state.stdout);
    assert.equal(parsed.pending, null);
    assert.deepEqual(parsed.lastResult.selectedIds, ['2']);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('resolve records revise feedback without closing pending', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nikechan-x-test-'));
  try {
    const env = {
      ...process.env,
      NIKECHAN_X_STATE_DIR: stateDir,
      NIKECHAN_X_RELEASE_MODE: 'dry-run',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    };
    const candidates = JSON.stringify([
      { text: '修正テスト用の候補です。', reason: 'revise' },
    ]);
    const proposed = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'propose', '--candidates-json', candidates], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(proposed.status, 0, proposed.stderr);

    const resolved = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'resolve', '--text', 'もう少しニケちゃんらしく修正して'], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.match(resolved.stdout, /revise/u);

    const state = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'state', '--json'], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(state.stdout);
    assert.equal(parsed.pending.status, 'needs_approval');
    assert.match(parsed.runState.lastFeedbackText, /修正/u);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('mention propose and approve dry-run use local pending state', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nikechan-x-test-'));
  try {
    await mkdir(stateDir, { recursive: true });
    const context = {
      candidates: [
        {
          id: 'm1',
          tweetLogId: 'log-1',
          postId: '1234567890',
          username: 'darche2',
          displayName: 'だーしゅ',
          nickname: 'だーしゅさん',
          type: 'reply',
          body: 'おかえりなさい',
          personContext: '必ず使う呼称: だーしゅさん',
        },
      ],
    };
    await writeFile(join(stateDir, 'mention-context.json'), `${JSON.stringify(context)}\n`);
    const env = {
      ...process.env,
      NIKECHAN_X_STATE_DIR: stateDir,
      NIKECHAN_X_RELEASE_MODE: 'dry-run',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    };
    const items = JSON.stringify({
      items: [
        {
          id: 'm1',
          tweetLogId: 'log-1',
          postId: '1234567890',
          username: 'darche2',
          displayName: 'だーしゅ',
          type: 'reply',
          body: 'おかえりなさい',
          replyAction: 'reply',
          quoteAction: 'skip',
          replyText: 'おかえりなさい、戻りました。',
          reason: '復帰への挨拶に返す',
        },
      ],
    });
    const proposed = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'mention-propose', '--items-json', items], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(proposed.status, 0, proposed.stderr);
    assert.match(proposed.stdout, /ただいま戻りました/u);
    const pending = JSON.parse(await readFile(join(stateDir, 'pending-mention-reaction.json'), 'utf8'));
    assert.equal(pending.items[0].body, 'おかえりなさい');

    const approved = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'mention-approve', '--ids', 'm1'], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(approved.stdout, /返信1件/u);
    const result = JSON.parse(await readFile(join(stateDir, 'last-mention-reaction-result.json'), 'utf8'));
    assert.equal(result.dryRun, true);
    assert.equal(result.results[0].action, 'reply');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('mention propose preserves candidate body over model summaries', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nikechan-x-test-'));
  try {
    await mkdir(stateDir, { recursive: true });
    const context = {
      candidates: [
        {
          id: 'm1',
          tweetLogId: 'log-1',
          postId: '1234567890',
          username: 'darche2',
          displayName: 'だーしゅ',
          type: 'reply',
          body: '@ai_nikechan その場に合わせて変わっていいと思います',
          originalTweetId: '111',
          originalTweetText: '人格が増えたわけではありません。たぶん。',
        },
      ],
    };
    await writeFile(join(stateDir, 'mention-context.json'), `${JSON.stringify(context)}\n`);
    const env = {
      ...process.env,
      NIKECHAN_X_STATE_DIR: stateDir,
      NIKECHAN_X_RELEASE_MODE: 'dry-run',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    };
    const items = JSON.stringify({
      items: [
        {
          id: 'm1',
          tweetLogId: 'log-1',
          postId: '1234567890',
          username: 'darche2',
          displayName: 'だーしゅ',
          type: 'reply',
          body: 'Person shared an opinion about changing personality by situation.',
          originalTweetText: 'Original tweet summarized in English.',
          replyAction: 'reply',
          quoteAction: 'skip',
          replyText: 'ありがとうございます。その場に合わせながら、同じ私として返していきます。',
          reason: '考えを受け止める返信',
        },
      ],
    });
    const proposed = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'mention-propose', '--items-json', items], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(proposed.status, 0, proposed.stderr);
    const pending = JSON.parse(await readFile(join(stateDir, 'pending-mention-reaction.json'), 'utf8'));
    assert.equal(pending.items[0].body, context.candidates[0].body);
    assert.equal(pending.items[0].originalTweetText, context.candidates[0].originalTweetText);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('mention resolve treats reply OK as the only actionable item approval', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nikechan-x-test-'));
  try {
    await mkdir(stateDir, { recursive: true });
    const context = {
      candidates: [
        {
          id: 'm1',
          tweetLogId: 'log-1',
          postId: '1234567890',
          username: 'kubo',
          displayName: 'KuboAvatar',
          type: 'reply',
          body: '日々成長！',
        },
        {
          id: 'm2',
          tweetLogId: 'log-2',
          postId: '2234567890',
          username: 'tegnike',
          displayName: 'ニケちゃん',
          type: 'mention',
          body: '作業報告',
        },
      ],
    };
    await writeFile(join(stateDir, 'mention-context.json'), `${JSON.stringify(context)}\n`);
    const env = {
      ...process.env,
      NIKECHAN_X_STATE_DIR: stateDir,
      NIKECHAN_X_RELEASE_MODE: 'dry-run',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    };
    const items = JSON.stringify({
      items: [
        {
          id: 'm1',
          tweetLogId: 'log-1',
          postId: '1234567890',
          username: 'kubo',
          displayName: 'KuboAvatar',
          type: 'reply',
          body: '日々成長！',
          replyAction: 'reply',
          quoteAction: 'skip',
          replyText: 'ありがとうございます。これからも少しずつ成長します。',
          reason: '応援への返信',
        },
        {
          id: 'm2',
          tweetLogId: 'log-2',
          postId: '2234567890',
          username: 'tegnike',
          displayName: 'ニケちゃん',
          type: 'mention',
          body: '作業報告',
          replyAction: 'skip',
          quoteAction: 'skip',
          reason: '反応不要',
        },
      ],
    });
    const proposed = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'mention-propose', '--items-json', items], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(proposed.status, 0, proposed.stderr);

    const resolved = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'mention-resolve', '--text', '返信OK'], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(resolved.status, 0, resolved.stderr);
    const result = JSON.parse(await readFile(join(stateDir, 'last-mention-reaction-result.json'), 'utf8'));
    assert.deepEqual(result.results.map((entry) => entry.itemId), ['m1']);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('thread-context matches mention pending and excludes self tweet routing', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nikechan-x-test-'));
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'pending-mention-reaction.json'), `${JSON.stringify({
      id: 'mention-pending',
      kind: 'mention-reaction',
      status: 'needs_approval',
      threadId: '1510314049735360582',
      threadName: 'Xメンション 2026-05-31 mention',
      items: [
        {
          id: 'm1',
          tweetLogId: 'log-1',
          postId: '1234567890',
          username: 'harumeri_',
          type: 'reply',
          body: '@ai_nikechan 😭',
          replyAction: 'reply',
          quoteAction: 'skip',
          replyText: 'ありがとうございます。',
          reason: 'reply',
        },
      ],
    })}\n`);
    await writeFile(join(stateDir, 'pending-self-tweet.json'), `${JSON.stringify({
      id: 'self-pending',
      kind: 'self-tweet',
      status: 'needs_approval',
      threadId: '1510313471366004886',
      candidates: [{ id: '1', text: '別の候補です。' }],
    })}\n`);
    const env = {
      ...process.env,
      NIKECHAN_X_STATE_DIR: stateDir,
      NIKECHAN_X_RELEASE_MODE: 'dry-run',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    };
    const result = spawnSync(process.execPath, [
      'scripts/nikechan-x.mjs',
      'thread-context',
      '--thread-id',
      '1510314049735360582',
      '--json',
    ], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.match, true);
    assert.equal(parsed.workflow, 'mention-reaction');
    assert.equal(parsed.pending.id, 'mention-pending');
    assert.match(parsed.routingInstruction.join('\n'), /Do not execute self-tweet/u);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('mention revision can preserve approval thread when requested', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nikechan-x-test-'));
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'pending-mention-reaction.json'), `${JSON.stringify({
      id: 'old-mention',
      kind: 'mention-reaction',
      status: 'needs_approval',
      threadId: '1510314049735360582',
      threadName: 'Xメンション 2026-05-31 old',
      notifiedAt: '2026-05-31T01:00:00.000Z',
      items: [{ id: 'm1', tweetLogId: 'old-log', postId: '111', replyAction: 'reply', replyText: 'old' }],
    })}\n`);
    const context = {
      revisionCount: 1,
      candidates: [
        {
          id: 'm1',
          tweetLogId: 'new-log',
          postId: '222',
          username: 'harumeri_',
          displayName: 'はるめり',
          type: 'reply',
          body: '@ai_nikechan 😭',
        },
      ],
    };
    await writeFile(join(stateDir, 'mention-context.json'), `${JSON.stringify(context)}\n`);
    const env = {
      ...process.env,
      NIKECHAN_X_STATE_DIR: stateDir,
      NIKECHAN_X_RELEASE_MODE: 'dry-run',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    };
    const items = JSON.stringify({
      items: [
        {
          id: 'm1',
          tweetLogId: 'new-log',
          postId: '222',
          username: 'harumeri_',
          displayName: 'はるめり',
          type: 'reply',
          body: '@ai_nikechan 😭',
          replyAction: 'reply',
          quoteAction: 'skip',
          replyText: 'はるめりさん、ありがとうございます。',
          reason: '修正版',
        },
      ],
    });
    const proposed = spawnSync(process.execPath, [
      'scripts/nikechan-x.mjs',
      'mention-propose',
      '--preserve-thread',
      'true',
      '--items-json',
      items,
    ], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(proposed.status, 0, proposed.stderr);
    const pending = JSON.parse(await readFile(join(stateDir, 'pending-mention-reaction.json'), 'utf8'));
    assert.equal(pending.supersedesPendingId, 'old-mention');
    assert.equal(pending.threadId, '1510314049735360582');
    assert.equal(pending.threadName, 'Xメンション 2026-05-31 old');
    assert.equal(pending.revisionCount, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('mention propose supersedes old pending and notify does not resend existing thread', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nikechan-x-test-'));
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'pending-mention-reaction.json'), `${JSON.stringify({
      id: 'old-pending',
      kind: 'mention-reaction',
      status: 'needs_approval',
      createdAt: '2026-05-29T21:11:42.299Z',
      threadId: '1510027893588234320',
      threadName: 'Xメンション 2026-05-30 old',
      notifiedAt: '2026-05-30T07:10:44.126Z',
      items: [
        {
          id: 'm1',
          tweetLogId: 'old-log',
          postId: '2060437768220942728',
          username: 'KuboAvatar',
          type: 'reply',
          body: '@ai_nikechan 日々成長！♪',
          replyAction: 'reply',
          quoteAction: 'skip',
          replyText: 'ありがとうございます。',
          reason: 'old',
        },
      ],
    })}\n`);
    const env = {
      ...process.env,
      NIKECHAN_X_STATE_DIR: stateDir,
      NIKECHAN_X_RELEASE_MODE: 'dry-run',
      DISCORD_BOT_TOKEN: '',
      DISCORD_HOME_CHANNEL: '1509865603714908304',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    };

    const skipped = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'notify-mention-pending', '--thread', '--json'], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(JSON.parse(skipped.stdout).skipped, true);

    const context = {
      candidates: [
        {
          id: 'm1',
          tweetLogId: 'new-log',
          postId: '2060473822458093742',
          username: 'darche2',
          displayName: 'だーしゅ',
          type: 'reply',
          body: '@ai_nikechan その場に合わせて変わっていいと思います',
        },
      ],
    };
    await writeFile(join(stateDir, 'mention-context.json'), `${JSON.stringify(context)}\n`);
    const items = JSON.stringify({
      items: [
        {
          id: 'm1',
          tweetLogId: 'new-log',
          postId: '2060473822458093742',
          username: 'darche2',
          displayName: 'だーしゅ',
          type: 'reply',
          body: '@ai_nikechan その場に合わせて変わっていいと思います',
          replyAction: 'reply',
          quoteAction: 'skip',
          replyText: 'ありがとうございます。その場に合わせながら、同じ私として返していきます。',
          reason: '新しい未対応返信への反応',
        },
      ],
    });
    const proposed = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'mention-propose', '--items-json', items], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(proposed.status, 0, proposed.stderr);
    const pending = JSON.parse(await readFile(join(stateDir, 'pending-mention-reaction.json'), 'utf8'));
    assert.equal(pending.supersedesPendingId, 'old-pending');
    assert.equal(pending.items[0].postId, '2060473822458093742');
    assert.equal(pending.threadId, undefined);
    const archived = await readdir(stateDir);
    assert.ok(archived.some((name) => name.includes('superseded-by-new-mention-context')));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('hashtag execute dry-run reports retweets without credentials', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nikechan-x-test-'));
  try {
    await mkdir(stateDir, { recursive: true });
    const context = {
      candidates: [
        {
          id: 'h1',
          tweetLogId: 'log-1',
          postId: '1234567890',
          username: 'lilyAIstudy',
          displayName: 'リリー',
          body: '#AIニケちゃん ファンアートです',
        },
      ],
    };
    await writeFile(join(stateDir, 'hashtag-context.json'), `${JSON.stringify(context)}\n`);
    const env = {
      ...process.env,
      NIKECHAN_X_STATE_DIR: stateDir,
      NIKECHAN_X_RELEASE_MODE: 'dry-run',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    };
    const items = JSON.stringify({
      items: [
        {
          id: 'h1',
          tweetLogId: 'log-1',
          postId: '1234567890',
          username: 'lilyAIstudy',
          displayName: 'リリー',
          body: '#AIニケちゃん ファンアートです',
          action: 'retweet',
          reason: 'ファンアートのため',
        },
      ],
    });
    const executed = spawnSync(process.execPath, ['scripts/nikechan-x.mjs', 'hashtag-execute', '--items-json', items], {
      cwd: join(import.meta.dirname, '..'),
      env,
      encoding: 'utf8',
    });
    assert.equal(executed.status, 0, executed.stderr);
    assert.match(executed.stdout, /RT（1件）/u);
    assert.match(executed.stdout, /dry-run retweet/u);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
