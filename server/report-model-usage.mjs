/* 仅汇总已有用量，不发请求。费用需显式提供价格快照，默认保持未知。 */
import {readFileSync,writeFileSync} from 'node:fs';
import {summarizeModelUsage} from './lib/model-usage.mjs';
const args=process.argv.slice(2),input=args.find(a=>a.startsWith('--input='))?.slice(8),output=args.find(a=>a.startsWith('--out='))?.slice(6),ratesFile=args.find(a=>a.startsWith('--rates='))?.slice(8);
if(!input)throw Error('用法：--input=用量JSONL [--rates=价格快照JSON] [--out=汇总JSON]');
const rows=[];let invalid=0;for(const line of readFileSync(input,'utf8').split('\n').filter(l=>l.trim())){try{const row=JSON.parse(line);if(!row||typeof row!=='object'||Array.isArray(row))throw Error('shape');rows.push(row);}catch{invalid++;}}
const rates=ratesFile?JSON.parse(readFileSync(ratesFile,'utf8')):{};
const result={...summarizeModelUsage(rows,{rateFor:r=>rates[r.provider+'|'+r.requested_model] || null}),invalid_log_rows:invalid};
const text=JSON.stringify(result,null,2);if(output)writeFileSync(output,text);else console.log(text);
