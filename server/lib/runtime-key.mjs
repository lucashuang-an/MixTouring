/* 本机授权签名密钥：排他创建并跨进程复用；损坏时失败，不静默换钥。 */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
export function loadOrCreateKey(path,{legacyPath}={}){
 mkdirSync(dirname(path),{recursive:true});
 if(!existsSync(path)){
  let key=randomBytes(32);
  if(legacyPath&&existsSync(legacyPath)){key=readFileSync(legacyPath);if(key.length!==32)throw Error('旧版规划授权密钥格式无效，未自动覆盖');}
  try{writeFileSync(path,key,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
 }
 // 并发首次启动可能看到排他创建后、写入完成前的空文件，只等待初始化，不换钥。
 for(let attempt=0;attempt<20;attempt++){
  const key=readFileSync(path);if(key.length===32)return key;
  if(key.length!==0)break;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
 }
 throw Error('本机规划授权密钥格式无效，未自动覆盖');
}
