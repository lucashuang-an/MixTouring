/* 真实密码只从进程环境读取，不放URL、命令行参数或验证输出。 */
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export async function smokeRelease({base,user,password,expectedRuntime,fetchImpl=fetch}){
 const url=new URL(base);
 assert.equal(url.protocol,'https:');assert.equal(url.origin,base);
 assert.ok(user&&password,'需设置MT_SMOKE_USER和MT_SMOKE_PASSWORD');
 assert.match(expectedRuntime || '',/^runtime-[a-f0-9]{16}$/,'需提供发布清单中的目标运行版本');
 const authorization='Basic '+Buffer.from(user+':'+password).toString('base64');
 let authHeaders={authorization},cookie=null;
 const get=(path,auth=false,extra={})=>fetchImpl(base+path,{headers:{...(auth?authHeaders:{}),...extra},redirect:'manual',signal:AbortSignal.timeout(15000)});
 const health=await get('/healthz');assert.equal(health.status,200);
 const info=await health.json();assert.match(info.runtime_version,/^runtime-[a-f0-9]{16}$/);assert.match(info.agent_rules_version,/^agents-md-[a-f0-9]{16}$/);
 assert.equal(info.runtime_version,expectedRuntime);
 assert.equal((await get('/readyz')).status,200);
 const entry=await get('/index.html');
 if(entry.status===302){
  assert.equal(new URL(entry.headers.get('location'),base).href,base+'/pages/login.html');
  assert.equal(entry.headers.get('www-authenticate'),null);
  assert.equal((await get('/pages/login.html')).status,200);
  const login=await fetchImpl(base+'/api/auth/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:user,password}),redirect:'manual',signal:AbortSignal.timeout(15000)});
  assert.equal(login.status,200);const setCookie=login.headers.get('set-cookie');assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/Secure/);cookie=setCookie.split(';')[0];authHeaders={cookie};
 }else assert.equal(entry.status,401);
 try{
 assert.equal((await get('/api/capabilities')).status,401);
 assert.equal((await get('/pages/trip.html',true)).status,200);
 const capabilities=await get('/api/capabilities',true);assert.equal(capabilities.status,200);
 const body=await capabilities.json();assert.equal(body.code,0);assert.equal(body.data.runtime_version,expectedRuntime);assert.equal(body.data.agent_rules_version,info.agent_rules_version);
 assert.equal((await get('/api/capabilities',true,{origin:'https://other.invalid'})).status,403);
 return info;
 }finally{if(cookie){const logout=await fetchImpl(base+'/api/auth/logout',{method:'POST',headers:{cookie,origin:base,'content-type':'application/json'},body:'{}',redirect:'manual',signal:AbortSignal.timeout(15000)});assert.equal(logout.status,200);assert.equal((await get('/api/capabilities',true)).status,401);}}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const info=await smokeRelease({base:process.env.MT_SMOKE_BASE,user:process.env.MT_SMOKE_USER,password:process.env.MT_SMOKE_PASSWORD,expectedRuntime:process.env.MT_EXPECT_RUNTIME});
  console.log('✓ HTTPS、目标版本、就绪、邀请门禁与跨站保护通过：'+info.runtime_version+' / '+info.agent_rules_version);
  console.log('此命令不产生模型调用；真实生成、流式响应、取消及保存恢复仍须浏览器验收。');
 }catch{console.error('✗ 部署冒烟未通过；请核对MT_EXPECT_RUNTIME、HTTPS地址、凭据及服务响应。');process.exitCode=1;}
}
