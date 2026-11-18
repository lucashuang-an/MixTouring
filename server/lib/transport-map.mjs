/* 跨城工具优先：Google城市定位→Routes，缺口再交搜索；地图数值不进入保存或证据目录。 */
import {googleMapsEnabled,resolveGoogleCities} from './google-maps.mjs';
import {googleRoute,routeLink} from './google-routes.mjs';
export async function queryTransportMap({from,to,mode='unknown',exclude_road=false,no_self_drive=false,places=[]},{signal,now=Date.now(),enabled=googleMapsEnabled(),resolve=resolveGoogleCities,route=googleRoute}={}){
  const requests=mode==='plane'?[]:[...(['unknown','drive'].includes(mode)&&!exclude_road&&!no_self_drive?[{mode:'DRIVE',kind:'drive'}]:[]),...(['unknown','rail','road'].includes(mode)?[{mode:'TRANSIT',kind:mode==='road'?'road':'rail',transitModes:mode==='road'?['BUS']:['TRAIN']}]:[])];
  if(!requests.length)return {options:[],attempts:[]};
  const failure=(request,reason)=>({mode:request.mode,kind:request.kind,status:'unavailable',reason});
  if(!enabled)return {options:[],attempts:requests.map(r=>failure(r,'not_configured'))};
  const toolSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(26000)]):AbortSignal.timeout(26000);
  let found;try{found=await resolve([from,to],places,{signal:toolSignal});}catch{found={points:[]};}
  if(signal?.aborted)throw Error('请求已取消');
  const points=found.points || [],a=points.find(p=>p.name===from&&p.provider==='Google Maps'&&p.provider_id&&p.lat!=null),b=points.find(p=>p.name===to&&p.provider==='Google Maps'&&p.provider_id&&p.lat!=null);
  if(!a || !b)return {options:[],attempts:requests.map(r=>failure(r,toolSignal.aborted?'timeout':'unresolved_endpoint'))};
  const results=await Promise.allSettled(requests.map(r=>route(a,b,{mode:r.mode,transitModes:r.transitModes,now,signal:toolSignal})));
  if(signal?.aborted)throw Error('请求已取消');
  const options=[],attempts=[];
  results.forEach((result,i)=>{
    const request=requests[i],data=result.status==='fulfilled'?result.value:null;
    const trainTypes=['RAIL','HEAVY_RAIL','COMMUTER_TRAIN','HIGH_SPEED_TRAIN','LONG_DISTANCE_TRAIN','METRO_RAIL','MONORAIL','SUBWAY','TRAM'];
    const actualTransit=data?.actual_modes?.includes('TRANSIT'),vehicles=data?.transit_vehicle_types || [];
    const matched=request.mode==='DRIVE' || actualTransit && (request.kind==='rail'?vehicles.some(v=>trainTypes.includes(v)):vehicles.some(v=>['BUS','INTERCITY_BUS','TROLLEYBUS','SHARE_TAXI'].includes(v)));
    const excludedRoad=exclude_road && vehicles.some(v=>['BUS','INTERCITY_BUS','TROLLEYBUS','SHARE_TAXI'].includes(v));
    const available=data?.status==='available' && matched && !excludedRoad && !data.walking_only && Number.isFinite(data.duration_s) && data.duration_s>=0 && Number.isFinite(data.distance_m) && data.distance_m>=0;
    const attempt={mode:request.mode,kind:request.kind,status:available?'available':data?.status==='available'?'unsupported':data?.status || 'unavailable',reason:available?null:excludedRoad?'excluded_road':data?.walking_only?'walking_only':data?.status==='available'?'requested_mode_not_returned':data?.reason || 'tool_failed',source_url:routeLink(a,b,request.mode)};
    attempts.push(attempt);if(!available)return;
    options.push({id:'google-route-'+request.kind,from,to,mode:request.kind,label:request.kind==='drive'?'自驾':request.kind==='rail'?'火车／公共交通':'公共汽车',route_nodes:[from,to],basis:'route_tool',provider:'Google Maps',cacheable:false,evidence_state:'explore',
      method:request.kind==='drive'?'Google Routes 返回的城市间驾车路线；可在地图中查看具体道路。':'Google Routes 返回的公共交通连接，完整路线可能包含市内接驳与步行。',
      route_result:{distance_m:data.distance_m,duration_s:data.duration_s,departure_time:data.departure_time,time_basis:data.time_basis,checked_at:data.checked_at},
      source:{kind:'map',title:'在 Google Maps 查看路线',url:attempt.source_url},
      temporal:{label:'Google Routes',reason:request.kind==='drive'?'按城市定位点计算的参考距离与耗时，不含休息和具体住宿接驳，不代表实时路况。':'按查询时刻获取的公共交通参考，不代表旅行日期班次或余票。'}});
  });
  return {options,attempts};
}
