/* 同任务对照只报告测量差异；新增URL和成功读取不自动变成经核实的结论。 */
import {summarizeBaseline} from './source-baseline.mjs';
import {articleIdentity} from './travel-sources.mjs';
const day=value=>new Date(value).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
const recordKey=r=>r.task_id+'#'+r.repeat;
export function compareSourceBaselines(left,right){
  for(const report of [left,right]){
    if(report?.schema_version!==1 || !/^[a-f0-9]{64}$/.test(report.dataset_sha256) || ![1,2].includes(report.repeat) || report.planned!==12*report.repeat || !Array.isArray(report.records) || report.records.length!==report.planned || report.cancelled || !Number.isFinite(Date.parse(report.frozen_at)))throw Error('只接受完整且有数据集身份的同日基线');
    if(new Set(report.records.map(recordKey)).size!==report.records.length)throw Error('基线任务身份重复');
    if(new Set(report.records.map(r=>r.task_id)).size!==12 || report.records.some(r=>!/^[a-z0-9-]+$/.test(r.task_id) || !Number.isInteger(r.repeat) || r.repeat<1 || r.repeat>report.repeat))throw Error('基线任务或重复轮次无效');
    if(report.records.some(r=>r.searches.some(s=>s.status==='unconfigured')))throw Error('未配置服务不构成真实效果对照');
  }
  if(left.dataset_sha256!==right.dataset_sha256 || day(left.frozen_at)!==day(right.frozen_at) || left.repeat!==right.repeat)throw Error('数据集、参考日期或重复次数不同，不能直接对照');
  if((left.measurement_profile || 'legacy')!==(right.measurement_profile || 'legacy'))throw Error('来源筛选或读取预算口径不同，不能直接对照');
  const pairs=left.records.map(a=>{
    const b=right.records.find(r=>recordKey(a)===recordKey(r));
    if(!b || ['query','window','language','target_domain','group'].some(key=>a[key]!==b[key]))throw Error('任务查询或范围不同，不能直接对照');
    const oldUrls=new Set(a.sources.map(s=>articleIdentity(s.url)));
    return {task_id:a.task_id,repeat:a.repeat,left_outcome:a.outcome,right_outcome:b.outcome,
      new_reference_urls:b.sources.filter(s=>!oldUrls.has(articleIdentity(s.url))).map(s=>s.url),
      left_reads:a.reads.length,right_reads:b.reads.length,left_read_success:a.reads.filter(r=>r.identity_match).length,right_read_success:b.reads.filter(r=>r.identity_match).length};
  });
  const before=summarizeBaseline(left.records,left.planned),after=summarizeBaseline(right.records,right.planned);
  const sameRun=left.run_id===right.run_id;
  return {schema_version:1,status:sameRun?'same_run_replay':'comparable',left_run_id:left.run_id,right_run_id:right.run_id,left_provider:left.provider || 'current',right_provider:right.provider || 'current',dataset_sha256:left.dataset_sha256,reference_day:day(left.frozen_at),
    before,after,delta:{domain_hit_queries:after.query_domain_hit.numerator-before.query_domain_hit.numerator,read_success:after.page_read.numerator-before.page_read.numerator,task_p95_ms:after.latency.task.p95_ms-before.latency.task.p95_ms},tasks:pairs,
    conclusion:sameRun?'同一次运行，只作记录重算，不构成服务效果对照':'新增参考与读取差异仅为测量；原文结论支持和旅行可执行性须另行核验'};
}
export async function diagnoseBaselineReads(baseline,{readPage,signal,onRecord=()=>{}}){
  if(baseline?.schema_version!==1 || !Array.isArray(baseline.records) || typeof readPage!=='function')throw Error('读取诊断输入无效');
  const targets=baseline.records.flatMap(r=>(r.reads || []).map(read=>({task_id:r.task_id,repeat:r.repeat,url:read.url})));
  if(targets.length>144)throw Error('读取诊断超过单批上限');
  const report={schema_version:1,kind:'public_reader_diagnostics',baseline_run_id:baseline.run_id,started_at:new Date().toISOString(),planned:targets.length,records:[],summary:null};
  let next=0;
  const summarize=()=>{const by_reason={},by_http_status={};for(const r of report.records){const reason=r.reason_code || (r.status==='page_excerpt'?r.identity_match?'available':'identity_mismatch':'unavailable'),http=r.diagnostics?.http_status || 'unknown';by_reason[reason]=(by_reason[reason] || 0)+1;by_http_status[http]=(by_http_status[http] || 0)+1;}return {completed:report.records.length,read_success:report.records.filter(r=>r.identity_match).length,by_reason,by_http_status};};
  const worker=async()=>{while(next<targets.length && !signal?.aborted){const target=targets[next++],started=Date.now();let page;
    try{page=await readPage(target.url,{signal,timeoutMs:5500});}catch{page={read_status:'unavailable',reason_code:'reader_error'};}
    const identity_match=page?.read_status==='page_excerpt' && articleIdentity(page.url || target.url)===articleIdentity(target.url);
    report.records.push({...target,final_url:page?.url || target.url,status:page?.read_status || 'unavailable',identity_match,elapsed_ms:Date.now()-started,reason_code:page?.reason_code || null,diagnostics:page?.diagnostics || null});
    report.summary=summarize();await onRecord(structuredClone(report));
  }};
  await Promise.all([worker(),worker()]);report.finished_at=new Date().toISOString();report.cancelled=!!signal?.aborted;report.summary=summarize();return report;
}
