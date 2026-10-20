/* 本机跨旅行软偏好。读取、写入、请求版本与界面反馈独立于旅行快照。 */
(function () {
  'use strict';
  var KEY='mt:preference-memory',SCHEMA=1;
  var VALUES={pace:['simple','explore','any'],road:['open','prefer_other','exclude'],preferred_mode:['rail','plane'],experience:['balanced','city','nature'],nature_theme:['mountains','canyon','lake','forest']};
  var LABEL={pace:'节奏偏好',road:'公路接受度',preferred_mode:'优先交通',experience:'体验搭配',nature_theme:'自然主题'};
  var VALUE_LABEL={simple:'优先省心到达',explore:'愿意沿途探索',any:'保留全部方向',open:'允许公路走法',prefer_other:'尽量少坐公路客运',exclude:'不坐公路客运',rail:'优先铁路',plane:'优先航班',balanced:'城区与自然搭配',city:'偏重城区',nature:'偏重自然',mountains:'山景',canyon:'峡谷',lake:'湖泊',forest:'森林'};
  var subscribers=[],epoch=0,sessionPaused=false,lastError=null;
  var state=empty(),health='ready',loaded=false,queue=Promise.resolve();
  function empty(){return {schema_version:SCHEMA,store_id:null,enabled:false,entries:[],next_id:1,revision:0};}
  function clone(v){return JSON.parse(JSON.stringify(v));}
  function validValue(k,v){return Object.prototype.hasOwnProperty.call(VALUES,k) && VALUES[k].indexOf(v)>=0;}
  function read(){
    var raw;
    try{raw=localStorage.getItem(KEY);}catch(e){return {state:empty(),raw:null,health:'read_failed'};}
    if(raw===null)return {state:empty(),raw:null,health:'ready'};
    try{
      var p=JSON.parse(raw);
      if(!p || typeof p!=='object' || Array.isArray(p))throw Error('格式错误');
      if(p.schema_version!==SCHEMA || p.degraded)return {state:empty(),raw:raw,health:'unsupported_schema'};
      if(typeof p.enabled!=='boolean' || !Array.isArray(p.entries) || !Number.isSafeInteger(p.revision) || p.revision<0 || !Number.isSafeInteger(p.next_id) || p.next_id<1)throw Error('字段错误');
      var ids=new Set(),active=new Set(),max=0;
      p.entries.forEach(function(e){
        if(!e || !/^pref_\d+$/.test(e.id) || ids.has(e.id) || !validValue(e.key,e.value) || ['active','removed'].indexOf(e.status)<0 || !Number.isSafeInteger(e.revision) || e.revision<0)throw Error('条目错误');
        if(e.status==='active' && active.has(e.key))throw Error('条目重复');
        ids.add(e.id);if(e.status==='active')active.add(e.key);max=Math.max(max,Number(e.id.slice(5)));
      });
      if(p.next_id<=max)throw Error('身份错误');
      return {state:{schema_version:SCHEMA,store_id:typeof p.store_id==='string'?p.store_id:'legacy',enabled:p.enabled,entries:clone(p.entries),next_id:p.next_id,revision:p.revision},raw:raw,health:'ready'};
    }catch(e){return {state:empty(),raw:raw,health:'corrupted_store'};}
  }
  function refresh(){var r=read();state=r.state;health=r.health;loaded=true;return r;}
  function ensure(){if(!loaded)refresh();}
  function notify(reason){subscribers.slice().forEach(function(fn){try{fn(reason);}catch(e){console.warn('偏好面板暂未刷新');}});}
  function failure(reason){lastError=reason;notify();return {ok:false,reason:reason};}
  function snapshot(){
    refresh();
    var enabled=health==='ready' && state.enabled && !sessionPaused;
    return {enabled:enabled,store_id:state.store_id,revision:state.revision,epoch:epoch,
      preferences:enabled?state.entries.filter(function(e){return e.status==='active';}).map(function(e){return {key:e.key,value:e.value};}):[]};
  }
  function matches(request){return request && request.enabled===true && request.store_id===state.store_id && request.revision===state.revision && request.epoch===epoch;}
  function locked(task){
    var run=function(){return typeof navigator!=='undefined' && navigator.locks? navigator.locks.request('mixtouring-preference-memory',task):task();};
    var result=queue.then(run,run);queue=result.catch(function(){});return result;
  }
  function transaction(change,request,isCurrent){
    return locked(function(){
      var current=refresh();
      if(health!=='ready')return failure(health);
      if(isCurrent && !isCurrent())return {ok:false,reason:'stale_response'};
      if(request && (!matches(request) || !state.enabled || sessionPaused))return {ok:false,reason:'stale_response'};
      var next=clone(state),outcome=change(next);
      if(outcome.ok===false)return failure(outcome.reason);
      if(!outcome.changed)return outcome;
      var check=read();
      if(check.health!=='ready')return failure(check.health);
      if(check.raw!==current.raw){refresh();epoch++;notify();return {ok:false,reason:'stale_response'};}
      if(!next.store_id || next.store_id==='legacy')next.store_id='device_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2);
      next.revision=state.revision+1;
      try{localStorage.setItem(KEY,JSON.stringify(next));}
      catch(e){sessionPaused=true;epoch++;return failure('write_failed');}
      state=next;health='ready';loaded=true;lastError=null;epoch++;notify();return outcome;
    });
  }
  function upsert(next,items,mid){
    var changed=0,ids=[],now=new Date().toISOString();
    items.forEach(function(item){
      var entry=next.entries.find(function(e){return e.key===item.key && e.status==='active';});
      if(entry && entry.value===item.value){ids.push(entry.id);return;}
      if(entry){entry.value=item.value;entry.updated_at=now;entry.revision++;entry.source_message_mid=mid;}
      else{entry={id:'pref_'+next.next_id++,key:item.key,value:item.value,status:'active',source_message_mid:mid,revision:0,created_at:now,updated_at:now};next.entries.push(entry);}
      ids.push(entry.id);changed++;
    });
    return {ok:true,changed:changed,ids:ids,id:ids[0]};
  }
  var api={
    KEY:KEY,SCHEMA_VERSION:SCHEMA,KEYS:Object.keys(VALUES),KEY_LABEL:LABEL,VALUE_LABEL:VALUE_LABEL,
    isEnabled:function(){ensure();return health==='ready' && state.enabled && !sessionPaused;},
    entries:function(){ensure();return clone(state.entries);},
    list:function(){ensure();return this.isEnabled()?clone(state.entries.filter(function(e){return e.status==='active';})):[];},
    status:function(){ensure();return {health:health,error:lastError,paused:sessionPaused,enabled:this.isEnabled(),stored_enabled:state.enabled,revision:state.revision};},
    subscribe:function(fn){subscribers.push(fn);return function(){subscribers=subscribers.filter(function(x){return x!==fn;});};},
    reload:function(){sessionPaused=false;lastError=null;epoch++;refresh();notify();return this.status();},
    setEnabled:async function(value){
      epoch++;
      var result=await transaction(function(next){var changed=next.enabled!==(value===true);next.enabled=value===true;return {ok:true,changed:changed};});
      if(result.ok){sessionPaused=false;lastError=null;notify();}
      return result.ok;
    },
    remove:function(id){
      epoch++;
      return transaction(function(next){var entry=next.entries.find(function(e){return e.id===id && e.status==='active';});if(!entry)return {ok:false,reason:'not_found'};entry.status='removed';entry.updated_at=new Date().toISOString();entry.revision++;return {ok:true,changed:1};});
    },
    snapshotForRequest:snapshot,
    propose:function(key,value,messageRef){return this.applyUpserts([{key:key,value:value}],messageRef,snapshot());},
    applyUpserts:function(items,messageRef,request,options){
      if(!Number.isSafeInteger(messageRef) || messageRef<0)return Promise.resolve({ok:false,reason:'missing_user_reference'});
      if(!Array.isArray(items) || items.length>5 || items.some(function(u){return !validValue(u && u.key,u && u.value);}))return Promise.resolve({ok:false,reason:'invalid_preference'});
      if(!request || request.enabled!==true)return Promise.resolve({ok:false,reason:'memory_disabled'});
      return transaction(function(next){return upsert(next,items,messageRef);},request,options && options.isCurrent);
    },
    _state:function(){ensure();return clone(state);}
  };
  if(typeof window!=='undefined' && window.addEventListener)window.addEventListener('storage',function(event){if(event.key===KEY || event.key===null){epoch++;refresh();notify('external');}});
  if(typeof window!=='undefined')window.MTPreferences=api;
  if(typeof module!=='undefined' && module.exports)module.exports=api;
})();
