/* 旅行交付合同：纯检查器，不调用模型、不改稿、不将运行结束当作旅行核实。 */
import workspace from '../../mixtouring-hifi/assets/route-workspace.js';
import {routeMatchesIntent} from './planning-state.mjs';
import {allocationReview} from './itinerary-constraints.mjs';
export function checkTravelDelivery({draft,requirements={},routing={},numeric,evidence,requireEvidence=false,requireDaily=true,quality=null,confirmedOutline=null,stayLocks=[]}={}){
  const checks=[];
  const add=(name,passed,details=[])=>checks.push({name,status:passed?'passed':'failed',details});
  if(requireDaily && !draft)add('draft_present',false);
  if(draft){
    const route=draft.route || [],cards=draft.cards || [];
    // 保留旧sections草案兼容；有route/cards时执行相应结构合同。
    if(route.length || requireDaily && cards.length)add('route_endpoints',routeMatchesIntent(route,routing,requirements));
    add('required_stops',(requirements.required_stops || []).every(p=>route.includes(p)));
    const coverage=workspace.dayCoverage(draft,requirements.trip_days);
    if(requirements.trip_days && (requireDaily || coverage))add('day_coverage',!!coverage && !coverage.missing.length && !coverage.outside.length,coverage?[...coverage.missing,...coverage.outside]:[]);
    if(cards.length)add('card_content',cards.every(c=>c.id && c.title?.trim() && c.content?.trim()) && new Set(cards.map(c=>c.id)).size===cards.length);
  }
  if(numeric)add('numeric_support',!numeric.rejected.length);
  if(requireEvidence)add('evidence_check',!!evidence && ['complete','partial'].includes(evidence.status));
  const allocation=draft?allocationReview(draft,confirmedOutline,stayLocks):{changes:[],hard_issues:[]};
  if(draft && stayLocks.length)add('locked_stays',!allocation.hard_issues.length,allocation.hard_issues);
  const valid=checks.every(c=>c.status==='passed');
  if(quality)add('itinerary_quality',quality.status==='passed',quality.issues || []);
  return {valid,passed:valid && (!quality || quality.status==='passed'),checks,allocation_changes:allocation.changes};
}
export function taskOutcome(result){
  if(result.status!=='ok')return result.status==='needs_intent'?'waiting_user':'active';
  if(result.request_generation)return 'active';
  if(result.delivery_validation?.passed && ['delivered','previewed','answered'].includes(result.task_status))return 'satisfied';
  if(result.task_status==='partial')return 'active';
  return result.conversation?.brief?.open_questions?.length?'waiting_user':'active';
}

// 前端只执行本轮服务端认可的后续动作；ready是状态，不是搜索授权。
export function nextConversationAction(result){
  const revision=result.conversation?.revision ?? 0;
  if(result.status!=='ok' || result.run?.status==='interrupted')return {type:'none',revision};
  if(result.request_generation && result.conversation?.stage==='ready')return {type:'generate',revision};
  if(result.request_route_discovery && result.conversation?.stage==='ready')return {type:'discover_routes',revision};
  return {type:'none',revision};
}
// 规划器done仅表示结束探索。回答完成还须有明确解决判定和通过核对的结论。
export function researchTaskSatisfied({resolution,verifyStatus,claims=[],gaps=[],interrupted=false}={}){
  return !interrupted && resolution==='answered' && verifyStatus==='complete' && claims.length>0 && gaps.length===0;
}
