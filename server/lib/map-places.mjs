import {reserveUpstream} from './upstream-budget.mjs';
import {googleMapsEnabled,resolveGoogleCities} from './google-maps.mjs';
/* 在线地图城市定位；坐标只取地理服务，不取模型生成值，不证明交通连接。 */
const cache=new Map();
export async function resolveMapPlaces(names,places=[],{signal,fetchImpl=fetch,now=Date.now()}={}){
  if(googleMapsEnabled())return resolveGoogleCities(names,places,{signal,fetchImpl});
  const list=[...new Set((Array.isArray(names)?names:[]).filter(n=>typeof n==='string' && n.trim() && n.length<=80))].slice(0,12);
  const points=await Promise.all(list.map(async name=>{
    const hint=places.find(p=>p.name===name),country=/^[A-Z]{2}$/.test(hint?.country_hint || hint?.country)?hint.country_hint || hint.country:null;
    const key=JSON.stringify([name,country,hint?.name_latin || null]),old=cache.get(key);
    if(old && now-old.at<86400000)return old.point;
    const missing={name,lat:null,lon:null};
    if(signal?.aborted)return missing;
    try{
      const apiKey=process.env.OPEN_METEO_API_KEY;
      const query=new URLSearchParams({name:hint?.name_latin || name,count:'10',language:'en',format:'json',...(country?{countryCode:country}:{}),...(apiKey?{apikey:apiKey}:{})});
      if(apiKey)await reserveUpstream('map');
      const response=await fetchImpl((apiKey?'https://customer-geocoding-api.open-meteo.com':'https://geocoding-api.open-meteo.com')+'/v1/search?'+query,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(4500)]):AbortSignal.timeout(4500)});
      if(!response.ok)return missing;
      const body=await response.json(),norm=s=>String(s || '').toLowerCase().replace(/\s/g,'').replace(/市$|city$/,'');
      const cities=(body.results || []).filter(p=>/^PPL/.test(p.feature_code || '') && Number.isFinite(p.latitude) && Math.abs(p.latitude)<=90 && Number.isFinite(p.longitude) && Math.abs(p.longitude)<=180 && (!country || p.country_code===country));
      const exact=cities.filter(p=>[name,hint?.name_latin].filter(Boolean).some(n=>norm(n)===norm(p.name)));
      const level=p=>p.feature_code==='PPLC'?0:p.feature_code==='PPLA'?1:/^PPLA[2-5]$/.test(p.feature_code)?Number(p.feature_code.slice(-1)):99;
      const pool=exact.length?exact:cities,min=Math.min(...pool.map(level));
      const major=pool.filter(p=>level(p)===min && min<99);
      const matches=exact.length===1?exact:country && major.length===1?major:cities.length===1?cities:[];
      if(matches.length!==1)return missing;
      const p=matches[0],point={name,lat:p.latitude,lon:p.longitude,country:p.country_code,tz:p.timezone || null,provider:'open-meteo/geonames',provider_id:p.id,checked_at:new Date(now).toISOString()};
      if(!signal?.aborted){cache.set(key,{at:now,point});if(cache.size>200)cache.delete(cache.keys().next().value);}return point;
    }catch{return missing;}
  }));
  return {points,attribution:'GeoNames / Open-Meteo',status:points.every(p=>p.lat!=null)?'complete':'partial'};
}
