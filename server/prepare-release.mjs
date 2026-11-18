/* 以当前工作区生成独立部署包，包含未提交运行文件，不携带私有状态或密钥。 */
import {mkdirSync,readdirSync,lstatSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {join,resolve,dirname,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {backendVersion} from './lib/runtime-version.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
export function prepareRelease(destination){
 const output=resolve(destination);
 if(output===resolve(root)||output.startsWith(resolve(root)+sep))throw Error('发布目录须在仓库之外，且不得已存在');
 mkdirSync(output,{recursive:false});
 const files=[];
 const copy=path=>{const source=join(root,path);if(!lstatSync(source).isFile())throw Error('发布文件类型无效：'+path);mkdirSync(dirname(join(output,path)),{recursive:true});copyFileSync(source,join(output,path));files.push(path.replaceAll('\\','/'));};
 const walk=(folder,extensions)=>{for(const entry of readdirSync(join(root,folder),{withFileTypes:true})){
  if(entry.name.startsWith('.')||['node_modules','logs'].includes(entry.name))continue;
  const path=join(folder,entry.name);if(entry.isSymbolicLink())throw Error('发布目录不接受符号链接：'+path);
  if(entry.isDirectory())walk(path,extensions);else if(extensions.includes(extname(entry.name)))copy(path);
 }};
 for(const path of ['AGENTS.md','DEVELOPMENT.md','Dockerfile','.dockerignore','compose.yaml','deploy.env.example','server/package.json','server/package-lock.json','server/index.mjs','server/create-invite.mjs','server/check-container.mjs','server/check-release-config.mjs','server/smoke-release.mjs','server/check-public-http.mjs','server/check-user-isolation.mjs','server/verify.mjs'])copy(path);
 walk('server/lib',['.mjs']);walk('deploy',['.example']);
 walk('mixtouring-hifi',['.html','.js','.css','.json','.svg','.png','.jpg','.jpeg','.webp','.ico','.woff2','.woff','.ttf']);
 const entries=files.sort().map(path=>({path,sha256:createHash('sha256').update(readFileSync(join(output,path))).digest('hex')}));
 const contentHash=createHash('sha256').update(JSON.stringify(entries)).digest('hex');
 let sourceCommit=null;try{sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim();}catch{}
 const manifest={release_tag:'beta-'+contentHash.slice(0,16),created_at:new Date().toISOString(),source_commit:sourceCommit,source:'current-worktree',runtime_version:backendVersion(output),content_sha256:contentHash,files:entries};
 writeFileSync(join(output,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 // 只验证复制完整性，不将打包成功等同镜像或部署验收。
 for(const entry of entries)if(createHash('sha256').update(readFileSync(join(output,entry.path))).digest('hex')!==entry.sha256)throw Error('发布文件校验失败');
 return {directory:output,...manifest};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==3)throw Error('用法：node server/prepare-release.mjs <仓库外的新目录>');const result=prepareRelease(process.argv[2]);console.log(JSON.stringify({directory:result.directory,release_tag:result.release_tag,runtime_version:result.runtime_version,files:result.files.length}));}
 catch(error){console.error('✗ '+error.message);process.exitCode=1;}
}
