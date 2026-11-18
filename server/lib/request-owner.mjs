import { AsyncLocalStorage } from 'node:async_hooks';

// 身份只由认证后的HTTP上下文提供，不从请求正文或模型输出读取。
// 无邀请门禁的本机调用与离线回放使用null，不能读取受邀用户的记录。
const context = new AsyncLocalStorage();
export const requestOwner = () => context.getStore() ?? null;
export const ownsRecord = record => !!record && record.owner === requestOwner();
export const withRequestOwner = (owner, execute) => context.run(owner ?? null, execute);
