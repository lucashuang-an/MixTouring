import {agentPrompt} from './agent-prompts.mjs';
import {buildContext} from './context-builder.mjs';
import {englishRequest} from './response-language.mjs';
import {outlineDayPlan} from './itinerary-constraints.mjs';

const kinds=new Set(['user_requirement','route','schedule','contradiction','critical_fact','missing_day']);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// 只做一次整体验收；修正必须指向已指出的显著问题和已有字段，不重写整稿。
export async function reviewFinalItinerary({draft,current,messages=[],confirmedOutline=null,catalog,model,signal,scope=[],readonly=[],check,budgetChars}){
 const original=structuredClone(draft),baseline=check(original);
 const fallback=reason=>({draft:original,status:'unreviewed',issues:[],applied:0,reason});
 const fields=new Map([['title',original.title],['overview',original.overview],['route',original.route],
  ...original.sections.map((s,i)=>['sections.'+i+'.content',s.content]),
  ...original.cards.flatMap((c,i)=>['label','place','title','content'].map(k=>['cards.'+i+'.'+k,c[k]]))]);
 const allowedPlaces=new Set([...original.route,...confirmedOutline?.route || [],...current.requirements?.required_stops || [],current.routing?.origin,current.routing?.destination].filter(Boolean));
 try{
  if(signal?.aborted)throw signal.reason;
  const built=buildContext({coreRules:agentPrompt('conversation.final_review'),budgetChars,payload:{current,user_messages:messages.filter(m=>m.role==='user'),confirmed_outline:confirmedOutline,confirmed_day_plan:outlineDayPlan(confirmedOutline),draft:original,
   revision_scope:scope.length?'local':'whole',editable_card_ids:scope.length?scope:original.cards.map(c=>c.id).filter(id=>!readonly.includes(id)),readonly_card_ids:[...new Set([...readonly,...(scope.length?original.cards.filter(c=>!scope.includes(c.id)).map(c=>c.id):[])])],
   structural_issues:baseline.filter(c=>c.status==='failed'),evidence_catalog:catalog}});
  const raw=await model({kind:'conversation_final_review',schema_prompt:agentPrompt('conversation.final_review'),user:JSON.stringify(built.value),timeoutMs:45000,signal});
  if(signal?.aborted)throw signal.reason;
  if(!raw || !Array.isArray(raw.issues) || !Array.isArray(raw.changes) || raw.issues.length>20 || raw.changes.length>60)return fallback('invalid_review');
  if(raw.issues.some(i=>!i || typeof i.id!=='string' || !i.id || !['ok','issue'].includes(i.decision) || !kinds.has(i.kind) || !['major','minor'].includes(i.severity) || typeof i.reason!=='string' || !i.reason.trim() || !Array.isArray(i.card_ids) || i.card_ids.some(id=>!original.cards.some(c=>c.id===id))) || new Set(raw.issues.map(i=>i.id)).size!==raw.issues.length)return fallback('invalid_issues');
  let candidate=structuredClone(original),applied=0;
  const unresolved=[],used=new Set();let ignoredOutsideScope=0;
  if(raw.changes.some(p=>!raw.issues.some(i=>i.id===p.issue_id)))return fallback('unexplained_changes');
  for(const issue of raw.issues){
   if(issue.decision!=='issue' || issue.severity!=='major')continue;
   if(scope.length && !issue.card_ids.some(id=>scope.includes(id))){ignoredOutsideScope++;continue;}
   const changes=raw.changes.filter(p=>p.issue_id===issue.id),proposed=structuredClone(candidate);
   let valid=issue.resolved===true && changes.length>0 && new Set(changes.map(p=>p.path)).size===changes.length;
   for(const patch of changes){
    const match=/^cards\.(\d+)\.(label|place|title|content)$/.exec(patch.path || ''),card=match?original.cards[Number(match[1])]:null;
    if(!fields.has(patch.path) || used.has(patch.path) || !equal(patch.old,fields.get(patch.path)) || equal(patch.old,patch.value)){valid=false;break;}
    if(card && (readonly.includes(card.id) || scope.length&&!scope.includes(card.id))){valid=false;break;}
    if(patch.path==='route'){
     if(scope.length || !Array.isArray(patch.value) || !patch.value.length || patch.value.length>12 || patch.value.some(p=>!allowedPlaces.has(p))){valid=false;break;}
    }else if(typeof patch.value!=='string' || !patch.value.trim() || patch.value.length>(patch.path.endsWith('title')?100:patch.path.endsWith('content')?1200:1600)){valid=false;break;}
    if(match?.[2]==='place'&&!allowedPlaces.has(patch.value)){valid=false;break;}
    const parts=patch.path.split('.'),key=parts.pop(),owner=parts.reduce((o,k)=>o[k],proposed);owner[key]=patch.value;
   }
   // 每组补丁都以当前已接受结果为基线，后续修正不能重新引入已解决的问题。
   const currentFailures=new Set(check(candidate).filter(c=>c.status==='failed').map(c=>c.name));
   if(valid && check(proposed).some(c=>c.status==='failed'&&!currentFailures.has(c.name)))valid=false;
   if(valid){candidate=proposed;applied+=changes.length;changes.forEach(p=>used.add(p.path));}
   else unresolved.push({code:issue.kind,card_ids:issue.card_ids,reason:issue.reason});
  }
  const en=englishRequest({text:current.text || '',messages});
  const labels={route_endpoints:['城市顺序与出发、抵达条件未对齐','The route does not match the departure and destination.'],required_stops:['仍有必去城市未安排','A required city is missing.'],day_coverage:['日程未完整覆盖约定天数','The itinerary does not cover the agreed days.'],card_content:['部分日期内容不完整','Some days have incomplete content.'],locked_stays:['未满足明确指定的停留天数','A required stay duration is not met.'],confirmed_allocation:['城市停留分配偏离已确认方案','The city allocations differ from the confirmed outline.']};
  for(const failure of check(candidate).filter(c=>c.status==='failed'))unresolved.push({code:failure.name,card_ids:[],reason:labels[failure.name]?.[en?1:0] || (en?'Part of the itinerary still needs adjustment.':'部分安排仍需调整')});
  const notice=unresolved.length?(en?'Still to resolve: ':'仍需调整：')+[...new Set(unresolved.map(i=>i.reason))].slice(0,3).join(en?' ':'；'):applied>0 && applied===raw.changes.length && typeof raw.reply==='string'?raw.reply.trim().slice(0,500):'';
  return {draft:candidate,status:unresolved.length?'needs_repair':'passed',issues:unresolved,applied,ignored_outside_scope:ignoredOutsideScope,reason:null,
   notice};
 }catch(error){if(signal?.aborted || error.code==='RUN_INTERRUPTED')throw error;return fallback(error.code==='CONTEXT_BUDGET_EXCEEDED'?'context_limit':'review_unavailable');}
}
