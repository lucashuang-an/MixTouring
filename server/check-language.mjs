import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {parseHTML} from 'linkedom';
const source=fs.readFileSync(new URL('../mixtouring-hifi/assets/language.js',import.meta.url),'utf8');
function make(lang='zh-CN',data=new Map()){
 const {document}=parseHTML('<html><head></head><body><h1>设置</h1><input aria-label="搜索收藏" placeholder="搜索名称或城市"><select id="languageSelect"></select><div class="personal-card"><h2>设置</h2></div><p class="guide-message">设置</p><p id="personalStatus"></p></body></html>');Object.defineProperty(document.getElementById('languageSelect'),'value',{value:'system',writable:true});const events={};let fail=false;
 const window={addEventListener:(n,fn)=>events[n]=fn};const ctx={window,document,navigator:{language:lang},location:{pathname:'/pages/settings.html'},NodeFilter:{SHOW_TEXT:4},MutationObserver:class{observe(){}},localStorage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>{if(fail)throw Error('quota');data.set(k,v);}}};vm.createContext(ctx);vm.runInContext(source,ctx);return {p:window.MTLanguage,document,data,events,deny(){fail=true;}};
}
const a=make();assert.equal(a.p.locale(),'en','新用户优先英文');a.p.set('zh-CN');assert.equal(a.p.locale(),'zh-CN');a.p.set('en');assert.equal(a.document.documentElement.lang,'en');assert.equal(a.document.querySelector('h1').textContent,'Settings');assert.equal(a.document.querySelector('input').getAttribute('aria-label'),'Search saved items');assert.equal(a.document.querySelector('.personal-card h2').textContent,'设置','用户收藏名称不翻译');assert.equal(a.document.querySelector('.guide-message').textContent,'设置','用户对话不翻译');
const b=make('zh-CN',a.data);assert.equal(b.p.locale(),'en','刷新沿用选择');a.p.set('zh-CN');assert.equal(a.document.querySelector('h1').textContent,'设置');b.events.storage({key:'mt:language'});assert.equal(b.document.documentElement.lang,'zh-CN');
a.deny();assert.throws(()=>a.p.set('en'));assert.equal(a.p.get(),'zh-CN','拒写不伪造成功');assert.throws(()=>a.p.set('fr'));assert.equal(make('en-GB').p.locale(),'en');const system=make('zh-TW');system.p.set('system');assert.equal(system.p.locale(),'zh-CN');assert.equal(make('fr-FR').p.locale(),'en');
console.log('✓ 语言选择：中英切换、刷新、跨窗口、浏览器语言、拒写、非法值与私人内容隔离通过');

const dynamic=make();dynamic.document.body.insertAdjacentHTML('beforeend','<p id="count">1 份旅行</p><button id="continue">继续规划</button><p data-no-i18n id="privateTitle">1 份旅行</p>');dynamic.p.set('en');
assert.equal(dynamic.document.getElementById('count').textContent,'1 trip');assert.equal(dynamic.document.getElementById('continue').textContent,'Continue planning');assert.equal(dynamic.document.getElementById('privateTitle').textContent,'1 份旅行');
dynamic.p.set('zh-CN');assert.equal(dynamic.document.getElementById('count').textContent,'1 份旅行');

const control=dynamic.document.createElement('button');control.id='collapseTest';control.setAttribute('aria-label','收起侧栏');dynamic.document.body.append(control);dynamic.p.set('en');
control.setAttribute('aria-label','Expand sidebar');dynamic.p.set('zh-CN');assert.equal(control.getAttribute('aria-label'),'展开侧栏','切语言保留控件真实展开状态');
