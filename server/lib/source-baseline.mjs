/* 基线为固定公开查询探针，不生成行程、不登记来源、不写用户草案。 */
import {createHash,randomUUID} from 'node:crypto';
import {collectTravelSources} from './travel-sources.mjs';
export function validateBaseline(dataset,repeat){
  if(dataset?.version!==1 || dataset.tasks?.length!==12 || ![1,2].includes(repeat))throw Error('基线必须为十二项任务，重复一至两次');
  const ids=new Set();
  for(const t of dataset.tasks){
    if(!/^[a-z0-9-]+$/.test(t.id) || ids.has(t.id) || !['route','experience','boundary'].includes(t.group) || !['zh','en'].includes(t.language) || !t.destination || !['transport','experience','guide'].includes(t.purpose) || !/^[a-z0-9.-]+$/.test(t.domain) || !Array.isArray(t.kinds) || !t.kinds.length || t.kinds.some(k=>!['guide','official','experience'].includes(k)) || typeof t.query!=='string' || t.query.length>100 || !Array.isArray(t.terms) || !t.terms.length || t.terms.some(group=>!Array.isArray(group) || !group.length || group.some(x=>typeof x!=='string' || !x)))throw Error('基线任务无效');
    ids.add(t.id);
  }
  if(['route','experience','boundary'].some(g=>dataset.tasks.filter(t=>t.group===g).length!==4) || new Set(dataset.tasks.map(t=>t.destination)).size<3)throw Error('基线分层不足');
}
export function baselinePlan(dataset,{repeat=2,now=Date.now()}={}){
  validateBaseline(dataset,repeat);
  return Array.from({length:repeat},(_,r)=>dataset.tasks.map(task=>{
    const date=task.future_days?new Date(now+task.future_days*86400000).toISOString().slice(0,10):null;
    return {task,repeat:r+1,query:task.query.replace('{date}',date || ''),window:date?date+' ~ '+date:null};
  })).flat();
}
export function assessBaselineSource(task,source){
  const excerpt=source.excerpt.slice(0,500),text=(source.title+' '+excerpt).toLowerCase();
  const lexical_match=task.terms.every(terms=>terms.some(term=>text.includes(term.toLowerCase())));
  return {...source,excerpt,lexical_match,
    review:{status:'pending',supports_conclusion:null,reason:null},allowed_use:task.allowed_use,
    missing:task.group==='route'?['方向与同句连接待人工核查','指定日期班次、可用性及价格未知']:['原文语境与结论支持待人工核查']};
}
const ratio=(n,d)=>({numerator:n,denominator:d,rate:d?n/d:null});
export function summarizeBaseline(records,planned){
  const queries=records.flatMap(r=>r.searches),attempts=queries.flatMap(q=>q.attempts),sources=records.flatMap(r=>r.sources),reads=records.flatMap(r=>r.reads);
  const count=(xs,p)=>xs.filter(p).length,byStatus=xs=>Object.fromEntries([...new Set(xs.map(x=>x.status))].sort().map(s=>[s,count(xs,x=>x.status===s)]));
  const latency=xs=>{const a=xs.map(x=>x.elapsed_ms).sort((a,b)=>a-b);return {count:a.length,p50_ms:a.length?a[Math.floor((a.length-1)*.5)]:null,p95_ms:a.length?a[Math.ceil(a.length*.95)-1]:null};};
  const reviewed=sources.filter(s=>s.review?.status==='reviewed'),decisive=reviewed.filter(s=>typeof s.review.supports_conclusion==='boolean');
  const coverage=rs=>({runs:rs.length,domain_hits:count(rs,r=>r.query_diagnostics.some(q=>q.domain_hit_count>0)),current_sources:rs.flatMap(r=>r.sources).filter(s=>['recent','window_reference'].includes(s.temporal.state)).length,reads:rs.reduce((n,r)=>n+r.reads.length,0),read_success:rs.flatMap(r=>r.reads).filter(r=>r.identity_match).length});
  const grouped=key=>Object.fromEntries([...new Set(records.map(r=>r[key]))].sort().map(value=>[value,coverage(records.filter(r=>r[key]===value))]));
  const stability=[...new Set(records.map(r=>r.task_id))].sort().map(id=>{
    const runs=records.filter(r=>r.task_id===id),urls=r=>new Set(r.sources.map(s=>s.url)),first=urls(runs[0]),second=runs[1]?urls(runs[1]):null;
    const union=second?new Set([...first,...second]):null,intersection=second?[...first].filter(url=>second.has(url)).length:0;
    return {task_id:id,runs:runs.length,outcome_same:runs.length===2?runs[0].outcome===runs[1].outcome:null,url_overlap:union?ratio(intersection,union.size):null};
  });
  return {planned,completed:records.length,queries:queries.length,query_status:byStatus(queries),attempt_status:byStatus(attempts),
    http_calls_started:count(attempts,a=>a.network_request),cooldown_skips:count(attempts,a=>a.status==='skipped'),
    query_domain_hit:ratio(count(records,r=>r.query_diagnostics.some(q=>q.domain_hit_count>0)),queries.length),
    raw_domain_hit:ratio(records.reduce((n,r)=>n+r.query_diagnostics.reduce((v,q)=>v+q.domain_hit_count,0),0),records.reduce((n,r)=>n+r.query_diagnostics.reduce((v,q)=>v+q.raw_count,0),0)),
    current_sources:count(sources,s=>['recent','window_reference'].includes(s.temporal.state)),historical_or_undated:count(sources,s=>!['recent','window_reference','future'].includes(s.temporal.state)),excluded_future:count(sources,s=>s.temporal.state==='future'),
    page_read:ratio(count(reads,r=>r.status==='page_excerpt' && r.identity_match),reads.length),read_status:byStatus(reads),
    lexical_candidates:count(sources,s=>s.lexical_match),reviewed_sources:reviewed.length,
    support_rate:ratio(count(decisive,s=>s.review.supports_conclusion===true),decisive.length),support_unresolved:sources.length-decisive.length,
    by_group:grouped('group'),by_domain:grouped('target_domain'),by_language:grouped('language'),repeat_stability:stability,
    latency:{task:latency(records),query:latency(queries),attempt:latency(attempts),read:latency(reads)},
    usage: Object.fromEntries(['input_tokens','output_tokens','total_tokens','web_search_calls'].map(k=>{const reported=attempts.filter(a=>Number.isFinite(a.usage?.[k]));return [k,{reported_attempts:reported.length,total:reported.length?reported.reduce((n,a)=>n+a.usage[k],0):null}];})),
    cost:{amount:null,currency:null,basis:'服务未返回金额；调用及用量不等于已知费用'},
    outcomes:Object.fromEntries(records.map(r=>[r.task_id+'#'+r.repeat,r.outcome]))};
}
export async function runSourceBaseline(dataset,{search,readPage,repeat=2,now=Date.now(),concurrency=2,onRecord=()=>{},signal}={}){
  const plan=baselinePlan(dataset,{repeat,now}),report={schema_version:1,harness_version:'0.60.10',cache:'应用层关闭，上游缓存不可判定',search_timeout_ms:12000,run_id:randomUUID(),profile:dataset.profile,dataset_sha256:createHash('sha256').update(JSON.stringify(dataset)).digest('hex'),
    frozen_at:new Date(now).toISOString(),started_at:new Date().toISOString(),repeat,concurrency,planned:plan.length,records:[],summary:null};
  if(!Number.isInteger(concurrency) || concurrency<1 || concurrency>2 || typeof search!=='function' || typeof readPage!=='function')throw Error('基线依赖或并发参数无效');
  let next=0;
  const worker=async()=>{while(next<plan.length && !signal?.aborted){
    const {task,repeat:iteration,query,window}=plan[next++],started=Date.now(),searches=[],reads=[];
    const collected=await collectTravelSources({destination:task.destination,purpose:task.purpose,window},async(q,opts)=>{
      const result=await search(q,{...opts,run_id:report.run_id});searches.push(result);
      // 公开索引明确返回零项与通道错误分开；不改变原业务接口的 null 契约。
      return result.results || (result.status==='empty'?[]:null);
    },{now,useCache:false,signal,diagnostics:true,queryPlans:[{channel:task.id,text:query,domain:task.domain,kinds:task.kinds}],readPage:async(url,opts)=>{
      const start=Date.now();let page;try{page=await readPage(url,opts);}catch{page={read_status:'unavailable'};}
      reads.push({url,elapsed_ms:Date.now()-start,status:page?.read_status || 'unavailable',identity_match:false});return page;
    }});
    const sources=(collected.diagnostics?.all_sources || []).map(s=>assessBaselineSource(task,s));
    for(const read of reads){const source=sources.find(s=>s.url===read.url || s.original_url===read.url);read.identity_match=source?.read_status==='page_excerpt';if(read.status==='page_excerpt' && !read.identity_match)read.status='identity_mismatch';}
    const diagnostics=collected.diagnostics?.queries || [],outcome=collected.cancelled?'cancelled':!searches.some(s=>Array.isArray(s.results) || s.status==='empty')?'channel_unavailable':!diagnostics.some(q=>q.raw_count)?'no_results':!diagnostics.some(q=>q.domain_hit_count)?'domain_miss':!sources.length?'path_or_kind_rejected':sources.every(s=>!['recent','window_reference'].includes(s.temporal.state))?'historical_or_undated':'current_reference';
    const record={task_id:task.id,group:task.group,destination:task.destination,language:task.language,target_domain:task.domain,query,window,repeat:iteration,outcome,elapsed_ms:Date.now()-started,searches,query_diagnostics:diagnostics,reads,sources};
    report.records.push(record);report.records.sort((a,b)=>a.repeat-b.repeat || a.task_id.localeCompare(b.task_id));report.summary=summarizeBaseline(report.records,plan.length);await onRecord(structuredClone(report),record);
  }};
  await Promise.all(Array.from({length:concurrency},worker));report.finished_at=new Date().toISOString();report.cancelled=!!signal?.aborted;report.summary=summarizeBaseline(report.records,plan.length);return report;
}
