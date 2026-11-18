import assert from 'node:assert/strict';
import {conversationTurn} from './lib/conversation.mjs';
import workspace from '../mixtouring-hifi/assets/route-workspace.js';
const brief={origin:'上海',destination:'济州岛',summary:'三日游',wishes:[],open_questions:[]};
const events=[];let searches=0;
const model=async o=>{
 events.push(o.kind);if(o.kind==='conversation_condition_update')return {requirements_patch:{trip_days:3},preferences:{},travel:{},constraints:{},sights:{}};
 return {intent_action:'discuss',reply:'三天是否包含往返？',brief,ready:true,requirements_patch:{trip_days:3},preferences:{pace:'simple'},travel:{},constraints:{},sights:{}};
};
const first=await conversationTurn({text:'上海去济州岛三日游'},null,{model,search:async()=>{searches++;return [];}});
assert.equal(first.status,'ok');assert.match(first.reply,/包含往返/);assert.equal(searches,0);assert.deepEqual(first.patch.preferences,{});assert.equal(first.conversation.requirements.trip_days,3);
const confirm=await conversationTurn({text:'生成吧',conversation:first.conversation},null,{model:async()=>({intent_action:'confirm',confirmed:true,reply:'你更想去哪里？',brief,ready:true,search_query:'济州岛 攻略',preferences:{},travel:{},constraints:{},sights:{}}),search:async()=>{throw Error('确认回合不得重复搜索');}});
assert.equal(confirm.request_generation,false,'没有粗略方案不能生成');
const d=workspace.cleanDraft({title:'三日',route:['上海','济州岛'],cards:[{id:'card-day-3',place:'济州岛',label:'第3天',title:'返程',content:'- 上午：`东门传统市场`逛街，观看`海女潜水表演`。\n- 下午：从`济州岛`返回`上海`。'}]});
assert.deepEqual(d.cards[0].activities.flatMap(a=>a.places.map(p=>p.name)),['东门传统市场']);
console.log('✓ 意图先行、条件授权、确认不重复检索与地图地点边界通过');

const comparison=await conversationTurn({text:'先比较交通走法',conversation:first.conversation},null,{search:async()=>{throw Error('路线动作不在对话内重复检索');},model:async()=>({intent_action:'discuss',route_discovery:true,reply:'接下来比较走法。',brief,ready:true,preferences:{},travel:{},constraints:{},sights:{}})});
assert.equal(comparison.next_action.type,'discover_routes');assert.equal(confirm.next_action.type,'none');assert.equal(first.next_action.type,'none');
