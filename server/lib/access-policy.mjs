import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export function createAccessPolicy(env = process.env, clock = Date.now) {
  const publicMode = env.MT_PUBLIC === '1';
  const users = JSON.parse(env.MT_ACCESS_USERS || '{}');
  if (!users || Array.isArray(users) || typeof users !== 'object' || Object.entries(users).some(([name, hash]) => !/^[a-zA-Z0-9_-]{1,64}$/.test(name) || !/^[a-f0-9]{64}$/.test(hash))) throw Error('访问凭据配置无效');
  const protectedMode = Object.keys(users).length > 0;
  if (publicMode && !protectedMode) throw Error('公开模式需要MT_ACCESS_USERS访问凭据');
  const number = (name, fallback) => {
    const value = Number(env[name] || fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw Error(name + '必须为正整数');
    return value;
  };
  const maxActive = number('MT_MAX_CONCURRENT', 4), maxRate = number('MT_API_PER_MINUTE', publicMode ? 20 : 200);
  const trusted = (env.MT_TRUSTED_PROXIES || '').split(',').filter(Boolean);
  if (trusted.some(ip => !isIP(ip))) throw Error('代理地址配置无效');
  const origin = env.MT_PUBLIC_ORIGIN || null;
  if (publicMode && (!origin || new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin)) throw Error('公开模式需要HTTPS的MT_PUBLIC_ORIGIN');
  const buckets = new Map(); let active = 0;
  function allowed(key, limit) {
    const now = clock();
    for (const [id, bucket] of buckets) if (bucket.until <= now) buckets.delete(id);
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= 10000) return false;
      bucket = { count: 0, until: now + 60000 }; buckets.set(key, bucket);
    }
    return ++bucket.count <= limit;
  }
  return async function access(ctx, next) {
    ctx.set('X-Content-Type-Options','nosniff');
    ctx.set('X-Frame-Options','DENY');
    ctx.set('Content-Security-Policy',"frame-ancestors 'none'");
    ctx.set('Referrer-Policy','strict-origin-when-cross-origin');
    if (['/healthz','/readyz'].includes(ctx.path)) return next();
    if(ctx.state.accountPublic)return next();
    const peer = ctx.req.socket?.remoteAddress || 'unknown';
    const forwarded = ctx.get('x-real-ip');
    const ip = trusted.includes(peer) && isIP(forwarded) ? forwarded : peer;
    function reject(status, message) {
      ctx.status = status; ctx.set('Cache-Control','no-store');
      if (status === 429) ctx.set('Retry-After','60');
      ctx.body = { code: 1, msg: message };
    }
    let user = ctx.state.accessUser || null;
    if (protectedMode && !user) {
      const header = ctx.get('authorization');
      const decoded = /^Basic [A-Za-z0-9+/=]+$/.test(header) && header.length < 2048 ? Buffer.from(header.slice(6),'base64').toString('utf8') : '';
      const colon = decoded.indexOf(':');
      const name = decoded.slice(0,colon), password = decoded.slice(colon+1);
      const expected = users[name];
      const actual = createHash('sha256').update(password).digest();
      const valid = colon > 0 && typeof expected === 'string' && timingSafeEqual(actual, Buffer.from(expected,'hex'));
      if (!valid) {
        if (!allowed('auth:' + ip, 10)) return reject(429,'访问尝试过于频繁，请稍后再试');
        ctx.set('WWW-Authenticate','Basic realm="MixTouring", charset="UTF-8"');
        return reject(401,'需要有效的邀请访问凭据');
      }
      user = name;
    }
    ctx.state.accessUser = user;
    if (!ctx.path.startsWith('/api/')) return next();
    if (publicMode && (ctx.get('sec-fetch-site') === 'cross-site' || ctx.get('origin') && ctx.get('origin') !== origin)) return reject(403,'请求来源不被允许');
    if (!allowed('ip:' + ip, maxRate) || user && !allowed('user:' + user, maxRate)) return reject(429,'请求过于频繁，请稍后再试');
    if (active >= maxActive) return reject(429,'正在处理的请求较多，请稍后再试');
    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    try {
      await next();
      const work = ctx.state.apiWork || ctx.body?.completion;
      if (work) Promise.resolve(work).then(release, release);
      else release();
    } catch (error) { release(); throw error; }
  };
}
