import assert from 'node:assert/strict';
import {groundConversationOutput} from './lib/conversation-evidence.mjs';
import {buildEvidenceCatalog} from './lib/evidence-grounding.mjs';
const catalog=buildEvidenceCatalog({sources:[{url:'https://example.org/lake',title:'石湖',excerpt:'石湖位于甲城。',date:'2026-10-29'}],now:Date.parse('2026-10-30')});
const source=catalog.entries[0];
const original={title:'游览',route:['乙城','甲城'],overview:'甲城游览',cards:[{id:'card-day-1',place:'甲城',label:'第1天',title:'石湖',content:'- 上午：`石湖`——云杉环绕的高山湖，沿湖散步。\n- 下午：在市区休整。'}],sections:[],pending:[]};
for(const mode of ['valid','repeat','drop']){
 let patches=0,rewrites=0;
 const result=await groundConversationOutput({reply:'',draft:original,catalog,deliveryMode:true,allowRepair:true,repairScope:'fields',model:async o=>{
  const p=JSON.parse(o.user);
  if(o.kind==='conversation_evidence_extract')return {items:p.fields.map(f=>({...f,needs_source:f.text.includes('石湖'),assertions:f.text.includes('石湖')?[{text:'石湖',allowed_use:'source_reference',supports:[{source_id:source.id,quote:'石湖位于甲城。'}]},...(f.text.includes('云杉环绕的高山湖')?[{text:'云杉环绕的高山湖',allowed_use:'source_reference',supports:[]}]:[])]:[]}))};
  if(o.kind==='conversation_evidence_support')return {items:p.claims.map(c=>({id:c.id,decision:'supported',relation:'supports',reason:'按出处核对'}))};
  if(o.kind==='conversation_delivery_patch'){
   patches++;const f=p.fields[0];assert.deepEqual(f.protected_places,['石湖']);assert.ok(f.supported_assertions.some(a=>a.text==='石湖'));assert.ok(f.rejected_assertions.some(a=>a.text==='云杉环绕的高山湖'));
   return {fields:[{path:f.path,text:mode==='valid'?'- 上午：`石湖`——沿湖散步，欣赏湖面。':mode==='repeat'?f.text:'- 上午：回到市区休息。'}]};
  }
  if(o.kind==='conversation_delivery')rewrites++;
  return {items:[]};
 }});
 assert.equal(patches,1);assert.equal(rewrites,0);
 if(mode==='valid'){assert.equal(result.status,'complete');assert.match(result.draft.cards[0].content,/石湖/);assert.match(result.draft.cards[0].content,/下午：在市区休整/);assert.doesNotMatch(result.draft.cards[0].content,/高山湖/);assert.ok(result.sources.some(s=>s.id===source.id));}
 else assert.notEqual(result.status,'complete','重复被拒断言或删除受保护地点不能算修复成功');
}
console.log('✓ 证据片段修复：保留已支持地点、删除被拒修饰、拒绝重复错误与丢失锚点、保留邻文和引用');
let whole=0;
const mixed=await groundConversationOutput({reply:'',draft:{...original,sections:[{title:'交通',content:'巴士每天发车。'}]},catalog,deliveryMode:true,model:async o=>{
 const p=JSON.parse(o.user);
 if(o.kind==='conversation_evidence_extract')return {items:p.fields.map(f=>({...f,needs_source:f.text.includes('石湖')||f.text.includes('巴士'),assertions:f.text.includes('石湖')?[{text:'石湖',allowed_use:'source_reference',supports:[{source_id:source.id,quote:'石湖位于甲城。'}]},...(f.text.includes('云杉')?[{text:'云杉环绕的高山湖',allowed_use:'source_reference',supports:[]}]:[])]:[]}))};
 if(o.kind==='conversation_evidence_support')return {items:p.claims.map(c=>({id:c.id,decision:'supported',relation:'supports',reason:'原句支持地点'}))};
 if(o.kind==='conversation_delivery_patch')return {fields:p.fields.map(f=>({path:f.path,text:f.path.includes('cards')?'- 上午：游览`石湖`。':'当地有直达巴士。'}))};
 if(o.kind==='conversation_delivery'){whole++;return null;}
}});
assert.equal(mixed.status,'partial');assert.equal(whole,0,'一个补丁失败不能触发整稿重写');assert.match(mixed.draft.cards[0].content,/游览`石湖`/);assert.equal(mixed.draft.sections[0].content,'');assert(mixed.sources.some(s=>s.id===source.id));
let batchCalls=0,largeRewrites=0;
const large={...original,cards:Array.from({length:7},(_,i)=>({...original.cards[0],id:'card-day-'+(i+1),label:'第'+(i+1)+'天'}))};
const largeResult=await groundConversationOutput({reply:'',draft:large,catalog,deliveryMode:true,model:async o=>{
 const p=JSON.parse(o.user);
 if(o.kind==='conversation_evidence_extract')return {items:p.fields.map(f=>({...f,needs_source:f.text.includes('石湖'),assertions:f.text.includes('石湖')?[{text:'石湖',allowed_use:'source_reference',supports:[{source_id:source.id,quote:'石湖位于甲城。'}]},...(f.text.includes('云杉')?[{text:'云杉环绕的高山湖',allowed_use:'source_reference',supports:[]}]:[])]:[]}))};
 if(o.kind==='conversation_evidence_support')return {items:p.claims.map(c=>({id:c.id,decision:'supported',relation:'supports',reason:'原句支持'}))};
 if(o.kind==='conversation_delivery_patch'){batchCalls++;assert(p.fields.length<=4);return {fields:p.fields.map(f=>({path:f.path,text:'- 上午：游览`石湖`。'}))};}
 if(o.kind==='conversation_delivery'){largeRewrites++;return null;}
}});
assert.equal(largeResult.status,'complete');assert.equal(batchCalls,2);assert.equal(largeRewrites,0);assert.equal(largeResult.draft.cards.length,7);assert(largeResult.draft.cards.every(c=>c.content.includes('下午：在市区休整')));
