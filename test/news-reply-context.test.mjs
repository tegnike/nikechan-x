import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewsReplyResolver, extractArticleText, isPublicIPv4, fetchArticle } from '../scripts/news-reply-context.mjs';
import { normalizeMentionItems } from '../scripts/nikechan-x.mjs';
const news = { id: 'n1', url: 'https://example.com/news', title: 'Example', summary: 'summary' };
test('resolve exact posted ID even if parent has t.co, cache article per batch', async () => {
 let reads=0;
 const resolve=createNewsReplyResolver({get:async q=>q.includes('id=eq.n1')?[news]:[], executedItems:[{id:'n1',status:'posted',result:{tweetId:'42'}}], readArticle:async()=>{reads++;return {status:'fetched',text:'evidence'}}});
 assert.equal((await resolve({tweet_id:'42',content:'https://t.co/abc'})).newsId,'n1');
 await resolve({tweet_id:'42'}); assert.equal(reads,1);
 assert.equal(await resolve({tweet_id:'99',content:'no link'}),null);
});
test('old post resolves exact stored URL, failed fetch preserves explicit limitation', async()=>{
 const resolve=createNewsReplyResolver({get:async q=>q.includes(encodeURIComponent(news.url))?[news]:[],readArticle:async()=>{throw Error('403')}});
 const result=await resolve({tweet_id:'old',content:news.url});
 assert.equal(result.article.status,'unavailable');assert.equal(result.storedSummary,'summary');
 assert.equal(await resolve({tweet_id:'other',content:'https://other.example/news'}),null);
});
test('missing DB is isolated, no article fetch for unmatched posts', async()=>{
 let reads=0;
 const resolve=createNewsReplyResolver({get:async()=>{throw Error('DB')},readArticle:async()=>{reads++}});
 assert.equal((await resolve({tweet_id:'1',content:news.url})).status,'lookup_unavailable');
 assert.equal(reads,0);
});
test('public DNS only, redirects cannot target local services', async()=>{
 for (const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.1.1','192.168.1.1','100.64.0.1','::1']) assert.equal(isPublicIPv4(ip),false,ip);
 assert.equal(isPublicIPv4('8.8.8.8'),true);
 let requests=0;
 await assert.rejects(fetchArticle('https://example.com',{resolveHost:async()=>[{address:'127.0.0.1',family:4}],requestImpl:()=>{requests++}}),/non_public/);
 await assert.rejects(fetchArticle('http://example.com'),/unsafe/);
 assert.equal(requests,0);
});
test('extract body excludes script/navigation and decodes entities',()=>{
 assert.equal(extractArticleText('<nav>Menu</nav><main>Hello &amp; &#x65e5; <script>bad()</script>world</main>'),'Hello & 日 world');
});
test('only bound news candidates accept longer replies, cannot forge from input',()=>{
 const candidate={id:'m1',tweetLogId:'log',postId:'42',body:'質問',newsContext:{newsId:'n1',article:{status:'fetched',text:'source'}}};
 const input={id:'m1',replyAction:'reply',quoteAction:'skip',replyText:'あ'.repeat(350)};
 const accepted=normalizeMentionItems([input],[candidate])[0];
 assert.equal(accepted.replyAction,'reply'); assert.equal(accepted.replyText.length,350); assert.equal(accepted.newsContext.newsId,'n1');
 assert.equal(normalizeMentionItems([{...input,replyText:'あ'.repeat(1001)}],[candidate])[0].replyAction,'skip');
 const forged=normalizeMentionItems([{...input,newsContext:candidate.newsContext}],[{...candidate,newsContext:null}])[0]; assert.equal(forged.newsContext,undefined); assert.equal(forged.replyText.length,280);
});

test('long news reply survives propose and approval execution in isolated dry-run', async()=>{
 const { mkdtemp,writeFile,readFile,rm }=await import('node:fs/promises');
 const { spawnSync }=await import('node:child_process');
 const { join }=await import('node:path');
 const dir=await mkdtemp(join(import.meta.dirname,'../tmp/news-reply-test-'));
 try {
  const candidate={id:'m1',tweetLogId:'log',postId:'123',body:'このニュースの詳細は？',newsContext:{newsId:'n1',url:news.url,article:{status:'fetched',text:'evidence'}}};
  await writeFile(join(dir,'mention-context.json'),JSON.stringify({candidates:[candidate]}));
  const env={...process.env,NIKECHAN_X_STATE_DIR:dir,NIKECHAN_X_RELEASE_MODE:'dry-run',NIKECHAN_X_CHARACTER_MEMORY_MODE:'off',SUPABASE_URL:'',SUPABASE_SERVICE_ROLE_KEY:''};
  const replyText='説明です。'.repeat(80);
  const run=args=>spawnSync(process.execPath,['scripts/nikechan-x.mjs',...args],{cwd:join(import.meta.dirname,'..'),env,encoding:'utf8'});
  const proposed=run(['mention-propose','--items-json',JSON.stringify({items:[{id:'m1',replyAction:'reply',quoteAction:'skip',replyText}]})]);
  assert.equal(proposed.status,0,proposed.stderr);
  const pending=JSON.parse(await readFile(join(dir,'pending-mention-reaction.json')));
  assert.equal(pending.items[0].replyText,replyText);
  const approved=run(['mention-approve','--ids','m1']);
  assert.equal(approved.status,0,approved.stderr);
  const result=JSON.parse(await readFile(join(dir,'last-mention-reaction-result.json')));
  assert.equal(result.dryRun,true);
  assert.equal(result.results[0].action,'reply');
  assert.ok(result.results[0].replyUrl.endsWith(replyText));
 } finally { await rm(dir,{recursive:true,force:true}); }
});
