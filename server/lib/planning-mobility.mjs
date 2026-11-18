/* 路线事实的生命周期仅限当前请求；顺序查询不得伪装为时刻表保证。 */
import {randomUUID} from 'node:crypto';
import {googleRoute} from './google-routes.mjs';
import {resolveDayMap} from './day-map.mjs';
import {planningHash} from './planning-state.mjs';
const validInstant=v=>typeof v==='string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
const finite=v=>Number.isFinite(v)&&v>=0;
export function routeObservation(result,{from,to,mode,departure=null,legId}){
 const available=!!from.provider_id && !!to.provider_id && result?.status==='available' && result.provider==='Google Maps' && result.from===from.name && result.to===to.name && result.mode===mode && Number.isSafeInteger(result.distance_m)&&finite(result.distance_m)&&finite(result.duration_s) && Number.isSafeInteger(result.duration_s*1000)
  && (mode!=='TRANSIT'||validInstant(result.departure_time) && (!departure||Date.parse(result.departure_time)===Date.parse(departure)));
 return {id:randomUUID(),leg_id:legId,provider:'Google Maps',tool_version:1,from_id:from.provider_id || null,to_id:to.provider_id || null,from:from.name,to:to.name,
  requested_mode:mode,actual_modes:available?result.actual_modes || []:[],departure_instant:result?.departure_time || null,sampled_at:result?.checked_at || null,
  status:available?'available':result?.status==='available'?'invalid':result?.status || 'unavailable',walking_only:available && result.walking_only===true,
  distance_m:available?result.distance_m:null,duration_s:available?result.duration_s:null,source_url:/^https:\/\/www\.google\.com\/maps\/dir\//.test(result?.source_url || '')?result.source_url:null};
}
export function routeFactCatalog(observations){
 return observations.filter(o=>o.status==='available').flatMap(o=>['distance_m','duration_s'].map(field=>({id:o.id+':'+field,kind:'route_observation',observation_id:o.id,field,value:o[field],unit:field==='distance_m'?'m':'s',
  from_id:o.from_id,to_id:o.to_id,mode:o.requested_mode,departure_instant:o.departure_instant,source_url:o.source_url,storage:'ephemeral'})));
}
export function supportsRouteFact(fact,observations){
 const observation=observations.find(o=>o.id===fact?.observation_id);
 return !!observation && observation.status==='available' && ['distance_m','duration_s'].includes(fact.field) && fact.value===observation[fact.field]
  && fact.from_id===observation.from_id && fact.to_id===observation.to_id && fact.mode===observation.requested_mode && fact.departure_instant===observation.departure_instant;
}
export async function evaluateDay({events,points,mode='TRANSIT',departure=null,deadline=null,timezone=null,includeOptional=true,anchorsKnown=false}, {query=googleRoute,signal,now=Date.now()}={}){
 const selected=events.filter(e=>includeOptional || !e.optional),observations=[],gaps=[],timeline=[];
 let cursor=validInstant(departure)?Date.parse(departure):null,complete=true;
 let zoneValid=false;try{if(timezone){new Intl.DateTimeFormat('en',{timeZone:timezone});zoneValid=true;}}catch{}
 const sequential=cursor!==null && zoneValid;
 if(!anchorsKnown)gaps.push({type:'unknown_anchor'});
 if(!sequential)gaps.push({type:'reference_only'});
 const stay=event=>{
  const range=event.stay_range;
  if(!range || !finite(range.min_s)||!finite(range.max_s)||range.min_s!==range.max_s || !['user','planning_assumption','source'].includes(range.basis)){gaps.push({type:'unknown_stay',entity_id:event.id});return null;}
  return range.min_s;
 };
 // 没有停留信息不编数值；后续只查同一参考时刻，并保持unknown。
 let chain=sequential;
 for(let i=0;i<selected.length;i++){
  signal?.throwIfAborted();
  const event=selected[i],duration=stay(event);
  if(/^CLOSED_/.test(points.find(p=>p.name===event.place_ref.name)?.business_status||'')){gaps.push({type:'place_status_requires_check',entity_id:event.id});}
  if(chain && event.time_window){
   const w=event.time_window;
   if(w.basis!=='source' && w.basis!=='user' || !validInstant(w.open) || !validInstant(w.close)){chain=false;gaps.push({type:'unknown_window',entity_id:event.id});}
   else {cursor=Math.max(cursor,Date.parse(w.open));if(cursor>Date.parse(w.close))gaps.push({type:'time_conflict',entity_id:event.id});}
  }
  if(chain && duration!==null){
   cursor+=duration*1000;
   if(event.time_window && cursor>Date.parse(event.time_window.close))gaps.push({type:'time_conflict',entity_id:event.id});
   timeline.push({event_id:event.id,departure_instant:new Date(cursor).toISOString()});
  }else chain=false;
  if(i===selected.length-1)continue;
  const next=selected[i+1],from=points.find(p=>p.name===event.place_ref.name)||{name:event.place_ref.name},to=points.find(p=>p.name===next.place_ref.name)||{name:next.place_ref.name};
  const at=chain?new Date(cursor).toISOString():departure;
  let result;
  if(!from.provider_id || !to.provider_id)result={status:'unresolved'};
  else result=await query(from,to,{mode,departureTime:at,signal,now});
  signal?.throwIfAborted();
  const observation=routeObservation(result,{from,to,mode,departure:at,legId:planningHash([event.id,next.id]).slice(0,20)});observations.push(observation);
  if(observation.status!=='available'){complete=false;chain=false;gaps.push({type:'route_'+observation.status,entity_id:observation.leg_id});}
  else if(mode==='TRANSIT' && !observation.actual_modes.includes('TRANSIT')){complete=false;chain=false;gaps.push({type:'requested_mode_not_supported',entity_id:observation.leg_id});}
  else if(chain)cursor+=observation.duration_s*1000;
 }
 if(selected.length<2){complete=false;gaps.push({type:'insufficient_points'});}
 if(chain && validInstant(deadline) && cursor>Date.parse(deadline))gaps.push({type:'time_conflict'});
 const conflict=gaps.some(g=>g.type==='time_conflict');
 const activitySchedule=conflict?'conflict':chain && validInstant(deadline) && !gaps.some(g=>g.type!=='unknown_anchor')?'fits_under_assumptions':'unknown';
 const schedule=activitySchedule==='conflict'?'conflict':anchorsKnown?activitySchedule:'unknown';
 return {basis:sequential?'sequential':'reference',schedule,activity_schedule:activitySchedule,mobility:complete?'supported':'partial',coverage:anchorsKnown?'including_anchors':'activity_segments_only',observations,gaps,timeline,
  long_transfers:observations.filter(o=>o.status==='available'&&o.duration_s>=5400).map(o=>o.leg_id),catalog:routeFactCatalog(observations)};
}

export async function checkDaySchedule(input,{resolve=resolveDayMap,query=googleRoute,signal,now=Date.now()}={}){
 const schedule=input?.schedule,rows=schedule?.events;
 if(typeof input?.city!=='string'||!Array.isArray(rows)||rows.length<1||rows.length>12 || !['TRANSIT','WALK','DRIVE'].includes(schedule.mode)
  || !validInstant(schedule.departure)||!validInstant(schedule.deadline)||Date.parse(schedule.deadline)<=Date.parse(schedule.departure)
  || rows.some(r=>typeof r.name!=='string'||!r.name.trim()||r.name.length>80||!finite(r.stay_minutes)||r.stay_minutes>1440))return {status:'invalid',reason:'invalid_schedule'};
 const anchors=[schedule.start_name,schedule.end_name];
 if(anchors.some(a=>a!=null && (typeof a!=='string'||!a.trim()||a.length>80)))return {status:'invalid',reason:'invalid_anchor'};
 const selected=[...(anchors[0]?[{name:anchors[0],stay_minutes:0}]:[]),...rows,...(anchors[1]?[{name:anchors[1],stay_minutes:0}]:[])];
 const places=[...new Set(selected.map(r=>r.name))];if(places.length>8)return {status:'invalid',reason:'too_many_places'};
 const located=await resolve({city:input.city,places,city_hint:input.city_hint},{signal});
 const events=selected.map((r,i)=>({id:'event-'+i,place_ref:{name:r.name},optional:r.optional===true,stay_range:{min_s:r.stay_minutes*60,max_s:r.stay_minutes*60,basis:'planning_assumption'}}));
 const options={events,points:(located.points||[]).filter(p=>p.provider==='Google Maps'),mode:schedule.mode,departure:schedule.departure,deadline:schedule.deadline,timezone:schedule.timezone,anchorsKnown:!!anchors[0]&&!!anchors[1]};
 const required=await evaluateDay({...options,includeOptional:false},{query,signal,now});
 const all=events.some(e=>e.optional)?await evaluateDay({...options,includeOptional:true},{query,signal,now}):null;
 return {status:'complete',provider:'Google Maps',cacheable:false,required,with_optional:all};
}
export async function evaluatePlan(plan,draft,{runtime,resolve=resolveDayMap,query=googleRoute,signal,mode='TRANSIT',scope=null,now=Date.now()}={}){
 const results=[];
 const days=scope?plan.days.filter(d=>scope.includes(d.id)):plan.days;
 const runDay=async day=>{
  signal?.throwIfAborted();
  const events=plan.activities.filter(e=>e.day_id===day.id),places=[...new Set(events.map(e=>e.place_ref.name))];
  if(!places.length)return {day_id:day.id,basis:'reference',schedule:'unknown',mobility:'unknown',observations:[],catalog:[],gaps:[{type:'legacy_narrative'}],long_transfers:[]};
  const args={city:day.city,places,city_hint:draft.map_places?.find(p=>p.name===day.city)||null};
  const located=runtime?await runtime.call('planning_places',args,{signal,scope:{conditions:plan.condition_hash}}):{data:await resolve(args,{signal})};
  const points=(located.data?.points || []).filter(p=>p.provider==='Google Maps');
  const call=async(from,to,options)=>runtime?(await runtime.call('planning_route',{from:{name:from.name,provider_id:from.provider_id},to:{name:to.name,provider_id:to.provider_id},mode,departureTime:options.departureTime,now},{signal,scope:{conditions:plan.condition_hash}})).data:query(from,to,options);
  const result=await evaluateDay({events,points,mode,departure:new Date(now).toISOString()}, {query:call,signal,now});
  return {day_id:day.id,...result};
 };
 if(runtime && !runtime.hasTool('planning_places')){
  const requestCache={cities:new Map(),places:new Map(),aliasAttempts:new Set()};
  runtime.register('planning_places',{readOnly:true,validate:a=>typeof a.city==='string'&&Array.isArray(a.places),execute:(a,{signal})=>resolve(a,{signal,requestCache}),classify:r=>r?.status==='complete'?'success':r?.points?.some(p=>p.provider_id)?'success':'empty'});
  runtime.register('planning_route',{readOnly:true,validate:a=>!!a.from?.provider_id&&!!a.to?.provider_id,execute:(a,{signal})=>query(a.from,a.to,{mode:a.mode,departureTime:a.departureTime,now:a.now,signal}),classify:r=>r?.status==='available'?'success':r?.status==='no_route'?'empty':'error'});
 }
 for(let i=0;i<days.length;i+=2)results.push(...await Promise.all(days.slice(i,i+2).map(runDay)));
 return {days:results,coverage:scope?'changed_days':'all_days',mobility:results.length&&results.every(d=>d.mobility==='supported')?'supported':'partial',schedule:'unknown'};
}
