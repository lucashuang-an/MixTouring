(function(root){
 'use strict';
 async function request(url,body,signal,onProgress,options){
  options=options || {};
  var controller=new AbortController(),timer=setTimeout(function(){controller.abort(new Error('回复超时，原方案已保留，请重试。'));},options.timeoutMs || 780000);
  var abort=function(){controller.abort(signal.reason);},reader=null;
  var abortReader=function(){if(reader)reader.cancel().catch(function(){});};
  if(signal){if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});}
  try{
   if(controller.signal.aborted)throw controller.signal.reason;
   var response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({},body,{progressive:true})),signal:controller.signal});
   if(!response.ok)throw Error(response.status===413?'本次提交内容过大，请缩短输入后重试。':response.status===408?'请求提交超时，原方案已保留，请重试。':response.status===429?'当前请求较多，请稍后重试。':'服务暂时不可用，请重试。');
   if(!response.body)throw Error('回复为空，原方案已保留，请重试。');
   var ndjson=(response.headers.get('content-type') || '').includes('application/x-ndjson');
   reader=response.body.getReader();controller.signal.addEventListener('abort',abortReader,{once:true});if(controller.signal.aborted)throw controller.signal.reason;var decoder=new TextDecoder('utf-8',{fatal:true}),buffer='',received=0;
   function parse(value){try{return JSON.parse(value);}catch(e){throw Error('回复格式异常，原方案已保留，请重试。');}}
   function consume(line){if(!line.trim())return null;var event=parse(line);if(event.type==='result'){if(!event.response || ![0,1].includes(event.response.code))throw Error('回复格式异常，原方案已保留，请重试。');return event.response;}if(event.type==='progress'&&typeof event.label==='string'&&event.label.length<100&&typeof onProgress==='function')onProgress(event.label);return null;}
   while(true){
    var chunk=await reader.read();if(controller.signal.aborted)throw controller.signal.reason;
    received+=chunk.value?.byteLength || 0;if(received>(options.maxBytes || 8*1024*1024))throw Error('回复过大，原方案已保留，请重试。');
    buffer+=decoder.decode(chunk.value || new Uint8Array(),{stream:!chunk.done});
    if(ndjson){var cut;while((cut=buffer.indexOf('\n'))>=0){var result=consume(buffer.slice(0,cut));buffer=buffer.slice(cut+1);if(result)return result;}}
    if(chunk.done){if(!ndjson)return parse(buffer);var result=consume(buffer);if(result)return result;throw Error('回复中断，原方案已保留，请重试。');}
   }
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',abortReader);if(reader){await reader.cancel().catch(function(){});reader.releaseLock();}}
 }
 var api={request:request};if(typeof module==='object'&&module.exports)module.exports=api;else root.MTConversationProgress=api;
})(typeof window!=='undefined'?window:globalThis);
