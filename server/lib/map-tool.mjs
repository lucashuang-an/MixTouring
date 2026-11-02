/* 地理工具也使用同一调用/结果协议；定位不构成交通或事实核实。 */
import {createAgentRuntime} from './agent-runtime.mjs';
import {resolveMapPlaces} from './map-places.mjs';
import {resolveDayMap} from './day-map.mjs';
export async function runMapTool(name,input,{signal,onTrace,resolveCities=resolveMapPlaces,resolveDay=resolveDayMap}={}){
  const runtime=createAgentRuntime({onEvent:onTrace});
  runtime.register('map_cities',{validate:a=>Array.isArray(a?.names),execute:(a,{signal})=>resolveCities(a.names,Array.isArray(a.places)?a.places:[],{signal})});
  runtime.register('map_day',{validate:a=>typeof a?.city==='string' && Array.isArray(a.places),execute:(a,{signal})=>resolveDay(a,{signal})});
  let result;
  try{result=await runtime.call(name,input,{signal});}catch{result={status:'interrupted',data:null};}
  const data=result.data || {points:[],status:'partial'};
  const outcome=runtime.finish({status:['error','interrupted'].includes(result.status)?'failed':'completed',taskState:result.status==='success' && data.status==='complete' && (!data.transport || data.transport.status==='complete')?'satisfied':'active'});
  return {...data,...outcome};
}
