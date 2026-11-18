import assert from 'node:assert/strict';
import workspace from '../mixtouring-hifi/assets/route-workspace.js';
import {ensureItineraryQuality} from './lib/itinerary-quality.mjs';
import {buildContext} from './lib/context-builder.mjs';
const reminder='返程前确认好随身行李与交通衔接，留出充裕时间。';
const original='- 上午：在公园散步。\n- 下午：在公园散步。\n- 提醒：'+reminder+reminder;
assert.equal(workspace.dedupeNotes(original),original.replace(reminder+reminder,reminder));
for(const unchanged of ['- 上午：先返回，再出发。先返回，再出发。','- 提醒：不要赶路。需要赶路时早点出发。','- 提醒：休息。\n- 下午：休息。\n- 提醒：休息。'])assert.equal(workspace.dedupeNotes(unchanged),unchanged);
const long={title:'四十日',overview:'街区慢逛',route:['甲城','乙城'],sections:[],pending:[],cards:Array.from({length:40},(_,i)=>({id:'card-day-'+(i+1),place:'乙城',label:'第'+(i+1)+'天',title:'街区散步',content:'上午：在街区散步，按体力休息。\n下午：留在当地慢逛，不赶项目。'+Array.from({length:65},(_,n)=>`这里保留当天第${n+1}段完整活动描述。`).join('')}))};
const baseline=JSON.stringify(long),batches=[],globals=[];
function review(p){return {cards:p.draft.cards.map(c=>({id:c.id,role:'activity',activity_present:true,title_matches:true})),summary_matches:true,issues:[],continuity:p.scope_ids.map(id=>({id,quotes:['上午：在街区散步，按体力休息。']}))};}
const model=async o=>{buildContext({payload:JSON.parse(o.user),coreRules:o.schema_prompt});const p=JSON.parse(o.user);
 if(o.kind==='conversation_quality_batch'){batches.push(p);return review(p);}
 if(o.kind==='conversation_quality_global'){globals.push(p);return globals.length===1?{action:'read',card_ids:['card-day-20']}:{action:'done',summary_matches:true,issues:[]};}
 throw Error('不应重写正文：'+o.kind);
};
const result=await ensureItineraryQuality({draft:long,current:{requirements:{trip_days:40}},model,verify:async()=>({accepted:false})});
assert.equal(result.status,'passed');assert.equal(JSON.stringify(result.draft),baseline);assert(batches.length>1);assert.equal(globals.length,2);assert.equal(globals[1].read_cards[0].content,long.cards[19].content);
assert.deepEqual(batches.flatMap(b=>b.scope_ids),long.cards.map(c=>c.id),'每个目标日恰好分配一次');
for(const batch of batches){const start=long.cards.findIndex(c=>c.id===batch.scope_ids[0]),end=long.cards.findIndex(c=>c.id===batch.scope_ids.at(-1));for(const i of [Math.max(0,start-1),Math.min(39,end+1)])assert(batch.draft.cards.concat(batch.readonly_neighbors).some(c=>c.id===long.cards[i].id),'完整邻日用于跨批衔接');}
assert.equal(JSON.stringify(long),baseline);
for(const failure of ['budget','missing','invented','global','read_loop']){
 const r=await ensureItineraryQuality({draft:long,current:{},canCall:n=>failure==='budget'?n<2:true,model:async o=>{
  const p=JSON.parse(o.user);if(o.kind==='conversation_quality_batch'){const answer=review(p);if(failure==='missing')answer.cards.pop();if(failure==='invented')answer.continuity[0].quotes=['不存在的内容'];return answer;}
  if(o.kind==='conversation_quality_global')return failure==='read_loop'?{action:'read',card_ids:['card-day-20']}:null;
  throw Error('不应进入写稿');
 },verify:async()=>({accepted:false})});assert.equal(r.status,'unreviewed',failure);assert.deepEqual(r.draft,long);assert.equal(r.checked,false);
}
const conflict=await ensureItineraryQuality({draft:long,current:{},model:async o=>{const p=JSON.parse(o.user);if(o.kind==='conversation_quality_batch')return review(p);if(o.kind==='conversation_quality_global')return {action:'done',summary_matches:true,issues:[{code:'cross_day_conflict',card_ids:['card-day-20','card-day-21'],quote:'上午：在街区散步',reason:'测试跨批冲突必须保留'}]};return null;},verify:async()=>({accepted:false})});assert.equal(conflict.status,'needs_repair');assert(conflict.issues.some(i=>i.code==='cross_day_conflict'));
console.log('✓ 重复提醒边界、40日完整分批、相邻衔接、按需读原卡、全程冲突与未完成状态通过');

const twice='- 提醒：带水。带水。\n- 提醒：带水。';assert.equal(workspace.dedupeNotes(twice),'- 提醒：带水。');assert.equal(workspace.dedupeNotes(workspace.dedupeNotes(twice)),workspace.dedupeNotes(twice));
assert.equal(workspace.dedupeNotes({content:'不是字符串'}),'');
const aborter=new AbortController();let invoked=0;
await assert.rejects(ensureItineraryQuality({draft:long,current:{},signal:aborter.signal,model:async o=>{invoked++;aborter.abort();return review(JSON.parse(o.user));},verify:async()=>({accepted:false})}));assert.equal(invoked,1,'取消后不能继续下一批');
