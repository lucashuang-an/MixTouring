import workspace from '../mixtouring-hifi/assets/route-workspace.js';
import assert from 'node:assert/strict';
import {conversationTurn,cleanConversation} from './lib/conversation.mjs';
const cases=[['上海','济州岛',3],['成都','乐山',2],['大阪','京都',5],['北京','阿拉木图',10],['','清迈',4],['深圳','',2]];
for(const [origin,destination,days] of cases){
 const brief={origin,destination,summary:'旅行想法',wishes:[],open_questions:[]};let searches=0;const phases=[];
 const r=await conversationTurn({text:origin+'去'+destination+days+'天'},null,{search:async()=>{searches++;return [];},model:async o=>{
  phases.push(o.instruction_phase);if(o.kind==='conversation_condition_update')return JSON.parse(o.user).proposed;
  if(o.kind==='conversation_places')return {origin,destination};
  if(o.instruction_phase==='intake'){assert.doesNotMatch(o.schema_prompt,/card\.content|逐日卡片必须|numeric_fact_catalog/);}
  return {intent_action:'discuss',reply:'先聊旅行方向。',brief,ready:!!origin&&!!destination,requirements_patch:{trip_days:days},preferences:{},travel:{},constraints:{},sights:{}};
 }});
 assert.equal(r.status,'ok');assert.equal(searches,0);assert.ok(phases.includes('intake'));
 assert.equal(r.request_generation,false);assert.equal(r.conversation.stage,'discuss');assert.match(r.reply,/旅行方向/);
}
// 无目的地的事实咨询仍允许检索；不能把目的地表单当作工具前置条件。
let queried=0;
const q=await conversationTurn({text:'请查询铁路行李规定'},null,{search:async()=>{queried++;return [];},model:async o=>({intent_action:'question',reply:'资料暂未返回。',brief:{origin:'',destination:'',summary:'咨询行李规则'},ready:false,search_query:'铁路 行李 规定',preferences:{},travel:{},constraints:{},sights:{}})});
assert.equal(q.status,'ok');assert.ok(queried>0);
// 授权结构错误只修复该阶段；失败不污染当前状态。
let repairs=0;
const brief={origin:'广州',destination:'桂林',summary:'四日旅行',wishes:[],open_questions:[]};
const r=await conversationTurn({text:'喜欢自然景观'},null,{model:async o=>{
 if(o.kind==='conversation_condition_update')return ++repairs===1?{preferences:{experience:'invalid'},authorizations:{'preferences.experience':'喜欢自然景观'}}:{preferences:{experience:'nature'}};
 return {intent_action:'discuss',reply:'已记下。',brief,ready:true,preferences:{experience:'nature'},travel:{},constraints:{},sights:{}};
}});
assert.equal(r.status,'ok');assert.equal(repairs,2);assert.equal(r.patch.preferences.experience,'nature');
// 修改／预览中的新必经城市与无车要求必须同时传入搜索和成稿，不依赖旧current。
for(const action of ['revise','preview']){
 const searches=[],seen=[];const draft={title:'四日',overview:'旅行',route:['广州','桂林'],cards:[{id:'card-day-1',place:'桂林',label:'第1天',title:'休整',content:'休息。'}],sections:[],pending:[]};
 const before={stage:'draft',brief,routing:{origin:'广州',destination:'桂林'},requirements:{trip_days:1},draft};
 const out=await conversationTurn({text:action==='preview'?'如果加阳朔且不自驾呢？':'加入阳朔，不自驾',conversation:before},null,{search:async(query,opts)=>{searches.push(query);return [];},model:async o=>{
  const p=JSON.parse(o.user);
  if(o.kind==='conversation_condition_update')return p.proposed;
  if(o.kind==='conversation_calendar')return {travel:{}};
  if(o.instruction_phase==='compose'){seen.push(p);assert.equal(p.current.constraints.no_self_drive,true);assert.ok(p.current.requirements.required_stops.includes('阳朔'));}
  return {intent_action:action,reply:'已安排。',brief,routing:before.routing,ready:true,requirements_patch:{add_stops:['阳朔']},preferences:{},travel:{},constraints:{no_self_drive:true},sights:{},draft:{...draft,route:['广州','阳朔','桂林']}};
 }});
 assert.equal(out.status,'ok');assert.ok(seen.length);assert.ok(searches.some(q=>q.includes('阳朔')));
 if(action==='preview'){assert.deepEqual(out.conversation.draft,cleanConversation(before).draft);assert.deepEqual(out.patch.constraints,{});}
}
console.log('✓ 跨目的地、缺端点、无目的地咨询、局部结构修复、修改／预览目标条件回归通过');

const repairedLayout=workspace.cleanDraft({title:'行程',route:['甲','乙'],cards:[{id:'card-day-1',place:'乙',label:'第1天',title:'散步',content:'- 上午：街区散步。- 下午：公园休息。- 提醒：带水。'}]});
assert.equal(repairedLayout.cards[0].activities.length,2);assert.equal(repairedLayout.cards[0].tips.length,1);

// 理解阶段漏掉必经城市，授权阶段必须允许有用户原句的增量补齐。
const recovered=await conversationTurn({text:'要经过奈良，坐公共交通'},null,{model:async o=>o.kind==='conversation_condition_update'?{requirements_patch:{add_stops:['奈良']},preferences:{},authorizations:{'requirements_patch.add_stops':'要经过奈良'}}:{intent_action:'discuss',reply:'已记下。',brief:{origin:'大阪',destination:'京都',summary:'经奈良'},ready:true,requirements_patch:{},preferences:{preferred_mode:'rail'},travel:{},constraints:{},sights:{}}});
assert.equal(recovered.status,'ok');assert.deepEqual(recovered.conversation.requirements.required_stops,['奈良']);assert.deepEqual(recovered.patch.preferences,{});
