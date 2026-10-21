/* 验证真实适配出口与HTTP读取链路，不消耗联网服务额度。 */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import https from 'node:https';
import {readFileSync,mkdtempSync,existsSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {searchWeb,searchWebDetailed} from './lib/llm.mjs';
import {readPublicPage} from './lib/public-reader.mjs';
import {collectTravelSources} from './lib/travel-sources.mjs';
import {webSearchConfigured} from './lib/trip-service.mjs';
import {runSourceBaseline,baselinePlan} from './lib/source-baseline.mjs';
import {compareSourceBaselines,diagnoseBaselineReads} from './lib/source-comparison.mjs';
const originalFetch=globalThis.fetch,keys=['TAVILY_API_KEY','TRAVEL_SEARCH_PROVIDER','VOLC_SEARCH_API_KEY'],env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
let calls=[];
try{
  delete process.env.TAVILY_API_KEY;
  globalThis.fetch=async()=>{throw Error('未配置不得调用');};
  const absent=await searchWebDetailed('公开任务',{provider:'tavily'});assert.equal(absent.status,'unconfigured');assert.equal(absent.network_requests,0);
  assert.equal(webSearchConfigured({TRAVEL_SEARCH_PROVIDER:'tavily',VOLC_SEARCH_API_KEY:'test'}).configured,false);
  assert.equal(webSearchConfigured({TRAVEL_SEARCH_PROVIDER:'tavily',TAVILY_API_KEY:'test'}).basis,'tavily');
  assert.equal(webSearchConfigured({TRAVEL_SEARCH_PROVIDER:'错误',VOLC_SEARCH_API_KEY:'test'}).configured,false);
  process.env.TAVILY_API_KEY='test-key';process.env.TRAVEL_SEARCH_PROVIDER='tavily';
  globalThis.fetch=async(url,opts)=>{calls.push({url,opts});return {ok:true,status:200,json:async()=>({answer:'不应采用的生成答案',results:[
    {url:'http://localhost/private',content:'不应访问'},
    {url:'https://reddit.com/r/travel/comments/1',title:'Almaty',content:'个人旅行经验',raw_content:'不应采用的正文',published_date:'Tue, 20 Oct 2026 01:00:00 GMT'},
    {url:'https://reddit.com/r/travel/comments/1',title:'重复结果'}],usage:{credits:0}})};};
  const available=await searchWebDetailed('site:reddit.com Almaty travel',{language:'en',run_id:'adapter-test'});
  assert.equal(available.provider,'tavily');assert.equal(available.results.length,1);assert.equal(available.results[0].date,null);assert.equal(available.results[0].date_basis,'provider_estimate');assert.ok(available.results[0].estimated_date);assert.equal(available.attempts[0].usage.api_credits,0);assert.equal(available.cost.amount,null);
  assert.equal(calls[0].url,'https://api.tavily.com/search');assert.equal(calls[0].opts.redirect,'error');
  const body=JSON.parse(calls[0].opts.body);assert.deepEqual(body.include_domains,['reddit.com']);assert.equal(body.include_domains_mode,'restrict');assert.equal(body.language,'en');assert.equal(body.include_answer,false);assert.equal(body.include_raw_content,false);assert.equal(body.auto_parameters,false);
  assert.ok(!JSON.stringify(available).includes('test-key'));assert.ok(!JSON.stringify(available).includes('不应采用'));
  await collectTravelSources({purpose:'experience'},searchWeb,{useCache:false,now:Date.parse('2026-10-20T02:00Z'),queryPlans:[{channel:'真实出口',domain:'reddit.com',text:'Almaty travel',kinds:['experience'],language:'en'}]});
  const forwarded=JSON.parse(calls.at(-1).opts.body);assert.deepEqual(forwarded.include_domains,['reddit.com']);assert.equal(forwarded.language,'en','来源采集把实际域名和语言送入选中的服务');
  const collected=await collectTravelSources({purpose:'transport'},async()=>available.results,{now:Date.parse('2026-10-20T02:00Z'),useCache:false,queryPlans:[{channel:'测试',domain:'reddit.com',text:'测试',kinds:['experience']}],readPage:async()=>({read_status:'unavailable'})});
  assert.equal(collected.sources.length,0);assert.equal(collected.archive[0].temporal.state,'undated');assert.equal(collected.archive[0].estimated_date_basis,'provider_estimate');
  const cancelled=new AbortController();cancelled.abort();const count=calls.length;assert.equal((await searchWebDetailed('取消',{signal:cancelled.signal})).network_requests,0);assert.equal(calls.length,count);
  globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({results:[],usage:{credits:1}})});assert.equal((await searchWebDetailed('零匹配')).status,'empty');
  globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({results:[{url:'file:///private'}]})});assert.equal((await searchWebDetailed('仅无效链接')).status,'filtered');
  globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({results:'错误格式'})});assert.equal((await searchWebDetailed('格式错误')).status,'error');
  let started=0;
  globalThis.fetch=async()=>{started++;return {ok:false,status:432,json:async()=>{throw Error('不应记录的原始错误');}};};
  const quota=await searchWebDetailed('额度'),skip=await searchWebDetailed('冷却');assert.equal(quota.status,'quota_exhausted');assert.equal(skip.status,'unavailable');assert.equal(skip.attempts[0].status,'skipped');assert.equal(started,1,'Tavily失败不暗中调用火山或公开索引');
  process.env.TAVILY_API_KEY='rate-test';globalThis.fetch=async()=>({ok:false,status:429});assert.equal((await searchWebDetailed('限速')).status,'rate_limited');
  process.env.TAVILY_API_KEY='auth-test';globalThis.fetch=async()=>({ok:false,status:401});assert.equal((await searchWebDetailed('鉴权')).status,'unauthorized');
  process.env.TAVILY_API_KEY='timeout-test';globalThis.fetch=async()=>{throw new DOMException('超时','TimeoutError');};assert.equal((await searchWebDetailed('超时')).status,'timeout');
  process.env.VOLC_SEARCH_API_KEY='test';let selected;
  globalThis.fetch=async(url)=>{selected=url;return {ok:true,status:200,json:async()=>({status:'completed',usage:{tool_usage:{web_search:1}},output:[{type:'web_search_call',status:'completed'},{content:[{annotations:[{type:'url_citation',url:'https://example.org/article'}]}]}]})};};
  assert.equal((await searchWebDetailed('保持现有通道',{provider:'current'})).provider,'volc-search');assert.ok(selected.includes('volces.com'));
}finally{globalThis.fetch=originalFetch;for(const k of keys)if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}
console.log('✓ Tavily真实出口、选择与配置、限定域名、估计日期隔离、计费点及失败停止通过');
const originalGet=https.get,publicResolve=async()=>[{address:'93.184.216.34',family:4}];
let responses=[],requested=[];
const mock=(status=200,body='<article>'+('公开旅行内容'.repeat(20))+'</article>',headers={'content-type':'text/html'})=>({status,body,headers});
https.get=(url,options,receive)=>{
  requested.push({url:url.href,options});const req=new EventEmitter();
  queueMicrotask(()=>{
    const spec=responses.shift() || mock(),res=new EventEmitter();res.statusCode=spec.status;res.headers=spec.headers;res.resume=()=>{};res.destroy=()=>{};
    if(spec.hang){options.signal.addEventListener('abort',()=>req.emit('error',new DOMException('取消','AbortError')),{once:true});return;}
    receive(res);if(spec.status===200 && /html/.test(spec.headers['content-type'] || '')){res.emit('data',Buffer.from(spec.body));res.emit('end');}
  });return req;
};
try{
  for(const status of [202,403,404,429,503]){responses=[mock(status)];const result=await readPublicPage('https://example.org/article',{resolve:publicResolve});assert.equal(result.reason_code,'http_'+status);assert.equal(result.diagnostics.http_status,status);assert.equal(result.diagnostics.phase,'http');}
  responses=[mock(200,'非HTML',{'content-type':'application/json'})];assert.equal((await readPublicPage('https://example.org/article',{resolve:publicResolve})).reason_code,'non_html');
  responses=[mock(200,'<title>安全验证</title>'+('验证'.repeat(60)))];assert.equal((await readPublicPage('https://example.org/article',{resolve:publicResolve})).reason_code,'verification_required');
  responses=[mock(200,'<title>登录</title><input type="password">'+('请登录'.repeat(30)))];assert.equal((await readPublicPage('https://example.org/article',{resolve:publicResolve})).reason_code,'login_required');
  responses=[mock(200,'<article>很短</article>')];assert.equal((await readPublicPage('https://example.org/article',{resolve:publicResolve})).reason_code,'empty_body');
  responses=[mock()];assert.equal((await readPublicPage('https://example.org/article',{resolve:publicResolve,maxBytes:8})).reason_code,'body_too_large');
  responses=[mock()];const page=await readPublicPage('https://example.org/article',{resolve:publicResolve});assert.equal(page.read_status,'page_excerpt');assert.equal(page.diagnostics.phase,'complete');assert.equal(page.published_at,null);
  let pinned;requested.at(-1).options.lookup('example.org',{all:true},(_error,addresses)=>pinned=addresses);assert.equal(pinned[0].address,'93.184.216.34');assert.equal(requested.at(-1).options.agent,false);
  responses=[mock(302,'',{location:'http://localhost/private'})];const before=requested.length;assert.equal((await readPublicPage('https://example.org/article',{resolve:publicResolve})).reason_code,'unsafe_url');assert.equal(requested.length,before+1);
  const unsafe=await readPublicPage('https://example.org/article',{resolve:async()=>[{address:'10.0.0.1',family:4}]});assert.equal(unsafe.reason_code,'unsafe_address');assert.equal(requested.length,before+1);
  const dns=await readPublicPage('https://example.org/article',{resolve:async()=>{throw Error('包含私密的原始错误');}});assert.equal(dns.reason_code,'dns_error');assert.ok(!JSON.stringify(dns).includes('私密'));
  responses=[{...mock(),hang:true}];const timed=await readPublicPage('https://example.org/article',{resolve:publicResolve,timeoutMs:5});assert.equal(timed.reason_code,'timeout');
  const ctrl=new AbortController();ctrl.abort();assert.equal((await readPublicPage('https://example.org/article',{resolve:publicResolve,signal:ctrl.signal})).reason_code,'cancelled');
}finally{https.get=originalGet;}
console.log('✓ 实际HTTP链路状态、非正文、登录验证、大小／超时、DNS固定与重定向边界通过');
const dataset=JSON.parse(readFileSync(new URL('../pipeline/data/source-baseline-tasks.json',import.meta.url),'utf8')),now=Date.parse('2026-10-20T02:00Z');
const fixture=await runSourceBaseline(dataset,{now,repeat:1,search:async(query,options)=>({status:'empty',results:[],attempts:[],elapsed_ms:1}),readPage:async()=>null});
const right=structuredClone(fixture);right.run_id='右侧运行';right.provider='tavily';assert.equal(compareSourceBaselines(fixture,right).delta.domain_hit_queries,0);
assert.equal(compareSourceBaselines(fixture,fixture).status,'same_run_replay');
const changed=structuredClone(right);changed.records[0].query+='x';assert.throws(()=>compareSourceBaselines(fixture,changed));
const partial=structuredClone(right);partial.records.pop();assert.throws(()=>compareSourceBaselines(fixture,partial));
const duplicate=structuredClone(right);duplicate.records[0]=duplicate.records[1];assert.throws(()=>compareSourceBaselines(fixture,duplicate));
const unconfigured=structuredClone(right);unconfigured.records[0].searches[0].status='unconfigured';assert.throws(()=>compareSourceBaselines(fixture,unconfigured));
const wrongRound=structuredClone(right);wrongRound.records[0].repeat=3;assert.throws(()=>compareSourceBaselines(fixture,wrongRound));
assert.throws(()=>compareSourceBaselines(fixture,{...right,frozen_at:'2026-10-21T02:00Z'}));assert.throws(()=>compareSourceBaselines(fixture,{...right,dataset_sha256:'a'.repeat(64)}));
assert.throws(()=>compareSourceBaselines(fixture,{...right,measurement_profile:'other-reader-budget'}));
const readFixture={schema_version:1,run_id:'原始运行',records:[{task_id:'固定任务',repeat:1,reads:[{url:'https://example.org/article'}]}]};
const diagnosed=await diagnoseBaselineReads(readFixture,{readPage:async()=>({url:'https://example.org/other',read_status:'page_excerpt',diagnostics:{http_status:200}})});assert.equal(diagnosed.summary.read_success,0);assert.equal(diagnosed.summary.by_reason.identity_mismatch,1);assert.equal(readFixture.records[0].reads[0].status,undefined,'诊断不续写旧来源与原始报告');
console.log('✓ 同数据集／日期／查询及完整性对照、读取诊断身份和原始记录保护通过');
const directory=mkdtempSync(join(tmpdir(),'mixtouring-adapter-')),output=join(directory,'report.json'),childEnv={...process.env,SOURCE_BASELINE_OUT:output};delete childEnv.TAVILY_API_KEY;
try{
  const absent=spawnSync(process.execPath,['server/baseline-sources.mjs','--live','--provider','tavily'],{env:childEnv,encoding:'utf8'});assert.equal(absent.status,1);assert.ok(absent.stderr.includes('Tavily未配置'));assert.equal(existsSync(output),false,'缺少密钥时不落零命中报告');
  writeFileSync(output,JSON.stringify(fixture));
  const alias=process.platform==='win32'?output.toUpperCase():output;
  const protectedInput=spawnSync(process.execPath,['server/baseline-sources.mjs','--diagnose-reads',alias],{env:childEnv,encoding:'utf8'});assert.equal(protectedInput.status,1);assert.ok(protectedInput.stderr.includes('不能覆盖'));assert.equal(readFileSync(output,'utf8'),JSON.stringify(fixture));
}finally{if(existsSync(output))unlinkSync(output);rmdirSync(directory);}
console.log('✓ CLI未配置提前停止、无伪造零命中报告与输入路径保护通过');
