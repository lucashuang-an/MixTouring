/* 后端启动指纹仅覆盖代码、规则及依赖清单，不读取环境或运行数据。 */
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
export function backendVersion(root){
 const files=['AGENTS.md','server/index.mjs','server/package.json','server/package-lock.json',...readdirSync(join(root,'server','lib')).filter(name=>name.endsWith('.mjs')).map(name=>'server/lib/'+name)].sort();
 const hash=createHash('sha256');for(const file of files){hash.update(file);hash.update('\0');hash.update(readFileSync(join(root,file)));}
 return 'runtime-'+hash.digest('hex').slice(0,16);
}
export const RUNTIME_VERSION=backendVersion(fileURLToPath(new URL('../../',import.meta.url)));
