import {PassThrough} from 'node:stream';
// 只映射真实事件，不传模型正文、来源或工具参数，也不估造百分比。
export function progressLabel(event){
 if(event.status==='retry_wait'&&event.reason_code==='rate_limited')return '模型暂时限流，等待后重试…';
 if(event.status==='retry'&&event.reason_code==='rate_limited')return '模型暂时限流，正在重试…';
 if(event.status==='retry'&&['service_unavailable','network_or_timeout','timeout','request_timeout','temporary_request'].includes(event.reason_code))return '模型暂时未响应，正在重试…';
 if(event.status!=='started')return null;
 const stage=event.stage;
 if(stage==='tool_call'&&event.tool==='transport_recheck')return '正在查询所选交通方式…';
 if(stage==='search')return '正在查找旅行资料…';
 if(stage==='planning_transport_scope')return '正在定位受影响的交通日…';
 if(stage==='conversation_transport_revision')return '正在调整交通日安排…';
 if(stage==='planning_transport_review')return '正在检查与其他日期的衔接…';
 if(/evidence|numeric|quality|review/.test(stage || ''))return '正在核对行程内容…';
 if(stage==='conversation'&&event.phase==='compose')return '正在编排每日行程…';
 if(['conversation_intent','conversation_intake','conversation_understand','conversation'].includes(stage))return '正在理解你的要求…';
 return null;
}
export function conversationStream(execute,signal){
 const stream=new PassThrough();let previous='';
 const abort=()=>stream.end();signal?.addEventListener('abort',abort,{once:true});
 stream.once('close',()=>signal?.removeEventListener('abort',abort));
 if(signal?.aborted){signal.removeEventListener('abort',abort);abort();return stream;}
 const send=value=>{if(signal?.aborted||stream.destroyed||stream.writableEnded)return false;try{stream.write(JSON.stringify(value)+'\n');return true;}catch{return false;}};
 Promise.resolve().then(()=>signal?.aborted?null:execute(event=>{const label=progressLabel(event);if(label&&label!==previous){previous=label;send({type:'progress',label});}}))
 .then(response=>{if(!send({type:'result',response}))send({type:'result',response:{code:1,msg:'回复未能完整传输，原方案已保留。'}});},()=>send({type:'result',response:{code:1,msg:'本轮未完成，原方案已保留。'}})).finally(()=>{signal?.removeEventListener('abort',abort);stream.end();}).catch(()=>stream.destroy());
 return stream;
}
