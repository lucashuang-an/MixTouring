import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
const require=createRequire(new URL('../deploy/cloudflare/package.json',import.meta.url));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const password='local-test-only',authorization='Basic '+Buffer.from('tester:'+password).toString('base64');
const persistence=mkdtempSync(resolve(tmpdir(),'mixtouring-workerd-'));
const options=convertV4MiniflareOptions({name:"mixtouring",modules:true,scriptPath:resolve('.cloudflare/output/v0/workers/default/bundle/worker.mjs'),compatibilityDate:'2026-11-12',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],
  bindings:{MT_RUNTIME:'cloudflare',MT_PUBLIC:'1',MT_PUBLIC_ORIGIN:'https://mixtouring.app',MT_ACCESS_USERS:JSON.stringify({tester:createHash('sha256').update(password).digest('hex')}),MT_PLANNING_AUTH_KEY:'a'.repeat(64),MT_DAILY_UPSTREAM_LIMIT:'200'},
  durableObjects:{TRAVELERS:{className:'TravelerAgent',useSQLite:true},USAGE:{className:'UsageCoordinator',useSQLite:true}},
  assets:{routerConfig:{has_user_worker:true},assetConfig:{html_handling:"none"},directory:resolve('mixtouring-hifi'),binding:'ASSETS',run_worker_first:true}});
options.resourcePersistencePath=persistence;
let mf=new Miniflare(options);
try{
  let r=await mf.dispatchFetch('https://mixtouring.app/healthz');assert.equal(r.status,200,await r.clone().text());assert.match((await r.json()).runtime_version,/^runtime-/);
  r=await mf.dispatchFetch('https://mixtouring.app/');assert.equal(r.status,401);
  r=await mf.dispatchFetch('https://mixtouring.app/',{headers:{authorization}});assert.equal(r.status,200);assert.match(await r.text(),/<html/i);
  r=await mf.dispatchFetch('https://mixtouring.app/api/capabilities',{headers:{authorization}});assert.equal(r.status,200);assert.equal((await r.json()).code,0);
  r=await mf.dispatchFetch('https://mixtouring.app/api/anywhere/conversation',{method:'POST',headers:{authorization,'content-type':'application/json',origin:'https://evil.example'},body:JSON.stringify({text:'你好'})});assert.equal(r.status,403);
  r=await mf.dispatchFetch('https://mixtouring.app/api/anywhere/conversation',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify({text:'你好',progressive:true})});assert.equal(r.status,200);assert.match(await r.text(),/result/);
  const usage=await mf.getDurableObjectNamespace('USAGE','mixtouring');
  assert.equal((await usage.getByName('upstream').reserve('model')).calls,1);
  await mf.dispose();mf=new Miniflare(options);
  const restarted=await mf.getDurableObjectNamespace('USAGE','mixtouring');
  assert.equal((await restarted.getByName('upstream').reserve('search')).calls,2);
  console.log('✓ workerd：启动、受邀静态页、API、跨站拒绝和流式失败恢复通过');
}finally{await mf.dispose();if(!persistence.startsWith(resolve(tmpdir(),'mixtouring-workerd-')))throw Error('测试目录越界');rmSync(persistence,{recursive:true,force:true});}
