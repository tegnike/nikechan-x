#!/usr/bin/env node
import {loadEnv,SupabaseClient} from './lib-memory-search.mjs';
const e={...await loadEnv(process.env.MEMORY_ENV_FILE||'.env'),...process.env};
const c=new SupabaseClient({url:e.SUPABASE_URL,key:e.SUPABASE_SERVICE_ROLE_KEY});
const settings=await c.fetchAll('memory_sync_state',{select:'cursor',limit:1,filters:['source_key=eq.character-memory%3Ax-settings']});
const [policy,batches,sources]=await Promise.all([
 c.fetchAll('memory_sync_state',{select:'cursor,updated_at',limit:1,filters:['source_key=eq.character-memory%3Apolicy']}),
 c.fetchAll('memory_x_batches',{select:'status,embedding_status,last_error_code,updated_at',limit:20000}),
 c.rpc('memory_x_source_snapshot_v1',{p_since:e.X_MEMORY_CUTOVER||settings[0]?.cursor?.cutover||'2026-09-06T00:00:00Z',p_limit:20000})]);
const tally=(rows,key)=>rows.reduce((out,row)=>{const k=row[key]??'none';out[k]=(out[k]||0)+1;return out;},{});
console.log(JSON.stringify({settings:settings[0]?.cursor,recall_runtime_mode:e.NIKECHAN_X_CHARACTER_MEMORY_MODE||'off',
 recall_policy_mode:policy[0]?.cursor?.policy?.runtimes?.['x-public']?.mode,
 allowed_scope_count:policy[0]?.cursor?.policy?.runtimes?.['x-public']?.destinations?.['twitter:public']?.length??0,
 policy_updated_at:policy[0]?.updated_at,sources:sources.length,batches:tally(batches,'status'),embeddings:tally(batches.filter(b=>b.status==='ready'),'embedding_status'),
 errors:tally(batches.filter(b=>b.status==='failed'&&b.last_error_code),'last_error_code'),unreserved_sources:sources.filter(r=>!r.reserved).length,
 latest_batch_update:batches.map(b=>b.updated_at).sort().at(-1)??null}));
