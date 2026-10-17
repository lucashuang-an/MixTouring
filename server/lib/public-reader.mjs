/* 只读公开网页摘录：限时限量，拒绝本机／内网、跳转内网及验证页，不使用登录态。 */
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import https from 'node:https';
import http from 'node:http';
import {sourceDay} from './source-time.mjs';

export function publicAddress(address){
  if(isIP(address)===4){const a=address.split('.').map(Number);return !(a[0]===0 || a[0]===10 || a[0]===127 || a[0]>=224 || a[0]===169 && a[1]===254 || a[0]===172 && a[1]>=16 && a[1]<=31 || a[0]===192 && [0,168].includes(a[1]) || a[0]===100 && a[1]>=64 && a[1]<=127 || a[0]===198 && [18,19].includes(a[1]));}
  if(isIP(address)===6){const s=new URL('http://['+address+']').hostname.slice(1,-1).toLowerCase();return !(/^(?:fc|fd|fe[89ab]|ff|::|0:|2001:db8:|2002:|64:ff9b:)/.test(s) || s.includes('ffff:'));}
  return false;
}
export function publicUrl(value){
  const u=new URL(value);
  if(!['http:','https:'].includes(u.protocol) || u.username || u.password || u.port && !['80','443'].includes(u.port) || !u.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(u.hostname) || isIP(u.hostname.replace(/^\[|\]$/g,'')))throw Error('仅支持公开网页地址');
  return u;
}
const decode=s=>s.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g,v=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'",'&nbsp;':' '})[v]);
const plain=s=>decode(s.replace(/<(script|style|nav|footer|header|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
export function extractPublicPage(html){
  if(/<title[^>]*>\s*(?:Just a moment|Attention Required|访问异常|安全验证)|cf-chl-|captcha-container|id=["']challenge-form/i.test(html))throw Error('网页要求验证，未读取内容');
  if(/<title[^>]*>[^<]*(?:登录|sign in|log in)/i.test(html) && /<input[^>]*type=["']password["']/i.test(html))throw Error('网页需要登录，未读取文章');
  let published=null,updated=null;
  for(const tag of html.match(/<meta\b[^>]*>/gi) || []){
    const attr=Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(m=>[m[1].toLowerCase(),decode(m[2])]));
    const name=(attr.property || attr.name || attr.itemprop || '').toLowerCase();
    if(['article:published_time','datepublished','publishdate','pubdate','publication_date'].includes(name))published ||=sourceDay(attr.content);
    if(['article:modified_time','datemodified'].includes(name))updated ||=sourceDay(attr.content);
  }
  for(const block of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    try{const walk=(v,depth=0)=>{if(depth>8 || !v || typeof v!=='object')return;if(['NewsArticle','Article','BlogPosting'].includes(v['@type'])){published ||=sourceDay(v.datePublished);updated ||=sourceDay(v.dateModified);}for(const item of Object.values(v))if(item && typeof item==='object')Array.isArray(item)?item.forEach(x=>walk(x,depth+1)):walk(item,depth+1);};walk(JSON.parse(block[1]));}catch{}
  }
  const body=html.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/i)?.[1] || html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || html;
  const content=plain(body);if(content.length<60)throw Error('未取得可读正文');
  published ||=sourceDay(content.slice(0,1200).match(/(?:发布时间|发布日期|发布于|Published on)[：:\s]*(\d{4}[-年/]\d{1,2}[-月/]\d{1,2}(?:日)?)/i)?.[1]);
  return {title:plain(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').slice(0,160),excerpt:content.slice(0,6000),published_at:published,updated_at:updated,read_status:'page_excerpt',truncated:content.length>6000};
}
export async function readPublicPage(value,{timeoutMs=6000,maxBytes=524288,resolve=lookup,signal}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try{
    let url=publicUrl(value);
    for(let step=0;step<4;step++){
      if(controller.signal.aborted)throw Error('读取超时或已取消');
      const addresses=await Promise.race([resolve(url.hostname,{all:true,verbatim:true}),new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('读取超时或已取消')),{once:true}))]);
      if(!addresses.length || addresses.some(a=>!publicAddress(a.address)))throw Error('地址不是公开网络地址');
      const chosen=addresses.find(a=>a.family===4) || addresses[0];
      const response=await new Promise((accept,reject)=>{
        const request=(url.protocol==='https:'?https:http).get(url,{agent:false,headers:{'user-agent':'MixTouring-PublicReader/1.0','accept':'text/html,application/xhtml+xml'},signal:controller.signal,lookup:(_host,opts,done)=>opts?.all?done(null,[chosen]):done(null,chosen.address,chosen.family)},res=>{
          if([301,302,303,307,308].includes(res.statusCode)){res.resume();accept({redirect:res.headers.location});return;}
          if(res.statusCode!==200 || !/text\/html|application\/xhtml\+xml/i.test(res.headers['content-type'] || '')){res.resume();reject(Error('网页不可公开读取'));return;}
          let length=0;const chunks=[];res.on('data',chunk=>{length+=chunk.length;if(length>maxBytes){res.destroy();reject(Error('网页超过读取上限'));}else chunks.push(chunk);});res.on('end',()=>{try{const buffer=Buffer.concat(chunks),header=String(res.headers['content-type'])+' '+buffer.subarray(0,2048).toString('ascii');accept({html:new TextDecoder(/gbk|gb2312|gb18030/i.test(header)?'gb18030':'utf-8').decode(buffer)});}catch{reject(Error('网页编码不可读取'));}});res.on('error',reject);
        });request.on('error',reject);
      });
      if(response.redirect){url=publicUrl(new URL(response.redirect,url).href);continue;}
      return {...extractPublicPage(response.html),url:url.href,checked_at:new Date().toISOString()};
    }
    throw Error('网页跳转过多');
  }catch(error){return {url:String(value),read_status:'unavailable',reason:error.message.slice(0,120),checked_at:new Date().toISOString()};}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
