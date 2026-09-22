import { xMemoryTransientCode } from './lib-x-memory-transient.mjs';
export function createPriorityRpcQueue({now=Date.now,maxWaitMs=30000}={}) {
 const pending=[];let running=false;
 function drain(){
  if(running||!pending.length)return;
  const at=now();pending.sort((a,b)=>(at-a.at>=maxWaitMs?0:a.priority)-(at-b.at>=maxWaitMs?0:b.priority)||a.sequence-b.sequence);
  const job=pending.shift();running=true;
  Promise.resolve().then(job.run).then(job.resolve,job.reject).finally(()=>{running=false;drain();});
 }
 let sequence=0;
 return (run,priority=2)=>new Promise((resolve,reject)=>{pending.push({run,priority,resolve,reject,at:now(),sequence:sequence++});drain();});
}
export function createXBulkRpc({request,allowed,alive,stopped,claimCutoff,log,sleep,now=Date.now,random=Math.random}) {
 const queue=createPriorityRpcQueue({now});let claimCooldownUntil=0,claimFailures=0;
 return async(name,body)=>{
  if(!allowed.has(name))throw Error('invalid_x_rpc');
  const claim=name==='memory_claim_x_batches_v1';
  const anyClaim=name.startsWith('memory_claim_');
  const priority=name.startsWith('memory_publish_')?0:name.startsWith('memory_fail_')?1:claim?2:3;
  for(let attempt=0;;attempt++){
   try{
    return await queue(async()=>{
     if(!alive())throw Error('bulk_deadline_reached');
     if(anyClaim&&stopped())return [];
     if(claim&&now()>=claimCutoff)return [];
     if(claim&&now()<claimCooldownUntil)return [];
     const value=await request(name,body);
     if(claim){claimFailures=0;claimCooldownUntil=0;}
     return value;
    },priority);
   }catch(error){
    const code=xMemoryTransientCode(error);
    if(!code||attempt>=4||!alive()||stopped())throw error;
    if(claim){
     claimFailures++;
     const cooldown=Math.round(Math.min(60000,5000*2**Math.min(claimFailures-1,4)*(0.8+0.4*random())));
     claimCooldownUntil=now()+cooldown;
     log('claim_cooling',{code,cooldown_ms:cooldown,failures:claimFailures});
     return [];
    }
    if(name==='memory_x_source_snapshot_page_v1')throw error;
    log('db_retry',{rpc:name,attempt:attempt+1,code});
    // Queue was released before this sleep; ready publications can proceed.
    await sleep(Math.round(Math.min(30000,1000*2**attempt)*(0.8+0.4*random())));
   }
  }
 };
}
