/* 保存状态比较用户安排与条件；网络来源、阅读状态和临时规划 ID 不构成未保存改动。 */
(function(root,factory){var api=factory();if(typeof module==='object' && module.exports)module.exports=api;else root.MTSaveState=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  function ordered(value){if(Array.isArray(value))return value.map(ordered);if(value && typeof value==='object')return Object.keys(value).sort().reduce(function(out,key){if(value[key]!==undefined)out[key]=ordered(value[key]);return out;},Object.create(null));return value;}
  function key(snapshot){var s=snapshot || {},c=s.conversation || {};return JSON.stringify(ordered({draft:c.draft || null,brief:c.brief || null,routing:c.routing || null,requirements:c.requirements || {},travel:s.travel || {},constraints:s.constraints || {},anchors:s.anchors || {},sights:s.sights || {},preferences:s.preferences || {},messages:(s.messages || []).filter(function(m){return m.role==='user' || m.role==='assistant';}).map(function(m){return {role:m.role,text:m.text};}),candidate:s.candidate_key || s.candidate?.route_key || null,nights:s.nights || 0}));}
  function find(snapshot,listing){
    if(!snapshot?.conversation?.draft)return {saved:false};
    if(snapshot.conversation.preview?.draft)return {saved:false,preview:true};
    if(listing.store_corrupted)return {saved:false,unavailable:true};
    var signature=key(snapshot),match=(listing.drafts || []).find(function(d){return d.versions?.length && key(d.versions.at(-1).snapshot)===signature;});
    return match?{saved:true,versions:match.versions.length,id:match.id}:{saved:false};
  }
  return {key:key,find:find};
});
