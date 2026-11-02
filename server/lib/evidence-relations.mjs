/* 缺失信息只能说明尚无依据，不能支持或反驳现实命题。混合句交语义核对。 */
const parts=text=>String(text || '').split(/[。！？!?；;\n]|但是|然而|不过|可是|但|\bbut\b|[,，]/i).map(s=>s.trim()).filter(Boolean);
const sourceSubject=/本文|本页|文中|网页|页面|文章|来源|资料|摘录|检索结果|\b(?:article|page|source|document|excerpt|search results?)\b/i;
const missing=/未(?:曾)?(?:说明|记载|写明|提及|列出|标注|披露|找到|查到)|没有(?:说明|记载|写明|提及|列出|标注|披露|找到|查到)|(?:未(?:曾)?|没有)(?:提供|给出).{0,40}(?:信息|资料|数据|说明|详情|依据|开放时间|开放时刻|营业时间|票价|价格|时刻表|班期|预约要求|预约方式|开放状态)\.?\s*$|缺少.{0,16}(?:信息|资料|依据|说明)|\b(?:does not|doesn't|do not|did not|has not|have not|not)\s+(?:state|mention|specify|list|disclose)\b|\b(?:does not|doesn't|do not|did not|has not|have not|not)\s+provide\b.{0,50}\b(?:information|details|data|evidence|hours|times|prices|fares|schedules)\.?\s*$|\b(?:no|missing)\s+(?:information|details|data|evidence)\b/i;

export function absenceOnlyEvidence(quote,entry={}){
 const excerpt=String(entry.excerpt || ''),sentences=excerpt.split(/(?<=[。！？!?；;\n])/).map(s=>s.trim()).filter(s=>s&&(s.includes(quote)||quote.includes(s)));
 const contexts=sentences.length?sentences:[quote];
 return contexts.length>0&&contexts.every(context=>!/[?？]|吗[。！!]?$/i.test(context)&&!/^(?:是否|请问|能否|有没有|does\b|is\b|can\b)/i.test(context)&&sourceSubject.test(context)&&parts(context).every(part=>missing.test(part)));
}
export function normalizeSupportDecision(row,{conflict=false,allowConflict=false}={}){
 const relation=row?.relation,decision=row?.decision;
 if(!['supports','refutes','missing','conflicting','uncertain'].includes(relation)||!['supported','unsupported','uncertain'].includes(decision))return {decision:'uncertain',relation:'uncertain',reason:'分句缺少有效的支持关系分类'};
 if(relation==='missing')return {decision:'uncertain',relation,reason:row.reason || '来源没有提供该判断所需信息'};
 if(relation==='refutes')return {decision:'unsupported',relation,reason:row.reason || '来源明确反驳当前判断'};
 if(relation==='uncertain')return {decision:'uncertain',relation,reason:row.reason || '支持关系尚不明确'};
 if(relation==='conflicting'&&!conflict&&!allowConflict||conflict&&relation!=='conflicting')return {decision:'uncertain',relation,reason:'冲突关系与当前陈述用途不一致'};
 return {decision,relation,reason:row.reason};
}
