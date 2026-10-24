/* 从服务端已选候选挑一段关键连接；只补资料，不修改路线或升级运营证据。 */
import {resolvePlace} from './anywhere.mjs';
import {searchTransportSources} from './transport-search.mjs';
import {sourceWindow} from './source-time.mjs';
export function criticalTransportLeg(plan,candidateId,anchors={}){
  const candidate=plan?.candidates?.find(c=>c.id===candidateId);
  if(!candidate?.legs?.length)throw Error('所选走法已过期，请重新比较后选择');
  const legs=candidate.legs.filter(l=>![anchors?.outbound,anchors?.return].some(a=>a?.from_city===l.from && a?.to_city===l.to && a?.mode && a.mode===l.mode_guess));
  const cross=l=>{const a=resolvePlace(l.from),b=resolvePlace(l.to);return !!(a?.country && b?.country && a.country!==b.country);};
  const leg=legs.find(l=>cross(l) && l.mode_guess==='road') || legs.find(cross) || legs.find(l=>!l.mode_guess || l.mode_guess==='unknown') || legs[0];
  return leg?{from:leg.from,to:leg.to,mode:['plane','rail','road'].includes(leg.mode_guess)?leg.mode_guess:'unknown',reason:cross(leg)?'跨境衔接最影响这条走法是否适合你':'先补齐影响选路的交通连接'}:null;
}
export async function researchSelectedRoute(input,plan,search,options={}){
  const leg=criticalTransportLeg(plan,input.candidate_id,input.anchors);
  if(!leg)return {status:'skipped',leg:null,verified:false,note:'所选走法的交通已由你确认；本次不重复自动检索。'};
  const window=sourceWindow(input.window);
  if(input.window!=null && !window)throw Error('资料查询时间窗无效，请检查日期后重试');
  const result=await searchTransportSources({...leg,window,exclude_road:input.exclude_road},search,options);
  return {...result,leg,verified:false,note:'本次补查只提供交通连接与乘车经验；班期、票价及日期适用性尚未核实。'};
}
