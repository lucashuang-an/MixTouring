/* 请求级取消信号（#32）：两侧判定——
 * 请求侧：请求体未读完（readableEnded=false）即 close，是提交阶段断开；
 * 响应侧：处理进行中（等待模型/检索）响应未正常写完（writableEnded=false）即 close，
 * 是客户端在等待回复时断开。正常完成两个条件都不满足，不会误杀。 */
export function createRequestSignal(req, res) {
  const controller = new AbortController();
  req.on('close', () => { if (!req.readableEnded) controller.abort(new Error('客户端已断开')); });
  if (res) res.on('close', () => { if (!res.writableEnded) controller.abort(new Error('客户端已断开')); });
  return controller.signal;
}
