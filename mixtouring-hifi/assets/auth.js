(()=>{'use strict';
const $=id=>document.getElementById(id),lang=()=>window.MTLanguage,t=text=>lang()?.t(text)||text;let register=false,busy=false;
function render(){
 $('title').textContent=t(register?'开启你的下一趟旅行':'欢迎回来');$('intro').textContent=t(register?'用邀请码创建 MixTouring 账号。':'登录，继续规划下一趟旅行。');
 $('registerFields').hidden=!register;for(const id of ['confirmPassword','invite']){$(id).required=register;$(id).disabled=!register;}
 $('password').autocomplete=register?'new-password':'current-password';$('submit').disabled=busy;$('submit').textContent=t(busy?(register?'正在创建账号…':'正在登录…'):(register?'注册并登录':'登录'));
 $('switchText').textContent=t(register?'已有账号？':'还没有账号？');$('switchMode').textContent=t(register?'去登录':'邀请码注册');
 const visible=$('password').type==='text';$('showPassword').textContent=t(visible?'隐藏':'显示');$('showPassword').setAttribute('aria-label',t(visible?'隐藏密码':'显示密码'));
 if($('authLanguage'))$('authLanguage').value=lang()?.get()||'en';document.title='MixTouring · '+t(register?'注册':'登录');
}
$('switchMode').onclick=()=>{if(busy)return;register=!register;$('error').textContent='';render();};
$('showPassword').onclick=()=>{$('password').type=$('password').type==='password'?'text':'password';render();};
if($('authLanguage'))$('authLanguage').onchange=()=>{try{lang().set($('authLanguage').value);$('error').textContent='';}catch{$('error').textContent=t('语言未保存，请检查浏览器存储权限');}render();};
$('authForm').onsubmit=async event=>{event.preventDefault();if(busy)return;$('error').textContent='';if(register&&$('password').value!==$('confirmPassword').value){$('error').textContent=t('两次输入的密码不一致');$('confirmPassword').focus();return;}busy=true;render();try{
 const response=await fetch('/api/auth/'+(register?'register':'login'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('username').value,password:$('password').value,invite:register?$('invite').value:undefined})});
 const result=await response.json();if(!response.ok)throw Error(result.msg||'暂时无法登录，请稍后再试');
 if(typeof BroadcastChannel==='function'){const channel=new BroadcastChannel('mt-account-session');channel.postMessage('login');channel.close();}location.replace('/pages/trip.html');
 }catch(error){$('error').textContent=t(error instanceof TypeError?'网络连接失败，请重试':error.message);}finally{busy=false;render();}};
window.addEventListener('storage',event=>{if(event.key===lang()?.KEY||event.key===null)render();});
window.addEventListener('languagechange',render);
render();
})();
