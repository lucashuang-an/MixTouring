/* 对比后再生成：驱动真实前端函数，保证发现不会隐式选路或写出草案。 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import workspace from '../mixtouring-hifi/assets/route-workspace.js';
const html=readFileSync(new URL('../mixtouring-hifi/pages/trip.html',import.meta.url),'utf8');
const fn=(name,end)=>html.slice(html.indexOf(name),html.indexOf(end,html.indexOf(name)));
let generated=[],rendered=0,posts=0;
const plan={plan_id:'test-plan',candidates:[{id:'baseline'},{id:'via'}]};
const env={MTRouteWorkspace:workspace,conversationBusy:false,planning:false,routeResearch:{isPending:()=>false},supplementChosenRoute:async()=>({status:'complete'}),conversation:{stage:'ready',draft:null},guideSequence:0,guideMessages:[],lastRequest:{},activeCandidate:null,activePlan:null,conversationError:null,conversationController:null,
 document:{getElementById:()=>({value:''})},renderGuide(){},rememberSession(){},showWorkspaceView(v){assert.equal(v,'route');},renderRouteDecision(){rendered++;},
 collectTravel:()=>({}),collectConstraints:()=>({}),anchors:{},post:async()=>{posts++;return {code:0,data:{status:'ok',conversation:{stage:'ready'},routing:{origin:'北京',destination:'阿拉木图'}}};},
 requestPlan:async()=>{env.activePlan=plan;return true;},sendConversation(...args){generated.push(args);},currentComparison:()=>({routes:[{id:'baseline',eligible:true,route:['北京','阿拉木图'],variants:[{id:'baseline'}]},{id:'via',eligible:true,route:['北京','伊宁','阿拉木图'],variants:[{id:'via'},{id:'via-rail'}]}]})};
vm.createContext(env);
vm.runInContext(fn('async function generateConversation()','function renderGuide()'),env);
vm.runInContext(fn('async function selectDiscoveryRoute(','function visibleRoutes()'),env);
await env.generateConversation();
assert.equal(rendered>0,true);assert.equal(generated.length,0,'发现完成不能在未选择时生成逐日草案');assert.equal(env.conversationBusy,false);
const firstPosts=posts;await env.generateConversation();assert.equal(posts,firstPosts,'重复确认比较不重新调用准备和发现');
await env.selectDiscoveryRoute('via');assert.equal(generated.length,1);assert.equal(generated[0][2],'generate');assert.equal(generated[0][3],'via');assert.ok(env.guideMessages[0].text.includes('伊宁'));
await env.selectDiscoveryRoute('via-rail');assert.equal(generated[1][3],'via-rail','同路线不同交通组合可显式选择');
env.conversationBusy=true;await env.selectDiscoveryRoute('baseline');assert.equal(generated.length,2,'在途请求禁止重复生成');env.conversationBusy=false;
let resolveLookup;env.supplementChosenRoute=()=>new Promise(r=>{resolveLookup=r;});const selecting=env.selectDiscoveryRoute('via');assert.equal(generated.length,2,'补查完成前不先生成无资料稿');env.guideSequence++;resolveLookup({status:'complete'});await selecting;assert.equal(generated.length,2,'重开或恢复后旧补查不能启动生成');
env.supplementChosenRoute=async()=>({status:'failed'});await env.selectDiscoveryRoute('via');assert.equal(generated.length,3,'检索失败仍可生成诚实的探索草案');
console.log('✓ 发现不自动成稿、重复比较复用、用户选路后生成、交通组合与重复点击隔离通过');
const count=generated.length;await env.chooseAlternativeRoute({id:'via',legs:[{from:'北京',to:'伊宁'},{from:'伊宁',to:'阿拉木图'}]});assert.equal(generated.length,count+1);assert.equal(generated.at(-1)[2],'chat');assert.equal(generated.at(-1)[3],'via');
