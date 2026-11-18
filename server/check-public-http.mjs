import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
process.env.MT_PUBLIC='1';process.env.MT_PUBLIC_ORIGIN='https://example.test';
process.env.MT_ACCESS_USERS=JSON.stringify({tester:createHash('sha256').update('fixture-password').digest('hex')});
process.env.MT_API_PER_MINUTE='50';
for(const key of Object.keys(process.env))if(/KEY$|API_KEY$/.test(key))delete process.env[key];
const {app}=await import('./index.mjs');
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base='http://127.0.0.1:'+server.address().port;
const authorization='Basic '+Buffer.from('tester:fixture-password').toString('base64');
try{
 assert.equal((await fetch(base+'/healthz')).status,200);
 assert.equal((await fetch(base+'/readyz')).status,503);
 assert.equal((await fetch(base+'/index.html')).status,401);
 assert.equal((await fetch(base+'/api/capabilities')).status,401);
 assert.equal((await fetch(base+'/index.html',{headers:{authorization}})).status,200);
 assert.equal((await fetch(base+'/api/capabilities',{headers:{authorization}})).status,200);
 assert.equal((await fetch(base+'/api/capabilities',{headers:{authorization,origin:'https://evil.test'}})).status,403);
 const r=await fetch(base+'/api/anywhere/conversation',{method:'POST',headers:{authorization,'content-type':'application/json',origin:'https://example.test'},body:JSON.stringify({text:'你好'})});
 assert.equal(r.status,200);assert.equal((await r.json()).data.status,'unavailable');
 const invalid=await fetch(base+'/api/anywhere/conversation',{method:'POST',headers:{authorization,'content-type':'application/json',origin:'https://example.test'},body:JSON.stringify({text:'你好',reasoning_effort:'none'})});
 assert.equal(invalid.status,400);assert.match((await invalid.json()).msg,/推理强度/);
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
console.log('✓ 真实HTTP：受邀页面/API、健康与就绪、跨站边界、无密钥失败保留');
