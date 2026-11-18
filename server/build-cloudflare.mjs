import {readFile,mkdir,writeFile,cp,readdir,rm} from 'node:fs/promises';
import {resolve,relative,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {backendVersion} from './lib/runtime-version.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(new URL('../deploy/cloudflare/package.json',import.meta.url));
const {build}=require('esbuild');
const {default:config}=await import(pathToFileURL(join(root,'cloudflare.config.ts')));
const output=join(root,'.cloudflare/output/v0'),workerDir=join(output,'workers/default');
const markdown=await readFile(join(root,'AGENTS.md'),'utf8');
const fingerprint=createHash('sha256').update(backendVersion(root));
for(const path of ['cloudflare.config.ts','server/build-cloudflare.mjs',...(await readdir(join(root,'server/cloudflare'))).sort().map(p=>'server/cloudflare/'+p)])fingerprint.update(path).update(await readFile(join(root,path)));
const version='runtime-'+fingerprint.digest('hex').slice(0,16);
if(resolve(output)!==resolve(root,'.cloudflare/output/v0'))throw Error('构建目录越界');
await rm(output,{recursive:true,force:true});
await mkdir(join(workerDir,'bundle'),{recursive:true});
await build({entryPoints:[join(root,'server/cloudflare/worker.mjs')],outfile:join(workerDir,'bundle/worker.mjs'),bundle:true,format:'esm',platform:'node',target:'es2022',external:['cloudflare:*','node:*'],minify:true,banner:{js:"import {createRequire as __createRequire} from 'node:module'; const require=__createRequire('/bundle/worker.mjs');"},
  plugins:[{name:'runtime-resources',setup(b){
    b.onLoad({filter:/runtime-version\.mjs$/},()=>({contents:`export const RUNTIME_VERSION=${JSON.stringify(version)};`,loader:'js'}));
    b.onLoad({filter:/\.(?:mjs|js)$/},async args=>{
      if(args.path.includes('node_modules'))return;
      let contents=await readFile(args.path,'utf8');
      // 将运行规则封装进同一不可变版本；其余模块路径只用于诊断，不读宿主文件。
      if(args.path.endsWith('agent-prompts.mjs'))contents=contents.replace("readFileSync(new URL('../../AGENTS.md',import.meta.url),'utf8')",JSON.stringify(markdown));
      contents=contents.replaceAll('import.meta.url',JSON.stringify('file:///bundle/'+relative(root,args.path).replaceAll('\\','/')));
      return {contents,loader:'js',resolveDir:resolve(args.path,'..')};
    });
  }}]});
const {entrypoint,...worker}=config.worker;
await writeFile(join(workerDir,'worker.config.json'),JSON.stringify({...worker,manifest:{type:'complete',mainModule:'worker.mjs',modules:{'worker.mjs':{type:'esm'}}}},null,2));
await writeFile(join(output,'config.json'),JSON.stringify({accountId:config.accountId,buildContext:{isPreview:false}},null,2));
await cp(join(root,'mixtouring-hifi'),join(workerDir,'assets'),{recursive:true,filter:source=>!relative(join(root,'mixtouring-hifi'),source).split(/[\\/]/).some(p=>p.startsWith('.'))});
await writeFile(join(output,'release.json'),JSON.stringify({runtime_version:version},null,2));
console.log('✓ Workers发布包已生成：'+version);
