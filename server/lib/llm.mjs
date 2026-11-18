import {reserveUpstream} from './upstream-budget.mjs';
import {classifyModelFailure,runModelAttempts} from './model-retry.mjs';
import {prepareInputLayout} from './input-layout.mjs';
import {createUsageObservation} from './model-usage.mjs';
import {agentPrompt,AGENT_RULES_VERSION} from './agent-prompts.mjs';
/* lib/llm.mjs · 旅行Agent模型与检索适配层（统一出口）
 * 开发约定见DEVELOPMENT.md；运行提示词从AGENTS.md读取。LLM key只存服务端，浏览器不直连。
 * 本模块用环境变量注入 key，统一所有 LLM 调用的入口；
 * 未配置 key 或调用失败返回 null，由Agent保留输入并提示重试，不以规则方案冒充模型成功。
 * 用量记录：每次真模型调用把 token 消耗追加到 server/logs/llm-usage.jsonl（kind 区分任务），
 * 为后续算法优化（prompt 瘦身/缓存/模型选型）提供逐任务数据。 */

import {appendBoundedJsonl} from './bounded-log.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { searchVolc,volcSearchModel } from './search-volc.mjs';
import {searchTavily} from './search-tavily.mjs';
import {searchDeepSeek} from './search-deepseek.mjs';
import {searchAttempt,detailedSearch} from './search-diagnostics.mjs';
import {ProxyAgent} from 'undici';
import {currentModelSettings,reasoningEffort,modelStageTimeout} from './model-settings.mjs';

const VOLC_CHAT = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

const DEFAULT_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

const KEY = process.env.LLM_API_KEY || '';
const BASE = (process.env.LLM_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
const MODEL = process.env.LLM_MODEL || DEFAULT_MODEL;
const LOG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'llm-usage-v2.jsonl');

/** 旧兼容通道是否配置；主模型就绪状态使用composeConfigured。 */
export function llmConfigured() {
  return !!KEY;
}
const deepseekKey=()=>process.env.DEEPSEEK_KEY || process.env.DEEPSEEK_API_KEY || '';
const openaiKey=()=>process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '';
const openaiSelected=()=>process.env.MT_COMPOSE_PROVIDER==='openai' || !process.env.MT_COMPOSE_PROVIDER && !!openaiKey();
let openaiProxy=null,openaiProxyUrl=null;
function openaiDispatcher(){
  const url=process.env.OPENAI_PROXY_URL;
  if(!url)return undefined;
  if(url!==openaiProxyUrl){openaiProxy?.close().catch(()=>{});openaiProxy=new ProxyAgent(url);openaiProxyUrl=url;}
  return openaiProxy;
}
export function composeModelInfo(){return openaiSelected()?{provider:'openai',model:process.env.OPENAI_MODEL || 'gpt-6.1-sol'}:deepseekKey()?{provider:'deepseek',model:process.env.DEEPSEEK_MODEL || 'deepseek-flash'}:process.env.VOLC_SEARCH_API_KEY?{provider:'volc',model:process.env.VOLC_COMPOSE_MODEL || process.env.VOLC_SEARCH_MODEL || 'deepseek-v4-flash-ga-260731'}:{provider:'compatible',model:MODEL};}
export function composeConfigured(){return openaiSelected()?!!openaiKey():!!deepseekKey() || !!process.env.VOLC_SEARCH_API_KEY || !!KEY;}

// 兼容旧对象/null返回值，同时通过回调保留可用于重试决策的失败原因。
export function decodeModelJson(body,opts={}){
  const finish=body.choices?.[0]?.finish_reason,raw=body.choices?.[0]?.message?.content;
  const fail=(reason_code,retryable=false)=>{try{opts.onFailure?.({reason_code,retryable,finish_reason:finish || null});}catch{}return null;};
  if(finish==='content_filter')return fail('content_filter');
  if(finish==='length')return fail('output_truncated');
  if(typeof raw!=='string' || !raw.trim())return fail('empty_response',true);
  const match=raw.match(/\{[\s\S]*\}/);
  if(!match)return fail('invalid_json');
  try{return JSON.parse(match[0]);}catch{return fail('invalid_json');}
}

/** 当前生效的模型标识（未配置时返回 'rule'） */
export function llmModel() {
  return composeConfigured() ? composeModelInfo().model : 'rule';
}

/* 逐任务用量落盘（JSONL，一行一次调用）；写失败只打日志，不影响主流程 */
function logUsage(row) { appendBoundedJsonl(process.env.MT_LLM_USAGE_LOG || LOG_PATH,row); }
function modelRequest(opts,provider,requestedModel){
  const systemPrompt=opts.schema_prompt || agentPrompt('format.json'),layout=prepareInputLayout(opts);
  return {messages:[{role:'system',content:systemPrompt},{role:'user',content:layout.user}],finish:createUsageObservation(opts,{provider,requestedModel,systemPrompt,layout,rulesVersion:AGENT_RULES_VERSION},logUsage)};
}

/* ---------- 专用联网搜索（智谱 web_search API，独立于 chat） ----------
 * 采集执行器的可靠检索通道：不等模型「自觉触发」工具，按查询词直接拿公开搜索结果。
 * v0.31.0 评审 P1-4：记录最近一次真实调用结果（available/quota_exhausted/timeout/error），
 * capabilities 据此如实报告——配置成功不等于可用（智谱 429 余额不足期间 configured=true 但不可用）。
 * @returns {Promise<Array|null>} [{ title, link, content, media, date }]；失败 null */
let SEARCH_STATE = { status: 'unknown', at: null };
let SEARCH_QUOTA_UNTIL = 0;
let PUBLIC_SEARCH_RETRY_AT = 0;
let VOLC_SEARCH_RETRY_AT = 0;
function markSearch(status, provider = null) { SEARCH_STATE = { status, provider, at: new Date().toISOString() }; }

function searchText(value) {
  return String(value || '').replace(/<[^>]+>/g, '').replace(/&(?:amp|nbsp|lt|gt|quot|apos|#39|#x27);/g, (entity) => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&#x27;': "'"
    })[entity] || (entity === '&nbsp;' ? ' ' : entity)).replace(/\s+/g, ' ').trim();
}

async function searchPublicIndex(query, limit, timeoutMs, signal,observe) {
  const started=Date.now(),emit=extra=>searchAttempt(observe,{provider:'public-search',query,started,...extra});
  if(signal?.aborted){emit({status:'cancelled',reason_code:'cancelled'});return null;}
  if (Date.now() < PUBLIC_SEARCH_RETRY_AT){emit({status:'skipped',reason_code:'cooldown'});return null;}
  try {
    const url = 'https://www.so.com/s?' + new URLSearchParams({ q: String(query).slice(0, 100) });
    const timeout = AbortSignal.timeout(Math.min(timeoutMs, 8000));
    const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || '')){emit({status:'error',network_request:true,http_status:res.status,reason_code:'http_or_content_type'});return null;}
    const html = (await res.text()).slice(0, 600000);
    if (html.includes('<title>访问异常页面</title>')) {
      PUBLIC_SEARCH_RETRY_AT = Date.now() + 5 * 60 * 1000;
      emit({status:'blocked',network_request:true,http_status:res.status,reason_code:'verification_page'});
      return null;
    }
    const blocks = html.split(/<li\s+class=["']res-list["']/i).slice(1, 16);
    const results = blocks.map((block) => {
      const head = block.match(/<h3\s+class=["']res-title["'][^>]*>([\s\S]*?)<\/h3>/i)?.[1] || '';
      const directUrl = head.match(/data-mdurl=["']([^"']+)["']/i)?.[1] || '';
      const summary = block.match(/<span\s+class=["']res-list-summary["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || '';
      return {
        title: searchText(head).slice(0, 120), link: searchText(directUrl),
        content: searchText(summary).slice(0, 300), media: 'public-search', date: null
      };
    }).filter((r) => /^https:\/\//i.test(r.link) && r.title);
    const seen = new Set();
    const unique = results.filter((r) => !seen.has(r.link) && seen.add(r.link)).slice(0, limit);
    if (!unique.length) PUBLIC_SEARCH_RETRY_AT = Date.now() + 5 * 60 * 1000;
    emit({status:unique.length?'available':'empty',network_request:true,http_status:res.status,reason_code:unique.length?null:'no_index_results'});
    return unique.length ? unique : null;
  } catch (err) {
    emit({status:signal?.aborted?'cancelled':err?.name==='TimeoutError' || err?.name==='AbortError'?'timeout':'error',network_request:true,reason_code:signal?.aborted?'cancelled':'network_or_timeout'});
    console.error('✗ 公开搜索备用通道失败：' + err.message);
    return null;
  }
}

/** 最近一次 searchWeb 真实调用的状态（浅拷贝，不泄露凭据）；从未调用过为 unknown */
export function webSearchStatus() { return { ...SEARCH_STATE }; }

export async function searchWeb(query, options = {}) {
  const { limit = 5, timeoutMs = 30000, signal,onAttempt,provider=process.env.TRAVEL_SEARCH_PROVIDER || 'current',domains=null,domainMode='restrict',language=null,startDate=null,endDate=null } = options;
  if(provider==='deepseek' || !Object.hasOwn(options,'provider') && language==='zh' && process.env.TRAVEL_CHINESE_SEARCH_PROVIDER==='deepseek'){
    const started=Date.now();let primaryStatus='unknown';
    const found=await searchDeepSeek(query,{limit,timeoutMs,signal,domains,domainMode,language,startDate,endDate,onAttempt:event=>{primaryStatus=event.status;markSearch(event.status,'deepseek-search');onAttempt?.(event);}});
    if(found!==null || signal?.aborted || !process.env.TAVILY_API_KEY || options.fallback===false)return found;
    const remaining=timeoutMs-(Date.now()-started);if(remaining<=500)return null;
    const fallback=await searchTavily(query,{limit,timeoutMs:remaining,signal,domains,domainMode,language,startDate,endDate,onAttempt:event=>{markSearch(event.status,'tavily');onAttempt?.(event);}});
    SEARCH_STATE.primary_status=primaryStatus;
    return fallback;
  }
  if(signal?.aborted){searchAttempt(onAttempt,{provider:'none',query,started:Date.now(),status:'cancelled',reason_code:'cancelled'});return null;}
  if(provider==='tavily'){
    return searchTavily(query,{limit,timeoutMs,signal,domains,domainMode,language,startDate,endDate,onAttempt:event=>{markSearch(event.status,'tavily');if(typeof onAttempt==='function')onAttempt(event);}});
  }
  if(provider!=='current'){markSearch('error');searchAttempt(onAttempt,{provider:'none',query,started:Date.now(),status:'error',reason_code:'unsupported_provider'});return null;}
  if (process.env.VOLC_SEARCH_API_KEY) {
    const started=Date.now();
    const skipped=started<VOLC_SEARCH_RETRY_AT,model=volcSearchModel();
    const outcome = skipped?{status:'quota_exhausted',results:null}:await searchVolc(query, {
      key: process.env.VOLC_SEARCH_API_KEY,
      model,
      limit, timeoutMs, signal
    });
    searchAttempt(onAttempt,{provider:'volc-search',model,query,started,status:skipped?'skipped':outcome.status,network_request:!skipped,http_status:outcome.http_status,reason_code:skipped?'cooldown':outcome.reason_code,usage:outcome.usage});
    if(outcome.results){markSearch(outcome.status,'volc-search');return outcome.results;}
    if(outcome.status==='quota_exhausted')VOLC_SEARCH_RETRY_AT=Date.now()+300000;
    const remaining=timeoutMs-(Date.now()-started);
    const fallback=remaining>500 && !signal?.aborted?await searchPublicIndex(query,limit,Math.min(remaining,8000),signal,onAttempt):null;
    markSearch(fallback?'available':outcome.status,fallback?'public-search':'volc-search');
    SEARCH_STATE.primary_status=outcome.status;
    return fallback;
  }
  if (!llmConfigured()){searchAttempt(onAttempt,{provider:'none',query,started:Date.now(),status:'unconfigured',reason_code:'unconfigured'});return null;}
  if (Date.now() < SEARCH_QUOTA_UNTIL) {
    searchAttempt(onAttempt,{provider:'zhipu',query,started:Date.now(),status:'skipped',reason_code:'cooldown'});
    const fallback = await searchPublicIndex(query, limit, timeoutMs, signal,onAttempt);
    markSearch(fallback ? 'available' : 'quota_exhausted', fallback ? 'public-search' : null);
    return fallback;
  }
  const started=Date.now();let httpStatus=null;
  try {
    await reserveUpstream('search');
    const res = await fetch(`${BASE}/web_search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        search_engine: process.env.LLM_SEARCH_ENGINE || 'search_std',
        search_query: String(query).slice(0, 100)
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    });
    httpStatus=res.status;
    if (!res.ok) {
      markSearch(res.status === 429 ? 'quota_exhausted' : 'error');
      throw new Error('search HTTP ' + res.status);
    }
    const body = await res.json();
    if(body.search_result!==undefined && !Array.isArray(body.search_result))throw Error('检索返回格式无效');
    const results=(body.search_result || []).slice(0, limit).map((r) => ({
      title: r.title || '',
      link: r.link || '',
      content: (r.content || '').slice(0, 300),
      media: r.media || null,
      date: r.publish_date || null
    }));
    searchAttempt(onAttempt,{provider:'zhipu',query,started,status:results.length?'available':'empty',network_request:true,http_status:httpStatus});
    markSearch('available', 'zhipu');
    return results;
  } catch (err) {
    searchAttempt(onAttempt,{provider:'zhipu',query,started,status:signal?.aborted?'cancelled':httpStatus===429?'quota_exhausted':err?.name==='TimeoutError' || err?.name==='AbortError'?'timeout':'error',network_request:true,http_status:httpStatus,reason_code:signal?.aborted?'cancelled':httpStatus?'http_error':'network_or_timeout'});
    if (err && err.message === 'search HTTP 429') {
      SEARCH_QUOTA_UNTIL = Date.now() + 10 * 60 * 1000;
      const fallback = await searchPublicIndex(query, limit, timeoutMs, signal,onAttempt);
      if (fallback) {
        markSearch('available', 'public-search');
        return fallback;
      }
    }
    if (!(err && err.message && err.message.startsWith('search HTTP'))) {
      markSearch(err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'error');
    }
    console.error('✗ 联网检索失败（' + query + '）：' + err.message);
    return null;
  }
}
export function searchWebDetailed(query,options={}){return detailedSearch(searchWeb,query,options);}

/** 结构化主模型统一出口。显式OpenAI配置优先，否则DeepSeek、火山、旧兼容通道。
 * 已选供应商失败不切换账户；请求仍统一执行JSON、取消、用量与失败分类。
 */
async function sendModelJson(opts,{provider,model,url,key,webSearch=false,defaultTimeout=12000}){
  if(opts.signal?.aborted){const failure={...classifyModelFailure({signal:opts.signal}),retry_handled:true},request=modelRequest({...opts,telemetry:{...opts.telemetry,physical_attempt:0}},provider,model);request.finish({status:'cancelled',reason:failure.reason_code});try{opts.onFailure?.(failure);}catch{}return null;}
  const result=await runModelAttempts({timeoutMs:opts.timeoutMs || defaultTimeout,signal:opts.signal,reserveRetry:opts.reserveRetry,canRetry:opts.canRetry,onRetry:opts.onRetry,onRetryWait:opts.onRetryWait,
    execute:async({attempt,timeoutMs,metadata})=>{
      const attemptOpts={...opts,telemetry:{...opts.telemetry,...metadata,physical_attempt:attempt},onFailure:null};
      const request=modelRequest(attemptOpts,provider,model);let responseBody=null,httpStatus=null,retryAfter=null;
      try{
        const body={model,temperature:webSearch?.3:.2,messages:request.messages};
        if(provider==='openai'){
          delete body.temperature;
          body.reasoning_effort=reasoningEffort(opts.reasoningEffort ?? currentModelSettings().effort);
          body.store=false;
        }else if(provider!=='compatible')body.thinking={type:'disabled'};
        if(webSearch)body.tools=[{type:'web_search',web_search:{enable:true,search_count:5}}];else body.response_format={type:'json_object'};
        await reserveUpstream(webSearch?'search':'model');
        const timeout=AbortSignal.timeout(timeoutMs),res=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify(body),...(provider==='openai' && process.env.OPENAI_PROXY_URL?{dispatcher:openaiDispatcher()}:{}),signal:opts.signal?AbortSignal.any([opts.signal,timeout]):timeout});
        httpStatus=res.status ?? null;retryAfter=res.headers?.get?.('retry-after') || null;
        if(!res.ok){
          try{const errorBody=await res.json();const code=errorBody?.error?.code || errorBody?.error?.type;if(typeof code==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(code))responseBody={error:{code}};}catch{}
          throw new Error(provider+' HTTP '+res.status);
        }
        responseBody=await res.json();let failure=null;
        const value=decodeModelJson(responseBody,{onFailure:f=>failure=f});
        request.finish({body:responseBody,status:value===null?'invalid_output':'success',httpStatus,reason:failure?.reason_code || null});
        // 空输出等结构问题不是HTTP重试；保留原有结构修复的判断。
        return {value,failure,decoded_failure:true};
      }catch(error){
        const failure={...classifyModelFailure({status:httpStatus,error,signal:opts.signal,retryAfter}),provider_error_code:responseBody?.error?.code || null};
        request.finish({body:responseBody,status:opts.signal?.aborted?'cancelled':'error',httpStatus,reason:failure.reason_code,providerErrorCode:failure.provider_error_code});
        return {value:null,failure};
      }
    }});
  if(result.failure){try{opts.onFailure?.(result.failure);}catch{}}
  return result.value;
}
export async function composeJson(opts){
  const {provider,model}=composeModelInfo();if(provider==='compatible')return callJson(opts);
  if(provider==='openai'){
    const scoped=currentModelSettings();
    if(scoped.deadlineAt)opts={...opts,reasoningEffort:scoped.effort,timeoutMs:modelStageTimeout(opts,scoped.effort,scoped.deadlineAt-Date.now())};
    if(!openaiKey()){const request=modelRequest(opts,provider,model);request.finish({status:'unconfigured',reason:'unconfigured'});opts.onFailure?.({reason_code:'unconfigured',retryable:false});return null;}
    return sendModelJson(opts,{provider,model,url:'https://api.openai.com/v1/chat/completions',key:openaiKey()});
  }
  return sendModelJson(opts,{provider,model,url:provider==='deepseek'?'https://api.deepseek.com/chat/completions':VOLC_CHAT,key:provider==='deepseek'?deepseekKey():process.env.VOLC_SEARCH_API_KEY});
}
export async function callJson(opts){
  const model=opts.model || MODEL;
  if(!llmConfigured()){const request=modelRequest(opts,'compatible',model);request.finish({status:'unconfigured',reason:'unconfigured'});try{opts.onFailure?.({reason_code:'unconfigured',retryable:false});}catch{}return null;}
  return sendModelJson(opts,{provider:'compatible',model,url:`${BASE}/chat/completions`,key:KEY,webSearch:opts.webSearch===true,defaultTimeout:30000});
}
