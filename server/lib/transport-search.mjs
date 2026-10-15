/* 按一段交通与用户日期查近期线索；读到资料也不自动升级班次核实状态。 */
import {collectTravelSources} from './travel-sources.mjs';
import {resultRelevance,resolvePlace} from './anywhere.mjs';
import {readPublicPage} from './public-reader.mjs';
import {randomUUID} from 'node:crypto';
import {retrievalContext,partitionTimedSources,sourceWindow} from './source-time.mjs';
const results=new Map();
export function transportSearchEvidence(ids,{route=[],window=null,now=Date.now(),purpose='transport'}={}){
  const sources=[];
  /* #29：先逐项校验（存在/未过期/同窗/同方向）再取资料，输入上限只作有界扫描（与客户端缓存上限一致）——
   * 旧无关项不得因排在前面挤占有效项配额。输出配额仍由 partitionTimedSources 后的 slice(0,8) 把守。 */
  for(const id of (Array.isArray(ids)?ids:[]).slice(0,20)){const item=results.get(id);
    if(!item || item.expires<=now || sourceWindow(window)!==item.data.temporal.target_window)continue;
    if(!route.slice(1).some((to,i)=>route[i]===item.data.from && to===item.data.to))continue;
    sources.push(...(purpose==='experience'?item.data.experiences:item.data.sources));
  }
  return partitionTimedSources(sources,retrievalContext({window,purpose,now})).current.slice(0,8);
}
export async function searchTransportSources({from,to,window=null},search,{readPage=readPublicPage,now=Date.now(),useCache=true,signal=null}={}){
  if([from,to].some(p=>typeof p!=='string' || !p.trim() || p.length>80) || from===to)throw Error('请提供两个不同的交通端点');
  const origin=resolvePlace(from)?.name || from.trim(),destination=resolvePlace(to)?.name || to.trim();
  const result=await collectTravelSources({destination:origin+' '+destination,query:origin+' 到 '+destination+' 客运 班次 运营',foreignQuery:(resolvePlace(origin)?.aliases?.find(a=>/^[a-z ]+$/i.test(a)) || origin)+' '+(resolvePlace(destination)?.aliases?.find(a=>/^[a-z ]+$/i.test(a)) || destination)+' bus travel',international:true,purpose:'transport',window},search,{readPage,now,useCache,signal});
  /* 复审二轮：取消轮（含缓存命中/读取阶段取消）不登记检索 ID、不进缓存——按失败路径返回 */
  if(result.cancelled || signal?.aborted)throw Error('请求已取消，本轮检索未完成');
  const relevant=s=>{const rel=resultRelevance({title:s.title,content:s.excerpt},{from:origin,to:destination,mode_guess:'unknown'});return rel.from_hit && rel.to_hit && rel.mode_hit && rel.connection_hit;};
  const mentions=(text,name)=>[name,...resolvePlace(name)?.aliases || []].some(term=>/^[a-z ]+$/i.test(term)?new RegExp('\\b'+term+'\\b','i').test(text):text.includes(term));
  const experiences=result.experiences.filter(s=>mentions(s.title+' '+s.excerpt,origin) && mentions(s.title+' '+s.excerpt,destination));
  const data={...result,experiences,sources:result.sources.filter(relevant),archive:result.archive.filter(relevant),from:origin,to:destination,evidence_state:'source_lead',retrieval_id:'retrieval_'+randomUUID(),note:'近期资料仅为连接线索；本次班次、可用性和日期适用范围仍需确认。'};
  for(const [id,item] of results)if(item.expires<=now)results.delete(id);
  while(results.size>=100)results.delete(results.keys().next().value);
  results.set(data.retrieval_id,{data:structuredClone(data),expires:now+900000});
  return data;
}
