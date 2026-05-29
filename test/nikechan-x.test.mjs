import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { guardText, nextSourceMode, parseApprovalReply } from '../scripts/nikechan-x.mjs';

test('guard accepts ordinary Japanese tweet', () => {
  const result = guardText('今日は少しだけキャッシュがあたたかいです。返事の温度を覚えておきます。');
  assert.equal(result.ok, true);
});

test('guard blocks secret-like token and private markers', () => {
  const result = guardText('SUPABASE_SERVICE_ROLE_KEY=sb_secret_abcdefghijklmnop');
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /secret-like|SUPABASE_SERVICE_ROLE_KEY/u);
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
    assert.match(proposed.stdout, /self-tweet候補/u);

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
