/* 编排前的旅行讨论。方案与授权独立于草案，城市建议不写入用户必去点。 */
import {createHash,createHmac} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadOrCreateKey} from './runtime-key.mjs';
import {agentPrompt} from './agent-prompts.mjs';
import {countryScope} from './place-scope.mjs';
import {collectTravelSources} from './travel-sources.mjs';
import {relevanceReviewer} from './source-relevance.mjs';
import {buildEvidenceCatalog} from './evidence-grounding.mjs';
import {groundConversationOutput} from './conversation-evidence.mjs';
import {buildNumericCatalog,validateNumericClaims} from './numeric-grounding.mjs';
import {samePlace,cleanStayLocks,outlineTotal,staySatisfied} from './itinerary-constraints.mjs';
const secret=loadOrCreateKey(fileURLToPath(new URL('../.state/planning-auth.key',import.meta.url)),{legacyPath:fileURLToPath(new URL('../logs/planning-auth.key',import.meta.url))});
const text=(v,n=1200)=>typeof v==='string'?v.trim().slice(0,n):'';
const canonical=v=>Array.isArray(v)?v.map(canonical):v && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export function cleanDiscussion(v={}){
  return {version:1,scopes:Array.isArray(v?.scopes)?v.scopes.filter(s=>s && ['country','province','region'].includes(s.level) && text(s.name,80) && (s.level!=='country' || countryScope(s.name))).slice(0,8).map(s=>({name:text(s.name,80),level:s.level})):[],
    stay_locks:cleanStayLocks(v?.stay_locks),
    options:Array.isArray(v?.options)?v.options.slice(0,3).filter(o=>o && typeof o.id==='string' && Array.isArray(o.route) && Array.isArray(o.segments)).map(o=>({id:text(o.id,80),title:text(o.title,80),description:text(o.description),route:o.route.map(p=>text(p,80)).filter(Boolean).slice(0,12),segments:o.segments.slice(0,20).map(s=>({place:text(s.place,80),days:s.days,scope:text(s.scope,80)})),outbound_days:o.outbound_days,return_days:o.return_days,suggested_total:o.suggested_total===true,trip_type:o.trip_type || 'pending',memberships:Array.isArray(o.memberships)?o.memberships.map(m=>({city:text(m.city,80),scope:text(m.scope,80),source_id:text(m.source_id,100),quote:text(m.quote,500)})):[]})):[],
    selected_id:text(v?.selected_id,80)||null,conditions_hash:text(v?.conditions_hash,64),hard_conditions_hash:text(v?.hard_conditions_hash,64),confirmation_requested:v?.confirmation_requested===true,authorization:text(v?.authorization,64)||null};
}
export function discussionFingerprint(conversation,current){
  const travel={...current.travel};travel.trip_type ||= 'pending';travel.traveler_count ||= 1;
  return hash({brief:{origin:conversation.brief.origin,destination:conversation.brief.destination,wishes:conversation.brief.wishes},requirements:conversation.requirements,scopes:conversation.discussion?.scopes || [],stay_locks:conversation.discussion?.stay_locks || [],preferences:current.preferences || {},travel,constraints:current.constraints || {},anchors:{outbound:current.anchors?.outbound || null,return:current.anchors?.return || null},sights:current.sights || {}});
}
function hardFingerprint(conversation,current){
 const preferences=current.preferences || {};
 return discussionFingerprint({...conversation,brief:{...conversation.brief,wishes:[]},discussion:{...conversation.discussion,stay_locks:cleanStayLocks(conversation.discussion?.stay_locks).map(({quote,...lock})=>lock)}},
  {...current,preferences:{road:preferences.road??null,nights:preferences.nights??null,preferred_mode:preferences.preferred_mode??null,destination_days:preferences.destination_days??null}});
}
const token=(discussion,fingerprint)=>createHmac('sha256',secret).update(JSON.stringify({options:discussion.options,selected_id:discussion.selected_id,conditions_hash:fingerprint})).digest('hex');
export function authorizedOutline(conversation,current){
  const d=cleanDiscussion(conversation.discussion),fingerprint=discussionFingerprint(conversation,current);
  return d.authorization && d.conditions_hash===fingerprint && d.authorization===token(d,fingerprint)?d.options.find(o=>o.id===d.selected_id)||null:null;
}
export function scopeRequirements(requirements,scopes){
  return {...requirements,required_stops:requirements.required_stops.filter(p=>!countryScope(p) && !scopes.some(s=>s.name===p))};
}
export function outlineErrors(option,{origin,destination=null,days,tripType,scopes,requiredStops,catalog,stayLocks=[]}){
  if(!option || !text(option.title,80) || !text(option.description) || !Array.isArray(option.segments) || !option.segments.length || option.segments.length>12)return ['invalid_shape'];
  const errors=[];
  if(![option.outbound_days,option.return_days].every(d=>Number.isInteger(d)&&d>=0&&d<=60))errors.push('invalid_transport_days');
  if(tripType!=='round_trip' && option.return_days!==0)errors.push('return_not_authorized: return_days must be 0');
  if(option.segments.some(s=>!text(s.place,80) || countryScope(s.place) || scopes.some(r=>r.name===s.place) || !Number.isInteger(s.days) || s.days<1 || s.days>60))errors.push('invalid_stay_segment');
  const total=outlineTotal(option);if(!total||total>60||days&&total!==days)errors.push('invalid_total_days');
  const places=option.segments.map(s=>s.place);
  if([origin,...places].filter((p,i,a)=>i===0||p!==a[i-1]).length>12)errors.push('route_capacity_exceeded');
  if(!origin || !requiredStops.every(p=>samePlace(p,origin) || places.some(city=>samePlace(city,p))))errors.push('missing_required_stop');
  if(destination && !scopes.length && !places.some(city=>samePlace(city,destination)))errors.push('missing_destination');
  if(cleanStayLocks(stayLocks).some(l=>!staySatisfied(l,option.segments.filter(s=>samePlace(s.place,l.place)||samePlace(s.scope,l.place)).reduce((n,s)=>n+s.days,0))))errors.push('locked_stay_mismatch');
  const memberships=option.memberships || [];
  const supports=(city,scope)=>memberships.some(m=>m.scope===scope && m.city===city && (()=>{
    const source=catalog.entries.find(e=>e.source_id===m.source_id || e.id===m.source_id);
    return source && text(m.quote).length>=4 && (source.title+'\n'+source.excerpt).includes(m.quote);
  })());
  if(!scopes.every(s=>places.some(city=>supports(city,s.name))) || scopes.length && !option.segments.every(s=>scopes.some(r=>r.name===s.scope) && supports(s.place,s.scope)))errors.push('missing_scope_membership_or_quote');
  return errors;
}
export const validateOutline=(option,context)=>outlineErrors(option,context).length===0;
function renderOption(o,index){
  return `${index+1}. ${o.title}\n${o.route.join(' → ')}\n${o.description}\n${o.suggested_total?'建议共'+outlineTotal(o)+'天；':''}时间分配：${o.outbound_days?'出发交通'+o.outbound_days+'天，':''}${o.segments.map(s=>s.place+s.days+'天').join('、')}${o.return_days?'，返程交通'+o.return_days+'天':''}。${!o.outbound_days&&!o.return_days?'首尾交通包含在停留安排内。':'跨城移动包含在各段安排内。'}`;
}
export async function discussPlan({before,next,current,raw,input,model,search,readPage,signal,now,evidenceReview,trace,useCache=true}){
  const prior=cleanDiscussion(before.discussion),decision=raw.planning || {},d=cleanDiscussion(next.discussion);
  const fingerprint=discussionFingerprint(next,current);
  const hardHash=hardFingerprint(next,current);
  const forceRefresh=input.refresh_sources===true || decision.refresh_sources===true && typeof decision.refresh_quote==='string' && decision.refresh_quote.trim().length>0 && input.text.includes(decision.refresh_quote);
  const collectionOptions={readPage,signal,now,useCache,cacheScope:fingerprint,forceRefresh,assessSources:evidenceReview?relevanceReviewer(model):null};
  const changed=prior.conditions_hash && prior.conditions_hash!==fingerprint && (!prior.hard_conditions_hash || prior.hard_conditions_hash!==hardHash);
  if(changed){d.options=[];d.selected_id=null;d.confirmation_requested=false;}
  d.authorization=null;d.conditions_hash=fingerprint;d.hard_conditions_hash=hardHash;next.discussion=d;
  let reply=text(raw.reply),sources=[],claims=[],requestGeneration=false,partial=false;
  const action=changed && ['select','confirm'].includes(decision.action)?'propose':decision.action || 'ask';
  const picked=decision.selected_id?d.options.find(o=>o.id===decision.selected_id):d.options.find(o=>o.id===d.selected_id) || (d.options.length===1?d.options[0]:null);
  let confirmed=false;
  if(action==='confirm' && picked && !changed){
    const checked=await model({kind:'planning_confirmation',timeoutMs:10000,schema_prompt:agentPrompt('planning.confirmation'),user:JSON.stringify({text:input.text,last_assistant_message:(input.messages || []).filter(m=>m.role==='assistant').at(-1)?.text || '',confirmation_requested:prior.confirmation_requested,hard_conditions_unchanged:true,current,selected_option:picked})});
    confirmed=checked?.generate===true && typeof checked.quote==='string' && checked.quote.trim().length>0 && input.text.includes(checked.quote);
  }
  if(confirmed){
    if(!next.requirements.trip_days && picked.suggested_total && outlineTotal(picked)){next.requirements={...next.requirements,trip_days:outlineTotal(picked)};current.requirements=next.requirements;}
    d.conditions_hash=discussionFingerprint(next,current);d.hard_conditions_hash=hardFingerprint(next,current);d.selected_id=picked.id;d.authorization=token(d,d.conditions_hash);next.routing={origin:picked.route[0],destination:picked.route.at(-1)};next.stage='ready';
    reply='按这份已确认的方案编排每日行程。';requestGeneration=true;
  }else if(action==='select' && picked && !changed){
    d.selected_id=picked.id;d.confirmation_requested=true;
    reply=renderOption(picked,d.options.indexOf(picked))+'\n\n要按这份方案生成完整逐日攻略吗？';
  }else if(action==='select'){
    reply='没有匹配到你选择的方案，请用方案里的城市顺序说明想采用哪一种。';
  }else if(action==='propose'){
    const destination=d.scopes.map(s=>s.name).join(' ') || next.brief.destination;
    if(!next.brief.origin || !destination){
      // 尚未选定地理范围时先推荐方向，不强迫用户先填完整路线，也不自行选中目的地。
      const collection=await collectTravelSources({destination:destination || '',query:text([destination,input.text,next.brief.wishes?.join(' ')].filter(Boolean).join(' '),100),question:input.text,purpose:'experience',international:true,travel:current.travel},search,collectionOptions);
      sources=[...collection.sources,...collection.experiences,...collection.archive.filter(s=>s.relevance?.decision==='keep')].slice(0,8);
      const catalog=buildEvidenceCatalog({sources,now,retrieval:{purpose:'experience'}});
      const answer=await model({kind:'planning_directions',timeoutMs:20000,schema_prompt:agentPrompt('planning.directions'),user:JSON.stringify({text:input.text,brief:next.brief,current,evidence_catalog:catalog})});
      reply=text(answer?.reply);if(!reply)throw Error('旅行方向整理未完成');
      if(evidenceReview){const checked=await groundConversationOutput({reply,catalog,model,signal,allowRepair:true,repairScope:'fields',conditions:{text:input.text,current}});if(!['complete','partial'].includes(checked.status))throw Error('旅行方向事实核对未完成');reply=checked.reply;claims=checked.claims || [];partial=checked.status==='partial';}
      if(validateNumericClaims({reply},{catalog:buildNumericCatalog({sources}),constraints:current.constraints,text:input.text}).rejected.length)throw Error('旅行方向包含无依据数字');
      d.confirmation_requested=false;
    }
    else {
      trace('planning_discussion','researching');
      const regions=d.scopes.length?d.scopes.map(s=>s.name):[destination],groups=Array.from({length:Math.min(3,regions.length)},()=>[]);regions.forEach((name,i)=>groups[i%groups.length].push(name));
      const collections=await Promise.all(groups.map(names=>names.join(' ')).map(place=>collectTravelSources({destination:place,query:place+' 旅行 城市 路线 特色 '+text(next.brief.wishes?.join(' '),80),foreignQuery:place+' travel itinerary cities',purpose:'experience',travel:current.travel},search,collectionOptions)));
      sources=collections.flatMap(c=>[...c.sources,...c.experiences,...c.archive.filter(s=>s.relevance?.decision==='keep')].slice(0,4)).filter((s,i,a)=>a.findIndex(t=>t.url===s.url)===i).slice(0,12);
      const catalog=buildEvidenceCatalog({sources,now,retrieval:{purpose:'experience'}});
      const optionCount=Number.isInteger(decision.option_count)?Math.max(1,Math.min(3,decision.option_count)):d.scopes.length?3:1;
      const payload={text:input.text,brief:next.brief,current,scopes:d.scopes,stay_locks:d.stay_locks,option_count:optionCount,previous_options:prior.options,evidence_catalog:catalog};
      const rules={origin:next.brief.origin,destination:next.routing.destination || next.brief.destination,days:current.requirements.trip_days,tripType:current.travel.trip_type,scopes:d.scopes,requiredStops:current.requirements.required_stops,catalog,stayLocks:d.stay_locks};
      let proposed=await model({kind:'planning_outline',timeoutMs:25000,schema_prompt:agentPrompt('planning.outline'),user:JSON.stringify(payload)});
      let candidates=(Array.isArray(proposed?.options)?proposed.options:[]).slice(0,optionCount);
      if(candidates.length && candidates.every(o=>!validateOutline(o,rules))){
        const validation_errors=candidates.map((o,index)=>({index,errors:outlineErrors(o,rules)}));trace('outline_validation','repairing',{validation_errors});
        proposed=await model({kind:'planning_outline',timeoutMs:25000,schema_prompt:agentPrompt('planning.outline'),user:JSON.stringify({...payload,proposed_options:candidates,validation_errors})});
        candidates=(Array.isArray(proposed?.options)?proposed.options:[]).slice(0,optionCount);
      }
      const valid=candidates.filter(o=>validateOutline(o,rules));
      const options=[];
      for(const item of valid){
        const o={...item,segments:item.segments.map(s=>({...s,place:text(s.place,80),scope:d.scopes.some(r=>r.name===s.scope)?s.scope:''})),memberships:(item.memberships || []).filter(m=>d.scopes.some(s=>s.name===m.scope)),suggested_total:!current.requirements.trip_days,trip_type:current.travel.trip_type || 'pending',route:[next.brief.origin,...item.segments.map(s=>s.place)].filter((p,i,a)=>i===0 || p!==a[i-1])};
        const geography=(o.memberships || []).map(m=>m.city+'位于'+m.scope+'。').join('\n');
        o.title=o.segments.map(s=>s.place).join('—');
        const placeFacts=[...o.segments.map(s=>s.place),geography].filter(Boolean).join('\n');
        if(evidenceReview){
          const checked=await groundConversationOutput({reply:'',draft:{title:o.title,overview:o.description,route:o.route,cards:[],sections:[{title:'地点范围',content:placeFacts}],pending:[]},catalog,model,signal,allowRepair:true,repairScope:'fields',deliveryMode:true,conditions:{text:input.text,current,route:o.route}});
          trace('outline_evidence',checked.status,{gaps:checked.gaps?.length || 0});
          if(!['complete','partial'].includes(checked.status) || checked.draft?.sections?.[0]?.content!==placeFacts || !text(checked.draft?.overview))continue;
          o.description=checked.draft.overview;
          claims.push(...checked.claims || []);
        }
        if(validateNumericClaims({reply:o.description},{catalog:buildNumericCatalog({sources}),constraints:current.constraints,text:input.text}).rejected.length)continue;
        o.id='outline_'+hash(o).slice(0,16);options.push(o);
      }
      d.options=cleanDiscussion({options}).options;d.selected_id=null;d.confirmation_requested=options.length===1;
      if(!options.length && !changed){d.options=prior.options;d.selected_id=prior.selected_id;}
      reply=options.length?options.map(renderOption).join('\n\n')+'\n\n'+(options.length===1?'这份粗略安排符合你的想法吗？确认后我再编排完整逐日攻略。':'你更倾向哪一种？选定后我们再确认是否编排完整逐日攻略。'):candidates.length&&!valid.length?'这次方案尚未对齐你的条件，本次没有采用，原有想法和方案仍保留，可以重试整理。':'这次资料还不足以形成可靠的城市组合，已保留你的想法。可以继续补充最想去的地方，或让我重新查找路线。';
      partial=!options.length || Number.isInteger(decision.option_count)&&options.length<optionCount;
      if(options.length && partial)reply='目前有'+options.length+'种方案通过资料核对，其余方向还需要补充资料。\n\n'+reply;
    }
  }else if(action==='confirm'){
    if(picked){d.selected_id=picked.id;d.confirmation_requested=true;reply=renderOption(picked,d.options.indexOf(picked))+'\n\n要按这份方案生成完整逐日攻略吗？';}
    else reply='先选定一份粗略方案，我们再按它编排每日行程。';
  }
  if(action==='ask'){
    if(!reply){trace('output_contract','failed',{missing_fields:['reply']});throw Error('讨论回复为空');}
    if(validateNumericClaims({reply},{catalog:[],constraints:current.constraints,text:input.text}).rejected.length)throw Error('讨论回复含无依据数字');
    if(evidenceReview){const checked=await groundConversationOutput({reply,catalog:buildEvidenceCatalog({sources:[],now}),model,signal,allowRepair:false,conditions:{text:input.text,current}});if(checked.status!=='complete')throw Error('讨论回复事实核对未完成');reply=checked.reply;}
  }
  if(!requestGeneration)next.stage='discuss';
  trace('planning_discussion','completed',{action,options:d.options.length,authorized:requestGeneration});
  return {status:'ok',engine:'llm',task_status:partial?'partial':'discussed',reply,conversation:next,sources,evidence_claims:claims,request_generation:requestGeneration,request_route_discovery:false};
}
