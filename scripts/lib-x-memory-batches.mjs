import { createHash } from 'node:crypto';

export const X_BATCH_VERSION = 'x-batch-v2';
const hash = text => createHash('sha256').update(text).digest('hex');
const characters = text => [...text].length;
const validInstant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

// Explicit references are reproducible topic evidence. Generic collection tags
// are not topics, and elapsed time alone never joins unrelated posts.
export function xTopicKeys(row) {
  const urls = (row.content.match(/https?:\/\/[^\s<>「」]+/gu) ?? [])
    .filter(url => !/^https?:\/\/(?:t\.co|(?:www\.)?(?:x|twitter)\.com)\//iu.test(url));
  const tags = (row.content.match(/#[\p{L}\p{N}_]+/gu) ?? [])
    .filter(tag => !['#aituber', '#vtuber', '#ai', '#aiニケちゃん'].includes(tag.toLowerCase()));
  const projects = ['AITuberKit','Codex','Hermes','Irodori-TTS','GPT-Live','Neuro-sama','ポケカAI大会']
    .filter(name => row.content.toLowerCase().includes(name.toLowerCase()));
  return [...new Set([...urls, ...tags, ...projects].map(key => key.toLowerCase()))].sort();
}

export function groupXBatches(rows, { now = new Date(), reservedRevisionIds = [], maxPrimary = 40,
  maxCharacters = 12000, maxHours = 6, stableMinutes = 10 } = {}) {
  if (!Number.isInteger(maxPrimary) || maxPrimary < 1 || maxPrimary > 40 || maxCharacters < 1 || maxCharacters > 12000
    || maxHours <= 0 || maxHours > 6 || stableMinutes < 10) throw Error('invalid_x_grouping_limits');
  const byKey = new Map(), reserved = new Set(reservedRevisionIds), rejected = [];
  for (const row of rows) {
    if (!row || !/^twitter:post:\d+$/u.test(row.source_key ?? '') || !row.revision_id || typeof row.content !== 'string'
      || !row.author_account_id || !validInstant(row.occurred_at) || !validInstant(row.observed_at)
      || row.time_basis !== 'provider' || row.lifecycle === 'deleted' || row.retention_state !== 'retained'
      || row.post_kind === 'retweet' || (row.reasons ?? []).length) {
      rejected.push({ source_key: row?.source_key ?? null, reason: 'ineligible_source' }); continue;
    }
    if (byKey.has(row.source_key)) throw Error('duplicate_x_source');
    byKey.set(row.source_key, { ...row, topic_keys: xTopicKeys(row) });
  }
  const rootFor = row => {
    if (row.conversation_key) return row.conversation_key;
    let cursor = row, key = row.reply_key || row.quote_key, seen = new Set([row.source_key]);
    if (!key) return null;
    // A bounded traversal also tolerates missing archived ancestors.
    for (let i = 0; i < 32 && key && !seen.has(key); i++) {
      seen.add(key); cursor = byKey.get(key);
      if (!cursor) return key;
      const parent = cursor.reply_key || cursor.quote_key;
      if (!parent) return key;
      key = parent;
    }
    return [...seen].sort()[0];
  };
  const order = (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.source_key.localeCompare(b.source_key);
  const eligible = [...byKey.values()].filter(row => !reserved.has(row.revision_id)
    && Date.parse(row.observed_at) <= +now - stableMinutes * 60000).sort(order);
  const groups = [];
  let activeGroups = [];
  for (const row of eligible) {
    // Older groups can never match the existing maximum-span rule.
    activeGroups = activeGroups.filter(g => Date.parse(row.occurred_at) - Date.parse(g.messages[0].occurred_at) <= maxHours * 3600000);
    if (characters(row.content) > maxCharacters) { rejected.push({ source_key: row.source_key, reason: 'oversize_source' }); continue; }
    const root = rootFor(row);
    const parent = byKey.get(row.reply_key || row.quote_key);
    const actor = row.actor_kind === 'nike' && parent && parent.actor_kind !== 'nike'
      ? parent.author_account_id : row.author_account_id;
    const kind = root ? 'thread' : row.actor_kind === 'nike' || row.actor_kind === 'master' ? 'activity'
      : row.direct_with_nike_verified ? 'person_interaction' : 'passive_observation';
    const matches = group => {
      if ((group.kind !== kind && !(root && group.roots.has(root))) || group.messages.length >= maxPrimary || group.chars + characters(row.content) > maxCharacters) return false;
      const span = Date.parse(row.occurred_at) - Date.parse(group.messages[0].occurred_at);
      if (span > (kind === 'activity' ? Math.min(maxHours, 3) : maxHours) * 3600000) return false;
      if (root) return group.roots.has(root);
      if (group.actor !== actor) return false;
      return row.topic_keys.some(key => group.topics.has(key));
    };
    let group = activeGroups.findLast(matches);
    if (!group && root && row.direct_with_nike_verified) {
      group = activeGroups.findLast(g => ['thread','person_interaction'].includes(g.kind) && g.actor === actor
        && row.topic_keys.some(key => g.topics.has(key)) && g.messages.length < maxPrimary
        && g.chars + characters(row.content) <= maxCharacters
        && Date.parse(row.occurred_at) - Date.parse(g.messages[0].occurred_at) <= maxHours * 3600000);
      if (group) { group.kind = 'person_interaction'; group.root = null; group.roots.add(root); }
    }
    if (!group) { group = { kind, root, roots: new Set(root ? [root] : []), actor, topics: new Set(), messages: [], chars: 0 }; groups.push(group); activeGroups.push(group); }
    group.messages.push(row); group.chars += characters(row.content);
    row.topic_keys.forEach(key => group.topics.add(key));
  }
  const batches = groups.map(group => {
    const primaryIds = new Set(group.messages.map(row => row.revision_id));
    const context = [], seen = new Set(primaryIds); let used = group.chars;
    const add = (row, role) => {
      if (!row || seen.has(row.revision_id) || context.length >= 6 || used + characters(row.content) > maxCharacters) return;
      seen.add(row.revision_id); used += characters(row.content); context.push({ ...row, source_role: role });
    };
    for (const row of group.messages) {
      for (const [key, role] of [[row.reply_key, 'parent_context'], [row.quote_key, 'quote_context']]) {
        let cursor = byKey.get(key);
        for (let i = 0; cursor && i < 6; i++) { add(cursor, role); cursor = byKey.get(cursor.reply_key); }
      }
    }
    // At most three already processed posts from the same explicit thread are
    // context only; they cannot generate their own primary memories again.
    if (group.root) [...byKey.values()].filter(row => reserved.has(row.revision_id) && rootFor(row) === group.root
      && order(row, group.messages[0]) < 0).sort(order).slice(-3).forEach(row => add(row, 'overlap_context'));
    const input = [...group.messages.map(row => `primary:${row.revision_id}`), ...context.map(row => `${row.source_role}:${row.revision_id}`)].join('\n');
    const inputHash = hash(input);
    return { batch_key: `${X_BATCH_VERSION}:${inputHash}`, input_hash: inputHash, processor_version: X_BATCH_VERSION,
      grouping_kind: group.kind, root_source_key: group.root, primary_actor_account_id: group.actor,
      window_start: group.messages[0].occurred_at, window_end: group.messages.at(-1).occurred_at,
      messages: group.messages, context, character_count: used };
  });
  return { batches, rejected, primary_count: batches.reduce((n, b) => n + b.messages.length, 0) };
}
