import { memoryTimePrompt } from './lib-memory-time.mjs';
import { createHash, randomUUID } from 'node:crypto';
const snapshotKey = value => JSON.stringify([value.snapshot?.epoch,value.snapshot?.policy_hash,value.snapshot?.mode]);
const episodeId = id => /^(x|discord):/u.test(id);

export class XCharacterMemory {
 constructor({mode='off',rpc,observe=()=>{},embed,resolveTime}) {
  if(!['off','shadow','live'].includes(mode))throw Error('invalid_character_memory_mode');
  Object.assign(this,{mode,rpc,observe,embed,resolveTime});
 }
 async context(log) {
  if(this.mode==='off')return undefined;
  try {
   if(!/^[0-9]+$/u.test(String(log.user_id)))throw Error('unresolved_native_author');
   const time=this.resolveTime?await this.resolveTime(String(log.body??'')):{state:'none'};
   const temporal=time.state==='resolved', unresolved=['ambiguous','unavailable'].includes(time.state);
   let vector=null;if(this.embed&&!unresolved)try{vector=JSON.stringify(await this.embed(String(log.body??'')));}catch{}
   const run=async()=>{
    const base={p_runtime:'x-public',p_destination:'twitter:public',p_actor_platform:'twitter',p_actor_native_id:String(log.user_id),
     p_query:String(log.body??''),p_turn_key:randomUUID(),p_attempt:1,...(time.state!=='none'?{p_time:time}:{})};
    const items=await this.rpc(unresolved?'memory_recall_unresolved_temporal_v1':temporal?'memory_recall_temporal_v1':this.embed?'memory_recall_v2':'memory_recall_v1',{...base,...(!unresolved&&this.embed?{p_query_embedding:vector}:{})});
    const episodes=unresolved?await this.rpc('memory_recall_unresolved_temporal_v1',{...base,p_attempt:2}):await this.rpc(temporal?'memory_recall_episodes_temporal_v1':'memory_recall_episodes_v1',{...base,p_attempt:2,p_query_embedding:vector,
     p_root_source_key:log.conversation_id?`twitter:post:${log.conversation_id}`:log.original_tweet_id?`twitter:post:${log.original_tweet_id}`:null});
    if(temporal&&[items,episodes].some(result=>!result.time_window||result.time_window.basis!==time.basis||result.time_window.mode!==time.mode||Date.parse(result.time_window.from)!==Date.parse(time.from)||Date.parse(result.time_window.to)!==Date.parse(time.to)||result.time_window.timezone!==time.timezone||result.time_window.eventFrom!==time.eventFrom||result.time_window.eventTo!==time.eventTo))throw Error('temporal_window_mismatch');
    if(unresolved&&[items,episodes].some(result=>result.time_window?.state!==time.state||result.candidates?.length!==0))throw Error('temporal_window_mismatch');
    if(!items?.run_id||!episodes?.run_id||!Array.isArray(items.candidates)||!Array.isArray(episodes.candidates)
     ||items.snapshot?.mode!==this.mode||snapshotKey(items)!==snapshotKey(episodes))throw Error('character_memory_mode_or_epoch_mismatch');
    return {...items,...(time.state!=='none'?{time_query:time,time_context:memoryTimePrompt(time)}:{}),episode_run_id:episodes.run_id,episode_keys:episodes.candidates.map(e=>e.episode_key),
     candidates:[...items.candidates,...episodes.candidates.map(e=>({...e,item_id:e.episode_key,candidate_type:'episode'}))]};
   };
   const reply=await run(),quote=await run();
   if(snapshotKey(reply)!==snapshotKey(quote))throw Error('character_memory_changed_during_context');
   this.observe({mode:this.mode,candidates:reply.candidates.length,episodes:reply.episode_keys.length,status:reply.status});
   if(this.mode==='shadow')return undefined;
   return {mode:'live',reply,quote};
  } catch(error){if(this.mode==='live')throw error;this.observe({mode:'shadow',status:'unavailable',
   reason:/^[a-z_]+$/u.test(error.message??'')?error.message:'recall_unavailable'});return undefined;}
 }
 bind(memory,item) {
  if(!memory){if(this.mode==='live'&&(item.replyAction==='reply'||item.quoteAction==='quote'))throw Error('character_memory_context_missing');return undefined;}
  if(memory.mode!=='live')throw Error('invalid_character_memory_binding');
  const bound={mode:'live'};
  for(const action of ['reply','quote']){
   if(item[`${action}Action`]!==action)continue;
   const recall=memory[action],used=item[`${action}UsedMemoryIds`];
   if(!Array.isArray(used)||used.some(id=>typeof id!=='string'||!recall.candidates.some(c=>c.item_id===id)))throw Error('invalid_character_memory_evidence');
   bound[action]={run_id:recall.run_id,episode_run_id:recall.episode_run_id,
    used:[...new Set(used.filter(id=>!episodeId(id)))],used_episode_keys:[...new Set(used.filter(episodeId))]};
  }
  return bound;
 }
 async validate(item,action){
  const bound=item.characterMemory;
  if(!bound){if(this.mode==='live')throw Error('pending_predates_character_memory; regenerate the proposal');return;}
  const record=bound[action];
  if(bound.mode!=='live'||!record?.episode_run_id)throw Error('invalid_character_memory_binding; regenerate the proposal');
  const hash=createHash('sha256').update(item[`${action}Text`]).digest('hex');
  const items=await this.rpc('memory_validate_recall_v1',{p_run_id:record.run_id,p_used_items:record.used,p_reply_hash:hash});
  const episodes=await this.rpc('memory_validate_episode_recall_v1',{p_run_id:record.episode_run_id,p_used_episode_keys:record.used_episode_keys,p_reply_hash:hash});
  if(items!==true||episodes!==true)throw Error('character_memory_changed; regenerate the proposal');
 }
 async delivered(item,action,posted){
  const record=item.characterMemory?.[action];if(!record||posted.dryRun)return;
  for(const run_id of [record.run_id,record.episode_run_id].filter(Boolean))try{
   await this.rpc('memory_delivery_v1',{p_run_id:run_id,p_state:'sent',p_message_id:posted.tweetId});
  }catch{this.observe({mode:'live',status:'delivery_audit_unknown'});}
 }
}
