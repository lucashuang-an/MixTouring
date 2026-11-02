/* 通用运行层：调用、结果、观察和本轮执行状态；不解释旅行完成条件。 */
import {createHash,randomUUID} from 'node:crypto';
const stable=value=>Array.isArray(value)?value.map(stable):value && typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const copy=value=>value===undefined?null:structuredClone(value);
// 长稿需要更多确定性的证据批次；资源保护随已登记工作量扩展，不作为任务完成判据。
export const validationModelCapacity=fieldCount=>Math.min(80,20+2*Math.ceil(Math.max(0,Number(fieldCount)||0)/12));
export class RunInterrupted extends Error{
  constructor(reason){super('运行中断：'+reason);this.name='RunInterrupted';this.code='RUN_INTERRUPTED';this.reason=reason;}
}
export function createAgentRuntime({onEvent=()=>{}}={}){
  const id=randomUUID(),tools=new Map(),cache=new Map(),failures=new Map(),observations=[];
  let sequence=0,interruption=null,requests=0;
  const emit=event=>{try{onEvent({...event,run_id:id});}catch{}};
  const interrupt=reason=>{interruption ||= reason;return new RunInterrupted(interruption);};
  const assertActive=signal=>{if(interruption)throw new RunInterrupted(interruption);if(signal?.aborted)throw interrupt(signal.reason?.name==='TimeoutError'?'deadline':'cancelled');};
  const observe=(call,result)=>{
    const observation={call_id:call.id,tool:call.name,status:result.status,reused:result.reused===true,
      result_hash:result.data==null?null:hash(result.data),reason:result.reason || null};
    observations.push(observation);emit({stage:'tool_result',...observation});return result;
  };
  return {
    id,interrupt,assertActive,
    hasTool(name){return tools.has(name);},
    register(name,{validate,execute,classify=()=> 'success',readOnly=false}){
      if(tools.has(name))throw Error('工具重复注册：'+name);
      tools.set(name,{validate,execute,classify,readOnly});
    },
    async call(name,args,{scope={},signal,retry=false,context}={}){
      assertActive(signal);
      const call={id:id+':'+(++sequence),name,args:copy(args)};
      emit({stage:'tool_call',status:'started',call_id:call.id,tool:name});
      const tool=tools.get(name);
      if(!tool || !tool.validate(call.args))return observe(call,{call_id:call.id,status:'error',data:null,reason:tool?'invalid_arguments':'unknown_tool'});
      const identity=hash({name,args:call.args,scope});
      if(tool.readOnly && (failures.get(identity) || 0)>=2)return observe(call,{call_id:call.id,status:'error',data:null,reason:'repeated_failure'});
      let promise=tool.readOnly && !retry?cache.get(identity):null;
      const reused=!!promise;
      if(!promise){
        promise=Promise.resolve().then(async()=>{
          assertActive(signal);
          const data=await tool.execute(copy(call.args),{signal,context});
          assertActive(signal); // 取消后到达的结果不能再作为成功观察或提交状态。
          const status=tool.classify(data);
          if(!['success','empty','error'].includes(status))throw Error('invalid_tool_result');
          return {status,data:copy(data),reason:status==='error'?(typeof data?.reason_code==='string' && /^[a-z_]{1,60}$/.test(data.reason_code)?data.reason_code:'tool_unavailable'):null};
        });
        if(tool.readOnly)cache.set(identity,promise);
      }
      try{
        const result=await promise;assertActive(signal);
        if(result.status==='error'){cache.delete(identity);if(!reused)failures.set(identity,(failures.get(identity)||0)+1);}else failures.delete(identity);
        return observe(call,{...copy(result),call_id:call.id,reused});
      }catch(error){
        cache.delete(identity);
        if(error.code==='RUN_INTERRUPTED' || signal?.aborted){
          const failure=error.code==='RUN_INTERRUPTED'?interrupt(error.reason):interrupt(signal.reason?.name==='TimeoutError'?'deadline':'cancelled');
          observe(call,{call_id:call.id,status:'interrupted',data:null,reason:failure.reason});throw failure;
        }
        if(!reused)failures.set(identity,(failures.get(identity)||0)+1);
        // 不把供应商异常正文或认证信息注入模型／日志。
        return observe(call,{call_id:call.id,status:'error',data:null,reason:'tool_failed'});
      }
    },
    prepareRequest(payload,{current,phase,includeObservations=true}={}){
      const prepared=copy(payload);
      if(current && Object.hasOwn(prepared,'current'))prepared.current=copy(current);
      // 每轮从最新权威状态和工具观察重建；观察只描述执行，不是事实证据。
      if(includeObservations && observations.length)prepared.execution_observations=copy(observations.slice(-6));
      if(!includeObservations)delete prepared.execution_observations;
      emit({stage:'context_prepared',status:'completed',request:++requests,phase:phase || null,
        state_hash:current?hash(current):null,observation_count:observations.length});
      return prepared;
    },
    finish({status='completed',taskState='active',reason=null,checks=[]}={}){
      const run={id,status:interruption?'interrupted':status,reason:interruption || reason,
        tool_calls:sequence,context_builds:requests,observation_count:observations.length};
      const task={scope:'current_request',state:interruption?'active':taskState,checks:copy(checks)};
      emit({stage:'run_finished',status:run.status,task_state:task.state,reason:run.reason});
      return {run,task};
    },
    get interruption(){return interruption;},
    get observations(){return copy(observations);}
  };
}
