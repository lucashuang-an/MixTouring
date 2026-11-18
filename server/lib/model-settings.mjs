import {AsyncLocalStorage} from 'node:async_hooks';
// 推理设置属于请求执行参数，不属于旅行条件，也不能通过客户端覆盖服务器时间上限。
const settings=new AsyncLocalStorage();
export const REASONING_EFFORTS=Object.freeze(['low','medium','high','xhigh','max']);
export function reasoningEffort(value=process.env.OPENAI_REASONING_EFFORT || 'low'){
  if(!REASONING_EFFORTS.includes(value))throw Object.assign(Error('推理强度无效。'),{status:400,expose:true});
  return value;
}
export const currentModelSettings=()=>settings.getStore() || {};
export const withModelSettings=(value,run)=>settings.run(Object.freeze(value),run);
export function reasoningBudget(effort){
  const index=REASONING_EFFORTS.indexOf(reasoningEffort(effort));
  return {turnMs:[360000,480000,600000,660000,720000][index],stageMs:[45000,60000,90000,120000,180000][index],composeMs:[90000,120000,180000,240000,300000][index]};
}
export function modelStageTimeout(opts,effort,remainingMs){
  const policy=reasoningBudget(effort);
  const compose=opts.instruction_phase==='compose' || opts.instruction_phase==='compose_local' || opts.kind==='planning_outline';
  return Math.max(1,Math.min(Math.max(opts.timeoutMs || 12000,compose?policy.composeMs:policy.stageMs),remainingMs));
}
