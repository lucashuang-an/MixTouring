/* 从当前文本的明确交通句法取两端，不维护地点名单，也不把抽取当作地理核验。 */
export function transportEndpoints(text){
  const clause=String(text || '').replace(/^(?:(?:据|根据)?(?:来源|资料|报道)(?:显示|记载|称)?|当前|目前|现时)[：:\s]*/,'');
  const match=clause.match(/^([\p{L}][\p{L}\s.'’-]{0,79}?)\s*(?:到|至|→|⇄|—|–|\bto\b)\s*([\p{L}][\p{L}\s.'’-]{0,79}?)(?:的)?\s*(?=飞机|航班|机票|航空|火车|铁路|列车|高铁|班车|大巴|巴士|客运|flight|airline|train|rail|bus|coach)/iu);
  if(!match || match[0].includes('⇄'))return [];
  const names=[match[1].trim(),match[2].replace(/的$/,'').trim()];
  if(names[0]===names[1])return [];
  return names.map(name=>({name,start:clause.indexOf(name),end:clause.indexOf(name)+name.length}));
}
