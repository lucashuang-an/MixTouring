/* 路线比较读取已有候选，不创造连接、班次或报价；体验、规划预算与运营事实分别表达。 */
import {readFileSync} from 'node:fs';
import {resolvePlace} from './anywhere.mjs';
const catalog=JSON.parse(readFileSync(new URL('../../pipeline/data/route-experiences.json',import.meta.url),'utf8'));
const names=c=>c.legs?.length?[c.legs[0].from,...c.legs.map(l=>l.to)]:[];
const modes={plane:'航空方向',rail:'铁路方向',road:'公路客运方向',unknown:'交通方式待查'};
export function buildRouteComparison(plan,{preferences={},requirements={},current_route=[]}={}){
  preferences=preferences || {};requirements=requirements || {};
  const place=name=>resolvePlace(name) || [plan?.intent?.origin_place,plan?.intent?.destination_place].find(p=>p?.name===name);
  const days=Number.isInteger(requirements.trip_days)?requirements.trip_days:null;
  const required=Array.isArray(requirements.required_stops)?requirements.required_stops.filter(s=>typeof s==='string'):[];
  const seen=new Set();
  const allCandidates=(plan?.candidates || []).filter(c=>c.legs?.length && !(preferences.road==='exclude' && c.legs.some(l=>l.mode_guess==='road')));
  const candidates=allCandidates.filter(c=>{
    const key=JSON.stringify(names(c));if(seen.has(key))return false;seen.add(key);return true;
  });
  const rows=candidates.map(c=>{
    const route=names(c),via=route.slice(1,-1),baseline=via.length===0;
    const profiles=via.map(name=>({name,...catalog.places[name]})).filter(p=>p.source);
    const missing=required.filter(name=>!route.includes(name));
    const cross=c.legs.some(l=>{const a=resolvePlace(l.from),b=resolvePlace(l.to);return a?.country && b?.country && a.country!==b.country;});
    const stopDays=via.length?(days && days>=9?2:1):0;
    const eligible=missing.length===0;
    const sources=profiles.map(p=>({...p.source,kind:'place_background'}));
    const dest=catalog.places[route.at(-1)];
    if(baseline && dest)sources.push({...dest.source,kind:'place_background'});
    const benefits=baseline?(dest?.benefits || ['将停留预算集中在目的地','减少沿途换乘与住宿安排']):profiles.flatMap(p=>p.benefits).slice(0,2);
    const reason=missing.length?'不包含你确认的必经城市：'+missing.join('、'):baseline?'先从换乘环节较少的基准比较，把停留集中在目的地。':profiles.length?'适合愿意用沿途停留换取'+profiles.map(p=>p.name+'的本地体验').join('、')+'的人。':'你指定的沿途城市已保留，具体体验与交通还需补充资料。';
    return {id:c.id,route,baseline,eligible,missing_stops:missing,
      variants:allCandidates.filter(x=>JSON.stringify(names(x))===JSON.stringify(route)).map(x=>({id:x.id,label:x.legs.map(l=>modes[l.mode_guess] || modes.unknown).join(' + ')})),
      title:baseline?'直接抵达，留时间给目的地':profiles[0]?.headline || '经'+via.join('、')+'停留',
      benefits:benefits.length?benefits:['保留你想去的沿途城市'],reason,
      tradeoff:baseline?'放弃沿途城市停留；本次交通可用性仍需查询。':'增加'+via.length+'处沿途停留；要协调跨城交通、住宿与站点接驳。',
      time:{transport_minutes:null,label:baseline?'交通占用按所选班次确认':'建议给'+via.join('、')+'预留'+stopDays+'天停留',suggested_stop_days:stopDays,basis:'可调整的规划预算，未计入未知交通耗时'},
      cost:{grade:'unpriced',label:baseline?'基础交通与目的地停留支出':'增加沿途住宿与接驳支出',basis:'结构判断；全程交通价格未比较，不代表更贵或更便宜'},
      effort:{intermediate_stops:via.length,transport_legs:c.legs.length,label:baseline?'减少沿途衔接':c.legs.length+'段跨城交通'},
      critical:requirements.verified_cross_border_only && cross?'你的要求是跨境交通须核实；当前候选尚不能证明本次班次已核实。':cross?'选定后优先补查跨境段的班期、乘车点和口岸衔接。':'选定后按出行日期核对交通班次与接驳。',
      verified:false,sources,legs:c.legs.map(l=>({from:l.from,to:l.to,mode:l.mode_guess || 'unknown',label:modes[l.mode_guess] || modes.unknown,evidence_state:l.evidence_state || 'explore'})),
      points:route.map(name=>{const p=place(name);return {name,lat:p?.lat ?? null,lon:p?.lon ?? null};}),
      _score:(eligible?100:0)+(baseline?0:profiles.length*4)+(preferences.experience==='nature' && profiles.some(p=>p.themes.includes('nature'))?4:0)+(preferences.pace==='explore' && !baseline?5:0)-(days && days<=7 && !baseline?5:0),
      _profiled:profiles.length>0};
  });
  const baseline=rows.find(r=>r.baseline);
  const alternatives=rows.filter(r=>!r.baseline && (r._profiled || required.some(s=>r.route.includes(s)))).sort((a,b)=>b._score-a._score).slice(0,2);
  const visible=[...(baseline?[baseline]:[]),...alternatives];
  const recommend=visible.filter(r=>r.eligible).sort((a,b)=>{
    if(preferences.pace==='simple' || days && days<=7)return Number(b.baseline)-Number(a.baseline) || b._score-a._score;
    if(preferences.pace!=='explore' && preferences.experience!=='nature')return Number(b.baseline)-Number(a.baseline) || b._score-a._score;
    return b._score-a._score;
  })[0];
  const currentNames=Array.isArray(current_route)?current_route.filter(n=>typeof n==='string' && n.length<=80).slice(0,12):[];
  const currentMap={id:'current',points:currentNames.map(name=>{const p=place(name);return {name,lat:p?.lat ?? null,lon:p?.lon ?? null};})};
  return {recommended_id:recommend?.id || null,trip_days:days,current_map:currentMap,notice:visible.length===1?'先从基准走法比较；暂未整理到有足够体验依据的沿途备选。':'以下比较体验与安排结构，交通时间和费用以具体查询为准。',
    routes:visible.map(({_score,_profiled,...r})=>({...r,recommended:r.id===recommend?.id})),
    background_boundary:catalog.usage};
}
