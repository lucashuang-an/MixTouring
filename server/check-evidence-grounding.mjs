/* R1-B 底座复审回归：原始反例、合法放行、真实目录形状及核对失败边界。 */
import assert from 'node:assert/strict';
import {buildEvidenceCatalog,validateEvidenceClaims,isQuestionSource,textDirection,assessEvidenceClaims} from './lib/evidence-grounding.mjs';
import {buildContext} from './lib/context-builder.mjs';
import {sourceId} from './lib/source-relevance.mjs';
const now=Date.parse('2026-10-22T00:00:00Z'),routing={origin:'北京',destination:'阿拉木图'};
const row=(excerpt,over={})=>({url:'https://example.gov.cn/article',title:'交通资料',excerpt,published_at:'2026-10-20',kind:'official',read_status:'page_excerpt',...over});
const make=(sources,extra={})=>buildEvidenceCatalog({sources,routing,now,retrieval:{purpose:'transport'},...extra});
const reply='来源记载北京到阿拉木图开通直飞，本次日期仍待确认。',quote='北京到阿拉木图开通直飞。',cat=make([row(quote)]);
const claim=(catalog=cat,text=reply,q=catalog.entries[0].excerpt)=>({text,allowed_use:'source_reference',supports:[{source_id:catalog.entries[0].id,quote:q}]});
const supported=async({user})=>({items:JSON.parse(user).claims.map(c=>({id:c.id,decision:'supported',reason:'原句支持限定后的资料参考'}))});
const check=async(catalog,text=reply,claims=[claim(catalog,text)],model=supported)=>validateEvidenceClaims(text,catalog,{claims,assessment:await assessEvidenceClaims(text,catalog,claims,model)});
assert.equal(cat.entries[0].id,sourceId(row(quote)));
assert.equal((await check(cat)).grounded.length,1);
assert.equal(validateEvidenceClaims(reply,cat,{claims:[claim()]}).grounded.length,0,'引用及原句存在不等于语义已核对');
for(const source of [row('阿拉木图国际机场位于哈萨克斯坦。',{title:'阿拉木图国际机场介绍'}),row('北京到阿拉木图尚未开通直飞。'),row('请问有人知道吗？',{title:'北京到阿拉木图有直飞吗？'}),row('Does Beijing have direct flights to Almaty?'),row(quote,{kind:'experience'}),row(quote,{allowed_use:'software_reference'}),row(quote,{relevance:{decision:'uncertain'}})]){
  const c=make([source]);let called=0;
  const r=await check(c,reply,[claim(c)],async p=>{called++;return supported(p);});
  assert.ok(r.rejected.length);assert.equal(r.grounded.length,0);assert.equal(called,0,'确定性不合格资料不花费模型调用');
}
const question={title:'北京到阿拉木图有直飞吗',excerpt:'请问怎么查'};
assert.equal(isQuestionSource(question),true);
assert.equal(isQuestionSource({...question,excerpt:'答：北京到阿拉木图开通直飞。'}),false);
assert.equal((await check(make([row(quote,{title:question.title})]))).grounded.length,1,'问答混合须核对具体回答');
const reverse=make([row('阿拉木图到北京开通直飞。')]);
const denied=await check(reverse,reply,[claim(reverse)],async({user})=>({items:JSON.parse(user).claims.map(c=>({id:c.id,decision:'unsupported',reason:'反向航线不能支持正向'}))}));
assert.equal(denied.grounded.length,0,'方向由语义核对，不靠城市首现顺序证明方向');
assert.equal(textDirection('阿拉木图出发到北京','北京','阿拉木图'),'BA');assert.equal(textDirection('机场介绍','北京','阿拉木图'),null);
assert.equal((await check(cat,'北京到阿拉木图现在有直飞。',[claim(cat,'北京到阿拉木图现在有直飞。')])).grounded.length,0);
const badQuote=claim();badQuote.supports[0].quote='北京到阿拉木图每天直飞';assert.equal((await check(cat,reply,[badQuote])).grounded.length,0);
assert.equal((await check(cat,reply,[claim(),claim()])).grounded.length,0);
assert.equal((await check(cat,reply,[{...claim(),supports:[...claim().supports,...claim().supports]}])).grounded.length,0);
const wrongRef=reply.replace('。',' [ev_1]。');assert.equal((await check(cat,wrongRef,[claim(cat,wrongRef)])).grounded.length,0);
console.log('✓ 背景、提问、否定、用途、方向语义、伪造原句及合法参考通过');

const old=make([row(quote,{published_at:'2026-05-01'})]);assert.equal(old.entries[0].temporal_state,'historical');assert.equal((await check(old)).grounded.length,0);
const experienceWindow=make([row(quote,{published_at:'2026-05-01'})],{retrieval:{purpose:'experience'}});
assert.equal(experienceWindow.entries[0].temporal_state,'recent');assert.equal((await check(experienceWindow)).grounded.length,0);
const history=make([row(quote)],{retrieval:{purpose:'transport',target_window:'2026-10-01 ~ 2026-10-08'}});
assert.equal(history.entries[0].temporal_state,'after_trip');assert.equal((await check(history)).grounded.length,0);
for(const over of [{published_at:null},{date_basis:'provider_estimate'},{temporal:{state:'historical'}},{valid_until:'2026-10-01'}])assert.equal((await check(make([row(quote,over)]))).grounded.length,0);
const future=make([row(quote,{valid_from:'2026-10-01',valid_until:'2026-10-31',validity_basis:'schedule'})],{retrieval:{purpose:'transport',target_window:'2026-11-01 ~ 2026-11-08'}});assert.equal(future.entries[0].temporal_state,'outside_window');
console.log('✓ 交通复核期、历史窗、估计日期和原状态不可升级通过');

for(const text of ['目前无法确认是否有直飞，班车也仍待核实。','没有直飞，班车尚未恢复运行。','如果开通直飞，可以再比较。','Are there direct flights?','Direct flights are unconfirmed.','可以先探索市区，再确认交通。'])assert.equal(validateEvidenceClaims(text,{entries:[]}).rejected.length,0,text);
for(const text of ['无法确认票价，但北京到阿拉木图有直飞。','是否有直飞？北京到阿拉木图每天发车。'])assert.ok(validateEvidenceClaims(text,{entries:[]}).rejected.length);
const experience=make([row('我在大阪散步很愉快。',{kind:'experience'})],{retrieval:{purpose:'experience'}}),experienceText='该旅行者记录了在大阪散步的愉快体验。';
assert.equal((await check(experience,experienceText,[{...claim(experience,experienceText),allowed_use:'travel_experience'}])).grounded.length,1);
console.log('✓ 否定、疑问、假设、转折和有出处经验正常表达通过');

for(const model of [async()=>null,async()=>({items:[]}),async()=>{throw Error('不记录原始故障');},async({user})=>({items:[{id:JSON.parse(user).claims[0].id,decision:'supported',reason:''}]}),async({user})=>{const r={id:JSON.parse(user).claims[0].id,decision:'supported',reason:'重复'};return {items:[r,r]};}])assert.equal((await check(cat,reply,[claim()],model)).grounded.length,0);
const assessment=await assessEvidenceClaims(reply,cat,[claim()],supported),changed=structuredClone(cat);changed.entries[0].excerpt='北京到阿拉木图尚未开通直飞。';
assert.equal(validateEvidenceClaims(reply,changed,{claims:[claim()],assessment}).grounded.length,0);
const changedReply='来源记载北京到阿拉木图每天直飞，本次日期仍待确认。';assert.equal(validateEvidenceClaims(changedReply,cat,{claims:[claim(cat,changedReply)],assessment}).grounded.length,0);
const changedScope=structuredClone(cat);changedScope.retrieval.target_window='2026-11-01 ~ 2026-11-08';assert.equal(validateEvidenceClaims(reply,changedScope,{claims:[claim()],assessment}).grounded.length,0);
assert.equal(validateEvidenceClaims('可以考虑直飞方案，再核实交通。',{entries:[]}).rejected.length,0);
const ctrl=new AbortController();const cancelled=await assessEvidenceClaims(reply,cat,[claim()],async p=>{ctrl.abort();return supported(p);},{signal:ctrl.signal});assert.equal(cancelled.reason,'cancelled');
let calls=0;await assessEvidenceClaims(reply,cat,[claim()],async()=>{calls++;},{signal:ctrl.signal});assert.equal(calls,0);
assert.equal((await assessEvidenceClaims(reply,cat,[claim()],supported,{budgetChars:50})).status,'unavailable');
console.log('✓ 缺项、重复、模型故障、修改后失效、取消和预算保护通过');

const large=make(Array.from({length:12},(_,i)=>row('旅行参考资料。'.repeat(70),{url:'https://example.gov.cn/article/'+i}))),before=JSON.stringify(large);
const built=buildContext({payload:{text:'保留本轮条件',evidence_catalog:large},budgetChars:4000});
assert.ok(built.manifest.omitted_ids.includes('evidence_catalog'));assert.equal(built.value.text,'保留本轮条件');assert.equal(JSON.stringify(large),before);
assert.ok(built.value.evidence_catalog.entries.length<12);assert.ok(built.value.evidence_catalog.entries.every(e=>e.id===sourceId(e)));
const removed=large.entries.find(e=>!built.value.evidence_catalog.entries.some(v=>v.id===e.id));
assert.equal((await check(built.value.evidence_catalog,reply,[{text:reply,allowed_use:'source_reference',supports:[{source_id:removed.id,quote:removed.excerpt}]}])).grounded.length,0);
assert.equal(buildContext({payload:{search_results:[row(quote)],evidence_catalog:cat}}).value.evidence_catalog.entries[0].excerpt,quote);
console.log('✓ 真实目录形状裁剪、稳定身份、原对象保护和可见引用一致性通过');
