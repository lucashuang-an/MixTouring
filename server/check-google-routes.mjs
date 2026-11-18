import assert from 'node:assert/strict';
import {googleRoute,planDayTravel} from './lib/google-routes.mjs';
import ui from '../mixtouring-hifi/assets/day-map-ui.js';
const a={name:'甲',provider_id:'idA'},b={name:'乙',provider_id:'idB'},c={name:'丙',provider_id:'idC'},now=Date.parse('2026-10-30T00:00:00Z');
const request={apiKey:'fixture-secret',proxy:'',now,fetchImpl:async(url,o)=>{assert.equal(url,'https://routes.googleapis.com/directions/v2:computeRoutes');assert.equal(o.headers['X-Goog-Api-Key'],'fixture-secret');assert.ok(!o.headers['X-Goog-FieldMask'].includes('*'));return {ok:true,json:async()=>({routes:[{distanceMeters:28827,duration:'12047s'}]})};}};
const route=await googleRoute(a,b,{...request,departureTime:'2026-10-31T00:00:00Z'});assert.equal(route.status,'available');assert.equal(route.duration_s,12047);assert.equal(route.time_basis,'reference_departure');assert.ok(!JSON.stringify(route).includes('fixture-secret'));
assert.equal((await googleRoute(a,b,{...request,mode:'FLY'})).status,'invalid');
assert.equal((await googleRoute(a,b,{...request,departureTime:'2028-01-01T00:00:00Z'})).status,'unsupported');
assert.equal((await googleRoute(a,b,{...request,fetchImpl:async()=>({ok:true,json:async()=>({routes:[]})})})).status,'no_route');
assert.equal((await googleRoute(a,b,{...request,fetchImpl:async()=>({ok:true,json:async()=>({routes:[{distanceMeters:12,duration:'unknown'}]})})})).status,'unavailable');
assert.equal((await googleRoute(a,b,{...request,fetchImpl:async()=>({ok:false,status:403})})).reason,'http_403');
let driveBody;await googleRoute(a,b,{...request,mode:'DRIVE',departureTime:'invalid',fetchImpl:async(u,o)=>{driveBody=JSON.parse(o.body);return {ok:true,json:async()=>({routes:[{distanceMeters:1000,duration:'60s'}]})};}});assert.equal(driveBody.travelMode,'DRIVE');assert.equal(driveBody.routingPreference,'TRAFFIC_UNAWARE');assert.equal(driveBody.departureTime,undefined);
const trip=await planDayTravel({points:[a,b],sequence:['甲','乙','甲'],mode:'TRANSIT'},request);assert.deepEqual(trip.legs.map(l=>[l.from,l.to]),[['甲','乙'],['乙','甲']]);assert.equal(trip.summary.duration_s,24094);assert.equal(trip.summary.basis,'independent_segments_same_reference_time');
const partial=await planDayTravel({points:[a,{name:'乙'},c],sequence:['甲','乙','丙']},request);assert.equal(partial.legs.length,2);assert.equal(partial.summary,null,'缺中间点不能跳过它伪造甲到丙，也不能显示零耗时');assert.equal(partial.coverage.missing,2);
assert.equal((await planDayTravel({points:[a],sequence:['甲']})).status,'not_applicable');
assert.deepEqual(ui.routeSequence({activities:[{places:[{name:'甲'}]},{places:[{name:'乙'}]},{places:[{name:'甲'}]}]}),['甲','乙','甲']);
const html=ui.transportHtml(trip);assert.match(html,/28.8公里/);assert.match(html,/3小时21分钟/);assert.match(html,/各段独立查询/);assert.match(html,/超过90分钟/);
assert.doesNotMatch(ui.transportHtml(partial),/0分钟|0公里/);
const saved=ui.snapshot({provider:'Google Maps',points:[{...a,lat:1,lon:2}],transport:trip});assert.equal(saved.transport,undefined,'路线结果与时长不写入持久快照');
console.log('✓ 地点交通参考：真实数值、方向／重复访问、方式隔离、时间窗、部分失败、不伪造零值、参考口径及存储边界');

assert.equal((await googleRoute(a,b,{...request,departureTime:'2026-02-31T09:00:00Z'})).status,'invalid');
const walkOnly=await googleRoute(a,b,{...request,fetchImpl:async()=>({ok:true,json:async()=>({routes:[{distanceMeters:1000,duration:'600s',legs:[{steps:[{travelMode:'WALK'}]}]}]})})});assert.equal(walkOnly.walking_only,true);assert.match(ui.transportHtml({legs:[walkOnly]}),/公交查询返回步行方案/);

const unknown=await planDayTravel({points:[a,c],sequence:['甲','未知地点','丙']},request);assert.equal(unknown.legs.length,2);assert.equal(unknown.coverage.available,0);
const longSequence=await planDayTravel({points:[a,b],sequence:Array.from({length:14},(_,i)=>i%2?'乙':'甲')},request);assert.equal(longSequence.status,'partial');assert.equal(longSequence.coverage.omitted_stops,2);assert.equal(longSequence.summary.complete,false);

const mixed=await planDayTravel({points:[a,b,{name:'丙'}],sequence:['甲','乙','丙']},request);assert.equal(mixed.summary.complete,false);assert.match(ui.transportHtml(mixed),/另有1段未计入/);assert.match(ui.transportHtml(mixed),/已查到的路段合计/);
assert.equal(trip.legs[0].departure_time,trip.legs[1].departure_time,'独立路段使用同一参考时刻');
