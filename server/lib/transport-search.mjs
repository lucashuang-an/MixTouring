/* 按一段交通与用户日期查近期线索；读到资料也不自动升级班次核实状态。 */
import {collectTravelSources} from './travel-sources.mjs';
import {resultRelevance,resolvePlace} from './anywhere.mjs';
import {readPublicPage} from './public-reader.mjs';
import {randomUUID} from 'node:crypto';
import {retrievalContext,partitionTimedSources,sourceWindow} from './source-time.mjs';
const results=new Map();
export function discardTransportSearch(ids){for(const id of ids)results.delete(id);}
/* 只读恢复本进程仍有效的记录；不联网、不续期、不采纳客户端计数。 */
export function resolveTransportSearch({ids=[],legs=[],window=null}={}, {now=Date.now()}={}){
  if(!Array.isArray(ids) || ids.length>20 || ids.some(id=>typeof id!=='string' || id.length>120) || !Array.isArray(legs) || legs.length>11 || legs.some(l=>!l || [l.from,l.to].some(v=>typeof v!=='string' || !v.trim() || v.length>80) || !['unknown','plane','rail','road'].includes(l.mode)))throw Error('查询记录字段无效');
  if(window!==null && (typeof window!=='string' || !sourceWindow(window)))throw Error('查询时间窗无效');
  const records=[];
  for(const id of new Set(ids)){
    const item=results.get(id),data=item?.data;
    if(!data || item.expires<=now || Date.parse(data.retrieved_at)>now || sourceWindow(window)!==data.temporal.target_window || !legs.some(l=>!l.locked && l.from===data.from && l.to===data.to && l.mode===data.requested_mode && !!l.exclude_road===!!data.exclude_road))continue;
    const current=structuredClone(data),context=retrievalContext({window,purpose:'transport',now});
    const transport=partitionTimedSources(current.sources,context),experience=partitionTimedSources(current.experiences,retrievalContext({window,purpose:'experience',now}));
    current.sources=transport.current;current.experiences=experience.current;
    current.archive=[...current.archive,...transport.archive,...experience.archive];
    current.temporal={...current.temporal,today:context.today};current.restored_lookup=true;
    current.results=current.sources.map(s=>({title:s.title,link:s.url,content:s.excerpt,date:s.published_at,date_basis:s.date_basis,source_kind:s.kind,platform:s.platform,read_status:s.read_status,temporal:s.temporal}));
    current.evidence_state=current.sources.length?'source_lead':'explore';records.push(current);
  }
  return {records};
}
export function transportSearchCovered(ids,{from,to,mode,exclude_road=false,window=null,now=Date.now()}){
  return (Array.isArray(ids)?ids:[]).slice(0,20).some(id=>{const item=results.get(id);return item?.expires>now && item.data.from===from && item.data.to===to && item.data.requested_mode===mode && !!item.data.exclude_road===exclude_road && sourceWindow(window)===item.data.temporal.target_window;});
}
export function transportSearchEvidence(ids,{route=[],legs=null,window=null,now=Date.now(),purpose='transport'}={}){
  const sources=[];
  /* #29：先逐项校验（存在/未过期/同窗/同方向）再取资料，输入上限只作有界扫描（与客户端缓存上限一致）——
   * 旧无关项不得因排在前面挤占有效项配额。输出配额仍由 partitionTimedSources 后的 slice(0,8) 把守。 */
  for(const id of (Array.isArray(ids)?ids:[]).slice(0,20)){const item=results.get(id);
    if(!item || item.expires<=now || sourceWindow(window)!==item.data.temporal.target_window)continue;
    if(!route.slice(1).some((to,i)=>route[i]===item.data.from && to===item.data.to))continue;
    if(legs && !legs.some(l=>l.from===item.data.from && l.to===item.data.to && (!l.exclude_road || item.data.exclude_road) && (!l.mode_guess || l.mode_guess==='unknown' || l.mode_guess===item.data.requested_mode)))continue;
    sources.push(...(purpose==='experience'?item.data.experiences:item.data.sources));
  }
  return partitionTimedSources(sources,retrievalContext({window,purpose,now})).current.slice(0,8);
}
export async function searchTransportSources({from,to,window=null,mode='unknown',exclude_road=false},search,{readPage=readPublicPage,now=Date.now(),useCache=true,signal=null}={}){
  if([from,to].some(p=>typeof p!=='string' || !p.trim() || p.length>80) || from===to)throw Error('请提供两个不同的交通端点');
  const origin=resolvePlace(from)?.name || from.trim(),destination=resolvePlace(to)?.name || to.trim();
  mode=['plane','rail','road'].includes(mode)?mode:'unknown';
  exclude_road=exclude_road===true;
  if(exclude_road && mode==='road')throw Error('已排除公路客运，请选择其他查询方向');
  const terms={plane:['航班 航空 运营','flight airline'],rail:['火车 铁路 客运','train rail passenger'],road:['大巴 巴士 客运','bus coach passenger'],unknown:['客运 交通 方式','passenger transport']};
  if(exclude_road)terms.unknown=['航班 铁路 客运','flight train passenger'];
  const result=await collectTravelSources({destination:origin+' '+destination,query:origin+' 到 '+destination+' '+terms[mode][0],foreignQuery:(resolvePlace(origin)?.aliases?.find(a=>/^[a-z ]+$/i.test(a)) || origin)+' '+(resolvePlace(destination)?.aliases?.find(a=>/^[a-z ]+$/i.test(a)) || destination)+' '+terms[mode][1],international:true,purpose:'transport',window},search,{readPage,now,useCache,signal});
  /* 复审二轮：取消轮（含缓存命中/读取阶段取消）不登记检索 ID、不进缓存——按失败路径返回 */
  if(result.cancelled || signal?.aborted)throw Error('请求已取消，本轮检索未完成');
  const relevant=s=>(exclude_road && mode==='unknown'?['plane','rail']:[mode]).some(check=>{const rel=resultRelevance({title:s.title,content:s.excerpt},{from:origin,to:destination,mode_guess:check});return rel.from_hit && rel.to_hit && rel.mode_hit && rel.connection_hit;});
  const mentions=(text,name)=>[name,...resolvePlace(name)?.aliases || []].some(term=>/^[a-z ]+$/i.test(term)?new RegExp('\\b'+term+'\\b','i').test(text):text.includes(term));
  const experienceMode={plane:/航班|航空|飞机|直飞|flight|airline/i,rail:/铁路|火车|列车|高铁|train|rail/i,road:/公路|班车|大巴|巴士|bus|coach/i}[mode];
  const experiences=result.experiences.filter(s=>mentions(s.title+' '+s.excerpt,origin) && mentions(s.title+' '+s.excerpt,destination) && (!experienceMode || experienceMode.test(s.title+' '+s.excerpt)) && (!exclude_road || relevant(s)));
  const sources=result.sources.filter(s=>s.kind!=='experience' && relevant(s));
  const data={...result,experiences,sources,archive:result.archive.filter(relevant),from:origin,to:destination,requested_mode:mode,exclude_road,evidence_state:sources.length?'source_lead':'explore',retrieval_id:'retrieval_'+randomUUID(),note:'近期资料仅为连接线索；本次班次、可用性和日期适用范围仍需确认。'};
  for(const [id,item] of results)if(item.expires<=now)results.delete(id);
  while(results.size>=100)results.delete(results.keys().next().value);
  results.set(data.retrieval_id,{data:structuredClone(data),expires:now+900000});
  return data;
}
