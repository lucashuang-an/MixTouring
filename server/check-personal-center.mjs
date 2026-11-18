import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';import {webcrypto} from 'node:crypto';
const src=fs.readFileSync(new URL('../mixtouring-hifi/assets/personal-store.js',import.meta.url),'utf8');
function env(){const data=new Map();let fail=null;const ctx={TextEncoder,URL,crypto:webcrypto,Date,console,navigator:{},localStorage:{getItem:k=>data.get(k)??null,setItem(k,v){if(fail===k){fail=null;throw Error('quota');}data.set(k,v);},removeItem:k=>data.delete(k)}};vm.createContext(ctx);vm.runInContext(src,ctx);return {p:ctx.MTPersonal,data,fail:k=>fail=k};}
const a=env();await a.p.add({type:'link',title:'资料',url:'https://example.com'});await a.p.add({type:'link',title:'重复',url:'https://example.com/'});assert.equal(a.p.list().length,1);await assert.rejects(a.p.add({type:'link',title:'坏链接',url:'javascript:alert(1)'}));
a.data.set('mt:favs',JSON.stringify({old:{title:'旧收藏'}}));await a.p.migrate();await a.p.migrate();assert.equal(a.p.list().length,2);await a.p.remove('legacy:old');await a.p.migrate();assert.equal(a.p.list().length,1,'取消旧收藏后不可复活');
a.fail('mt:collections');await assert.rejects(a.p.add({type:'place',title:'新地点'}));assert.equal(a.p.list().length,1);
const draft={id:'d1',name:'旅行',versions:[{vid:'v1',saved_at:'2026-11-04',snapshot:{request:{origin:'北京'},resume_token:'private-token',conversation:{draft:{title:'安排'}}}}]};a.data.set('mt:drafts',JSON.stringify({d1:draft}));a.data.set('secret-token','not exported');const text=JSON.stringify(a.p.backup());assert.ok(!text.includes('not exported'));assert.ok(!text.includes('private-token'));
const b=env();await b.p.restore(text);assert.equal(b.p.list().length,1);await b.p.restore(text);assert.equal(Object.keys(JSON.parse(b.data.get('mt:drafts'))).length,2,'冲突行程保留副本');
for(const invalid of ['null','{}',JSON.stringify({format:'mixtouring-personal',version:99,data:{}}),JSON.stringify({format:'mixtouring-personal',version:1,data:{'secret-token':'{}'}}),JSON.stringify({format:'mixtouring-personal',version:1,data:{'mt:drafts':'[]'}}),'x'.repeat(9*1024*1024)])assert.throws(()=>b.p.inspect(invalid));
const before=new Map(b.data);b.fail('mt:collections');await assert.rejects(b.p.restore(text));assert.deepEqual(b.data,before,'拒写回滚保持已有数据');
await b.p.clearKeys(['mt:collections','mt:favs']);assert.equal(b.p.list().length,0);assert.ok(b.data.has('mt:drafts'));
a.data.set('mt:collections','{broken');assert.throws(()=>a.p.list());await assert.rejects(a.p.add({type:'place',title:'不可覆盖'}));assert.equal(a.data.get('mt:collections'),'{broken');
console.log('✓ 个人中心：去重、迁移、取消不复活、拒写、备份白名单、导入冲突、坏格式与回滚通过');

// 记忆清空使在途响应失效，关闭不会删除存量。
const pctx={console,window:{addEventListener(){}},localStorage:{getItem:k=>b.data.get(k)??null,setItem:(k,v)=>b.data.set(k,v)},navigator:{}};vm.createContext(pctx);vm.runInContext(fs.readFileSync(new URL('../mixtouring-hifi/assets/preference-store.js',import.meta.url),'utf8'),pctx);const prefs=pctx.window.MTPreferences;await prefs.setEnabled(true);await prefs.propose('pace','simple',1);const request=prefs.snapshotForRequest();await prefs.clear();assert.equal((await prefs.applyUpserts([{key:'pace',value:'simple'}],1,request)).ok,false);assert.equal(prefs.entries().length,0);
console.log('✓ 清空偏好拒绝迟到结果，备份不含恢复凭据');
