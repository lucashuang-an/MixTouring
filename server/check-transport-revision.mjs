import {draftQueryScope} from './lib/draft-research.mjs';
import assert from 'node:assert/strict';
import {reviseTransport,updateTransportChoices,applicableTransportChoices} from './lib/transport-revision.mjs';
import {conversationTurn,cleanConversation} from './lib/conversation.mjs';
import {createAgentRuntime} from './lib/agent-runtime.mjs';
const draft={title:'两城五日',overview:'城市散步',route:['甲城','乙城'],cards:Array.from({length:5},(_,i)=>({id:'card-day-'+(i+1),place:i===0||i===4?'甲城':'乙城',label:'第'+(i+1)+'天',title:i===0?'出发':i===4?'返回':'散步',content:i===0?'从甲城前往乙城，下午逛街。':i===4?'从乙城返回甲城。':'上午在公园散步。'})),sections:[],pending:[]};
const before=cleanConversation({draft,stage:'draft',revision:3,routing:{origin:'甲城',destination:'乙城'},requirements:{trip_days:5},brief:{origin:'甲城',destination:'乙城'}});
const current={travel:{trip_type:'round_trip'},preferences:{},constraints:{},anchors:{}};
const choice={from:'甲城',to:'乙城',mode:'drive'},text='去程改用自驾，其他日期不变';
const points=['甲城','乙城'].map((name,i)=>({name,provider:'Google Maps',provider_id:'p'+i,lat:30+i,lon:120}));
function options(extra={}){return {before,input:{text,transport_revision:3},current,choices:[choice],runtime:createAgentRuntime(),search:async()=>[],readPage:null,evidenceReview:false,mapTools:{enabled:true,resolve:async()=>({points}),route:async()=>({status:'available',provider:'Google Maps',duration_s:25200,distance_m:700000,actual_modes:['DRIVE'],time_basis:'typical'})},model:async o=>{
 const p=JSON.parse(o.user);if(o.kind==='planning_transport_scope')return {events:[{from:'甲城',to:'乙城',card_id:'card-day-1',fragment_id:'card-day-1@1'},{from:'乙城',to:'甲城',card_id:'card-day-5',fragment_id:'card-day-5@1'}]};
 if(o.kind==='conversation_transport_revision'){assert.equal(p.observations[0].observation.duration_s,25200);return {cards:[{id:'card-day-1',title:'自驾前往乙城',content:'从甲城自驾前往乙城，抵达后休息。'}],summary_fields:[]};}
 if(o.kind==='planning_transport_review')return {passed:true};throw Error(o.kind);
 },...extra};}
const original=JSON.stringify(before),r=await reviseTransport(options());
assert.equal(JSON.stringify(before),original);assert.equal(r.conversation.revision,4);assert.deepEqual(r.conversation.transport_choices,[choice]);assert.deepEqual(r.patch.preferences,{});
assert.deepEqual(r.conversation.draft.cards.slice(1),before.draft.cards.slice(1));assert(!JSON.stringify(r.conversation).includes('25200'));assert(r.transport_updates.length);assert.equal(r.transport_assessment.available,1);
const preview=await reviseTransport(options({preview:true,baseSignature:'old'}));assert.deepEqual(preview.conversation.draft,before.draft);assert.deepEqual(preview.conversation.transport_choices,[]);assert.deepEqual(preview.conversation.preview.transport_choices,[choice]);assert.equal(preview.transport_updates.length,0);
for(const extra of [{input:{text,transport_revision:2}},{choices:[{...choice,to:'丙城'}]},{current:{...current,constraints:{no_self_drive:true}}},{current:{...current,preferences:{road:'exclude'}}},{current:{...current,anchors:{outbound:{from_city:'甲城',to_city:'乙城',mode:'rail'}}}}])await assert.rejects(reviseTransport(options(extra)),e=>e.code==='TRANSPORT_REVISION');
const baseModel=options().model;
await assert.rejects(reviseTransport(options({model:async o=>o.kind==='planning_transport_scope'?{events:[{from:'甲城',to:'乙城',card_id:'card-day-2',fragment_id:'invented'}]}:baseModel(o)})),/定位/);
await assert.rejects(reviseTransport(options({model:async o=>o.kind==='conversation_transport_revision'?{cards:[{id:'card-day-1',title:'出发',content:'自驾7小时抵达乙城。'}],summary_fields:[]}:baseModel(o)})),/数值/);
await assert.rejects(reviseTransport(options({model:async o=>o.kind==='planning_transport_review'?{passed:false,reason:'衔接冲突'}:baseModel(o)})),/衔接/);
const controller=new AbortController();controller.abort();await assert.rejects(reviseTransport(options({signal:controller.signal})),/中断/);assert.equal(JSON.stringify(before),original);
assert.deepEqual(updateTransportChoices([choice],[{...choice,mode:null,quote:'取消自驾'}],'取消自驾'),[]);
assert.deepEqual(updateTransportChoices([choice],[{...choice,mode:null,quote:'取消自驾'}],'比较火车'),[choice]);
assert.deepEqual(applicableTransportChoices([choice,{from:'乙城',to:'甲城',mode:'rail'}],draft,{trip_type:'one_way'}),[choice]);
console.log('✓ 交通重排：工具观察、局部修改、独立预览、数值隔离、版本/条件冲突、审查失败与取消保留原稿');


const dependencies={model:async o=>o.kind==='conversation_intent'?{intent_action:'preview',transport_only:true,transport_choices:[{...choice,quote:text}]}:baseModel(o),search:async()=>[],transportMapTools:options().mapTools};
const speculative=await conversationTurn({text,conversation:before,...current},null,dependencies);
assert.equal(speculative.status,'ok',speculative.reply);assert.equal(speculative.task_status,'previewed');assert.deepEqual(speculative.conversation.draft,before.draft);
const adopted=await conversationTurn({action:'accept_preview',text:'采用',conversation:speculative.conversation,...current},null,dependencies);
assert.equal(adopted.status,'ok',adopted.reply);assert.deepEqual(adopted.conversation.transport_choices,[choice]);assert.deepEqual(adopted.conversation.draft.cards.slice(1),before.draft.cards.slice(1));
const direct=await conversationTurn({text,conversation:before,...current,transport_choices:[choice],transport_revision:3},null,dependencies);assert.equal(direct.status,'ok',direct.reply);assert.equal(direct.conversation.preview,null);assert.deepEqual(direct.conversation.transport_choices,[choice]);
const chosenScope=draftQueryScope({route:draft.route,travel:current.travel,transport_choices:[choice]});
assert.equal(draftQueryScope({route:draft.route,travel:current.travel,previous:chosenScope,transport_choices:[]}).legs[0].mode,'unknown','取消选路不能通过旧查询范围恢复选择');
console.log('✓ 真实对话入口、假设预览、采纳与交通选择撤回通过');
const grounded=await reviseTransport(options({evidenceReview:true,model:async o=>o.kind==='conversation_evidence_extract'?{items:JSON.parse(o.user).fields.map(f=>({id:f.id,needs_source:false,assertions:[]}))}:baseModel(o)}));assert.equal(grounded.status,'ok');
let repairAttempts=0;
const repaired=await reviseTransport(options({evidenceReview:true,model:async o=>{
 if(o.kind==='conversation_transport_revision'&&++repairAttempts===1)return {cards:[{id:'card-day-1',title:'自驾出发',content:'从甲城自驾前往乙城。具体交通仍需核实。'}],summary_fields:[]};
 if(o.kind==='conversation_evidence_extract')return {items:JSON.parse(o.user).fields.map(f=>({id:f.id,needs_source:false,assertions:[]}))};
 return baseModel(o);
}}));assert.equal(repaired.status,'ok');assert.equal(repairAttempts,2,'呈现移除核验说明后必须重新写稿并核对，不能把未核对原文提交');
for(const allow of [false,true]){
 const text=allow?'去程改自驾，连同第2天一起调整':'去程改自驾，第2天保持不变';
 const outcome=await reviseTransport(options({input:{text,transport_revision:3},model:async o=>{
  const p=JSON.parse(o.user);
  if(o.kind==='planning_transport_authorization')return {permissions:[{id:'card-day-2',allow,quote:text}]};
  if(o.kind==='conversation_transport_revision'){assert.deepEqual(p.targets.map(c=>c.id),allow?['card-day-1','card-day-2']:['card-day-1']);const patch=await baseModel(o);if(allow)patch.cards.push({id:'card-day-2',title:'休整',content:'上午：按体力安排散步与休息。'});return patch;}
  return baseModel(o);
 }}));assert.equal(outcome.status,'ok');if(!allow)assert.deepEqual(outcome.conversation.draft.cards[1],before.draft.cards[1]);
}
