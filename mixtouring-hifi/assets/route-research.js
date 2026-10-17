/* 一次选择只补一段关键交通；取消、失败和重试有明确状态。 */
(function(root,factory){var api=factory();if(typeof module==='object' && module.exports)module.exports=api;else root.MTRouteResearch=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  function create(deps){
    var state=null,controller=null,sequence=0,inflight=null,cache=new Map();
    function publish(next){state=next;deps.onChange(next);}
    function cancel(){sequence++;if(controller)controller.abort();controller=null;inflight=null;publish(null);}
    function run(input,force){
      input=JSON.parse(JSON.stringify(input));
      var key=JSON.stringify(input),now=(deps.now || Date.now)();
      if(inflight && state?.key===key)return inflight;
      if(!force && cache.get(key)?.until>now){if(controller)controller.abort();controller=null;sequence++;inflight=null;publish(cache.get(key).state);return Promise.resolve(state);}
      if(controller)controller.abort();controller=new AbortController();var signal=controller.signal,seq=++sequence;
      publish({key,input,status:'pending'});
      inflight=(async function(){try{
        var response=await deps.request(input,signal);
        if(seq!==sequence || signal.aborted)return {status:'cancelled'};
        if(response.code!==0 || !response.data)throw Error(response.msg || '检索未完成');
        var next={key,input,status:'complete',data:response.data};cache.set(key,{until:now+300000,state:next});while(cache.size>12)cache.delete(cache.keys().next().value);publish(next);return next;
      }catch(error){if(seq!==sequence || signal.aborted)return {status:'cancelled'};var next={key,input,status:'failed',error:'补查暂未完成，交通仍保留待查；你可以继续完善或重新补查。'};publish(next);return next;}
      finally{if(seq===sequence){inflight=null;controller=null;}}})();
      return inflight;
    }
    return {run:run,cancel:cancel,getState:function(){return state;},isPending:function(){return state?.status==='pending';}};
  }
  return {create:create};
});
