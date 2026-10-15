/* 请求级取消信号（#32）：客户端提前断开才视为取消；请求体已读完（readableEnded）后的
 * close 是正常完成，不得误杀在途处理。返回 AbortSignal 供对话/检索编排贯穿下游。 */
export function createRequestSignal(req) {
  const controller = new AbortController();
  req.on('close', () => { if (!req.readableEnded) controller.abort(new Error('客户端已断开')); });
  return controller.signal;
}
