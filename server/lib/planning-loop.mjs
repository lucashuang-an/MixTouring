import {planWorkspace,planningHash,changedDays,applyDayPatch,invalidation} from './planning-state.mjs';
import {evaluatePlan} from './planning-mobility.mjs';
import {createPlanningProgress} from './planning-progress.mjs';
import {agentPrompt} from './agent-prompts.mjs';
import workspace from '../../mixtouring-hifi/assets/route-workspace.js';
import {mentionedDays} from './itinerary-constraints.mjs';
// 只重排既有活动块，不允许模型借地图优化新增事实、删除必去点或改变日序。
export function reorderDay(draft,decision){
 const card=draft.cards.find(c=>c.id===decision?.day_id),order=decision?.activity_order;
 if(!card || !Array.isArray(order))throw Error('invalid_day_order');
 const indexed=workspace.cleanDraft(draft).cards.find(c=>c.id===card.id),activities=indexed.activities;
 if(order.length!==activities.length || new Set(order).size!==order.length || order.some(id=>!activities.some(a=>a.id===id)))throw Error('incomplete_day_order');
 if(/一日(?:游|团)|两日|二日|多日|次日|翌日|集合|早餐|午餐|晚餐|早饭|午饭|晚饭|看日出|看日落|看夕阳|赏日出|赏日落|夜景|晚霞|随后|接着|之后|最后|返回|先.{0,20}再|\d{1,2}[:：]\d{2}/.test(card.content))throw Error('locked_time_order');
 const content=order.map((id,i)=>{const a=activities.find(a=>a.id===id);return (activities[i].slot?activities[i].slot+'：':'')+a.text;})
  .concat((indexed.tips || []).map(t=>t.kind+'：'+t.text)).join('\n');
 return applyDayPatch(draft,{cards:[{id:card.id,title:card.title,content}]},[card.id]);
}
export function explicitDayScope(text,draft){
 const numbers=mentionedDays(text);
 return (draft?.cards || []).filter(c=>[...mentionedDays(c.label)].some(day=>numbers.has(day))).map(c=>c.id);
}
export function dayOnlyPreferenceScope(text,draft){
 if(!explicitDayScope(text,draft).length)return false;
 const scope='(?:全程|整体|整趟|这趟|所有天|每天|长期|以后|今后)';
 const plain=String(text).replace(new RegExp('(?:不要|不|别|勿)(?:调整|更改|修改|改变|改动|改).{0,4}'+scope+'.{0,5}(?:节奏|偏好|安排)','g'),'')
  .replace(new RegExp(scope+'.{0,5}(?:保持不变|保持原样|不要改|不改|不变)','g'),'');
 return !new RegExp(scope).test(plain);
}
export function preserveOutsideScope(before,after,scope){
 if(!scope.length)return after;
 const copy=structuredClone(after);
 if(before.cards.length!==after.cards.length || JSON.stringify(before.route)!==JSON.stringify(after.route))throw Error('local_revision_structure_changed');
 copy.cards=before.cards.map(c=>scope.includes(c.id)?copy.cards.find(n=>n.id===c.id)||c:c);
 return workspace.cleanDraft(copy,before);
}
export function applyLocalRevision(before,patch,scope){
 if(!Array.isArray(patch?.cards)||patch.cards.length!==scope.length)throw Error('local_revision_missing_cards');
 const next=applyDayPatch(before,patch,scope),fields=patch.summary_fields || [];
 const allowed=new Set(['overview',...(before.sections||[]).map((_,i)=>'sections.'+i+'.content')]);
 if(!Array.isArray(fields)||new Set(fields.map(f=>f.path)).size!==fields.length||fields.some(f=>!allowed.has(f.path)||typeof f.text!=='string'||!f.text.trim()||f.text.length>(f.path==='overview'?1000:1200)))throw Error('local_revision_summary_scope');
 for(const f of fields){if(f.path==='overview')next.overview=f.text;else next.sections[Number(f.path.split('.')[1])].content=f.text;}
 return next;
}
export function numericRevisionScope(value,before,scope){
 if(!value?.draft || !before || !scope.length)return value;
 const draft=value.draft;
 return {...value,draft:{...draft,title:draft.title===before.title?'':draft.title,overview:draft.overview===before.overview?'':draft.overview,
  cards:draft.cards.map(c=>scope.includes(c.id)?c:{...c,title:'',content:''}),
  sections:draft.sections.map((s,i)=>({title:s.title===before.sections[i]?.title?'':s.title,content:s.content===before.sections[i]?.content?'':s.content})),pending:[]}};
}
const totals=day=>day && day.observations?.length && day.observations.every(o=>o.status==='available')?day.observations.reduce((n,o)=>n+o.duration_s,0):null;
export async function runPlanningLoop({draft,conditions={},before=null,scope=null,model,runtime,signal,resolve,query,now=Date.now(),onTrace=()=>{},onCheckpoint=()=>{}}){
 if(/先.{0,80}(?:再|然后)|依次|指定顺序|保留顺序|按原.{0,8}顺序/.test([conditions.brief?.summary,...(conditions.brief?.wishes||[])].join(' ')))model=null;
 let candidate=workspace.cleanDraft(draft),plan=planWorkspace(candidate,conditions),evaluation;
 const progress=createPlanningProgress(),rejected=new Set(),considered=new Set();
 const evaluate=(p,d,ids)=>evaluatePlan(p,d,{runtime,signal,resolve,query,scope:ids,now});
 evaluation=await evaluate(plan,candidate,scope);
 const initial=structuredClone(evaluation),changed=new Set();
 // 每次接受必须有同查询口径的严格时长下降；有限排列、拒绝身份及执行器共同限制循环。
 while(model){
  signal?.throwIfAborted();
  const eligible=evaluation.days.filter(d=>!considered.has(d.day_id) && totals(d)!==null && d.mobility==='supported' && d.long_transfers.length && plan.activities.filter(a=>a.day_id===d.day_id).length>=3).slice(0,1);
  if(!eligible.length)break;
  const state=progress.observe({conditions,structure:candidate.cards.map(c=>[c.id,c.content]),gaps:eligible.map(d=>d.day_id),evidence:evaluation.days.map(d=>[d.day_id,d.observations.map(o=>[o.from_id,o.to_id,o.duration_s])])});
  if(state.repeated)break;
  const action={name:'reorder_day',days:eligible.map(d=>d.day_id)};
  if(!progress.action(state.fingerprint,action).allowed)break;
  onTrace({stage:'planning_reasoning',status:'started',day_ids:action.days});
  const decision=await model({kind:'planning_route',schema_prompt:agentPrompt('planning.route_decision'),timeoutMs:12000,user:JSON.stringify({
   conditions,scope_day_ids:action.days,cards:candidate.cards.filter(c=>action.days.includes(c.id)),
   route_observations:eligible.map(d=>({day_id:d.day_id,basis:d.basis,coverage:d.coverage,observations:d.observations})),
   numeric_fact_catalog:eligible.flatMap(d=>d.catalog),rejected_proposals:[...rejected]})});
  if(!decision)break;
  if(decision.action!=='reorder'){considered.add(eligible[0].day_id);continue;}
  if(!action.days.includes(decision.day_id))break;
  const fingerprint=planningHash(decision);if(rejected.has(fingerprint))break;
  let proposed;try{proposed=reorderDay(candidate,decision);}catch{rejected.add(fingerprint);considered.add(decision.day_id);continue;}
  if(!changedDays(candidate,proposed).length){considered.add(decision.day_id);continue;}
  const proposedPlan=planWorkspace(proposed,conditions,plan),affected=invalidation(plan,proposedPlan).day_ids;
  const observed=await evaluate(proposedPlan,proposed,affected);
  const old=totals(evaluation.days.find(d=>d.day_id===decision.day_id)),next=totals(observed.days.find(d=>d.day_id===decision.day_id));
  if(old===null || next===null || next>=old){rejected.add(fingerprint);considered.add(decision.day_id);onTrace({stage:'planning_patch',status:'rejected',reason:'no_measured_improvement'});continue;}
  candidate=proposed;plan=proposedPlan;changed.add(decision.day_id);
  evaluation.days=evaluation.days.map(d=>observed.days.find(n=>n.day_id===d.day_id)||d);
  onTrace({stage:'planning_patch',status:'accepted',day_ids:affected});
  // 提交前仍须主流程事实与质量核验，检查点不能当作已提交稿。
  await onCheckpoint({stage:'structure_proposed',draft:candidate});
 }
 return {draft:candidate,workspace:plan,evaluation,initial,changed_day_ids:[...changed],
  assessment:{mobility:evaluation.mobility,schedule:'unknown',dated_transport:'unknown',coverage:evaluation.coverage,
   days:evaluation.days.map(d=>({day_id:d.day_id,mobility:d.mobility,schedule:d.schedule,coverage:d.coverage,gaps:d.gaps.map(g=>({type:g.type,entity_id:g.entity_id || null}))}))}};
}
