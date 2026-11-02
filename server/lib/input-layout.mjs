/* 仅在发送边界重排已组装JSON的顶层键；不裁剪、不改值、不改变数组。 */
const switches=Object.freeze({conversation_evidence_extract:process.env.MT_CACHE_LAYOUT_EXTRACT || 'baseline',conversation_delivery_patch:process.env.MT_CACHE_LAYOUT_PATCH || 'baseline'});
export const INPUT_LAYOUT_POLICY=Object.freeze(Object.fromEntries(Object.entries(switches).map(([kind,value])=>[kind,value==='cache_v1'?'cache_v1':'baseline'])));
const specs={
 conversation_evidence_extract:{front:['evidence_catalog','source_refs','output_use','planning_conditions'],back:['fields','execution_observations','manifest']},
 conversation_delivery_patch:{front:['evidence_catalog','source_refs','numeric_fact_catalog','conditions'],back:['fields','removed_statements','review_feedback','correction','field_correction','execution_observations','manifest']}
};
export function prepareInputLayout({kind,user,webSearch=false,inputLayout}={}){
 const baseline=reason=>({user,input_layout_version:'baseline',layout_reason:reason,payload_bytes:typeof user==='string'?Buffer.byteLength(user):null});
 if(!Object.hasOwn(specs,kind || ''))return baseline('stage_not_enabled');
 const mode=inputLayout ?? switches[kind];if(mode!=='cache_v1')return baseline(mode==='baseline'?'disabled':'invalid_configuration');
 if(webSearch || typeof user!=='string')return baseline('unsupported_input');
 let value;try{value=JSON.parse(user);}catch{return baseline('invalid_json');}
 if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.fields)||!value.evidence_catalog||typeof value.evidence_catalog!=='object'||Array.isArray(value.evidence_catalog))return baseline('invalid_shape');
 if(kind==='conversation_evidence_extract'&&value.output_use!=='proposed_itinerary')return baseline('variant_not_enabled');
 if(!Array.isArray(value.evidence_catalog.entries)||value.fields.some(field=>!field||typeof field!=='object'||Array.isArray(field)||typeof field.text!=='string'||(kind==='conversation_evidence_extract'?(typeof field.id!=='string'||!Array.isArray(field.assertion_spans)):typeof field.path!=='string')))return baseline('invalid_shape');
 // 非规范JSON可能含重复键或不同转义；不擅自消除这些差异。
 if(JSON.stringify(value)!==user)return baseline('noncanonical_json');
 const {front,back}=specs[kind],keys=Object.keys(value),order=[...front.filter(k=>Object.hasOwn(value,k)),...keys.filter(k=>!front.includes(k)&&!back.includes(k)),...back.filter(k=>Object.hasOwn(value,k))];
 const reordered=JSON.stringify(Object.fromEntries(order.map(key=>[key,value[key]])));
 if(Buffer.byteLength(reordered)!==Buffer.byteLength(user))return baseline('byte_length_changed');
 return {user:reordered,input_layout_version:'cache_v1',layout_reason:'applied',payload_bytes:Buffer.byteLength(reordered)};
}
