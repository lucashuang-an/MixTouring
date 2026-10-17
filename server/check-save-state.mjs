/* 保存状态必须从持久化快照推导；后台来源与临时 ID 不得制造未保存状态。 */
import assert from 'node:assert/strict';
import state from '../mixtouring-hifi/assets/save-state.js';
const snapshot={request:{origin:'北京',destination:'阿拉木图'},messages:[{role:'assistant',text:'已生成安排。'}],travel:{traveler_count:1},constraints:{budget_max_cny:8000},preferences:{road:'open'},conversation:{brief:{summary:'自然与文化'},routing:{origin:'北京',destination:'阿拉木图'},requirements:{trip_days:10},draft:{title:'草案',route:['北京','伊宁','阿拉木图'],cards:[{id:'card-1',title:'街区体验'}]}},candidate_key:'via'};
const listing={drafts:[{id:'trip',versions:[{snapshot:structuredClone(snapshot)}]}]};
for(let i=0;i<5;i++){const refreshed={...structuredClone(snapshot),request:{...snapshot.request,plan_id:'new-'+i},messages:[{role:'assistant',text:'已生成安排。',mid:i,sources:[{url:'https://example.com/'+i}]}]};assert.equal(state.find(refreshed,listing).saved,true);}
const consulted=structuredClone(snapshot);consulted.messages.push({role:'user',text:'先聊聊，不改稿。'});assert.equal(state.find(consulted,listing).saved,false,'新增对话正文也应允许保存，避免恢复后丢掉上下文');
const edited=structuredClone(snapshot);edited.conversation.draft.cards[0].title='河谷体验';assert.equal(state.find(edited,listing).saved,false);
const changedDays=structuredClone(snapshot);changedDays.conversation.requirements.trip_days=7;assert.equal(state.find(changedDays,listing).saved,false);
const changedMode=structuredClone(snapshot);changedMode.candidate_key='other-mode';assert.equal(state.find(changedMode,listing).saved,false);
assert.equal(state.find(snapshot,{...listing,store_corrupted:true}).unavailable,true);
assert.equal(state.find(snapshot,{drafts:[]}).saved,false);
const preview=structuredClone(snapshot);preview.conversation.preview={draft:edited.conversation.draft};assert.equal(state.find(preview,listing).preview,true,'待采用预览不能显示为已保存');
assert.equal(state.find(snapshot,{drafts:[{id:'trip',versions:[{snapshot},{snapshot:edited}]}]}).saved,false,'历史版本匹配不能冒充当前最新版已保存');
assert.equal(state.find(edited,{drafts:[{id:'trip',versions:[{snapshot},{snapshot:edited}]}]}).versions,2);
assert.equal(state.key({...snapshot,constraints:{b:2,a:1}}),state.key({...snapshot,constraints:{a:1,b:2}}));
console.log('✓ 连续后台刷新、重新规划、实际改稿、历史版本、存储失败与恢复的保存状态通过');
