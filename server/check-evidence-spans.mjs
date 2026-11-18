import {deduplicateSentences} from './lib/evidence-spans.mjs';
import assert from 'node:assert/strict';
import {evidenceSpans,resolveEvidenceAtoms,planningEvidenceUse,isKnownRoutePlan} from './lib/evidence-spans.mjs';
import {groundConversationOutput,groundScopedConversationOutput} from './lib/conversation-evidence.mjs';
import {buildEvidenceCatalog} from './lib/evidence-grounding.mjs';
const field={id:'day#0',text:'- 上午：`石湖`——沿湖散步，不保证当天开放。'};
const planConditions={route:['北京','伊宁','阿拉木图'],current:{requirements:{required_stops:['伊宁']}}};
for(const text of ['北京出发','飞往伊宁','从北京出发前往伊宁','回程从阿拉木图飞北京'])assert(isKnownRoutePlan(text,planConditions));
for(const text of ['北京开通直飞伊宁','从北京直飞伊宁','从北京飞往伊宁每天都有航班','不从北京飞伊宁','从北京飞往未知城'])assert(!isKnownRoutePlan(text,planConditions));
const spans=evidenceSpans(field);assert(spans.every(s=>field.text.includes(s.text)));
const selected=resolveEvidenceAtoms({assertions:[{span_id:spans.find(s=>s.kind==='place').id,text:'恶意覆盖',supports:[]}]},field);
assert.equal(selected.assertions[0].text,'石湖');
assert.equal(resolveEvidenceAtoms({assertions:[{span_id:'other@0',supports:[]}]},field).assertions[0].text,'');
assert.equal(resolveEvidenceAtoms({assertions:[{text:'石湖——沿湖散步'}]},field).assertions[0].text,'石湖`——沿湖散步');
assert.equal(resolveEvidenceAtoms({assertions:[{text:'保证当天开放'}]},field).assertions[0].text,'保证当天开放','已经是连续原文的片段不靠格式归一化改变语义，完整运营另行整句守门');
assert.equal(resolveEvidenceAtoms({assertions:[{text:'石湖一定每天开放'}]},field).assertions[0].text,'石湖一定每天开放','同义改写不被格式对齐伪装成原文');
const catalog=buildEvidenceCatalog({sources:[{url:'https://example.org/trip',title:'甲城游记',excerpt:'我们在甲城游览了石湖。',kind:'experience',published_at:'2026-10-29',read_status:'page_excerpt'}],now:Date.parse('2026-10-30')});
const source=catalog.entries[0],claim={text:'石湖',allowed_use:'source_reference',supports:[{source_id:source.id,quote:'我们在甲城游览了石湖。'}]};
assert.equal(planningEvidenceUse(claim,catalog).allowed_use,'source_reference');assert.equal(planningEvidenceUse(claim,{...catalog,delivery_context:'suggested_itinerary'}).allowed_use,'travel_experience');
const draft={title:'甲城散步',overview:'城市散步',route:['乙城','甲城'],cards:[{id:'card-day-1',place:'甲城',label:'第1天',title:'湖边散步',content:'- 上午：游览`石湖`，按自己的节奏安排停留。'}],sections:[],pending:[]};
for(const invalid of [false,true]){
 const out=await groundConversationOutput({reply:'',draft,catalog,deliveryMode:true,allowRepair:false,model:async o=>{
  const p=JSON.parse(o.user);
  if(o.kind==='conversation_evidence_extract')return {items:p.fields.map(f=>({id:f.id,needs_source:f.text.includes('石湖'),assertions:f.text.includes('石湖')?[{span_id:invalid?'unknown':f.assertion_spans.find(s=>s.text==='石湖').id,allowed_use:'source_reference',supports:claim.supports}]:[]}))};
  if(o.kind==='conversation_evidence_support'){assert(p.claims.every(c=>c.claim.allowed_use==='travel_experience'));return {items:p.claims.map(c=>({id:c.id,decision:'supported',relation:'supports',reason:'地点来自实际经历，未推广运营'}))};}
 }});
 assert.equal(out.status,invalid?'partial':'complete');if(!invalid){assert(out.draft.cards[0].content.includes('石湖'));assert.equal(out.claims[0].allowed_use,'travel_experience');}
}
console.log('原文span编号、格式对齐、跨字段拒绝、经验用途降级与实际核对链路通过');
const largeCatalog=buildEvidenceCatalog({sources:Array.from({length:8},(_,i)=>({url:'https://example.org/article/'+i,title:'资料'+i,excerpt:'这是本次规划可见的公开资料。'.repeat(90),published_at:'2026-10-29'})),now:Date.parse('2026-10-30')});
const longDraft={...draft,cards:Array.from({length:6},(_,i)=>({...draft.cards[0],id:'card-day-'+(i+1),content:Array.from({length:10},()=>'- 上午：按自己的节奏安排游览与休息，根据个人体力选择停留，保留调整的空间。').join('\n')}))};
const views=[];
const batched=await groundConversationOutput({reply:'',draft:longDraft,catalog:largeCatalog,deliveryMode:true,allowRepair:false,budgetChars:16000,model:async o=>{
 const p=JSON.parse(o.user);views.push(p);assert(o.schema_prompt.length+o.user.length<=16000);return {items:p.fields.map(f=>({id:f.id,needs_source:false,assertions:[]}))};
}});
assert.equal(batched.status,'complete');assert(views.length>3);assert(views.every(p=>p.evidence_catalog.entries.length===8),'拆批保留所有可见来源，不靠逐批删不同来源挤进上下文');
const transportCatalog=buildEvidenceCatalog({sources:[{url:'https://example.gov.cn/line',kind:'official',title:'客运公告',excerpt:'甲到乙每天发车。',published_at:'2026-10-29'}],now:Date.parse('2026-10-30')});
const transport=await groundConversationOutput({reply:'',draft:{...draft,cards:[{...draft.cards[0],content:'资料记载甲到乙每天发车，仅供参考。'}]},catalog:transportCatalog,deliveryMode:true,allowRepair:false,model:async o=>{
 const p=JSON.parse(o.user);
 if(o.kind==='conversation_evidence_extract')return {items:p.fields.map(f=>({id:f.id,needs_source:f.text.includes('发车'),assertions:f.text.includes('发车')?[{span_id:f.assertion_spans.at(-1).id,allowed_use:'source_reference',supports:[{source_id:transportCatalog.entries[0].id,quote:'甲到乙每天发车。'}]}]:[]}))};
 return {items:p.claims.map(c=>({id:c.id,decision:'supported',relation:'supports',reason:'完整公告原句支持，仅作资料参考'}))};
}});assert.equal(transport.status,'complete','运营整句从span引用合并支持，仍执行完整运营检查');

const previous={...draft,cards:[{...draft.cards[0],id:'card-day-0',content:'旧文档写古桥每天开放。'},draft.cards[0]]};
const scoped=await groundScopedConversationOutput({reply:'',draft:previous,catalog,deliveryMode:true,allowRepair:false,model:async o=>{
 const p=JSON.parse(o.user);
 if(o.kind==='conversation_evidence_extract'){assert(!p.fields.some(f=>f.text.includes('古桥')));return {items:p.fields.map(f=>({id:f.id,needs_source:f.text.includes('石湖'),assertions:f.text.includes('石湖')?[{span_id:f.assertion_spans.find(s=>s.text==='石湖').id,allowed_use:'travel_experience',supports:claim.supports}]:[]}))};}
 return {items:p.claims.map(c=>({id:c.id,decision:'supported',relation:'supports',reason:'当前来源支持改动范围'}))};
}},{before:previous,cardIds:['card-day-1']});
assert.equal(scoped.status,'complete');assert.equal(scoped.draft.cards[0].content,previous.cards[0].content);assert.equal(scoped.verification_scope.unchanged,'preserved_not_reverified');assert(!scoped.claims.some(c=>c.sentence.includes('古桥')));

// 英文句号必须隔开规划与运营断言，小数不拆开。
{
 const spans=evidenceSpans({id:'english',text:'Plan a relaxed walk. The train runs daily. It costs 12.50 euros.'});
 assert.ok(spans.some(s=>s.kind==='clause' && s.text==='Plan a relaxed walk.'));
 assert.ok(spans.some(s=>s.kind==='clause' && s.text==='The train runs daily.'));
 assert.ok(spans.some(s=>s.kind==='clause' && s.text.includes('12.50')));
}

assert.equal(deduplicateSentences('先逛老城。下午休息。先逛老城。'),'先逛老城。 下午休息。');
assert.equal(deduplicateSentences('Walk downtown. Rest afterwards. Walk downtown.'),'Walk downtown. Rest afterwards.');
assert.equal(deduplicateSentences('上午游览。下午不游览。'),'上午游览。 下午不游览。');
