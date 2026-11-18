/* 长稿按完整日卡分批，邻日正文随批携带；全程核对可按ID读取原卡。 */
import {agentPrompt} from './agent-prompts.mjs';
import {CONTEXT_BUDGET_CHARS} from './context-builder.mjs';
const project=c=>({id:c.id,place:c.place,label:c.label,title:c.title,content:c.content});
const fits=(payload,rules,budgetChars=CONTEXT_BUDGET_CHARS)=>JSON.stringify(payload).length+rules.length+3000<=budgetChars;
export function qualityReviewPayload(draft,current,must=[]){return {current,draft:{title:draft.title,overview:draft.overview,route:draft.route,cards:draft.cards.map(project),sections:draft.sections},must_have_activity:must};}
export function needsQualityBatches(draft,current,must=[],budgetChars){return !fits(qualityReviewPayload(draft,current,must),agentPrompt('conversation.quality_review'),budgetChars);}
export async function reviewLongItinerary({draft,current,mustHaveActivity=[],model,normalizeReview,canCall,signal,onTrace,budgetChars}){
 const unknown=()=>null,rule=agentPrompt('conversation.quality_review')+'\n'+agentPrompt('conversation.quality_batch');
 const batches=[];let start=0;
 const payloadFor=(start,end)=>{const owner=draft.cards.slice(start,end),window=draft.cards.slice(Math.max(0,start-1),Math.min(draft.cards.length,end+1));return {current,scope_ids:owner.map(c=>c.id),quote_budget:160,draft:{title:draft.title,route:draft.route,overview:'',sections:[],cards:owner.map(project)},readonly_neighbors:window.filter(c=>!owner.includes(c)).map(project),must_have_activity:mustHaveActivity.filter(id=>owner.some(c=>c.id===id))};};
 while(start<draft.cards.length){let end=start+1,payload=payloadFor(start,end);if(!fits(payload,rule,budgetChars))return unknown();while(end<draft.cards.length&&fits(payloadFor(start,end+1),rule,budgetChars)){end++;payload=payloadFor(start,end);}batches.push(payload);start=end;}
 if(!canCall(batches.length+1))return unknown();
 const assessments=[],continuity=[],issues=[];
 for(let index=0;index<batches.length;index++){
  if(signal?.aborted)throw signal.reason;
  if(!canCall(1))return unknown();
  const payload=batches[index];onTrace({stage:'quality_batch',status:'started',batch:index+1,batches:batches.length,card_ids:payload.scope_ids});
  const raw=await model({kind:'conversation_quality_batch',timeoutMs:15000,schema_prompt:rule,user:JSON.stringify(payload)});
  const checked=normalizeReview(raw,payload.draft,payload.readonly_neighbors);
  if(!checked||raw.summary_matches!==true||checked.issues.some(i=>i.code==='summary_mismatch'))return unknown();
  const notes=raw.continuity;
  if(!Array.isArray(notes)||notes.length!==payload.scope_ids.length||new Set(notes.map(n=>n?.id)).size!==notes.length||notes.some(n=>{
   const card=payload.draft.cards.find(c=>c.id===n?.id);return !payload.scope_ids.includes(n?.id)||!Array.isArray(n.quotes)||!n.quotes.length||n.quotes.join('').length>payload.quote_budget||n.quotes.some(q=>typeof q!=='string'||!q.trim()||!card.content.includes(q));
  }))return unknown();
  assessments.push(...checked.cards.filter(c=>payload.scope_ids.includes(c.id)));issues.push(...checked.issues);continuity.push(...notes);
 }
 const globalRule=agentPrompt('conversation.quality_global');
 const payload={current,route:draft.route,overview:draft.overview,sections:draft.sections,reviewed_outline:draft.cards.map(c=>({id:c.id,place:c.place,label:c.label,title:c.title,quotes:continuity.find(n=>n.id===c.id).quotes})),local_issues:issues,read_cards:[]};
 const readIds=new Set();
 // 有界按需读原卡；不截断原文，也不因一次读取成功而宣称全程通过。
 for(let round=0;round<4;round++){
  if(signal?.aborted)throw signal.reason;
  if(!canCall(1)||!fits(payload,globalRule,budgetChars))return unknown();
  const raw=await model({kind:'conversation_quality_global',timeoutMs:15000,schema_prompt:globalRule,user:JSON.stringify(payload)});
  if(raw?.action==='read'){
   const ids=raw.card_ids;if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>readIds.has(id)||!draft.cards.some(c=>c.id===id)))return unknown();
   ids.forEach(id=>readIds.add(id));payload.read_cards.push(...draft.cards.filter(c=>ids.includes(c.id)).map(project));continue;
  }
  if(raw?.action!=='done'||typeof raw.summary_matches!=='boolean'||!Array.isArray(raw.issues))return unknown();
  return normalizeReview({cards:assessments,summary_matches:raw.summary_matches,issues:issues.concat(raw.issues)},draft);
 }
 return unknown();
}
