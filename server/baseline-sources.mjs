/* 手动执行：默认仅展示公开计划；--live 才联网，--replay 只重算本地报告。 */
import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {baselinePlan,runSourceBaseline,summarizeBaseline} from './lib/source-baseline.mjs';
import {searchWebDetailed} from './lib/llm.mjs';
import {readPublicPage} from './lib/public-reader.mjs';
import {tavilyConfigured} from './lib/search-tavily.mjs';
import {compareSourceBaselines,diagnoseBaselineReads} from './lib/source-comparison.mjs';
const args=process.argv.slice(2),dataset=JSON.parse(readFileSync(new URL('../pipeline/data/source-baseline-tasks.json',import.meta.url),'utf8'));
const output=resolve(process.env.SOURCE_BASELINE_OUT || join(tmpdir(),args[0]==='--diagnose-reads'?'mixtouring-reader-diagnostics.json':args[0]==='--compare'?'mixtouring-source-comparison.json':args[0]==='--live' && args[2]==='tavily'?'mixtouring-source-baseline-tavily.json':'mixtouring-source-baseline.json'));
const samePath=(a,b)=>{const path=resolve(a),other=resolve(b);return process.platform==='win32'?path.toLowerCase()===other.toLowerCase():path===other;};
const save=report=>{mkdirSync(dirname(output),{recursive:true});writeFileSync(output+'.tmp',JSON.stringify(report,null,2)+'\n');renameSync(output+'.tmp',output);};
const load=path=>JSON.parse(readFileSync(resolve(path),'utf8'));
const controller=new AbortController();process.once('SIGINT',()=>controller.abort());
try{
if(args[0]==='--replay' && args.length===2){
  const report=JSON.parse(readFileSync(resolve(args[1]),'utf8'));
  if(report.schema_version!==1 || !Array.isArray(report.records))throw Error('不支持的基线报告');
  console.log(JSON.stringify(summarizeBaseline(report.records,report.planned),null,2));
}else if(args[0]==='--compare' && args.length===3){
  if([args[1],args[2]].some(path=>samePath(path,output)))throw Error('对照报告不能覆盖输入基线');
  const report=compareSourceBaselines(load(args[1]),load(args[2]));save(report);console.log(JSON.stringify({status:report.status,delta:report.delta,conclusion:report.conclusion,output},null,2));
}else if(args[0]==='--diagnose-reads' && args.length===2){
  if(samePath(args[1],output))throw Error('诊断报告不能覆盖原始基线');
  const report=await diagnoseBaselineReads(load(args[1]),{readPage:readPublicPage,signal:controller.signal,onRecord:save});save(report);console.log(JSON.stringify({summary:report.summary,output},null,2));if(report.cancelled)process.exitCode=1;
}else if(args[0]==='--live' && (args.length===1 || args.length===3 && args[1]==='--provider')){
  const provider=args[2] || 'current';if(!['current','tavily'].includes(provider))throw Error('搜索服务仅支持current或tavily');
  if(provider==='tavily' && !tavilyConfigured())throw Error('Tavily未配置；请在本机server/.env添加TAVILY_API_KEY，不会将未配置记为零命中');
  const report=await runSourceBaseline(dataset,{search:searchWebDetailed,readPage:readPublicPage,provider,signal:controller.signal,onRecord:(report,record)=>{
    save(report);console.log(`${report.records.length}/${report.planned} ${record.task_id} 第${record.repeat}轮：${record.outcome}；来源${record.sources.length}；读取${record.reads.filter(r=>r.identity_match).length}/${record.reads.length}`);
  }});save(report);console.log(JSON.stringify(report.summary,null,2));console.log('私有报告：'+output);
  if(report.cancelled || report.records.length!==report.planned)process.exitCode=1;
}else if(args.length===0){console.log(dataset.profile);console.log(JSON.stringify(baselinePlan(dataset).map(({task,...p})=>({id:task.id,...p})),null,2));}
else throw Error('参数支持 --live [--provider current|tavily]、--replay 报告、--compare 左报告 右报告、--diagnose-reads 报告');
}catch(error){console.error('基线工具：'+error.message);process.exitCode=1;}
