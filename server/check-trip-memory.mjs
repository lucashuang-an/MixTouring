/* M1修复回归：实际编排中的用户出处、预览原子提交、恢复与隔离；无网络无密钥。 */
import assert from 'node:assert/strict';
import {cleanMemory,extractMemoryCandidates,commitMemoryDecisions,decisionIndexForPrompt,revokeMemoryEntry} from './lib/trip-memory.mjs';
import {conversationTurn,cleanConversation} from './lib/conversation.mjs';
const brief={origin:'北京',destination:'阿拉木图',summary:'自然与文化',wishes:[],open_questions:[]};
const base={stage:'ready',revision:2,brief,routing:{origin:'北京',destination:'阿拉木图'}};
const payload=(over={})=>({intent_action:'discuss',reply:'继续保留条件。',brief,ready:true,confirmed:false,preferences:{},travel:{},constraints:{},sights:{},requirements_patch:{},...over});
const user={mid:3,role:'user',text:'我选择经伊宁'};
const candidate={kind:'choice',summary:'选择经伊宁，因为想沿途停留',message_refs:[3],evidence_refs:[]};
const history=[{mid:1,role:'user',text:'想看自然与文化'},{mid:2,role:'assistant',text:'可以考虑伊宁'}];
const input={text:user.text,current_message:user,conversation:base,messages:history};
const deps={model:async()=>payload({memory_patch:{decisions:[candidate]}}),search:async()=>[]};
{
  const checks=extractMemoryCandidates({decisions:[candidate,{...candidate,message_refs:[2]},{...candidate,message_refs:[]},{...candidate,message_refs:[3],evidence_refs:['https://evil.example/']}]},{userMessages:[...history,user],currentMessageId:3});
  assert.equal(checks.accepted.length,1);assert.equal(checks.rejected.length,3);
  const result=await conversationTurn(input,null,deps);
  assert.equal(result.status,'ok');assert.deepEqual(result.conversation.memory.entries[0].message_refs,[3]);
  assert.equal(result.conversation.memory.entries[0].base_revision,result.conversation.revision);
  const same=await conversationTurn({...input,conversation:result.conversation},null,deps);
  assert.equal(same.conversation.memory.entries.length,1,'同消息重试不重复记忆');
  const legacy=await conversationTurn({...input,current_message:undefined},null,deps);
  assert.equal(legacy.status,'ok');assert.equal(legacy.conversation.memory.entries.length,0,'无本轮身份的旧调用正常继续但不编记忆');
}
{
  let memory=commitMemoryDecisions(cleanMemory(),[candidate],{baseRevision:3});
  memory=commitMemoryDecisions(memory,[{...candidate,kind:'correction',summary:'取消途经伊宁',message_refs:[5],supersedes:'mem_1'}],{baseRevision:4});
  assert.equal(memory.entries[0].status,'superseded');
  assert.deepEqual(decisionIndexForPrompt(memory).entries.map(e=>e.id),['mem_2']);
  memory=revokeMemoryEntry(memory,'mem_2');assert.equal(decisionIndexForPrompt(memory).entries.length,0);
  const unknown=cleanMemory({schema_version:99,entries:[{raw:'不能丢失'}]});
  assert.equal(unknown.degraded,true);assert.deepEqual(unknown.unrecognized.entries,[{raw:'不能丢失'}]);
  const again=cleanConversation({memory:unknown});assert.equal(again.memory.degraded,true);
  assert.deepEqual(commitMemoryDecisions(again.memory,[candidate]).unrecognized,unknown.unrecognized);
  const old=cleanConversation({stage:'draft'});assert.equal(old.memory.entries.length,0);assert.equal(old.summaries.items.length,0);
}
const draft={title:'十天探索',overview:'交通仍待核实',route:['北京','伊宁','阿拉木图'],cards:[{id:'card-a',place:'阿拉木图',label:'第1—10天',title:'阶段预留',content:'待核实交通后安排。'}],sections:[],pending:['班次待查']};
{
  const url='https://example.com/experience';
  const generate=async source=>{
    const model=async opts=>{
      if(opts.kind==='conversation_intent')return {intent_action:'preview',requirements_patch:{trip_days:7}};
      if(opts.kind==='conversation_review')return {reply:'压缩为七天的备选。',draft:{...draft,cards:[{...draft.cards[0],label:'第1—7天'}]}};
      return payload({intent_action:'preview',requirements_patch:{trip_days:7},draft:{...draft,cards:[{...draft.cards[0],label:'第1—7天'}]},search_query:source?'阿拉木图旅行':null,memory_patch:{decisions:[{...candidate,summary:'比较七天安排',evidence_refs:source?[url]:[]}]}});
    };
    return conversationTurn({...input,text:'如果只有七天呢',current_message:{...user,text:'如果只有七天呢'},conversation:{...base,stage:'draft',draft,requirements:{trip_days:10,required_stops:['伊宁']}}},null,{model,search:async q=>source && !q.includes('site:')?[{title:'阿拉木图旅行参考',link:url,content:'当地文化和自然的旅行体验。',date:'2026-10-18'}]:[],now:Date.parse('2026-10-19T04:00:00Z')});
  };
  for(const source of [false,true]){
    const preview=await generate(source);assert.equal(preview.status,'ok');
    assert.equal(preview.conversation.requirements.trip_days,10);assert.equal(preview.conversation.memory.entries.length,0);
    assert.equal(preview.conversation.preview.memory_candidates.length,1);
    if(source)assert.deepEqual(preview.conversation.preview.memory_evidence_refs,[url]);
    const restored=JSON.parse(JSON.stringify(preview.conversation));
    const adopted=await conversationTurn({action:'accept_preview',conversation:restored,messages:[...history,user]});
    assert.equal(adopted.status,'ok');assert.equal(adopted.conversation.requirements.trip_days,7);
    assert.equal(adopted.conversation.preview,null);assert.equal(adopted.conversation.memory.entries.length,1);
    assert.deepEqual(adopted.conversation.memory.entries[0].evidence_refs,source?[url]:[]);
    assert.deepEqual(adopted.sources,[],'历史决策出处不升级现时证据，不重搜或续期');
    const legacySignature=JSON.parse(restored.preview.base_signature);
    legacySignature.anchors={};legacySignature.travel={trip_type:'pending',traveler_count:1};
    const oldDefault={...restored,preview:{...restored.preview,base_signature:JSON.stringify(legacySignature)}};
    const formRestored=await conversationTurn({action:'accept_preview',conversation:oldDefault,messages:[...history,user],travel:{traveler_count:1},anchors:{outbound:null,return:null}});
    assert.equal(formRestored.status,'ok','旧快照空锚点和未定类型与表单默认值语义等价');
    const actualChange=await conversationTurn({action:'accept_preview',conversation:oldDefault,messages:[...history,user],travel:{traveler_count:2}});
    assert.equal(actualChange.status,'unavailable','真实人数变化仍拦截旧预览');
    const discarded=await conversationTurn({action:'discard_preview',conversation:restored});
    assert.equal(discarded.conversation.preview,null);assert.equal(discarded.conversation.memory.entries.length,0);
    assert.equal(discarded.conversation.requirements.trip_days,10);
    const stale=await conversationTurn({action:'accept_preview',conversation:{...restored,revision:3},messages:[...history,user]});
    assert.equal(stale.status,'unavailable');assert.equal(stale.conversation.requirements.trip_days,10);
    const invalid=await conversationTurn({action:'accept_preview',conversation:restored,messages:history});
    assert.equal(invalid.status,'unavailable','出处未恢复时整次采纳失败');assert.equal(invalid.conversation.requirements.trip_days,10);
  }
}
{
  let digestCalls=0;
  const messages=Array.from({length:64},(_,i)=>({mid:i+1,role:i%2?'assistant':'user',text:i===0?'必须途经伊宁，因为想看沿途文化':'继续讨论可调整的安排'}));
  const run=async state=>conversationTurn({text:'先聊安排',conversation:state,messages},null,{model:async opts=>{
    if(opts.kind==='conversation_digest'){digestCalls++;const c=JSON.parse(opts.user);assert.equal(c.messages.length,8);return {summary:'用户必经伊宁，想了解沿途文化[1]'};}
    return payload();
  },search:async()=>[]});
  let state={...base,requirements:{required_stops:['伊宁']}};
  for(let i=0;i<6;i++){const r=await run(state);assert.equal(r.status,'ok');state=r.conversation;}
  assert.equal(digestCalls,6);const count=state.summaries.items.length;
  const r=await run(state);assert.equal(r.status,'ok');assert.equal(digestCalls,6,'同范围不反复压缩');assert.equal(r.conversation.summaries.items.length,count);
  assert.deepEqual(r.conversation.requirements.required_stops,['伊宁']);
}
console.log('✓ M1用户出处、去重、未知格式保留、预览生成/采纳/丢弃/恢复及长对话摘要通过');
