import {readFileSync,writeFileSync,renameSync,mkdirSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAccounts,sessionCookie,sessionToken} from './accounts.mjs';
import {readJsonBody} from './http-body.mjs';
export function nodeAccounts(env=process.env){
 if(env.MT_ACCOUNT_AUTH!=='1'||env.MT_RUNTIME==='cloudflare')return async(ctx,next)=>next();
 const file=env.MT_ACCOUNT_FILE||new URL('../.state/accounts.json',import.meta.url);
 const path=typeof file==='string'?file:fileURLToPath(file);
 let data=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
 const store={get:k=>data[k],set:(k,v)=>{data[k]=v;},remove:k=>{delete data[k];},transaction:fn=>{const before=structuredClone(data);try{const result=fn();mkdirSync(dirname(path),{recursive:true});writeFileSync(path+'.tmp',JSON.stringify(data),{mode:0o600});renameSync(path+'.tmp',path);return result;}catch(e){data=before;throw e;}}};
 const service=createAccounts(store,env);
 return async(ctx,next)=>{
  if(['/healthz','/readyz'].includes(ctx.path))return next();
  ctx.set('Cache-Control','no-store');
  const token=sessionToken(ctx.get('cookie'));
  if(ctx.path.startsWith('/api/auth/')){try{
   const action=ctx.path.slice(10),read=action==='session';
   if(ctx.method!==(read?'GET':'POST')){ctx.status=405;return;}
   if(!read&&(ctx.get('origin')!==(env.MT_PUBLIC_ORIGIN||ctx.origin)||ctx.get('sec-fetch-site')==='cross-site')){ctx.status=403;return;}
   if(!read&&!ctx.get('content-type').startsWith('application/json')){ctx.status=415;return;}
   const result=await service.handle(action,read?{}:await readJsonBody(ctx.req,{maxBytes:4096}),token,ctx.req.socket.remoteAddress);
   if('token'in result)ctx.set('Set-Cookie',sessionCookie(result.token,ctx.secure));ctx.body={user:result.user};
  }catch(e){ctx.status=e.status||500;ctx.body={msg:e.status?e.message:'账号服务暂不可用'};}return;}
  if(['/pages/login.html','/assets/auth.js','/assets/auth.css','/assets/language.js','/assets/theme.js','/assets/desktop-ui.css'].includes(ctx.path)){ctx.state.accountPublic=true;return next();}
  const {user,owner}=await service.handle('session',{},token);
  if(!user){if(ctx.path.startsWith('/api/')){ctx.status=401;ctx.body={msg:'请先登录'};}else ctx.redirect('/pages/login.html');return;}
  if(ctx.path==='/assets/account-context.js'){ctx.type='text/javascript';ctx.body='window.MTAccount='+JSON.stringify(user)+';';return;}
  ctx.state.accessUser=owner || 'account:'+user.id;return next();
 };
}
