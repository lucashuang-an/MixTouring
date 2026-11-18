(()=>{'use strict';const user=window.MTAccount;if(!user)return;
// 唯一的旧邀请账号沿用原浏览器存储；新账号始终使用独立命名空间。
const prefix=user.legacy_local===true?'':'mt:user:'+user.id+':';
const wrap=storage=>({getItem:key=>storage.getItem(prefix+key),setItem:(key,value)=>storage.setItem(prefix+key,value),removeItem:key=>storage.removeItem(prefix+key)});
window.MTLocalStorage=wrap(window.localStorage);window.MTSessionStorage=wrap(window.sessionStorage);
const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('mt-account-session'):null;
channel?.addEventListener('message',()=>location.replace('/pages/login.html'));
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
document.addEventListener('DOMContentLoaded',()=>{const menu=document.getElementById('accountMenu'),toggle=document.getElementById('accountToggle');
if(toggle){toggle.setAttribute('aria-label',user.username);const label=toggle.querySelector('span:not([aria-hidden])');if(label)label.textContent=user.username;}
if(menu){const logout=document.createElement('button');logout.type='button';logout.textContent='退出登录';logout.onclick=async()=>{logout.disabled=true;try{const response=await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw Error();channel?.postMessage('logout');location.replace('/pages/login.html');}catch{logout.disabled=false;logout.textContent='退出失败，重试';}};menu.append(logout);}
});
})();
