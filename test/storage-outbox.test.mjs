import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { enqueue, flushOutbox, activityRow, prepareOutbox } from '../scripts/storage-outbox.mjs';
const root = resolve(import.meta.dirname, '..');
await mkdir(join(root, 'tmp'), {recursive: true});
async function fixture(fn) {
 const dir = await mkdtemp(join(root, 'tmp', 'outbox-test-'));
 try { await fn(dir); } finally { await rm(dir, {recursive:true, force:true}); }
}
test('failed DB insert survives restart and retries same primary key', () => fixture(async dir => {
 const id = await enqueue(dir,'tweets',{tweet_id:'provider-1',content:'test'});
 assert.deepEqual(await flushOutbox(dir, async()=>({status:'error'})),{saved:0,pending:1});
 let received;
 assert.deepEqual(await flushOutbox(dir,async(table,row)=>{received={table,row};return {status:'inserted'};}),{saved:1,pending:0});
 assert.equal(received.row.id,id);assert.equal(received.row.tweet_id,'provider-1');
}));
test('uncertain DB success retries identically without duplicating row', () => fixture(async dir=>{
 await enqueue(dir,'tweets',{tweet_id:'provider-2',content:'test'});
 const rows = new Map();let first=true;
 const insert = async(t,row)=>{rows.set(row.id,row); if(first){first=false;throw Error('lost response');} return {status:'inserted'};};
 assert.equal((await flushOutbox(dir,insert)).pending,1);
 assert.equal((await flushOutbox(dir,insert)).pending,0);assert.equal(rows.size,1);
}));
test('activity status uses existing parsed JSON and preserves original keys',()=>{
 const row=activityRow('execute',{result:{tweetId:'123'}},'self-tweet','success');
 assert.equal(Object.hasOwn(row,'status'),false);assert.equal(row.parsed.activity_status,'success');assert.equal(row.parsed.result.tweetId,'123');
});
test('partial drain retains remaining entries and stops on DB failure',()=>fixture(async dir=>{
 await enqueue(dir,'tweets',{content:'a'});await enqueue(dir,'tweets',{content:'b'});let calls=0;
 const result=await flushOutbox(dir,async()=>({status:++calls===1?'inserted':'error'}));assert.deepEqual(result,{saved:1,pending:1});
}));
test('preflight rejects unusable local storage before provider call',()=>fixture(async dir=>{
 const p=join(dir,'file');await writeFile(p,'x');await assert.rejects(prepareOutbox(p));
}));
test('CLI post mock then DB-only recovery never replays X',()=>fixture(async dir=>{
 const preload=join(dir,'offline.mjs');const calls=join(dir,'calls.jsonl');
 await writeFile(preload, `import { appendFileSync } from 'node:fs';
 globalThis.fetch=async(url,options={})=>{
  const u=new URL(url);appendFileSync(process.env.TEST_CALLS,JSON.stringify({host:u.hostname,path:u.pathname,query:u.search,body:options.body})+'\\n');
  if(u.hostname==='api.twitter.com' && u.pathname==='/2/tweets' && process.env.TEST_PHASE==='post') return new Response(JSON.stringify({data:{id:'fake-provider-123'}}),{status:201});
  if(u.hostname==='db.invalid') {
   if(process.env.TEST_PHASE==='post') return new Response('DB unavailable',{status:503});
   if(u.pathname==='/rest/v1/tweets'||u.pathname==='/rest/v1/twitter_activity_logs'){
    if(u.searchParams.get('on_conflict')!=='id'||!options.headers.Prefer.includes('ignore-duplicates')) throw Error('missing idempotency');
    if(Object.hasOwn(JSON.parse(options.body),'status')) throw Error('invalid status column');
    return new Response(null,{status:201});
   }
  }
  throw Error('Unexpected network request');
 };`);
 const env={...process.env,NIKECHAN_X_STATE_DIR:join(dir,'state'),SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'test',NIKECHAN_X_RELEASE_MODE:'live',NIKECHAN_X_LIVE_ARMED:'yes',X_CONSUMER_KEY:'test',X_CONSUMER_SECRET:'test',X_ACCESS_TOKEN:'test',X_ACCESS_TOKEN_SECRET:'test',TEST_CALLS:calls};
 const run=(args,phase)=>spawnSync(process.execPath,['--import',preload,join(root,'scripts/nikechan-x.mjs'),...args],{env:{...env,TEST_PHASE:phase},encoding:'utf8'});
 const post=run(['post','--action','tweet','--text','通常のテスト文章です。','--json'],'post');
 assert.equal(post.status,0,post.stderr);assert.match(post.stdout,/fake-provider-123/);
 const queued=await readdir(join(dir,'state','storage-outbox'));assert.equal(queued.filter(n=>n.endsWith('.json')).length,2);
 const replay=run(['retry-storage'],'retry');assert.equal(replay.status,0,replay.stderr);assert.equal(JSON.parse(replay.stdout).pending,0);
 const records=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(records.filter(r=>r.host==='api.twitter.com').length,1);
 assert.equal((await readdir(join(dir,'state','storage-outbox'))).length,0);
}));
