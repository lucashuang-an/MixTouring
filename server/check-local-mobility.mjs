import assert from 'node:assert/strict';
import workspace from '../mixtouring-hifi/assets/route-workspace.js';
import {buildLocalMobilityIndex} from './lib/local-mobility.mjs';
import {collectTravelSources} from './lib/travel-sources.mjs';
import {conversationTurn} from './fixtures/confirmed-conversation.mjs';
import {buildContext} from './lib/context-builder.mjs';
const old=workspace.cleanDraft({title:'攻略',route:['北京','阿拉木图'],cards:[{id:'card-day-1',place:'阿拉木图',label:'第1天',title:'峡谷',content:'- 全天：`恰伦峡谷`观景。\n不承诺当天能按点返回。\n- 提醒：带饮水和防晒。'}]});
const shown=workspace.presentDraft(old);
assert.doesNotMatch(shown.cards[0].content,/不承诺/);assert.match(shown.cards[0].content,/恰伦峡谷/);assert.match(shown.cards[0].content,/饮水/);assert.ok(shown.pending.some(p=>p.includes('不承诺')));
assert.equal(workspace.presentReply('当天一定返回，但不保证准点。'),'','整句移除，不留下前半句保证');
assert.match(workspace.presentReply('路线已停运，不能保证成行。'),/已停运/,'已知实质冲突保留');
const catalog={entries:[{id:'tour',url:'https://www.getyourguide.com/almaty-l1414/day-tour/',title:'Charyn Canyon day tour',excerpt:'Join a small group day trip from Almaty with hotel pickup.',kind:'guide',read_status:'search_excerpt',temporal_state:'undated'},
  {id:'two',url:'https://www.viator.com/tours/almaty/two-day',title:'Two-day tour to the lakes',excerpt:'Two-day tour with a guide.',kind:'guide'},
  {id:'ugc',url:'https://bbs.qyer.com/thread-123-1.html',title:'我的阿拉木图游记',excerpt:'我参加过峡谷一日团。',kind:'experience'},
  {id:'cancelled',url:'https://example.org/cancelled',title:'Notice',excerpt:'The day tour is cancelled.',kind:'guide'}]};
const rows=buildLocalMobilityIndex(catalog);
assert.ok(rows.some(r=>r.source_id==='tour'&&r.mode==='day_tour'&&r.basis==='offer_reference'));
assert.ok(rows.some(r=>r.source_id==='two'&&r.mode==='multi_day_tour'));
assert.ok(!rows.some(r=>r.source_id==='two'&&r.mode==='day_tour'));
assert.ok(rows.some(r=>r.source_id==='ugc'&&r.basis==='experience_reference'));
assert.ok(rows.some(r=>r.source_id==='cancelled'&&r.basis==='unavailable_reference'));
for(const row of rows){const source=catalog.entries.find(s=>s.id===row.source_id);assert.ok([source.title,source.excerpt].some(t=>t.includes(row.quote)));assert.equal(row.availability,'not_checked');}
const packed=buildContext({payload:{evidence_catalog:catalog,local_mobility_index:Array.from({length:30},()=>rows[0]),claims:[{supports:[{source_id:'tour',quote:'day tour'}]}]},coreRules:'规则',budgetChars:3000});
assert.ok(packed.value.evidence_catalog.entries.some(s=>s.id==='tour'));
assert.ok(packed.value.local_mobility_index.every(r=>packed.value.evidence_catalog.entries.some(s=>s.id===r.source_id)),'索引不能引用被裁掉的来源');
const calls=[];await collectTravelSources({destination:'阿拉木图',foreignQuery:'Almaty nature',international:true,purpose:'experience',include_day_tours:true},async(q,o)=>{calls.push({q,...o});return [];},{useCache:false});
assert.ok(calls.some(c=>c.q.includes('day tour')&&c.language==='en'));assert.equal(calls.length,3,'当地游补充只增加一个查询，不无限展开');
let sawIndex=false;
const brief={origin:'北京',destination:'阿拉木图',summary:'自然与城市体验',wishes:[],open_questions:[]};
const draft={title:'两天',overview:'旅行安排',route:['北京','阿拉木图'],cards:[{id:'card-day-1',place:'阿拉木图',label:'第1天',title:'当地体验',content:'上午安排城市漫步。'},{id:'card-day-2',place:'阿拉木图',label:'第2天',title:'休整',content:'下午休息。'}],sections:[],pending:[]};
const generated=await conversationTurn({action:'generate',conversation:{stage:'ready',brief,routing:{origin:'北京',destination:'阿拉木图'},requirements:{trip_days:2}}},null,{
  search:async()=>[{title:'Almaty day tour',link:catalog.entries[0].url,content:'Almaty day tour with pickup.',date:'2026-10-20'}],now:Date.parse('2026-10-28'),sourceReview:true,
  model:async opts=>{const p=JSON.parse(opts.user);if(opts.kind==='conversation_source_relevance')return {items:p.candidates.map(s=>({id:s.id,decision:'keep',reason:'当地游方式',quote:s.title}))};
    if(opts.kind==='conversation' && opts.instruction_phase==='compose'){sawIndex=true;assert.ok(p.local_mobility_index.some(r=>r.mode==='day_tour'));}
    return {intent_action:'revise',reply:'已整理。',brief,ready:true,draft,requirements_patch:{},preferences:{},travel:{},constraints:{},sights:{}};
  }
});
assert.equal(generated.status,'ok');assert.ok(sawIndex,'正式成稿实际收到出行方式索引');
console.log('✓ 正文防御性说明移除、实质冲突保留、当地游索引、日数边界与有界产品检索');
