/* 规划领域结构：仅保存用户结构与依赖，不保存地图供应商观察。 */
import {createHash} from 'node:crypto';
import workspace from '../../mixtouring-hifi/assets/route-workspace.js';
const canonical=v=>Array.isArray(v)?v.map(canonical):v && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const planningHash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export const PLANNING_SCHEMA=1;
export function routeMatchesIntent(route=[],routing={},requirements={}){
 if(!route.length || route[0]!==routing.origin)return false;
 const destination=route.lastIndexOf(routing.destination);if(destination<0)return false;
 const allowed=new Set(requirements.required_stops || []);
 return route.slice(destination+1).every(city=>city!==routing.origin && allowed.has(city));
}
const id=(prefix,value)=>prefix+'-'+planningHash(value).slice(0,20);
export function taskContract({requestId=null,revision=0,operation='generate',conditions={},scope=[],verifyMobility=false}={}){
 const dimensions=verifyMobility?['grounding','mobility','schedule']:['content','grounding'];
 if(conditions.requirements?.verified_cross_border_only)dimensions.push('dated_transport');
 return {schema_version:PLANNING_SCHEMA,request_id:requestId,base_revision:revision,operation,target_conditions_hash:planningHash(conditions),scope_entity_ids:[...scope],
  required_dimensions:dimensions};
}
export function planWorkspace(draft,conditions={},previous=null){
 const clean=workspace.cleanDraft(draft),days=[],activities=[],legs=[],gaps=[],used=new Set();
 for(const card of clean?.cards || []){
  const events=[],occurrences=new Map();
  for(const activity of card.activities || []){
   for(const place of activity.places || []){
    const signature=card.id+'|'+place.name,ordinal=occurrences.get(signature)||0;occurrences.set(signature,ordinal+1);
    const old=(previous?.activities || []).filter(a=>a.day_id===card.id && a.place_ref.name===place.name)[ordinal];
    const activityId=old?.id || id('activity',[signature,ordinal]);
    if(used.has(activityId))throw Error('duplicate_activity_id');used.add(activityId);
    const event={id:activityId,day_id:card.id,source_activity_id:activity.id,place_ref:{name:place.name,city:card.place},purpose:activity.text,
     optional:/可选|备选|视.{0,8}情况|若.{0,10}时间/.test(activity.text),locked:false,stay_range:null,time_window:null};
    activities.push(event);events.push(event.id);
   }
  }
  const start=id('anchor',[card.id,'start']),end=id('anchor',[card.id,'end']);
  for(const [anchor,side]of [[start,'start'],[end,'end']])gaps.push({id:id('gap',[anchor]),entity_id:anchor,type:'unknown_anchor',dimension:'schedule',side});
  const chain=[start,...events,end];
  for(let n=0;n<chain.length-1;n++)legs.push({id:id('leg',[chain[n],chain[n+1]]),day_id:card.id,from_event_id:chain[n],to_event_id:chain[n+1],mode:null,
   dependency_hash:planningHash([conditions,chain.slice(0,n+2)]),observation_ref:null});
  if(!events.length)gaps.push({id:id('gap',[card.id,'legacy']),entity_id:card.id,type:'legacy_narrative',dimension:'mobility'});
  days.push({id:card.id,city:card.place,label:card.label,event_ids:events,start_anchor:start,end_anchor:end});
 }
 return {schema_version:PLANNING_SCHEMA,condition_hash:planningHash(conditions),days,activities,legs,gaps};
}
export function changedDays(before,after){
 const old=new Map((before?.cards || []).map(c=>[c.id,c]));
 return (after?.cards || []).filter(c=>{const p=old.get(c.id);return !p || ['place','label','title','content'].some(k=>p[k]!==c[k]);}).map(c=>c.id);
}
export function invalidation(before,after){
 const old=new Map((before?.legs || []).map(l=>[l.id,l]));
 const invalid=after.legs.filter(l=>old.get(l.id)?.dependency_hash!==l.dependency_hash).map(l=>l.id);
 const removed=[...old.keys()].filter(k=>!after.legs.some(l=>l.id===k));
 return {leg_ids:invalid,retired_leg_ids:removed,day_ids:[...new Set(after.legs.filter(l=>invalid.includes(l.id)).map(l=>l.day_id))]};
}
// 模型补丁只能替换获准卡片正文，不能删除日期或修改路线。提交前仍须走证据／质量检查。
export function applyDayPatch(draft,patch,allowedIds){
 if(!Array.isArray(patch?.cards) || !patch.cards.length || patch.cards.length>allowedIds.length)throw Error('invalid_patch');
 const seen=new Set(),copy=structuredClone(draft);
 for(const card of patch.cards){
  if(!allowedIds.includes(card.id)||seen.has(card.id)||Object.keys(card).some(k=>!['id','title','content'].includes(k)))throw Error('patch_scope');
  const target=copy.cards.find(c=>c.id===card.id);if(!target || typeof card.title!=='string'||!card.title.trim()||typeof card.content!=='string'||!card.content.trim()||card.content.length>1200)throw Error('patch_shape');
  seen.add(card.id);target.title=card.title;target.content=card.content;
 }
 return workspace.cleanDraft(copy,draft);
}
// 仅服务端检查器给出维度；外部输入的assessment绝不能直接采用。
export function assessDelivery(contract,{content=false,grounding=false,mobility='unknown',schedule='unknown',datedTransport='unknown',negativeAnswer=false}={}){
 const dimensions={content:content?'complete':'partial',grounding:grounding?'supported':'unknown',mobility,schedule,dated_transport:datedTransport};
 const satisfied={content,grounding,mobility:mobility==='supported',schedule:schedule==='fits_under_assumptions'||negativeAnswer && schedule==='conflict',dated_transport:datedTransport==='supported'};
 return {dimensions,required_dimensions:contract.required_dimensions,passed:contract.required_dimensions.every(k=>satisfied[k]===true)};
}
