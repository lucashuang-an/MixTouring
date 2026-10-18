/* 资料任务只记录查询进度；保存与恢复不会把计数变成已核实事实。 */
(function(root,factory){var api=factory();if(typeof module==='object' && module.exports)module.exports=api;else root.MTResearchTasks=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  var TTL=900000,STORE='mt:research-tasks',modes=['unknown','plane','rail','road'];
  var states=['pending','running','interrupted','sources','experience','empty','partial','unavailable','failed','stale','confirmed'];
  var clone=function(v){return JSON.parse(JSON.stringify(v));};
  var count=function(v){return Number.isInteger(v)&&v>=0?Math.min(v,10000):0;};
  function leg(raw){if(!raw || [raw.from,raw.to].some(function(v){return typeof v!=='string' || !v.trim() || v.length>80;}) || raw.from===raw.to || !modes.includes(raw.mode))return null;return {from:raw.from,to:raw.to,mode:raw.mode,exclude_road:raw.exclude_road===true,locked:raw.locked===true};}
  function key(l,window){return JSON.stringify([l.from,l.to,l.mode,l.exclude_road===true,window || null]);}
  function signature(scope){return JSON.stringify([(Array.isArray(scope?.route)?scope.route:[]).slice(0,12),(Array.isArray(scope?.legs)?scope.legs:[]).slice(0,11).map(function(l){return [l?.from,l?.to,l?.mode,!!l?.exclude_road,!!l?.locked];}),scope?.window || null]);}
  function fresh(task,now){var t=Date.parse(task.checked_at);return Number.isFinite(t) && t<=now && now-t<TTL && !task.historical;}
  function sync(scope,previous,options){
    options=options || {};var now=options.now ?? Date.now(),restored=options.restored===true;
    var old=Array.isArray(previous?.tasks)?previous.tasks.slice(0,11):[],priority=options.priority || [];
    var tasks=(Array.isArray(scope?.legs)?scope.legs:[]).slice(0,11).map(function(raw,i){
      var l=leg(raw);if(!l)return null;var id=key(l,scope.window),found=old.find(function(t){return t?.id===id;});
      var task={id:id,leg:l,status:l.locked?'confirmed':'pending',sources:0,experiences:0,checked_at:null,retrieval_id:null,partial:false,historical:false,last_error:null,priority:100+i};
      if(found){task.status=states.includes(found.status)?found.status:'pending';task.sources=count(found.sources);task.experiences=count(found.experiences);task.checked_at=typeof found.checked_at==='string'?found.checked_at.slice(0,40):null;task.last_attempt=typeof found.last_attempt==='string'?found.last_attempt.slice(0,40):null;task.retrieval_id=/^retrieval_[a-z0-9-]{1,100}$/i.test(found.retrieval_id || '')?found.retrieval_id:null;task.partial=found.partial===true;task.historical=found.historical===true;task.last_error=['failed','unavailable','interrupted'].includes(found.last_error)?found.last_error:null;task.previous_status=states.includes(found.previous_status)?found.previous_status:null;task.priority=Number.isInteger(found.priority)?found.priority:task.priority;}
      var rank=priority.findIndex(function(p){return key(p,scope.window)===id;});if(rank>=0)task.priority=rank;
      if(l.locked){task.status='confirmed';task.historical=false;return task;}
      if(restored){if(task.status==='running'){task.status='interrupted';task.last_error='interrupted';task.historical=!!task.checked_at;}else if(task.checked_at){task.previous_status=task.status==='stale'?task.previous_status:task.status;task.status='stale';task.historical=true;}}
      else if(['sources','experience','empty','partial'].includes(task.status) && !fresh(task,now)){task.previous_status=task.status;task.status='stale';task.historical=true;}
      return task;
    }).filter(Boolean);
    return {version:1,scope_key:signature(scope),window:scope?.window || null,tasks:tasks};
  }
  function start(state,queries,now){state=clone(state);var ids=queries.map(function(l){return key(l,state.window);});state.tasks.forEach(function(t){if(ids.includes(t.id) && !t.leg.locked){t.previous_status=t.status;t.status='running';t.last_attempt=new Date(now ?? Date.now()).toISOString();}});return state;}
  function interrupt(state,now){if(!state)return state;state=clone(state);state.tasks.forEach(function(t){if(t.status==='running'){t.status=fresh(t,now ?? Date.now()) && ['sources','experience','empty','partial'].includes(t.previous_status)?t.previous_status:'interrupted';t.last_error='interrupted';}});return state;}
  function apply(state,segments,now){
    state=clone(state);now=now ?? Date.now();
    (segments || []).forEach(function(s){var d=s.data,l=s.leg || d && {from:d.from,to:d.to,mode:d.requested_mode,exclude_road:d.exclude_road};if(!l)return;var task=state.tasks.find(function(t){return t.id===key(l,state.window);});if(!task || task.leg.locked)return;
      var failed=s.status==='failed' || !d,unavailable=d?.status==='unavailable';
      if((failed || unavailable) && fresh(task,now) && task.sources+task.experiences>0){task.status=task.sources?'sources':'experience';task.last_error=failed?'failed':'unavailable';task.last_attempt=new Date(now).toISOString();return;}
      if(failed){task.status='failed';task.last_error='failed';task.last_attempt=new Date(now).toISOString();return;}
      var priorError=task.last_error,attempt=task.last_attempt;
      task.sources=(d.sources || []).length;task.experiences=(d.experiences || []).length;task.checked_at=d.retrieved_at || null;task.retrieval_id=d.retrieval_id || null;task.partial=d.status==='partial';task.historical=false;
      task.status=unavailable?'unavailable':task.sources?'sources':task.experiences?'experience':task.partial?'partial':'empty';
      task.last_error=d.restored_lookup?priorError:unavailable?'unavailable':null;task.last_attempt=d.restored_lookup?attempt:d.retrieved_at || new Date(now).toISOString();
    });return state;
  }
  function select(state,group){return (state?.tasks || []).filter(function(t){if(t.leg.locked || t.status==='running')return false;if(group==='pending')return ['pending','interrupted'].includes(t.status);if(group==='stale')return t.status==='stale';return t.status!=='stale' && (['failed','unavailable','partial'].includes(t.status) || t.partial || t.last_error);}).sort(function(a,b){return a.priority-b.priority;}).slice(0,2).map(function(t){return t.leg;});}
  function label(t){if(t.status==='confirmed')return '你已确认交通 · 未作外部核实';if(t.status==='stale')return '上次查询记录 · 待更新';if(t.status==='running')return '正在查资料';if(t.last_error && t.sources+t.experiences>0)return t.historical?'查询未完成 · 上次资料待更新':'保留上次资料 · 最近补查未完成';var text={pending:'暂无查询记录',interrupted:'查询中断 · 可继续',sources:'有连接线索 · 班期待核',experience:'仅有乘车经验 · 班期待核',empty:'暂未找到匹配资料',partial:'部分通道未完成',unavailable:'查询通道暂不可用',failed:'查询未完成'}[t.status] || '暂无查询记录';return text+(t.partial && ['sources','experience'].includes(t.status)?' · 部分通道未完成':'');}
  function journal(storage){
    function read(){try{var raw=storage.getItem(STORE);if(raw==null)return {entries:[]};var data=JSON.parse(raw);return Array.isArray(data)?{entries:data.slice(0,20)}:{error:true};}catch(e){return {error:true};}}
    return {load:function(scope){var r=read();if(r.error)return {error:true};var entry=r.entries.find(function(e){return e?.key===signature(scope);});return {state:entry?.state || null};},save:function(scope,state){var r=read();if(r.error)return false;var entries=r.entries.filter(function(e){return e?.key!==signature(scope);});entries.unshift({key:signature(scope),state:clone(state)});try{storage.setItem(STORE,JSON.stringify(entries.slice(0,20)));return true;}catch(e){return false;}}};
  }
  return {sync:sync,start:start,interrupt:interrupt,apply:apply,select:select,label:label,key:key,signature:signature,journal:journal,TTL:TTL};
});
