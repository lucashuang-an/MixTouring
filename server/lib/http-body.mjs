/* 有界JSON请求读取：按字节累计，避免UTF-8跨网络分块损坏。 */
export function readJsonBody(req,{maxBytes=2*1024*1024,timeoutMs=30000}={}){
 return new Promise((resolve,reject)=>{
  let chunks=[],size=0,settled=false;
  const ignoreError=()=>{},drain=()=>{req.once('error',ignoreError);req.resume();};
  const error=(status,message)=>Object.assign(Error(message),{status,expose:true});
  const cleanup=()=>{clearTimeout(timer);req.off('data',onData);req.off('end',onEnd);req.off('aborted',onAbort);req.off('error',onError);};
  const finish=(err,value)=>{if(settled)return;settled=true;cleanup();chunks=[];err?reject(err):resolve(value);};
  const onData=chunk=>{const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>maxBytes){finish(error(413,'提交内容过大，请缩短本次输入后重试。'));drain();return;}chunks.push(bytes);};
  const onEnd=()=>{try{const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));const value=raw.trim()?JSON.parse(raw):{};if(!value||typeof value!=='object'||Array.isArray(value))throw Error('object_required');finish(null,value);}catch{finish(error(400,'请求内容不是有效的JSON对象。'));}};
  const onAbort=()=>{req.once('error',ignoreError);finish(error(400,'请求提交已中断。'));};
  const onError=()=>finish(error(400,'请求提交未完成。'));
  const timer=setTimeout(()=>{finish(error(408,'请求提交超时，请重试。'));drain();},timeoutMs);timer.unref?.();
  req.on('data',onData);req.once('end',onEnd);req.once('aborted',onAbort);req.once('error',onError);
  if(req.aborted)onAbort();
 });
}
