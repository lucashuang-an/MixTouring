import {AsyncLocalStorage} from 'node:async_hooks';

// 每个请求绑定自己的持久服务，不能通过全局变量切换用户或 Durable Object。
const services = new AsyncLocalStorage();
export const runtimeServices = () => services.getStore();
export const withRuntimeServices = (value, execute) => services.run(value, execute);
