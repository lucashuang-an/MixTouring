(function(){
const key='mt:theme',media=matchMedia('(prefers-color-scheme: dark)');
function selected(){try{return localStorage.getItem(key)||'system';}catch(e){return 'system';}}
function apply(){const value=selected();document.documentElement.dataset.theme=value==='dark'||(value==='system'&&media.matches)?'dark':'light';}
apply();media.addEventListener('change',apply);window.addEventListener('storage',e=>{if(e.key===key||e.key===null)apply();});
window.MTTheme={get:selected,set(value){if(!['light','dark','system'].includes(value))throw Error('外观选项错误');localStorage.setItem(key,value);apply();}};
})();
