/* 交通选择是用户意图。工具观察仅本轮使用，更新限于明确受影响的日卡。 */
import workspace from '../../mixtouring-hifi/assets/route-workspace.js';
import {agentPrompt} from './agent-prompts.mjs';
import {searchTransportSources} from './transport-search.mjs';
import {draftQueryScope} from './draft-research.mjs';
import {applyLocalRevision,explicitDayScope} from './planning-loop.mjs';
import {checkTravelDelivery} from './travel-completion.mjs';
import {buildEvidenceCatalog} from './evidence-grounding.mjs';
import {evidenceFields,groundConversationOutput} from './conversation-evidence.mjs';
import {validateNumericClaims} from './numeric-grounding.mjs';
const modes=['drive','rail','road','plane'];
const name=v=>typeof v==='string'?v.trim().slice(0,80):'';
const fail=message=>Object.assign(Error(message),{code:'TRANSPORT_REVISION'});
export function cleanTransportChoices(values){
 return (Array.isArray(values)?values:[]).slice(0,12).filter(c=>c&&name(c.from)&&name(c.to)&&c.from!==c.to&&modes.includes(c.mode))
  .map(c=>({from:name(c.from),to:name(c.to),mode:c.mode})).filter((c,i,a)=>a.findLastIndex(n=>n.from===c.from&&n.to===c.to)===i);
}
export function applicableTransportChoices(values,draft,travel={},constraints={}){
 const route=workspace.transportRoute(draft?.route || [],travel);
 return cleanTransportChoices(values).filter(c=>route.slice(1).some((to,i)=>route[i]===c.from&&to===c.to)&&!(c.mode==='drive'&&constraints.no_self_drive));
}
export function updateTransportChoices(before,changes,text){
 let result=cleanTransportChoices(before);
 for(const change of Array.isArray(changes)?changes:[]){
  if(typeof change?.quote!=='string'||!change.quote.trim()||!text.includes(change.quote)||!name(change.from)||!name(change.to))continue;
  if(change.mode!==null&&!modes.includes(change.mode))continue;
  result=result.filter(c=>c.from!==change.from||c.to!==change.to);
  if(change.mode!==null)result.push({from:change.from,to:change.to,mode:change.mode});
 }
 return cleanTransportChoices(result);
}
export async function reviseTransport({before,input,current,choices,model,search,readPage,runtime,signal,evidenceReview=true,mapTools={},now=Date.now(),trace=()=>{},preview=false,baseSignature=''}){
 if(!before.draft || before.preview)throw fail('请先采用或放弃预览，再调整当前行程的交通方式。');
 const requested=Array.isArray(choices)?choices:[],selected=cleanTransportChoices(requested);
 if(!selected.length || selected.length!==requested.length)throw fail('交通选择无效，原方案已保留。');
 if(input.transport_revision!=null && input.transport_revision!==before.revision)throw fail('日程已经更新，请基于当前版本重新选择交通方式。');
 const route=workspace.transportRoute(before.draft.route,current.travel);
 if(selected.some(c=>!route.slice(1).some((to,i)=>route[i]===c.from&&to===c.to)))throw fail('这段交通不在当前行程中，原方案已保留。');
 if(selected.some(c=>c.mode==='drive'&&current.constraints.no_self_drive || ['drive','road'].includes(c.mode)&&current.preferences.road==='exclude'))throw fail('这个选择与当前不自驾或排除公路的条件冲突，请先说明是否修改该条件。');
 if(selected.some(c=>[current.anchors?.outbound,current.anchors?.return].some(a=>a?.from_city===c.from&&a?.to_city===c.to&&a.mode&&a.mode!==c.mode)))throw fail('这段已有确认的交通安排，请先更新或取消已定安排，再调整出行方式。');
 const cards=before.draft.cards.map(c=>({id:c.id,place:c.place,label:c.label,title:c.title,fragments:[c.title,...c.content.split('\n').filter(Boolean)].map((text,i)=>({id:c.id+'@'+i,text}))}));
 const scoped=await model({kind:'planning_transport_scope',timeoutMs:15000,schema_prompt:agentPrompt('planning.transport_scope'),user:JSON.stringify({travel:current.travel,route:before.draft.route,cards})});
 const events=scoped?.events;
 if(!Array.isArray(events)||events.some(t=>!name(t.from)||!name(t.to)||t.from===t.to||!cards.some(c=>c.id===t.card_id&&c.fragments.some(f=>f.id===t.fragment_id))))throw fail('没有明确定位到这段交通对应的日卡，请说明想调整第几天。原方案已保留。');
 // 先从只读原稿提取实际方向，再由代码匹配选择。识别阶段不接触新的方式要求，避免推断往返自驾。
 const targets=selected.flatMap((choice,leg_index)=>events.filter(e=>e.from===choice.from&&e.to===choice.to).map(e=>({...e,leg_index,role:'transport'})));
 if(selected.some((_,i)=>!targets.some(t=>t.leg_index===i)))throw fail('没有明确定位到这段交通对应的日卡，请说明想调整第几天。原方案已保留。');
 const related=explicitDayScope(input.text,before.draft).filter(id=>!targets.some(t=>t.card_id===id));
 if(related.length){
  const checked=await model({kind:'planning_transport_authorization',timeoutMs:12000,schema_prompt:agentPrompt('planning.transport_authorization'),user:JSON.stringify({text:input.text,choices:selected,candidates:before.draft.cards.filter(c=>related.includes(c.id)).map(c=>({id:c.id,label:c.label,title:c.title}))})});
  const permissions=checked?.permissions;
  if(!Array.isArray(permissions)||permissions.length!==related.length||new Set(permissions.map(p=>p?.id)).size!==related.length||permissions.some(p=>!related.includes(p?.id)||typeof p.allow!=='boolean'||typeof p.quote!=='string'||!p.quote.trim()||!input.text.includes(p.quote)))throw fail('相关日期的修改范围尚未核对，原方案已保留。');
  for(const p of permissions)if(p.allow)targets.push({card_id:p.id,role:'related',user_quote:p.quote});
 }
 const ids=[...new Set(targets.map(t=>t.card_id))];
 trace('transport_revision_scope','completed',{card_ids:ids});
 if(!runtime.hasTool('transport_recheck'))runtime.register('transport_recheck',{readOnly:true,validate:c=>modes.includes(c.mode)&&!!c.from&&!!c.to,execute:(choice,{signal})=>searchTransportSources({...choice,places:before.draft.map_places || [],no_self_drive:current.constraints.no_self_drive,exclude_road:current.preferences.road==='exclude'},search,{mapTools,readPage,signal,now,useCache:false}),classify:r=>r?.status==='unavailable'?'error':r?.connection_options?.length?'success':'empty'});
 const queryScope=draftQueryScope({route:before.draft.route,travel:current.travel,constraints:current.constraints,preferences:current.preferences,transport_choices:selected},now);
 const observations=[],updates=[];
 // 同一次请求最多主动重查两段，其余保留未知；不通过增加查询额度冒充全程核实。
 for(let i=0;i<selected.length;i++){
  if(i>=2){observations.push({leg_index:i,status:'not_checked'});continue;}
  const leg=queryScope.legs.find(l=>l.from===selected[i].from&&l.to===selected[i].to);
  const result=await runtime.call('transport_recheck',{...selected[i],window:leg?.window || queryScope.window},{signal,scope:{revision:before.revision,travel:current.travel}});
  if(result.data)updates.push(result.data);
  const option=result.data?.connection_options?.find(o=>o.mode===selected[i].mode&&o.provider==='Google Maps');
  observations.push({leg_index:i,status:option?'reference':'unknown',observation:option?.route_result || null});
 }
 const catalog=buildEvidenceCatalog({sources:updates.flatMap(d=>d.sources || []),now});
 const payload={text:input.text,preview,current:{...current,brief:before.brief,stay_locks:before.discussion.stay_locks},choices:selected,observations,scope:targets,targets:before.draft.cards.filter(c=>ids.includes(c.id)),
  readonly_outline:before.draft.cards.filter(c=>!ids.includes(c.id)).map(c=>({id:c.id,place:c.place,label:c.label,title:c.title,content:c.content.slice(0,180)})),
  summary:{overview:before.draft.overview,sections:before.draft.sections},route:before.draft.route};
 let candidate,validation,review,grounding={sources:[],claims:[],inferences:[]};
 for(let attempt=0;attempt<2;attempt++){
  const proposed=await model({kind:'conversation_transport_revision',timeoutMs:25000,schema_prompt:agentPrompt('conversation.transport_revision'),user:JSON.stringify({...payload,...(review?{review_feedback:review.reason}: {})})});
  if(proposed?.blocked===true)throw fail('所选交通会影响更多日期，请说明可以一起调整哪些天；原方案已保留。');
  candidate=applyLocalRevision(before.draft,proposed,ids);
  const oldTexts=new Set(evidenceFields('',before.draft,{includePending:false}).map(f=>f.text));
  const newTexts=evidenceFields('',candidate,{includePending:false}).map(f=>f.text).filter(t=>!oldTexts.has(t));
  const delta={title:'',overview:newTexts.join('\n'),route:candidate.route,cards:[],sections:[],pending:[]};
  grounding={sources:[],claims:[],inferences:[]};
  const numeric=validateNumericClaims({draft:delta},{catalog:[],constraints:current.constraints,text:input.text,includePending:false});
  if(numeric.rejected.length)throw fail('调整内容出现未经支持的数值，原方案已保留。');
  if(evidenceReview && newTexts.length){
   const checked=await groundConversationOutput({reply:'',draft:delta,catalog,model,signal,deliveryMode:true,allowRepair:false,conditions:{text:input.text,current:{...current,transport_choices:selected},route:candidate.route}});
   if(checked.status!=='complete'||checked.draft?.overview!==delta.overview){
    trace('transport_revision_evidence','rejected',{reason:checked.reason || 'unsupported_delta'});
    review={passed:false,reason:'新增内容核对未通过。只保留用户选择的交通安排和必要的活动取舍，不新增外部属性，也不写核验说明。'+JSON.stringify({reason:checked.reason,gaps:checked.gaps || [],checked_text:checked.draft?.overview})};
    if(attempt===0)continue;
    throw fail('交通调整的新增内容未通过事实核对，原方案已保留。');
   }
   grounding=checked;
  }
  validation=checkTravelDelivery({draft:candidate,requirements:before.requirements,routing:before.routing,confirmedOutline:before.discussion.options.find(o=>o.id===before.discussion.selected_id),stayLocks:before.discussion.stay_locks});
  if(!validation.valid)throw fail('交通调整与原有天数或停留要求不一致，原方案已保留。');
  review=await model({kind:'planning_transport_review',timeoutMs:15000,schema_prompt:agentPrompt('planning.transport_review'),user:JSON.stringify({...payload,cards:candidate.cards.filter(c=>ids.includes(c.id)),summary:{overview:candidate.overview,sections:candidate.sections}})});
  if(review?.passed===true)break;
 }
 if(review?.passed!==true)throw fail('调整尚未通过与原日程的衔接检查，原方案已保留。');
 runtime.assertActive(signal);
 const merged=cleanTransportChoices((before.transport_choices || []).concat(selected));
 const changed=JSON.stringify(candidate)!==JSON.stringify(before.draft)||JSON.stringify(merged)!==JSON.stringify(before.transport_choices || []);
 const unresolved=observations.some(o=>o.status!=='reference');
 const labels=ids.map(id=>before.draft.cards.find(c=>c.id===id).label).join('、');
 const patch={preferences:{},travel:{},constraints:{},sights:{}};
 const next=preview?{...before,preview:{kind:'draft',draft:candidate,brief:before.brief,requirements:before.requirements,patch,base_revision:before.revision,base_signature:baseSignature,transport_choices:merged,memory_candidates:[],memory_evidence_refs:[]}}:{...before,transport_choices:merged,draft:candidate,stage:'draft',revision:before.revision+(changed?1:0),preview:null};
 return {status:'ok',engine:'llm',task_status:before.requirements.verified_cross_border_only?'partial':preview?'previewed':'delivered',
  reply:preview?'先看看'+labels+'改用所选方式后的安排，当前版本尚未改变。':changed?'已按所选交通方式调整'+labels+'，其他日期保持不变。'+(unresolved?'部分连接或耗时仍未核实，安排保留了弹性。':''): '当前相关日程保持不变，已重新检查交通参考。',
  conversation:next,patch,sources:grounding.sources || [],evidence_claims:grounding.claims || [],evidence_inferences:grounding.inferences || [],request_generation:false,clear_selection:!preview,selected_candidate_id:null,
  delivery_validation:{...validation,passed:validation.passed&&!before.requirements.verified_cross_border_only,verification_scope:{card_ids:ids,unchanged:'preserved_not_reverified'}},
  transport_updates:preview?[]:updates,
  transport_assessment:{available:observations.filter(o=>o.status==='reference').length,requested:selected.length,basis:'reference_only'}};
}
