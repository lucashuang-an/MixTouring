/* 资料日期与出行日期分别判断；重新采样不会把旧文变成新文。 */
const DAY=86400000;
export function sourceDay(value){
  if(typeof value!=='string')return null;
  const m=value.trim().match(/^(\d{4})[-年/](\d{1,2})[-月/](\d{1,2})(?:日|\b|T|\s|$)/);
  if(!m)return null;
  const date=m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');
  return Number.isFinite(Date.parse(date+'T00:00:00Z')) && new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date?date:null;
}
export function sourceWindow(value){
  if(typeof value!=='string')return null;
  const parts=value.split(' ~ '),start=sourceDay(parts[0]),end=sourceDay(parts[1]);
  return parts.length===2 && start && end && start<=end?start+' ~ '+end:null;
}
export function retrievalContext({travel={},window=null,purpose='experience',now=Date.now()}={}){
  const today=new Date(now).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
  const outbound=sourceWindow(travel.outbound_window),inbound=sourceWindow(travel.return_window);
  const target=sourceWindow(window) || (outbound && inbound && travel.trip_type==='round_trip'?outbound.slice(0,10)+' ~ '+inbound.slice(13):outbound || inbound);
  return {today,target_window:sourceWindow(target),purpose,max_age_days:{transport:90,experience:365,guide:180}[purpose] || 180};
}
export function assessSourceTime(source,context=retrievalContext()){
  const published=sourceDay(source.published_at ?? source.date),sampled=sourceDay(source.sampled_at || source.checked_at);
  const start=sourceDay(source.valid_from),end=sourceDay(source.valid_until),window=sourceWindow(context.target_window);
  const age=published?Math.floor((Date.parse(context.today)-Date.parse(published))/DAY):null;
  const result={state:'recent',label:'近期资料',reason:'在资料复核周期内，仍非当期可用性证明',published_at:published,age_days:age,target_window:window,date_scope:'unverified',max_age_days:context.max_age_days};
  const state=(name,label,reason)=>({...result,state:name,label,reason,date_scope:['outside_window','expired'].includes(name)?'outside':name==='after_trip'?'not_applicable':name==='future'?'invalid':result.date_scope});
  if(published>context.today || sampled>context.today)return state('future','日期异常','资料发布日期或采样日期晚于当前日期');
  if(window && ((start && window.slice(0,10)<start) || (end && window.slice(13)>end)))return state('outside_window','不覆盖出行时间','资料明确的适用范围不能覆盖本次时间窗');
  if(end && end<context.today && (!window || window.slice(0,10)>end))return state('expired','适用期已过','资料有效期已结束');
  if(window && published && published>window.slice(13))return state('after_trip','晚于出行时间','资料发布晚于所查历史旅行时间，不能证明当时情况');
  if(window && start && end && window.slice(0,10)>=start && window.slice(13)<=end && source.validity_basis==='schedule'){
    return {...state('window_reference','适用范围参考','结构化时刻表覆盖该范围，班次与可用性仍需确认'),date_scope:'covered'};
  }
  if(!published)return state('undated','日期未明','没有可靠发布日期，不能按最新资料使用');
  if(age>context.max_age_days)return state('historical','较早资料','超过'+context.max_age_days+'天的本类资料复核周期，仅保留历史参考');
  return result;
}
export function partitionTimedSources(sources,context){
  const current=[],archive=[],excluded=[];
  const sorted=sources.map(s=>({...s,temporal:assessSourceTime(s,context)})).sort((a,b)=>(b.temporal.published_at || '').localeCompare(a.temporal.published_at || ''));
  const seen=new Set();
  for(const s of sorted){const key=s.url || s.link;if(seen.has(key))continue;seen.add(key);
    if(s.temporal.state==='future')excluded.push(s);
    else if(['recent','window_reference'].includes(s.temporal.state))current.push(s);
    else archive.push(s);
  }
  return {current,archive,excluded,context};
}
