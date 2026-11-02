/* 旧成稿回归的前置条件：先经过真实确认转换，再测试下游编排。不是产品候选库。 */
import {conversationTurn as turn,cleanConversation} from '../lib/conversation.mjs';
import {discussPlan,discussionFingerprint} from '../lib/planning-discussion.mjs';
import guide from '../../mixtouring-hifi/assets/trip-guide.js';
import {sanitizeConstraints,sanitizeIntentFields} from '../lib/anywhere.mjs';
import {normalizeSightState} from '../lib/sights.mjs';
import workspace from '../../mixtouring-hifi/assets/route-workspace.js';
export {cleanConversation};
export async function confirmedInput(input,plan){
 const before=cleanConversation(input.conversation);
 if(before.stage!=='ready' || !before.brief.origin || !before.brief.destination)return input;
 const candidate=plan?.candidates?.find(c=>c.id===(input.requested_candidate_id || input.candidate_id));
 const route=candidate?workspace.routeFor(null,candidate):[...new Set([before.routing.origin || before.brief.origin,...before.requirements.required_stops,before.routing.destination || before.brief.destination])];
 const current={requirements:before.requirements,preferences:guide.clean(input.preferences),travel:sanitizeIntentFields(input.travel),constraints:sanitizeConstraints(input.constraints),anchors:input.anchors,sights:normalizeSightState(input.sights)};
 const option={id:'test-outline',title:'已讨论的测试方案',description:'用户确认按此城市顺序编排。',route,segments:route.slice(1).map(place=>({place,days:1,scope:''})),outbound_days:0,return_days:0,memberships:[]};
 before.discussion={...before.discussion,options:[option],confirmation_requested:true};before.discussion.conditions_hash=discussionFingerprint(before,current);
 const approved=await discussPlan({before,next:structuredClone(before),current,raw:{planning:{action:'confirm',selected_id:option.id}},input:{text:'按这份方案生成'},model:async()=>({generate:true,quote:'按这份方案生成'}),trace:()=>{}});
 // fixture的调用者此后以确认后的快照作为失败保留／撤销基线。
 Object.assign(input.conversation,approved.conversation);
 return {...input,conversation:approved.conversation};
}
export async function conversationTurn(input,plan,deps){return turn(input?.action==='generate'?await confirmedInput(input,plan):input,plan,deps);}
