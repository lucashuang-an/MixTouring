import {googleMapsEnabled,resolveGoogleDay} from './google-maps.mjs';
import {resolveMapPlaces} from './map-places.mjs';
import {composeJson,composeConfigured} from './llm.mjs';
import {agentPrompt} from './agent-prompts.mjs';
const cache=new Map();
const norm=s=>String(s || '').normalize('NFKC').toLowerCase().replace(/[\s·・]/g,'');
const aliasKey=s=>String(s || '').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const distance=(a,b)=>{const rad=Math.PI/180,x=(a.lat-b.lat)*rad,y=(a.lon-b.lon)*rad;return 6371000*2*Math.asin(Math.min(1,Math.sqrt(Math.sin(x/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(y/2)**2)));};
export function matchDayPlaces(names,elements,center){
  return names.map(name=>{
    if(norm(name)===norm(center.name))return {...center,name};
    const candidates=elements.flatMap(e=>{
      const tags=e.tags || {},aliases=Object.entries(tags).filter(([k])=>/^(?:name(?::[\w-]+)?|alt_name|official_name|short_name)$/.test(k)).flatMap(([,v])=>String(v).split(';'));
      const lat=e.lat ?? e.center?.lat,lon=e.lon ?? e.center?.lon;
      if(!aliases.some(a=>norm(a)===norm(name)) || !Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180||distance({lat,lon},center)>250000)return [];
      return [{name,lat,lon,matched_name:tags.matched_name || tags.name,provider:'OpenStreetMap/Overpass',provider_id:e.type+'/'+e.id,source_url:'https://www.openstreetmap.org/'+e.type+'/'+e.id}];
    });
    // 同一地点的节点与轮廓可视为同一位置；分散的同名候选不猜测。
    return candidates.length && candidates.every(p=>distance(p,candidates[0])<200)?candidates[0]:{name,lat:null,lon:null};
  });
}
export async function resolveDayMap({city,places=[],city_hint=null,transport_mode=null,departure_time=null,sequence=null,optional=false}={}, {signal,fetchImpl=fetch,resolveCity=resolveMapPlaces,resolveNames=null,usePhoton=true,now=Date.now(),requestCache=null}={}){
  if(googleMapsEnabled())return resolveGoogleDay({city,places,city_hint,transport_mode,departure_time,sequence,optional},{signal,fetchImpl,requestCache,...(resolveNames?{resolveNames}:{})});
  signal=signal?AbortSignal.any([signal,AbortSignal.timeout(35000)]):AbortSignal.timeout(35000);
  const names=[...new Set((Array.isArray(places)?places:[]).map(p=>typeof p==='string'?p:p?.name).filter(n=>typeof n==='string' && n.trim() && n.length<=80))].slice(0,8);
  const missing={points:names.map(name=>({name,lat:null,lon:null})),status:'partial',attribution:'© OpenStreetMap contributors',checked_at:new Date(now).toISOString()};
  if(typeof city!=='string' || !city.trim() || city.length>80 || !names.length || signal?.aborted)return missing;
  const key=JSON.stringify([city,names,city_hint?.name_latin,city_hint?.country_hint]),old=cache.get(key);
  if(old && now-old.at<86400000)return old.value;
  const cityResult=await resolveCity([city],city_hint?[{name:city,name_latin:city_hint.name_latin,country_hint:city_hint.country_hint}]:[],{signal,fetchImpl,now});
  const center=cityResult.points.find(p=>p.name===city && Number.isFinite(p.lat)&&Number.isFinite(p.lon));
  if(!center)return missing;
  if(usePhoton){
    // 模型只给检索用别名，坐标、身份和国家均取实际地理服务，不消费模型坐标。
    let aliases=[];
    try{if(resolveNames)aliases=await resolveNames(city,names,{signal});else if(composeConfigured()){
      const hints=await composeJson({kind:'day_map_query',timeoutMs:10000,signal,schema_prompt:agentPrompt('map.query_names'),user:JSON.stringify({city,names})});aliases=hints?.places || [];
    }}catch{}
    if(!Array.isArray(aliases))aliases=[];
    const points=[];
    for(let i=0;i<names.length;i+=2){
      points.push(...await Promise.all(names.slice(i,i+2).map(async name=>{
        const row=aliases.find(p=>p?.name===name),hints=(Array.isArray(row?.aliases)?row.aliases:[]).filter(s=>typeof s==='string'&&s.length<=100).slice(0,2);
        const query=(hints[0] || name)+' '+(city_hint?.name_latin || city);
        try{
          const response=await fetchImpl('https://photon.komoot.io/api/?'+new URLSearchParams({q:query,limit:'5',lang:'en',lat:String(center.lat),lon:String(center.lon)}),{redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])});
          if(!response.ok)throw Error('geocoder');
          const body=await response.json(),accepted=new Set([name,...hints].map(aliasKey));
          const elements=(body.features || []).filter(f=>!center.country || !f.properties?.countrycode || f.properties.countrycode.toUpperCase()===center.country).flatMap(f=>{
            const p=f.properties || {},coordinates=f.geometry?.coordinates,type={N:'node',W:'way',R:'relation'}[p.osm_type];
            if(!type || !Array.isArray(coordinates) || !accepted.has(aliasKey(p.name)))return [];
            return [{type,id:p.osm_id,lat:coordinates[1],lon:coordinates[0],tags:{name,matched_name:p.name}}];
          });
          return {...matchDayPlaces([name],elements,center)[0],provider:'OpenStreetMap/Photon'};
        }catch{return {name,lat:null,lon:null};}
      })));
    }
    if(points.some(p=>p.lat!=null)){
      const value={...missing,points,status:points.every(p=>p.lat!=null)?'complete':'partial'};cache.set(key,{at:now,value});if(cache.size>100)cache.delete(cache.keys().next().value);return value;
    }
  }
  const alternatives=names.map(n=>n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  const pattern=JSON.stringify('^('+alternatives+')$');
  const clauses=['name','name:zh','name:en','name:ru','name:kk','alt_name'].map(tag=>'nwr(around:250000,'+center.lat+','+center.lon+')['+JSON.stringify(tag)+'~'+pattern+',i];').join('');
  try{
    const response=await fetchImpl('https://overpass.private.coffee/api/interpreter',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded','user-agent':'MixTouring-DayMap/1.0'},body:new URLSearchParams({data:'[out:json][timeout:15];('+clauses+');out center 100;'}).toString(),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
    if(!response.ok)return missing;
    const body=await response.json(),points=matchDayPlaces(names,Array.isArray(body.elements)?body.elements:[],center);
    const value={...missing,points,status:points.every(p=>p.lat!=null)?'complete':'partial'};
    if(!signal?.aborted){cache.set(key,{at:now,value});if(cache.size>100)cache.delete(cache.keys().next().value);}return value;
  }catch{return missing;}
}
