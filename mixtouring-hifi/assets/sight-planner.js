/* 私人活动状态兼容，不装载或推荐固定景点。 */
(function(){'use strict';var state={selected_ids:[]},onChange=null;
  var copy=function(v){return JSON.parse(JSON.stringify(v || {}));};
  function refresh(){var el=document.getElementById('sightDetails');if(el)el.hidden=true;}
  window.MTSights={init:function(box,context,changed){onChange=changed;refresh();},getState:function(){return copy(state);},
    restore:function(saved){state=copy(saved || {selected_ids:[]});refresh();},reset:function(){state={selected_ids:[]};refresh();},
    applyPatch:function(patch){state=Object.assign({},state,copy(patch));if(onChange)onChange();refresh();},refresh:refresh,
    getCatalog:function(){return [];},getComparison:function(){return null;}};
})();
