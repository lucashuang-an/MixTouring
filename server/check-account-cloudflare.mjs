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
  bindings:{MT_RUNTIME:'cloudflare',MT_ACCOUNT_AUTH:'1',MT_REGISTRATION_INVITES:JSON.stringify([createHash('sha256').update('test-invite-only').digest('hex')]),MT_PUBLIC:'1',MT_PUBLIC_ORIGIN:'https://mixtouring.app',MT_ACCESS_USERS:JSON.stringify({tester:createHash('sha256').update(password).digest('hex')}),MT_PLANNING_AUTH_KEY:'a'.repeat(64),MT_DAILY_UPSTREAM_LIMIT:'200'},
  durableObjects:{TRAVELERS:{className:'TravelerAgent',useSQLite:true},USAGE:{className:'UsageCoordinator',useSQLite:true}},
  assets:{routerConfig:{has_user_worker:true},assetConfig:{html_handling:"none"},directory:resolve('mixtouring-hifi'),binding:'ASSETS',run_worker_first:true}});
options.resourcePersistencePath=persistence;
let mf=new Miniflare(options);
try{
  const origin='https://mixtouring.app';
  const post=(action,body,cookie='')=>mf.dispatchFetch(origin+'/api/auth/'+action,{method:'POST',headers:{origin,'content-type':'application/json',cookie},body:JSON.stringify(body)});
  let r=await mf.dispatchFetch(origin+'/',{redirect:'manual'});assert.equal(r.status,302);assert.equal(r.headers.get('www-authenticate'),null);
  r=await mf.dispatchFetch(origin+'/pages/login.html');assert.equal(r.status,200);
  const oldLogin=await post('login',{username:'tester',password});assert.equal(oldLogin.status,200);const oldCookie=oldLogin.headers.get('set-cookie').split(';')[0];
  const oldSession=await mf.dispatchFetch(origin+'/api/auth/session',{headers:{cookie:oldCookie}});assert.equal((await oldSession.json()).user.legacy_local,true);
  assert.equal((await mf.dispatchFetch(origin+'/api/capabilities',{headers:{cookie:oldCookie}})).status,200);
  r=await post('register',{username:'newtester',password:'test-password-only',invite:'test-invite-only'});assert.equal(r.status,200,await r.clone().text());
  const cookie=r.headers.get('set-cookie').split(';')[0];assert.match(r.headers.get('set-cookie'),/HttpOnly/);
  r=await mf.dispatchFetch(origin+'/api/auth/session',{headers:{cookie}});assert.equal((await r.json()).user.username,'newtester');
  r=await mf.dispatchFetch(origin+'/api/capabilities',{headers:{cookie}});assert.equal(r.status,200,await r.clone().text());
  r=await mf.dispatchFetch(origin+'/assets/account-context.js',{headers:{cookie}});assert.match(await r.text(),/tester/);
  await mf.dispose();mf=new Miniflare(options);
  r=await mf.dispatchFetch(origin+'/api/auth/session',{headers:{cookie}});assert.equal((await r.json()).user.username,'newtester');
  r=await post('register',{username:'second',password:'test-password-only',invite:'test-invite-only'});assert.equal(r.status,400);
  r=await mf.dispatchFetch(origin+'/api/auth/logout',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json',cookie},body:'{}'});assert.equal(r.status,403);
  r=await post('logout',{},cookie);assert.equal(r.status,200);
  r=await mf.dispatchFetch(origin+'/api/capabilities',{headers:{cookie}});assert.equal(r.status,401);
  console.log('✓ workerd：注册、会话、鉴权、重启持久化、邀请码消费、跨站拒绝与退出通过');
}finally{await mf.dispose();if(!persistence.startsWith(resolve(tmpdir(),'mixtouring-workerd-')))throw Error('测试目录越界');rmSync(persistence,{recursive:true,force:true});}
