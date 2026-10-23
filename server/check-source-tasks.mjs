/* R1-A五项原始反例：实际采集合同、读取后重评、模型身份及主对话入参。 */
import assert from 'node:assert/strict';
import {collectTravelSources} from './lib/travel-sources.mjs';
import {relevanceReviewer,sourceId} from './lib/source-relevance.mjs';
import {conversationTurn} from './lib/conversation.mjs';
const now=Date.parse('2026-10-22T02:00:00Z');
const row=(id,title,content=title)=>({title,content,link:'https://www.xiaohongshu.com/explore/'+id,date:'2026-10-20'});
const opts={now,useCache:false};
let calls=[];
const search=async(q,options)=>{calls.push({q,...options});return [{title:q,link:'https://kazakhstan.travel/en/task',content:q,date:'2026-10-20'}];};
const task={destination:'阿拉木图',international:true,query:'阿拉木图博物馆文化体验'};
await collectTravelSources(task,search,{now,useCache:true});calls=[];
await collectTravelSources({...task,query:'阿拉木图郊外无车徒步'},search,{now,useCache:true});assert.equal(calls.length,2);assert.ok(calls.every(c=>c.q.includes('徒步')));
calls=[];const hit=await collectTravelSources({...task,query:'阿拉木图郊外无车徒步'},search,{now,useCache:true});assert.equal(hit.cache_hit,true);assert.equal(calls.length,0);
for(const purpose of ['transport','guide']){
  calls=[];await collectTravelSources({...task,purpose,query:'北京到阿拉木图官方航班时刻'},search,opts);
  assert.equal(calls.length,2);assert.ok(calls.some(c=>c.domains===null && /官方|official/.test(c.q)));assert.ok(calls.every(c=>c.q.includes('航班')));
}
calls=[];await collectTravelSources({...task,query:'前置共同条件'.repeat(10)+'博物馆'},search,opts);assert.ok(calls.every(c=>c.q.length<=100 && c.q.includes('博物馆')));
calls=[];await collectTravelSources({...task,purpose:'transport',query:'Almaty Shymbulak public transport access'},search,opts);
assert.equal(calls.length,2);assert.ok(calls.some(c=>c.domains===null && c.q.includes('public transport access')),'官方查询不得截断用户主题词');
assert.ok(calls.every(c=>!c.q.includes('transpor cess')),'英文查询不把单词拼接成无效词');
calls=[];await collectTravelSources({destination:'大阪',international:true,purpose:'guide',query:'site:line-shinkansen.jr-central.co.jp エクスプレス予約 価格改定'},search,opts);
assert.ok(calls.some(c=>c.domains===null && c.language==='ja' && c.q.includes('公式')),'日文官网查询保留日语词与语言偏好');
const model=async({user})=>{const {candidates}=JSON.parse(user);return {items:candidates.map(c=>({id:c.id,decision:/越南|露营/.test(c.title)?'reject':'keep',reason:'依据任务和正文内容判断',quote:c.title}))};};
const assessSources=relevanceReviewer(model),good=row('osaka','日本关西独旅攻略','大阪地铁与无车旅行体验'),other=row('vietnam','越南独旅行程'),camp=row('camp','北京周边露营攻略');
const related=await collectTravelSources({destination:'大阪',query:'大阪无车体验'},async()=>[good,other,camp],{...opts,assessSources});
assert.deepEqual(related.sources.map(s=>s.url),[good.link]);assert.ok(related.query_diagnostics.every(q=>q.raw_count===q.accepted_count+q.rejected_count && q.rejected_count>=0));
const ad=row('actual-ad','P人不想做旅行攻略？圆周旅迹带你出发','发现 通知 消息 关于我们 '.repeat(15)+'这个APP一键抓取全网攻略，自动整合生成专属行程。');
const promotion=await collectTravelSources({destination:'伊宁'},async()=>[ad],opts);assert.equal(promotion.sources.length,0);assert.ok(promotion.channels.every(c=>c.status==='empty'));
const afterRead=await collectTravelSources({destination:'伊宁'},async()=>[{...ad,content:'搜索摘要未读到正文',date:null}],{...opts,readPage:async url=>({url,read_status:'page_excerpt',title:ad.title,excerpt:ad.content,published_at:'2026-10-20'})});assert.equal(afterRead.sources.length,0);assert.ok(afterRead.query_diagnostics.every(q=>q.rejected_count===1 && q.task_filtered[0].stage==='page'));
const software=await collectTravelSources({destination:'伊宁',query:'旅行Apps推荐'},async()=>[ad],{...opts,assessSources});assert.equal(software.sources.length,1,'明确询问软件时不误删介绍');assert.equal(software.sources[0].kind,'guide');assert.equal(software.experiences.length,0,'软件推广可作介绍，不能在个人经验区复活');
const appInTrip=row('personal','伊宁公交亲历','我在伊宁坐公交，下载了导航App看站点，分享实际乘车感受。');assert.equal((await collectTravelSources({destination:'伊宁'},async()=>[appInTrip],opts)).sources.length,1);
const queryPlans=[{channel:'小红书探针',domain:'xiaohongshu.com',text:'site:xiaohongshu.com 体验',kinds:['experience']}];
const strict=await collectTravelSources({},async()=>[{title:'站外官方资料',link:'https://example.gov.cn/article',date:'2026-10-20'},row('valid','旅行体验')],{...opts,diagnostics:true,queryPlans});assert.equal(strict.sources.length,1);assert.equal(strict.query_diagnostics[0].rejected_count,1);
const typeMismatch=await collectTravelSources({},async()=>[{title:'站内攻略入口',link:'https://reddit.com/r/travel/wiki/guide',date:'2026-10-20'}],{...opts,queryPlans:[{...queryPlans[0],domain:'reddit.com'}]});assert.equal(typeMismatch.sources.length,0);assert.equal(typeMismatch.channels[0].status,'empty');
const official=await collectTravelSources({destination:'阿拉木图',purpose:'transport',international:true},async()=>[{title:'官方交通资料',link:'https://example.gov.cn/article',date:'2026-10-20'}],opts);assert.equal(official.sources[0].kind,'official','通用产品计划不恢复全局类型窄化');
console.log('✓ 原始五项反例、任务切换缓存、官方入口、真实推广形态、读取重评与探针口径通过');
for(const bad of [async()=>null,async()=>({items:[]}),async()=>({items:[{id:sourceId({url:good.link}),decision:'keep',reason:'无原句',quote:'虚构原句'}]})]){
  const judged=await collectTravelSources({destination:'大阪'},async()=>[good],{now,useCache:true,assessSources:relevanceReviewer(bad)});assert.equal(judged.sources.length,0);assert.equal(judged.relevance.uncertain,1);
}
let emptyModelCalls=0;
await relevanceReviewer(async()=>{emptyModelCalls++;return null;})({destination:'大阪'},[{url:good.link,title:good.title,excerpt:good.content}]);
assert.equal(emptyModelCalls,2,'HTTP成功但模型空返回仅补一次，全部调用纳入用量');
let retries=0;await collectTravelSources({destination:'大阪'},async()=>{retries++;return [good];},{now,useCache:true,assessSources});assert.equal(retries,2,'评估失败或缺项不会缓存为成功');
const duplicateReviewer=relevanceReviewer(async({user})=>{const c=JSON.parse(user).candidates[0],entry={id:c.id,decision:'keep',reason:'重复ID',quote:c.title};return {items:[entry,entry]};});assert.equal((await duplicateReviewer({destination:'大阪'},[{url:good.link,title:good.title,excerpt:good.content}])).items[0].decision,'uncertain');
const ctrl=new AbortController();const cancelled=await collectTravelSources({destination:'大阪'},async()=>[good],{...opts,signal:ctrl.signal,assessSources:async()=>{ctrl.abort();return {status:'completed',items:[]};}});assert.equal(cancelled.cancelled,true);
console.log('✓ 模型缺项、伪造原句、重复身份、失败重试与评估阶段取消通过');
const originalFetch=globalThis.fetch,keys=['TAVILY_API_KEY','TRAVEL_SEARCH_PROVIDER'],env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
try{
  process.env.TAVILY_API_KEY='source-task-test';process.env.TRAVEL_SEARCH_PROVIDER='tavily';let nativeQueries=0,reviewCalls=0,finalContext;
  globalThis.fetch=async()=>{nativeQueries++;return {ok:true,status:200,json:async()=>({results:[good,other,camp].map(s=>({url:s.link,title:s.title,content:s.content})),usage:{credits:1}})};};
  const output=()=>({intent_action:'question',reply:'根据保留的体验资料，可以先考虑市区公共交通，具体班次仍待查。',brief:{origin:'北京',destination:'大阪',summary:'大阪无车体验',wishes:[],open_questions:[]},ready:true,confirmed:false,requirements_patch:{},preferences:{},travel:{},constraints:{},sights:{},draft:null,search_query:'大阪无车体验',search_purpose:'experience',destination_country:'JP'});
  const result=await conversationTurn({text:'大阪无车怎么体验？',conversation:{stage:'discuss',brief:{origin:'北京',destination:'大阪',summary:'大阪无车体验'},routing:{origin:'北京',destination:'大阪'}}},null,{now,readPage:async url=>({url,read_status:'page_excerpt',excerpt:[good,other,camp].find(s=>s.link===url).content,published_at:'2026-10-20'}),model:async parameters=>{
    if(parameters.kind==='conversation_source_relevance'){reviewCalls++;return model(parameters);}
    const context=JSON.parse(parameters.user);if(context.search_complete)finalContext=context;
    return output();
  }});
  assert.equal(result.status,'ok');assert.equal(nativeQueries,2);assert.equal(reviewCalls,1);assert.ok(finalContext);assert.equal(result.sources.length,1);assert.equal(result.sources[0].url,good.link);
  assert.ok(!JSON.stringify(finalContext.search_results).includes('越南'));assert.ok(!JSON.stringify(finalContext.search_results).includes('露营'));assert.equal(result.source_relevance.status,'completed');
  assert.equal(result.source_relevance.reason_code,null);
  const failedReview=await conversationTurn({text:'再核对一次大阪无车资料，只讨论不改行程',conversation:{stage:'discuss',brief:{origin:'北京',destination:'大阪',summary:'大阪无车体验'},routing:{origin:'北京',destination:'大阪'}}},null,{now,readPage:async url=>({url,read_status:'page_excerpt',excerpt:[good,other,camp].find(s=>s.link===url).content,published_at:'2026-10-20'}),model:async parameters=>parameters.kind==='conversation_source_relevance'?null:output()});
  assert.equal(failedReview.status,'ok');assert.equal(failedReview.sources.length,0);assert.equal(failedReview.source_relevance.status,'unavailable');assert.match(failedReview.reply,/相关性核对/,'模型筛选故障必须如实显示，不被写成检索零结果');
}finally{globalThis.fetch=originalFetch;for(const key of keys)if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}
console.log('✓ 用户输入→实际Tavily适配→同一预算模型审查→最终整合输入的端到端合同通过');
