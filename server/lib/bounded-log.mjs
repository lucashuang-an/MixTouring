/* 诊断日志不参与状态提交；轮转有界，跨进程竞争不覆盖其他写入。 */
import {appendFileSync,writeFileSync,mkdirSync,openSync,closeSync,existsSync,statSync,readFileSync,renameSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
export function appendBoundedJsonl(path,record,{maxBytes=8*1024*1024,archives=3,maxRecordBytes=1024*1024}={}){
 const lock=path+'.lock';let fd;
 try{
  mkdirSync(dirname(path),{recursive:true});
  for(let attempt=0;attempt<25;attempt++){
   try{fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));break;}catch(error){
    if(error.code!=='EEXIST')throw error;
    try{if(Date.now()-statSync(lock).mtimeMs>60000){const owner=Number(readFileSync(lock,'utf8'));let dead=!Number.isSafeInteger(owner)||owner<=0;if(!dead){try{process.kill(owner,0);}catch(e){dead=e.code==='ESRCH';}}if(dead)unlinkSync(lock);}}catch{}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);
   }
  }
  if(fd===undefined)return false;
  let line=JSON.stringify(record)+'\n',bytes=Buffer.byteLength(line);
  if(bytes>Math.min(maxRecordBytes,maxBytes))line=JSON.stringify({at:new Date().toISOString(),task_id:record?.task_id || null,status:record?.status || null,truncated:true,original_bytes:bytes})+'\n';
  if(existsSync(path)&&statSync(path).size+Buffer.byteLength(line)>maxBytes){
   if(archives>0){if(existsSync(path+'.'+archives))unlinkSync(path+'.'+archives);for(let i=archives-1;i>=1;i--)if(existsSync(path+'.'+i))renameSync(path+'.'+i,path+'.'+(i+1));renameSync(path,path+'.1');}
   else unlinkSync(path);
  }
  appendFileSync(path,line,{encoding:'utf8',mode:0o600});return true;
 }catch{return false;}finally{if(fd!==undefined){try{closeSync(fd);}catch{}try{unlinkSync(lock);}catch{}}}
}
