#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const STATE_PATH =
  process.env.KARAKURI_NIGHT_REST_STATE_PATH ||
  '/profile/profiles/nikechan-another-world/state/karakuri-night-rest.json';
const LOCK_PATH =
  process.env.KARAKURI_NIGHT_REST_LOCK_PATH ||
  '/profile/profiles/nikechan-another-world/state/karakuri-night-rest.lock';
const KARAKURI_BIN = process.env.KARAKURI_BIN || '/profile/profiles/nikechan-another-world/bin/karakuri.sh';
const TIME_ZONE = process.env.KARAKURI_NIGHT_REST_TIMEZONE || 'Asia/Tokyo';
const NIGHT_START_HOUR = intEnv('KARAKURI_NIGHT_REST_START_HOUR', 22);
const NIGHT_END_HOUR = intEnv('KARAKURI_NIGHT_REST_END_HOUR', 9);
const SLEEP_HOURS = intEnv('KARAKURI_NIGHT_REST_SLEEP_HOURS', 8);
const BUSY_LOOKBACK_HOURS = intEnv('KARAKURI_NIGHT_REST_BUSY_LOOKBACK_HOURS', 8);
const CONVERSATION_BUSY_MINUTES = intEnv('KARAKURI_NIGHT_REST_CONVERSATION_BUSY_MINUTES', 120);
const DRY_RUN = process.env.KARAKURI_NIGHT_REST_DRY_RUN === '1';

async function main() {
  await withLock(async () => {
    const now = nowDate();
    const state = await loadState();

    if (state.sleeping) {
      const wakeAt = new Date(state.wake_at);
      if (Number.isNaN(wakeAt.getTime())) {
        await saveState({ sleeping: false, last_error: 'invalid_wake_at', updated_at: now.toISOString() });
        log({ action: 'reset_invalid_state', now: now.toISOString() });
        return;
      }
      if (now >= wakeAt) {
        const result = await runKarakuri('login');
        await saveState({
          sleeping: false,
          logged_out_at: state.logged_out_at ?? null,
          wake_at: wakeAt.toISOString(),
          logged_in_at: now.toISOString(),
          login_result: result,
          updated_at: now.toISOString(),
        });
        log({ action: DRY_RUN ? 'dry_run_login' : 'login', now: now.toISOString(), wake_at: wakeAt.toISOString() });
        return;
      }
      log({ action: 'keep_sleeping', now: now.toISOString(), wake_at: wakeAt.toISOString() });
      return;
    }

    if (!isNight(now)) {
      log({ action: 'outside_night_window', now: now.toISOString(), jst_hour: zonedHour(now) });
      return;
    }

    const recentLogs =
      process.env.KARAKURI_NIGHT_REST_ASSUME_IDLE === '1' ? [] : await fetchRecentActivityLogs(now);
    const busy = detectBusy(recentLogs, now);
    if (busy.busy) {
      log({ action: 'skip_busy', now: now.toISOString(), reason: busy.reason });
      return;
    }

    const wakeAt = new Date(now.getTime() + SLEEP_HOURS * 60 * 60 * 1000);
    const result = await runKarakuri('logout');
    await saveState({
      sleeping: true,
      logged_out_at: now.toISOString(),
      wake_at: wakeAt.toISOString(),
      logout_result: result,
      updated_at: now.toISOString(),
    });
    log({ action: DRY_RUN ? 'dry_run_logout' : 'logout', now: now.toISOString(), wake_at: wakeAt.toISOString() });
  });
}

async function withLock(fn) {
  await mkdir(path.dirname(LOCK_PATH), { recursive: true });
  let handle;
  try {
    handle = await open(LOCK_PATH, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      log({ action: 'skip_locked' });
      return;
    }
    throw error;
  }
  try {
    await handle.writeFile(String(process.pid));
    await fn();
  } finally {
    await handle.close().catch(() => {});
    await import('node:fs/promises').then((fs) => fs.unlink(LOCK_PATH).catch(() => {}));
  }
}

async function fetchRecentActivityLogs(now) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Supabase environment variables are required');
  }
  const since = new Date(now.getTime() - BUSY_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const query = new URL(`${SUPABASE_URL}/rest/v1/karakuri_activity_logs`);
  query.searchParams.set('select', 'created_at,message_type,parsed');
  query.searchParams.set('created_at', `gte.${since}`);
  query.searchParams.set('order', 'created_at.desc');
  query.searchParams.set('limit', '120');
  const response = await fetch(query, {
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
    },
  });
  if (!response.ok) {
    throw new Error(`Supabase activity log fetch failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function detectBusy(logs, now) {
  if (process.env.KARAKURI_NIGHT_REST_ASSUME_IDLE === '1') {
    return { busy: false, reason: 'assume_idle' };
  }

  for (const logEntry of logs) {
    const parsed = normalizeParsed(logEntry.parsed);
    const result = parseApiResult(parsed.api_result);
    const completesAt = Number(result?.completes_at ?? result?.data?.completes_at);
    if (Number.isFinite(completesAt) && completesAt > now.getTime()) {
      return { busy: true, reason: `command_in_progress_until_${new Date(completesAt).toISOString()}` };
    }
  }

  const latestConversation = logs.find((logEntry) => {
    const parsed = normalizeParsed(logEntry.parsed);
    return logEntry.message_type === 'ai_action' && typeof parsed.command === 'string' && parsed.command.startsWith('conversation_');
  });
  if (latestConversation) {
    const parsed = normalizeParsed(latestConversation.parsed);
    const terminal = new Set(['conversation_end', 'conversation_leave', 'conversation_reject']);
    const ageMs = now.getTime() - new Date(latestConversation.created_at).getTime();
    if (!terminal.has(parsed.command) && ageMs < CONVERSATION_BUSY_MINUTES * 60 * 1000) {
      return { busy: true, reason: `recent_${parsed.command}` };
    }
  }

  const latestPrompt = logs.find((logEntry) => logEntry.message_type === 'bot_request');
  if (latestPrompt) {
    const parsed = normalizeParsed(latestPrompt.parsed);
    const commands = Array.isArray(parsed.choices) ? parsed.choices.map((choice) => choice.command) : [];
    if (commands.some((command) => typeof command === 'string' && command.startsWith('conversation_'))) {
      const ageMs = now.getTime() - new Date(latestPrompt.created_at).getTime();
      if (ageMs < CONVERSATION_BUSY_MINUTES * 60 * 1000) {
        return { busy: true, reason: 'conversation_choices_pending' };
      }
    }
  }

  return { busy: false, reason: null };
}

async function runKarakuri(command) {
  if (DRY_RUN) {
    return { dry_run: true, command };
  }
  const { stdout, stderr } = await execFileAsync(KARAKURI_BIN, [command], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return {
    stdout: trimOutput(stdout),
    stderr: trimOutput(stderr),
  };
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function saveState(state) {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  const tempPath = `${STATE_PATH}.tmp.${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tempPath, STATE_PATH);
}

function isNight(date) {
  const hour = zonedHour(date);
  if (NIGHT_START_HOUR < NIGHT_END_HOUR) {
    return hour >= NIGHT_START_HOUR && hour < NIGHT_END_HOUR;
  }
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

function zonedHour(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date);
  return Number(parts.find((part) => part.type === 'hour')?.value);
}

function normalizeParsed(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? value : {};
}

function parseApiResult(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' ? value : null;
}

function intEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) ? value : fallback;
}

function nowDate() {
  const value = process.env.KARAKURI_NIGHT_REST_NOW;
  return value ? new Date(value) : new Date();
}

function trimOutput(value) {
  return String(value || '').slice(0, 4000);
}

function log(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main().catch((error) => {
  console.error(JSON.stringify({ action: 'error', message: error.message }));
  process.exitCode = 1;
});
