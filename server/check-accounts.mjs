import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAccounts} from './lib/accounts.mjs';
const invite='test-invite-only',data=new Map();let now=100;
const store={get:k=>data.get(k),set:(k,v)=>data.set(k,v),remove:k=>data.delete(k),transaction:fn=>{const old=new Map(data);try{return fn();}catch(e){data.clear();for(const [k,v] of old)data.set(k,v);throw e;}}};
const env={MT_REGISTRATION_INVITES:JSON.stringify([createHash('sha256').update(invite).digest('hex')])};
let accounts=createAccounts(store,env,()=>now);
const user=await accounts.handle('register',{username:'Tester',password:'test-password-only',invite},'','ip1');
assert.equal(user.user.username,'tester');assert.equal((await accounts.handle('session',{},user.token)).user.id,user.user.id);
await assert.rejects(accounts.handle('register',{username:'second',password:'test-password-only',invite},'','ip2'),/邀请码/);
await assert.rejects(accounts.handle('login',{username:'tester',password:'incorrect-password'},'','ip3'),/账号或密码/);
accounts=createAccounts(store,env,()=>now);
const login=await accounts.handle('login',{username:'tester',password:'test-password-only'},'','ip4');
assert.equal(login.user.id,user.user.id);await accounts.handle('logout',{},login.token);assert.equal((await accounts.handle('session',{},login.token)).user,null);
now+=604800001;assert.equal((await accounts.handle('session',{},user.token)).user,null);
assert(!JSON.stringify([...data.values()]).includes('test-password-only'));
console.log('✓ 注册、邀请码单次消费、密码验证、会话重建、退出与过期通过');

const legacyEnv={...env,MT_ACCESS_USERS:JSON.stringify({legacy:createHash('sha256').update('legacy-password-123').digest('hex')})};
accounts=createAccounts(store,legacyEnv,()=>now);
await assert.rejects(accounts.handle('register',{username:'legacy',password:'different-password-123',invite},'','ip5'),/账号不可用/);
const legacy=await accounts.handle('login',{username:'legacy',password:'legacy-password-123'},'','ip6');const legacySession=await accounts.handle('session',{},legacy.token);assert.equal(legacySession.owner,'legacy');assert.equal(legacySession.user.legacy_local,true);assert(!('legacy_local' in user.user));
await assert.rejects(accounts.handle('login',{username:'legacy',password:'wrong-password-123'},'','ip7'),/账号或密码/);
accounts=createAccounts(store,{...legacyEnv,MT_ACCESS_USERS:'{}'},()=>now);assert.equal((await accounts.handle('session',{},legacy.token)).user,null);await assert.rejects(accounts.handle('login',{username:'legacy',password:'legacy-password-123'},'','ip8'),/账号或密码/);
console.log('✓ 旧凭据表单登录、保留存储身份、禁止抢注及撤销后会话失效通过');

{
 const {readFileSync}=await import('node:fs');const vm=await import('node:vm');const storage=new Map([['mt:drafts','existing-trip']]);
 const raw={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
 const bind=user=>{const window={MTAccount:user,localStorage:raw,sessionStorage:raw,addEventListener(){}};vm.runInNewContext(readFileSync(new URL('../mixtouring-hifi/assets/account-storage.js',import.meta.url),'utf8'),{window,document:{addEventListener(){}}});return window.MTLocalStorage;};
 const existing=bind(legacySession.user),fresh=bind(user.user);assert.equal(existing.getItem('mt:drafts'),'existing-trip');assert.equal(fresh.getItem('mt:drafts'),null);fresh.setItem('mt:drafts','new-trip');assert.equal(existing.getItem('mt:drafts'),'existing-trip');assert.equal(fresh.getItem('mt:drafts'),'new-trip');
}
