import assert from 'node:assert/strict';import {reviewFinalItinerary} from './lib/final-review.mjs';import {conversationTurn} from './lib/conversation.mjs';import {conversationTurn as confirmedTurn} from './fixtures/confirmed-conversation.mjs';
const draft={title:'河内—岘港',overview:'文化与美食',route:['北京','河内','岘港'],sections:[],pending:[],cards:[{id:'day1',label:'第1天',place:'河内',title:'老城',content:'上午：在`还剑湖`散步。'},{id:'day2',label:'第2天',place:'岘港',title:'文化',content:'上午：租车前往`占婆雕塑博物馆`。下午：在`汉市场`选当地小吃。'}]};
const current={requirements:{required_stops:[]},routing:{origin:'北京',destination:'岘港'},constraints:{no_self_drive:true}};
const check=()=>[];let calls=0;
const fixed=await reviewFinalItinerary({draft,current,check,catalog:{entries:[]},model:async()=>{calls++;return {issues:[{id:'drive',decision:'issue',kind:'user_requirement',severity:'major',reason:'用户不自驾',card_ids:['day2'],resolved:true}],changes:[{issue_id:'drive',path:'cards.1.content',old:draft.cards[1].content,value:'上午：前往`占婆雕塑博物馆`参观。下午：在`汉市场`选当地小吃。'}],reply:'已保留两个地点，去掉租车安排。'};}});
assert.equal(calls,1);assert.equal(fixed.status,'passed');assert(fixed.draft.cards[1].content.includes('汉市场'));assert.deepEqual(fixed.draft.cards[0],draft.cards[0]);assert(draft.cards[1].content.includes('租车'));
const unauthorized=await reviewFinalItinerary({draft,current,check,scope:['day1'],model:async()=>({issues:[{id:'drive',decision:'issue',kind:'user_requirement',severity:'major',reason:'无车且影响目标日衔接',card_ids:['day1','day2'],resolved:true}],changes:[{issue_id:'drive',path:'cards.1.content',old:draft.cards[1].content,value:'自由活动'}]})});assert.deepEqual(unauthorized.draft,draft);assert.equal(unauthorized.status,'needs_repair');
const failed=await reviewFinalItinerary({draft,current,check,model:async()=>null});assert.equal(failed.status,'unreviewed');assert.deepEqual(failed.draft,draft);
const noSource=await reviewFinalItinerary({draft,current,check,model:async()=>({issues:[{id:'missing',kind:'missing_source',reason:'没有景点出处',card_ids:['day2'],resolved:true}],changes:[]})});assert.equal(noSource.status,'unreviewed');assert.deepEqual(noSource.draft,draft);
const cancelled=new AbortController();cancelled.abort();await assert.rejects(reviewFinalItinerary({draft,current,check,signal:cancelled.signal,model:()=>assert.fail()}));
const kinds=[];const brief={origin:'北京',destination:'越南',summary:'越南文化三天',wishes:['想去河内文庙'],open_questions:[]};
const outline=await conversationTurn({text:'北京出发去越南三天，想去河内文庙，先给个方案',preferences:{},travel:{trip_type:'one_way'}},null,{deliveryReview:'final',search:async()=>[],model:async o=>{kinds.push(o.kind);if(o.kind==='planning_outline')return {options:[{title:'河内',description:'参观河内文庙，穿插老城散步。',outbound_days:0,return_days:0,segments:[{place:'河内',days:3,scope:'越南'}],memberships:[]}]};if(o.kind!=='conversation')assert.fail('讨论不应逐项审批 '+o.kind);return {intent_action:'discuss',reply:'先围绕河内安排。',brief,ready:true,planning:{action:'propose',scopes:[{name:'越南',level:'country'}]},requirements_patch:{trip_days:3},preferences:{},travel:{trip_type:'one_way'},constraints:{},sights:{}};}});
assert.equal(outline.status,'ok');assert.equal(outline.conversation.discussion.options.length,1);assert.match(outline.reply,/文庙/);assert.deepEqual(kinds,['conversation','planning_outline']);
let generatedCalls=[];const itinerary={...draft,route:['北京','河内'],cards:[{...draft.cards[0],label:'第1天'},{...draft.cards[1],label:'第2天',place:'河内',content:'下午：在`河内文庙`参观，预留约2小时。'}]};
const delivered=await confirmedTurn({action:'generate',conversation:{stage:'ready',brief:{origin:'北京',destination:'河内',summary:'河内两天单程'},requirements:{trip_days:2}},travel:{trip_type:'one_way'}},null,{deliveryReview:'final',search:async()=>[],model:async o=>{generatedCalls.push(o.kind);if(o.kind==='conversation_final_review')return {issues:[],changes:[],reply:''};if(o.kind!=='conversation')assert.fail('不应多轮审核 '+o.kind);return {reply:'行程已整理。',draft:itinerary};}});
assert.equal(delivered.status,'ok',delivered.reply);assert.equal(delivered.task_status,'delivered');assert.equal(delivered.delivery_validation.review_mode,'final');assert.deepEqual(generatedCalls,['conversation','conversation_final_review']);assert(delivered.conversation.draft.cards[1].content.includes('河内文庙'));
assert(!delivered.delivery_validation.checks.some(c=>c.name==='numeric_support'),'规划时间估算不冒充外部数字核实');
console.log('✓ 交互优先：空资料仍保留景点／范围方案、单程成稿仅一次终检、显著错误局部修正、越界拒绝、失败保留、取消通过');

// 后续问题的补丁不得撤销已经修好的必去城市，也不能对拒绝的补丁声称全部完成。
const missingCity={...draft,route:['北京','河内']};
const regression=await reviewFinalItinerary({draft:missingCity,current,check:d=>[{name:'required_stops',status:d.route.includes('岘港')&&d.cards.some(c=>c.place==='岘港')?'passed':'failed'}],model:async()=>({issues:[{id:'route',decision:'issue',kind:'route',severity:'major',reason:'路线漏了岘港',card_ids:[],resolved:true},{id:'place',decision:'issue',kind:'route',severity:'major',reason:'卡片城市需要核对',card_ids:['day2'],resolved:true}],changes:[{issue_id:'route',path:'route',old:missingCity.route,value:draft.route},{issue_id:'place',path:'cards.1.place',old:'岘港',value:'河内'}],reply:'所有问题都已修正。'})});
assert.deepEqual(regression.draft.route,draft.route);assert.equal(regression.draft.cards[1].place,'岘港');assert.equal(regression.applied,1);assert.equal(regression.status,'needs_repair');assert(!regression.notice.includes('所有问题都已修正'));assert(regression.notice.includes('城市需要核对'));

const {outlineDayPlan,allocationMessage}=await import('./lib/itinerary-constraints.mjs');
const daily=outlineDayPlan({route:['北京','河内','岘港'],outbound_days:1,return_days:1,segments:[{place:'河内',days:3},{place:'岘港',days:2}]});
assert.equal(daily.length,7);assert.deepEqual(daily.filter(x=>x.city==='河内').map(x=>x.day),[2,3,4]);assert.deepEqual(daily.filter(x=>x.city==='岘港').map(x=>x.day),[5,6]);assert.equal(daily[0].role,'outbound');assert.equal(daily[6].role,'return');
assert(!allocationMessage([{place:'河内',before_days:3,after_days:2}],{accepted:false}).includes('以当前'));assert(allocationMessage([{place:'Hanoi',before_days:3,after_days:2}],{accepted:false,en:true}).includes('still needs adjustment'));

const minor=await reviewFinalItinerary({draft,current,check,model:async()=>({issues:[{id:'minor',decision:'issue',kind:'critical_fact',severity:'minor',reason:'咖啡馆营业尚未确认，不构成显著错误',card_ids:['day1'],resolved:false}],changes:[],reply:'需要继续核实咖啡馆。'})});assert.equal(minor.status,'passed');assert.deepEqual(minor.draft,draft);assert.equal(minor.notice,'');

const localOnly=await reviewFinalItinerary({draft,current,check,scope:['day1'],model:async o=>{const p=JSON.parse(o.user);assert.equal(p.revision_scope,'local');assert.deepEqual(p.readonly_card_ids,['day2']);return {issues:[{id:'old-day',decision:'issue',kind:'user_requirement',severity:'major',reason:'把单日偏好错当成其他日期要求',card_ids:['day2'],resolved:false}],changes:[],reply:'其他日期也必须修改。'};}});assert.equal(localOnly.status,'passed');assert.equal(localOnly.notice,'');assert.equal(localOnly.ignored_outside_scope,1);assert.deepEqual(localOnly.draft,draft);

const compliant=await reviewFinalItinerary({draft,current,check,scope:['day1'],model:async()=>({issues:[{id:'already-ok',decision:'ok',kind:'user_requirement',severity:'major',reason:'目标日已符合，其他日期不构成违规',card_ids:['day1','day2'],resolved:false}],changes:[],reply:'全部已经符合要求。'})});assert.equal(compliant.status,'passed');assert.equal(compliant.notice,'');assert.deepEqual(compliant.draft,draft);

{
 const before={stage:'draft',brief:{origin:'北京',destination:'河内',summary:'河内两天'},routing:{origin:'北京',destination:'河内'},requirements:{trip_days:2},draft:{...itinerary,cards:itinerary.cards.map((c,i)=>({...c,id:'card-day-'+(i+1)}))}};const wrong='上午：逛市场。下午：参观博物馆。',right='上午：参观博物馆。下午：逛市场。',receipt='第2天已改为上午博物馆、下午市场，其他日期不变。';
 const corrected=await conversationTurn({text:'只改第2天，上午博物馆、下午市场，其他日期不变。',conversation:before,travel:{trip_type:'one_way'}},null,{deliveryReview:'final',search:async()=>[],model:async o=>{
  if(o.kind==='conversation_intent')return {intent_action:'revise'};
  if(o.kind==='conversation')return {reply:'上午市场、下午博物馆。',intent_action:'revise',brief:before.brief,routing:before.routing,ready:true,requirements_patch:{},preferences:{},travel:{},constraints:{},sights:{}};
  if(o.kind==='conversation_local_revision')return {reply:'上午市场、下午博物馆。',cards:[{id:before.draft.cards[1].id,title:'文化与市场',content:wrong}],summary_fields:[]};
  if(o.kind==='conversation_final_review')return {issues:[{id:'order',decision:'issue',kind:'user_requirement',severity:'major',card_ids:[before.draft.cards[1].id],reason:'活动顺序与要求相反',resolved:true}],changes:[{issue_id:'order',path:'cards.1.content',old:wrong,value:right}],reply:receipt};
  throw Error('unexpected '+o.kind);
 }});assert.equal(corrected.status,'ok',corrected.reply);assert.equal(corrected.conversation.draft.cards[1].content,right);assert.equal(corrected.reply,receipt);for(const [key,value] of Object.entries(before.draft.cards[0]))assert.deepEqual(corrected.conversation.draft.cards[0][key],value);
}
