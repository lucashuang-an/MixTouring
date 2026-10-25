/* 客运线索的文本检查；无固定城市或走廊。 */
function serviceClauseUnavailable(clause) {
  const excluded = /物流|货运|货车|货物|托运|freight|cargo|0\s*(?:车次|班次)|暂无|停运|停航|停飞|停驶|停班|停开|取消|中断|暂停|筹备|规划中/i;
  const future = /(?:计划|将|拟|预计|即将|有意|延期|等待|尚待)[^。；;，,！!？?\n]*(?:新?开(?:通|行|航)?|复航|恢复|运营|运行|执飞|直飞)|待(?:开通|开行|开航|复航|运营)/;
  /* 否定词后允许多个情态/状态修饰词，不再依赖固定字符距离；「不经停」不等同否定运营。 */
  const denied = /(?:未|不|没有)(?:能|会|可|曾|再|予以|正式|实际|成功|如期|按期|获准|开始|正常|继续|完全|真正|直接|进行|持续|已经|暂时)*(?:开通|开行|开航|复航|恢复|运营|运行|执飞|直飞|通航)/;
  return excluded.test(clause) || future.test(clause) || denied.test(clause);
}

/** 搜索摘要只作线索；只有同一短句明确连接两端且描述客运，才支持某段的方式。
 * 泛查询／订票页标题即使含起终点与方式，也不能证明实际有该段服务。 */
export function sourceLegConnectionExcerpt(source, from, to, mode) {
  const modeWords = {
    plane: /航班|航空|飞机|机场|直飞|flight|airline/i,
    rail: /客运列车|列车|火车|高铁|动车|铁路|train|rail/i,
    road: /道路客运|公路客运|客运班线|班车|大巴|巴士|长途汽车|bus|coach/i
  };
  if (!modeWords[mode] || !from || !to) return null;
  const title = String(source?.title || '');
  const content = String(source?.content || '');
  const genericTitle = /查询|票价|预订|订票|攻略|怎么走|路线规划/i.test(title) ||
    (/时刻表/.test(title) && !/[A-Z]\d{2,4}/i.test(title));
  if (genericTitle) return null;
  const clauses = title + '。' + content;
  for (const clause of clauses.split(/[。；;，,！!？?\n]/)) {
    if (serviceClauseUnavailable(clause)) continue;
    const start = clause.indexOf(from);
    const end = start < 0 ? -1 : clause.indexOf(to, start + from.length);
    if (end < 0) continue;
    const between = clause.slice(start + from.length, end);
    if (between.length > 48 || !/到|至|往返|—|－|→|经|开往|抵达/.test(between)) continue;
    if (modeWords[mode].test(clause) &&
      /开通|开行|运营|运行|经停|途经|经营许可|始发|抵达|复航|直飞|客运班线|班车|列车|航班/i.test(clause)) {
      return clause.trim().slice(0, 160);
    }
  }
  return null;
}

export function sourceSupportsLeg(source, from, to, mode) {
  return sourceLegConnectionExcerpt(source, from, to, mode) != null;
}
