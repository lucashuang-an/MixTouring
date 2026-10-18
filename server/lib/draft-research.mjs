/* 草案变化只产生资料查询任务，不生成交通候选或已核实事实。 */
import {resolvePlace} from './anywhere.mjs';
import {retrievalContext,sourceWindow} from './source-time.mjs';
import {searchTransportSources,transportSearchCovered,discardTransportSearch} from './transport-search.mjs';
const modes=new Set(['plane','rail','road']);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const routeOf=value=>Array.isArray(value)?value.filter(x=>typeof x==='string' && x.trim() && x.length<=80).slice(0,12):[];
const edgeKey=l=>l.from+'→'+l.to;
const fits=(candidate,route)=>candidate?.legs?.length && same(candidate.legs.map(l=>l.from).concat(candidate.legs.at(-1).to),route);
export function draftQueryScope({route=[],candidate=null,preferences={},previous=null,anchors={},travel={}}={},now=Date.now()){
  route=routeOf(route);preferences=preferences || {};anchors=anchors || {};
  const preferred_mode=modes.has(preferences.preferred_mode)?preferences.preferred_mode:null;
  const road=preferences.road || null;
  const reusable=previous && Array.isArray(previous.legs) && previous.preferred_mode===preferred_mode && previous.road===road;
  const legs=route.slice(1).map((to,i)=>{
    const from=route[i],locked=[anchors.outbound,anchors.return].find(a=>a?.from_city===from && a?.to_city===to && modes.has(a.mode));
    const known=fits(candidate,route)?candidate.legs[i].mode_guess:null;
    const prior=reusable?previous.legs.slice(0,11).find(l=>l?.from===from && l?.to===to)?.mode:null;
    let mode=locked?.mode || preferred_mode || known || prior || 'unknown';
    if(!locked && road==='exclude' && mode==='road')mode='unknown';
    if(!modes.has(mode))mode='unknown';
    return {from,to,mode,exclude_road:road==='exclude' && !locked,locked:!!locked};
  });
  return {route,legs,preferred_mode,road,window:retrievalContext({travel,now}).target_window,basis:'查询方向，不证明实际交通方式或连接存在'};
}
export function draftResearchChanges(input,data,plan,{now=Date.now()}={}){
  if(data?.status!=='ok' || !data.conversation?.draft || data.conversation.preview)return null;
  const before=input.conversation || {},after=data.conversation;
  const beforeCandidate=plan?.candidates?.find(c=>c.id===input.candidate_id);
  const afterCandidate=plan?.candidates?.find(c=>c.id===data.selected_candidate_id);
  const preferences={...input.preferences,...data.patch?.preferences};
  const scope=draftQueryScope({route:after.draft.route,candidate:afterCandidate,preferences,previous:draftQueryScope({route:before.draft?.route,candidate:beforeCandidate,preferences:input.preferences,previous:input.research_scope,anchors:input.anchors,travel:input.travel},now),anchors:input.anchors,travel:{...input.travel,...data.patch?.travel}},now);
  const previous=draftQueryScope({route:before.draft?.route,candidate:beforeCandidate,preferences:input.preferences,previous:input.research_scope,anchors:input.anchors,travel:input.travel},now);
  const windowChanged=scope.window!==previous.window;
  const verificationChanged=after.requirements?.verified_cross_border_only && !before.requirements?.verified_cross_border_only;
  const changed=scope.legs.filter(l=>!l.locked && (windowChanged || verificationChanged || !previous.legs.some(old=>edgeKey(old)===edgeKey(l) && old.mode===l.mode && old.exclude_road===l.exclude_road && old.locked===l.locked)));
  const initialChosen=input.action==='generate' && !before.draft && input.requested_candidate_id;
  const pending=initialChosen?[]:changed.filter(l=>!transportSearchCovered(input.retrieval_ids,{...l,window:scope.window,now}));
  const cross=l=>{const a=resolvePlace(l.from),b=resolvePlace(l.to);return a?.country && b?.country && a.country!==b.country;};
  const ordered=pending.map((l,i)=>({...l,order:i})).sort((a,b)=>Number(!!cross(b))-Number(!!cross(a)) || a.order-b.order).map(({order,...l})=>l);
  return {scope,queries:ordered.slice(0,2),remaining:ordered.slice(2),removed:previous.legs.filter(l=>!scope.legs.some(n=>edgeKey(n)===edgeKey(l))),retained:scope.legs.filter(l=>!changed.includes(l)).map(edgeKey)};
}
export async function searchDraftChanges(input,search,options={}){
  const queries=input?.queries;
  if(!Array.isArray(queries) || !queries.length || queries.length>2)throw Error('每次请查询一至两段交通资料');
  const window=sourceWindow(input.window);
  if(input.window!=null && !window)throw Error('资料查询时间窗无效');
  const seen=new Set(),clean=[];
  for(const q of queries){
    if(!q || [q.from,q.to].some(v=>typeof v!=='string' || !v.trim() || v.length>80) || !['unknown',...modes].includes(q.mode) || q.exclude_road!=null && typeof q.exclude_road!=='boolean')throw Error('交通查询字段无效');
    const leg={from:resolvePlace(q.from)?.name || q.from.trim(),to:resolvePlace(q.to)?.name || q.to.trim(),mode:q.mode,exclude_road:q.exclude_road===true};
    if(leg.from===leg.to)throw Error('交通查询字段无效');
    const key=edgeKey(leg)+'|'+leg.mode;if(seen.has(key))throw Error('请勿重复查询相同路段');seen.add(key);clean.push(leg);
  }
  const lookup=options.lookup || searchTransportSources;
  const settled=await Promise.allSettled(clean.map(q=>lookup({...q,window},search,options)));
  const completed=settled.filter(r=>r.status==='fulfilled').map(r=>r.value);
  if(options.signal?.aborted){discardTransportSearch(completed.map(d=>d.retrieval_id));throw Error('请求已取消，本轮补查未采用');}
  return {segments:settled.map((r,i)=>({leg:clean[i],status:r.status==='fulfilled'?'complete':'failed',data:r.status==='fulfilled'?r.value:null})),verified:false,note:'仅补查变化路段的资料；未升级为已核实交通。'};
}
