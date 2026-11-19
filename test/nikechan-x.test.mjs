import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildAiNewsTweetText,
  guardText,
  isRecentAiNewsItem,
  tweetWeightedLength,
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

test('release mode changes require explicit live confirmation', () => {
  assert.deepEqual(validateReleaseModeChange('dry-run'), { ok: true, mode: 'dry-run', liveArmed: false });
  assert.equal(validateReleaseModeChange('canary-live').ok, false);
  assert.equal(validateReleaseModeChange('live').ok, false);
  assert.deepEqual(validateReleaseModeChange('live', 'LIVE_X_POSTING'), { ok: true, mode: 'live', liveArmed: true });
});

test('AI news tweet text selects a long-form variant and appends only the source URL', () => {
  const variants = [
    'グラッドキューブが、ハイブリッド型AIアバター接客「SiTest AIコンシェルジュ」を発表しました。\n\nウェブと実店舗の案内をつなぐ仕組みで、私はキャラクターへの愛着まで接客設計に入れている点に注目しています。',
    'グラッドキューブは、ウェブと実店舗で使えるAIアバター接客を公開しました。\n\n私が見てみたいのは、同じキャラが画面と店舗の間でどこまで関係をつなげられるかです。',
    'グラッドキューブが、AIアバター接客の新サービスを提供します。\n\n回答精度だけでなく、キャラクターとしての親しみを接客に持ち込む設計が私には興味深いです。',
  ];
  const text = buildAiNewsTweetText({
    title: 'グラッドキューブ、ハイブリッド型AIアバター接客「SiTest AIコンシェルジュ」の提供開始',
    url: 'https://corp.glad-cube.com/news/pressrelease/1256/',
    x_post_variants: variants,
  }, 0);

  assert.ok(text.startsWith(variants[0]));
  assert.match(text, /\n\nhttps:\/\/corp\.glad-cube\.com\/news\/pressrelease\/1256\/$/u);
  assert.doesNotMatch(text, /グラッドキューブ、ハイブリッド型/u);
});

test('AI news long-form text uses the dedicated max length', () => {
  const longVariant = 'ニュースの発表内容を最初の一文で明確に説明しました。\n\n' + '私がAIキャラクターの体験として注目している具体的な理由を説明します。'.repeat(10);
  const text = buildAiNewsTweetText({
    url: 'https://www.prnewswire.com/news-releases/in2ition-ai-launches-iris-the-always-on-ai-companion-that-participates-in-conversations-instead-of-analyzing-them-after-they-end-302789131.html',
    x_post_variants: [longVariant, `${longVariant}A`, `${longVariant}B`],
  }, 0);

  assert.ok(tweetWeightedLength(text) > 280);
  assert.equal(guardText(text, { sourceMode: 'news' }).ok, false);
  assert.equal(guardText(text, { sourceMode: 'news', maxLength: 1000 }).ok, true);
});

test('AI news tweet eligibility uses the addition time, not the source publication time', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  assert.equal(isRecentAiNewsItem({
    discovered_at: '2026-06-01T06:00:00.000Z',
    published_at: '2026-06-01T00:30:00.000Z',
  }, now), true);
  assert.equal(isRecentAiNewsItem({
    discovered_at: '2026-06-01T06:00:00.000Z',
    published_at: '2026-05-30T11:59:59.000Z',
  }, now), true);
  assert.equal(isRecentAiNewsItem({
    discovered_at: '2026-05-30T11:59:59.000Z',
    published_at: '2026-06-01T00:30:00.000Z',
  }, now), false);
  assert.equal(isRecentAiNewsItem({ created_at: '2026-06-01T06:00:00.000Z' }, now), true);
  assert.equal(isRecentAiNewsItem({
    published_at: '2026-05-31T00:00:00.000Z',
    created_at: '2026-06-01T06:00:00.000Z',
  }, now), true);
  assert.equal(isRecentAiNewsItem({ discovered_at: '2026-06-01T13:00:00.000Z' }, now), false);
  assert.equal(isRecentAiNewsItem({}), false);
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

test('thread-context matches mention pending', async () => {
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

test('person profile keeps only checked note fields and who wrote them', async () => {
  const { projectPersonProfile } = await import('../scripts/nikechan-x.mjs');
  assert.deepEqual(projectPersonProfile({ person: { profiles: [
    { field: 'memo', text: ' 動画制作をしている人 ', source: 'automatic', fingerprint: 'x' },
    { field: 'guidance', text: 'やさしく短めに', source: 'master' },
    { field: 'unknown', text: 'ignored', source: 'master' },
    { field: 'context', text: '', source: 'automatic' },
  ] } }), {
    memo: { text: '動画制作をしている人', writtenBy: 'automatic' },
    guidance: { text: 'やさしく短めに', writtenBy: 'master' },
  });
  assert.equal(projectPersonProfile({ person: null, unresolved: true }), undefined);
  assert.deepEqual(projectPersonProfile({ person: { profiles: [], recent_broadcasts: [
    { title: 'ゲームセンター配信', date: '2026-10-04', comment_count: 12 }, { title: null, date: 'bad', comment_count: 1 },
  ] } }), { recentStreamVisits: [{ title: 'ゲームセンター配信', date: '2026-10-04', commentCount: 12 }] });
  assert.equal(projectPersonProfile(null), undefined);
});

test('reply that pastes person notes is blocked, natural use is allowed', async () => {
  const { guardPersonProfileCopy, normalizeMentionItems } = await import('../scripts/nikechan-x.mjs');
  const personProfile = { memo: { text: '個人で3Dモデルを制作していて、最近はVRMの表情設定を細かく調整している。', writtenBy: 'automatic' },
    guidance: { text: 'やさしく短めに話す', writtenBy: 'master' } };
  assert.equal(guardPersonProfileCopy('表情の調整、進んでいるみたいでうれしいです！', personProfile).ok, true);
  assert.equal(guardPersonProfileCopy('最近はVRMの表情設定を細かく調整しているんですよね！', personProfile).ok, false);
  assert.equal(guardPersonProfileCopy('やさしく短めに話すね', personProfile).ok, true);
  const candidate = { id: 'm1', tweetLogId: '1', postId: '10', username: 'alpha', displayName: 'Alpha',
    nickname: 'アルファさん', type: 'reply', body: '表情できた！', personProfile };
  const [copied, natural] = normalizeMentionItems([
    { id: 'm1', tweetLogId: '1', replyAction: 'reply', quoteAction: 'skip', reason: '理由',
      replyText: '最近はVRMの表情設定を細かく調整しているんですよね！', replyUsedPersonProfile: true },
    { id: 'm1', tweetLogId: '1', replyAction: 'reply', quoteAction: 'skip', reason: '理由',
      replyText: '表情の調整、進んでいるみたいでうれしいです！', replyUsedPersonProfile: true },
  ], [candidate]);
  assert.equal(copied.replyAction, 'skip');
  assert.match(copied.guards.reply.errors.join(' '), /copies person memo text/);
  assert.equal(natural.replyAction, 'reply');
  assert.equal(natural.replyUsedPersonProfile, true);
  assert.equal(natural.personProfile, undefined, 'notes stay in candidates, not in proposed items');
});
