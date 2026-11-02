import {planningHash} from './planning-state.mjs';
/* 无进展是状态与信息重复，次数上限仅属于执行保护。 */
export function createPlanningProgress(){
 const states=new Set(),actions=new Set();
 return {
  observe({conditions,structure,gaps,evidence}){const fingerprint=planningHash({conditions,structure,gaps,evidence});const repeated=states.has(fingerprint);states.add(fingerprint);return {fingerprint,repeated};},
  action(fingerprint,action){const identity=planningHash({fingerprint,action});if(actions.has(identity))return {allowed:false,reason:'no_new_information'};actions.add(identity);return {allowed:true};},
  get stateCount(){return states.size;}
 };
}
