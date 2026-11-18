/* 启动指纹覆盖后端、实际静态资源、规则及依赖清单，不读取环境或运行数据。 */
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
export function backendVersion(root){
 const files=['AGENTS.md','server/index.mjs','server/package.json','server/package-lock.json',...readdirSync(join(root,'server','lib')).filter(name=>name.endsWith('.mjs')).map(name=>'server/lib/'+name)];
 const walk=folder=>{for(const entry of readdirSync(join(root,folder),{withFileTypes:true})){
  if(entry.name.startsWith('.') || ['logs','node_modules'].includes(entry.name))continue;
  const path=folder+'/'+entry.name;
  if(entry.isSymbolicLink())throw Error('运行资源不能使用符号链接');
  if(entry.isDirectory())walk(path);else if(/\.(?:html|js|css|json|svg|png|jpe?g|webp|ico|woff2?|ttf)$/.test(entry.name))files.push(path);
 }};
 walk('mixtouring-hifi');files.sort();
 const hash=createHash('sha256');for(const file of files){hash.update(file);hash.update('\0');hash.update(readFileSync(join(root,file)));}
 return 'runtime-'+hash.digest('hex').slice(0,16);
}
export const RUNTIME_VERSION=backendVersion(fileURLToPath(new URL('../../',import.meta.url)));
