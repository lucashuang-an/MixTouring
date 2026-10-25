/* 仅保存用户当前任务的活动选择；没有预置景点目录。 */
import {isValidWindow} from './anywhere.mjs';
export function normalizeSightState(raw={}){
  if(!raw || typeof raw!=='object')raw={};
  const ids=Array.isArray(raw.selected_ids)?[...new Set(raw.selected_ids.filter(id=>typeof id==='string' && id.length<=100))].slice(0,20):[];
  const integer=(v,fallback,min,max)=>Number.isInteger(Number(v)) && Number(v)>=min && Number(v)<=max?Number(v):fallback;
  return {selected_ids:ids,requested:raw.requested===true,full_days:integer(raw.full_days,2,1,14),day_hours:integer(raw.day_hours,8,4,12),
    preference:typeof raw.preference==='string'?raw.preference.slice(0,80):'不限',play_window:isValidWindow(raw.play_window)?raw.play_window:null,
    visit_dates:Object.fromEntries(ids.map(id=>[id,isValidWindow(raw.visit_dates?.[id]+' ~ '+raw.visit_dates?.[id])?raw.visit_dates[id]:null])),
    visit_hours:Object.fromEntries(ids.map(id=>[id,integer(raw.visit_hours?.[id],6,1,12)]))};
}
