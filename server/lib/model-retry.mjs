/* 临时模型故障可在原阶段期限内补试一次；调用额度由上层同步预留。 */
import {setTimeout as sleep} from 'node:timers/promises';
export function retryAfterMs(value,now=Date.now()){
 if(typeof value!=='string'||!value.trim())return null;
 const text=value.trim();if(/^[-+]/.test(text))return null;if(/^\d+(?:\.\d+)?$/.test(text)){const ms=Number(text)*1000;return Number.isFinite(ms)?Math.ceil(ms):null;}
 const date=Date.parse(text);return Number.isFinite(date)?Math.max(0,date-now):null;
}
export function classifyModelFailure({status=null,error,signal,retryAfter=null,now=Date.now()}={}){
 if(signal?.aborted)return {reason_code:signal.reason?.name==='TimeoutError'?'deadline':'cancelled',retryable:false,http_status:status,retry_after_ms:null};
 const serverError=Number.isInteger(status)&&status>=500&&status<=599,temporary=[408,425,429].includes(status)||serverError&&![501,505,511].includes(status);
 const reason=status===429?'rate_limited':status===408?'request_timeout':serverError&&temporary?'service_unavailable':temporary?'temporary_request':status>=400?'http_rejected':error?.name==='SyntaxError'?'invalid_response':error?.name==='TimeoutError'?'timeout':'network_or_timeout';
 return {reason_code:reason,retryable:temporary||(status==null||status<400)&&error?.name!=='SyntaxError',http_status:status,retry_after_ms:retryAfterMs(retryAfter,now)};
}
export async function runModelAttempts({execute,timeoutMs=12000,signal,reserveRetry,canRetry,onRetry,onRetryWait},{clock=Date.now,random=Math.random,wait=(ms,signal)=>sleep(ms,undefined,{signal})}={}){
 const deadline=clock()+timeoutMs;let metadata={},last=null;
 for(let attempt=1;attempt<=2;attempt++){
  if(signal?.aborted)return {value:null,failure:{reason_code:'cancelled',retryable:false,retry_handled:true}};
  const remaining=deadline-clock();if(remaining<=0)return {value:null,failure:{...(last || {reason_code:'timeout',retryable:true}),retry_handled:true,retry_skipped:'deadline'}};
  const result=await execute({attempt,timeoutMs:Math.max(1,Math.ceil(remaining)),metadata});
  if(signal?.aborted)return {value:null,failure:{reason_code:signal.reason?.name==='TimeoutError'?'deadline':'cancelled',retryable:false,retry_handled:true}};
  if(result.value!==null)return result;
  const failure=result.failure;if(result.decoded_failure || !failure?.retryable)return attempt>1&&failure?{...result,failure:{...failure,retry_handled:true}}:result;
  last=failure;
  if(attempt===2)return {...result,failure:{...failure,retry_handled:true,retry_exhausted:true}};
  if(canRetry&&!canRetry())return {...result,failure:{...failure,retry_handled:true,retry_skipped:'call_budget'}};
  const delay=Math.max(failure.retry_after_ms || 0,Math.ceil(200*(.5+random())));
  if(deadline-clock()<=delay+250)return {...result,failure:{...failure,retry_handled:true,retry_skipped:'deadline'}};
  try{onRetryWait?.({...failure,retry_delay_ms:delay,next_attempt:attempt+1});}catch{}
  try{await wait(delay,signal);}catch{return {value:null,failure:{reason_code:'cancelled',retryable:false,retry_handled:true}};}
  if(signal?.aborted)return {value:null,failure:{reason_code:'cancelled',retryable:false,retry_handled:true}};
  if(deadline-clock()<=250)return {...result,failure:{...failure,retry_handled:true,retry_skipped:'deadline'}};
  const reserved=reserveRetry?reserveRetry(failure):true;
  if(!reserved)return {...result,failure:{...failure,retry_handled:true,retry_skipped:'call_budget'}};
  metadata=typeof reserved==='object'?reserved:{};
  try{onRetry?.({...failure,retry_delay_ms:delay,next_attempt:attempt+1});}catch{}
 }
}
