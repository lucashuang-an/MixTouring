import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {parseHTML} from 'linkedom';
const read=p=>fs.readFileSync(new URL('../mixtouring-hifi/'+p,import.meta.url),'utf8');
{
 const {window,document}=parseHTML(read('pages/login.html')),data=new Map(),calls=[];let destination=null;
 Object.defineProperty(document.getElementById('authLanguage'),'value',{value:'en',writable:true});
 const ctx={window,document,NodeFilter:{SHOW_TEXT:4},MutationObserver:class{observe(){}},localStorage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)},navigator:{language:'en'},location:{pathname:'/pages/login.html',replace:u=>destination=u},fetch:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {ok:false,json:async()=>({msg:'账号或密码不正确'})};}};
 vm.createContext(ctx);vm.runInContext(read('assets/language.js'),ctx);window.MTLanguage.apply();vm.runInContext(read('assets/auth.js'),ctx);
 const $=id=>document.getElementById(id);assert.equal($('title').textContent,'Welcome back');assert.equal($('submit').textContent,'Sign in');assert.equal($('confirmPassword').disabled,true);
 $('username').value='fixture_user';$('password').value='fixture-password-only';$('authLanguage').value='zh-CN';$('authLanguage').onchange();assert.equal($('title').textContent,'欢迎回来');assert.equal($('password').value,'fixture-password-only');
 $('switchMode').onclick();assert.equal($('registerFields').hidden,false);assert.equal($('confirmPassword').required,true);$('confirmPassword').value='different-password';await $('authForm').onsubmit({preventDefault(){}});assert.equal(calls.length,0);assert.match($('error').textContent,/不一致/);
 $('switchMode').onclick();$('authLanguage').value='en';$('authLanguage').onchange();await $('authForm').onsubmit({preventDefault(){}});assert.equal(calls[0].url,'/api/auth/login');assert.equal($('error').textContent,'Incorrect username or password.');assert.equal(destination,null);assert.equal($('submit').disabled,false);
}
{
 const {window,document}=parseHTML(read('pages/collections.html'));window.HTMLElement.prototype.focus=function(){};
 const create=document.createElement.bind(document);document.createElement=tag=>{const e=create(tag);if(tag==='dialog'){e.showModal=()=>{e.open=true;};e.close=()=>{e.open=false;e.onclose?.();};}return e;};
 const item={id:'place-test',type:'place',title:'河内',city:'河内'},trip={id:'trip-test',name:'测试旅行',versions:[{vid:'v1',snapshot:{conversation:{draft:{cards:[{id:'day1',label:'第1天',place:'河内',title:'散步'}]}}}}]};
 const language={t:s=>s,apply(){},locale:()=> 'zh-CN'};window.MTLanguage=language;
 const service={add:args=>{assert.equal(args.tripId,'trip-test');assert.equal(args.cardId,'day1');return {ok:true,tripId:'trip-test',vid:'v2',day:'第1天',undo:{}};},undo:()=>({ok:true,vid:'v3'}),href:(id,vid)=>'/pages/trip.html?draft='+id+'&ver='+vid};
 const ctx={window,document,location:{pathname:'/pages/collections.html'},CSS:{escape:s=>s},MT:{esc:s=>String(s),toast(){}},MTLanguage:language,MTPersonal:{list:()=>[item],migrate:async()=>{}},MTDrafts:{list:()=>({drafts:[trip]}),get:()=>trip},MTSavedPlacement:{create:()=>service},MTRouteWorkspace:{},console};
 Object.defineProperty(document.getElementById('collectionType'),'value',{value:'place',writable:true});document.getElementById('collectionSearch').value='';
 vm.createContext(ctx);vm.runInContext(read('assets/personal-ui.js'),ctx);await new Promise(r=>setTimeout(r,0));
 assert.equal(document.querySelector('.saved-card p.muted'),null);document.querySelector('[data-view]').click();assert.equal(document.querySelector('#savedDetail p[data-no-i18n]'),null);
 document.querySelector('[data-add-saved]').click();for(const [id,value] of [['savedTripTarget','trip-test'],['savedDayTarget','day1']])Object.defineProperty(document.getElementById(id),'value',{value,writable:true});document.getElementById('savedTripTarget').onchange();document.getElementById('savedDayTarget').onchange();document.getElementById('savedDayForm').onsubmit({preventDefault(){}});
 assert.equal(document.getElementById('savedDetailTitle').textContent,'已加入行程');document.getElementById('undoSavedDay').onclick();assert.equal(document.getElementById('savedDetailTitle').textContent,'已撤销添加');assert.match(document.querySelector('#savedDetail a').href,/ver=v3/);
}
console.log('✓ 用户旅程界面：登录语言与输入保留、注册确认、错误翻译、收藏去重展示与撤销反馈通过');
