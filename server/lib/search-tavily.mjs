/* Tavily Search 显式适配：不消费生成答案／raw_content，不自动转其他付费服务。 */
import {searchAttempt} from './search-diagnostics.mjs';
import {publicUrl} from './public-reader.mjs';
const ENDPOINT='https://api.tavily.com/search';
const states=new Map();
const domain=value=>typeof value==='string' && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(value);
export function tavilyConfigured(){return !!process.env.TAVILY_API_KEY;}
export async function searchTavily(query,{limit=5,timeoutMs=12000,signal,onAttempt,domains=null,language=null}={}){
  const started=Date.now(),key=process.env.TAVILY_API_KEY;
  const emit=extra=>searchAttempt(onAttempt,{provider:'tavily',query,started,...extra});
  if(signal?.aborted){emit({status:'cancelled',reason_code:'cancelled'});return null;}
  if(!key){emit({status:'unconfigured',reason_code:'unconfigured'});return null;}
  const text=String(query).slice(0,100),sites=domains ?? [...text.matchAll(/(?:^|\s)site:([a-z0-9.-]+)/gi)].map(m=>m[1]);
  if(!Array.isArray(sites) || sites.length>8 || sites.some(s=>!domain(s)) || !text.trim() || !Number.isInteger(limit) || limit<1 || limit>10 || !Number.isInteger(timeoutMs) || timeoutMs<1){emit({status:'error',reason_code:'invalid_options'});return null;}
  const cooldown=states.get(key);if(cooldown?.until>Date.now()){emit({status:'skipped',reason_code:cooldown.reason});return null;}
  let httpStatus=null;
  try{
    const res=await fetch(ENDPOINT,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer '+key},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs),
      body:JSON.stringify({query:text,search_depth:'basic',topic:'general',max_results:limit,include_answer:false,include_raw_content:false,include_images:false,include_usage:true,include_published_date:true,filter_by_published_date:false,auto_parameters:false,
        ...(sites.length?{include_domains:[...new Set(sites)],include_domains_mode:'restrict'}:{}),...(['zh','en'].includes(language)?{language}:{})})});
    httpStatus=res.status;
    if(!res.ok){
      const status=res.status===401 || res.status===403?'unauthorized':res.status===429?'rate_limited':[432,433].includes(res.status)?'quota_exhausted':'error';
      if(['rate_limited','quota_exhausted','unauthorized'].includes(status)){states.set(key,{until:Date.now()+(status==='rate_limited'?60000:300000),reason:status});if(states.size>4)states.delete(states.keys().next().value);}
      emit({status,network_request:true,http_status:httpStatus,reason_code:'http_'+httpStatus});return null;
    }
    const body=await res.json();
    if(!Array.isArray(body.results))throw Error('检索返回格式无效');
    const seen=new Set(),results=[];
    for(const row of body.results){
      let url;try{url=publicUrl(row?.url).href;}catch{continue;}
      if(seen.has(url))continue;seen.add(url);
      // published_date 可能是更新时间的估计，不能成为近期运营资料的准入日期。
      results.push({title:String(row.title || '').slice(0,120),link:url,content:String(row.content || '').slice(0,300),media:'tavily',date:null,
        estimated_date:typeof row.published_date==='string'?row.published_date.slice(0,100):null,date_basis:'provider_estimate'});
      if(results.length>=limit)break;
    }
    if(signal?.aborted){emit({status:'cancelled',network_request:true,http_status:httpStatus,reason_code:'cancelled'});return null;}
    emit({status:results.length?'available':body.results.length?'filtered':'empty',network_request:true,http_status:httpStatus,reason_code:results.length?null:body.results.length?'no_public_urls':'no_results',usage:{api_credits:body.usage?.credits}});
    return body.results.length && !results.length?null:results;
  }catch(error){emit({status:signal?.aborted?'cancelled':['TimeoutError','AbortError'].includes(error?.name)?'timeout':'error',network_request:true,http_status:httpStatus,reason_code:signal?.aborted?'cancelled':'network_or_invalid_response'});return null;}
}
