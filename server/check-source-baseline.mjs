/* 实际检索出口、并发归因和固定任务报告；只注入 HTTP 与公开网页桩。 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {baselinePlan,runSourceBaseline,summarizeBaseline} from './lib/source-baseline.mjs';
import {collectTravelSources} from './lib/travel-sources.mjs';
const dataset=JSON.parse(readFileSync(new URL('../pipeline/data/source-baseline-tasks.json',import.meta.url),'utf8'));
const now=Date.parse('2026-10-20T02:00:00Z');
const plan=baselinePlan(dataset,{now});
assert.equal(plan.length,24);assert.equal(plan.find(p=>p.window).window,'2026-12-19 ~ 2026-12-19');
assert.throws(()=>baselinePlan({...dataset,tasks:dataset.tasks.slice(1)}));assert.throws(()=>baselinePlan(dataset,{repeat:3}));
const originalFetch=globalThis.fetch,originalKey=process.env.VOLC_SEARCH_API_KEY;
const response=(status,body)=>({status,ok:status===200,headers:new Headers({'content-type':typeof body==='string'?'text/html':'application/json'}),json:async()=>body,text:async()=>body});
const cited=query=>({status:'completed',usage:{input_tokens:3,output_tokens:4,total_tokens:7,tool_usage:{web_search:1}},output:[{type:'web_search_call',status:'completed'},{type:'message',content:[{annotations:[{type:'url_citation',url:'https://reddit.com/r/travel/comments/'+query,title:query,summary:'个人游记',publish_time:'2026-10-01'}]}]}]});
const fresh=()=>import('./lib/llm.mjs?baseline='+Math.random());
try{
  process.env.VOLC_SEARCH_API_KEY='仅测试凭据';
  globalThis.fetch=async(_url,opts)=>{const query=JSON.parse(opts.body).input.split('查询词：')[1];await new Promise(resolve=>setTimeout(resolve,query==='slow'?15:1));return response(200,cited(query));};
  const api=await fresh(),parallel=await Promise.all(['slow','fast'].map(q=>api.searchWebDetailed(q,{run_id:'test-run'})));
  for(const [i,r] of parallel.entries()){
    assert.equal(r.status,'available');assert.equal(r.results[0].title,['slow','fast'][i]);assert.equal(r.attempts.length,1);assert.equal(r.attempts[0].request_id,r.request_id);assert.equal(r.attempts[0].run_id,'test-run');assert.equal(r.attempts[0].usage.total_tokens,7);assert.equal(r.cost.amount,null);
    assert.ok(!JSON.stringify(r).includes('仅测试凭据'));assert.ok(!JSON.stringify(r).includes('authorization'));
  }
  assert.notEqual(parallel[0].request_id,parallel[1].request_id);
  let httpCalls=0;
  globalThis.fetch=async url=>{httpCalls++;return String(url).includes('volces.com')?response(429,{error:{code:'SetLimitExceeded',message:'不应保存的原始错误'}}):response(200,'<title>访问异常页面</title>');};
  const quota=await fresh(),first=await quota.searchWebDetailed('额度探针'),second=await quota.searchWebDetailed('冷却探针');
  assert.equal(httpCalls,2);assert.deepEqual(first.attempts.map(a=>a.status),['quota_exhausted','blocked']);assert.deepEqual(second.attempts.map(a=>a.status),['skipped','skipped']);assert.equal(second.network_requests,0);assert.equal(second.status,'unavailable');assert.ok(!JSON.stringify(first).includes('不应保存'));
  const ctrl=new AbortController();ctrl.abort();const cancelled=await quota.searchWebDetailed('取消',{signal:ctrl.signal});assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.network_requests,0);assert.equal(httpCalls,2);
  globalThis.fetch=async url=>String(url).includes('volces.com')?response(200,{status:'completed',output:[],usage:{tool_usage:{web_search:1}}}):response(200,'<html><body>没有结果</body></html>');
  const emptyApi=await fresh(),empty=await emptyApi.searchWebDetailed('无引用');assert.equal(empty.status,'empty');assert.equal(empty.attempts[0].reason_code,'missing_search_citations');assert.equal(empty.network_requests,2);
  globalThis.fetch=async url=>String(url).includes('volces.com')?response(503,{}):response(200,'<li class="res-list"><h3 class="res-title"><a data-mdurl="https://reddit.com/r/travel/comments/abc">参考原帖</a></h3><span class="res-list-summary">旅行经验</span></li>');
  const fallback=await (await fresh()).searchWebDetailed('备用通道');assert.equal(fallback.provider,'public-search');assert.equal(fallback.results.length,1);assert.deepEqual(fallback.attempts.map(a=>a.status),['error','available']);assert.equal(fallback.cost.amount,null);
}finally{globalThis.fetch=originalFetch;if(originalKey===undefined)delete process.env.VOLC_SEARCH_API_KEY;else process.env.VOLC_SEARCH_API_KEY=originalKey;}
console.log('✓ 实际搜索出口并发身份、主备请求、额度冷却、零项、取消与脱敏通过');
const fixed=(rows,readPage,window=null)=>collectTravelSources({purpose:'transport',window},async()=>rows,{now,diagnostics:true,queryPlans:[{channel:'测试',text:'测试',domain:'reddit.com',kinds:['experience']}],readPage});
const raw=(link,date='2026-10-01')=>({link,title:'Almaty',content:'Beijing Almaty bus',date});
const miss=await fixed([raw('https://reddit.com.evil.test/r/travel/comments/1')]);assert.equal(miss.diagnostics.queries[0].domain_hit_count,0);
const rejected=await fixed([raw('https://reddit.com/search/')]);assert.equal(rejected.diagnostics.queries[0].domain_hit_count,1);assert.equal(rejected.diagnostics.queries[0].accepted_count,0);
const old=await fixed([raw('https://reddit.com/r/travel/comments/1','2020-01-01')]);assert.equal(old.archive[0].temporal.state,'historical');
const undated=await fixed([raw('https://reddit.com/r/travel/comments/2',null)],async()=>({read_status:'unavailable'}));assert.equal(undated.archive[0].temporal.state,'undated');assert.equal(undated.reader.available,0);
const redirect=await fixed([raw('https://reddit.com/r/travel/comments/3')],async()=>({url:'https://reddit.com/r/travel/comments/other',read_status:'page_excerpt',excerpt:'其他文章',published_at:'2026-10-19'}));assert.equal(redirect.reader.available,0);assert.equal(redirect.sources[0].excerpt,'Beijing Almaty bus');
const future=await fixed([raw('https://reddit.com/r/travel/comments/4','2027-01-01')]);assert.equal(future.excluded_count,1);
// 国庆仅作固定时钟的历史夹具回归；线上计划不把已过去的国庆当未来任务。
const historical=await fixed([raw('https://reddit.com/r/travel/comments/5','2026-10-10')],null,'2026-10-01 ~ 2026-10-08');assert.equal(historical.archive[0].temporal.state,'after_trip');
await assert.rejects(()=>collectTravelSources({},async()=>[],{queryPlans:[]}));
console.log('✓ 实际域名、路径拒绝、旧文、未知日期、跨文章跳转与历史时钟隔离通过');
let checkpoints=0;
const report=await runSourceBaseline(dataset,{now,search:async(query,{run_id})=>{
  const task=plan.find(p=>p.query===query).task;
  const link='https://'+task.domain+(task.domain==='xiaohongshu.com'?'/explore/123':task.domain==='reddit.com'?'/r/travel/comments/123':task.domain==='mafengwo.cn'?'/i/123.html':'/guide/123');
  return {run_id,request_id:task.id,status:'available',results:[{link,title:task.destination,content:task.terms.map(t=>t[0]).join(' '),date:'2026-10-01'}],elapsed_ms:1,attempts:[{provider:'fixture',status:'available',network_request:true,elapsed_ms:1,usage:null,cost:{amount:null}}]};
},readPage:async url=>({url,read_status:'page_excerpt',excerpt:'公开原文摘要',published_at:'2026-10-01'}),onRecord:()=>{checkpoints++;}});
assert.equal(checkpoints,24);assert.equal(report.summary.completed,24);assert.equal(report.summary.query_domain_hit.rate,1);assert.equal(report.summary.http_calls_started,24);assert.equal(report.summary.page_read.rate,1);assert.equal(report.summary.support_rate.rate,null);assert.equal(report.summary.cost.amount,null);assert.equal(report.summary.usage.total_tokens.total,null);
assert.deepEqual(summarizeBaseline(JSON.parse(JSON.stringify(report)).records,24),report.summary,'本地回放只使用已记录资料');
const gyg=report.records.find(r=>r.task_id==='experience-osaka-gyg');assert.equal(gyg.sources[0].kind,'guide');assert.ok(gyg.sources[0].allowed_use.includes('商业'));
const reviewed=structuredClone(report.records);reviewed[0].sources[0].review={status:'reviewed',supports_conclusion:false,reason:'仅有背景'};assert.deepEqual(summarizeBaseline(reviewed,24).support_rate,{numerator:0,denominator:1,rate:0});
reviewed[0].sources[0].review.supports_conclusion=null;assert.equal(summarizeBaseline(reviewed,24).support_rate.denominator,0,'核查后仍未知，不能算成已证明或已否定');
assert.equal(report.summary.by_group.route.runs,8);assert.equal(report.summary.repeat_stability.length,12);
console.log('✓ 十二项两轮、分层、未来窗、检查点、本地回放、商业目录与未知费用／支持率通过');
