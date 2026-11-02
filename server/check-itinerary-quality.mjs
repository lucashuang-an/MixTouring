import assert from 'node:assert/strict';
import {hollowDayIssues,ensureItineraryQuality} from './lib/itinerary-quality.mjs';
import {conversationTurn} from './fixtures/confirmed-conversation.mjs';
import {checkTravelDelivery,taskOutcome} from './lib/travel-completion.mjs';
const cards=[{id:'card-day-1',place:'甲城',label:'第1天',title:'峡谷一日',content:'- 傍晚：返回甲城，早点休息。\n- 提醒：带水和防晒。'},
 {id:'card-day-2',place:'甲城',label:'第2天',title:'城市漫步',content:'- 上午：在青石街漫步，看建筑。'},
 {id:'card-day-3',place:'乙城',label:'第3天',title:'飞回乙城',content:'- 全天：飞回乙城。'}];
const draft={title:'三日',overview:'峡谷与街区',route:['乙城','甲城'],cards,sections:[],pending:[]};
assert.deepEqual(hollowDayIssues(draft).map(i=>i.card_ids[0]),['card-day-1']);
assert.deepEqual(hollowDayIssues({...draft,cards:[{...cards[0],title:'休整日',content:'睡到自然醒，休息。'}]}),[]);
assert.deepEqual(hollowDayIssues({...draft,cards:[{...cards[0],content:'- 全天：游览青石峡谷，欣赏岩壁。'}]}),[],'没有反引号不等于没有活动');
const review=(valid)=>({cards:cards.map(c=>({id:c.id,role:c.id==='card-day-3'?'transport':'activity',activity_present:c.id!=='card-day-1'||valid,title_matches:c.id!=='card-day-1'||valid})),summary_matches:true,issues:[]});
let reviews=0,patches=0,verified=0;
const fixed=await ensureItineraryQuality({draft,current:{},catalog:{entries:[]},model:async o=>{
 if(o.kind==='conversation_quality_review')return review(++reviews>1);
 patches++;const p=JSON.parse(o.user);assert.deepEqual(p.targets.map(c=>c.id),['card-day-1']);
 return {cards:[{id:'card-day-1',title:'峡谷一日',content:'- 全天：游览青石峡谷，欣赏岩壁。'}]};
},verify:async(candidate,scope)=>{verified++;assert.deepEqual(scope.card_ids,['card-day-1']);assert.deepEqual(candidate.cards[1],cards[1]);return {accepted:true};}});
assert.equal(fixed.status,'passed');assert.equal(patches,1);assert.equal(verified,1);assert.deepEqual(fixed.draft.cards[2],cards[2]);assert.equal(draft.cards[0].content,cards[0].content);
const rejected=await ensureItineraryQuality({draft,current:{},model:async o=>o.kind==='conversation_quality_review'?review(false):{cards:[{id:'card-day-1',title:'峡谷一日',content:'新地点每天开放。'}]},verify:async()=>({accepted:false})});
assert.equal(rejected.status,'needs_repair');assert.deepEqual(rejected.draft,draft,'证据未通过不提交补丁');
const escaped=await ensureItineraryQuality({draft,current:{},model:async o=>o.kind==='conversation_quality_review'?review(false):{cards:[{id:'card-day-2',title:'篡改',content:'篡改无关日。'}]},verify:async()=>{throw Error('越界补丁不进入核对');}});
assert.deepEqual(escaped.draft,draft);assert.equal(escaped.repair,'invalid_shape');
const unavailable=await ensureItineraryQuality({draft,current:{},model:async()=>null,verify:async()=>({accepted:true})});assert.equal(unavailable.status,'unreviewed');
const contract=checkTravelDelivery({draft,routing:{origin:'乙城',destination:'甲城'},requirements:{trip_days:3},quality:unavailable});
assert.equal(contract.valid,true);assert.equal(contract.passed,false);assert.equal(taskOutcome({status:'ok',task_status:'partial',delivery_validation:contract,conversation:{draft}}),'active');
// 跨日／概览问题必须被送入局部修复，不允许改路线或无关日。
let crossPass=0;
const cross=await ensureItineraryQuality({draft:{...draft,cards:[{...cards[0],content:'参加两日团，晚上在外过夜。'},cards[1],cards[2]]},current:{},
 model:async o=>{if(o.kind==='conversation_quality_review')return {...review(true),summary_matches:++crossPass>1,issues:crossPass===1?[{code:'cross_day_conflict',card_ids:['card-day-1','card-day-2'],quote:'参加两日团',reason:'次日另有城市活动'}]:[]};
  const p=JSON.parse(o.user);assert.equal(p.targets.length,2);assert.ok(p.summary);
  return {cards:[{id:'card-day-1',title:'峡谷一日',content:'游览青石峡谷。'},{id:'card-day-2',title:'城市漫步',content:'青石街散步。'}],summary_fields:[{path:'overview',text:'峡谷和城市各一天'}]};},verify:async()=>({accepted:true})});
assert.equal(cross.status,'passed');assert.deepEqual(cross.draft.route,draft.route);assert.deepEqual(cross.draft.cards[2],cards[2]);
// 正式对话返回可用初稿，但不得把空心日卡判成完成。
const brief={origin:'乙城',destination:'甲城',summary:'三天',wishes:[],open_questions:[]};
const partial=await conversationTurn({action:'generate',conversation:{stage:'ready',brief,routing:{origin:'乙城',destination:'甲城'},requirements:{trip_days:3}},travel:{trip_type:'round_trip'}},null,{
 search:async()=>[],model:async()=>({intent_action:'revise',brief,ready:true,reply:'完整攻略已生成。',draft,preferences:{},travel:{},constraints:{},sights:{}})});
assert.equal(partial.status,'ok');assert.equal(partial.task_status,'partial');assert.equal(partial.task.state,'active');assert.equal(partial.conversation.draft.cards.length,3);assert.match(partial.reply,/还需要完善/);assert.equal(partial.conversation.draft.quality_status,'partial');
const workspace=(await import('../mixtouring-hifi/assets/route-workspace.js')).default;assert.equal(workspace.cleanDraft(partial.conversation.draft).quality_status,'partial','保存恢复不能丢掉未完成状态');
console.log('✓ 最终质量：空心日卡、无高亮有效活动、交通休整豁免、局部范围、证据拒绝、跨日冲突、概览一致与真实完成状态');

let fullReviews=0,deltaChecks=0;
const groundedRepair=await conversationTurn({action:'generate',conversation:{stage:'ready',brief,routing:{origin:'乙城',destination:'甲城'},requirements:{trip_days:3}},travel:{trip_type:'round_trip'}},null,{
 now:Date.parse('2026-10-29'),budgetMs:10000,semanticReview:true,evidenceReview:true,
 search:async()=>[{title:'甲城青石峡谷',link:'https://example.org/canyon',content:'青石峡谷位于甲城，适合步行游览。',date:'2026-10-28'}],
 model:async o=>{const p=JSON.parse(o.user);
  if(o.kind==='conversation_quality_review')return review(++fullReviews>1);
  if(o.kind==='conversation_quality_repair'){assert.ok(o.timeoutMs<10000,'按实际剩余时间限制调用，不用预估时长提前放弃');return {cards:[{id:'card-day-1',title:'峡谷一日',content:'- 全天：游览`青石峡谷`。'}]};}
  if(o.kind==='conversation_evidence_extract'){if(p.fields.some(f=>f.text.includes('青石峡谷')))deltaChecks++;
   return {items:p.fields.map(f=>{const needs=f.text.includes('青石峡谷'),source=p.evidence_catalog.entries.find(e=>e.excerpt.includes('青石峡谷'));
    return {...f,needs_source:needs,assertions:needs?[{text:'青石峡谷',allowed_use:'source_reference',supports:source?[{source_id:source.id,quote:'青石峡谷位于甲城'}]:[]}]:[]};})};}
  if(o.kind==='conversation_evidence_support')return {items:p.claims.map(c=>({id:c.id,decision:'supported',relation:'supports',reason:'对应原句'}))};
  return {intent_action:'revise',brief,ready:true,reply:'已生成。',draft,preferences:{},travel:{},constraints:{},sights:{}};
 }});
assert.equal(groundedRepair.status,'ok');assert.equal(groundedRepair.task.state,'satisfied');assert.ok(deltaChecks>0,'质量修复后实际调用证据核对');
assert.match(groundedRepair.conversation.draft.cards[0].content,/青石峡谷/);assert.equal(groundedRepair.conversation.draft.cards[1].content,cards[1].content);
assert.ok(groundedRepair.sources.some(s=>s.url==='https://example.org/canyon'),'局部新证据合并到最终引用');

// allowRepair=false用于补丁验收，拒绝事实时不得暗中触发整稿重写。
const {groundConversationOutput}=await import('./lib/conversation-evidence.mjs');let wholeRewrites=0;
const refused=await groundConversationOutput({reply:'',draft:{...draft,cards:[{...cards[0],content:'景区每天开放。'}]},catalog:{entries:[]},deliveryMode:true,allowRepair:false,model:async o=>{
 if(o.kind==='conversation_delivery')wholeRewrites++;
 if(o.kind==='conversation_evidence_extract')return {items:JSON.parse(o.user).fields.map(f=>({...f,needs_source:f.text.includes('每天开放'),assertions:[],supports:[]}))};
 return {items:[]};
}});assert.equal(wholeRewrites,0);assert.notEqual(refused.status,'complete');

// 事实删句后必须重新做质量判断，不能沿用修复前的通过状态。
let afterDeletionReviews=0;
const deletedAgain=await ensureItineraryQuality({draft,current:{},model:async o=>o.kind==='conversation_quality_review'?review(++afterDeletionReviews>1):{cards:[{id:'card-day-1',title:'峡谷一日',content:'游览峡谷。'}]},
 verify:async candidate=>({accepted:true,draft:{...candidate,cards:candidate.cards.map(c=>c.id==='card-day-1'?{...c,content:cards[0].content}:c)}})});
assert.equal(deletedAgain.status,'needs_repair');assert.ok(deletedAgain.issues.some(i=>i.code==='missing_activity'));
const summaryEscaped=await ensureItineraryQuality({draft,current:{},model:async o=>o.kind==='conversation_quality_review'?review(false):{cards:[{id:'card-day-1',title:'峡谷一日',content:'游览峡谷。'}],summary_fields:[{path:'route.0',text:'其他城市'}]},verify:async()=>{throw Error('非法路径不得进入核对');}});
assert.equal(summaryEscaped.repair,'invalid_summary');assert.deepEqual(summaryEscaped.draft,draft);

const mealOnly={...cards[0],content:'有相关一日游方案，具体团型以实际为准。\n- 中午：沿途体验当地特色美食。\n- 傍晚：返回甲城。'};
assert.ok(hollowDayIssues({...draft,cards:[mealOnly]}).some(i=>i.code==='title_mismatch'),'团型说明和吃饭不能替代峡谷主活动');
assert.deepEqual(hollowDayIssues({...draft,cards:[{...mealOnly,title:'当地美食一日'}]}),[],'美食日的用餐体验不能被误伤');

let fallbackCalls=0;
await groundConversationOutput({reply:'',draft:{...draft,cards:[{...cards[0],content:'景区每天开放。'}]},catalog:{entries:[]},deliveryMode:true,allowRepair:true,repairScope:'fields',model:async o=>{
 if(o.kind==='conversation_delivery')fallbackCalls++;
 if(o.kind==='conversation_evidence_extract')return {items:JSON.parse(o.user).fields.map(f=>({...f,needs_source:f.text.includes('每天开放'),assertions:[],supports:[]}))};
 if(o.kind==='conversation_delivery_patch')return null;
 return {items:[]};
}});assert.equal(fallbackCalls,0,'局部补丁核对不能后退到整稿重写');

// 正文已完整，只有助手自提的标题／概览未同步：只改元数据，不能再改正文。
const summaryDraft={...draft,overview:'教堂与老街',cards:[{id:'card-day-1',place:'甲城',label:'第1天',title:'教堂与老街',content:'- 上午：在`老街`漫步，看街区建筑。'}]};
let syncReviews=0,syncWrites=0;
const synced=await ensureItineraryQuality({draft:summaryDraft,current:{},model:async o=>{
 if(o.kind==='conversation_quality_review'){const good=++syncReviews>1;return {cards:[{id:'card-day-1',role:'activity',activity_present:true,title_matches:good}],summary_matches:good,issues:good?[]:[{code:'title_mismatch',card_ids:['card-day-1'],quote:'教堂与老街',reason:'正文没有教堂'}]};}
 if(o.kind==='conversation_quality_sync'){syncWrites++;return {blocked:false,titles:[{id:'card-day-1',title:'老街漫步'}],summary_fields:[{path:'overview',text:'老街漫步'}]};}
 throw Error('不能重复写正文');
},verify:async(value,scope)=>{assert.equal(scope.title_only,true);assert.equal(value.cards[0].content,summaryDraft.cards[0].content);return {accepted:true,draft:value};}});
assert.equal(synced.status,'passed');assert.equal(syncWrites,1);assert.equal(synced.draft.cards[0].content,summaryDraft.cards[0].content);assert.equal(summaryDraft.cards[0].title,'教堂与老街');

let disguisedSync=0;
const disguised=await ensureItineraryQuality({draft:{...summaryDraft,overview:'峡谷一日',cards:[{...summaryDraft.cards[0],title:'峡谷一日',content:'- 上午：在`游客中心`询问团型。\n- 傍晚：返回住处。'}]},current:{},model:async o=>{
 if(o.kind==='conversation_quality_review')return {cards:[{id:'card-day-1',role:'transport',activity_present:false,title_matches:false}],summary_matches:true,issues:[]};
 if(o.kind==='conversation_quality_sync')disguisedSync++;
 return null;
},verify:async()=>({accepted:true})});
assert.equal(disguisedSync,0,'只有高亮地点但没有实质活动，不能靠同步标题通过');assert.notEqual(disguised.status,'passed');

// 已确认返程的同义标题不能被确定性规则误判为缺活动，导致补景点删返程。
assert.deepEqual(hollowDayIssues({cards:[{id:'return',title:'巴厘岛返回北京',content:'上午：整理行李。\n下午：返回北京。'}]}),[]);
// 长稿容量边界：上下文装不下时必须保留完整草案，并明确尚未完成质量核对。
const {buildContext}=await import('./lib/context-builder.mjs');
const longDraft={...draft,overview:'城市慢逛',cards:Array.from({length:40},(_,i)=>({id:'card-day-'+(i+1),place:'甲城',label:'第'+(i+1)+'天',title:'街区慢逛',content:'上午：在街区散步。下午：按体力安排休息。'.repeat(35)}))};
let overflow=false;
const longResult=await ensureItineraryQuality({draft:longDraft,current:{requirements:{trip_days:40}},model:async o=>{try{buildContext({payload:JSON.parse(o.user),coreRules:o.schema_prompt});}catch(e){overflow=e.code==='CONTEXT_BUDGET_EXCEEDED';throw e;}return null;},verify:async()=>({accepted:false})});
assert.equal(overflow,false,'长稿分批请求不得超过单次上下文预算');assert.equal(longResult.status,'unreviewed');assert.deepEqual(longResult.draft,longDraft);assert.equal(longResult.checked,false);
