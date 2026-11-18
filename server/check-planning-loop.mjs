import {revisionDayScope} from './lib/planning-loop.mjs';
import assert from 'node:assert/strict';
import {planWorkspace,taskContract,assessDelivery,applyDayPatch,invalidation,routeMatchesIntent} from './lib/planning-state.mjs';
import {evaluateDay,routeFactCatalog,supportsRouteFact} from './lib/planning-mobility.mjs';
import {createPlanningProgress} from './lib/planning-progress.mjs';
import {runPlanningLoop,reorderDay,preserveOutsideScope,dayOnlyPreferenceScope} from './lib/planning-loop.mjs';
import {createAgentRuntime} from './lib/agent-runtime.mjs';
import {checkDaySchedule} from './lib/planning-mobility.mjs';
import {conversationTurn,cleanConversation} from './fixtures/confirmed-conversation.mjs';
const draft={title:'测试',overview:'安排',route:['上海','济州岛'],cards:[{id:'card-day-1',place:'济州岛',label:'第1天',title:'海岸',content:'上午：游览`A`。\n下午：游览`B`。\n晚上：回到`A`。'},{id:'card-day-2',place:'济州岛',label:'第2天',title:'街区',content:'上午：游览`C`。'}],sections:[],pending:[]};
const first=planWorkspace(draft,{no_self_drive:true});
assert(routeMatchesIntent(['甲','乙','丙'],{origin:'甲',destination:'乙'},{required_stops:['丙']}));
assert(!routeMatchesIntent(['甲','乙','丙'],{origin:'甲',destination:'乙'},{}),'未授权的后续城市仍须拒绝');
assert(!routeMatchesIntent(['甲','丙'],{origin:'甲',destination:'乙'},{required_stops:['丙']}),'不能遗漏主目的地');
assert(dayOnlyPreferenceScope('把第2天放轻松，其余各天不改',draft));
assert(dayOnlyPreferenceScope('不要改全程节奏，只改第2天轻松一点',draft));
assert(!dayOnlyPreferenceScope('第2天少一点活动，全程也慢一点',draft));
assert.equal(first.activities.length,4);assert.notEqual(first.activities[0].id,first.activities[2].id);assert.equal(first.gaps.filter(g=>g.type==='unknown_anchor').length,4);
const edited=applyDayPatch(draft,{cards:[{id:'card-day-1',title:'海岸',content:'上午：游览`A`。\n晚上：回到`A`。'}]},['card-day-1']);
assert.deepEqual(edited.cards[1].content,draft.cards[1].content);
const second=planWorkspace(edited,{no_self_drive:true},first);
assert.equal(first.activities[2].id,second.activities[1].id);
assert.deepEqual(invalidation(first,second).day_ids,['card-day-1']);
assert.throws(()=>applyDayPatch(draft,{cards:[{id:'card-day-2',title:'x',content:'x'}]},['card-day-1']),/patch_scope/);
assert.equal(assessDelivery(taskContract(),{content:true,grounding:true}).passed,true);
assert.equal(assessDelivery(taskContract({verifyMobility:true}),{content:true,grounding:true}).passed,false);
const points=['A','B','C'].map(name=>({name,provider_id:name}));
const events=['A','B','C'].map((name,i)=>({id:name,place_ref:{name},stay_range:{min_s:600,max_s:600,basis:'planning_assumption'},optional:i===1}));
const calls=[];
const query=async(from,to,o)=>{calls.push(o.departureTime);return {provider:'Google Maps',from:from.name,to:to.name,mode:o.mode,status:'available',distance_m:1000,duration_s:600,departure_time:o.departureTime,checked_at:'2026-10-30T00:00:00Z',actual_modes:['TRANSIT']};};
const checked=await evaluateDay({events,points,departure:'2026-10-31T00:00:00Z',deadline:'2026-10-31T02:00:00Z',timezone:'Asia/Seoul',anchorsKnown:true},{query});
assert.deepEqual(calls,['2026-10-31T00:10:00.000Z','2026-10-31T00:30:00.000Z']);assert.equal(checked.schedule,'fits_under_assumptions');
const catalog=routeFactCatalog(checked.observations);assert(catalog.every(f=>supportsRouteFact(f,checked.observations)));assert(!supportsRouteFact({...catalog[0],from_id:'C'},checked.observations));
const partial=await evaluateDay({events,points:points.slice(0,2),departure:'2026-10-31T00:00:00Z',timezone:'Asia/Seoul'},{query});assert.equal(partial.schedule,'unknown');assert.equal(partial.observations[1].status,'unresolved');
const reference=await evaluateDay({events,points,departure:'2026-10-31T00:00:00Z'},{query});assert.equal(reference.basis,'reference');assert.equal(reference.schedule,'unknown');
const conflict=await evaluateDay({events,points,departure:'2026-10-31T00:00:00Z',deadline:'2026-10-31T00:20:00Z',timezone:'Asia/Seoul',anchorsKnown:true},{query});assert.equal(conflict.schedule,'conflict');
const without=await evaluateDay({events,points,includeOptional:false},{query});assert.equal(without.observations.length,1);assert.equal(without.observations[0].to,'C');
const guard=createPlanningProgress(),state={conditions:{},structure:['A'],gaps:['route'],evidence:[]};
const a=guard.observe(state);assert(guard.action(a.fingerprint,{name:'search',q:'A'}).allowed);assert(!guard.action(a.fingerprint,{name:'search',q:'A'}).allowed);
guard.observe({...state,structure:['B']});assert(guard.observe(state).repeated);
console.log('规划结构、数值观察、连续时间、未知断点、局部修改与循环反例通过');
const tour={...draft,cards:[{...draft.cards[0],content:'上午：游览`A`。\n下午：游览`B`。\n晚上：游览`C`。'},draft.cards[1]]};
let decisions=0;
const resolver=async({places})=>({status:'complete',points:places.map(name=>({name,provider:'Google Maps',provider_id:name}))});
const routes=async(from,to,o)=>({...await query(from,to,o),duration_s:['AB','BC'].includes(from.name+to.name)?7200:900});
const loop=await runPlanningLoop({draft:tour,scope:['card-day-1'],runtime:createAgentRuntime(),resolve:resolver,query:routes,now:Date.parse('2026-10-30T00:00:00Z'),model:async o=>{
 decisions++;const card=JSON.parse(o.user).cards[0];return {action:'reorder',day_id:card.id,activity_order:[card.activities[0].id,card.activities[2].id,card.activities[1].id]};
}});
assert.equal(decisions,1);assert.deepEqual(loop.changed_day_ids,['card-day-1']);assert(loop.draft.cards[0].content.indexOf('C')<loop.draft.cards[0].content.indexOf('B'));assert.equal(loop.draft.cards[1].content,tour.cards[1].content);assert.equal(loop.assessment.schedule,'unknown');
assert.throws(()=>reorderDay(tour,{day_id:'card-day-1',activity_order:['invented']}));
assert.throws(()=>reorderDay({...tour,cards:[{...tour.cards[0],content:'上午：在`A`吃早餐。\n下午：游览`B`。\n晚上：游览`C`。'}]}, {day_id:'card-day-1',activity_order:['card-day-1-activity-3','card-day-1-activity-2','card-day-1-activity-1']}),/locked_time_order/);
const noGain=await runPlanningLoop({draft:tour,scope:['card-day-1'],resolve:resolver,query:async(f,t,o)=>({...await query(f,t,o),duration_s:7200}),model:async o=>{const c=JSON.parse(o.user).cards[0];return {action:'reorder',day_id:c.id,activity_order:c.activities.map(a=>a.id).reverse()};}});
assert.deepEqual(noGain.changed_day_ids,[]);
const restored=preserveOutsideScope(tour,{...tour,cards:tour.cards.map(c=>({...c,title:'被误改'}))},['card-day-1']);assert.equal(restored.cards[1].title,tour.cards[1].title);
const schedule=await checkDaySchedule({city:'乙',schedule:{mode:'TRANSIT',departure:'2026-10-31T00:00:00Z',deadline:'2026-10-31T08:00:00Z',timezone:'Asia/Seoul',events:[{name:'A',stay_minutes:60},{name:'B',stay_minutes:60,optional:true},{name:'C',stay_minutes:60}]}},{resolve:resolver,query});
assert.equal(schedule.required.schedule,'unknown');assert.equal(schedule.required.activity_schedule,'fits_under_assumptions');assert.equal(schedule.with_optional.observations.length,2);
console.log('真实编排：观察→提出顺序→新路段查询→接受实测改善／拒绝无改善；可选分支与首末段范围通过');
const walking=await evaluateDay({events,points,departure:'2026-10-31T00:00:00Z',deadline:'2026-10-31T08:00:00Z',timezone:'Asia/Seoul',anchorsKnown:true},{query:async(f,t,o)=>({...await query(f,t,o),actual_modes:['WALK'],walking_only:true})});
assert.equal(walking.mobility,'partial');assert.equal(walking.schedule,'unknown');assert(walking.gaps.some(g=>g.type==='requested_mode_not_supported'));
assert.throws(()=>reorderDay({...tour,cards:[{...tour.cards[0],content:'全天：参加一日游。\n上午：`A`。\n下午：`B`。'}]}, {day_id:'card-day-1',activity_order:['card-day-1-activity-3','card-day-1-activity-2','card-day-1-activity-1']}),/locked_time_order/);
const closed=await evaluateDay({events,points:points.map(p=>({...p,business_status:'CLOSED_TEMPORARILY'})),departure:'2026-10-31T00:00:00Z',deadline:'2026-10-31T08:00:00Z',timezone:'Asia/Seoul',anchorsKnown:true},{query});assert.equal(closed.schedule,'unknown');
const routeBefore=cleanConversation({stage:'ready',brief:{origin:'甲',destination:'乙',summary:'经过丙'},routing:{origin:'甲',destination:'乙'},requirements:{trip_days:2,required_stops:['丙']}});
const routeDraft={title:'游览',overview:'城市散步',route:['甲','丙','丁'],cards:[{id:'card-day-1',place:'丙',label:'第1天',title:'街区',content:'在`老街`散步。'},{id:'card-day-2',place:'乙',label:'第2天',title:'公园',content:'到`公园`散步。'}],sections:[],pending:[]};
for(const repair of [['甲','丙','乙'],['甲','丁','乙']]){
 const r=await conversationTurn({action:'generate',conversation:routeBefore},null,{search:async()=>[],model:async o=>o.kind==='planning_route_structure'?{route:repair}:{reply:'行程如下。',draft:routeDraft,brief:routeBefore.brief,ready:true,preferences:{},travel:{},constraints:{},sights:{}}});
 assert.equal(r.status,repair.includes('丁')?'unavailable':'ok');if(r.status==='ok'){assert.deepEqual(r.conversation.draft.route,repair);assert.equal(r.conversation.draft.cards[0].content,routeDraft.cards[0].content);}
}

// 单日偏好不能写入全程条件；局部改稿不依赖再次重写整份攻略的复审。
const localBefore=cleanConversation({stage:'draft',revision:1,brief:{origin:'上海',destination:'济州岛',summary:'三日含往返'},routing:{origin:'上海',destination:'济州岛'},requirements:{trip_days:2},draft});
let wholeReview=0;
const local=await conversationTurn({action:'chat',text:'第2天轻松一点，其余天不改',conversation:localBefore,travel:{trip_type:'round_trip'}},null,{search:async()=>[],model:async o=>{
 if(o.kind==='conversation_intent')return {intent_action:'revise'};
 if(o.kind==='conversation_condition_update')return {preferences:{pace:'simple'},requirements_patch:{},travel:{},constraints:{},sights:{}};
 if(o.kind==='conversation_calendar')return {travel:{}};
 if(o.kind==='conversation_local_revision')return {reply:'第二天已调整。',cards:[{id:'card-day-2',title:'街区慢游',content:'上午：在`C`慢慢散步，按体力安排停留。'}],summary_fields:[]};
 if(o.kind==='conversation_review'){wholeReview++;return null;}
 return {intent_action:'revise',reply:'已调整。',brief:localBefore.brief,ready:true,preferences:{pace:'simple'},travel:{},constraints:{},sights:{},draft:{...draft,cards:draft.cards.map(c=>c.id==='card-day-2'?{...c,content:'上午：在`C`慢慢散步，按体力安排停留。'}:c)}};
}});
assert.equal(local.status,'ok');assert.deepEqual(local.patch.preferences,{});assert.equal(wholeReview,0);assert.equal(local.conversation.draft.cards[0].content,draft.cards[0].content);

assert.equal(assessDelivery(taskContract({conditions:{requirements:{verified_cross_border_only:true}}}),{content:true,grounding:true,mobility:'supported',schedule:'fits_under_assumptions'}).passed,false,'明确要求核实跨境时，初稿完整不能替代日期交通证据');

const scoped={cards:Array.from({length:5},(_,i)=>({id:'day-'+(i+1),label:'第'+(i+1)+'天'}))};
assert.deepEqual(revisionDayScope('只调整第2天，下午休息。第1天和第3天完全不变。',scoped),{editable:['day-2'],readonly:['day-1','day-3']});
assert.deepEqual(revisionDayScope('第1天不改；修改第3至4天；如果要动第5天先问我。',scoped),{editable:['day-3','day-4'],readonly:['day-1','day-5']});
assert.deepEqual(revisionDayScope('Change day 2. Keep day 1 and day 3 unchanged.',scoped),{editable:['day-2'],readonly:['day-1','day-3']});
assert.deepEqual(revisionDayScope('Change days 2-4. Leave day 5 untouched.',scoped),{editable:['day-2','day-3','day-4'],readonly:['day-5']});
assert.deepEqual(revisionDayScope('只改第2天，其他不变。',scoped).editable,['day-2']);

assert.deepEqual(revisionDayScope('最后一天改为休息，第一天保持原样',scoped,{editable:[{id:'day-5',quote:'最后一天改为休息'}],readonly:[{id:'day-1',quote:'第一天保持原样'}]}),{editable:['day-5'],readonly:['day-1']});
assert.deepEqual(revisionDayScope('第2天不变',scoped,{editable:[{id:'day-2',quote:'第2天不变'}],readonly:[]}).editable,[],'语义范围不得覆盖明确只读日期');
{
 const {conversationTurn:turn,cleanConversation:clean}=await import('./lib/conversation.mjs');
 const base=clean({stage:'draft',revision:1,brief:{origin:'甲城',destination:'乙城',summary:'三天',wishes:[],open_questions:[]},routing:{origin:'甲城',destination:'乙城'},requirements:{trip_days:3},draft:{title:'城市慢游',overview:'在城区游览。',route:['甲城','乙城'],cards:Array.from({length:3},(_,i)=>({id:'card-day-'+(i+1),label:'第'+(i+1)+'天',place:'乙城',title:'城区游览',content:'上午在城区散步。下午在住处休息。'})),sections:[],pending:[]}});
 const common={intent_action:'revise',reply:'局部调整。',brief:base.brief,routing:base.routing,ready:true,requirements_patch:{},preferences:{},travel:{},constraints:{},sights:{},draft:base.draft};let reviews=0;
 const r=await turn({text:'只改第2天下午休息，第1天和第3天完全不变。',conversation:base,travel:{trip_type:'one_way'},constraints:{lodging_stays:[{city:'乙城',date:'2026-11-10'}]}},null,{search:async()=>[],model:async o=>{
  const p=JSON.parse(o.user);
  if(o.kind==='conversation_condition_update')return p.proposed;
  if(o.kind==='conversation_calendar')return {travel:{}};
  if(o.kind==='conversation_local_revision')return {reply:'只改第二天。',cards:[{id:'card-day-2',title:'休息',content:'全天在住处休息。'}],summary_fields:[]};
  if(o.kind==='conversation_review'){reviews++;return {reply:'已校对。',draft:{...base.draft,cards:base.draft.cards.map(c=>({...c,content:'全天在住处休息。'}))}};}
  return common;
 }});
 assert.equal(r.status,'ok',r.reply);assert.ok(reviews>0);assert.equal(r.conversation.draft.cards[0].content,base.draft.cards[0].content);assert.equal(r.conversation.draft.cards[2].content,base.draft.cards[2].content);assert.notEqual(r.conversation.draft.cards[1].content,base.draft.cards[1].content);
}
