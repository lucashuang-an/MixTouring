/* 搜索规划的实际模块回归；资料、模型和地图故障均为合成 fixture，无付费调用。 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planSearchFirst} from './lib/search-planner.mjs';
import {progressivePlan} from './lib/progressive.mjs';
import {buildRouteComparison} from './lib/route-comparison.mjs';
import {buildJourneyDetail} from './lib/journey.mjs';
import {researchLoopTask,researchLoopSignature,planFitsTask} from './lib/research-loop.mjs';

const now=Date.parse('2026-10-25T00:00:00Z');
const input={origin:'北京',destination:'曼谷',location_context:'从北京去泰国的曼谷 Bangkok, Thailand，十五天环线回北京，日期待定',travel:{trip_type:'round_trip'}};
const row={title:'北京 河内 曼谷旅行路线记录',link:'https://example.org/travel/sea',content:'这篇记录讨论从北京经河内去曼谷的旅行方向，各段实际连接需要另查。'};
const normalized={origin:{name:'北京',name_latin:'Beijing',country:'CN',kind:'city'},destination:{name:'曼谷',name_latin:'Bangkok Thailand',country:'TH',kind:'city'}};
function fixture({routes=null,reject=false,empty=false,date=null,routeDecision='keep'}={}){
  const calls={models:[],queries:[]};
  const model=async options=>{
    calls.models.push(options.kind);const data=JSON.parse(options.user);
    if(options.kind==='search_plan_places'){assert.match(data.location_context,/Bangkok, Thailand/);return normalized;}
    if(options.kind==='conversation_source_relevance')return {items:data.candidates.map(s=>({id:s.id,decision:reject?'reject':'keep',quote:s.title,reason:reject?'无关':'本次方向的旅行资料'}))};
    if(options.kind==='search_plan_route_check')return {items:data.candidates.map(c=>({id:c.id,decision:routeDecision,reason:'核对资料方向及用户意图'}))};
    assert.equal(options.kind,'search_plan_routes');
    assert.ok(!options.schema_prompt.includes('已收录'));
    const source=data.sources[0] || {id:''};
    return {routes:routes?routes(source):[{stops:[],source_ids:[source.id]},
      {stops:[{name:'河内',name_latin:'Hanoi',country:'VN',source_id:source.id,quote:'从北京经河内去曼谷'}],source_ids:[source.id]}]};
  };
  return {calls,deps:{nowMs:now,composeJson:model,osmSearch:async()=>{throw Error('地图通道故障不能阻断探索');},searchWeb:async(q,options)=>{calls.queries.push({q,...options});return empty?[]:[{...row,date}];}}};
}
const f=fixture(),plan=await planSearchFirst(input,f.deps);
assert.equal(plan.status,'ok');assert.equal(plan.planning_mode,'search_first');
assert.equal(f.calls.queries.length,2);assert.ok(f.calls.queries.some(q=>q.q.includes('Bangkok Thailand')));
assert.equal(plan.candidates.length,2);assert.deepEqual(plan.candidates[1].legs.map(l=>l.to),['河内','曼谷'],'库外途经城市不能被旧名单过滤');
assert.ok(plan.candidates.every(c=>c.builder==='search+llm' && c.legs.every(l=>l.mode_guess===null && l.evidence_state==='explore' && l.sources.length===0)));
assert.ok(plan.places.every(p=>p.country===null && p.lat===null && p.lon===null && p.resolution_state==='unverified'),'模型检索提示不能写成地理事实');
assert.equal(plan.places.find(p=>p.name==='曼谷').country_hint,'TH');
assert.equal(plan.intent.outbound_window,null);assert.equal(plan.intent.return_window,null,'十五天不生成日期');
const again=await planSearchFirst(input,fixture().deps);assert.deepEqual(again.candidates.map(c=>c.id),plan.candidates.map(c=>c.id),'相同结构稳定ID');
for(const routeDecision of ['reject','uncertain']){
  const r=await planSearchFirst(input,fixture({routeDecision}).deps);
  assert.equal(r.candidates.length,2);assert.equal(r.candidates[0].kind,'direct','探索方向不再由第二个模型机械否决');
}
const comparison=buildRouteComparison(plan,{now,requirements:{trip_days:15}});
assert.equal(comparison.routes.length,2,'比较页不能再次用内置体验名单隐藏河内');
assert.ok(comparison.routes.every(r=>r.points.every(p=>p.lat===null && p.lon===null)));
assert.ok(comparison.routes.every(r=>!r.verified && r.cost.grade==='unpriced'));
assert.ok(buildRouteComparison(plan,{now,requirements:{verified_cross_border_only:true}}).routes.every(r=>r.verification_required),'未知国家不能绕过跨境核实要求');
assert.equal(plan.candidates[0].basis.sources.length,0,'用户方向基准不能拿网页假装直达证明');
const history=await planSearchFirst(input,fixture({date:'2025-01-01'}).deps);
assert.equal(history.candidates.length,2,'历史资料可经相关性核对提出探索结构');
assert.ok(history.candidates[1].basis.sources.every(s=>s.temporal.state==='historical' && s.allowed_use==='exploration_only'));
const detail=buildJourneyDetail(plan,plan.candidates[1].id);
assert.equal(detail.inbound[0].from,'曼谷');assert.equal(detail.inbound[0].to,'北京');
assert.equal(detail.inbound[0].mode_guess,null);assert.equal(detail.inbound[0].sources.length,0);assert.equal(detail.transport_references.length,0,'新详情不注入旧客运参考');
for(const options of [{reject:true},{empty:true}]){const r=await planSearchFirst(input,fixture(options).deps);assert.equal(r.candidates.length,2);assert(r.candidates.every(c=>c.legs.every(l=>l.evidence_state==='explore')));}
const unsupported=await planSearchFirst(input,fixture({routes:s=>[{stops:[{name:'万象',source_id:s.id,quote:'捏造万象原句'}],source_ids:[s.id]}]}).deps);
assert.equal(unsupported.candidates.length,1);assert.deepEqual(unsupported.candidates[0].basis.node_quotes,[],'保留候选但不接受伪造引用');
const invented=await planSearchFirst(input,fixture({routes:()=>[{stops:[],source_ids:['fabricated']}]}).deps);assert.equal(invented.candidates.length,1);assert.deepEqual(invented.candidates[0].basis.sources,[]);
const duplicate=await planSearchFirst(input,fixture({routes:s=>[{stops:[{name:'北京',source_id:s.id,quote:'从北京经河内去曼谷'}],source_ids:[s.id]}]}).deps);assert.equal(duplicate.candidates.length,0);
assert(!f.calls.models.includes('conversation_source_relevance'));assert(!f.calls.models.includes('search_plan_route_check'));
let searches=0;
const noModel=await planSearchFirst(input,{composeJson:async()=>null,searchWeb:async()=>{searches++;return [row];}});
assert.equal(noModel.status,'unavailable');assert.equal(noModel.candidates.length,0);assert.equal(searches,0,'模型失败不冒充规则规划成功');
const country=await planSearchFirst({...input,destination:'泰国'},fixture().deps);assert.equal(country.status,'needs_intent');
const forged=await planSearchFirst({...input,confirmed_places:{destination:{name:'曼谷',country:'TH',lat:1,lon:1}}},fixture().deps);
assert.equal(forged.status,'ok');assert.equal(forged.intent.destination_place.country,null);assert.equal(forged.intent.destination_place.lat,null,'客户端旧确认字段及坐标不参与新规划事实');
const anchored=await planSearchFirst({...input,anchors:{outbound:{mode:'plane',date:'2026-12-01',from_city:'北京',to_city:'清迈'}}},fixture().deps);
assert.equal(anchored.anchors.outbound.to_city,'清迈');assert.equal(anchored.candidates[0].legs[0].from,'清迈','库外锚点按用户输入保留，不要求旧名单');

const events=[],p=fixture();
const progressive=await progressivePlan(input,(data,phase)=>events.push({data,phase}),{...p.deps,callJson:async()=>{throw Error('新链路不得走旧模型通道');}});
assert.equal(progressive.status,'ok');assert.deepEqual(events.map(e=>e.phase),['base','complete']);
assert.equal(events[0].data.candidates.length,0,'进度不能伪造规则候选');assert.equal(progressive.discovery_metrics.model_calls,2);assert.equal(progressive.discovery_metrics.search_calls,2);
const controller=new AbortController(),cancelEvents=[],cancelled=fixture();
await progressivePlan(input,(_,phase)=>{cancelEvents.push(phase);controller.abort();},cancelled.deps,controller.signal);
assert.deepEqual(cancelEvents,['base']);assert.equal(cancelled.calls.queries.length,0);
const slow=fixture(),timed=await progressivePlan(input,()=>{},{...slow.deps,budgetMs:10,searchWeb:async()=>new Promise(r=>setTimeout(()=>r([]),40))});
assert.equal(timed.discovery_metrics.budget_exhausted,true);assert.equal(timed.candidates.length,0);

const task=researchLoopTask({question:'清迈不骑摩托怎么玩',gap:'无车玩法待查',task_type:'experience',destination:'清迈',places:[{name:'清迈',name_latin:'Chiang Mai',country_hint:'TH'}]},now);
assert.equal(task.international,true);assert.ok(planFitsTask({query:'',foreign_query:'Chiang Mai no motorbike'},task));
const jp=researchLoopTask({question:'东京到大阪怎么走',gap:'交通待查',task_type:'transport',leg:{from:'东京',to:'大阪'},places:[{name:'东京',country_hint:'JP'},{name:'大阪',country_hint:'JP'}]},now);
assert.equal(jp.international,true,'国外同国段仍查国外资料');
const unknown=researchLoopTask({question:'某城到另一城怎么走',gap:'交通待查',task_type:'transport',leg:{from:'某城',to:'另一城'}},now);assert.equal(unknown.international,true);
const changed={...task,places:[{name:'清迈',name_latin:'Another query',country_hint:'TH'}]};
assert.notEqual(researchLoopSignature(task),researchLoopSignature(changed),'检索别名变更使恢复身份失效');

/* 当前模型出口实走HTTP适配桩：仅组合key有效，旧LLM无配置；不替换composeJson函数。 */
const keys=['VOLC_SEARCH_API_KEY','VOLC_COMPOSE_MODEL','TRAVEL_SEARCH_PROVIDER','TAVILY_API_KEY'],saved=keys.map(k=>process.env[k]),originalFetch=globalThis.fetch;
try{
  process.env.VOLC_SEARCH_API_KEY='search-planner-fixture';process.env.VOLC_COMPOSE_MODEL='fixture-compose';
  process.env.TRAVEL_SEARCH_PROVIDER='tavily';process.env.TAVILY_API_KEY='fixture-tavily';
  const real=fixture();let httpModel=0,httpSearch=0;
  globalThis.fetch=async(url,opts)=>{
    if(String(url).includes('tavily.com')){httpSearch++;return {ok:true,status:200,json:async()=>({results:[{url:row.link,title:row.title,content:row.content}],usage:{credits:1}})};}
    assert.match(String(url),/ark\.cn-beijing\.volces\.com/);httpModel++;
    const body=JSON.parse(opts.body);assert.deepEqual(body.thinking,{type:'disabled'});
    const kind=body.messages[0].content.includes('每个来源ID')?'conversation_source_relevance':body.messages[0].content.includes('没有地点白名单')?'search_plan_places':body.messages[0].content.startsWith('核对路线结构')?'search_plan_route_check':'search_plan_routes';
    const output=await real.deps.composeJson({kind,user:body.messages[1].content,schema_prompt:body.messages[0].content});
    return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify(output)}}],usage:{total_tokens:0}})};
  };
  const result=await progressivePlan(input,()=>{},{nowMs:now});assert.equal(result.status,'ok');assert.equal(httpModel,2);assert.equal(httpSearch,2);
}finally{globalThis.fetch=originalFetch;keys.forEach((k,i)=>saved[i]===undefined?delete process.env[k]:process.env[k]=saved[i]);}
const html=readFileSync(new URL('../mixtouring-hifi/pages/trip.html',import.meta.url),'utf8');
assert.ok(html.includes("fetch('/api/anywhere/search-plan'"));
console.log('✓ 搜索规划：库外端点与途中城市、上下文、来源绑定、未知地图、比较/详情、模型失败、预算取消、涉外范围及当前组合HTTP出口通过');

const coveredInput={...input,travel:{trip_type:'one_way'},anchors:{outbound:{mode:'plane',date:'2026-12-01',from_city:'北京',to_city:'曼谷'}}};
const covered=await planSearchFirst(coveredInput,fixture().deps);assert.equal(covered.status,'ok');assert.equal(covered.anchors.full_cover,true);assert.equal(covered.anchors.return,null);assert.equal(covered.candidates.length,0,'不为已覆盖单程伪造新交通');
const incompleteRound=await planSearchFirst({...coveredInput,travel:{trip_type:'round_trip'}},fixture().deps);assert.notEqual(incompleteRound.anchors.full_cover,true,'未定返程不冒充全程覆盖');
