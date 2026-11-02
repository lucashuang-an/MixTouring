import {planDayTravel} from './google-routes.mjs';
import {composeJson,composeConfigured} from './llm.mjs';
import {agentPrompt} from './agent-prompts.mjs';
/* Google Places定位：密钥仅在请求头；结果不作为运营／路线可达证明。 */
import {ProxyAgent} from 'undici';
const dispatchers=new Map();
const endpoint='https://places.googleapis.com/v1/places:searchText';
const mask='places.id,places.displayName,places.location,places.addressComponents,places.googleMapsUri,places.attributions,places.businessStatus';
const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s·・]/g,'').replace(/市$/,'');
export const googleMapsEnabled=()=>process.env.MAP_PROVIDER==='google' || !process.env.MAP_PROVIDER && !!process.env.GOOGLE_MAPS_API_KEY;
export function googlePlaceUrl(name,id){return 'https://www.google.com/maps/search/?'+new URLSearchParams({api:'1',query:name,...(id?{query_place_id:id}:{})});}
const countryOf=p=>p.addressComponents?.find(c=>c.types?.includes('country'))?.shortText;
const valid=p=>typeof p.id==='string' && /^[A-Za-z0-9_-]{1,200}$/.test(p.id) && Number.isFinite(p.location?.latitude) && Math.abs(p.location.latitude)<=90 && Number.isFinite(p.location?.longitude) && Math.abs(p.location.longitude)<=180;
const km=(a,b)=>{const rad=Math.PI/180,x=(a.lat-b.lat)*rad,y=(a.lon-b.lon)*rad;return 12742*Math.asin(Math.min(1,Math.sqrt(Math.sin(x/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(y/2)**2)));};
export async function googlePlace(name,{query=name,aliases=[],country=null,center=null,language='zh-CN',signal,fetchImpl=fetch,apiKey=process.env.GOOGLE_MAPS_API_KEY,proxy=process.env.GOOGLE_MAPS_PROXY_URL}={}){
 const missing=reason=>({name,lat:null,lon:null,provider:'Google Maps',reason,source_url:googlePlaceUrl(query)});
 if(!apiKey)return missing('not_configured');
 if(signal?.aborted)return missing('cancelled');
 try{
  let dispatcher;if(proxy){if(!dispatchers.has(proxy))dispatchers.set(proxy,new ProxyAgent(proxy));dispatcher=dispatchers.get(proxy);}
  const response=await fetchImpl(endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-Goog-Api-Key':apiKey,'X-Goog-FieldMask':mask},
   body:JSON.stringify({textQuery:query,languageCode:language,pageSize:3,...(country?{regionCode:country}:{}),...(center?{locationBias:{circle:{center:{latitude:center.lat,longitude:center.lon},radius:50000}}}:{})}),
   ...(dispatcher?{dispatcher}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)});
  if(!response.ok)return missing('http_'+response.status);
  const body=await response.json();
  const candidates=(Array.isArray(body.places)?body.places:[]).filter(p=>valid(p) && (!country || countryOf(p)===country) && (!center || km(center,{lat:p.location.latitude,lon:p.location.longitude})<=250));
  const accepted=new Set([name,...aliases].map(norm));
  const exact=candidates.filter(p=>accepted.has(norm(p.displayName?.text)));
  const matches=exact.length?exact:candidates;
  if(matches.length!==1)return missing(matches.length?'ambiguous':'not_found');
  if(signal?.aborted)return missing('cancelled');
  const p=matches[0];
  return {name,lat:p.location.latitude,lon:p.location.longitude,matched_name:p.displayName?.text || name,country:countryOf(p),provider:'Google Maps',provider_id:p.id,
   match_basis:exact.length?'name':'single_query_result',business_status:p.businessStatus || null,source_url:googlePlaceUrl(name,p.id),attributions:(p.attributions||[]).map(a=>a.provider).filter(a=>typeof a==='string')};
 }catch{return missing(signal?.aborted?'cancelled':'network_unavailable');}
}
const result=points=>({points,provider:'Google Maps',attribution:'Google Maps',cacheable:false,status:points.length&&points.every(p=>p.lat!=null)?'complete':'partial'});
const requestMemo=(cache,key,execute)=>{if(!cache)return execute();if(!cache.has(key))cache.set(key,Promise.resolve().then(execute));return cache.get(key);};
export async function resolveGoogleCities(names,hints=[],options={}){
 const list=[...new Set((Array.isArray(names)?names:[]).filter(n=>typeof n==='string'&&n.trim()&&n.length<=80))].slice(0,12);
 const points=[];for(let i=0;i<list.length;i+=2)points.push(...await Promise.all(list.slice(i,i+2).map(name=>{
  const hint=hints.find(h=>h.name===name)||{},country=/^[A-Z]{2}$/.test(hint.country_hint)?hint.country_hint:null;
  const latin=typeof hint.name_latin==='string'&&hint.name_latin.length<=100?hint.name_latin:null;
  return googlePlace(name,{...options,country,query:(latin||name)+(country?' '+country:''),aliases:latin?[latin]:[]});
 })));
 return result(points);
}
export async function resolveGoogleDay({city,places=[],city_hint=null,transport_mode=null,departure_time=null,sequence=null,optional=false}={},options={}){
 options={...options,signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(35000)]):AbortSignal.timeout(35000)};
 const names=[...new Set((Array.isArray(places)?places:[]).map(p=>typeof p==='string'?p:p?.name).filter(n=>typeof n==='string'&&n.trim()&&n.length<=80))].slice(0,8);
 if(typeof city!=='string'||!city.trim()||city.length>80||!names.length)return result([]);
 const cityQuery=typeof city_hint?.name_latin==='string'&&city_hint.name_latin.length<=100?city_hint.name_latin:city;
 const cities=await requestMemo(options.requestCache?.cities,JSON.stringify([city,city_hint]),()=>resolveGoogleCities([city],city_hint?[{...city_hint,name:city}]:[],options)),center=cities.points.find(p=>p.lat!=null);
 if(!center)return result(names.map(name=>({name,lat:null,lon:null,provider:'Google Maps',reason:'city_unresolved',source_url:googlePlaceUrl(city+' '+name)})));
 const points=[];for(let i=0;i<names.length;i+=2)points.push(...await Promise.all(names.slice(i,i+2).map(name=>requestMemo(options.requestCache?.places,JSON.stringify([city,city_hint,name]),()=>googlePlace(name,{...options,center,country:center.country,query:name+' '+cityQuery})))));
 const unresolved=points.filter(p=>['ambiguous','not_found'].includes(p.reason) && !options.requestCache?.aliasAttempts?.has(JSON.stringify([city,city_hint,p.name])));
 if(unresolved.length && !options.signal?.aborted && (options.resolveNames || composeConfigured())){
  for(const p of unresolved)options.requestCache?.aliasAttempts?.add(JSON.stringify([city,city_hint,p.name]));
  let aliases=[];try{const response=options.resolveNames?await options.resolveNames(city,unresolved.map(p=>p.name)):await composeJson({kind:'day_map_query',timeoutMs:10000,signal:options.signal,schema_prompt:agentPrompt('map.query_names'),user:JSON.stringify({city,names:unresolved.map(p=>p.name)})});aliases=Array.isArray(response)?response:response?.places || [];}catch{}
  if(!Array.isArray(aliases))aliases=[];
  for(const failed of unresolved){const hints=aliases.find(p=>p?.name===failed.name)?.aliases,alias=(Array.isArray(hints)?hints:[]).find(s=>typeof s==='string'&&s.length<=100);if(!alias)continue;
   const retried=await googlePlace(failed.name,{...options,center,country:center.country,language:'en',aliases:[alias],query:alias+' '+cityQuery});
   if(retried.lat!=null){points[points.indexOf(failed)]=retried;options.requestCache?.places?.set(JSON.stringify([city,city_hint,failed.name]),Promise.resolve(retried));}
  }
 }
 const output=result(points);
 if(transport_mode)output.transport=await planDayTravel({points,sequence,mode:transport_mode,departureTime:departure_time,optional},options);
 return output;
}

export async function googleStaticMap(ids,{signal,fetchImpl=fetch,apiKey=process.env.GOOGLE_MAPS_API_KEY,proxy=process.env.GOOGLE_MAPS_PROXY_URL}={}){
 if(!Array.isArray(ids)||!ids.length||ids.length>12||ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(id)))return {status:400,reason:'invalid_places'};
 if(!apiKey)return {status:503,reason:'not_configured'};
 try{
  const url=new URL('https://maps.googleapis.com/maps/api/staticmap');
  url.search=new URLSearchParams({size:'640x320',scale:'2',format:'png',language:'zh-CN',key:apiKey}).toString();
  [...new Set(ids)].forEach((id,i)=>url.searchParams.append('markers','label:'+String.fromCharCode(65+i)+'|place_id:'+id));
  let dispatcher;if(proxy){if(!dispatchers.has(proxy))dispatchers.set(proxy,new ProxyAgent(proxy));dispatcher=dispatchers.get(proxy);}
  const response=await fetchImpl(url,{redirect:'error',...(dispatcher?{dispatcher}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
  if(!response.ok || !response.headers.get('content-type')?.startsWith('image/png')){await response.body?.cancel();return {status:502,reason:'google_map_unavailable',upstream_status:response.status};}
  const data=Buffer.from(await response.arrayBuffer());if(data.length>4*1024*1024)return {status:502,reason:'image_too_large'};
  return {status:200,data};
 }catch{return {status:502,reason:signal?.aborted?'cancelled':'network_unavailable'};}
}
