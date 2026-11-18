/* 无模型故障时也能沿用用户输入语言；明确的回复语言要求优先。 */
export function englishRequest(input={}) {
 const messages=[...(input.messages || []).filter(m=>m.role==='user').map(m=>m.text),input.text].filter(Boolean);
 for(const text of [...messages].reverse()){
  if(/(?:reply|respond|answer)\s+in\s+English|用英文(?:回答|回复)/i.test(text))return true;
  if(/(?:reply|respond|answer)\s+in\s+Chinese|用中文(?:回答|回复)/i.test(text))return false;
 }
 const text=messages.at(-1) || '';
 return /[a-z]{2,}/i.test(text) && !/[\u3400-\u9fff]/.test(text);
}
