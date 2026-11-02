/* 真实状态转换链，模拟外部模型与搜索，不使用自动补授权的成稿fixture。 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {conversationTurn,cleanConversation} from './lib/conversation.mjs';
import {discussionFingerprint} from './lib/planning-discussion.mjs';
import guide from '../mixtouring-hifi/assets/trip-guide.js';
import {sanitizeIntentFields,sanitizeConstraints} from './lib/anywhere.mjs';
import {normalizeSightState} from './lib/sights.mjs';
import workspace from '../mixtouring-hifi/assets/route-workspace.js';
const base={origin:'福州',destination:'宁波',summary:'城市慢逛，五日含往返',wishes:[],open_questions:[]};
const five={title:'宁波五日',overview:'城市慢逛',route:['福州','宁波'],cards:['福州','宁波','宁波','宁波','福州'].map((place,i)=>({id:'card-day-'+(i+1),place,label:'第'+(i+1)+'天',title:i===0?'出发':i===4?'返回福州':'城市散步',content:i===0?'从福州出发抵达宁波。':i===4?'从宁波返回福州。':'上午：在`公园`散步。'})),sections:[],pending:[]};
let step='intake',lastInput=null,composed=0,optionCount=2;
const patches={preferences:{},travel:{},constraints:{},sights:{},requirements_patch:{}};
const model=async o=>{
 const p=JSON.parse(o.user);
 if(o.kind==='conversation_condition_update')return p.proposed;
 if(o.kind==='conversation_calendar')return {travel:{trip_type:'round_trip'}};
 if(o.kind==='conversation_digest')return {summary:'福州往返宁波，先讨论再生成。'};
 if(o.kind==='planning_confirmation')return {generate:true,quote:p.text};
 if(o.kind==='planning_outline')return {options:Array.from({length:optionCount},(_,i)=>({title:'方向'+i,description:i?'建议适当留白。':'建议以城市散步为主。',outbound_days:1,return_days:1,segments:[{place:'宁波',days:3,scope:''}],memberships:[]}))};
 if(o.kind==='conversation_intent')return {intent_action:step==='undo'?'undo':step==='question'?'question':'revise'};
 if(o.kind==='conversation_local_revision'){assert.deepEqual(p.local_scope,['card-day-3']);return {reply:'第三天放慢节奏。',cards:[{id:'card-day-3',title:'公园慢逛',content:'上午：到`公园`慢慢走，下午休息。'}],summary_fields:[]};}
 if(o.instruction_phase==='compose'){composed++;return {reply:'行程如下。',draft:five};}
 if(o.kind==='conversation_review')return {reply:'当前安排保持不变。'};
 if(step==='undo')return {intent_action:'undo'};
 const intent=step==='confirm'?'confirm':step==='revise'?'revise':step==='question'?'question':'discuss';
 return {...patches,...(lastInput?.text?.includes('轻松点')?{preferences:{pace:'simple'}}:{}),intent_action:intent,reply:'先聊想法。',brief:base,ready:true,confirmed:step==='confirm',planning:{action:step==='intake'?'ask':step,scopes:[],option_count:2,selected_id:lastInput?.conversation?.discussion?.options[0]?.id},...(step==='intake'?{requirements_patch:{trip_days:5},travel:{trip_type:'round_trip'}}:{})};
};
let input={messages:[],preferences:{},travel:{},constraints:{},sights:{}};
const rows=[{title:'宁波城市游',link:'https://example.org/ningbo',content:'宁波公园与城市散步。',date:'2026-10-31'}];
async function send(text,action='chat'){
 lastInput={...input,text,action};const r=await conversationTurn(lastInput,null,{model,search:async()=>rows,now:Date.parse('2026-10-31T00:00:00Z')});
 assert.equal(r.status,'ok',r.reply);if(r.action!=='undo')input.conversation=r.conversation;
 input.messages.push({role:'user',text},{role:'assistant',text:r.reply});for(const k of ['preferences','travel','constraints','sights'])input[k]={...input[k],...r.patch?.[k]};return r;
}
let r=await send('福州往返宁波五天');assert.equal(composed,0);assert.equal(r.next_action.type,'none');
step='propose';r=await send('偏城市文化，给两种玩法比较');assert.equal(r.conversation.discussion.options.length,2,'城市对可以按用户要求比较');assert.equal(composed,0);
step='select';r=await send('选第一种');assert.equal(r.next_action.type,'none');
step='confirm';r=await send('按第一种生成，节奏轻松点');assert.equal(r.next_action.type,'generate','软节奏变化不强制重新提粗略方案');assert.equal(input.preferences.pace,'simple');
step='generate';r=await send('按已确认方案生成','generate');assert.equal(composed,1);assert.equal(r.conversation.draft.cards.length,5);
const beforeEdit=structuredClone(input.conversation);
step='revise';r=await send('只改第三天，减少一个活动，其他所有天不变');assert.equal(composed,1,'局部修改不重跑整稿生成');
for(const c of beforeEdit.draft.cards)if(c.id!=='card-day-3')assert.deepEqual(r.conversation.draft.cards.find(x=>x.id===c.id),c);
step='undo';r=await conversationTurn({...input,text:'撤销上次修改',can_undo:true},null,{model});assert.equal(r.action,'undo');input.conversation=beforeEdit;
const storage=new Map(),env={window:{},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}};vm.createContext(env);vm.runInContext(readFileSync(new URL('../mixtouring-hifi/assets/draft-store.js',import.meta.url),'utf8'),env);
const snapshot={request:{origin:'福州',destination:'宁波'},...input};const saved=env.window.MTDrafts.save('完整链路',snapshot);assert(saved.ok);
const restored=env.window.MTDrafts.get(saved.draft.id).versions[0].snapshot;assert.deepEqual(JSON.parse(JSON.stringify(restored.conversation)),JSON.parse(JSON.stringify(beforeEdit)));input=JSON.parse(JSON.stringify(restored));
step='question';r=await send('先不要改稿');assert.deepEqual(r.conversation.draft,beforeEdit.draft);assert.equal(composed,1);
// 未确定总天数：先建议，确认后才将建议总天数提交为本次条件。
step='propose';optionCount=1;input={preferences:{},travel:{trip_type:'round_trip'},constraints:{},sights:{},messages:[],conversation:cleanConversation({brief:base})};
r=await send('天数未定，先给两种建议');assert.equal(r.task_status,'partial');assert.match(r.reply,/目前有1种/);assert.equal(r.conversation.requirements.trip_days,null);assert.match(r.reply,/建议共5天/);
step='confirm';r=await send('按这份方案生成');assert.equal(r.conversation.requirements.trip_days,5);assert.equal(r.next_action.type,'generate');
// 建议分配可调整并告知；用户明确锁定的相同分配必须拦截。
for(const hard of [false,true]){
 const brief={origin:'上海',destination:'大阪',summary:'经京都七日往返',wishes:[],open_questions:[]};
 const outline={id:'chosen',title:'京都—大阪',description:'城市旅行。',route:['上海','京都','大阪'],outbound_days:1,return_days:1,segments:[{place:'京都',days:2,scope:''},{place:'大阪',days:3,scope:''}],memberships:[]};
 const before=cleanConversation({stage:'discuss',brief,routing:{origin:'上海',destination:'大阪'},requirements:{trip_days:7,required_stops:['京都']},discussion:{options:[outline],confirmation_requested:true,stay_locks:hard?[{place:'京都',days:2,quote:'京都必须两天'}]:[]}});
 const current={preferences:guide.clean({}),travel:sanitizeIntentFields({trip_type:'round_trip'}),constraints:sanitizeConstraints({}),sights:normalizeSightState({})};before.discussion.conditions_hash=discussionFingerprint(before,current);
 const altered={...five,title:'两城七日',route:outline.route,cards:['上海','京都','京都','京都','京都','大阪','上海'].map((place,i)=>({id:'card-day-'+(i+1),place,label:'第'+(i+1)+'天',title:i===0?'出发':i===6?'返回上海':'公园散步',content:i===0?'从上海出发。':i===6?'返回上海。':'上午：在`公园`散步。'}))};
 const callback=async o=>o.kind==='conversation_calendar'?{travel:{}}:o.kind==='conversation_condition_update'?JSON.parse(o.user).proposed:o.kind==='planning_confirmation'?{generate:true,quote:'按这份方案生成'}:{...patches,intent_action:'confirm',confirmed:true,reply:'准备编排。',brief,ready:true,planning:{action:'confirm',selected_id:'chosen'},draft:altered};
 const confirmed=await conversationTurn({text:'按这份方案生成',conversation:before,...current},null,{model:callback});assert.equal(confirmed.request_generation,true);
 const delivered=await conversationTurn({action:'generate',text:'生成',conversation:confirmed.conversation,...current},null,{model:callback,search:async()=>[]});
 if(hard){assert.equal(delivered.status,'unavailable');assert.equal(delivered.conversation.draft,null);assert.match(delivered.reply,/停留天数/);}
 else {assert.equal(delivered.status,'ok');assert.match(delivered.reply,/京都由2天调整为4天/);assert.match(delivered.reply,/大阪由3天调整为1天/);}
}
console.log('✓ 完整链路：讨论、两个城市玩法、选择与确认、生成、局部改稿、撤销、保存恢复；建议天数与硬锁定分别验收');
// 驱动真实前端范围函数：旧快照只有去程时，也必须重建返程，而不是按钮空操作。
const page=readFileSync(new URL('../mixtouring-hifi/pages/trip.html',import.meta.url),'utf8');
const scopeStart=page.indexOf('function taskScope(){'),scopeEnd=page.indexOf('function persistResearchTasks',scopeStart);
let type='round_trip';
const scopeEnv={conversation:{draft:{route:['福州','宁波']}},researchScope:{route:['福州','宁波'],window:null,legs:[{from:'福州',to:'宁波',mode:'unknown'}]},MTRouteWorkspace:workspace,collectTravel:()=>({trip_type:type}),currentSearchWindow:()=>null,currentLegWindow:()=>null,currentTransportMode:()=> 'unknown',anchors:{},guideState:{},collectConstraints:()=>({})};
vm.createContext(scopeEnv);vm.runInContext(page.slice(scopeStart,scopeEnd),scopeEnv);
assert.equal(scopeEnv.taskScope().legs.map(l=>l.from+'→'+l.to).join('|'),'福州→宁波|宁波→福州');
type='one_way';assert.equal(scopeEnv.taskScope().legs.length,1);
