import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { guardText, nextSourceMode } from '../scripts/nikechan-x.mjs';

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
