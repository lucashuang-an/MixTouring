/* 用户硬要求与助手建议分开；日期范围和分配对照不依赖固定目的地。 */
export const placeKey=value=>String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,'').replace(/市$/,'');
export const samePlace=(a,b)=>!!placeKey(a)&&placeKey(a)===placeKey(b);
export function dayNumber(value){
 const s=String(value).replace(/两/g,'二');if(/^\d+$/.test(s))return Number(s);
 const digits='零一二三四五六七八九';if(s==='十')return 10;
 if(/^[一二三四五六七八九]?十[一二三四五六七八九]?$/.test(s)){const [a,b]=s.split('十');return (a?digits.indexOf(a):1)*10+(b?digits.indexOf(b):0);}
 return s.length===1?digits.indexOf(s):NaN;
}
export function mentionedDays(text){
 const numbers=new Set(),digit='[0-9零一二两三四五六七八九十]+';
 const pattern=new RegExp('第\\s*('+digit+')(?:\\s*天)?(?:\\s*(?:至|到|[-—–~～])\\s*(?:第\\s*)?('+digit+'))?\\s*天','g');
 const normalized=String(text).replace(/\bDays?\s*(\d{1,2})(?:\s*(?:to|[-–—])\s*(\d{1,2}))?(?!\d)/gi,(_,a,b)=>'第'+a+(b?'至'+b:'')+'天');
 for(const m of normalized.matchAll(pattern)){
  const a=dayNumber(m[1]),b=m[2]?dayNumber(m[2]):a;if(!Number.isInteger(a)||!Number.isInteger(b)||a<1||b<a||b>60)continue;
  for(let d=a;d<=b;d++)numbers.add(d);
 }
 return numbers;
}
export function cleanStayLocks(value){return (Array.isArray(value)?value:[]).flatMap(x=>{
 if(!x||typeof x.place!=='string'||!x.place.trim())return [];
 const base={place:x.place.trim().slice(0,80),quote:typeof x.quote==='string'?x.quote.slice(0,500):''};
 if(Number.isInteger(x.days)&&x.days>=1&&x.days<=60)return [{place:base.place,days:x.days,quote:base.quote}];
 const min=x.min_days??0,max=x.max_days??60;
 if((x.min_days==null&&x.max_days==null)||!Number.isInteger(min)||!Number.isInteger(max)||min<0||max<1||max>60||min>max)return [];
 return [{...base,min_days:x.min_days??null,max_days:x.max_days??null}];
}).slice(0,12);}
export const staySatisfied=(lock,days)=>Number.isInteger(lock.days)?days===lock.days:days>=(lock.min_days??0)&&days<=(lock.max_days??Infinity);
export function updateStayLocks(before,planning,text){
 const quoted=x=>typeof x?.quote==='string'&&x.quote.trim().length>=2&&String(text).includes(x.quote);
 let locks=cleanStayLocks(before);
 for(const x of Array.isArray(planning?.unlock_stays)?planning.unlock_stays:[])if(quoted(x))locks=locks.filter(l=>!samePlace(l.place,x.place));
 for(const x of cleanStayLocks(planning?.stay_locks))if(quoted(x))locks=locks.filter(l=>!samePlace(l.place,x.place)).concat(x);
 return locks;
}
export function outlineTotal(outline){
 if(!outline||!Array.isArray(outline.segments)||!outline.segments.length||![outline.outbound_days,outline.return_days,...outline.segments.map(s=>s.days)].every(d=>Number.isInteger(d)&&d>=0))return null;
 return outline.segments.reduce((n,s)=>n+s.days,outline.outbound_days+outline.return_days);
}
export function outlineDayPlan(outline){
 const total=outlineTotal(outline);if(!total || total>60)return [];
 const days=[],origin=outline.route?.[0],first=outline.segments[0].place,last=outline.segments.at(-1).place;
 const add=(count,info)=>{for(let i=0;i<count;i++)days.push({day:days.length+1,...info});};
 add(outline.outbound_days,{role:'outbound',from:origin,to:first});
 for(const segment of outline.segments)add(segment.days,{role:'stay',city:segment.place});
 add(outline.return_days,{role:'return',from:last,to:origin});return days;
}
export function allocationReview(draft,outline,locks=[]){
 const total=outlineTotal(outline),cards=draft?.cards || [],days=new Map();
 for(const c of cards)for(const day of mentionedDays(c.label)){if(days.has(day))return {changes:[],hard_issues:locks.length?[{reason:'duplicate_day'}]:[]};days.set(day,c.place);}
 const matching=total && days.size===total && Math.max(...days.keys())===total;
 const actual=new Map(),expected=new Map();
 for(const [day,place]of days){
  if(total && (day<=outline.outbound_days || day>Math.max(...days.keys())-outline.return_days))continue;
  actual.set(placeKey(place),(actual.get(placeKey(place))||0)+1);
 }
 const groups=new Map();
 for(const s of outline?.segments || []){
  expected.set(placeKey(s.place),(expected.get(placeKey(s.place))||0)+s.days);
  if(s.scope){const members=groups.get(placeKey(s.scope)) || new Set();members.add(placeKey(s.place));groups.set(placeKey(s.scope),members);}
 }
 const count=place=>groups.has(placeKey(place))?[...groups.get(placeKey(place))].reduce((n,p)=>n+(actual.get(p)||0),0):actual.get(placeKey(place))||0;
 const hard_issues=cleanStayLocks(locks).filter(l=>!staySatisfied(l,count(l.place))).map(l=>({place:l.place,expected:l.days??{min_days:l.min_days,max_days:l.max_days},actual:count(l.place)}));
 const seen=new Set(),changes=[];
 if(matching)for(const s of outline.segments){const key=placeKey(s.place);if(seen.has(key))continue;seen.add(key);if(expected.get(key)!==(actual.get(key)||0))changes.push({place:s.place,before_days:expected.get(key),after_days:actual.get(key)||0});}
 if(outline?.preserve_allocation)hard_issues.push(...changes.map(c=>({reason:'confirmed_allocation_changed',place:c.place,expected:c.before_days,actual:c.after_days})));
 return {changes,hard_issues};
}
export function allocationMessage(changes,{accepted=true,en=false}={}){
 if(!changes?.length)return '';
 if(en)return (accepted?'The allocation changed: ':'The allocation still needs adjustment: ')+changes.map(c=>c.place+': '+c.before_days+' days planned, '+c.after_days+' days in the draft').join('; ')+'.';
 return (accepted?'相比粗略方案，建议分配调整为：':'当前停留分配尚未符合已确认方案：')+changes.map(c=>accepted?c.place+'由'+c.before_days+'天调整为'+c.after_days+'天':c.place+'原定'+c.before_days+'天，当前'+c.after_days+'天').join('；')+(accepted?'；以当前逐日安排为准。':'。');
}
