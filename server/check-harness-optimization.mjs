import assert from 'node:assert/strict';
import workspace from '../mixtouring-hifi/assets/route-workspace.js';
import {buildContext} from './lib/context-builder.mjs';
import {buildEvidenceCatalog,assessEvidenceClaims} from './lib/evidence-grounding.mjs';
import {groundConversationOutput} from './lib/conversation-evidence.mjs';
import {collectTravelSources} from './lib/travel-sources.mjs';
import {sourceId} from './lib/source-relevance.mjs';
import {materialCoverage} from './lib/material-coverage.mjs';
import {conversationTurn} from './fixtures/confirmed-conversation.mjs';

const cards=Array.from({length:40},(_,i)=>({id:'card-day-'+(i+1),place:'城',label:'第'+(i+1)+'天',title:'漫步',content:'- 上午：`青石街`散步。\n- Tips：按兴趣停留。'}));
const draft=workspace.cleanDraft({title:'行程',route:['出发','城'],cards,sections:[],pending:[]});
assert.equal(draft.cards.length,40);
assert.equal(draft.cards[0].activities[0].places[0].name,'青石街');assert.equal(draft.cards[0].tips.length,1);
const updated=workspace.cleanDraft({...draft,cards:[{...draft.cards[0],content:'- 下午：`新街`散步。'}]});
assert.equal(updated.cards[0].activities[0].places[0].name,'新街','不能沿用旧活动索引');
const payload={original_draft:{cards:[cards[0]]},evidence_catalog:{entries:[{id:'needed',title:'青石街',excerpt:'青石街是本地街区。'},...Array.from({length:6},(_,i)=>({id:'unused'+i,title:'无关',excerpt:'资料'.repeat(700)}))]}};
const packed=buildContext({payload,coreRules:'规则',budgetChars:3800});
assert.ok(packed.value.evidence_catalog.entries.some(e=>e.id==='needed'));assert.ok(packed.manifest.omitted_ids.includes('evidence_catalog'));

const historical=await collectTravelSources({destination:'城',purpose:'experience'},async()=>[{title:'城的老街游记',link:'https://bbs.qyer.com/thread-123456-1.html',content:'城的青石街记录。',date:'2019-01-01'}],
  {useCache:false,now:Date.parse('2026-10-28'),assessSources:async(task,sources)=>({status:'completed',items:sources.map(s=>({id:sourceId(s),decision:'keep',quote:s.title,reason:'静态地点背景'}))})});
assert.equal(historical.sources.length,0);assert.equal(historical.archive[0].relevance.decision,'keep');
assert.equal(materialCoverage(historical,['城','另一城'])[1].status,'gap');

const catalog=buildEvidenceCatalog({sources:[{url:'https://example.org/guide',title:'青石街',excerpt:'青石街是当地街区。',date:'2026-10-20'}],now:Date.parse('2026-10-28')});
const source=catalog.entries[0],calls=[];
const two=workspace.cleanDraft({...draft,cards:[cards[0],{...cards[1],content:'景区每天开放。晚上休息。'}]});
const model=async opts=>{calls.push(opts.kind);const p=JSON.parse(opts.user);
  if(opts.kind==='conversation_evidence_extract')return {items:p.fields.map(f=>({id:f.id,text:f.text,needs_source:f.text.includes('每天开放')||f.text.includes('青石街'),
    assertions:f.text.includes('青石街')?[{text:'青石街',allowed_use:'source_reference',supports:[{source_id:source.id,quote:'青石街是当地街区。'}]}]:[],allowed_use:'source_reference',supports:[]}))};
  if(opts.kind==='conversation_evidence_support')return {items:p.claims.map(c=>({id:c.id,decision:'supported',relation:'supports',reason:'原句支持'}))};
  if(opts.kind==='conversation_delivery_patch'){assert.deepEqual(p.fields[0].adjacent_readonly.after,['晚上休息。']);assert.deepEqual(p.fields.map(f=>f.path),['draft.cards[1].content#0']);return {fields:[{path:p.fields[0].path,text:'下午：在住处附近散步。'}]};}
  throw Error('不应整稿重写');
};
const grounded=await groundConversationOutput({reply:'已整理。',draft:two,catalog,model,deliveryMode:true});
assert.match(grounded.draft.cards[1].content,/晚上休息。/);assert.equal(grounded.status,'complete');assert.equal(grounded.repair_scope.kind,'fields');
assert.equal(grounded.draft.cards[0].content,two.cards[0].content);assert.ok(!grounded.draft.cards[1].content.includes('每天开放'));
assert.ok(grounded.claims.some(c=>c.sentence.includes('青石街')));assert.ok(!calls.includes('conversation_delivery'));
for(const [retryable,remaining,expected]of [[true,50000,2],[true,1000,1],[false,50000,1]]){
  let attempts=0;
  const retried=await groundConversationOutput({reply:'建议慢慢散步。',catalog:{entries:[]},remainingMs:()=>remaining,model:async opts=>{
    attempts++;if(attempts===1){opts.onFailure?.({reason_code:retryable?'network_or_timeout':'content_filter',retryable});return null;}
    return {items:JSON.parse(opts.user).fields.map(f=>({...f,needs_source:false,assertions:[]}))};
  }});
  assert.equal(attempts,expected);assert.equal(retried.status==='complete',expected===2);
}
const statements=Array.from({length:35},(_,i)=>'街区'+String.fromCharCode(0x4e00+i)+'有文化活动。');
const manyCatalog=buildEvidenceCatalog({sources:[{url:'https://example.org/many',title:'街区文化',excerpt:statements.join(''),date:'2026-10-20'}],now:Date.parse('2026-10-28')});
const manyClaims=statements.map(text=>({text,allowed_use:'source_reference',supports:[{source_id:manyCatalog.entries[0].id,quote:text}]})),sizes=[];
const assessment=await assessEvidenceClaims(statements.join('\n'),manyCatalog,manyClaims,async opts=>{const p=JSON.parse(opts.user);sizes.push(p.claims.length);return {items:p.claims.map(c=>({id:c.id,decision:'supported',relation:'supports',reason:'对应原句'}))};});
assert.deepEqual(sizes,[24,11]);assert.equal(assessment.items.length,35);assert.ok(assessment.items.every(i=>i.decision==='supported'));

const brief={origin:'北京',destination:'阿拉木图',summary:'经伊宁旅行',wishes:[],open_questions:[]};
const candidate={title:'行程',overview:'城市漫步',route:['北京','伊宁','阿拉木图'],cards:[{id:'card-day-1',place:'伊宁',label:'第1天',title:'漫步',content:'上午在城区散步。'},{id:'card-day-2',place:'阿拉木图',label:'第2天',title:'漫步',content:'下午在城区散步。'},{id:'card-day-3',place:'北京',label:'第3天',title:'返程',content:'回到北京。'}],sections:[],pending:[]};
const queries=[],trace=[];
const improved=await conversationTurn({action:'generate',conversation:{stage:'ready',brief,routing:{origin:'北京',destination:'阿拉木图'},requirements:{trip_days:3,required_stops:['伊宁']}},travel:{trip_type:'round_trip'}},null,{
  now:Date.parse('2026-10-28'),qualityResearch:true,sourceReview:true,onTrace:e=>trace.push(e),
  search:async q=>{queries.push(q);return q.includes('特色美食')?[{title:'伊宁青石街',link:'https://example.org/yining',content:'伊宁的青石街提供城市漫步体验。',date:'2026-10-20'}]:[];},
  model:async opts=>{const p=JSON.parse(opts.user);if(opts.kind==='conversation_source_relevance')return {items:p.candidates.map(s=>({id:s.id,decision:'keep',reason:'当地体验',quote:s.title}))};
    return {intent_action:'revise',reply:'已整理。',ready:true,brief,draft:candidate,preferences:{},travel:{},constraints:{},requirements_patch:{},sights:{}};}
});
assert.equal(improved.status,'ok');assert.equal(trace.filter(t=>t.stage==='material_gap' && t.status==='researching').length,1);
assert.ok(trace.some(t=>t.stage==='conversation_review' && t.status==='skipped'),'首次基础稿不再无条件整稿重写，仍执行后续结构与证据校验');
assert.ok(trace.some(t=>t.stage==='material_gap' && t.status==='completed'));assert.ok(queries.length<=5,'一次缺口最多补充两搜，仍受父预算约束');
for(const [phrase,expectedReview]of [['不必租车。',false],['建议租车自驾。',true]]){
  const events=[];
  const response=await conversationTurn({action:'generate',conversation:{stage:'ready',brief,routing:{origin:'北京',destination:'阿拉木图'},requirements:{trip_days:3,required_stops:['伊宁']}},travel:{trip_type:'round_trip'},constraints:{no_self_drive:true}},null,{
    search:async()=>[],onTrace:e=>events.push(e),model:async opts=>({intent_action:'revise',reply:'已整理。',ready:true,brief,draft:opts.kind==='conversation_review'?candidate:{...candidate,cards:candidate.cards.map((c,i)=>i?c:{...c,content:c.content+phrase})},preferences:{},travel:{},constraints:{},requirements_patch:{},sights:{}})
  });
  assert.equal(response.status,'ok');assert.equal(events.some(e=>e.stage==='conversation_review' && e.status==='started'),expectedReview);
}
console.log('✓ 活动索引、40天保留、选定地点证据保护、历史游记背景准入、城市覆盖与局部事实修复');
let capacity=null;
const longRequest=await conversationTurn({action:'generate',conversation:{stage:'ready',brief:{origin:'甲城',destination:'乙城',summary:'四十天旅行'},routing:{origin:'甲城',destination:'乙城'},requirements:{trip_days:40}}},null,{search:async()=>[],model:async o=>{if(o.instruction_phase==='compose')capacity=JSON.parse(o.user).output_contract.max_cards;return {reply:'本次没有生成日程。',draft:null};}});
assert.equal(capacity,40,'写稿合同随已确认天数变化，不再与60天存储能力冲突地固定为30');
assert.equal(longRequest.status,'unavailable','仅有回复没有日卡不能当正式生成成功');
