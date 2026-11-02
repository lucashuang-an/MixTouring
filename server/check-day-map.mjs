import assert from 'node:assert/strict';
import {matchDayPlaces,resolveDayMap} from './lib/day-map.mjs';
import {activityContentGaps} from './lib/material-coverage.mjs';
import workspace from '../mixtouring-hifi/assets/route-workspace.js';
import save from '../mixtouring-hifi/assets/save-state.js';
import {conversationTurn} from './fixtures/confirmed-conversation.mjs';
const center={name:'测试城',lat:43,lon:81};
const element=(id,lat=43.01,lon=81.01)=>({type:'node',id,lat,lon,tags:{name:'测试公园'}});
assert.equal(matchDayPlaces(['测试公园'],[element(1)],center)[0].provider_id,'node/1');
assert.equal(matchDayPlaces(['测试公园'],[element(1),element(2,43.2)],center)[0].lat,null,'不同位置同名不猜测');
assert.equal(matchDayPlaces(['测试公园'],[element(1),element(2,43.0101)],center)[0].lat,43.01,'同位置轮廓节点可合并');
assert.equal(matchDayPlaces(['测试公园'],[element(1,10,10)],center)[0].lat,null,'排除城市范围之外');
let calls=0;
const result=await resolveDayMap({city:'测试城',places:[{name:'测试公园',lat:99,lon:99}],city_hint:{name_latin:'Test',lat:0,lon:0}},{
  usePhoton:false,
  resolveCity:async(names,hints)=>{assert.equal(hints[0].lat,undefined);return {points:[center]};},
  fetchImpl:async(url,opts)=>{calls++;assert.equal(url,'https://overpass.private.coffee/api/interpreter');assert.ok(new URLSearchParams(opts.body).get('data').includes('around:250000,43,81'));return {ok:true,json:async()=>({elements:[element(1)]})};}
});
assert.equal(result.status,'complete');assert.equal(result.points[0].lat,43.01);assert.equal(calls,1);
const photon=await resolveDayMap({city:'光子城',places:['新公园']},{resolveCity:async()=>({points:[{...center,name:'光子城',country:'KZ'}]}),
  resolveNames:async()=>[{name:'新公园',aliases:['English Park'],lat:90,lon:0}],
  fetchImpl:async(url)=>{assert.ok(url.startsWith('https://photon.komoot.io/'));return {ok:true,json:async()=>({features:[{geometry:{coordinates:[81.01,43.01]},properties:{osm_type:'W',osm_id:7,name:'English Park',countrycode:'kz'}}]})};}});
assert.equal(photon.points[0].lat,43.01);assert.equal(photon.points[0].matched_name,'English Park');assert.equal(photon.points[0].provider_id,'way/7');
const cards=[{id:'card-day-1',place:'测试城',label:'第1天',title:'城区探索',content:'上午散步，下午自由活动。'},{id:'card-day-2',place:'测试城',label:'第2天',title:'出发与交通',content:'出发前往目的地。'}];
const draft=workspace.cleanDraft({route:['起点','测试城'],cards,sections:[]});
assert.deepEqual(activityContentGaps(draft).map(g=>g.card_id),['card-day-1']);
assert.equal(activityContentGaps(workspace.cleanDraft({...draft,cards:[{...cards[0],title:'阿拉木图飞回北京'}]})).length,0,'返程日不补景点');
const marked=workspace.cleanDraft({...draft,cards:[{...cards[0],content:'- 上午：`测试公园`——在园内慢慢散步，看街区的日常生活。把主要时间留给步行和休息，下午按兴趣选择继续游览。'}]});
assert.equal(activityContentGaps(marked).length,0);assert.ok(workspace.cardHtml(marked.cards[0]).includes('data-day-map="card-day-1"'));
assert.equal(save.key({conversation:{draft:marked}}),save.key({conversation:{draft:marked},day_maps:{x:result}}),'地图元数据不改变保存状态');
const brief={origin:'起点',destination:'测试城',summary:'体验当地街区',wishes:[],open_questions:[]},events=[],queries=[];
let fills=0;
const baseDraft={title:'两天行程',overview:'当地体验',route:['起点','测试城'],cards:[cards[0],{...cards[1],title:'休整'}],sections:[],pending:[]};
const generated=await conversationTurn({action:'generate',conversation:{stage:'ready',brief,routing:{origin:'起点',destination:'测试城'},requirements:{trip_days:2}}},null,{
  now:Date.parse('2026-10-28'),activityResearch:true,onTrace:e=>events.push(e),
  search:async q=>{queries.push(q);return q.includes('具体景点')?[{title:'测试城公园',link:'https://example.org/park',content:'测试城的测试公园可散步。',date:'2026-10-20'}]:[];},
  model:async opts=>{const p=JSON.parse(opts.user);
    if(opts.kind==='conversation_source_relevance')return {items:p.candidates.map(s=>({id:s.id,decision:'keep',quote:s.title,reason:'当地体验'}))};
    if(opts.kind==='conversation_activity_fill'){fills++;return {card:{id:p.card.id,title:'公园与街区',content:marked.cards[0].content}};}
    return {intent_action:'revise',reply:'已整理。',ready:true,brief,draft:baseDraft,preferences:{},travel:{},constraints:{},requirements_patch:{},sights:{}};
  }
});
assert.equal(generated.status,'ok');assert.equal(fills,1);assert.ok(events.some(e=>e.stage==='activity_gap' && e.status==='prepared'));
assert.equal(generated.conversation.draft.cards[1].content,baseDraft.cards[1].content);assert.equal(generated.conversation.draft.cards[0].place,'测试城');assert.ok(queries.length<=4);
console.log('✓ 日地图真实坐标来源、同名消歧、范围限制、城市重查、活动缺口与保存状态');
