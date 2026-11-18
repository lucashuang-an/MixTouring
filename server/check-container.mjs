import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,cpSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const temporary=mkdtempSync(join(tmpdir(),'mt-image-')),context=join(temporary,'context');
const project='mt-smoke-'+randomUUID().slice(0,8),release='smoke-'+Date.now(),tag='mixtouring:'+release;
const env={...process.env,MT_RELEASE_TAG:release,MT_RUNTIME_ENV_FILE:join(temporary,'runtime.env'),MT_PORT:'0'};
const docker=args=>execFileSync('docker',args,{env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:300000,windowsHide:true}).trim();
const compose=args=>docker(['compose','--project-directory',context,'-p',project,'-f',join(context,'compose.yaml'),...args]);
let started=false;
try{
 // 缺Docker时先失败，不生成可被误认作已验收的镜像产物。
 docker(['info']);docker(['compose','version']);
 mkdirSync(join(context,'server'),{recursive:true});
 for(const file of ['Dockerfile','.dockerignore','AGENTS.md','compose.yaml'])cpSync(file,join(context,file));
 for(const file of ['index.mjs','package.json','package-lock.json'])cpSync(join('server',file),join(context,'server',file));
 cpSync('server/lib',join(context,'server/lib'),{recursive:true});cpSync('mixtouring-hifi',join(context,'mixtouring-hifi'),{recursive:true});
 writeFileSync(join(context,'server/.env'),'SECRET_IMAGE_MARKER=do-not-package');
 for(const dir of ['.state','logs']){mkdirSync(join(context,'server',dir));writeFileSync(join(context,'server',dir,'secret.key'),'do-not-package');}
 const password='container-fixture',users=JSON.stringify({test:createHash('sha256').update(password).digest('hex')});
 writeFileSync(env.MT_RUNTIME_ENV_FILE,'MT_ACCESS_USERS='+users+'\nMT_PUBLIC_ORIGIN=https://example.test\nMT_DAILY_UPSTREAM_LIMIT=10\n',{mode:0o600});
 compose(['config','--quiet']);started=true;
 compose(['up','-d','--build','--wait','--wait-timeout','60']);
 let container=compose(['ps','-q','mixtouring']);assert.match(container,/^[a-f0-9]{64}$/);
 const inspect=JSON.parse(docker(['inspect',container]))[0];
 assert.equal(inspect.HostConfig.ReadonlyRootfs,true);assert.equal(inspect.Config.User,'node');
 assert.ok(inspect.HostConfig.CapDrop.includes('ALL'));
 assert.ok(inspect.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
 assert.equal(inspect.Mounts.filter(m=>m.Type==='volume'&&m.RW).length,2);
 const exec=code=>docker(['exec',container,'node','--input-type=module','-e',code]);
 exec("import fs from 'node:fs';if(process.getuid()===0)throw Error('root');for(const p of ['/app/server/.env','/app/server/.state/secret.key','/app/server/logs/secret.key'])if(fs.existsSync(p))throw Error('private file packaged');if(!fs.existsSync('/app/AGENTS.md'))throw Error('missing prompts');try{fs.writeFileSync('/app/readonly-test','x');throw Error('writable source');}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')throw e;}fs.writeFileSync('/app/server/logs/smoke-marker','preserved');");
 const address=compose(['port','mixtouring','3000']).split('\n')[0],base='http://'+address;
 const get=(path,auth=false)=>fetch(base+path,{headers:auth?{authorization:'Basic '+Buffer.from('test:'+password).toString('base64')}:{},signal:AbortSignal.timeout(10000)});
 assert.equal((await get('/healthz')).status,200);assert.equal((await get('/readyz')).status,503);
 assert.equal((await get('/index.html')).status,401);assert.equal((await get('/api/capabilities',true)).status,200);
 exec("import {reserveUpstream} from './lib/upstream-budget.mjs';reserveUpstream('model');");
 // 强制重建实际Compose容器，检查卷权限、日志和额度均保留，不调用供应商。
 compose(['up','-d','--force-recreate','--wait','--wait-timeout','60']);container=compose(['ps','-q','mixtouring']);
 exec("import fs from 'node:fs';if(JSON.parse(fs.readFileSync('.state/upstream-budget.json')).calls!==1)throw Error('budget lost');if(fs.readFileSync('logs/smoke-marker','utf8')!=='preserved')throw Error('logs lost');");
 console.log('✓ 实际Compose：镜像排除密钥、非root、只读源码、可写私有卷、端口/门禁/探针及重建保留额度和日志');
}finally{
 if(started)try{compose(['down','--volumes','--remove-orphans']);}catch{}
 if(started)try{docker(['image','rm',tag]);}catch{}
 if(resolve(temporary).startsWith(resolve(tmpdir())+sep)&&basename(temporary).startsWith('mt-image-'))rmSync(temporary,{recursive:true,force:true});
}
