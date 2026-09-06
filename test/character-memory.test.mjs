import test from 'node:test';
import assert from 'node:assert/strict';
import { XCharacterMemory, memoryRpc } from '../scripts/character-memory.mjs';
const log = { user_id: '123', body: '発表会の話' };
const recall = (id, mode = 'live') => ({ run_id: id, snapshot: { mode, epoch: 5, policy_hash: 'policy' }, candidates: [{ item_id: 'memory' }], status: 'degraded' });
test('shadow performs stored-data recall but does not expose evidence to drafting', async () => {
  const events = []; let calls = 0;
  const m = new XCharacterMemory({ mode: 'shadow', observe: e => events.push(e), rpc: async (name, body) => {
    calls++; assert.equal(name, 'memory_recall_v1'); assert.equal(body.p_actor_native_id, '123'); return recall('r', 'shadow');
  } });
  assert.equal(await m.context(log), undefined);
  assert.equal(calls, 1); assert.equal(events[0].candidates, 1);
});
test('shadow outage is observable while live outage prevents old-context fallback', async () => {
  const rpc = async () => { throw Error('offline'); };
  assert.equal(await new XCharacterMemory({ mode: 'shadow', rpc }).context(log), undefined);
  await assert.rejects(new XCharacterMemory({ mode: 'live', rpc }).context(log), /offline/);
});
test('reply and quote have independent delivery records from one unchanged snapshot', async () => {
  let n = 0; const requests = [];
  const m = new XCharacterMemory({ mode: 'live', rpc: async (name, body) => {
    requests.push({ name, body }); return name === 'memory_recall_v1' ? recall('run' + ++n) : true;
  } });
  const context = await m.context(log);
  const item = { replyAction: 'reply', quoteAction: 'quote', replyText: '応援します', quoteText: '発表会だそうです', replyUsedMemoryIds: ['memory'], quoteUsedMemoryIds: [] };
  item.characterMemory = m.bind(context, item);
  await m.validate(item, 'reply'); await m.delivered(item, 'reply', { tweetId: 'sent1' });
  await m.validate(item, 'quote');
  assert.notEqual(item.characterMemory.reply.run_id, item.characterMemory.quote.run_id);
  assert.equal(requests.filter(r => r.name === 'memory_validate_recall_v1').length, 2);
});
test('unreported or forged memory IDs cannot be bound to a proposal', () => {
  const m = new XCharacterMemory({ mode: 'live', rpc: async () => null });
  const context = { mode: 'live', reply: recall('r'), quote: recall('q') };
  assert.throws(() => m.bind(context, { replyAction: 'reply' }), /invalid_character_memory_evidence/);
  assert.throws(() => m.bind(context, { replyAction: 'reply', replyUsedMemoryIds: ['invented'] }), /invalid_character_memory_evidence/);
});
test('identity, source, or policy invalidation prevents a pending action before the send', async () => {
  let sent = 0;
  const m = new XCharacterMemory({ mode: 'live', rpc: async () => false });
  const item = { replyText: '古い返答', characterMemory: { mode: 'live', reply: { run_id: 'r', used: ['memory'] } } };
  await assert.rejects(async () => { await m.validate(item, 'reply'); sent++; }, /regenerate/);
  assert.equal(sent, 0);
  await assert.rejects(m.validate({ replyText: '旧候補' }, 'reply'), /predates/);
});
test('turning the feature off cannot bypass invalidation for a previously live draft', async () => {
  const m = new XCharacterMemory({ mode: 'off', rpc: async () => false });
  await assert.rejects(m.validate({ replyText: 'old', characterMemory: { mode: 'live', reply: { run_id: 'r', used: [] } } }, 'reply'), /regenerate/);
});
test('audit failure after a successful post cannot cause an X retry', async () => {
  const observed = [];
  const m = new XCharacterMemory({ mode: 'live', observe: e => observed.push(e), rpc: async () => { throw Error('DB unavailable'); } });
  await m.delivered({ characterMemory: { reply: { run_id: 'r' } } }, 'reply', { tweetId: 'real' });
  assert.equal(observed[0].status, 'delivery_audit_unknown');
});
test('memory transport is restricted to Supabase RPCs with a timeout', async () => {
  const rpc = memoryRpc({ url: 'https://fixture.invalid', key: 'fixture', fetcher: async (url, opts) => {
    assert.equal(url, 'https://fixture.invalid/rest/v1/rpc/memory_recall_v1');
    assert.ok(opts.signal); return { ok: true, status: 200, json: async () => recall('r') };
  } });
  await rpc('memory_recall_v1', {});
  await assert.rejects(rpc('post_tweet', {}), /unavailable/);
});

test('the approval command keeps a stale pending proposal open and performs no X or state mutation', async () => {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('../scripts/nikechan-x.mjs', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('async function commandMentionApprove('), source.indexOf('async function commandMentionCancel('));
  let mutations = 0;
  const context = { command: null, options: { ids: 'm1' },
    readMentionPending: async () => ({ items: [{ id: 'm1', replyAction: 'reply', replyText: 'old' }] }),
    statePath: x => x, normalizeReactionItemId: x => x, mentionExecutedItemIds: () => new Set(),
    xMemory: { validate: async () => { throw Error('stale'); } },
    executeMentionReactions: async () => { mutations++; }, writeJsonAtomic: async () => { mutations++; },
  };
  const pending = runInNewContext(fn + '\ncommandMentionApprove(options)', context);
  await assert.rejects(pending, /stale/); assert.equal(mutations, 0);
});

test('each network action is revalidated when a reply is followed by a quote', async () => {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('../scripts/nikechan-x.mjs', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('async function executeMentionReactions('), source.indexOf('async function executeHashtagReactions('));
  let validations = 0; const actions = [];
  const result = await runInNewContext(fn + '\nexecuteMentionReactions(items, {})', {
    items: [{ id: 'm1', postId: '123', replyAction: 'reply', replyText: 'ok', quoteAction: 'quote', quoteText: 'now stale' }],
    xMemory: { validate: async () => { if (++validations === 2) throw Error('changed'); }, delivered: async () => {} },
    postTweet: async item => { actions.push(item.action); return { url: 'fixture', tweetId: '456' }; },
    shouldPersistReactionWorkflow: () => false, releaseMode: () => 'fixture',
  });
  assert.deepEqual(actions, ['reply']); assert.equal(result.results[0].error, 'changed'); assert.equal(result.results[0].action, 'reply');
});

test('embedding outages preserve scoped lexical recall without exposing shadow evidence', async () => {
  const m = new XCharacterMemory({ mode: 'shadow', embed: async () => { throw Error('embedding unavailable'); }, rpc: async (name, body) => {
    assert.equal(name, 'memory_recall_v2'); assert.equal(body.p_query_embedding, null); return recall('r', 'shadow');
  } });
  assert.equal(await m.context(log), undefined);
});

test('query vectors are generated once and reused for independent reply/quote records', async () => {
  let embedded = 0, n = 0;
  const m = new XCharacterMemory({ mode: 'live', embed: async () => { embedded++; return Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0); }, rpc: async (name, body) => {
    assert.equal(name, 'memory_recall_v2'); assert.equal(JSON.parse(body.p_query_embedding).length, 768); return recall('r' + ++n);
  } });
  await m.context(log); assert.equal(embedded, 1); assert.equal(n, 2);
});
