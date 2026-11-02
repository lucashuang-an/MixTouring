/* 原文锚点由代码登记；模型选择编号，不能拿来源原句替换被核对文本。 */
export function evidenceSpans(field){
 const values=[];
 const add=(text,kind)=>{if(text && !values.some(v=>v.text===text))values.push({id:field.id+'@'+values.length,text,kind});};
 for(const m of field.text.matchAll(/`([^`\n]+)`/g))add(m[1],'place');
 for(const m of field.text.matchAll(/[^，,；;。！？!?\n]+/g)){
  const text=m[0].replace(/^\s*[-*•]\s*/,'').replace(/^(?:清晨|早上|上午|中午|下午|傍晚|晚上|全天|途中|抵达后)[：:]\s*/,'').trim();
  add(text,'clause');
 }
 add(field.text,'sentence');
 return values;
}
const pureUncertainty=text=>/^(?:仍|尚|还)?(?:需|需要|待|有待)(?:再|进一步|另行)?(?:核实|确认|查证|核对)[。；;！!]*$/.test(String(text || '').replace(/^\s*[-*•]\s*/, '').trim());
export function resolveEvidenceAtoms(item,field){
 if(item?.needs_source===false&&(Array.isArray(item.assertions)&&item.assertions.length||Array.isArray(item.supports)&&item.supports.length||['supported','refuted','missing','conflicting'].includes(item.evidence_relation)))item={...item,needs_source:true};
 if(!Array.isArray(item?.assertions))return item;
 const spans=evidenceSpans(field);
 const resolved=item.assertions.map(atom=>{
  if(!atom || typeof atom!=='object')return atom;
  if(atom.span_id!==undefined){const span=spans.find(s=>s.id===atom.span_id);return {...atom,text:span?.text || ''};}
  // 旧合同只容忍显示反引号差异，不做语义、简繁、同义词或否定词改写。
  if(typeof atom.text==='string' && atom.text && !field.text.includes(atom.text)){
   let plain='',positions=[];for(let i=0;i<field.text.length;i++)if(field.text[i]!=='`'){plain+=field.text[i];positions.push(i);}
   const at=plain.indexOf(atom.text);
   if(at>=0 && plain.indexOf(atom.text,at+1)<0)return {...atom,text:field.text.slice(positions[at],positions[at+atom.text.length-1]+1)};
  }
  return atom;
 });
 const assertions=resolved.filter(atom=>{const span=spans.find(s=>s.id===atom?.span_id||s.text===atom?.text);return !(span?.kind==='clause'&&pureUncertainty(span.text));});
 return {...item,needs_source:resolved.length&&!assertions.length&&pureUncertainty(field.text)?false:item.needs_source,assertions};
}
export function planningEvidenceUse(claim,catalog){
 if(catalog?.delivery_context!=='suggested_itinerary' || claim.allowed_use!=='source_reference' || !claim.supports?.length)return claim;
 const sources=claim.supports.map(s=>catalog.entries?.find(e=>e.id===s.source_id));
 // 降为经验用途，不赋予运营资格；prepare仍拒绝经验支持运营与未注明归因的事实问答。
 return sources.some(s=>s && (s.kind==='experience' || /^travel_experience/.test(s.allowed_use)))?{...claim,allowed_use:'travel_experience'}:claim;
}
export function isKnownRoutePlan(text,conditions={}){
 const route=conditions.route || [],current=conditions.current || {},routing=current.routing || conditions.routing || {};
 const names=[routing.origin,routing.destination,route[0],route.at(-1),...(current.requirements?.required_stops || [])].filter(s=>typeof s==='string'&&s);
 if(!names.length)return false;
 const city='(?:'+[...new Set(names)].sort((a,b)=>b.length-a.length).map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')';
 const value=String(text).replace(/`/g,'').replace(/^\s*[-*•]\s*/,'').replace(/^(?:上午|下午|晚上|全天|傍晚|中午)[：:]\s*/,'').replace(/[。；;！!]$/,'').trim();
 // 只匹配无运营承诺、班次、距离、时刻或费用的路线安排；不是交通连接证据。
 return new RegExp('^(?:'+city+'(?:出发)?|(?:前往|抵达|返回|飞往|飞回)'+city+'|(?:从)?'+city+'(?:出发)?(?:前往|抵达|返回|飞往|飞回|飞)'+city+'|去程经'+city+'陆路跨境|回程从'+city+'飞'+city+'|搭乘'+city+'飞'+city+'的航班返程)$').test(value);
}
