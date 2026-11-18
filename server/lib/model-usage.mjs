import {AsyncLocalStorage} from 'node:async_hooks';
import {currentModelSettings} from './model-settings.mjs';
/* 缓存用量只做观测；未知不是零，不把诊断字段写进提示。 */
import {createHash,randomUUID} from 'node:crypto';
const usageContext=new AsyncLocalStorage();
export const withModelUsageContext=(context,execute)=>usageContext.run(Object.freeze({...context}),execute);
const count=v=>Number.isSafeInteger(v)&&v>=0;
const get=(o,path)=>path.split('.').reduce((v,k)=>v?.[k],o);
export function normalizeModelUsage(usage){
 const u=usage && typeof usage==='object'?usage:{},errors=[];
 function pick(paths){const present=paths.map(path=>({path,value:get(u,path)})).filter(x=>x.value!=null);if(present.some(x=>!count(x.value))){errors.push('invalid_count:'+paths[0]);return {value:null,source:null};}if(new Set(present.map(x=>x.value)).size>1){errors.push('conflicting_count:'+paths[0]);return {value:null,source:null};}return present.length?{value:present[0].value,source:present[0].path}:{value:null,source:null};}
 const input=pick(['prompt_tokens','input_tokens']),output=pick(['completion_tokens','output_tokens']),total=pick(['total_tokens']);
 const hit=pick(['prompt_cache_hit_tokens','prompt_tokens_details.cached_tokens','input_tokens_details.cached_tokens']),miss=pick(['prompt_cache_miss_tokens']);
 let h=hit.value,m=miss.value,hitSource=hit.source,missSource=miss.source;
 const cacheError=errors.some(e=>/prompt_cache|cached_tokens|prompt_tokens$/.test(e));
 if(input.value!=null && ((h!=null&&h>input.value)||(m!=null&&m>input.value)||(h!=null&&m!=null&&h+m!==input.value)))errors.push('inconsistent_cache_total');
 if(total.value!=null&&input.value!=null&&output.value!=null&&total.value!==input.value+output.value)errors.push('inconsistent_token_total');
 const invalid=cacheError||errors.some(e=>e==='inconsistent_cache_total'||e==='inconsistent_token_total');
 if(invalid){h=null;m=null;hitSource=null;missSource=null;}
 else if(input.value!=null){
  if(h!=null&&m==null){m=input.value-h;missSource='derived:input_minus_hit';}
  if(m!=null&&h==null){h=input.value-m;hitSource='derived:input_minus_miss';}
 }
 return {usage_available:!!usage,prompt_tokens:input.value,completion_tokens:output.value,total_tokens:total.value,input_tokens_source:input.source,output_tokens_source:output.source,
  cache_hit_tokens:h,cache_miss_tokens:m,cache_hit_source:hitSource,cache_miss_source:missSource,
  cache_status:invalid?'invalid':h==null||m==null?'unknown':[hitSource,missSource].some(s=>s?.startsWith('derived:'))?'derived':'reported',usage_errors:errors};
}
const text=v=>typeof v==='string'?v.slice(0,160):null;
export function createUsageObservation(opts,{provider,requestedModel,systemPrompt,layout,rulesVersion},emit){
 const inherited=usageContext.getStore() || {};
 const started=Date.now(),base={usage_schema_version:1,ts:new Date(started).toISOString(),call_id:randomUUID(),task_id:text(opts.telemetry?.task_id)||text(inherited.task_id),operation:text(opts.telemetry?.operation)||text(inherited.operation),run_id:text(opts.telemetry?.run_id),attempt:Number.isSafeInteger(opts.telemetry?.attempt)?opts.telemetry.attempt:null,
  physical_attempt:Number.isSafeInteger(opts.telemetry?.physical_attempt)?opts.telemetry.physical_attempt:1,kind:opts.kind || 'unspecified',instruction_phase:opts.instruction_phase || null,provider,requested_model:requestedModel,reasoning_effort:provider==='openai'?(opts.reasoningEffort ?? currentModelSettings().effort ?? process.env.OPENAI_REASONING_EFFORT ?? 'low'):null,agent_rules_version:rulesVersion,
  system_prompt_hash:typeof systemPrompt==='string'?createHash('sha256').update(systemPrompt).digest('hex'):null,input_layout_version:layout.input_layout_version,layout_reason:layout.layout_reason,payload_bytes:layout.payload_bytes};
 let done=false;
 return ({body=null,status='error',httpStatus=null,reason=null,providerErrorCode=null}={})=>{
  if(done)return;done=true;
  const returned=text(body?.model),row={...base,returned_model:returned,model:returned || requestedModel,elapsed_ms:Math.max(0,Date.now()-started),status,http_status:httpStatus,reason_code:reason,provider_error_code:providerErrorCode,...normalizeModelUsage(body?.usage)};
  try{emit(row);}catch{}try{opts.onUsage?.(row);}catch{}return row;
 };
}
export function estimateModelCost(row,rate){
 if(!rate || !['reported','derived'].includes(row.cache_status)||![row.cache_hit_tokens,row.cache_miss_tokens,row.completion_tokens].every(count)||!['hit','miss','output'].every(k=>Number.isFinite(rate[k])&&rate[k]>=0)||!rate.version||!rate.currency)return null;
 return {amount:(row.cache_hit_tokens*rate.hit+row.cache_miss_tokens*rate.miss+row.completion_tokens*rate.output)/1e6,currency:rate.currency,price_version:rate.version,basis:rate.basis || 'configured_rates'};
}
function aggregate(rows,rateFor){
 const known=rows.filter(r=>count(r.prompt_tokens)&&!r.usage_errors?.length),observable=known.filter(r=>['reported','derived'].includes(r.cache_status)&&count(r.cache_hit_tokens)&&count(r.cache_miss_tokens));
 const sum=(list,key)=>list.reduce((n,r)=>n+r[key],0),input=sum(known,'prompt_tokens'),observedInput=sum(observable,'prompt_tokens');
 const costs=rows.map(r=>estimateModelCost(r,rateFor?.(r))),knownCosts=costs.filter(Boolean),currencies=new Set(knownCosts.map(c=>c.currency));
 const durations=rows.map(r=>r.elapsed_ms).filter(v=>Number.isFinite(v)&&v>=0).sort((a,b)=>a-b),quantile=p=>durations.length?durations[Math.ceil(durations.length*p)-1]:null;
 return {calls:rows.length,successful_calls:rows.filter(r=>r.status==='success').length,unknown_input_calls:rows.length-known.length,input_tokens:known.length?input:null,output_tokens:rows.some(r=>count(r.completion_tokens))?sum(rows.filter(r=>count(r.completion_tokens)),'completion_tokens'):null,
  cache_observable_calls:observable.length,cache_observable_input_tokens:observable.length?observedInput:null,cache_hit_tokens:observable.length?sum(observable,'cache_hit_tokens'):null,cache_miss_tokens:observable.length?sum(observable,'cache_miss_tokens'):null,
  cache_hit_ratio:observedInput?sum(observable,'cache_hit_tokens')/observedInput:null,cache_input_coverage:known.length===rows.length&&input?observedInput/input:null,known_input_cache_coverage:input?observedInput/input:null,usage_call_coverage:rows.length?known.length/rows.length:null,invalid_usage_calls:rows.filter(r=>r.usage_errors?.length).length,p50_ms:quantile(.5),p95_ms:quantile(.95),
  cost_known_calls:knownCosts.length,estimated_model_cost:rows.length&&knownCosts.length===rows.length&&currencies.size===1?knownCosts.reduce((n,c)=>n+c.amount,0):null,
  observed_model_cost:knownCosts.length&&currencies.size===1?knownCosts.reduce((n,c)=>n+c.amount,0):null,currency:currencies.size===1?[...currencies][0]:null,price_versions:[...new Set(knownCosts.map(c=>c.price_version))]};
}
export function summarizeModelUsage(rows,{rateFor}={}){
 const groups=new Map();for(const row of rows){const key=JSON.stringify([row.provider,row.requested_model,row.returned_model,row.reasoning_effort,row.kind,row.instruction_phase,row.system_prompt_hash,row.input_layout_version]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
 return {overall:aggregate(rows,rateFor),groups:[...groups.values()].map(group=>({provider:group[0].provider,requested_model:group[0].requested_model,returned_model:group[0].returned_model,reasoning_effort:group[0].reasoning_effort || null,kind:group[0].kind,instruction_phase:group[0].instruction_phase,system_prompt_hash:group[0].system_prompt_hash,input_layout_version:group[0].input_layout_version,...aggregate(group,rateFor)})),tool_costs:{search:null,fetch:null,maps:null},cost_note:'模型估算不包含未提供的工具费用；未知用量不视为零成本。'};
}
