import {randomBytes,createHash,scrypt as derive,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(derive), digest=v=>createHash('sha256').update(v).digest('hex');
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export const SESSION_COOKIE='mt_session';
export function sessionToken(cookie=''){return cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith(SESSION_COOKIE+'='))?.slice(SESSION_COOKIE.length+1)||'';}
export function sessionCookie(token,secure=true){return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token?604800:0}${secure?'; Secure':''}`;}
// store 的事务必须同步提交，邀请码消费与账号写入不可分开。
export function createAccounts(store,env={},clock=Date.now){
 const invites=JSON.parse(env.MT_REGISTRATION_INVITES||'[]');
 if(!Array.isArray(invites)||invites.some(x=>!/^[a-f0-9]{64}$/.test(x)))throw Error('邀请码配置无效');
 const legacy=Object.entries(JSON.parse(env.MT_ACCESS_USERS||'{}'));
 if(legacy.some(([name,hash])=>!/^[a-zA-Z0-9_-]{1,64}$/.test(name)||!/^[a-f0-9]{64}$/.test(hash)) || new Set(legacy.map(([name])=>name.toLowerCase())).size!==legacy.length)throw Error('旧访问账号配置无效');
 const clean=user=>user?{id:user.id,username:user.username,...(user.legacyLocal===true?{legacy_local:true}:{})}:null;
 const owner=user=>user?.legacyOwner || (user?'account:'+user.id:null);
 function rate(key){store.transaction(()=>{const id='rate:'+digest(key),now=clock(),old=store.get(id),row=old?.expires>now?old:{count:0,expires:now+60000};if(row.count>=8)fail(429,'尝试过于频繁，请稍后再试');store.set(id,{...row,count:row.count+1});});}
 async function handle(action,data={},token='',ip='unknown'){
  const sid='session:'+digest(token),session=token&&store.get(sid);
  let user=session?.expires>clock()?store.get('user:'+session.username):null;
  if(user?.legacyOwner && (!legacy.some(([name,hash])=>name===user.legacyOwner&&hash===session.credentialVersion)))user=null;
  if(action==='session')return {user:clean(user),owner:owner(user)};
  if(action==='logout'){store.transaction(()=>store.remove(sid));return {user:null,token:''};}
  if(!['login','register'].includes(action))fail(404,'接口不存在');
  if(!data||typeof data!=='object'||Array.isArray(data))fail(400,'请求格式无效');
  rate('ip:'+ip);
  const username=typeof data.username==='string'?data.username.trim().toLowerCase():'';
  const password=data.password;
  if(!/^[a-z0-9_]{3,32}$/.test(username)||typeof password!=='string'||password.length<12||password.length>128)fail(400,'账号需为3—32位字母、数字或下划线，密码需为12—128位');
  rate('user:'+username);
  let account=store.get('user:'+username);
  const previous=legacy.find(([name])=>name.toLowerCase()===username);
  if(action==='register'){
   if(previous)fail(409,'账号不可用，请换一个');
   const invite=typeof data.invite==='string'&&data.invite.length<=256?digest(data.invite.trim()):'';
   if(!invites.includes(invite))fail(400,'邀请码无效或已使用');
   const salt=randomBytes(16).toString('hex'),hash=(await scrypt(password,salt,64)).toString('hex');
   account={id:randomBytes(16).toString('hex'),username,salt,hash};
   store.transaction(()=>{if(store.get('invite:'+invite))fail(400,'邀请码无效或已使用');if(store.get('user:'+username))fail(409,'账号不可用，请换一个');store.set('user:'+username,account);store.set('invite:'+invite,{used:true});});
  }else if(previous){
   const [legacyOwner,credentialVersion]=previous;
   if(!timingSafeEqual(Buffer.from(digest(password),'hex'),Buffer.from(credentialVersion,'hex'))){await scrypt(password,'mixtouring-dummy-salt',64);fail(401,'账号或密码不正确');}
   if(!account || account.credentialVersion!==credentialVersion){
    const salt=randomBytes(16).toString('hex'),hash=(await scrypt(password,salt,64)).toString('hex');
    account={id:account?.id || digest('legacy:'+legacyOwner).slice(0,32),username,salt,hash,legacyOwner,credentialVersion,legacyLocal:account?.legacyLocal ?? legacy.length===1};
    store.transaction(()=>store.set('user:'+username,account));
   }
  }else{
   const actual=await scrypt(password,account?.salt||'mixtouring-dummy-salt',64);
   if(!account||account.legacyOwner||!timingSafeEqual(actual,Buffer.from(account.hash,'hex')))fail(401,'账号或密码不正确');
  }
  const nextToken=randomBytes(32).toString('hex');
  store.transaction(()=>{store.remove(sid);store.set('session:'+digest(nextToken),{username,expires:clock()+604800000,...(account.credentialVersion?{credentialVersion:account.credentialVersion}:{})});});
  return {user:clean(account),token:nextToken};
 }
 return {handle};
}
