// 确认方案的segments记录实际停留；只作出发交通的城市无需采集游玩素材。
export function itineraryMaterialCities(outline,requiredStops,destination){
  const stays=(outline?.segments || []).map(s=>s.place);
  return [...new Set([...stays,...requiredStops,destination].filter(Boolean))];
}
/* 城市资料覆盖只是补查信号，不授予班次或地点事实的核实资格。 */
export function materialCoverage(collection,cities=[]){
  const pool=[...(collection.sources || []),...(collection.experiences || []),...(collection.archive || [])]
    .filter(s=>!s.relevance || s.relevance.decision==='keep');
  return [...new Set(cities.filter(c=>typeof c==='string' && c))].map(city=>{
    const matches=pool.filter(s=>(s.title+'\n'+s.excerpt).includes(city));
    return {city,source_ids:[...new Set(matches.map(s=>s.url || s.link))],status:matches.length?'covered':'gap'};
  });
}
export function mergeMaterialCollections(base,extra){
  const unique=rows=>rows.filter((s,i,a)=>a.findIndex(x=>(x.url || x.link)===(s.url || s.link))===i);
  return {...base,sources:unique(base.sources.concat(extra.sources)),archive:unique(base.archive.concat(extra.archive)),
    experiences:unique(base.experiences.concat(extra.experiences)),results:unique(base.results.concat(extra.results)),
    channels:base.channels.concat(extra.channels),source_audit:(base.source_audit || []).concat(extra.source_audit || []),
    reader:{attempted:base.reader.attempted+extra.reader.attempted,available:base.reader.available+extra.reader.available},
    status:base.status==='available' && extra.status==='available'?'available':'partial',
    relevance:{...base.relevance,status:base.relevance?.status==='completed' && extra.relevance?.status==='completed'?'completed':'partial'}};
}
export function activityContentGaps(draft){
  return (draft?.cards || []).flatMap(card=>{
    const title=card.title || '';
    if(/出发|返程|回程|跨境|抵达|交通|飞回|返回|回到|飞往|离开/.test(title))return [];
    if(/休整|缓冲|自由活动/.test(title) && !/公园|街区|博物馆|湖|峡谷|老城|市场|巴扎|文化|地标/.test(title))return [];
    const activities=card.activities || [],named=activities.flatMap(a=>a.places || []).filter(p=>p.name!==card.place);
    const length=activities.map(a=>a.text).join('').replace(/\s|`/g,'').length;
    return !named.length || length<45?[{card_id:card.id,city:card.place,label:card.label,title:card.title,reason:!named.length?'missing_named_place':'thin_activity'}]:[];
  });
}
