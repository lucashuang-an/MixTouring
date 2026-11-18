import {reserveUpstream} from './upstream-budget.mjs';
/* DeepSeek独立搜索API；火山模型key不在此复用。结果仍进入统一来源和证据核对。 */
import {searchAttempt} from './search-diagnostics.mjs';
export async function searchDeepSeek(query,{limit=5,timeoutMs=12000,signal,domains,domainMode='restrict',language,startDate,endDate,onAttempt,fetchImpl=fetch,key=process.env.DEEPSEEK_KEY || process.env.DEEPSEEK_API_KEY}={}){
  const started=Date.now(),emit=extra=>searchAttempt(onAttempt,{provider:'deepseek-search',query,started,...extra});
  if(signal?.aborted || !key){emit({status:signal?.aborted?'cancelled':'unconfigured',network_request:false,reason_code:signal?.aborted?'cancelled':'unconfigured'});return null;}
  const filters=[];
  if(language)filters.push('lang:'+language);
  if(startDate)filters.push('after:'+startDate);
  if(endDate)filters.push('before:'+endDate);
  const sites=domainMode==='restrict' && domains?.length?domains.filter(d=>/^[a-z0-9.-]+$/i.test(d)).slice(0,5):[];
  if(sites.length)filters.push(sites.map(d=>'site:'+d).join(' OR '));
  const suffix=filters.join(' '),remaining=128-[...suffix].length-(suffix?1:0);
  if(!String(query).trim() || remaining<1){emit({status:'error',reason_code:'invalid_query',network_request:false});return null;}
  const text=[...String(query).trim()].slice(0,remaining).join('')+(suffix?' '+suffix:'');
  let status=null;
  try{
    await reserveUpstream('search');
    const res=await fetchImpl('https://api.deepseek.com/v1/tools/search',{method:'POST',redirect:'manual',headers:{'content-type':'application/json',authorization:'Bearer '+key},
      body:JSON.stringify({query:text,count:Math.min(10,Math.max(1,limit)),need_content:false}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});
    status=res.status;if(!res.ok)throw Error('HTTP '+status);
    const body=await res.json();if(signal?.aborted)throw Error('cancelled');if(!Array.isArray(body.results))throw Error('invalid_response');
    const result=body.results.filter(r=>{try{const u=new URL(r.url);return u.protocol==='https:' && !u.username && !u.password && (!sites.length || sites.some(d=>u.hostname===d || u.hostname.endsWith('.'+d)));}catch{return false;}}).slice(0,limit)
      .map(r=>({title:String(r.title || '').slice(0,200),link:r.url,content:String(r.summary || r.snippet || '').slice(0,2000),date:r.date || null,date_basis:'search_index'}));
    emit({status:result.length?'available':'empty',network_request:true,http_status:status,usage:{successful_requests:body.results.length?1:0}});return result;
  }catch(error){emit({status:signal?.aborted?'cancelled':status===402?'quota_exhausted':status===401?'unauthorized':status===429?'rate_limited':error?.name==='TimeoutError'?'timeout':'error',network_request:true,http_status:status,reason_code:signal?.aborted?'cancelled':status?'http_error':'network_or_timeout'});return null;}
}
