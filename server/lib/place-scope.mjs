/* 国家属于旅行范围，不能直接作为跨城交通端点。使用运行时国家名表识别层级。 */
import { readFileSync } from 'node:fs';
const countries = new Map();
const zh = new Intl.DisplayNames(['zh-CN'], { type:'region' });
const en = new Intl.DisplayNames(['en'], { type:'region' });
const normalize = v => String(v || '').trim().toLowerCase();
const cityNames=new Set(JSON.parse(readFileSync(new URL('../../pipeline/data/places.json',import.meta.url),'utf8')).places
  .filter(p=>p.kind==='city').flatMap(p=>[p.name,...p.aliases || []]).map(normalize));
for(let a=65;a<=90;a++)for(let b=65;b<=90;b++){
  const code=String.fromCharCode(a,b),name=zh.of(code),latin=en.of(code);
  if(name===code || latin===code)continue;
  const country={name,code};countries.set(normalize(name),country);countries.set(normalize(latin),country);
}
for(const [alias,code] of [['吉尔吉斯共和国','KG'],['吉尔吉斯','KG'],['吉国','KG'],['土耳其','TR']])countries.set(normalize(alias),{name:zh.of(code),code});
export function countryScope(value){
  const key=normalize(value),scope=countries.get(key);
  /* 已有城市与城市国家仍可作端点，例如香港、澳门、新加坡。 */
  return cityNames.has(key) || scope?.code==='SG' ? null : scope || null;
}
