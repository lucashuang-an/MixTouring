/* 九轮实测故障的实际编排回归。合成工具结果只用于测试，不进入产品数据。 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {conversationTurn,cleanConversation} from './fixtures/confirmed-conversation.mjs';
import {decodeModelJson} from './lib/llm.mjs';
import {relevanceReviewer} from './lib/source-relevance.mjs';
import {searchDeepSeek} from './lib/search-deepseek.mjs';
import {resolveMapPlaces} from './lib/map-places.mjs';
import {planSearchFirst} from './lib/search-planner.mjs';
import {groundConversationOutput} from './lib/conversation-evidence.mjs';
import {buildEvidenceCatalog} from './lib/evidence-grounding.mjs';
import workspace from '../mixtouring-hifi/assets/route-workspace.js';

const brief={origin:'北京',destination:'阿拉木图',summary:'沿途与目的地体验',wishes:[],open_questions:[]};
const before=cleanConversation({stage:'ready',brief,routing:{origin:'北京',destination:'阿拉木图'},requirements:{trip_days:10,required_stops:['伊宁']}});
const output=extra=>({intent_action:'discuss',reply:'可以安排沿途散步与目的地活动。',brief,ready:true,confirmed:false,requirements_patch:{},preferences:{},travel:{},constraints:{},sights:{},...extra});
const noSearch=async()=>[];

// X6：没有旧草案也能比较条件；失败或采纳之前不能修改当前旅行。
const preview=await conversationTurn({text:'如果只有7天呢？',conversation:before},null,{search:noSearch,model:async()=>output({intent_action:'preview',requirements_patch:{trip_days:7},draft:null})});
assert.equal(preview.status,'ok');assert.equal(preview.conversation.requirements.trip_days,10);
assert.equal(preview.conversation.preview.requirements.trip_days,7);assert.equal(preview.conversation.preview.kind,'conditions');
assert.equal(cleanConversation(preview.conversation).preview.kind,'conditions');assert.equal(preview.conversation.revision,0);
const adopted=await conversationTurn({action:'accept_preview',conversation:preview.conversation});
assert.equal(adopted.status,'ok');assert.equal(adopted.conversation.requirements.trip_days,7);assert.equal(adopted.conversation.draft,null);
const discarded=await conversationTurn({action:'discard_preview',conversation:preview.conversation});
assert.equal(discarded.conversation.requirements.trip_days,10);assert.equal(discarded.conversation.preview,null);
const stale=await conversationTurn({action:'accept_preview',conversation:{...preview.conversation,requirements:{...before.requirements,trip_days:12}}});
assert.equal(stale.status,'unavailable','条件变化后不能采纳旧预览');

// X3：文档操作与真实条件授权分开；核对器也不能扩写主模型没有提出的字段。
const question=await conversationTurn({text:'先不生成。10天含往返，8000元含全部交通，不自驾。',conversation:before},null,{search:noSearch,model:async opts=>{
  if(opts.kind==='conversation_calendar')return {travel:{trip_type:'round_trip'}};
  if(opts.kind==='conversation_condition_update')return {requirements_patch:{trip_days:10},travel:{trip_type:'round_trip'},constraints:{budget_max_cny:8000,no_self_drive:true,max_transfers:0},preferences:{}};
  return output({intent_action:'question',requirements_patch:{trip_days:10},travel:{trip_type:'round_trip'},constraints:{budget_max_cny:8000,no_self_drive:true}});
}});
assert.equal(question.status,'ok');assert.equal(question.patch.travel.trip_type,'round_trip');assert.equal(question.patch.constraints.no_self_drive,true);
assert.equal(question.patch.constraints.max_transfers,undefined);assert.equal(question.conversation.draft,null);assert.equal(question.request_generation,false);
const refused=await conversationTurn({text:'先比较，不采用这些变化',conversation:before},null,{search:noSearch,model:async opts=>opts.kind==='conversation_condition_update'?{}:output({intent_action:'question',requirements_patch:{trip_days:7},constraints:{no_self_drive:false}})});
assert.equal(refused.conversation.requirements.trip_days,10);assert.deepEqual(refused.patch.constraints,{});

// X4/X5：无匹配候选也可基于用户确认的结构正式成稿，完整逐日覆盖。
const draft={title:'沿途与阿拉木图十日建议',overview:'沿途停留后，把目的地散步与休息交替安排。',route:['北京','伊宁','阿拉木图'],
  cards:Array.from({length:10},(_,i)=>({id:'card-day-'+(i+1),place:i<2?'伊宁':'阿拉木图',label:'第'+(i+1)+'天',title:'自由探索',content:'安排散步、用餐和休息时间。'})),sections:[],pending:['内部交通补查任务']};
const trace=[];
const generated=await conversationTurn({action:'generate',conversation:before,travel:{trip_type:'round_trip'},constraints:{no_self_drive:true}},null,{search:noSearch,evidenceReview:true,onTrace:e=>trace.push(e),model:async opts=>{
  if(opts.kind==='conversation_evidence_extract')return {items:JSON.parse(opts.user).fields.map(f=>({id:f.id,text:f.text,needs_source:false,allowed_use:null,supports:[]}))};
  if(opts.kind==='conversation_review')return {reply:'已整理好每日建议。',draft,changes:[]};
  return output({draft});
}});
assert.equal(generated.status,'ok');assert.equal(generated.conversation.stage,'draft');assert.equal(generated.conversation.draft.cards.length,10);
assert.deepEqual(workspace.dayCoverage(generated.conversation.draft,10).missing,[]);
assert.ok(trace.some(e=>e.stage==='conversation' && e.status==='started'));assert.ok(trace.some(e=>e.stage==='conversation' && e.status==='completed'));
assert.doesNotMatch(JSON.stringify({...generated.conversation.draft,pending:[]}),/待查|待核实|待考证|不确定|不支持/);

// 上午/下午是安排决策，用户不自驾是条件；来源只需支持真正的地点事实。
const atomicCatalog=buildEvidenceCatalog({sources:[{url:'https://example.org/museum',title:'测试艺术馆',excerpt:'测试艺术馆位于阿拉木图。',published_at:'2026-10-26',kind:'guide'}],now:Date.parse('2026-10-27')});
const atomicDraft={...draft,cards:[{id:'card-a',place:'阿拉木图',label:'第1天',title:'城市文化',content:'上午参观测试艺术馆，下午休息。'}],sections:[{title:'出行方式',content:'全程不自驾。'}],pending:[]};
let factualChecks=0;
const atomicModel=async opts=>{
  const p=JSON.parse(opts.user);
  if(opts.kind==='conversation_evidence_extract'){
    assert.equal(p.output_use,'proposed_itinerary');assert.equal(p.planning_conditions.current.constraints.no_self_drive,true);
    return {items:p.fields.map(f=>({id:f.id,text:f.text,needs_source:f.text.includes('测试艺术馆'),assertions:f.text.includes('测试艺术馆')?[{text:'测试艺术馆',allowed_use:'source_reference',supports:[{source_id:p.evidence_catalog.entries[0].id,quote:'测试艺术馆位于阿拉木图。'}]},...(f.text.includes('门票免费')?[{text:'门票免费',allowed_use:'source_reference',supports:[]}]:[])]:[]}))};
  }
  if(opts.kind==='conversation_evidence_support'){factualChecks++;assert.ok(p.claims.every(c=>c.claim.text==='测试艺术馆'));return {items:p.claims.map(c=>({id:c.id,decision:'supported',relation:'supports',reason:'原文支持该地点'}))};}
  return null;
};
const atomic=await groundConversationOutput({reply:'已整理每日建议。',draft:atomicDraft,catalog:atomicCatalog,model:atomicModel,deliveryMode:true,conditions:{current:{constraints:{no_self_drive:true}}}});
assert.equal(atomic.status,'complete');assert.equal(atomic.draft.cards[0].content,atomicDraft.cards[0].content);assert.equal(factualChecks,1);
const inventedFree=await groundConversationOutput({reply:'已整理每日建议。',draft:{...atomicDraft,cards:[{...atomicDraft.cards[0],content:'上午参观测试艺术馆，门票免费。'}]},catalog:atomicCatalog,model:atomicModel,deliveryMode:true,conditions:{current:{constraints:{no_self_drive:true}}}});
assert.equal(inventedFree.status,'unavailable','安排语境不能掩盖无依据免费断言');

// 明确核实进入真实有界研究执行器；任务已完成时不额外展开普通双搜索。
const stages=[];
const research=await conversationTurn({text:'只核实伊宁到阿拉木图的跨境交通',conversation:before},null,{search:async()=>{throw Error('规划器决定结束时不应搜索');},model:async opts=>{
  stages.push(opts.kind);
  if(opts.kind==='research_loop_plan')return {done:true};
  return output({intent_action:'question',research_request:{task_type:'transport',gap:'跨境连接资料',leg:{from:'伊宁',to:'阿拉木图',mode:'road'}}});
}});
assert.equal(research.status,'ok');assert.equal(stages.filter(k=>k==='research_loop_plan').length,1);

// 来源内容过滤不原样补试；空响应可按明确原因补试一次。
let filteredCalls=0;
const filtered=await relevanceReviewer(async opts=>{filteredCalls++;return decodeModelJson({choices:[{finish_reason:'content_filter',message:{content:'拒答'}}]},opts);})({purpose:'transport'},[{url:'https://example.org/a',title:'交通',excerpt:'资料'}]);
assert.equal(filteredCalls,1);assert.equal(filtered.reason_code,'content_filter');
let emptyCalls=0;
await relevanceReviewer(async opts=>{emptyCalls++;return decodeModelJson({choices:[{finish_reason:'stop',message:{content:''}}]},opts);})({},[]);
assert.equal(emptyCalls,2);
let failure;
assert.equal(decodeModelJson({choices:[{finish_reason:'length',message:{content:'{"x":1}'}}]},{onFailure:e=>failure=e}),null);
assert.equal(failure.reason_code,'output_truncated');

// DeepSeek独立搜索的真实适配请求；凭据为合成值，不联网。
let searched=0;
const results=await searchDeepSeek('伊宁 阿拉木图 交通',{key:'synthetic-test-key',language:'zh',domains:['example.org'],fetchImpl:async(url,opts)=>{
  searched++;assert.equal(url,'https://api.deepseek.com/v1/tools/search');assert.equal(opts.headers.authorization,'Bearer synthetic-test-key');
  const payload=JSON.parse(opts.body);assert.match(payload.query,/lang:zh/);assert.match(payload.query,/site:example.org/);assert.equal(payload.need_content,false);
  return {ok:true,status:200,json:async()=>({results:[{url:'https://example.org/a',title:'交通资料',summary:'中文搜索摘录',date:'2026-10-26'},{url:'https://noise.invalid/a',title:'跑题'}]})};
}});
assert.equal(searched,1);assert.equal(results.length,1);assert.equal(results[0].date_basis,'search_index');
assert.equal(await searchDeepSeek('交通',{key:'',fetchImpl:async()=>{throw Error('缺key不联网');}}),null);

// 地图坐标只来自唯一匹配的城市结果；重名不能取第一条。
const geo=async()=>({ok:true,json:async()=>({results:[{id:1,name:'测试甲城',feature_code:'PPLA',country_code:'CN',latitude:30,longitude:100,timezone:'Asia/Shanghai'}]})});
const map=await resolveMapPlaces(['测试甲城'],[],{fetchImpl:geo});assert.equal(map.points[0].lat,30);assert.equal(map.points[0].provider,'open-meteo/geonames');
const ambiguous=await resolveMapPlaces(['测试乙城'],[],{fetchImpl:async()=>({ok:true,json:async()=>({results:[1,2].map(id=>({id,name:'测试乙城',feature_code:'PPL',latitude:id,longitude:id}))})})});
assert.equal(ambiguous.points[0].lat,null);

// 明确的必经城市来自用户条件，不要求网页替用户证明“想经过哪里”。
const plan=await planSearchFirst({origin:'北京',destination:'阿拉木图',requirements:before.requirements},{searchWeb:noSearch,composeJson:async()=>({origin:{name:'北京',country:'CN'},destination:{name:'阿拉木图',country:'KZ'}})});
assert.equal(plan.status,'ok');assert.equal(plan.candidates.length,1);assert.equal(plan.candidates[0].builder,'user+ai');
assert.deepEqual(workspace.routeFor(null,plan.candidates[0]),['北京','伊宁','阿拉木图']);assert.ok(plan.candidates[0].legs.every(l=>l.evidence_state==='explore'));

// 页面实际入口：明确生成不再被旧plan挡住；刷新恢复不会触发发现。
const html=readFileSync(new URL('../mixtouring-hifi/pages/trip.html',import.meta.url),'utf8');
const slice=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));
let generatedArgs=null,network=0;
const env={conversationBusy:false,conversation:before,activePlan:{plan_id:'old',candidates:[]},activePlanSignature:'old',planningSignature:()=> 'new',currentCandidate:()=>null,MTRouteWorkspace:workspace,
  sendConversation:async(...args)=>generatedArgs=args};vm.createContext(env);
vm.runInContext(slice('async function generateConversation(','function renderGuide()'),env);
await env.generateConversation(true);assert.equal(generatedArgs[2],'generate');assert.equal(generatedArgs[3],null);
Object.assign(env,{cancelRouteResearch(){},saveFailure:null,guideSequence:0,journeySequence:0,savedDraftId:null,researchScope:null,researchTasks:null,researchHydrationKey:null,
  MTGuide:{clean:v=>v,routeKey:()=>null},historicalMessages:v=>v,fillTravel(){},restoreConstraintSnapshot(){},MTSights:{restore(){}},planController:null,planSequence:0,planning:false,
  document:{getElementById:()=>({value:''})},renderGuide(){},rememberSession(){},renderUnified(){},requestPlan:()=>network++,draftMap:null,guideUndo:[]});
vm.runInContext(slice('function restoreGuideSnapshot(','function undoGuide()'),env);
env.restoreGuideSnapshot({request:{origin:'北京',destination:'阿拉木图'},conversation:before,travel:{},constraints:{},preferences:{},messages:[],active_plan:plan},false);
assert.equal(network,0);assert.equal(env.activePlan.candidates.length,1);
assert.ok(!slice('function renderTaskPreview()','function fillTravel(').includes('draft.pending.map'),'攻略正文不渲染内部缺口清单');
console.log('✓ 实测故障回归：条件预览、咨询授权、十日成稿、自然语言补查、失败分类、中文搜索、地图歧义、旧候选与免费刷新恢复通过');

// 旧候选回填不能覆盖已保存预算，刷新不再将已保存误判为未保存。
let restoredBudget=null;env.restoreConstraintSnapshot=s=>{restoredBudget=s?.budget_max_cny ?? null;};env.renderUnified=()=>{restoredBudget=null;};
env.restoreGuideSnapshot({request:{origin:'北京',destination:'阿拉木图'},conversation:before,travel:{},constraints:{budget_max_cny:8000},preferences:{},messages:[],active_plan:plan},false);
assert.equal(restoredBudget,8000);assert.equal(network,0);

// 核验说明按整句移入后台，不能仅删除限定词后留下“每天开”等断言。
const shown=workspace.presentDraft({...draft,overview:'先安排城市散步。跨境时刻均需按出行日期另行核对，预算8000元。',cards:[{...draft.cards[0],content:'班车每天开，日期仍需核实。下午安排散步。'}]});
assert.equal(shown.overview,'先安排城市散步。');assert.equal(shown.cards[0].content,'下午安排散步。');assert.ok(shown.pending.some(s=>s.includes('班车每天开')));

// 只对适配器明确标为可恢复的理解调用重试一次；空原因/内容过滤不原样重复。
let networkCalls=0;const retries=[];
const retryResult=await conversationTurn({text:'先聊旅行方向',conversation:before},null,{search:noSearch,onTrace:e=>retries.push(e),model:async opts=>{
  if(opts.kind==='conversation' && ++networkCalls===1){opts.onFailure?.({reason_code:'network_or_timeout',retryable:true});return null;}return output();
}});
assert.equal(retryResult.status,'ok');assert.equal(retries.filter(e=>e.status==='retry').length,1);
let nonRetryCalls=0;const notRetried=await conversationTurn({text:'先聊旅行方向',conversation:before},null,{search:noSearch,model:async opts=>{nonRetryCalls++;opts.onFailure?.({reason_code:'content_filter',retryable:false});return null;}});
assert.equal(notRetried.status,'unavailable');assert.equal(nonRetryCalls,1);

// 自然语言丢弃预览仍完成本轮问答；意图分类先于大模型答复，当前十日稿不动。
const withPreview=cleanConversation({...generated.conversation,preview:{draft:{...draft,cards:draft.cards.slice(0,7)},requirements:{...before.requirements,trip_days:7},brief,patch:{},base_revision:generated.conversation.revision}});
const callOrder=[];
const keepTen=await conversationTurn({text:'保留10天，不采用7天，先聊聊',conversation:withPreview},null,{search:noSearch,model:async opts=>{
  callOrder.push(opts.kind);if(opts.kind==='conversation_intent')return {intent_action:'question',requirements_patch:{},discard_preview:true};return output({intent_action:'question',draft:null});
}});
assert.equal(callOrder[0],'conversation_intent');assert.equal(keepTen.status,'ok');assert.equal(keepTen.conversation.preview,null);assert.equal(keepTen.conversation.requirements.trip_days,10);assert.equal(keepTen.conversation.revision,generated.conversation.revision);

// 理解阶段只发卡片结构，正式编排阶段使用七天目标与完整原稿，不能先写两遍十日稿。
const sevenDraft={...draft,title:'七天备选',cards:draft.cards.slice(0,7)};let understood=0,composed=0;
const phasedPreview=await conversationTurn({text:'如果只有7天呢',conversation:generated.conversation},null,{search:noSearch,model:async opts=>{
  if(opts.kind==='conversation_intent')return {intent_action:'preview',requirements_patch:{trip_days:7}};
  if(opts.kind==='conversation_calendar')return {travel:{},search_window:null};
  if(opts.kind==='conversation_review')return {draft:sevenDraft,reply:'整理了七天备选。',changes:[]};
  if(opts.kind==='conversation'){
    const p=JSON.parse(opts.user);
    if(opts.instruction_phase==='understand'){understood++;assert.equal(p.draft_outline.cards[0].content,undefined);return output({intent_action:'preview',requirements_patch:{trip_days:7},draft});}
    if(opts.instruction_phase==='compose'){composed++;assert.equal(p.current.requirements.trip_days,7);assert.equal(p.output_contract.delivery_mode,'preview');assert.equal(p.original_draft.cards.length,10);return output({draft:sevenDraft,reply:'整理了七天备选。'});}
  }
  return output();
}});
assert.equal(phasedPreview.status,'ok');assert.equal(phasedPreview.conversation.requirements.trip_days,10);assert.equal(phasedPreview.conversation.preview.draft.cards.length,7);assert.equal(understood,1);assert.equal(composed,1);
assert.equal(workspace.presentReply('已安排城市散步。预算8000元按目标复述，实际费用待查。'),'已安排城市散步。');

// 真实轨迹反例：两个理解模型都漏写预览天数，但实际提案是首尾完整的七天。
const missingPatchProposal={...sevenDraft,cards:sevenDraft.cards.map((c,i)=>({...c,place:i===0 || i===6?'北京':c.place}))};
const derived=[];
const recoveredDays=await conversationTurn({text:'如果我只有7天呢？',conversation:generated.conversation,travel:{trip_type:'round_trip'}},null,{search:noSearch,onTrace:e=>derived.push(e),model:async opts=>{
  if(opts.kind==='conversation_intent')return {intent_action:'preview',requirements_patch:{}};
  if(opts.kind==='conversation_calendar')return {travel:{},search_window:null};
  if(opts.kind==='conversation_review'){assert.equal(JSON.parse(opts.user).requirements.trip_days,7);return {draft:missingPatchProposal,reply:'整理了七天备选。',changes:[]};}
  if(opts.kind==='conversation')return output({intent_action:'preview',requirements_patch:{},draft:missingPatchProposal,reply:'整理了七天备选。'});
  return output();
}});
assert.equal(recoveredDays.status,'ok');assert.equal(recoveredDays.conversation.requirements.trip_days,10);assert.equal(recoveredDays.conversation.preview.requirements.trip_days,7);assert.equal(recoveredDays.conversation.preview.draft.cards.length,7);assert.ok(derived.some(e=>e.stage==='preview_target' && e.trip_days===7));

// 日序补缺只能改原卡标签；修复模型顺手添加的3小时必须不进入交付稿。
const unlabeled={...draft,cards:draft.cards.map((c,i)=>i===9?{...c,place:'北京',label:'返程安排',title:'返程交通',content:'安排返回北京的交通与休息。'}:c)};
const coverageTrace=[];
const coverageFixed=await conversationTurn({action:'generate',conversation:before,travel:{trip_type:'round_trip'}},null,{search:noSearch,onTrace:e=>coverageTrace.push(e),model:async opts=>{
  if(opts.kind==='conversation_schedule'){
    const p=JSON.parse(opts.user);assert.deepEqual(p.coverage.missing,[10]);
    return {draft:{...unlabeled,cards:unlabeled.cards.map((c,i)=>({...c,label:'第'+(i+1)+'天',...(i===6?{content:'从市区前往景区需要3小时。'}:{})}))}};
  }
  if(opts.kind==='conversation_review')return {draft:unlabeled,reply:'已整理完整安排。',changes:[]};
  return output({draft:unlabeled});
}});
assert.equal(coverageFixed.status,'ok');assert.equal(coverageFixed.conversation.draft.cards[6].content,draft.cards[6].content);assert.equal(coverageFixed.conversation.draft.cards[9].label,'第10天');assert.ok(coverageTrace.some(e=>e.stage==='schedule' && e.ignored_content_changes===1));

// 数值纠错只改被拒字段，主生成与一致性编辑各自新增的3小时都能局部删除。
let localFixes=0;
const badNumberDraft={...draft,cards:draft.cards.map((c,i)=>i===6?{...c,content:'从市区前往峡谷需要3小时。'}:c)};
const locallyFixed=await conversationTurn({action:'generate',conversation:{...before,stage:'ready',revision:1,draft},travel:{trip_type:'round_trip'}},null,{search:noSearch,model:async opts=>{
  if(opts.kind==='conversation_numeric_repair'){
    localFixes++;const p=JSON.parse(opts.user);assert.ok(Array.isArray(p.numeric_fact_catalog));assert.equal(p.fields[0].path,'draft.cards.6.content');assert.equal(p.fields[0].card.label,'第7天');
    return {fields:p.fields.map(f=>({path:f.path,text:'本日以交通和自然游览为主，早点出发并保留休整时间。'}))};
  }
  if(opts.kind==='conversation_review')return {draft:badNumberDraft,reply:'已整理每日建议。',changes:[]};
  return output({draft:badNumberDraft});
}});
assert.equal(locallyFixed.status,'ok');assert.equal(localFixes,2);assert.doesNotMatch(locallyFixed.conversation.draft.cards[6].content,/3小时/);assert.equal(locallyFixed.conversation.draft.cards[0].content,draft.cards[0].content);
const wrongPath=await conversationTurn({action:'generate',conversation:before,travel:{trip_type:'round_trip'}},null,{search:noSearch,model:async opts=>opts.kind==='conversation_numeric_repair'?{fields:[{path:'draft.route',text:'未经授权的修改'}]}:output({draft:badNumberDraft})});
assert.equal(wrongPath.status,'unavailable');assert.deepEqual(wrongPath.conversation,before,'字段修复不能改非白名单路径');

const hintsOnly=workspace.cleanDraft({...draft,map_places:[{name:'伊宁',name_latin:'Yining',country_hint:'CN',lat:99,lon:88},{name:'无关城市',name_latin:'Other'}]});assert.equal(hintsOnly.map_places.length,1);assert.equal(hintsOnly.map_places[0].lat,undefined);assert.equal(workspace.cleanDraft({...draft,map_places:{bad:true}}).map_places.length,0);
