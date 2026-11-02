import assert from 'node:assert/strict';
import {googlePlace,resolveGoogleCities,resolveGoogleDay,googleStaticMap} from './lib/google-maps.mjs';
import ui from '../mixtouring-hifi/assets/day-map-ui.js';
import discovery from '../mixtouring-hifi/assets/discovery-workspace.js';
const place=(id,name,country='KR',latitude=33.4,longitude=126.5)=>({id,displayName:{text:name},location:{latitude,longitude},addressComponents:[{types:['country'],shortText:country}]});
const opts={apiKey:'fixture-key',proxy:'',fetchImpl:async(url,o)=>{assert.equal(url,'https://places.googleapis.com/v1/places:searchText');assert.equal(o.headers['X-Goog-Api-Key'],'fixture-key');assert.ok(!url.includes('fixture-key'));assert.ok(!o.headers['X-Goog-FieldMask'].includes('*'));return {ok:true,json:async()=>({places:[place('id1','测试市场')]})};}};
const p=await googlePlace('测试市场',{...opts,country:'KR'});assert.equal(p.provider_id,'id1');assert.equal(p.provider,'Google Maps');
const ambiguous=await googlePlace('市场',{...opts,fetchImpl:async()=>({ok:true,json:async()=>({places:[place('a','甲市场'),place('b','乙市场')]})})});assert.equal(ambiguous.reason,'ambiguous');
const wrong=await googlePlace('测试市场',{...opts,country:'JP'});assert.equal(wrong.lat,null);
const far=await googlePlace('测试市场',{...opts,center:{lat:0,lon:0}});assert.equal(far.lat,null);
const denied=await googlePlace('测试市场',{...opts,fetchImpl:async()=>({ok:false,status:403})});assert.equal(denied.reason,'http_403');
let calls=0;const d=await resolveGoogleDay({city:'测试岛',city_hint:{name_latin:'Test Island',country_hint:'KR'},places:['市场']},{...opts,resolveNames:async()=>[{name:'市场',aliases:['Test Market'],lat:99}],fetchImpl:async(url,o)=>{calls++;const q=JSON.parse(o.body);return {ok:true,json:async()=>({places:q.textQuery.includes('Test Island KR')?[place('island','Test Island')]:q.languageCode==='en'?[place('market','Test Market')]:[place('a','甲市场'),place('b','乙市场')]})};}});
assert.equal(calls,3);assert.equal(d.status,'complete');assert.equal(d.cacheable,false);assert.equal(d.points[0].lat,33.4,'坐标只来自Google，不取名称模型坐标');
const saved=ui.snapshot(d);assert.equal(saved.points[0].provider_id,'market');assert.equal(saved.points[0].lat,null);assert.equal(saved.points[0].matched_name,undefined);assert.equal(saved.points[0].attributions,undefined);
const host={innerHTML:''};discovery.renderMap(host,{point_kind:'poi',routes:[{id:'day',points:d.points}]},'day',()=>{});assert.match(host.innerHTML,/Google Maps/);assert.match(host.innerHTML,/query_place_id=market/);assert.doesNotMatch(host.innerHTML,/tile.openstreetmap/);
console.log('✓ Google Maps：密钥边界、真实坐标、国家／范围／歧义、名称提示、独立展示与仅Place ID持久化');

let imageCalls=0;const imageResult=await googleStaticMap(['id1'],{apiKey:'fixture-secret',proxy:'',fetchImpl:async u=>{imageCalls++;assert.equal(u.origin,'https://maps.googleapis.com');assert.equal(u.searchParams.get('key'),'fixture-secret');assert.equal(u.searchParams.get('markers'),'label:A|place_id:id1');return {ok:true,headers:new Headers({'content-type':'image/png'}),arrayBuffer:async()=>new Uint8Array([137,80,78,71]).buffer};}});
assert.equal(imageResult.status,200);assert.equal(imageCalls,1);assert.ok(!JSON.stringify(imageResult).includes('fixture-secret'));
assert.equal((await googleStaticMap(['bad|key=evil'],{apiKey:'x',fetchImpl:async()=>{throw Error('不应调用');}})).status,400);
assert.match(host.innerHTML,/google-map-image/);assert.doesNotMatch(host.innerHTML,/fixture-secret|key=/);
let memoCalls=0;
const memoOptions={...opts,requestCache:{cities:new Map(),places:new Map(),aliasAttempts:new Set()},fetchImpl:async(...args)=>{memoCalls++;return opts.fetchImpl(...args);}};
await Promise.all([resolveGoogleDay({city:'测试岛',places:['甲']},memoOptions),resolveGoogleDay({city:'测试岛',places:['甲','乙']},memoOptions)]);
assert.equal(memoCalls,3,'同一规划请求并发复用城市与重复地点，避免逐日重复定位');
await resolveGoogleDay({city:'测试岛',places:['甲']},{...memoOptions,requestCache:{cities:new Map(),places:new Map(),aliasAttempts:new Set()}});
assert.equal(memoCalls,5,'新请求重新获取地点，不持久缓存Google内容');

const cityHost={innerHTML:''};discovery.renderMap(cityHost,{routes:[{id:'cities',points:d.points}]},'cities',()=>{});assert.match(cityHost.innerHTML,/google-map-image/);assert.doesNotMatch(cityHost.innerHTML,/<ul>|maps\/search/,'城市路线地图不再重复列出外链，地点详情地图仍保留地点入口');
