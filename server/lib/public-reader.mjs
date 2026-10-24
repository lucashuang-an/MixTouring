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
  // 部分官方公告把发布日期放在文章标题前的 <time datetime>，而非 meta。
  // 只接受正文前部、NEWS 类文章页眉且紧邻标题的时间，避免活动日/车次日被当成发布日期。
  if(!published)for(const match of body.slice(0,4000).matchAll(/<time\b[^>]*>/gi)){
    const attr=Object.fromEntries([...match[0].matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(m=>[m[1].toLowerCase(),m[2]]));
    const date=sourceDay(attr.datetime),explicit=/\b(?:posted|publish(?:ed)?|pub)[-_]?date\b/i.test(attr.class || '') || /datepublished/i.test(attr.itemprop || '');
    const before=body.slice(Math.max(0,match.index-400),match.index),after=body.slice(match.index+match[0].length,match.index+match[0].length+500);
    if(date && (explicit || /<header\b/i.test(before) && /(?:NEWS|ニュース|記事|公開|掲載|投稿日|Published)/i.test(before) && /<h1\b/i.test(after))){
      published=date;break;
    }
  }
  const content=plain(body);if(content.length<60)throw Error('未取得可读正文');
  published ||=sourceDay(content.slice(0,1200).match(/(?:发布时间|发布日期|发布于|Published on)[：:\s]*(\d{4}[-年/]\d{1,2}[-月/]\d{1,2}(?:日)?)/i)?.[1]);
  return {title:plain(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').slice(0,160),excerpt:content.slice(0,6000),published_at:published,updated_at:updated,read_status:'page_excerpt',truncated:content.length>6000};
}
export async function readPublicPage(value,{timeoutMs=6000,maxBytes=524288,resolve=lookup,signal}={}){
  const started=Date.now(),diagnostics={phase:'validation',http_status:null,content_type:'unknown',redirects:0,elapsed_ms:0};
  const messages={unsafe_url:'仅支持公开网页地址',unsafe_address:'地址不是公开网络地址',dns_error:'域名解析失败',network_error:'公开网页连接失败',timeout:'读取超时',cancelled:'读取已取消',non_html:'网页不是可读HTML',body_too_large:'网页超过读取上限',decode_error:'网页编码不可读取',verification_required:'网页要求验证，未读取内容',login_required:'网页需要登录，未读取文章',empty_body:'未取得可读正文',too_many_redirects:'网页跳转过多'};
  const fail=code=>Object.assign(Error(messages[code] || '网页不可公开读取'),{reader_code:code});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try{
    let url=publicUrl(value);
    for(let step=0;step<4;step++){
      if(controller.signal.aborted)throw fail('cancelled');
      diagnostics.phase='dns';
      let onAbort;
      const addresses=await Promise.race([resolve(url.hostname,{all:true,verbatim:true}),new Promise((_,reject)=>{onAbort=()=>reject(fail('cancelled'));controller.signal.addEventListener('abort',onAbort,{once:true});})]).finally(()=>controller.signal.removeEventListener('abort',onAbort));
      if(controller.signal.aborted)throw fail('cancelled');
      if(!addresses.length || addresses.some(a=>!publicAddress(a.address)))throw fail('unsafe_address');
      const chosen=addresses.find(a=>a.family===4) || addresses[0];
      diagnostics.phase='http';diagnostics.http_status=null;diagnostics.content_type='unknown';
      const response=await new Promise((accept,reject)=>{
        const request=(url.protocol==='https:'?https:http).get(url,{agent:false,headers:{'user-agent':'MixTouring-PublicReader/1.0','accept':'text/html,application/xhtml+xml'},signal:controller.signal,lookup:(_host,opts,done)=>opts?.all?done(null,[chosen]):done(null,chosen.address,chosen.family)},res=>{
          diagnostics.http_status=res.statusCode;
          const type=String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          diagnostics.content_type=type==='text/html'?'html':type==='application/xhtml+xml'?'xhtml':type?'other':'unknown';
          if([301,302,303,307,308].includes(res.statusCode)){res.resume();accept({redirect:res.headers.location});return;}
          if(res.statusCode!==200){res.resume();reject(fail('http_'+res.statusCode));return;}
          if(!['html','xhtml'].includes(diagnostics.content_type)){res.resume();reject(fail('non_html'));return;}
          diagnostics.phase='body';let length=0,failed=false;const chunks=[];
          res.on('data',chunk=>{if(failed)return;length+=chunk.length;if(length>maxBytes){failed=true;res.destroy();reject(fail('body_too_large'));}else chunks.push(chunk);});
          res.on('end',()=>{if(failed)return;try{diagnostics.phase='decode';const buffer=Buffer.concat(chunks),header=String(res.headers['content-type'])+' '+buffer.subarray(0,2048).toString('ascii');accept({html:new TextDecoder(/gbk|gb2312|gb18030/i.test(header)?'gb18030':'utf-8').decode(buffer)});}catch{reject(fail('decode_error'));}});res.on('error',reject);
        });request.on('error',reject);
      });
      if(controller.signal.aborted)throw fail('cancelled');
      if(response.redirect){diagnostics.redirects++;diagnostics.phase='validation';url=publicUrl(new URL(response.redirect,url).href);continue;}
      diagnostics.phase='extract';let page;
      try{page=extractPublicPage(response.html);}catch(error){throw fail(error.message.includes('验证')?'verification_required':error.message.includes('登录')?'login_required':'empty_body');}
      diagnostics.phase='complete';diagnostics.elapsed_ms=Date.now()-started;
      return {...page,url:url.href,checked_at:new Date().toISOString(),diagnostics};
    }
    throw fail('too_many_redirects');
  }catch(error){const code=controller.signal.aborted?(signal?.aborted?'cancelled':'timeout'):error.reader_code || (diagnostics.phase==='validation'?'unsafe_url':diagnostics.phase==='dns'?'dns_error':'network_error');diagnostics.elapsed_ms=Date.now()-started;
    return {url:String(value),read_status:'unavailable',reason:messages[code] || (/^http_\d{3}$/.test(code)?'网页返回HTTP '+diagnostics.http_status:'网页不可公开读取'),reason_code:code,checked_at:new Date().toISOString(),diagnostics};}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
