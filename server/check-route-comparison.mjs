/* P0：比较保留基准、真实差异、硬条件与来源边界；十条固定任务，不访问外网或模型。 */
import assert from 'node:assert/strict';
import {buildRouteComparison} from './lib/route-comparison.mjs';
import {conversationTurn} from './lib/conversation.mjs';
import discovery from '../mixtouring-hifi/assets/discovery-workspace.js';
import {searchTransportSources} from './lib/transport-search.mjs';
const candidate=(id,route,mode='plane')=>({id,kind:route.length===2?'direct':'discovered',legs:route.slice(1).map((to,i)=>({from:route[i],to,mode_guess:i?'road':mode,evidence_state:'explore'}))});
const direct=candidate('direct',['北京','阿拉木图']),yining=candidate('yining',['北京','伊宁','阿拉木图']),urumqi=candidate('urumqi',['北京','乌鲁木齐','阿拉木图']);
const plan={candidates:[yining,urumqi,candidate('tacheng',['北京','塔城','阿拉木图']),direct],intent:{origin:'北京',destination:'阿拉木图'}};
const run=(preferences={},requirements={})=>buildRouteComparison(plan,{preferences,requirements});
const tasks=[
  ['允许巴士仍保留直达基准',()=>{const c=run({road:'open'});assert.equal(c.routes[0].id,'direct');assert.equal(c.recommended_id,'direct');assert.equal(c.routes.length,3);}],
  ['自然与沿途偏好有具体体验',()=>{const c=run({experience:'nature',pace:'explore'},{trip_days:10});assert.equal(c.recommended_id,'yining');assert.ok(c.routes.find(r=>r.id==='yining').benefits.some(b=>b.includes('六星街')));}],
  ['短行程基准优先但不删除备选',()=>{const c=run({pace:'explore'},{trip_days:7});assert.equal(c.recommended_id,'direct');assert.ok(c.routes.some(r=>r.id==='yining'));}],
  ['必经伊宁不被基准覆盖',()=>{const c=run({}, {required_stops:['伊宁']});assert.equal(c.routes[0].eligible,false);assert.equal(c.recommended_id,'yining');}],
  ['跨境核实要求不等于核实完成',()=>{const c=run({}, {verified_cross_border_only:true});assert.ok(c.routes.every(r=>!r.verified));assert.ok(c.routes.find(r=>r.id==='yining').critical.includes('尚不能证明'));}],
  ['缺少总价与交通时间不补数字',()=>{const c=run({}, {trip_days:10});assert.ok(c.routes.every(r=>r.cost.grade==='unpriced' && r.time.transport_minutes===null));assert.equal(c.routes.find(r=>r.id==='yining').time.suggested_stop_days,2);}],
  ['不同交通组合仍可选择',()=>{const p={...plan,candidates:[direct,candidate('rail',['北京','阿拉木图'],'rail'),yining]};assert.equal(buildRouteComparison(p).routes[0].variants.length,2);}],
  ['排除公路后不展示公路备选',()=>{const c=run({road:'exclude'});assert.ok(c.routes.every(r=>r.legs.every(l=>l.mode!=='road')));assert.equal(c.routes.length,1);}],
  ['未策展目的地不给虚构体验',()=>{const c=buildRouteComparison({candidates:[candidate('unknown',['上海','昆明']),candidate('via',['上海','长沙','昆明'])]});assert.equal(c.routes.length,1);assert.ok(c.notice.includes('暂未整理'));assert.equal(c.routes[0].sources.length,0);}],
  ['自定义地图只返回已知坐标',()=>{const c=buildRouteComparison(plan,{current_route:['北京','伊宁','阿拉木图','未知测试城']});assert.equal(c.current_map.points[1].lat,43.92);assert.equal(c.current_map.points[3].lat,null);assert.deepEqual(plan.candidates[0].legs,yining.legs);}]
];
for(const [name,test] of tasks){test();console.log('✓ '+name);}
const c=run({experience:'nature'}),rendered=discovery.cardsHtml(c);
assert.ok(rendered.includes('直达基准') && rendered.includes('时间与节奏') && rendered.includes('费用结构'));
assert.ok(!rendered.includes('已核实'));
const dirty=structuredClone(c);dirty.routes[0].title='<img src=x onerror=alert(1)>';assert.ok(!discovery.cardsHtml(dirty).includes('<img'));
const brief={origin:'北京',destination:'阿拉木图',summary:'独行，自然与本地文化',wishes:[],open_questions:[]};
const draft={title:'十天旅行探索',overview:'按已选择城市链分阶段安排',route:['北京','伊宁','阿拉木图'],cards:[{id:'start',label:'出发',place:'北京',title:'出发交通',content:'先核对所选交通与时间。'},{id:'stay',label:'沿途停留',place:'伊宁',title:'街巷与河谷',content:'预留街区体验与弹性时间。'}],pending:['交通班期待按日期核查']};
const input={action:'generate',requested_candidate_id:'yining',conversation:{stage:'ready',brief,routing:{origin:'北京',destination:'阿拉木图'},requirements:{trip_days:10},revision:0}};
const result=await conversationTurn(input,plan,{search:async()=>[],model:async opts=>{if(opts.kind==='conversation')assert.deepEqual(JSON.parse(opts.user).output_contract.selected_route,draft.route);return {intent_action:'revise',reply:'已生成。',brief,ready:true,confirmed:false,preferences:{},travel:{},constraints:{},draft};}});
assert.equal(result.status,'ok');assert.deepEqual(result.conversation.draft.route,draft.route);assert.equal(result.selected_candidate_id,'yining');assert.ok(result.reply.includes('你选的'));
const wrong=await conversationTurn(input,plan,{search:async()=>[],model:async()=>({reply:'已生成。',brief,ready:true,preferences:{},travel:{},constraints:{},draft:{...draft,route:['北京','乌鲁木齐','阿拉木图']}})});
assert.equal(wrong.status,'unavailable','生成不能悄悄替换已点选路线');
console.log('✓ 十条比较任务、来源边界、展示转义与点选后生成合同通过');
const unspecified={...plan,candidates:plan.candidates.map(c=>c.id==='yining'?{...c,legs:c.legs.map((l,i)=>({...l,mode_guess:i?l.mode_guess:'unknown'}))}:c)};
const withReturn={...draft,cards:[draft.cards[0],draft.cards[1],{id:'last',label:'第10天',place:'北京',title:'抵达北京',content:'结束行程，回到北京。'}]};
const guarded=await conversationTurn(input,unspecified,{search:async()=>[],model:async opts=>opts.kind==='conversation_scope'?{cards:[{id:JSON.parse(opts.user).affected[0].id,title:'目的地弹性安排',content:'在阿拉木图保留自由活动与休息时间。'}],reply:'已留出弹性。'}:{reply:'生成草案。',brief,ready:true,preferences:{},travel:{},constraints:{},draft:withReturn}});
assert.equal(guarded.status,'ok');assert.equal(guarded.conversation.draft.cards.at(-1).place,'阿拉木图');assert.ok(!guarded.conversation.draft.cards.some(c=>/抵达北京|回到北京/.test(c.title+c.content)));
assert.ok(!guarded.conversation.draft.cards.some(c=>/^第\d+天/.test(c.label)),'交通方式和日期未定时不暗示固定抵达日序');
console.log('✓ 未确认返程的抵达起点表述与未知交通分阶段安排回归通过');
const ready=await conversationTurn({text:'北京到阿拉木图，愿意坐巴士',action:'chat'},plan,{search:async()=>[],model:async()=>({reply:'直飞费用高，陆路更省钱。',brief,ready:true,preferences:{road:'open'},travel:{},constraints:{}})});
assert.equal(ready.status,'ok');assert.ok(ready.reply.includes('比较走法'));assert.ok(!/费用高|更省钱/.test(ready.reply),'进入比较时不输出无同口径价格支持的结论');
const now=Date.parse('2026-10-18T02:00:00Z');
const lead=await searchTransportSources({from:'伊宁',to:'阿拉木图',mode:'road'},async()=>[{title:'伊宁到阿拉木图国际客运班车',link:'https://example.gov.cn/route',content:'伊宁至阿拉木图国际客运班车恢复运行。',date:'2026-10-01'}],{now,readPage:null,useCache:false});
const evidence=buildRouteComparison(plan,{retrieval_ids:[lead.retrieval_id],constraints:{budget_max_cny:8000},now});
const leg=evidence.routes.find(r=>r.id==='yining').variants[0].connections[1];assert.equal(leg.status,'source_lead');assert.equal(leg.sources.length,1);assert.ok(leg.directions.every(d=>d.source.published_at!=='2026-10-18'),'采样日期不能代替旧参考的发布日期');
assert.ok(evidence.budget_notice.includes('不能据此判断已满足预算'));
assert.equal(evidence.routes[0].variants[0].connections[0].sources.length,0,'相同目的地的别段来源不能串入直达比较');
const stale=buildRouteComparison(plan,{retrieval_ids:[lead.retrieval_id],now:now+900000});assert.equal(stale.routes.find(r=>r.id==='yining').variants[0].connections[1].sources.length,0);
const otherWindow=buildRouteComparison(plan,{retrieval_ids:[lead.retrieval_id],travel:{outbound_window:'2026-11-01 ~ 2026-11-03'},now});assert.equal(otherWindow.routes.find(r=>r.id==='yining').variants[0].connections[1].sources.length,0);
const multi=buildRouteComparison({...plan,candidates:[direct,candidate('direct-rail',['北京','阿拉木图'],'rail'),yining]},{preferences:{preferred_mode:'rail'},now});assert.equal(multi.routes[0].id,'direct-rail');assert.equal(multi.routes[0].variants.length,2,'偏好只调整同链默认组合，其他组合仍可选');
const historical=discovery.connectionsHtml(evidence.routes.find(r=>r.id==='yining'));assert.ok(historical.includes('2024-02-21') && historical.includes('非当期班次'));
const stored=structuredClone(plan);stored.candidates.find(c=>c.id==='yining').legs[1].evidence_state='source_lead';stored.candidates.find(c=>c.id==='yining').legs[1].sources=[{title:'伊宁到阿拉木图国际客运班车',link:'https://example.gov.cn/discovery',connection_excerpt:'伊宁至阿拉木图国际客运班车恢复运行。',temporal:{published_at:'2026-10-01'}}];
assert.equal(buildRouteComparison(stored,{now}).routes.find(r=>r.id==='yining').variants[0].connections[1].sources.length,1,'发现阶段的逐段线索沿用同一比较依据');
stored.candidates.find(c=>c.id==='yining').legs[1].sources[0].temporal.published_at='2023-01-01';assert.equal(buildRouteComparison(stored,{now}).routes.find(r=>r.id==='yining').variants[0].connections[1].sources.length,0,'旧发现线索重评时效，不作近期事实');
console.log('✓ P1 比较理由、预算边界、逐段同源、交通组合、旧参考及检索过期隔离通过');
const row=multi.routes[0],prior={[row.id]:{variant:'direct',open:true}},restoredCards=discovery.cardsHtml(multi,null,prior);
assert.ok(restoredCards.includes('value="direct" selected'));
assert.ok(restoredCards.includes('class="discovery-evidence" open'),'资料刷新保留用户展开和交通组合选择');
const hard=run({}, {verified_cross_border_only:true}).routes.find(r=>r.id==='yining');assert.equal(discovery.criticalText(hard,hard.variants[0].id),hard.critical,'换组合不能隐藏跨境核实硬要求');
const changedVariant=structuredClone(row);changedVariant.variants[1].connections[0].summary='本组合连接资料待补充';assert.ok(discovery.criticalText(changedVariant,changedVariant.variants[1].id).includes('本组合连接资料待补充'),'交通组合切换后关键缺口与来源同步');
