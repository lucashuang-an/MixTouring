/* 用户明确选择的地点加入指定日卡；不推断交通、时间或新的地点事实。 */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MTSavedPlacement=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const clone=x=>JSON.parse(JSON.stringify(x));
  const normalize=x=>String(x||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase();
  function create(store,workspace){
    function add({tripId,versionId,cardId,item,language='en'}){
      const trip=store.get(tripId),latest=trip?.versions.at(-1);
      if(!latest)return {ok:false,reason:'not_found'};
      if(latest.vid!==versionId)return {ok:false,reason:'stale_version'};
      const before=clone(latest.snapshot),snapshot=clone(before),conversation=snapshot.conversation;
      if(!conversation?.draft || conversation.preview)return {ok:false,reason:'invalid_target'};
      const index=conversation.draft.cards?.findIndex(c=>c.id===cardId);
      if(index===undefined || index<0)return {ok:false,reason:'invalid_target'};
      if(item?.type!=='place' || typeof item.title!=='string' || !item.title.trim() || item.title.length>300)return {ok:false,reason:'invalid_place'};
      const title=item.title.replace(/[\r\n]+/g,' ').trim(),card=conversation.draft.cards[index];
      if(typeof card.content!=='string'||typeof card.title!=='string')return {ok:false,reason:'invalid_target'};
      const named=[...card.content.matchAll(/`([^`\n]+)`/g)].map(m=>m[1]).concat((card.activities||[]).flatMap(a=>(a.places||[]).map(p=>p.name)));
      const added=card.content.split('\n').map(s=>s.replace(/^\s*-\s*/,''));
      if(named.some(n=>normalize(n)===normalize(title))||added.some(s=>[normalize('Added place: '+title+'.'),normalize('补充地点：'+title+'。')].includes(normalize(s))))return {ok:true,duplicate:true,vid:latest.vid,tripId};
      const line=language==='en'?'Added place: '+title+'.':'补充地点：'+title+'。';
      const content=card.content+'\n- '+line;
      if(content.length>6000)return {ok:false,reason:'day_too_long'};
      const changed=workspace.cleanDraft({route:conversation.draft.route,cards:[{...card,content}]} )?.cards[0];
      if(!changed || changed.id!==card.id)return {ok:false,reason:'invalid_target'};
      conversation.draft.cards[index]=changed;
      conversation.draft.quality_status='unreviewed';
      conversation.revision=(Number(conversation.revision)||0)+1;
      const command=language==='en'?'Add '+title+' to '+(card.label||card.title)+'. Keep all other days unchanged.':'将'+title+'加入'+(card.label||card.title)+'，其他日期保持不变。';
      snapshot.messages=[...(snapshot.messages||[]),{role:'user',text:command,mid:Math.max(0,...(snapshot.messages||[]).map(m=>Number(m.mid)||0))+1}];
      snapshot.saved_draft_id=tripId;
      const result=store.save(trip.name,snapshot,{id:tripId,expected_vid:versionId});
      return result.ok?{...result,tripId,day:card.label||card.title,title,undo:{tripId,expectedVid:result.vid,before}}:result;
    }
    function undo(token){
      const trip=store.get(token?.tripId),latest=trip?.versions.at(-1);
      if(!latest)return {ok:false,reason:'not_found'};
      if(latest.vid!==token.expectedVid)return {ok:false,reason:'stale_version'};
      const snapshot=clone(token.before);
      snapshot.conversation.revision=(Number(latest.snapshot.conversation?.revision)||0)+1;
      return store.save(trip.name,snapshot,{id:trip.id,expected_vid:token.expectedVid});
    }
    function href(tripId,vid){const trip=store.get(tripId),version=trip?.versions.find(v=>v.vid===vid),request=version?.snapshot.request;if(!request)return null;const q=new URLSearchParams({restore:'1',draft:tripId,ver:vid});if(request.origin)q.set('from',request.origin);if(request.destination)q.set('to',request.destination);if(request.text)q.set('text',request.text);return 'trip.html?'+q;}
    return {add,undo,href};
  }
  return {create};
});
