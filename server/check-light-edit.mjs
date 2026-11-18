import assert from 'node:assert/strict';
import {editItinerary} from './lib/light-edit.mjs';
const draft={title:'Trip',overview:'A trip',route:['A','B'],sections:[],cards:[{id:'one',place:'A',label:'Day 1',title:'Walk',content:'Walk around the gate.'},{id:'two',place:'B',label:'Day 2',title:'Museum',content:'Visit the museum.'}]};
const edit={key:'one.content',old:'Walk around the gate.',new:'Pause outside the gate and look at its shape.',kind:'interest',interest_quote:'I like architecture',source_ids:['s']};
const input={draft,current:{},messages:[{role:'user',text:'I like architecture'}],catalog:{entries:[{id:'s',title:'Gate',excerpt:'A city gate.'}]},validate:d=>d.cards.every(c=>c.content.length>0)};
let calls=0;
const r=await editItinerary({...input,model:async()=>{calls++;return {edits:[edit,{...edit,key:'bogus'}],unresolved:[]}}});
assert.equal(calls,1);assert.equal(r.applied,1);assert.equal(r.status,'needs_repair');assert.equal(r.draft.cards[1].content,draft.cards[1].content);assert.equal(draft.cards[0].content,'Walk around the gate.');
const bad=await editItinerary({...input,model:async()=>({edits:[{...edit,interest_quote:'invented'}],unresolved:[]})});assert.equal(bad.applied,0);
const refused=await editItinerary({...input,validate:()=>false,model:async()=>({edits:[edit],unresolved:[]})});assert.deepEqual(refused.draft,draft);
const unavailable=await editItinerary({...input,model:async()=>null});assert.deepEqual(unavailable.draft,draft);assert.equal(unavailable.status,'unreviewed');
const cancelled=new AbortController();cancelled.abort();await assert.rejects(editItinerary({...input,signal:cancelled.signal,model:async()=>({edits:[],unresolved:[]})}));
console.log('✓ 轻量编辑：单次调用、原稿保留、局部失败隔离、兴趣出处、结构拒绝与取消');
// 正常生成入口采用轻量交付，保持结构与来源状态；编辑故障仍交付可继续的初稿。
{
 const {conversationTurn}=await import('./fixtures/confirmed-conversation.mjs');
 const brief={origin:'A',destination:'B',summary:'Two days',wishes:['walks'],open_questions:[]};
 for(const unavailable of [false,true]){
  let edits=0;
  const result=await conversationTurn({action:'generate',conversation:{stage:'ready',brief,routing:{origin:'A',destination:'B'},requirements:{trip_days:2}},travel:{trip_type:'round_trip'}},null,{
   deliveryReview:'light',search:async()=>[],model:async opts=>{
    if(opts.kind==='conversation_light_edit'){edits++;return unavailable?null:{edits:[],unresolved:[]};}
    if(opts.kind.includes('evidence')||opts.kind.startsWith('conversation_quality'))throw Error('轻量路径不应进入逐句审核');
    return {reply:'Ready',intent_action:'revise',brief,draft,preferences:{},travel:{},constraints:{},requirements_patch:{},sights:{}};
   }});
  assert.equal(result.status,'ok');assert.equal(edits,1);assert.equal(result.conversation.draft.cards.length,2);
  assert.equal(result.delivery_validation.review_mode,'light');assert.equal(result.delivery_validation.assessment.dimensions.grounding,'unknown');
  assert.equal(result.task_status,unavailable?'partial':'delivered');
 }
}
// 回退策略在新进程启动时生效；HTTP入参无法切换。
{
 const {execFileSync}=await import('node:child_process');
 for(const mode of ['light','strict']){
  const actual=execFileSync(process.execPath,['--input-type=module','-e',"import {ITINERARY_REVIEW_MODE} from './server/lib/light-edit.mjs';process.stdout.write(ITINERARY_REVIEW_MODE)"],{cwd:new URL('..',import.meta.url),env:{...process.env,MT_ITINERARY_REVIEW:mode},encoding:'utf8',windowsHide:true});
  assert.equal(actual,mode);
 }
}

// 不让后续补丁编辑刚生成的内容，原稿不同位置的补丁仍可独立应用。
{
 const compound={...draft,cards:[{...draft.cards[0],content:'Visit A. Visit B.'},draft.cards[1]]};
 const change=(old,text)=>({key:'one.content',old,new:text,kind:'correction',source_ids:[]});
 const edited=await editItinerary({...input,draft:compound,model:async()=>({edits:[change('Visit A.','Visit B.'),change('Visit B.','Walk in B.')],unresolved:[]})});
 assert.equal(edited.applied,2);assert.equal(edited.draft.cards[0].content,'Visit B. Walk in B.');
 const overlap=await editItinerary({...input,draft:compound,model:async()=>({edits:[change('Visit A.','Look at A.'),change('Visit A. Visit B.','Gone')],unresolved:[]})});
 assert.equal(overlap.applied,1);assert.equal(overlap.rejected[0].reason,'overlapping_edit');
 let checks=0;
 const exception=await editItinerary({...input,draft:compound,validate:()=>{if(++checks===2)throw Error('bad second patch');return true;},model:async()=>({edits:[change('Visit A.','Look at A.'),change('Visit B.','Walk in B.')],unresolved:[]})});
 assert.equal(exception.applied,1);assert.equal(exception.draft.cards[0].content,'Look at A. Visit B.');
 const malformed=await editItinerary({...input,model:async()=>({edits:[{...edit,new:5},edit],unresolved:[]})});
 assert.equal(malformed.applied,1);assert.equal(malformed.skipped,1);
 const {deliveryReviewMode}=await import('./lib/light-edit.mjs');
 assert.equal(deliveryReviewMode({action:'generate',requiresDatedEvidence:true,mode:'light'}),'strict');
 assert.equal(deliveryReviewMode({action:'chat',mode:'light'}),'strict');
 assert.equal(deliveryReviewMode({action:'generate',mode:'light'}),'light');
}

// 用户消息引用保留早期兴趣，不能引用助手消息作为需求依据。
{
 const valid=await editItinerary({...input,messages:[{mid:1,role:'user',text:'I like architecture'},{mid:2,role:'assistant',text:'Try a museum'}],model:async()=>({edits:[{...edit,interest_quote:'',interest_message_id:1}],unresolved:[]})});
 assert.equal(valid.applied,1);
 const wrong=await editItinerary({...input,messages:[{mid:1,role:'user',text:'I like architecture'},{mid:2,role:'assistant',text:'Try a museum'}],model:async()=>({edits:[{...edit,interest_quote:'',interest_message_id:2}],unresolved:[]})});
 assert.equal(wrong.applied,0);assert.equal(wrong.rejected[0].reason,'missing_interest_reference');
}
