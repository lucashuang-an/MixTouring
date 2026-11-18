import assert from 'node:assert/strict';
import {validateOutline,cleanDiscussion,discussPlan,discussionFingerprint} from './lib/planning-discussion.mjs';
import {mentionedDays,allocationReview,updateStayLocks} from './lib/itinerary-constraints.mjs';
import {checkTravelDelivery} from './lib/travel-completion.mjs';
import {draftQueryScope,searchDraftChanges} from './lib/draft-research.mjs';
import {searchTransportSources,resolveTransportSearch,transportSearchEvidence} from './lib/transport-search.mjs';
import {conversationTurn,cleanConversation} from './lib/conversation.mjs';
import workspace from '../mixtouring-hifi/assets/route-workspace.js';
import tasks from '../mixtouring-hifi/assets/research-tasks.js';
const option={title:'城市游',description:'城市散步',outbound_days:0,return_days:0,segments:[{place:'京都',days:2,scope:''}],memberships:[]};
const conditions={origin:'大阪',destination:'京都',days:2,tripType:'round_trip',scopes:[],requiredStops:[],catalog:{entries:[]}};
assert(validateOutline(option,conditions),'短途往返可以与游览共用日期');
assert(!validateOutline({...option,segments:[{place:'神户',days:2}]},conditions),'必须保留具体目的地');
assert(validateOutline({...option,outbound_days:6,segments:[{place:'京都',days:3}]},{...conditions,days:9}),'不把长途交通固定限制为五天');
assert(validateOutline(option,{...conditions,days:null}),'天数未定可以先讨论建议方案');
assert(!validateOutline(option,{...conditions,stayLocks:[{place:'京都',days:1}]}));
assert.deepEqual([...mentionedDays('只改第十一天和第3至5天')],[11,3,4,5]);
assert.deepEqual([...mentionedDays('只改第十二天到第十四天')],[12,13,14]);
assert.deepEqual([...mentionedDays('Day 11 和 D3')],[11]);assert.deepEqual([...mentionedDays('改乘D11列车')],[]);
assert.deepEqual([...mentionedDays('选第一个方案，第三次再说')],[]);
const outline={outbound_days:1,return_days:1,segments:[{place:'京都',days:2},{place:'大阪',days:3}]};
const draft={title:'七日',overview:'两城游',route:['上海','京都','大阪'],cards:['上海','京都','京都','京都','京都','大阪','上海'].map((place,i)=>({id:'card-day-'+(i+1),place,label:'第'+(i+1)+'天',title:'城市安排',content:'城市散步。'})),sections:[],pending:[]};
const soft=checkTravelDelivery({draft,confirmedOutline:outline,requirements:{trip_days:7},routing:{origin:'上海',destination:'大阪'}});
assert(soft.passed);assert.deepEqual(soft.allocation_changes,[{place:'京都',before_days:2,after_days:4},{place:'大阪',before_days:3,after_days:1}]);
assert(!checkTravelDelivery({draft,confirmedOutline:outline,stayLocks:[{place:'京都',days:2}],requirements:{trip_days:7},routing:{origin:'上海',destination:'大阪'}}).valid,'用户硬锁定不能调整');
assert.deepEqual(updateStayLocks([],{stay_locks:[{place:'京都',days:2,quote:'京都必须两天'}]},'京都必须两天'),[{place:'京都',days:2,quote:'京都必须两天'}]);
assert.deepEqual(updateStayLocks([],{stay_locks:[{place:'京都',days:2,quote:'京都必须两天'}]},'大概看看'),[]);
assert.deepEqual(updateStayLocks([{place:'京都',days:2}],{unlock_stays:[{place:'京都',quote:'这个不限制天数了'}]},'这个不限制天数了'),[]);
const travel={trip_type:'round_trip',outbound_window:'2026-11-01 ~ 2026-11-01',return_window:'2026-11-05 ~ 2026-11-05'};
const scope=draftQueryScope({route:['福州','宁波'],travel,preferences:{preferred_mode:'rail'}});
assert.deepEqual(scope.route,['福州','宁波']);assert.deepEqual(scope.legs.map(l=>[l.from,l.to,l.window]),[['福州','宁波',travel.outbound_window],['宁波','福州',travel.return_window]]);
assert.equal(draftQueryScope({route:['福州','宁波'],travel:{trip_type:'one_way'}}).legs.length,1);
assert.equal(draftQueryScope({route:['福州','宁波'],travel:{trip_type:'pending'}}).legs.length,1);
assert.deepEqual(workspace.transportRoute(scope.route,travel),['福州','宁波','福州']);
const observed=[];await searchDraftChanges({queries:scope.legs,window:scope.window},null,{lookup:async q=>{observed.push([q.from,q.to,q.window]);return {retrieval_id:'x'};}});assert.deepEqual(observed,scope.legs.map(l=>[l.from,l.to,l.window]));
assert.equal(tasks.signature(scope),tasks.signature({...scope,legs:scope.legs.map(l=>({...l,window:l.window || scope.window}))}));
const now=Date.parse('2026-10-31T00:00:00Z');
const back=await searchTransportSources({from:'宁波',to:'福州',mode:'rail',window:travel.return_window},async()=>[{title:'宁波到福州列车开行',link:'https://example.org/return',content:'宁波到福州列车运行。',date:'2026-10-30'}],{now,useCache:false,readPage:null,mapTools:{enabled:false}});
assert.equal(resolveTransportSearch({ids:[back.retrieval_id],legs:scope.legs,window:scope.window},{now}).records.length,1);
assert.equal(transportSearchEvidence([back.retrieval_id],{route:scope.route,legs:scope.legs.map(l=>({...l,mode_guess:l.mode})),window:scope.window,now}).length,1);
assert.equal(transportSearchEvidence([back.retrieval_id],{route:scope.route,window:scope.window,now}).length,0);
const before=cleanConversation({brief:{origin:'北京',destination:'越南、印尼',summary:'两国旅行'},requirements:{trip_days:15},discussion:{scopes:[{name:'越南',level:'country'},{name:'印尼',level:'country'}]}});
const removed=await conversationTurn({text:'第二个国家不去了',conversation:before},null,{model:async()=>({reply:'取消印尼。',brief:{...before.brief,destination:'越南'},ready:false,intent_action:'discuss',planning:{action:'ask',scopes:[{name:'越南',level:'country'}],remove_scopes:[{name:'印尼',quote:'第二个国家不去了'}]},requirements_patch:{},preferences:{},travel:{},constraints:{},sights:{}})});
assert.equal(removed.status,'ok');assert.deepEqual(removed.conversation.discussion.scopes,[{name:'越南',level:'country'}]);
console.log('✓ 约束审计回归：目的地、共享交通日、建议与硬锁定、指代取消、中文日序、往返日期与证据隔离');

assert(validateOutline(option,{...conditions,stayLocks:[{place:'京都',min_days:1}]}));assert(!validateOutline(option,{...conditions,stayLocks:[{place:'京都',max_days:1}]}));assert(validateOutline(option,{...conditions,stayLocks:[{place:'京都',min_days:1,max_days:3}]}));
let directionCalls=0;
const direction=await conversationTurn({text:'从北京出发，没决定去哪，喜欢自然风景，请推荐方向'},null,{search:async()=>[],model:async o=>{
 if(o.kind==='planning_directions'){directionCalls++;return {reply:'可以先比较山地慢游和海岸散步，你更想体验哪一种？'};}
 return {intent_action:'discuss',reply:'先比较方向。',brief:{origin:'北京',destination:'',summary:'自然旅行'},ready:false,planning:{action:'propose',scopes:[]},requirements_patch:{},preferences:{},travel:{},constraints:{},sights:{}};
}});
assert.equal(direction.status,'ok');assert.equal(directionCalls,1);assert.equal(direction.conversation.routing.destination,'');assert.equal(direction.request_generation,false);
const fixed=cleanConversation({brief:{origin:'东京',destination:'京都',summary:'去京都'},routing:{origin:'东京',destination:'京都'},requirements:{trip_days:2}});
const wrong=await conversationTurn({text:'请给一个方案',conversation:fixed},null,{search:async()=>[],model:async o=>{
 if(o.kind==='conversation_route_change')return {origin:'东京',destination:'京都'};
 if(o.kind==='planning_outline')return {options:[{...option,segments:[{place:'大阪',days:2,scope:''}]}]};
 return {intent_action:'discuss',reply:'整理方案。',brief:{...fixed.brief,destination:'大阪'},routing:{origin:'东京',destination:'大阪'},ready:true,planning:{action:'propose',scopes:[]},requirements_patch:{},preferences:{},travel:{},constraints:{},sights:{}};
}});
assert.equal(wrong.status,'ok');assert.equal(wrong.conversation.brief.destination,'京都');assert.equal(wrong.conversation.discussion.options.length,0);assert.equal(wrong.task_status,'partial');assert.match(wrong.reply,/目的地/);
let negationChecked=false;
const negation='不要把“京都必须两天”当成硬要求';
const rejectedLock=await conversationTurn({text:negation,conversation:fixed},null,{model:async o=>{
 if(o.kind==='conversation_condition_update'){assert.equal(JSON.parse(o.user).text,negation);negationChecked=true;return {planning:{},preferences:{},requirements_patch:{},travel:{},constraints:{},sights:{}};}
 return {intent_action:'discuss',reply:'先保留灵活安排。',brief:fixed.brief,routing:fixed.routing,ready:false,planning:{action:'ask',stay_locks:[{place:'京都',days:2,quote:'京都必须两天'}]},requirements_patch:{},preferences:{},travel:{},constraints:{},sights:{}};
}});
assert(negationChecked);assert.equal(rejectedLock.status,'ok');assert.deepEqual(rejectedLock.conversation.discussion.stay_locks,[],'截出的肯定片段不能绕过完整原话中的否定');
