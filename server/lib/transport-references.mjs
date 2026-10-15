/* 方向资料只由服务端策展；报道运营方与本次已核运营方分开，航线页售期不等于逐日班次。 */
import { readFileSync } from 'node:fs';
import { isValidWindow, resolvePlace } from './anywhere.mjs';
import { utcToZoned, zonedToUtc } from './trip.mjs';
import {retrievalContext,assessSourceTime} from './source-time.mjs';
const DATA=JSON.parse(readFileSync(new URL('../../pipeline/data/transport-references.json',import.meta.url),'utf8'));
const day=(s)=>typeof s==='string' && isValidWindow(s+' ~ '+s);
const validSource=s=>s && s.title && /^https:\/\//.test(s.url || '') && day(s.sampled_at) && (s.published_at===null || day(s.published_at));
export function validSchedule(s) {
  if(!s || !s.service_no || !isValidWindow(s.start+' ~ '+s.end) || !Array.isArray(s.weekdays) || !s.weekdays.length || !s.weekdays.every(n=>Number.isInteger(n) && n>=1 && n<=7) || ![0,1,2].includes(s.arrival_day_offset)) return false;
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.depart_time || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.arrive_time || '')) return false;
  try {const arrival=new Date(Date.parse(s.start+'T00:00:00Z')+s.arrival_day_offset*86400000).toISOString().slice(0,10);
    const duration=zonedToUtc(arrival,s.arrive_time,s.to_tz)-zonedToUtc(s.start,s.depart_time,s.from_tz);return duration>0 && duration<=36*3600000;
  } catch{return false;}
}
export function validTransportReference(r) {
  return !!(r && r.id && resolvePlace(r.from) && resolvePlace(r.to) && r.from!==r.to &&
    r.kind==='public_transport' && ['plane','rail','road_passenger'].includes(r.mode) &&
    ['source_lead','historical','dated_partial'].includes(r.evidence_state) && r.method && r.duration_minutes===null &&
    (!r.schedule || validSchedule(r.schedule)) && (r.evidence_state!=='dated_partial' || !!r.schedule) &&
    validSource(r.source) && (!r.supplementary_sources || Array.isArray(r.supplementary_sources) && r.supplementary_sources.every(validSource)) &&
    (!r.route_nodes || Array.isArray(r.route_nodes) && r.route_nodes.length>=2 && r.route_nodes.length<=12 && r.route_nodes[0]===r.from && r.route_nodes.at(-1)===r.to && r.route_nodes.every(p=>typeof p==='string' && p.length<=80)) &&
    (r.reported_until===null || day(r.reported_until)) && (!r.review_by || day(r.review_by)));
}
export function transportReferences(from,to,nowMs=Date.now(),window=null) {
  const today=utcToZoned(nowMs,'Asia/Shanghai').dateStr;
  return DATA.references.filter(r=>r.from===from && r.to===to && validTransportReference(r)).map(r=>{
    const copy=structuredClone(r);
    if ((r.review_by && today>r.review_by) || (r.reported_until && today>r.reported_until)) copy.evidence_state='stale';
    if (r.source.sampled_at>today || (r.source.published_at && r.source.published_at>today)) copy.evidence_state='unsupported';
    copy.date_scope=r.reported_until && isValidWindow(window) && window.slice(13,23)>r.reported_until?'outside_reference':'unverified';
    if(r.schedule) {
      if(today>r.schedule.end) copy.evidence_state='stale';
      if(isValidWindow(window)) {
        const first=window.slice(0,10),last=window.slice(13,23);
        copy.date_scope=first<r.schedule.start || last>r.schedule.end?'outside_reference':'schedule_range';
        const dates=[];
        if((Date.parse(last)-Date.parse(first))/86400000<=31) for(let date=Date.parse(first+'T00:00:00Z');date<=Date.parse(last+'T00:00:00Z');date+=86400000) {
          const text=new Date(date).toISOString().slice(0,10),weekday=new Date(date).getUTCDay() || 7;
          if(text>=r.schedule.start && text<=r.schedule.end && r.schedule.weekdays.includes(weekday)) dates.push(text);
        }
        copy.schedule_dates=dates;
        if(!dates.length || copy.date_scope==='outside_reference') copy.evidence_state='unsupported';
      } else if(copy.evidence_state==='dated_partial') copy.evidence_state='source_lead';
    }
    copy.missing=['本次具体班次和起落两端当地时刻','指定日期运营与可用性','本次单人票价、行李及市内接驳'];
    return copy;
  });
}

/** 仅查服务端资料；传入城市链用于匹配，不能把客户端内容变成交通事实。 */
export function routeTransportReferences(route,nowMs=Date.now(),window=null) {
  if(!Array.isArray(route) || route.length<2 || route.length>12 || route.some(p=>typeof p!=='string' || !p.trim() || p.length>80))throw Error('请提供有效的路线城市链');
  const names=route.map(p=>resolvePlace(p)?.name || p.trim());
  /* 去程出发窗只约束首段，不能当成停留后的跨境乘车日期。 */
  return names.slice(1).map((to,i)=>{
    const context=retrievalContext({window:i===0?window:null,purpose:'transport',now:nowMs});
    const refs=transportReferences(names[i],to,nowMs,i===0?window:null).filter(r=>r.evidence_state!=='unsupported').map(r=>{
      const temporal=assessSourceTime({...r.source,valid_from:r.schedule?.start,valid_until:r.schedule?.end || r.reported_until,validity_basis:r.schedule?'schedule':null},context);
      return {...r,temporal,source:{...r.source,temporal},supplementary_sources:(r.supplementary_sources || []).map(s=>({...s,temporal:assessSourceTime(s,context)})).filter(s=>s.temporal.state!=='future')};
    }).sort((a,b)=>(a.mode==='road_passenger'?0:1)-(b.mode==='road_passenger'?0:1));
    const directions=refs.filter(r=>r.temporal.state!=='future').map(r=>({id:r.id,from:r.from,to:r.to,mode:r.mode,label:r.label,route_nodes:r.route_nodes,method:r.method,source:r.source,supplementary_sources:r.supplementary_sources,reported_boarding_stop:r.reported_boarding_stop,evidence_state:'explore',temporal:{label:'交通方向参考',reason:'资料支持探索这一走法；本次班次、票价与适用日期仍待确认。'}}));
    return {from:names[i],to,directions,options:refs.filter(r=>['recent','window_reference'].includes(r.temporal.state)),archive:refs.filter(r=>!['recent','window_reference','future'].includes(r.temporal.state)),temporal:context};
  });
}
