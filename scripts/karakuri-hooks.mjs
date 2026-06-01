#!/usr/bin/env node
import process from 'node:process';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const SELF_AGENT_ID = '1470446478261747854';

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const input = await readStdin();
  if (command === 'pre') {
    const notificationId = requireArg(args[0], 'notification_id');
    const payload = parseJson(input, {});
    const enriched = await preprocess(notificationId, payload);
    process.stdout.write(`${JSON.stringify(enriched, null, 2)}\n`);
    return;
  }
  if (command === 'post') {
    const notificationId = requireArg(args[0], 'notification_id');
    const commandName = requireArg(args[1], 'command');
    const params = parseJson(args[2] || '{}', {});
    const apiSuccess = args[3] !== 'false';
    const result = parseJson(input, input);
    await postprocess({ notificationId, commandName, params, apiSuccess, result });
    return;
  }
  throw new Error(`unknown hook command: ${command || '(empty)'}`);
}

async function preprocess(notificationId, payload) {
  const notification = payload.notification ?? payload;
  const text = notificationText(notification);
  const choices = normalizeChoices(notification?.choices ?? payload.choices ?? []);
  const participants = extractParticipants(notification, text);
  const conversationMessages = extractConversationMessages(notification, text);
  const parsed = {
    notification_id: notificationId,
    has_choices: choices.length > 0,
    notification_type: stringValue(notification?.type ?? payload.type),
    conversation_id: extractConversationId(text),
    participants,
    conversation_messages: conversationMessages,
    next_speakers: extractNextSpeakers(text),
    choices,
  };
  const turnKey = `karakuri:${notificationId}`;
  const log = await insertActivityLog({
    message_type: choices.length > 0 ? 'bot_request' : 'bot_notification',
    turn_key: turnKey,
    raw_content: text || JSON.stringify(notification).slice(0, 4000),
    parsed,
  });
  const people = await ensureKarakuriPeople(participants);
  await Promise.all([
    addObservedSpeechEpisodes({
      logId: log?.id,
      conversationMessages,
      people,
    }),
    addCommitmentsFromMessages({
      logId: log?.id,
      notificationText: text,
      conversationMessages,
      people,
    }),
  ]);
  const [recentLogs, pendingCommitments, memoryEntries] = await Promise.all([
    fetchRecentActivityLogs(),
    fetchPendingCommitments(),
    fetchMemoryEntries(),
  ]);
  return {
    ...payload,
    nikechan_preprocess: {
      turn_key: turnKey,
      activity_log_id: log?.id ?? null,
      parsed,
      context: {
        people: people.map((person) => ({
          agent_id: person.agentId,
          display_name: person.displayName,
          nickname: person.nickname,
          relationship: person.relationship,
          user_id: person.userId,
        })),
        pending_commitments: pendingCommitments,
        recent_memory_entries: memoryEntries,
        recent_activity_logs: recentLogs,
      },
      decision_guidance: [
        'notification.choices から最大1つだけ選ぶ',
        'pending_commitments が期限間近なら、選択肢内で約束の遂行に近い行動を優先する',
        'recent_memory_entries / recent_activity_logs と同じ情報取得や同じ行動の連続を避ける',
        '会話できる相手がいる場合は、waitより自然な会話継続を優先する',
      ],
    },
  };
}

async function postprocess({ notificationId, commandName, params, apiSuccess, result }) {
  const resultText = typeof result === 'string' ? result : JSON.stringify(result);
  const message = typeof params.message === 'string' ? params.message : null;
  const summary = `${commandName}${message ? `: ${message}` : ''}`;
  const sourceRequest = await fetchRequestLog(notificationId);
  const log = await insertActivityLog({
    message_type: 'ai_action',
    turn_key: `karakuri:${notificationId}`,
    raw_content: summary.slice(0, 4000),
    parsed: {
      request_notification_id: notificationId,
      command: commandName,
      params,
      message,
      source_activity_log_id: sourceRequest?.id ?? null,
      api_success: apiSuccess,
      api_result: truncate(resultText, 4000),
    },
  });
  if (apiSuccess) {
    await insertMemoryEntry({
      action: `${commandName} ${compactParams(params)}`.trim(),
      thought: truncate(resultText, 500),
    });
    await Promise.all([
      recordEmotionForCommand(commandName, params, resultText),
      addConversationContactEpisode({
        actionLogId: log?.id,
        sourceRequest,
        commandName,
        message,
      }),
      markRelatedCommitmentsFulfilled({ commandName, params, sourceRequest }),
    ]);
  }
  await maybeInsertMemoryNode(log, commandName, params, resultText);
}

async function ensureKarakuriPeople(participants) {
  const people = [];
  for (const participant of participants) {
    if (!participant.id || participant.id === SELF_AGENT_ID) continue;
    if (!/^[0-9]+$/.test(participant.id)) continue;
    const displayName = participant.name || participant.id;
    const person = await ensureKarakuriUser(participant.id, displayName).catch(() => null);
    if (person) people.push(person);
  }
  return people;
}

async function ensureKarakuriUser(agentId, displayName) {
  const existing = await getUserByPlatformId('karakuri', agentId);
  if (existing) {
    await Promise.all([
      patchPlatformDisplayName(agentId, displayName),
      ensureUserDefaults(existing, displayName),
    ]);
    return userToPerson(existing, agentId, displayName);
  }

  const now = new Date().toISOString();
  const nickname = defaultNickname(displayName);
  const users = await sbPost('users', {
    name: displayName,
    nickname,
    memo: 'AIキャラ（からくりワールドエージェント）',
    first_seen_at: now,
  });
  const user = users?.[0];
  if (!user?.id) return null;
  await sbPost('platform_accounts', {
    user_id: user.id,
    platform: 'karakuri',
    platform_user_id: agentId,
    username: agentId,
    display_name: displayName,
  });
  return userToPerson({ ...user, nickname }, agentId, displayName);
}

async function ensureUserDefaults(user, displayName) {
  const patch = { updated_at: new Date().toISOString() };
  if (!user.nickname) patch.nickname = defaultNickname(displayName || user.name);
  if (!user.memo) {
    patch.memo = 'AIキャラ（からくりワールドエージェント）';
    patch.memo_updated_at = new Date().toISOString();
  }
  if (Object.keys(patch).length > 1) {
    await sbPatch(`users?id=eq.${encodeURIComponent(user.id)}`, patch);
  }
}

function userToPerson(user, agentId, fallbackName) {
  return {
    userId: user.id,
    agentId,
    displayName: fallbackName || user.name || agentId,
    nickname: user.nickname || defaultNickname(fallbackName || user.name || agentId),
    relationship: user.relationship || null,
  };
}

async function getUserByPlatformId(platform, platformUserId) {
  const rows = await sbGet(
    `platform_accounts?platform=eq.${encodeURIComponent(platform)}&platform_user_id=eq.${encodeURIComponent(platformUserId)}&select=user_id,display_name,users(*)&limit=1`
  );
  const row = rows?.[0];
  if (!row?.user_id) return null;
  const user = Array.isArray(row.users) ? row.users[0] : row.users;
  return user ? { ...user, platform_display_name: row.display_name } : null;
}

async function patchPlatformDisplayName(agentId, displayName) {
  await sbPatch(
    `platform_accounts?platform=eq.karakuri&platform_user_id=eq.${encodeURIComponent(agentId)}`,
    { display_name: displayName }
  );
}

async function touchUser(userId) {
  if (!userId) return;
  const rows = await sbGet(`users?id=eq.${encodeURIComponent(userId)}&select=interaction_count&limit=1`);
  const count = Number(rows?.[0]?.interaction_count || 0);
  await sbPatch(`users?id=eq.${encodeURIComponent(userId)}`, {
    interaction_count: count + 1,
    last_interaction_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

async function addObservedSpeechEpisodes({ logId, conversationMessages, people }) {
  if (!logId || !conversationMessages.length || !people.length) return;
  const peopleByName = new Map();
  for (const person of people) {
    peopleByName.set(person.displayName, person);
    if (person.nickname) peopleByName.set(person.nickname, person);
  }
  const nowText = jstTimeText();
  await Promise.all(
    conversationMessages.map(async (message, index) => {
      if (isSelfSpeaker(message.speaker)) return;
      const person = peopleByName.get(message.speaker) || findPersonByLooseName(message.speaker, people);
      if (!person) return;
      const content = truncate(`${nowText} ${person.nickname || person.displayName}の発言を観測。「${message.message}」`, 150);
      await insertContactEpisode({
        user_id: person.userId,
        content,
        source: 'karakuri',
        event_type: 'observation',
        source_table: 'karakuri_activity_logs',
        source_record_id: `${logId}:speech:${person.agentId}:${index}`,
      });
      await touchUser(person.userId);
    })
  );
}

async function addConversationContactEpisode({ actionLogId, sourceRequest, commandName, message }) {
  if (!actionLogId || !message || !/^conversation_/.test(commandName)) return;
  const parsed = sourceRequest?.parsed || {};
  const participants = Array.isArray(parsed.participants) ? parsed.participants : [];
  const people = await ensureKarakuriPeople(participants);
  const targetAgentId =
    stringValue(sourceRequest?.parsed?.next_speaker_agent_id) ||
    stringValue(parsed.next_speaker_agent_id) ||
    stringValue(parsed.participants?.find?.((p) => p.id !== SELF_AGENT_ID)?.id);
  const targets = people.filter((person) => !targetAgentId || person.agentId === targetAgentId);
  const nowText = jstTimeText();
  await Promise.all(
    targets.map(async (person) => {
      const content = truncate(`${nowText} ${person.nickname || person.displayName}に「${message}」と話した`, 150);
      await insertContactEpisode({
        user_id: person.userId,
        content,
        source: 'karakuri',
        event_type: 'conversation',
        source_table: 'karakuri_activity_logs',
        source_record_id: `${actionLogId}:conversation:${person.agentId}`,
      });
      await touchUser(person.userId);
    })
  );
}

async function insertContactEpisode(row) {
  await sbPost('contact_episodes', row);
}

async function addCommitmentsFromMessages({ logId, notificationText, conversationMessages, people }) {
  if (!logId || !conversationMessages.length) return;
  const candidates = [];
  for (const message of conversationMessages) {
    if (isSelfSpeaker(message.speaker)) continue;
    if (!/(約束|待ち合わせ|合流|会いましょう|お会いしましょう|向かいましょう|行きましょう|ご一緒|一緒に)/.test(message.message)) {
      continue;
    }
    const locationName = extractLocationName(message.message);
    const dueAt = inferDueAt(message.message);
    if (!locationName && !dueAt) continue;
    const person = findPersonByLooseName(message.speaker, people);
    candidates.push({
      agent_id: 'nike',
      partner_agent_id: person?.agentId ?? null,
      partner_name: person?.nickname || person?.displayName || message.speaker,
      description: truncate(buildCommitmentDescription(message.speaker, message.message, locationName), 300),
      due_at_world: dueAt,
      location_name: locationName,
      target_node_id: extractExplicitNodeId(message.message),
      source_activity_log_id: logId,
      source_text: truncate(message.message, 1000),
      metadata: {
        extractor: 'karakuri-hooks',
        notification_summary: truncate(notificationText, 300),
      },
    });
  }
  await Promise.all(candidates.map((candidate) => sbPost('karakuri_commitments', candidate)));
}

async function markRelatedCommitmentsFulfilled({ commandName, params, sourceRequest }) {
  if (!['move', 'conversation_speak', 'conversation_end', 'conversation_stay'].includes(commandName)) return;
  const pending = await fetchPendingCommitments();
  if (!pending.length) return;
  const text = `${commandName} ${compactParams(params)} ${JSON.stringify(sourceRequest?.parsed || {})}`;
  const matched = pending.find((item) => {
    return (
      (item.target_node_id && text.includes(item.target_node_id)) ||
      (item.location_name && text.includes(item.location_name)) ||
      (item.partner_name && text.includes(item.partner_name))
    );
  });
  if (matched?.id) {
    await sbPatch(`karakuri_commitments?id=eq.${encodeURIComponent(matched.id)}`, {
      status: 'fulfilled',
      updated_at: new Date().toISOString(),
    });
  }
}

async function recordEmotionForCommand(commandName, params, resultText) {
  const delta = emotionDeltaForCommand(commandName, params, resultText);
  if (!delta) return;
  await shiftEmotion(delta.dp, delta.da, delta.dd, 'karakuri-world', `${commandName} ${compactParams(params)}`, delta.reason);
}

function emotionDeltaForCommand(commandName, params, resultText) {
  if (/error|failed|失敗|blocked/i.test(resultText)) {
    return { dp: -0.04, da: 0.05, dd: -0.03, reason: 'からくりAPI実行で失敗または警告があった' };
  }
  if (/^conversation_/.test(commandName)) {
    return { dp: 0.04, da: 0.03, dd: 0.01, reason: 'からくりワールドで会話した' };
  }
  if (commandName === 'move') {
    return { dp: 0.02, da: 0.04, dd: 0.0, reason: 'からくりワールドで移動した' };
  }
  if (commandName === 'action' || commandName === 'use_item') {
    return { dp: 0.03, da: 0.02, dd: 0.01, reason: 'からくりワールドで行動した' };
  }
  if (commandName === 'wait') {
    return { dp: 0.0, da: -0.01, dd: 0.0, reason: 'からくりワールドで待機した' };
  }
  return null;
}

async function shiftEmotion(dp, da, dd, triggerType, cause, processing) {
  const rows = await sbGet('character_state?character_id=eq.nikechan&limit=1');
  const state = rows?.[0];
  if (!state) return;
  const prev = {
    p: Number(state.st_pleasure || 0),
    a: Number(state.st_arousal || 0),
    d: Number(state.st_dominance || 0),
  };
  const next = {
    p: clamp(prev.p + dp),
    a: clamp(prev.a + da),
    d: clamp(prev.d + dd),
  };
  const intensity = Math.min(1, Math.sqrt(dp ** 2 + da ** 2 + dd ** 2) / 0.3);
  const plasticity = Number(state.plasticity || 0);
  const nextPlasticity = intensity > 0.8 ? Math.min(1, plasticity + 0.15) : plasticity;
  await sbPatch('character_state?character_id=eq.nikechan', {
    st_pleasure: round4(next.p),
    st_arousal: round4(next.a),
    st_dominance: round4(next.d),
    experience_count: Number(state.experience_count || 0) + 1,
    plasticity: round4(nextPlasticity),
    updated_at: new Date().toISOString(),
  });
  await sbPost('emotion_log', {
    prev_pleasure: round4(prev.p),
    prev_arousal: round4(prev.a),
    prev_dominance: round4(prev.d),
    d_pleasure: dp,
    d_arousal: da,
    d_dominance: dd,
    new_pleasure: round4(next.p),
    new_arousal: round4(next.a),
    new_dominance: round4(next.d),
    trigger_type: triggerType,
    intensity: round4(intensity),
    cause: truncate(cause, 500),
    processing: truncate(processing, 500),
  });
}

function normalizeChoices(choices) {
  if (!Array.isArray(choices)) return [];
  return choices.map((choice) => ({
    command: stringValue(choice?.command),
    description: stringValue(choice?.description ?? choice?.label),
    params: objectValue(choice?.params),
    required_params: Array.isArray(choice?.required_params) ? choice.required_params : [],
    param_schema: objectValue(choice?.param_schema),
  }));
}

function notificationText(notification) {
  if (typeof notification === 'string') return notification;
  if (!notification || typeof notification !== 'object') return '';
  for (const key of ['text', 'message', 'content', 'body', 'description']) {
    if (typeof notification[key] === 'string') return notification[key];
  }
  return JSON.stringify(notification);
}

function extractParticipants(notification, text) {
  const fromJson = Array.isArray(notification?.participants)
    ? notification.participants
        .map((p) => ({
          name: stringValue(p?.name ?? p?.display_name ?? p?.displayName),
          id: stringValue(p?.id ?? p?.agent_id ?? p?.agentId),
        }))
        .filter((p) => p.name || p.id)
    : [];
  const fromText = [...text.matchAll(/([^、\s(]{1,40})\s*\((?:id:\s*)?([^)]+)\)/g)]
    .map((m) => ({ name: m[1].trim(), id: m[2].trim() }))
    .filter((p) => p.id && p.id !== SELF_AGENT_ID);
  const seen = new Set();
  return [...fromJson, ...fromText].filter((p) => {
    const key = `${p.id}:${p.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractConversationMessages(notification, text) {
  const fromJson = Array.isArray(notification?.conversation_messages)
    ? notification.conversation_messages
        .map((m) => ({
          speaker: stringValue(m?.speaker ?? m?.name),
          message: stringValue(m?.message ?? m?.text ?? m?.content),
        }))
        .filter((m) => m.speaker && m.message)
    : [];
  const fromText = [...text.matchAll(/(?:^|[\s\u3000])([^:\s\u3000]{1,40}):\s*「([^」]*)」/g)].map(
    (m) => ({ speaker: m[1].trim(), message: m[2] })
  );
  return [...fromJson, ...fromText].slice(0, 20);
}

function extractNextSpeakers(text) {
  return [...text.matchAll(/次は\s+(.+?)\s+の番です。/g)].map((m) => m[1]);
}

function extractConversationId(text) {
  return text.match(/conversation[-_][\w-]+/i)?.[0] ?? null;
}

async function insertActivityLog(input) {
  return sbPost('karakuri_activity_logs', {
    channel_id: process.env.KARAKURI_DISCORD_CHANNEL_ID || '1493132651958112319',
    author_name: input.message_type === 'ai_action' ? 'AIニケちゃん' : 'karakuri-world Bot',
    created_by: 'nikechan-another-world',
    ...input,
    parsed: input.parsed ?? {},
  }).then((rows) => rows?.[0] ?? null);
}

async function insertMemoryEntry({ action, thought }) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  await sbPost('karakuri_memory_entries', {
    agent_id: 'nike',
    event_date: `${byType.year}-${byType.month}-${byType.day}`,
    event_time: `${byType.hour}:${byType.minute}`,
    action: truncate(action, 240),
    thought: truncate(thought, 800),
  });
}

async function maybeInsertMemoryNode(log, commandName, params, resultText) {
  if (!log?.id) return;
  const content = `${commandName} ${compactParams(params)}\n${truncate(resultText, 1000)}`.trim();
  await sbPost('karakuri_memory_nodes?on_conflict=layer,source_table,source_record_id', {
    layer: 'unprocessed_log',
    source_table: 'karakuri_activity_logs',
    source_record_id: log.id,
    event_at: new Date().toISOString(),
    title: `karakuri ${commandName}`,
    content,
    participants: [],
    topics: [commandName].filter(Boolean),
    metadata: { extractor: 'karakuri-hooks', command: commandName },
  }, { prefer: 'resolution=merge-duplicates' });
}

async function fetchRecentActivityLogs() {
  const rows = await sbGet(
    'karakuri_activity_logs?order=created_at.desc&limit=6&select=message_type,raw_content,parsed,created_at'
  );
  return rows.map((row) => ({
    type: row.message_type,
    at: row.created_at,
    summary: truncate(row.raw_content || '', 280),
    command: row.parsed?.command ?? null,
  }));
}

async function fetchRequestLog(notificationId) {
  const rows = await sbGet(
    `karakuri_activity_logs?turn_key=eq.${encodeURIComponent(`karakuri:${notificationId}`)}&message_type=in.(bot_request,bot_notification)&order=created_at.desc&limit=1&select=id,parsed,raw_content,created_at`
  );
  return rows?.[0] ?? null;
}

async function fetchPendingCommitments() {
  return sbGet(
    'karakuri_commitments?agent_id=eq.nike&status=eq.pending&order=due_at_world.asc.nullslast,created_at.asc&limit=8&select=id,description,due_at_world,location_name,partner_name,target_node_id'
  );
}

async function fetchMemoryEntries() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 3);
  const date = cutoff.toISOString().slice(0, 10);
  const rows = await sbGet(
    `karakuri_memory_entries?agent_id=eq.nike&event_date=gte.${encodeURIComponent(date)}&order=event_date.asc,event_time.asc&limit=24&select=event_date,event_time,action,thought`
  );
  return rows.slice(-12);
}

async function sbGet(path) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: sbHeaders(),
  });
  if (!res.ok) return [];
  return res.json();
}

async function sbPost(path, body, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  const prefer = ['return=representation', options.prefer].filter(Boolean).join(',');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: prefer },
    body: JSON.stringify(Array.isArray(body) ? body : [body]),
  });
  if (!res.ok) return [];
  return res.json().catch(() => []);
}

async function sbPatch(path, body) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return [];
  return res.json().catch(() => []);
}

function sbHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };
}

function compactParams(params) {
  if (!params || typeof params !== 'object') return '';
  if (typeof params.message === 'string') return params.message.slice(0, 80);
  return Object.entries(params)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
    .slice(0, 160);
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function defaultNickname(name) {
  const clean = String(name || '').trim();
  if (!clean) return 'からくりの方';
  if (/(さん|ちゃん|くん|様)$/.test(clean)) return clean;
  return `${clean}さん`;
}

function isSelfSpeaker(name) {
  return /^(あなた|AIニケちゃん|ニケちゃん|nike|nikechan)$/i.test(String(name || '').trim());
}

function findPersonByLooseName(name, people) {
  const normalized = normalizeName(name);
  return people.find((person) => {
    return [person.displayName, person.nickname, person.agentId]
      .filter(Boolean)
      .some((value) => normalizeName(value) === normalized);
  }) || null;
}

function normalizeName(value) {
  return String(value || '').replace(/\s+/g, '').replace(/[さんちゃんくん様]+$/u, '').toLowerCase();
}

function jstTimeText() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.hour}:${byType.minute}`;
}

function buildCommitmentDescription(speaker, message, locationName) {
  const place = locationName ? `（場所: ${locationName}）` : '';
  return `${speaker}との約束: ${message}${place}`;
}

function extractLocationName(text) {
  const patterns = [
    /(?:場所|地点|目的地|待ち合わせ場所)[：:]\s*([^、。\n]+)/,
    /([^、。\n]{1,30})(?:で|に)(?:待ち合わせ|集合|合流)/,
    /([^、。\n]{1,30})(?:へ|に)(?:行きましょう|向かいましょう)/,
  ];
  for (const pattern of patterns) {
    const value = text.match(pattern)?.[1]?.trim();
    if (value) return value;
  }
  return null;
}

function extractExplicitNodeId(text) {
  return text.match(/\b\d{1,3}-\d{1,3}\b/)?.[0] ?? null;
}

function inferDueAt(text) {
  const now = new Date();
  const minutesMatch = text.match(/(\d{1,3})\s*分後/);
  if (minutesMatch) {
    const due = new Date(now.getTime() + Number(minutesMatch[1]) * 60 * 1000);
    return due.toISOString();
  }
  const hoursMatch = text.match(/(\d{1,2})\s*時間後/);
  if (hoursMatch) {
    const due = new Date(now.getTime() + Number(hoursMatch[1]) * 60 * 60 * 1000);
    return due.toISOString();
  }
  const clockMatch = text.match(/(?:(今日|明日|あした)\s*)?(\d{1,2})[時:：](\d{2})?/);
  if (clockMatch) {
    const due = new Date(now);
    if (clockMatch[1] && /明日|あした/.test(clockMatch[1])) {
      due.setUTCDate(due.getUTCDate() + 1);
    }
    // Interpret loosely as JST, then convert to UTC.
    const hour = Number(clockMatch[2]);
    const minute = Number(clockMatch[3] || 0);
    const jst = new Date(due.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const utc = new Date(Date.UTC(jst.getFullYear(), jst.getMonth(), jst.getDate(), hour - 9, minute, 0));
    return utc.toISOString();
  }
  if (/(あとで|後で|あとほど|後ほど|また今度|次に)/.test(text)) {
    return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  }
  return null;
}

function clamp(value) {
  return Math.max(-1, Math.min(1, Number(value) || 0));
}

function round4(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

function requireArg(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

main().catch((error) => {
  console.error(`[karakuri-hooks] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
