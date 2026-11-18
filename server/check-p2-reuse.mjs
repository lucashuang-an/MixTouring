import assert from 'node:assert/strict';
import {ensureItineraryQuality} from './lib/itinerary-quality.mjs';
import {summaryFingerprint,appendSummary,cleanSummaries,isStale,summarizeBacklog} from './lib/context-builder.mjs';
import {collectTravelSources} from './lib/travel-sources.mjs';
import {discussionFingerprint,discussPlan} from './lib/planning-discussion.mjs';

for(const count of [5,20]){
 const draft={title:'城市行程',overview:'游览街区',route:['甲城'],sections:[],cards:Array.from({length:count},(_,i)=>({id:'day-'+i,place:'甲城',label:'第'+(i+1)+'天',title:'城市体验',content:'休息。'}))};
 let repaired=false,repairs=0,checks=0;
 const model=async o=>{
  if(o.kind==='conversation_quality_review')return {cards:draft.cards.map(c=>({id:c.id,role:'activity',activity_present:repaired,title_matches:true})),summary_matches:true,issues:[]};
  assert.equal(o.kind,'conversation_quality_repair');repairs++;
  const p=JSON.parse(o.user);assert.equal(p.targets.length,count);assert.ok(p.readonly_outline.every(c=>!c.content));
  repaired=true;return {cards:p.targets.map(c=>({id:c.id,title:c.title,content:'在青石街散步。'})),summary_fields:[]};
 };
 const r=await ensureItineraryQuality({draft,current:{constraints:{no_self_drive:true}},model,catalog:{entries:[]},verify:async(next,scope)=>{checks++;assert.equal(scope.card_ids.length,count);assert.deepEqual(next.route,draft.route);return {accepted:true};}});
 assert.equal(r.status,'passed');assert.equal(repairs,1);assert.equal(checks,1);assert.equal(draft.cards[0].content,'休息。');
}
// 超出实际上下文容量或剩余预算时不调用修复，旧稿保留。
{
 const draft={title:'城市',overview:'',route:['甲城'],sections:[],cards:[{id:'d',place:'甲城',label:'第1天',title:'`青石街`体验',content:'休息。'}]};
 let calls=0;
 const model=async o=>{assert.equal(o.kind,'conversation_quality_review');calls++;return {cards:[{id:'d',role:'activity',activity_present:false,title_matches:true}],summary_matches:true,issues:[]};};
 const r=await ensureItineraryQuality({draft,current:{},model,catalog:{entries:[{id:'s',title:'青石街',excerpt:'资料'.repeat(3000)}]},budgetChars:6000,verify:async()=>{throw Error('不应核对');}});
 assert.deepEqual(r.draft,draft);assert.notEqual(r.status,'passed');assert.equal(calls,1);assert.equal(r.repair,'context_limit');
 const denied=await ensureItineraryQuality({draft,current:{},model,canCall:n=>n<4,verify:async()=>{throw Error('不应核对');}});
 assert.deepEqual(denied.draft,draft);assert.equal(denied.status,'needs_repair');
}
const messages=Array.from({length:24},(_,i)=>({mid:i+1,role:i%2?'assistant':'user',text:'消息'+i}));
const fp=summaryFingerprint(1,'same conditions');
const summaries=appendSummary(cleanSummaries(),{fromMid:1,toMid:8,text:'早期选择'},fp,1,messages);
assert.equal(summaryFingerprint(20,'same conditions'),fp);
assert.equal(isStale(summaries.items[0],fp,messages),false);
assert.equal(summarizeBacklog(messages,summaries,fp).pending.length,0);
for(const changed of [messages.slice(1),messages.filter(m=>m.mid!==4),messages.map(m=>m.mid===3?{...m,text:'撤回原选择'}:m)])assert.equal(isStale(summaries.items[0],fp,changed),true);
assert.equal(isStale(summaries.items[0],summaryFingerprint(1,'new dates'),messages),true);
assert.equal(isStale({...summaries.items[0],source_hash:undefined},fp,messages),true);

const now=Date.parse('2026-11-03T02:00:00Z');let searches=0;
const search=async(q,o)=>{searches++;return [{title:'福州旅行',link:o.domains?.includes('reddit.com')?'https://www.reddit.com/r/travel/comments/p2cache':'https://www.xiaohongshu.com/explore/p2cache',content:'福州街区旅行体验',date:'2026-11-01'}];};
const task={destination:'福州',international:true,foreignQuery:'Fuzhou travel'};
const collect=(opts={})=>collectTravelSources(task,search,{now,cacheScope:'p2',...opts});
const first=await collect();assert.equal(first.status,'available');const initial=searches;
first.sources[0].title='污染调用者副本';
const hit=await collect({now:now+1000});assert.equal(hit.cache_hit,true);assert.equal(searches,initial);assert.notEqual(hit.sources[0].title,first.sources[0].title);assert.equal(hit.retrieved_at,first.retrieved_at);
assert.equal((await collect({cacheScope:'changed conditions'})).cache_hit,false);
assert.equal((await collect({forceRefresh:true})).cache_hit,false);
assert.equal((await collect({now:now+300001})).cache_hit,false);
const controller=new AbortController();controller.abort();const n=searches;
assert.equal((await collect({signal:controller.signal})).cancelled,true);assert.equal(searches,n);
// 生产讨论入口确实复用；明确刷新绕过；条件变化隔离。
const before={brief:{origin:'北京',destination:'福州',wishes:[]},requirements:{trip_days:5,required_stops:[]},routing:{origin:'北京',destination:'福州'},discussion:{}};
const current={travel:{trip_type:'one_way'},requirements:before.requirements,constraints:{}};
const run=async(refresh=false,conditions=current)=>discussPlan({before,next:structuredClone(before),current:conditions,raw:{planning:{action:'propose',refresh_sources:refresh,refresh_quote:refresh?'重新检索':null}},input:{text:refresh?'重新检索':'给我一个方案'},model:async()=>({options:[]}),search,now,trace:()=>{},evidenceReview:false});
await run();const afterFirst=searches;await run();assert.equal(searches,afterFirst);
await run(true);assert.ok(searches>afterFirst);const afterRefresh=searches;
await run(false,{...current,constraints:{no_self_drive:true}});assert.ok(searches>afterRefresh);
assert.notEqual(discussionFingerprint(before,current),discussionFingerprint(before,{...current,travel:{trip_type:'round_trip'}}));
console.log('✓ P2：5/20天容量修复、预算保留、源消息摘要失效、讨论素材复用/刷新/条件隔离');

// 部分渠道失败与相关性未完成不能被短期缓存掩盖。
for(const partialReview of [false,true]){
 let attempts=0;
 const options={now,cacheScope:'partial-'+partialReview,assessSources:partialReview?async()=>({status:'partial',items:[]}):null};
 const partialSearch=async(q,o)=>{attempts++;if(!partialReview && o.domains?.includes('reddit.com'))throw Error('服务临时不可用');return search(q,o);};
 await collectTravelSources(task,partialSearch,options);const seen=attempts;
 const second=await collectTravelSources(task,partialSearch,options);assert.equal(second.cache_hit,false);assert.ok(attempts>seen);
}
