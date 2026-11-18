import {INPUT_LAYOUT_POLICY} from './lib/input-layout.mjs';
/* 显式实网回放：固定代码/规则/时钟，逐轮保留失败；不作为产品候选。 */
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {conversationTurn} from './lib/conversation.mjs';
import {AGENT_RULES_VERSION} from './lib/agent-prompts.mjs';
import {composeModelInfo} from './lib/llm.mjs';
const args=process.argv.slice(2),outArg=args.find(a=>a.startsWith('--out='));
if(!args.includes('--live')||!outArg)throw Error('仅显式运行：node --env-file=server/.env server/replay-planning.mjs --live --out=私有目录');
const root=fileURLToPath(new URL('../',import.meta.url)),out=resolve(outArg.slice(6));await mkdir(out,{recursive:true});
async function codeHash(){const hash=createHash('sha256');for(const dir of ['server/lib','mixtouring-hifi/assets']){for(const name of (await readdir(join(root,dir))).sort()){if(!/\.(?:mjs|js)$/.test(name))continue;hash.update(dir+'/'+name);hash.update(await readFile(join(root,dir,name)));}}hash.update(await readFile(join(root,'AGENTS.md')));return hash.digest('hex');}
const cases=[{id:'domestic',days:3,text:'从成都出发去乐山，3天单程，不返回成都，一个人，不自驾，喜欢文化和街区慢逛。日期未定，先讨论。'}, {id:'international',days:5,text:'从大阪出发到京都，5天含往返，一个人，公共交通，偏历史文化，不推荐酒店，日期未定，先讨论。'}, {id:'regions',days:15,text:'北京出发，越南和印尼共15天，最后回北京，一个人，不自驾，偏文化与海边，先聊城市和路线选择，不生成日程。'}];
const chosen=args.find(a=>a.startsWith('--case='))?.slice(7),repetitions=Number(args.find(a=>a.startsWith('--repeat='))?.slice(9)||1);
if(!Number.isInteger(repetitions)||repetitions<1||repetitions>3||chosen&&!cases.some(c=>c.id===chosen))throw Error('回放参数无效');
const manifest={started_at:new Date().toISOString(),code_before:await codeHash(),rules:AGENT_RULES_VERSION,model:composeModelInfo(),input_layouts:INPUT_LAYOUT_POLICY,samples:[]};await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2));
const now=Date.now();
for(const test of cases.filter(c=>!chosen||c.id===chosen))for(let repeat=1;repeat<=repetitions;repeat++){
 let state={messages:[],preferences:{},travel:{},constraints:{},sights:{}},turns=[];
 async function send(text,action='chat'){
  const usage=[],trace=[],input={...state,text,action,current_message:{mid:state.messages.length+1,role:'user',text}},start=Date.now();
  const result=await conversationTurn(input,null,{now,taskId:'replay-'+test.id+'-'+repeat+'-'+turns.length,onTrace:e=>trace.push(e),onModelUsage:e=>usage.push(e)});
  turns.push({input,result,elapsed_ms:Date.now()-start,usage,trace});
  if(result.status==='ok'){state={...state,conversation:result.conversation};for(const key of ['preferences','travel','constraints','sights'])state[key]={...state[key],...result.patch?.[key]};state.messages.push(input.current_message,{mid:state.messages.length+2,role:'assistant',text:result.reply});}
  // transport_updates不落盘，避免保存地图供应商观察。
  await writeFile(join(out,test.id+'-'+repeat+'.json'),JSON.stringify({test,repeat,turns},(key,value)=>key==='transport_updates'?undefined:value,2));
  console.log(JSON.stringify({case:test.id,repeat,action,status:result.status,task_status:result.task_status,cards:result.conversation?.draft?.cards?.length || 0,elapsed_ms:Date.now()-start,reply:result.reply?.slice(0,140)}));return result;
 }
 let r=await send(test.text);
 if(r.status==='ok')r=await send(test.id==='regions'?'请给两种不同的城市组合与文字粗略方案，说明取舍，暂不生成日卡。':'请给一个文字粗略方案，按已说的偏好安排，暂不生成日卡。');
 const beforeConfirmation=!r.conversation?.draft;
 if(test.id!=='regions'&&r.status==='ok'&&r.conversation?.discussion?.options?.length){r=await send('按第一个粗略方案生成完整逐日攻略。');if(r.next_action?.type==='generate')r=await send('按已确认的方案生成完整逐日攻略。','generate');}
 const summary={id:test.id,repeat,initial_discussion_only:!turns[0].result.conversation?.draft,before_confirmation_no_draft:beforeConfirmation,status:r.status,task_status:r.task_status,cards:r.conversation?.draft?.cards?.length||0,coverage:r.delivery_validation,elapsed_ms:turns.reduce((s,t)=>s+t.elapsed_ms,0)};manifest.samples.push(summary);await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2));
}
manifest.code_after=await codeHash();manifest.code_unchanged=manifest.code_before===manifest.code_after;await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({code_unchanged:manifest.code_unchanged,samples:manifest.samples.length}));
