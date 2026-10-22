/* 手动真实验收：固定十二任务各两轮，Tavily搜索+主对话+来源核对+结论支持核对。报告仅保存在本机。 */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {baselinePlan} from './lib/source-baseline.mjs';
import {conversationTurn} from './lib/conversation.mjs';
import {readPublicPage} from './lib/public-reader.mjs';
import {composeJson,searchWebDetailed} from './lib/llm.mjs';
import {tavilyConfigured} from './lib/search-tavily.mjs';
const dataset=JSON.parse(readFileSync(new URL('../pipeline/data/source-baseline-tasks.json',import.meta.url),'utf8'));
if(!tavilyConfigured())throw Error('Tavily未配置，不能将未配置记作无结果');
const output=resolve(process.env.R1B_REPLAY_OUT || join(tmpdir(),'mixtouring-r1b-live.json'));
const frozen=Date.now(),all=baselinePlan(dataset,{repeat:2,now:frozen});
const only=process.env.R1B_CASES?.split(',').map(s=>s.trim()).filter(Boolean);
const selected=only?.length?all.filter(j=>only.includes(j.task.id)):all;
const jobs=process.env.R1B_ROUND?selected.filter(j=>j.repeat===Number(process.env.R1B_ROUND)):selected;
if(!jobs.length)throw Error('没有匹配的任务ID');
const origins={'route-beijing-almaty':'北京','route-yining-almaty':'伊宁','route-chengdu-kunming':'成都','route-tokyo-osaka':'东京','experience-yili-xhs':'乌鲁木齐','experience-chengdu-mafengwo':'成都'};
const report={schema_version:1,profile:'R1-B真实任务整合：来源/结论/引用分层验收',started_at:new Date().toISOString(),frozen_at:new Date(frozen).toISOString(),planned:jobs.length,records:[]};
const save=()=>{mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');};
const controller=new AbortController();process.once('SIGINT',()=>controller.abort());
let next=0;
async function worker(){
  while(next<jobs.length && !controller.signal.aborted){
    const {task,repeat,query,window}=jobs[next++],origin=origins[task.id] || '北京',destination=task.destination;
    const brief={origin,destination,summary:'讨论'+destination+'的公开旅行资料'},route=[origin,destination];
    const conversation={stage:'draft',brief,routing:{origin,destination},draft:{title:'已有旅行想法',overview:'具体交通待核实。',route,cards:[{id:'place',place:destination,label:'目的地阶段',title:'当地活动',content:'安排待讨论。'}],sections:[],pending:['交通班期待核实。']}};
    const text='请核对公开资料，讨论'+query.replace(/\bsite:\S+\s*/g,'')+'，说明有依据的取舍和待查项。先不要改行程。';
    const searches=[],modelUsage=[],modelAttempts=[],rawStages=[],started=Date.now();let result;
    try{result=await conversationTurn({text,conversation},null,{now:frozen,budgetMs:110000,sourceReview:true,evidenceReview:true,readPage:readPublicPage,signal:controller.signal,
      search:async(q,opts)=>{const r=await searchWebDetailed(q,{...opts,provider:'tavily'});searches.push({status:r.status,attempts:r.attempts.map(a=>({provider:a.provider,status:a.status,elapsed_ms:a.elapsed_ms,network_request:a.network_request,usage:a.usage,reason_code:a.reason_code})),elapsed_ms:r.elapsed_ms,result_count:r.results?.length ?? 0});return r.results;},
      model:async opts=>{modelAttempts.push({kind:opts.kind});const output=await composeJson(opts);if(process.env.R1B_CAPTURE_MODEL)rawStages.push({kind:opts.kind,output});return output;},
      onModelUsage:u=>modelUsage.push(u)});}catch{result={status:'unavailable',reply:'运行中断或失败'};}
    const record={task_id:task.id,group:task.group,repeat,query,window,status:result.status,reply:result.reply || '',source_relevance:result.source_relevance?.status || null,
      claims:(result.evidence_claims || []).map(c=>({sentence:c.sentence,allowed_use:c.allowed_use,supports:c.supports})),
      sources:(result.sources || []).map(s=>({url:s.url,title:s.title,kind:s.kind,published_at:s.published_at,read_status:s.read_status})),
      searches,model_attempts:modelAttempts,model_usage:modelUsage,...(process.env.R1B_CAPTURE_MODEL?{raw_stages:rawStages}:{}),elapsed_ms:Date.now()-started};
    report.records.push(record);report.records.sort((a,b)=>a.repeat-b.repeat || a.task_id.localeCompare(b.task_id));save();
    console.log(`${report.records.length}/${jobs.length} ${task.id} 第${repeat}轮：${record.status}；引用${record.sources.length}；结论${record.claims.length}；检索${searches.length}`);
  }
}
await Promise.all(Array.from({length:Math.min(2,jobs.length)},worker));
const durations=report.records.map(r=>r.elapsed_ms).sort((a,b)=>a-b),percentile=p=>durations.length?durations[Math.ceil(durations.length*p)-1]:null;
report.finished_at=new Date().toISOString();report.summary={complete:report.records.length,ok:report.records.filter(r=>r.status==='ok').length,
  search_calls:report.records.reduce((n,r)=>n+r.searches.length,0),reported_credits:report.records.reduce((n,r)=>n+r.searches.reduce((m,s)=>m+s.attempts.reduce((o,a)=>o+(a.usage?.api_credits || 0),0),0),0),
  model_attempts:report.records.reduce((n,r)=>n+r.model_attempts.length,0),reported_model_calls:report.records.reduce((n,r)=>n+r.model_usage.length,0),reported_model_tokens:report.records.reduce((n,r)=>n+r.model_usage.reduce((m,u)=>m+(u.total_tokens || 0),0),0),
  output_sources:report.records.reduce((n,r)=>n+r.sources.length,0),sourced_claim_rounds:report.records.filter(r=>r.claims.length).length,
  task_latency_p50_ms:percentile(.5),task_latency_p95_ms:percentile(.95),first_useful_result_ms:null,first_useful_result_note:'需人工评估真实取舍价值；不能把状态ok或链接数量当作有用结果',currency_cost:'unknown'};save();console.log(JSON.stringify(report.summary));console.log('私有报告：'+output);
if(report.records.length!==jobs.length || report.records.some(r=>r.searches.length>2))process.exitCode=1;
