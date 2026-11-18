(function(){
'use strict';
const $=id=>document.getElementById(id),esc=s=>MT.esc(s),store=MTPersonal;
function status(s){s=window.MTLanguage?MTLanguage.t(s):s;if($('personalStatus'))$('personalStatus').textContent=s;else MT.toast(s);}
function run(fn){return Promise.resolve().then(fn).catch(e=>status(e.message||'操作未完成，请重试'));}
function importSummary(data){
 const english=MTLanguage.locale()==='en',labels={'mt:drafts':['行程','trips'],'mt:collections':['收藏','saved items'],'mt:preference-memory':['偏好','preferences'],'mt:favs':['历史收藏','legacy favorites'],'mt:wishlist':['历史心愿','legacy wishes'],'mt:feedback':['历史回填','legacy reports']};
 const counts=Object.entries(data).map(([k,v])=>{const n=k==='mt:drafts'?Object.keys(v).filter(id=>id!=='__seq').length:k==='mt:collections'?v.items.length:k==='mt:preference-memory'?v.entries.filter(x=>x.status==='active').length:Array.isArray(v)?v.length:Object.keys(v).length;return english?n+' '+labels[k][1]:labels[k][0]+' '+n+' 条';}).join(english?', ':'、');
 return english?'Merge: '+counts+'. Conflicting trips are kept as copies. Existing preferences take priority; importing does not enable memory.':'将合并：'+counts+'。冲突行程保留副本，已有偏好优先；不会自动开启记忆。';
}
function download(name,content){const u=URL.createObjectURL(new Blob([content],{type:'application/json;charset=utf-8'})),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
if(!document.querySelector('.personal-menu')){const nav=document.createElement('nav');nav.className='personal-menu';nav.setAttribute('aria-label','个人中心');nav.innerHTML='<a href="collections.html">收藏</a><a href="settings.html">设置</a><a href="help.html">帮助</a>';document.body.prepend(nav);}
function renderCollections(){
 const q=$('collectionSearch').value.trim().toLocaleLowerCase(),type=$('collectionType').value;
 const items=store.list().filter(x=>(type==='place'?x.type==='place':type==='route'?false:x.type!=='place')&&(!q||[x.title,x.city].join(' ').toLocaleLowerCase().includes(q)));
 document.querySelectorAll('[data-saved-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.savedTab===type)));
 $('collectionList').className=items.length?'saved-grid':'';
 $('collectionList').innerHTML=items.length?items.map(x=>'<article class="saved-card"><div class="saved-card-media" aria-hidden="true"><img src="../assets/heart-gray.svg" alt=""></div><button class="saved-heart-button" data-remove="'+esc(x.id)+'" aria-label="取消收藏"><img src="../assets/heart-red.svg" alt=""></button><h2 data-no-i18n>'+esc(x.title)+'</h2>'+(x.city && x.city!==x.title?'<p class="muted" data-no-i18n>'+esc(x.city)+'</p>':'')+'<button class="saved-card-open" data-view="'+esc(x.id)+'">'+(x.type==='place'?'查看地点':'查看来源')+'</button></article>').join(''):'<div class="mt-empty prototype-empty"><h2>'+(q?'没有匹配的收藏。':'把旅行灵感留在这里。')+'</h2><p>'+(type==='route'?'社区路线尚未开放。':'发现喜欢的地点和资料，就先收藏起来。')+'</p><a class="mt-button-primary" href="trip.html">新建旅行</a></div>';
 MTLanguage.apply();
}
function viewSaved(id){
 const item=store.list().find(x=>x.id===id);if(!item)return;
 let dialog=$('savedDetail');if(!dialog){dialog=document.createElement('dialog');dialog.id='savedDetail';dialog.className='saved-detail';dialog.setAttribute('aria-labelledby','savedDetailTitle');dialog.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const controls=[...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter(n=>n.getClientRects().length);if(!controls.length)return;const first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}});document.body.append(dialog);}
 const trigger=document.querySelector('[data-view="'+CSS.escape(id)+'"]');
 dialog.innerHTML='<button type="button" class="detail-close" aria-label="关闭">×</button><div class="saved-card-media" aria-hidden="true"><img src="../assets/heart-gray.svg" alt=""></div><h2 id="savedDetailTitle" data-no-i18n>'+esc(item.title)+'</h2>'+(item.city && item.city!==item.title?'<p data-no-i18n>'+esc(item.city)+'</p>':'')+(item.url?'<a class="source-link" href="'+esc(item.url)+'" target="_blank" rel="noopener noreferrer">查看来源 ↗</a>':'')+'<div class="detail-actions">'+(item.type==='place'?'<button type="button" class="primary" data-add-saved>加入行程</button><button type="button" data-plan-saved>以此地点规划</button>':'')+'<button type="button" data-remove-detail>取消收藏</button></div>';
 dialog.querySelector('.detail-close').onclick=()=>dialog.close();dialog.onclose=()=>{if(trigger?.isConnected)trigger.focus();else document.querySelector('.saved-tabs [aria-pressed="true"]')?.focus();};
 dialog.querySelector('[data-remove-detail]').onclick=()=>run(async()=>{await store.remove(id);dialog.close();renderCollections();status('已取消收藏');});
 const add=dialog.querySelector('[data-add-saved]');if(add)add.onclick=()=>selectSavedDay(dialog,item);
 const plan=dialog.querySelector('[data-plan-saved]');if(plan)plan.onclick=()=>run(()=>{
  const text=MTLanguage.locale()==='en'?'I would like to include '+item.title+(item.city && item.city!==item.title?' in '+item.city:'')+' in my trip. Help me plan around it.':'我想把'+item.title+(item.city && item.city!==item.title?'（'+item.city+'）':'')+'加入旅行，请帮我讨论如何安排。';
  (globalThis.MTSessionStorage || sessionStorage).setItem('mt:saved-place-intent',text);location.href='trip.html?new=1';
 });
 MTLanguage.apply();dialog.showModal();
}
function selectSavedDay(dialog,item){
 const listing=MTDrafts.list(),trips=listing.drafts.filter(t=>t.versions.at(-1)?.snapshot.conversation?.draft?.cards?.length);
 const service=MTSavedPlacement.create(MTDrafts,MTRouteWorkspace);
 const errorText=reason=>MTLanguage.t(({stale_version:'这份旅行已更新，请重新选择。',write_failed:'未能保存，原行程保持不变。',corrupted_store:'行程存储暂不可读取，请到设置导出备份。',not_found:'这份旅行已不存在。',invalid_target:'这个日期暂不可用，请重新选择。',day_too_long:'这一天内容已过长，请先在规划中调整。'})[reason]||'操作未完成，请重试');
 dialog.innerHTML='<button type="button" class="detail-close" aria-label="关闭">×</button><h2 id="savedDetailTitle">加入行程</h2><p data-no-i18n>'+esc(item.title)+'</p>'+(listing.store_corrupted?'<p role="alert">行程存储暂不可读取，请到设置导出备份。</p>':!trips.length?'<p>还没有已保存的逐日行程。</p><a href="trip.html?new=1">新建旅行</a>':'<form id="savedDayForm"><label>选择旅行<select id="savedTripTarget" required><option value="">请选择</option>'+trips.map(t=>'<option value="'+esc(t.id)+'" data-no-i18n>'+esc(t.name)+'</option>').join('')+'</select></label><label>选择日期<select id="savedDayTarget" required disabled><option value="">请选择</option></select></label><p>只加入所选日期，其他安排保持不变。</p><p id="savedDayError" role="alert"></p><div class="detail-actions"><button type="button" data-cancel-add>取消</button><button type="submit" class="primary" id="confirmSavedDay" disabled>确认加入</button></div></form>');
 dialog.querySelector('.detail-close').onclick=()=>dialog.close();
 const form=$('savedDayForm');if(!form){MTLanguage.apply();return;}
 let versionId=null;
 $('savedTripTarget').onchange=()=>{
  const t=MTDrafts.get($('savedTripTarget').value),latest=t?.versions.at(-1);versionId=latest?.vid||null;
  const cards=latest?.snapshot.conversation?.draft?.cards||[];
  $('savedDayTarget').innerHTML='<option value="">'+MTLanguage.t('请选择')+'</option>'+cards.map(c=>'<option value="'+esc(c.id)+'" data-no-i18n>'+esc([MTLanguage.t(c.label),c.place,c.title].filter(Boolean).join(' · '))+'</option>').join('');
  $('savedDayTarget').disabled=!cards.length;$('confirmSavedDay').disabled=true;$('savedDayError').textContent='';
 };
 $('savedDayTarget').onchange=()=>{$('confirmSavedDay').disabled=!$('savedDayTarget').value;};
 dialog.querySelector('[data-cancel-add]').onclick=()=>viewSaved(item.id);
 form.onsubmit=e=>{
  e.preventDefault();const button=$('confirmSavedDay');button.disabled=true;
  const result=service.add({tripId:$('savedTripTarget').value,versionId,cardId:$('savedDayTarget').value,item,language:MTLanguage.locale()});
  if(!result.ok){$('savedDayError').textContent=errorText(result.reason);button.disabled=false;if(result.reason==='stale_version'){$('savedTripTarget').value='';$('savedDayTarget').innerHTML='<option value="">'+MTLanguage.t('请选择')+'</option>';$('savedDayTarget').disabled=true;versionId=null;button.disabled=true;}return;}
  const href=service.href(result.tripId,result.vid);
  dialog.innerHTML='<button type="button" class="detail-close" aria-label="关闭">×</button><h2 id="savedDetailTitle">'+(result.duplicate?'这个日期已包含该地点。':'已加入行程')+'</h2><p data-no-i18n>'+esc(item.title)+(result.day?' · '+esc(MTLanguage.t(result.day)):'')+'</p><div class="detail-actions">'+(href?'<a class="mt-button-primary" href="'+esc(href)+'">查看行程</a>':'')+(result.undo?'<button type="button" id="undoSavedDay">撤销</button>':'')+'</div><p id="savedDayResult" role="status"></p>';
  dialog.querySelector('.detail-close').onclick=()=>dialog.close();
  if(result.undo)$('undoSavedDay').onclick=()=>{const undone=service.undo(result.undo);if(!undone.ok){$('savedDayResult').textContent=errorText(undone.reason);return;}$('undoSavedDay').disabled=true;$('savedDetailTitle').textContent=MTLanguage.t('已撤销添加');$('savedDayResult').textContent=MTLanguage.t('已撤销，原安排已恢复。');const link=dialog.querySelector('a');if(link)link.href=service.href(result.tripId,undone.vid);};
  MTLanguage.apply();const heading=$('savedDetailTitle');heading.tabIndex=-1;heading.focus();
 };
 MTLanguage.apply();$('savedTripTarget').focus();
}
if($('collectionList')){
 run(async()=>{await store.migrate();renderCollections();});
 $('collectionSearch').oninput=()=>run(renderCollections);$('collectionType').onchange=()=>run(renderCollections);
 document.querySelectorAll('[data-saved-tab]').forEach(b=>b.onclick=()=>{$('collectionType').value=b.dataset.savedTab;renderCollections();});
 $('collectionForm').onsubmit=e=>{e.preventDefault();run(async()=>{const item=Object.fromEntries(new FormData(e.target));await store.add(item);$('collectionType').value=item.type==='place'?'place':'source';e.target.reset();renderCollections();status('已收藏');});};
 $('collectionList').onclick=e=>{const b=e.target.closest('[data-remove]'),v=e.target.closest('[data-view]');if(b)run(async()=>{await store.remove(b.dataset.remove);renderCollections();status('已取消收藏');});else if(v)viewSaved(v.dataset.view);};
 window.addEventListener('storage',e=>{if(e.key===store.KEY)run(renderCollections);});
}
if($('themeSelect')){
 $('themeSelect').value=MTTheme.get();$('themeSelect').onchange=()=>run(()=>{try{MTTheme.set($('themeSelect').value);status('外观已保存');}finally{$('themeSelect').value=MTTheme.get();}});
 function prefs(){const p=MTPreferences,s=p.status();$('memoryEnabled').checked=s.stored_enabled;if($('settingsMemoryLabel'))$('settingsMemoryLabel').textContent=MTLanguage.t(s.stored_enabled?'记忆已开启':'记忆已关闭');$('preferenceList').innerHTML=s.health!=='ready'?'<p>偏好暂不可读取，请先导出原始数据。</p>':p.entries().filter(x=>x.status==='active').map(x=>'<div class="personal-card personal-row"><span>'+'<span>'+esc(p.KEY_LABEL[x.key])+'</span> · <span>'+esc(p.VALUE_LABEL[x.value])+'</span>'+'</span><button data-pref="'+esc(x.id)+'">删除</button></div>').join('')||'<p class="muted">尚无已记录偏好。</p>';}
 prefs();MTPreferences.subscribe(prefs);$('memoryEnabled').onchange=()=>run(async()=>{const ok=await MTPreferences.setEnabled($('memoryEnabled').checked);prefs();status(ok?'偏好设置已保存':'未能保存，请检查存储权限');});$('preferenceList').onclick=e=>{const b=e.target.closest('[data-pref]');if(b)run(async()=>{const r=await MTPreferences.remove(b.dataset.pref);prefs();status(r.ok?'已删除偏好':'未能删除偏好');});};$('clearPreferences').onclick=()=>{if(confirm(MTLanguage.t('清空全部长期偏好？已保存行程保持不变。')))run(async()=>{const r=await MTPreferences.clear();prefs();status(r.ok?'偏好已清空':'清空失败，原数据保留');});};
 $('exportData').onclick=()=>run(()=>{download('mixtouring-backup.json',JSON.stringify(store.backup(),null,2));status('备份已生成');});
 let pending=null;$('importFile').onchange=()=>run(async()=>{pending=null;$('importPreview').hidden=true;const f=$('importFile').files[0];if(!f)return;if(f.size>8*1024*1024)throw Error('备份超过8 MB');const text=await f.text(),data=store.inspect(text);pending=text;$('importSummary').textContent=importSummary(data);$('importPreview').hidden=false;});$('cancelImport').onclick=()=>{pending=null;$('importPreview').hidden=true;$('importFile').value='';};$('confirmImport').onclick=()=>run(async()=>{if(!pending)return;$('confirmImport').disabled=true;try{await store.restore(pending);pending=null;$('importPreview').hidden=true;status('导入完成');}finally{$('confirmImport').disabled=false;}});
 $('clearData').onclick=()=>run(async()=>{const select=$('clearCategory'),label=select.selectedOptions[0].textContent;if(!confirm(MTLanguage.locale()==='en'?'Clear '+label+' in this browser? This cannot be undone. Export a backup first.':'确认清除当前浏览器的'+label+'？此操作无法撤销，建议先导出备份。'))return;const keys={drafts:['mt:drafts'],collections:['mt:collections','mt:favs'],legacy:['mt:wishlist','mt:feedback']}[select.value];await store.clearKeys(keys);status('所选本机数据已清除');});
}
if($('feedbackForm')){let preview='';$('feedbackForm').onsubmit=e=>{e.preventDefault();preview=JSON.stringify({product:'MixTouring',version:'personal-phase-1',message:$('feedbackText').value.trim()},null,2);$('feedbackBody').textContent=preview;$('feedbackPreview').hidden=false;};$('feedbackText').oninput=()=>{$('feedbackPreview').hidden=true;preview='';};$('downloadFeedback').onclick=()=>{if(preview)download('mixtouring-feedback.json',preview);};}
// 只为实际渲染出的来源添加收藏，不构造预置资料。
if(location.pathname.endsWith('/trip.html')){
 function attachSave(a,item,cls){
  if(a.nextElementSibling?.classList.contains(cls))return;
  const b=document.createElement('button');b.className=cls;b.type='button';
  function current(){return store.list().find(x=>item.url?x.url===item.url:x.type===item.type&&x.title===item.title&&x.city===item.city);}
  function paint(){const on=!!current();b.setAttribute('aria-pressed',String(on));b.innerHTML='<img src="../assets/heart-'+(on?'red':'gray')+'.svg" alt=""><span>'+(on?'取消收藏':item.type==='place'?'收藏地点':'收藏资料')+'</span>';}
  b.onclick=()=>run(async()=>{b.disabled=true;try{const saved=current();if(saved)await store.remove(saved.id);else await store.add(item);paint();}finally{b.disabled=false;}});
  a.after(b);try{paint();}catch(e){b.textContent='收藏';b.disabled=true;}
 }
 function wire(){
  document.querySelectorAll('[data-focus-place]').forEach(a=>attachSave(a,{type:'place',title:a.dataset.focusPlace,city:a.dataset.focusPlace},'save-place'));
  document.querySelectorAll('a.source-card,a.transport-source').forEach(a=>attachSave(a,{type:'link',title:(a.querySelector('.source-title')?.textContent||a.textContent).trim().slice(0,300),url:a.href},'save-source'));
 }
 const observer=new MutationObserver(wire);observer.observe(document.body,{childList:true,subtree:true});wire();
}
})();
