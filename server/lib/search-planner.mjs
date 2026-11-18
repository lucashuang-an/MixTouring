import {agentPrompt} from './agent-prompts.mjs';
/* 新网页规划：本次意图 → 检索 → 模型组合。旧地点、枢纽和路线模板不参与准入。
 * 名称及国家只是检索提示；没有地图事实时不补坐标，也不阻断探索。 */
import {createHash} from 'node:crypto';
import {composeJson,searchWeb} from './llm.mjs';
import {webSearchConfigured} from './trip-service.mjs';
import {buildTravelIntent,extractConstraints,sanitizeConstraints,constraintChips,sanitizeAnchors} from './anywhere.mjs';
import {countryScope} from './place-scope.mjs';
import {collectTravelSources,articleIdentity} from './travel-sources.mjs';
import {sourceId} from './source-relevance.mjs';
import {SEARCH_PLANNER_VERSION} from './versions.mjs';

const str=(v,n=80)=>typeof v==='string'?v.trim().slice(0,n):'';
const kinds=new Set(['city','airport','station','poi']);
const country=v=>typeof v==='string' && /^[A-Z]{2}$/.test(v)?v:null;
const id=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,18);

/* 生成的地点只属于本次探索。模型/客户端不能写入 country、坐标、时区和 verified。 */
function intentPlace(raw,name){
  return {name,kind:kinds.has(raw?.kind)?raw.kind:'city',name_latin:str(raw?.name_latin),
    country:null,country_hint:country(raw?.country),lat:null,lon:null,tz:null,
    resolution_state:'unverified',dynamic:true};
}
export function searchLeg(from,to,seq=1,mode=null){
  return {seq,from:from.name,to:to.name,from_kind:from.kind,to_kind:to.kind,
    from_country:from.country || null,to_country:to.country || null,
    mode_guess:mode,evidence_state:'explore',sources:[],via:null,lead_query:null,
    evidence_note:'这是探索结构，尚无本次日期的客运连接证据。',manual_check:'逐段核对运营方、方向、日期、站点与接驳'};
}

export async function planSearchFirst(input={},deps={}){
  const model=deps.composeJson || composeJson,search=deps.searchWeb || searchWeb;
  const signal=deps.signal,now=deps.nowMs ?? Date.now();
  const text=str(input.text,4000),context=typeof input.location_context==='string'?input.location_context.trim().slice(-6000):'';
  const travel=buildTravelIntent(text,input.travel || null,now);
  const constraints={...extractConstraints(text),...sanitizeConstraints(input.constraints)};
  if(constraints.no_self_drive===false)delete constraints.no_self_drive;
  const data={planning_mode:'search_first',status:'partial',planner_version:SEARCH_PLANNER_VERSION,
    intent:{...travel.intent,origin:str(input.origin) || null,destination:str(input.destination) || null,
      origin_place:null,destination_place:null,constraints,constraint_chips:constraintChips(constraints),parse_engine:'search+ai'},
    route:null,places:[],needs_confirmation:[...travel.needs],place_candidates:{origin:[],destination:[]},
    candidates:[],explorations:[],constraint_notes:[],degradations:[],anchors:null,anchor_notes:[],next_steps:[],
    web_search:{configured:false,status:'not_started'}};
  const fail=(message,status='unavailable')=>{data.status=status;data.candidates=[];data.planning_notice=message;data.needs_confirmation.push(message);return data;};
  if(signal?.aborted)return fail('规划已取消，原输入与安排仍保留。','cancelled');
  const normalized=await model({kind:'search_plan_places',timeoutMs:12000,signal,
    schema_prompt:agentPrompt('search.places'),
    user:JSON.stringify({origin:input.origin,destination:input.destination,text,location_context:context})});
  if(!normalized || signal?.aborted)return fail(signal?.aborted?'规划已取消，原输入与安排仍保留。':'模型暂时无法整理地点，原输入与安排仍保留，请重试。',signal?.aborted?'cancelled':'unavailable');
  const endpoints={};
  for(const key of ['origin','destination']){
    const name=str(input[key]) || str(normalized[key]?.name);
    if(!name || !str(normalized[key]?.name) || countryScope(name) || normalized[key]?.ambiguous===true)
      return fail(str(normalized.question,240) || '请补充'+(key==='origin'?'出发':'目的')+'城市及国家或地区。','needs_intent');
    endpoints[key]=intentPlace(normalized[key],name);
    data.intent[key]=endpoints[key].name;data.intent[key+'_place']=endpoints[key];
  }
  if(endpoints.origin.name===endpoints.destination.name)return fail('请先明确环线的首段或要比较的两个城市，完整环线目标仍保留在对话中。','needs_intent');
  data.places=Object.values(endpoints);
  // 没有地图核验的国家信息不升级为跨境事实。
  data.route={route_type:endpoints.origin.country && endpoints.destination.country?
    endpoints.origin.country===endpoints.destination.country?'domestic':'international':'needs_confirmation'};
  const anchors=sanitizeAnchors(input.anchors);
  if(anchors.invalid.length)return fail('已定交通信息不完整，请补全方式、日期及两端城市。','needs_intent');
  if(anchors.outbound || anchors.return){
    data.anchors={outbound:anchors.outbound,return:anchors.return,recompute_scope:anchors.outbound?'after_outbound_anchor':'full'};
    data.anchor_notes.push('已定交通按你的输入保留；地点、时区与去返衔接仍需核查。');
    if(anchors.outbound){
      const name=anchors.outbound.to_city;
      endpoints.origin=data.places.find(p=>p.name===name) || intentPlace({},name);
      if(!data.places.some(p=>p.name===name))data.places.push(endpoints.origin);
    }
    if(endpoints.origin.name===endpoints.destination.name){
      if(data.intent.trip_type==='one_way' || anchors.return?.from_city===endpoints.destination.name){data.status='ok';data.anchors.full_cover=true;data.planning_notice='已定交通已覆盖本次移动，可继续安排目的地体验。';return data;}
      return fail('去程已到达目的地；可继续安排当地体验，并单独核对返程接驳。','needs_intent');
    }
  }
  data.degradations.push('地图位置尚未核验，先以列表比较探索方向；这不证明客运连接或本次班期成立。');
  if(signal?.aborted)return fail('规划已取消，原输入与安排仍保留。','cancelled');
  // 进度快照没有规则候选，不把模型/搜索未完成伪装成已找到走法。
  deps.onProgress?.(structuredClone(data));
  const from=endpoints.origin,to=endpoints.destination;
  const required=[...new Set((Array.isArray(input.requirements?.required_stops)?input.requirements.required_stops:[]).map(s=>str(s)).filter(s=>s && s!==from.name && s!==to.name && !countryScope(s)))].slice(0,10);
  if(required.length){
    const nodes=[from,...required.map(name=>intentPlace({},name)),to],names=nodes.map(p=>p.name);
    for(const p of nodes)if(!data.places.some(x=>x.name===p.name))data.places.push(p);
    data.candidates.push({id:'cand-search-'+id(names),kind:'discovered',builder:'user+ai',hypothesis:true,transfers:required.length,
      basis:{rule:'user-requested-structure',sources:[],node_quotes:[]},legs:nodes.slice(0,-1).map((p,i)=>searchLeg(p,nodes[i+1],i+1)),
      explanation:'按你指定的城市顺序组织停留与交通预留。',why_explore:'保留你选择的沿途体验。',tradeoffs:[],fragile_legs:[],next_checks:[]});
  }
  const userStructure=()=>{data.status='ok';data.planning_notice='已整理你指定的路线，可以展开每日安排。';return data;};
  const queryFits=q=>[from,to].every(p=>[p.name,p.name_latin].filter(Boolean).some(n=>q.toLowerCase().includes(n.toLowerCase())));
  const queryZh=str(normalized.query_zh,100),queryForeign=str(normalized.query_foreign,100);
  const collected=await collectTravelSources({destination:from.name+' '+to.name,
    query:queryFits(queryZh)?queryZh:from.name+'到'+to.name+'怎么走',
    foreignQuery:queryFits(queryForeign)?queryForeign:(from.name_latin || from.name)+' to '+(to.name_latin || to.name)+' travel options',
    question:[text,context].filter(Boolean).join('\n'),international:![from,to].every(p=>(p.country || p.country_hint)==='CN'),
    travel:travel.intent,purpose:'transport'},search,{now,useCache:false,signal});
  data.web_search={configured:!!deps.searchWeb || webSearchConfigured(deps.env || process.env).configured,status:collected.status};
  if(signal?.aborted)return fail('规划已取消，原输入与安排仍保留。','cancelled');
  // 历史和日期未明资料可提出结构假设，不能作为当期连接证据；保留各自时间分区。
  const seen=new Set(),pool=[...collected.sources,...collected.experiences,...collected.archive]
    .filter(s=>!seen.has(articleIdentity(s.url)) && seen.add(articleIdentity(s.url)))
    .slice(0,10).map(s=>({...s,id:sourceId(s)}));
  // 资料供探索参考；不因相关性模型失败或查无来源删除用户路线。
  const sources=pool;
  const result=await model({kind:'search_plan_routes',timeoutMs:12000,signal,
    schema_prompt:agentPrompt('search.routes'),
    user:JSON.stringify({origin:from.name,destination:to.name,intent:{text,context,constraints,travel:travel.intent},sources:sources.map(({id,title,excerpt,temporal})=>({id,title,excerpt,temporal}))})});
  if(!result || signal?.aborted)return !signal?.aborted && data.candidates.length?userStructure():fail(signal?.aborted?'规划已取消，原输入与安排仍保留。':'模型整合未完成，原输入与安排仍保留，请重试。',signal?.aborted?'cancelled':'unavailable');
  const signatures=new Set(data.candidates.map(c=>JSON.stringify(c.legs.map(l=>l.from).concat(c.legs.at(-1).to))));
  for(const proposal of (Array.isArray(result.routes)?result.routes:[]).slice(0,6)){
    if(!Array.isArray(proposal?.stops) || proposal.stops.length>3 || !Array.isArray(proposal.source_ids))continue;
    const support=sources.filter(s=>proposal.source_ids.includes(s.id));

    const stops=[];
    for(const stop of proposal.stops){
      const name=str(stop?.name),quote=str(stop?.quote,500),source=support.find(s=>s.id===stop?.source_id);
    if(!name || countryScope(name))break;
      stops.push(intentPlace(stop,name));
    }
    if(stops.length!==proposal.stops.length)continue;
    const nodes=[from,...stops,to],names=nodes.map(p=>p.name),signature=JSON.stringify(names);
    if(new Set(names).size!==names.length || signatures.has(signature))continue;
    if(constraints.max_transfers!=null && stops.length>constraints.max_transfers)continue;
    signatures.add(signature);
    for(const p of stops)if(!data.places.some(x=>x.name===p.name))data.places.push(p);
    const refs=support.map(s=>({title:s.title,link:s.url,date:s.published_at,temporal:s.temporal,allowed_use:'exploration_only'}));
    data.candidates.push({id:'cand-search-'+id(names),kind:stops.length?'discovered':'direct',builder:'search+llm',
      hypothesis:true,transfers:stops.length,basis:{rule:stops.length?'search-discovery':'requested-direction',sources:stops.length?refs:[],node_quotes:proposal.stops.filter(stop=>{const source=support.find(s=>s.id===stop.source_id);return source && str(stop.quote,500) && (source.title+'\n'+source.excerpt).includes(stop.quote);}).map(s=>({name:str(s.name),name_latin:str(s.name_latin),source_id:str(s.source_id),quote:str(s.quote,500)}))},
      legs:nodes.slice(0,-1).map((p,i)=>searchLeg(p,nodes[i+1],i+1)),
      explanation:stops.length?'建议比较经'+stops.map(p=>p.name).join('、')+'的探索方向；逐段连接、班期与接驳待查。':'直达方向作为比较基准；是否存在适用的客运服务仍待查。',
      why_explore:'比较路线结构及沿途停留的取舍，资料不证明本次日期可成行。',
      uncertain_leg:nodes.slice(0,-1).map((p,i)=>p.name+' → '+nodes[i+1].name+'（连接待查）').join('；'),
      next_checks:['逐段核对客运连接、方向、班期和站点','按用户日期独立核对返程及接驳'],tradeoffs:[],fragile_legs:[]});
    if(data.candidates.length===3)break;
  }
  if(signal?.aborted)return fail('规划已取消，原输入与安排仍保留。','cancelled');
  if(!data.candidates.length)return fail('本轮资料尚不能形成可比较的走法；可以继续细化方向或补查。','partial');
  data.status='ok';
  data.planning_notice='以下是可继续讨论的探索结构，地图位置、逐段客运连接与当期安排仍待核验。';
  return data;
}
