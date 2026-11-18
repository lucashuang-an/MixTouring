// 只使用全局公网fetch。部署必须启用global_fetch_strictly_public；
// 不使用服务、VPC或源站绑定，不能凭资料URL触达私有服务。
export async function publicHttp(url,{signal,maxBytes=524288,fetchImpl=fetch}={}){
  const response=await fetchImpl(url.href,{redirect:'manual',signal,headers:{'user-agent':'MixTouring-PublicReader/1.0',accept:'text/html,application/xhtml+xml'}});
  const headers=Object.fromEntries(response.headers),status=response.status;
  if(status!==200){await response.body?.cancel();return {status,headers,body:Buffer.alloc(0)};}
  const type=(headers['content-type']||'').split(';')[0].trim().toLowerCase();
  if(!['text/html','application/xhtml+xml'].includes(type)){await response.body?.cancel();return {status,headers,body:Buffer.alloc(0)};}
  const reader=response.body?.getReader(),chunks=[];let size=0;
  if(!reader)return {status,headers,body:Buffer.alloc(0)};
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>maxBytes)throw Object.assign(Error('body too large'),{reader_code:'body_too_large'});
    chunks.push(Buffer.from(value));
  }}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  return {status,headers,body:Buffer.concat(chunks)};
}
