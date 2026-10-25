/* 国家属于旅行范围，不能直接作为跨城交通端点。使用运行时国家名表识别层级。 */
const countries = new Map();
const zh = new Intl.DisplayNames(['zh-CN'], { type:'region' });
const en = new Intl.DisplayNames(['en'], { type:'region' });
const normalize = v => String(v || '').trim().toLowerCase();
for(let a=65;a<=90;a++)for(let b=65;b<=90;b++){
  const code=String.fromCharCode(a,b),name=zh.of(code),latin=en.of(code);
  if(name===code || latin===code)continue;
  const country={name,code};countries.set(normalize(name),country);countries.set(normalize(latin),country);
}
for(const [alias,code] of [['吉尔吉斯共和国','KG'],['吉尔吉斯','KG'],['吉国','KG'],['土耳其','TR']])countries.set(normalize(alias),{name:zh.of(code),code});
export function countryScope(value){
  const key=normalize(value),scope=countries.get(key);
  /* 城市国家／城市地区可作端点，此层只判断地域层级，不读旧地点库。 */
  return ['SG','HK','MO'].includes(scope?.code) ? null : scope || null;
}
