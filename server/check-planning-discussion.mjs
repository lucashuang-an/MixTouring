import assert from 'node:assert/strict';
import {conversationTurn,cleanConversation} from './lib/conversation.mjs';
import {validateOutline,authorizedOutline,discussionFingerprint} from './lib/planning-discussion.mjs';
import {buildEvidenceCatalog} from './lib/evidence-grounding.mjs';
import guide from '../mixtouring-hifi/assets/trip-guide.js';
import {sanitizeIntentFields,sanitizeConstraints} from './lib/anywhere.mjs';
import {normalizeSightState} from './lib/sights.mjs';
const brief={origin:'北京',destination:'越南、印尼',summary:'两国15天含往返',wishes:[],open_questions:[]};
const scopes=[{name:'越南',level:'country'},{name:'印尼',level:'country'}];
let input={text:'北京往返，越南印尼15天',preferences:{},travel:{},constraints:{},sights:{}};
let searches=0,compose=0;
let decision={action:'ask',scopes},requirements={trip_days:15,add_stops:['越南','印尼']};
const rows=[{title:'越南与印尼旅行',link:'https://example.org/regions',content:'河内位于越南，可安排城市散步。巴厘岛位于印尼，可安排海岛休息。',date:'2026-10-31'}];
const model=async o=>{
 const p=JSON.parse(o.user);
 if(o.kind==='planning_confirmation')return {generate:/生成/.test(p.text),quote:p.text};
 if(o.kind==='conversation_condition_update')return p.proposed;
 if(o.kind==='conversation_calendar')return {travel:{trip_type:'round_trip'}};
 if(o.kind==='planning_outline'){
  const source=p.evidence_catalog.entries[0];return {options:[{title:'文化与海岛',description:'建议先安排城市散步，再留出海岛休息时间。',outbound_days:1,return_days:1,segments:[{place:'河内',days:6,scope:'越南'},{place:'巴厘岛',days:7,scope:'印尼'}],memberships:[{city:'河内',scope:'越南',source_id:source.id,quote:'河内位于越南'},{city:'巴厘岛',scope:'印尼',source_id:source.id,quote:'巴厘岛位于印尼'}]}]};
 }
 if(o.instruction_phase==='compose'){compose++;throw Error('确认前禁止成稿');}
 return {intent_action:decision.action==='confirm'?'confirm':'discuss',confirmed:decision.action==='confirm',reply:'你更想城市文化还是海岛放松？',brief,ready:true,planning:decision,requirements_patch:requirements,preferences:{},travel:{trip_type:'round_trip'},constraints:{},sights:{}};
};
async function send(text){input.text=text;const r=await conversationTurn(input,null,{model,search:async()=>{searches++;return rows;},now:Date.parse('2026-10-31T00:00:00Z')});assert.equal(r.status,'ok',r.reply);input.conversation=r.conversation;for(const k of ['preferences','travel','constraints','sights'])input[k]={...input[k],...r.patch?.[k]};return r;}
let r=await send(input.text);assert.equal(searches,0);assert.equal(compose,0);assert.equal(r.next_action.type,'none');assert.deepEqual(r.conversation.requirements.required_stops,[]);assert.deepEqual(r.conversation.discussion.scopes,scopes);assert.equal(r.conversation.routing.destination,'');
requirements={};decision={action:'confirm',scopes};r=await send('对，包含往返');assert.equal(r.next_action.type,'none','未展示方案，模型误判confirm也不允许成稿');
decision={action:'propose',scopes};r=await send('文化加海岛，少换地方，请推荐');assert.equal(r.conversation.draft,null);assert.equal(compose,0);assert.equal(r.next_action.type,'none');assert.equal(r.conversation.discussion.options.length,1);assert.match(r.reply,/第2—7天 河内 · 第8—14天 巴厘岛/);
const proposed=structuredClone(input),id=r.conversation.discussion.options[0].id;
decision={action:'select',scopes,selected_id:id};r=await send('选这个');assert.equal(r.next_action.type,'none');assert.match(r.reply,/生成完整逐日攻略/);
decision={action:'confirm',scopes,selected_id:id};r=await send('按这个方案生成');assert.equal(r.next_action.type,'generate');assert.deepEqual(r.conversation.routing,{origin:'北京',destination:'巴厘岛'});assert.deepEqual(r.conversation.requirements.required_stops,[]);
const current={preferences:guide.clean(input.preferences),travel:sanitizeIntentFields(input.travel),constraints:sanitizeConstraints(input.constraints),sights:normalizeSightState(input.sights)};
assert(authorizedOutline(cleanConversation(JSON.parse(JSON.stringify(r.conversation))),current),'刷新恢复后仍绑定同一方案');
const tampered=structuredClone(r.conversation);tampered.discussion.options[0].route[1]='曼谷';assert.equal(authorizedOutline(tampered,current),null);
assert.equal(authorizedOutline(r.conversation,{...current,constraints:{no_self_drive:true}}),null);
assert.equal(authorizedOutline(r.conversation,{...current,anchors:{outbound:{from_city:'北京',to_city:'河内'}}}),null,'已订交通变化必须重新确认方案');
assert.equal((await conversationTurn({...input,constraints:{no_self_drive:true},action:'generate'},null,{model})).status,'needs_intent');
input=proposed;requirements={trip_days:12};decision={action:'confirm',scopes,selected_id:id};r=await send('改12天，生成吧');assert.equal(r.next_action.type,'none','改变条件后旧方案授权失效');assert.equal(compose,0);
const failed=await conversationTurn({...input,text:'继续讨论'},null,{model:async()=>null});assert.equal(failed.status,'unavailable');assert.deepEqual(failed.conversation,cleanConversation(input.conversation));
const aborted=new AbortController();aborted.abort();assert.equal((await conversationTurn({...input,text:'推荐'},null,{model,signal:aborted.signal})).status,'unavailable');
const catalog=buildEvidenceCatalog({sources:[{url:'https://example.org/province',title:'福建旅行',excerpt:'福州位于福建，泉州位于福建。'}]});
const option={title:'福建慢游',description:'建议分两段游览。',outbound_days:1,return_days:1,segments:[{place:'福州',days:2,scope:'福建'},{place:'泉州',days:1,scope:'福建'}],memberships:[{city:'福州',scope:'福建',source_id:catalog.entries[0].id,quote:'福州位于福建'},{city:'泉州',scope:'福建',source_id:catalog.entries[0].id,quote:'泉州位于福建'}]};
const args={origin:'上海',days:5,tripType:'round_trip',scopes:[{name:'福建',level:'province'}],requiredStops:[],catalog};
assert(validateOutline(option,args));assert(!validateOutline({...option,memberships:[]},args));assert(!validateOutline({...option,return_days:0},args));assert(!validateOutline(option,{...args,scopes:[...args.scopes,{name:'浙江',level:'province'}]}));assert(!validateOutline({...option,segments:[{place:'福建',days:3,scope:'福建'}]},args));
// 新生成接口不能接受旧ready状态，也不能接受随意伪造的授权。
assert.equal((await conversationTurn({action:'generate',conversation:{stage:'ready',brief,discussion:{authorization:'fake'}}},null,{model})).status,'needs_intent');
console.log('✓ 讨论→来源方案→选择→确认，国家／省份覆盖、旧状态迁移、刷新、篡改、条件变化、取消与失败保留通过');

assert.deepEqual(cleanConversation({discussion:{scopes:[{name:'宁波',level:'country'}]}}).discussion.scopes,[],'不能接受模型把城市标为国家');
// 实网反例：城市方案没有国家归属段，空段尾换行不应使已核对地点被误判改变。
const {discussPlan}=await import('./lib/planning-discussion.mjs');
for(const [origin,destination]of [['成都','乐山'],['大阪','京都']]){
 const before=cleanConversation({brief:{origin,destination,summary:'城市慢逛'},routing:{origin,destination},requirements:{trip_days:3}});
 const result=await discussPlan({before,next:structuredClone(before),current:{requirements:before.requirements,travel:{trip_type:'one_way'},preferences:{},constraints:{}},raw:{planning:{action:'propose',option_count:1}},input:{text:'请给文字粗略方案'},search:async()=>[],readPage:null,trace:()=>{},evidenceReview:true,model:async o=>{
  const p=JSON.parse(o.user);
  if(o.kind==='planning_outline')return {options:[{title:'城市慢逛',description:'建议以街区散步为主，适当留白。',outbound_days:0,return_days:0,segments:[{place:' '+destination+' ',days:3}],memberships:[]}]};
  if(o.kind==='conversation_evidence_extract')return {items:p.fields.map(f=>({id:f.id,needs_source:false,assertions:[]}))};
  throw Error(o.kind);
 }});
 assert.equal(result.conversation.discussion.options.length,1,'已核对城市方案不能因空归属段的尾换行被丢弃');
 assert.equal(result.request_generation,false);assert.equal(result.conversation.draft,null);
}
// 实网402反例：证据层捕获调用失败后，不能把供应商拒绝伪装成资料不足。
let rejectedCalls=0;
const rejectionBefore=cleanConversation({brief:{origin:'成都',destination:'乐山',summary:'三天单程'},routing:{origin:'成都',destination:'乐山'},requirements:{trip_days:3}});
const providerRejected=await conversationTurn({text:'给个粗略方案',conversation:rejectionBefore,travel:{trip_type:'one_way'}},null,{evidenceReview:true,search:async()=>[],model:async o=>{
 const p=JSON.parse(o.user);if(o.kind==='conversation_condition_update')return p.proposed;
 if(o.kind==='conversation_calendar')return {travel:{}};
 if(o.kind==='planning_outline')return {options:[{title:'乐山',description:'建议慢逛。',segments:[{place:'乐山',days:3}],outbound_days:0,return_days:0,memberships:[]}]};
 if(o.kind==='conversation_evidence_extract'){rejectedCalls++;o.onFailure?.({reason_code:'http_rejected',retryable:false,status:402});return null;}
 return {intent_action:'discuss',reply:'准备方案。',brief:rejectionBefore.brief,ready:true,planning:{action:'propose'},requirements_patch:{},preferences:{},travel:{},constraints:{},sights:{}};
}});
assert.equal(providerRejected.status,'unavailable');assert.match(providerRejected.reply,/模型服务.*拒绝/);assert.deepEqual(providerRejected.conversation,rejectionBefore);assert.equal(rejectedCalls,1);

// 英文请求：故障消息、动作合同缺失不静默降为ask，显式中文仍保留。
{
 const english="I'm planning a relaxed 5-day trip from Lisbon to Porto. Reply in English.";
 let intakeCalls=0;
 const failed=await conversationTurn({text:english},null,{evidenceReview:true,validateIntake:true,model:async opts=>{
  if(opts.instruction_phase==='intake'){intakeCalls++;return {reply:'What pace?',brief:{origin:'Lisbon',destination:'Porto'},preferences:{},travel:{},constraints:{},requirements_patch:{}};}
  throw Error('不应进入后续阶段');
 }});
 assert.equal(intakeCalls,2);
 assert.equal(failed.status,'unavailable');
 assert.match(failed.reply,/preserved/);
 assert.doesNotMatch(failed.reply,/[\u3400-\u9fff]/);
 const chinese=await conversationTurn({text:'从北京去上海，用中文回复'},null,{model:async()=>null});
 assert.match(chinese.reply,/保留/);
}

// 动作核对只升级粗略讨论，不能增改条件或授予生成；覆盖真实编排出口。
{
 const {reviewIntakeAction}=await import('./lib/intake-action.mjs');
 const original={planning:{action:'ask',scopes:[]},reply:'How many days in each city?',confirmed:true,requirements_patch:{trip_days:6}};
 const promoted=await reviewIntakeAction(original,{text:'Please suggest an outline.',model:async()=>({action:'propose',quote:'Please suggest an outline.'})});
 assert.equal(promoted.planning.action,'propose');assert.equal(promoted.confirmed,false);assert.deepEqual(promoted.requirements_patch,original.requirements_patch);assert.equal(original.planning.action,'ask');
 assert.equal((await reviewIntakeAction(original,{text:'Do not suggest anything yet.',model:async()=>({action:'ask',quote:''})})).planning.action,'ask');
 await assert.rejects(()=>reviewIntakeAction(original,{text:'Hello',model:async()=>({action:'propose',quote:'invented authorization'})}));
 await assert.rejects(()=>reviewIntakeAction(original,{text:'Hello',model:async()=>({action:'confirm',quote:'Hello'})}));
 await assert.rejects(()=>reviewIntakeAction(original,{text:'Hello',model:async()=>null}));
 let reviewCalls=0,searchCalls=0;
 const integrated=await conversationTurn({text:'Please suggest an outline.'},null,{validateIntake:true,model:async opts=>{
  if(opts.kind==='planning_intake_review'){reviewCalls++;return {action:'propose',quote:'Please suggest an outline.'};}
  if(opts.kind==='planning_outline')return {options:[]};
  if(opts.kind==='conversation_calendar')return {travel:{}};
  if(opts.kind==='conversation_condition_update')return JSON.parse(opts.user).proposed;
  return {intent_action:'discuss',planning:{action:'ask'},reply:'Which pace?',brief:{origin:'Amsterdam',destination:'Brussels',wishes:[]},routing:{origin:'Amsterdam',destination:'Brussels'},preferences:{},travel:{},constraints:{},requirements_patch:{},sights:{}};
 },search:async()=>{searchCalls++;return [];}});
 assert.equal(reviewCalls,1);assert.ok(searchCalls>0);assert.equal(integrated.request_generation,false);assert.equal(integrated.conversation.draft,null);
}

{
 const {reviewIntakeAction}=await import('./lib/intake-action.mjs');
 const raw={planning:{action:'propose'},reply:'Here is a route',requirements_patch:{trip_days:8}};
 const conversation={discussion:{recommendation_hold:{quote:'Wait until I ask.'}}};
 const held=await reviewIntakeAction(raw,{text:'I like museums.',conversation,model:async()=>({action:'propose',quote:'I like museums.',hold_update:'keep',reply:'Noted.'})});
 assert.equal(held.planning.action,'ask');assert.equal(held.reply,'Noted.');assert.equal(held.confirmed,false);
 const {cleanDiscussion}=await import('./lib/planning-discussion.mjs');
 assert.deepEqual(cleanDiscussion({recommendation_hold:held.planning.recommendation_hold}).recommendation_hold,conversation.discussion.recommendation_hold);
 const cleared=await reviewIntakeAction(raw,{text:'Please suggest an outline now.',conversation,model:async()=>({action:'propose',quote:'Please suggest an outline now.',hold_update:'clear',hold_quote:'Please suggest an outline now.'})});
 assert.equal(cleared.planning.recommendation_hold,null);assert.equal(cleared.planning.action,'propose');
 await assert.rejects(()=>reviewIntakeAction(raw,{text:'I like museums.',conversation,model:async()=>({action:'propose',quote:'I like museums.',hold_update:'clear',hold_quote:'invented'})}));
}

// 完整主模型决策直接调度工具，不再调用语义审批；冲突仍走有界补修。
{
 const {reviewIntakeAction}=await import('./lib/intake-action.mjs');
 const noReview=async()=>{throw Error('正常路径不应复审');};
 for(const action of ['ask','propose']){
  const raw={planning:{action,hold_update:'keep',hold_quote:''},reply:'Ready',requirements_patch:{trip_days:5}};
  const result=await reviewIntakeAction(raw,{text:'Please recommend a trip.',model:noReview});
  assert.equal(result.planning.action,action);assert.deepEqual(result.requirements_patch,raw.requirements_patch);
 }
 const held={discussion:{recommendation_hold:{quote:'Wait until I ask.'}}};
 const kept=await reviewIntakeAction({planning:{action:'ask',hold_update:'keep'}},{text:'I like museums.',conversation:held,model:noReview});
 assert.deepEqual(kept.planning.recommendation_hold,held.discussion.recommendation_hold);
 const released=await reviewIntakeAction({planning:{action:'propose',hold_update:'clear',hold_quote:'Please recommend now.'}},{text:'Please recommend now.',conversation:held,model:noReview});
 assert.equal(released.planning.recommendation_hold,null);assert.equal(released.confirmed,false);
 let calls=0;
 const repaired=await reviewIntakeAction({planning:{action:'propose',hold_update:'keep'}},{text:'I like museums.',conversation:held,model:async()=>{calls++;return {action:'ask',hold_update:'keep',reply:'Noted.'};}});
 assert.equal(calls,1);assert.equal(repaired.planning.action,'ask');
}

// 未定日期的null和省略经过请求清洗后语义相同，不让确认变成重新推荐。
{
 const c=cleanConversation({brief:{origin:'Amsterdam',destination:'Brussels'},requirements:{trip_days:6}});
 const a={preferences:{},constraints:{},sights:{},travel:{trip_type:'one_way',traveler_count:1,outbound_window:null}};
 assert.equal(discussionFingerprint(c,a),discussionFingerprint(c,{...a,travel:{trip_type:'one_way',traveler_count:1}}));
 assert.notEqual(discussionFingerprint(c,a),discussionFingerprint(c,{...a,travel:{trip_type:'round_trip',traveler_count:1}}));
 assert.notEqual(discussionFingerprint(c,a),discussionFingerprint(c,{...a,travel:{trip_type:'one_way',traveler_count:2}}));
}

// 具体城市路线的检索覆盖出发地与目的地，不先让模型写无资料的出发地停留。
{
 const {discussPlan}=await import('./lib/planning-discussion.mjs');
 const before=cleanConversation({}),next=cleanConversation({brief:{origin:'Amsterdam',destination:'Brussels'},routing:{origin:'Amsterdam',destination:'Brussels'},requirements:{trip_days:6}});
 const queries=[];
 await discussPlan({before,next,current:{requirements:next.requirements,travel:{trip_type:'one_way'},constraints:{},preferences:{}},raw:{planning:{action:'propose'}},input:{text:'Suggest an outline.'},model:async()=>({options:[]}),search:async q=>{queries.push(q);return [];},signal:new AbortController().signal,now:Date.now(),evidenceReview:false,trace:()=>{},useCache:false});
 assert.ok(queries.some(q=>q.includes('Amsterdam')));assert.ok(queries.some(q=>q.includes('Brussels')));
 assert.ok(queries.length<=6);
}

// 没有方案时的生成请求进入提案，不要求用户选择不存在的方案。
{
 const {discussPlan}=await import('./lib/planning-discussion.mjs');
 const before=cleanConversation({}),next=cleanConversation({brief:{origin:'北京',destination:'赤峰'},routing:{origin:'北京',destination:'赤峰'},requirements:{trip_days:3}});
 let proposed=0;
 const result=await discussPlan({before,next,current:{requirements:next.requirements,travel:{trip_type:'one_way'},constraints:{},preferences:{}},raw:{planning:{action:'confirm'}},input:{text:'已经确定，生成方案'},model:async()=>{proposed++;return {options:[{title:'城市探索',description:'建议围绕城区安排。',outbound_days:0,return_days:0,segments:[{place:'赤峰',days:3,scope:''}],memberships:[]}]};},search:async()=>[],now:Date.now(),evidenceReview:false,trace:()=>{},useCache:false});
 assert.equal(proposed,1);assert.equal(result.conversation.discussion.options.length,1);assert.equal(result.request_generation,false);assert.doesNotMatch(result.reply,/先选定/);
}
{
 const {allocationReview}=await import('./lib/itinerary-constraints.mjs');
 const outline={outbound_days:1,return_days:0,segments:[{place:'河内',days:4},{place:'岘港',days:2}],preserve_allocation:true};
 const cards=Array.from({length:7},(_,i)=>({label:'第'+(i+1)+'天',place:i<4?'河内':'岘港'}));
 assert.equal(allocationReview({cards},outline).hard_issues.length,2);
 cards[4].place='河内';assert.equal(allocationReview({cards},outline).hard_issues.length,0);
}

{
 const {samePlaceFacts}=await import('./lib/planning-discussion.mjs');
 assert.equal(samePlaceFacts('河内。\n河内位于越南。','河内\n河内位于越南。'),true);
 assert.equal(samePlaceFacts('河内位于印尼。','河内位于越南。'),false);
 assert.equal(samePlaceFacts('', '河内'),false);
}

{
 const {outlineDestination}=await import('./lib/planning-discussion.mjs');
 assert.equal(outlineDestination('', '河内、岘港', ['河内','岘港']),null);
 assert.equal(outlineDestination('', '河内、岘港', ['河内']),'河内、岘港');
 assert.equal(outlineDestination('岘港', '河内、岘港', ['河内','岘港']),'岘港');
 assert.equal(outlineDestination('', '岘港', ['河内']),'岘港');
}
