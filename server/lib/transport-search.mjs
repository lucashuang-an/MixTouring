/* 按一段交通与用户日期查近期线索；读到资料也不自动升级班次核实状态。 */
import {collectTravelSources} from './travel-sources.mjs';
import {resultRelevance} from './transport-relevance.mjs';
import {readPublicPage} from './public-reader.mjs';
import {randomUUID} from 'node:crypto';
import {connectionOptions} from './transport-options.mjs';
import {queryTransportMap} from './transport-map.mjs';
import {retrievalContext,partitionTimedSources,sourceWindow} from './source-time.mjs';
const results=new Map();
export function discardTransportSearch(ids){for(const id of ids)results.delete(id);}
/* 只读恢复本进程仍有效的记录；不联网、不续期、不采纳客户端计数。 */
export function resolveTransportSearch({ids=[],legs=[],window=null}={}, {now=Date.now()}={}){
  if(!Array.isArray(ids) || ids.length>20 || ids.some(id=>typeof id!=='string' || id.length>120) || !Array.isArray(legs) || legs.length>12 || legs.some(l=>!l || [l.from,l.to].some(v=>typeof v!=='string' || !v.trim() || v.length>80) || !['unknown','plane','rail','road','drive'].includes(l.mode) || l.window!=null&&!sourceWindow(l.window)))throw Error('查询记录字段无效');
  if(window!==null && (typeof window!=='string' || !sourceWindow(window)))throw Error('查询时间窗无效');
  const records=[];
  for(const id of new Set(ids)){
    const item=results.get(id),data=item?.data;
    if(!data || item.expires<=now || Date.parse(data.retrieved_at)>now || !legs.some(l=>!l.locked && l.from===data.from && l.to===data.to && l.mode===data.requested_mode && sourceWindow(l.window || window)===data.temporal.target_window && !!l.exclude_road===!!data.exclude_road && !!l.no_self_drive===!!data.no_self_drive))continue;
    const current=structuredClone(data),context=retrievalContext({window:data.temporal.target_window,purpose:'transport',now});
    const transport=partitionTimedSources(current.sources,context),experience=partitionTimedSources(current.experiences,retrievalContext({window:data.temporal.target_window,purpose:'experience',now}));
    current.sources=transport.current;current.experiences=experience.current;
    current.archive=[...current.archive,...transport.archive,...experience.archive];
    current.temporal={...current.temporal,today:context.today};current.restored_lookup=true;
    current.results=current.sources.map(s=>({title:s.title,link:s.url,content:s.excerpt,date:s.published_at,date_basis:s.date_basis,source_kind:s.kind,platform:s.platform,read_status:s.read_status,temporal:s.temporal}));
    current.evidence_state=current.sources.length?'source_lead':'explore';records.push(current);
  }
  return {records};
}
export function transportSearchCovered(ids,{from,to,mode,exclude_road=false,no_self_drive=false,window=null,now=Date.now()}){
  return (Array.isArray(ids)?ids:[]).slice(0,20).some(id=>{const item=results.get(id);return item?.expires>now && item.data.from===from && item.data.to===to && item.data.requested_mode===mode && !!item.data.exclude_road===exclude_road && !!item.data.no_self_drive===!!no_self_drive && sourceWindow(window)===item.data.temporal.target_window;});
}
export function transportSearchEvidence(ids,{route=[],legs=null,window=null,now=Date.now(),purpose='transport'}={}){
  const sources=[];
  /* #29：先逐项校验（存在/未过期/同窗/同方向）再取资料，输入上限只作有界扫描（与客户端缓存上限一致）——
   * 旧无关项不得因排在前面挤占有效项配额。输出配额仍由 partitionTimedSources 后的 slice(0,8) 把守。 */
  for(const id of (Array.isArray(ids)?ids:[]).slice(0,20)){const item=results.get(id);
    if(!item || item.expires<=now)continue;
    const leg=legs?.find(l=>l.from===item.data.from && l.to===item.data.to && (!l.exclude_road || item.data.exclude_road) && (!l.mode_guess || l.mode_guess==='unknown' || l.mode_guess===item.data.requested_mode));
    if(legs?!leg:!route.slice(1).some((to,i)=>route[i]===item.data.from && to===item.data.to))continue;
    const adjacent=route.slice(1).some((to,i)=>route[i]===item.data.from&&to===item.data.to);
    if(!adjacent && !(leg?.direction==='inbound' && route.length>1 && item.data.from===route.at(-1) && item.data.to===route[0]))continue;
    const legWindow=sourceWindow(leg?.window || window);if(legWindow!==item.data.temporal.target_window)continue;
    sources.push(...partitionTimedSources(purpose==='experience'?item.data.experiences:item.data.sources,retrievalContext({window:legWindow,purpose,now})).current);
  }
  return sources.filter((s,i,a)=>a.findIndex(x=>x.url===s.url)===i).slice(0,8);
}
export async function searchTransportSources({from,to,window=null,mode='unknown',exclude_road=false,no_self_drive=false,places=[]},search,{readPage=readPublicPage,now=Date.now(),useCache=true,signal=null,mapTools={}}={}){
  if([from,to].some(p=>typeof p!=='string' || !p.trim() || p.length>80) || from===to)throw Error('请提供两个不同的交通端点');
  const origin=from.trim(),destination=to.trim();
  mode=['plane','rail','road','drive'].includes(mode)?mode:'unknown';
  exclude_road=exclude_road===true;
  no_self_drive=no_self_drive===true;
  if(exclude_road && ['road','drive'].includes(mode))throw Error('已排除公路客运，请选择其他查询方向');
  if(no_self_drive && mode==='drive')throw Error('当前条件不自驾，请先更新出行条件');
  const terms={drive:['自驾 驾车 路线 导航','driving directions'],plane:['航班 航空 运营','flight airline'],rail:['火车 铁路 客运','train rail passenger'],road:['大巴 巴士 客运','bus coach passenger'],unknown:['客运 交通 方式','passenger transport']};
  if(exclude_road)terms.unknown=['航班 铁路 客运','flight train passenger'];
  const latin=name=>{const hint=Array.isArray(places)?places.find(p=>p?.name===name):null;return typeof hint?.name_latin==='string'?hint.name_latin.trim().slice(0,100) || name:name;};
  const mapped=await queryTransportMap({from:origin,to:destination,mode,exclude_road,no_self_drive,places},{...mapTools,signal,now});
  const mappedModes=new Set(mapped.options.map(o=>o.mode));
  const fallbackModes=(mode==='unknown'?['rail','plane',...(!exclude_road&&!no_self_drive?['drive']:[])]:[mode]).filter(m=>!mappedModes.has(m));
  const result=fallbackModes.length?await collectTravelSources({destination:origin+' '+destination,query:origin+' 到 '+destination+(mode==='unknown'?'':' '+terms[mode][0]),foreignQuery:latin(origin)+' '+latin(destination)+' '+terms[mode][1],international:true,purpose:'transport',window,
    connection_modes:mode==='unknown'?fallbackModes:[]},search,{readPage,now,useCache,signal}):{sources:[],experiences:[],archive:[],channels:[],results:[],temporal:retrievalContext({window,purpose:'transport',now}),reader:{attempted:0,available:0},status:'available',retrieved_at:new Date(now).toISOString(),cache_hit:false};
  /* 复审二轮：取消轮（含缓存命中/读取阶段取消）不登记检索 ID、不进缓存——按失败路径返回 */
  if(result.cancelled || signal?.aborted)throw Error('请求已取消，本轮检索未完成');
  const relevant=s=>(exclude_road && mode==='unknown'?['plane','rail']:[mode]).some(check=>{const rel=resultRelevance({title:s.title,content:s.excerpt},{from:origin,to:destination,mode_guess:check});return rel.from_hit && rel.to_hit && rel.mode_hit && rel.connection_hit;});
  const mentions=(text,name)=>[name,latin(name)].some(term=>text.toLowerCase().includes(term.toLowerCase()));
  const experienceMode={drive:/自驾|驾车|driv/i,plane:/航班|航空|飞机|直飞|flight|airline/i,rail:/铁路|火车|列车|高铁|train|rail/i,road:/公路|班车|大巴|巴士|bus|coach/i}[mode];
  const experiences=result.experiences.filter(s=>mentions(s.title+' '+s.excerpt,origin) && mentions(s.title+' '+s.excerpt,destination) && (!experienceMode || experienceMode.test(s.title+' '+s.excerpt)) && (!exclude_road || relevant(s)));
  const sources=result.sources.filter(s=>s.kind!=='experience' && relevant(s));
  const directions=mapped.options.concat(connectionOptions([...result.sources,...result.experiences,...result.archive],{from:origin,to:destination,mode,exclude_road,no_self_drive}).filter(o=>!mappedModes.has(o.mode)));
  directions.sort((a,b)=>['rail','plane','drive','road'].indexOf(a.mode)-['rail','plane','drive','road'].indexOf(b.mode));
  const data={...result,experiences,sources,connection_options:directions,map_attempts:mapped.attempts,cacheable:false,archive:result.archive.filter(relevant),from:origin,to:destination,requested_mode:mode,exclude_road,no_self_drive:!!no_self_drive,evidence_state:sources.length?'source_lead':'explore',retrieval_id:'retrieval_'+randomUUID(),note:'地图提供查询时的交通参考；网页补充工具未覆盖的方式，班次与日期仍需确认。'};
  if(mapped.options.length && result.status==='unavailable')data.status='partial';
  for(const [id,item] of results)if(item.expires<=now)results.delete(id);
  while(results.size>=100)results.delete(results.keys().next().value);
  // Google路线数值只给本次面板，不写入恢复缓存或草案证据。刷新后重新调用工具。
  const restorable={...data,connection_options:directions.filter(o=>o.provider!=='Google Maps'),map_attempts:mapped.attempts.map(a=>({...a,status:a.status==='available'?'needs_refresh':a.status,reason:a.status==='available'?'refresh_required':a.reason}))};
  results.set(data.retrieval_id,{data:structuredClone(restorable),expires:now+900000});
  return data;
}
