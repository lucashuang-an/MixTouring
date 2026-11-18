import {reserveUpstream} from './upstream-budget.mjs';
/* 地点间交通参考：仅使用Google返回的道路距离/时长，不用直线距离推算。 */
import {ProxyAgent} from 'undici';
const agents=new Map();
const modes=new Set(['TRANSIT','WALK','DRIVE']);
const idOk=id=>typeof id==='string' && /^[A-Za-z0-9_-]{1,200}$/.test(id);
export function routeLink(from,to,mode){return 'https://www.google.com/maps/dir/?'+new URLSearchParams({api:'1',origin:from.name,destination:to.name,...(from.provider_id?{origin_place_id:from.provider_id}:{}),...(to.provider_id?{destination_place_id:to.provider_id}:{}),travelmode:{TRANSIT:'transit',WALK:'walking',DRIVE:'driving'}[mode]||'transit'});}
export async function googleRoute(from,to,{mode='TRANSIT',departureTime=null,transitModes=null,now=Date.now(),signal,fetchImpl=fetch,apiKey=process.env.GOOGLE_MAPS_API_KEY,proxy=process.env.GOOGLE_MAPS_PROXY_URL}={}){
 const base={from:from?.name||'',to:to?.name||'',mode,provider:'Google Maps',checked_at:new Date(now).toISOString(),time_basis:mode==='TRANSIT'?'reference_departure':'typical',departure_time:null,distance_m:null,duration_s:null};
 if(!modes.has(mode))return {...base,status:'invalid',reason:'invalid_mode'};
 if(!idOk(from?.provider_id)||!idOk(to?.provider_id))return {...base,status:'unresolved',reason:'unresolved_endpoint'};
 const source_url=routeLink(from,to,mode);
 let at=null;if(mode==='TRANSIT'){
  if(departureTime && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(departureTime) || !Number.isFinite(Date.parse(departureTime))))return {...base,status:'invalid',reason:'invalid_departure_time'};
  if(departureTime){const parts=departureTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/),date=new Date(Date.UTC(+parts[1],+parts[2]-1,+parts[3]));if(date.getUTCFullYear()!==+parts[1] || date.getUTCMonth()!==+parts[2]-1 || date.getUTCDate()!==+parts[3] || +parts[4]>23 || +parts[5]>59 || +parts[6]>59)return {...base,status:'invalid',reason:'invalid_departure_time'};}
  at=departureTime?new Date(departureTime).toISOString():new Date(now).toISOString();
  if(Date.parse(at)<now-7*86400000 || Date.parse(at)>now+100*86400000)return {...base,status:'unsupported',reason:'departure_out_of_range'};
 }
 const result={...base,departure_time:at,source_url};
 if(!apiKey)return {...result,status:'unavailable',reason:'not_configured'};
 if(signal?.aborted)return {...result,status:'unavailable',reason:'cancelled'};
 try{
  let dispatcher;if(proxy){if(!agents.has(proxy))agents.set(proxy,new ProxyAgent(proxy));dispatcher=agents.get(proxy);}
  const preferred=Array.isArray(transitModes)?[...new Set(transitModes.filter(m=>['BUS','SUBWAY','TRAIN','LIGHT_RAIL','RAIL'].includes(m)))]:[];
    await reserveUpstream('map');
  const response=await fetchImpl('https://routes.googleapis.com/directions/v2:computeRoutes',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json','X-Goog-Api-Key':apiKey,'X-Goog-FieldMask':'routes.distanceMeters,routes.duration,routes.legs.steps.travelMode,routes.legs.steps.transitDetails.transitLine.vehicle.type'},
   body:JSON.stringify({origin:{placeId:from.provider_id},destination:{placeId:to.provider_id},travelMode:mode,...(at?{departureTime:at}:{}),...(mode==='TRANSIT'&&preferred.length?{transitPreferences:{allowedTravelModes:preferred}}:{}),...(mode==='DRIVE'?{routingPreference:'TRAFFIC_UNAWARE'}:{}),languageCode:'zh-CN',units:'METRIC'}),
   ...(dispatcher?{dispatcher}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)});
  if(!response.ok)return {...result,status:'unavailable',reason:'http_'+response.status};
  const data=await response.json();if(!Array.isArray(data.routes)||!data.routes.length)return {...result,status:'no_route',reason:'no_route_returned'};
  const r=data.routes[0],seconds=typeof r.duration==='string' && /^\d+(?:\.\d+)?s$/.test(r.duration)?Number(r.duration.slice(0,-1)):NaN;
  if(!Number.isSafeInteger(r.distanceMeters)||r.distanceMeters<0||!Number.isFinite(seconds)||seconds<0)return {...result,status:'unavailable',reason:'invalid_response'};
  if(signal?.aborted)return {...result,status:'unavailable',reason:'cancelled'};
  const actualModes=[...new Set((r.legs || []).flatMap(l=>l.steps || []).map(s=>s.travelMode).filter(m=>modes.has(m)))];
  const vehicleTypes=[...new Set((r.legs || []).flatMap(l=>l.steps || []).map(s=>s.transitDetails?.transitLine?.vehicle?.type).filter(v=>typeof v==='string'&&v.length<=40))];
  return {...result,status:'available',distance_m:r.distanceMeters,duration_s:seconds,actual_modes:actualModes,transit_vehicle_types:vehicleTypes,walking_only:mode==='TRANSIT' && actualModes.length===1 && actualModes[0]==='WALK'};
 }catch{return {...result,status:'unavailable',reason:signal?.aborted?'cancelled':'network_unavailable'};}
}
export async function planDayTravel({points=[],sequence=null,mode='TRANSIT',departureTime=null,optional=false}={},options={}){
 const names=Array.isArray(sequence)?sequence:points.map(p=>p.name),stops=[];
 for(const name of names.slice(0,12)){
  if(typeof name!=='string' || !name.trim() || name.length>80)return {status:'invalid',reason:'invalid_stop',legs:[]};
  const point=points.find(p=>p.name===name) || {name,provider_id:null};
  if(stops.length && (stops.at(-1).name===point.name || point.provider_id && stops.at(-1).provider_id===point.provider_id))continue;
  stops.push(point);
 }
 if(!modes.has(mode))return {status:'invalid',reason:'invalid_mode',legs:[]};
 if(stops.length<2)return {status:'not_applicable',reason:'fewer_than_two_points',legs:[]};
 const legs=[],sampleNow=options.now ?? Date.now();
 for(let i=0;i<stops.length-1;i+=2)legs.push(...await Promise.all(stops.slice(i,Math.min(i+2,stops.length-1)).map((from,j)=>googleRoute(from,stops[i+j+1],{...options,now:sampleNow,mode,departureTime}))));
 const available=legs.filter(l=>l.status==='available'),omitted=Math.max(0,names.length-12),complete=available.length===legs.length && omitted===0;
 return {provider:'Google Maps',status:complete?'complete':'partial',mode,cacheable:false,order_basis:'activity_mentions',includes_optional:optional===true,
  legs,coverage:{requested:legs.length,available:available.length,missing:legs.length-available.length,omitted_stops:omitted},
  summary:available.length?{distance_m:available.reduce((sum,l)=>sum+l.distance_m,0),duration_s:available.reduce((sum,l)=>sum+l.duration_s,0),complete,
   basis:'independent_segments_same_reference_time',excludes_stay_time:true}:null,
  planning_hints:available.some(l=>l.duration_s>=5400)?['long_transfers']:[]};
}
