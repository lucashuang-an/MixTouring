/* 只检查指定配置文件，不加载本机.env、不发供应商请求、不输出凭据。 */
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAccessPolicy} from './lib/access-policy.mjs';
import {upstreamBudgetConfig} from './lib/upstream-budget.mjs';
import {webSearchConfigured} from './lib/trip-service.mjs';
import {reasoningEffort} from './lib/model-settings.mjs';

export function releaseConfigErrors(env){
 const errors=[];
 if(env.MT_PUBLIC!=='1')errors.push('必须启用MT_PUBLIC=1');
 try{createAccessPolicy(env);}catch{errors.push('邀请凭据、HTTPS Origin、限流或代理配置无效');}
 try{upstreamBudgetConfig(env);}catch{errors.push('上游调用次数或费用配置无效');}
 if(!env.MT_DAILY_UPSTREAM_LIMIT)errors.push('须明确填写MT_DAILY_UPSTREAM_LIMIT');
 const keys=['DEEPSEEK_KEY','DEEPSEEK_API_KEY','VOLC_SEARCH_API_KEY','LLM_API_KEY','TAVILY_API_KEY','GOOGLE_MAPS_API_KEY','OPENAI_API_KEY','OPENAI_KEY'];
 if(keys.some(k=>env[k]!==undefined && (!env[k].trim() || env[k]!==env[k].trim())))errors.push('供应商密钥不能为空白或含首尾空格');
 const placeholder=v=>/replace|your[-_ ]|example|changeme|<|>/i.test(v || '');
 if(keys.some(k=>env[k] && placeholder(env[k])))errors.push('供应商密钥仍含占位文本');
 const openai=env.MT_COMPOSE_PROVIDER==='openai' || !env.MT_COMPOSE_PROVIDER && !!(env.OPENAI_API_KEY || env.OPENAI_KEY);
 if(!(openai?[env.OPENAI_API_KEY,env.OPENAI_KEY]:keys.slice(0,4).map(k=>env[k])).some(v=>v?.trim()))errors.push('缺少主模型配置');
 if(openai){try{reasoningEffort(env.OPENAI_REASONING_EFFORT || 'low');}catch{errors.push('OpenAI推理强度无效');}}
 if(!webSearchConfigured(env).configured)errors.push('搜索服务未配置或供应商不受支持');
 try{const host=new URL(env.MT_PUBLIC_ORIGIN).hostname;if(placeholder(host)||/\.(test|invalid|localhost)$/.test(host)||host==='localhost')errors.push('公开Origin仍为示例地址');}catch{}
 if(env.MAP_PROVIDER==='google'&&!env.GOOGLE_MAPS_API_KEY?.trim())errors.push('Google地图已启用但未配置密钥');
 if(env.PORT && env.PORT!=='3000')errors.push('当前Compose要求容器PORT=3000；宿主机端口用MT_PORT设置');
 if(env.MT_BUDGET_FILE && env.MT_BUDGET_FILE!=='/app/server/.state/upstream-budget.json' && env.MT_BUDGET_FILE!=='.state/upstream-budget.json')errors.push('当前Compose额度账本须使用.state/upstream-budget.json持久路径');
 return errors;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  if(process.argv.length!==3)throw Error();
  const errors=releaseConfigErrors(parseEnv(readFileSync(process.argv[2],'utf8')));
  if(errors.length){for(const error of errors)console.error('✗ '+error);process.exitCode=1;}
  else console.log('✓ 部署配置结构通过；尚未联网验证供应商、TLS或实际账单额度');
 }catch{console.error('无法读取配置。用法：node server/check-release-config.mjs <仓库外的运行环境文件>');process.exitCode=1;}
}
