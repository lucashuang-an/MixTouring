import assert from 'node:assert/strict';
import {unconfirmedReturnCards} from './lib/return-scope.mjs';
const cards=[{id:'card-1',place:'乐山',title:'苏稽慢逛',content:'下午游览后返程，回到乐山住处休息。'},{id:'card-2',place:'乐山',title:'继续慢逛',content:'本次不返回成都，回程另行安排。'},{id:'card-3',place:'乐山',title:'返回成都',content:'下午从乐山返回成都。'}];
const draft={route:['成都','乐山'],cards},routing={origin:'成都',destination:'乐山'};
const classify=async o=>{const p=JSON.parse(o.user);assert.equal(p.origin,'成都');return {classifications:p.cards.map(c=>({id:c.id,kind:c.id==='card-3'?'return_to_origin':c.id==='card-2'?'not_scheduled':'local_return',quote:c.content}))};};
assert.deepEqual((await unconfirmedReturnCards(draft,routing,classify)).map(c=>c.id),['card-3']);
await assert.rejects(unconfirmedReturnCards(draft,routing,async()=>({classifications:[]})),/核对/);
await assert.rejects(unconfirmedReturnCards(draft,routing,async()=>({classifications:cards.map(c=>({id:c.id,kind:'local_return',quote:'不存在的原话'}))})),/核对/);
await assert.rejects(unconfirmedReturnCards(draft,routing,async()=>({classifications:cards.map(c=>({id:c.id,kind:'unclear',quote:c.content}))})),/核对/);
let calls=0;assert.deepEqual(await unconfirmedReturnCards({route:draft.route,cards:[{...cards[0],content:'下午在街区散步。'}]},routing,async()=>{calls++;}),[]);assert.equal(calls,0,'没有返程线索时不增加模型调用');
console.log('✓ 单程范围：当地返回、否定、真正返回出发城、无法判断及核对失败保留边界');

assert.equal((await unconfirmedReturnCards({route:draft.route,cards:[cards[2]]},routing,classify)).length,1,'同一天也不能擅自安排回到出发城');
import {conversationTurn,cleanConversation} from './lib/conversation.mjs';
const before=cleanConversation({stage:'draft',brief:{origin:'成都',destination:'乐山',summary:'三天单程'},routing,requirements:{trip_days:3},draft:{title:'乐山',overview:'慢逛',route:draft.route,cards,sections:[],pending:[]}});
const localDraft={...before.draft,cards:before.draft.cards.map((c,i)=>i===2?{...c,title:'公园慢逛',content:'下午在公园散步。'}:c)};
let destructiveRepairs=0;
const result=await conversationTurn({text:'保留当地游览后回住处的安排',conversation:before,travel:{trip_type:'one_way'}},null,{search:async()=>[],model:async o=>{
 if(o.kind==='conversation_return_check')return classify(o);
 if(o.kind==='conversation_scope'){destructiveRepairs++;throw Error('当地返回不能进入删改');}
 if(o.kind==='conversation_condition_update')return JSON.parse(o.user).proposed;
 if(o.kind==='conversation_calendar')return {travel:{}};
 return {intent_action:'revise',reply:'保留当地安排。',brief:before.brief,routing,ready:true,requirements_patch:{},preferences:{},travel:{},constraints:{},sights:{},draft:localDraft};
}});
assert.equal(result.status,'ok',result.reply);assert.equal(destructiveRepairs,0);assert.equal(result.conversation.draft.cards[0].content,cards[0].content);assert.equal(result.conversation.draft.cards[1].content,cards[1].content);
