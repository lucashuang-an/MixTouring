/* 仅记录明确白名单的逐请求诊断；不接收凭据、请求头、原始错误对象或网页正文。 */
import {randomUUID} from 'node:crypto';
export const unknownCost=()=>({amount:null,currency:null,basis:'not_reported'});
export function searchAttempt(callback,{provider,model=null,query,status,started,network_request=false,http_status=null,reason_code=null,usage=null}){
  if(typeof callback!=='function')return;
  const safe=v=>Number.isFinite(v) && v>=0?v:null;
  const event={attempt_id:randomUUID(),provider,model,query:String(query).slice(0,100),status,network_request:!!network_request,
    elapsed_ms:Math.max(0,Date.now()-started),http_status:safe(http_status),reason_code:typeof reason_code==='string' && /^[A-Za-z0-9_.-]{1,80}$/.test(reason_code)?reason_code:null,
    usage:usage?Object.fromEntries(['input_tokens','output_tokens','total_tokens','web_search_calls','api_credits'].map(k=>[k,safe(usage[k])])):null,cost:unknownCost()};
  try{callback(event);}catch{/* 诊断失败不改变业务检索结果。 */}
}
export async function detailedSearch(search,query,{run_id=null,onAttempt,...options}={}){
  const started=Date.now(),attempts=[],request_id=randomUUID();
  const run=typeof run_id==='string' && /^[\w-]{1,120}$/.test(run_id)?run_id:null;
  const observe=event=>{const associated={...event,request_id,run_id:run};attempts.push(associated);if(typeof onAttempt==='function')try{onAttempt(associated);}catch{}};
  let results=null;
  try{results=await search(query,{...options,onAttempt:observe});}
  catch{searchAttempt(observe,{provider:'unknown',query,started,status:options.signal?.aborted?'cancelled':'error',reason_code:'unexpected_failure'});}
  const last=attempts.at(-1);
  return {request_id,run_id:run,query:String(query).slice(0,100),
    status:Array.isArray(results)?results.length?'available':'empty':last?.status==='skipped'?'unavailable':last?.status || 'unavailable',provider:last?.provider || null,results,
    elapsed_ms:Math.max(0,Date.now()-started),attempts,network_requests:attempts.filter(a=>a.network_request).length,cost:unknownCost()};
}
