/* 手动执行：默认仅展示公开计划；--live 才联网，--replay 只重算本地报告。 */
import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {baselinePlan,runSourceBaseline,summarizeBaseline} from './lib/source-baseline.mjs';
import {searchWebDetailed} from './lib/llm.mjs';
import {readPublicPage} from './lib/public-reader.mjs';
const args=process.argv.slice(2),dataset=JSON.parse(readFileSync(new URL('../pipeline/data/source-baseline-tasks.json',import.meta.url),'utf8'));
const output=resolve(process.env.SOURCE_BASELINE_OUT || join(tmpdir(),'mixtouring-source-baseline.json'));
const save=report=>{mkdirSync(dirname(output),{recursive:true});writeFileSync(output+'.tmp',JSON.stringify(report,null,2)+'\n');renameSync(output+'.tmp',output);};
if(args[0]==='--replay'){
  const report=JSON.parse(readFileSync(resolve(args[1]),'utf8'));
  if(report.schema_version!==1 || !Array.isArray(report.records))throw Error('不支持的基线报告');
  console.log(JSON.stringify(summarizeBaseline(report.records,report.planned),null,2));
}else if(args.length===1 && args[0]==='--live'){
  const controller=new AbortController();process.once('SIGINT',()=>controller.abort());
  const report=await runSourceBaseline(dataset,{search:searchWebDetailed,readPage:readPublicPage,signal:controller.signal,onRecord:(report,record)=>{
    save(report);console.log(`${report.records.length}/${report.planned} ${record.task_id} 第${record.repeat}轮：${record.outcome}；来源${record.sources.length}；读取${record.reads.filter(r=>r.identity_match).length}/${record.reads.length}`);
  }});save(report);console.log(JSON.stringify(report.summary,null,2));console.log('私有报告：'+output);
  if(report.cancelled || report.records.length!==report.planned)process.exitCode=1;
}else if(args.length===0){console.log(dataset.profile);console.log(JSON.stringify(baselinePlan(dataset).map(({task,...p})=>({id:task.id,...p})),null,2));}
else throw Error('参数仅支持 --live 或 --replay 报告路径');
