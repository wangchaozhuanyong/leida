import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {replayTimeline,scoreReplay,REPLAY_VERSION,type ReplayInput,type ReplayRecord,type ReplayStep} from '../src/lib/historical-replay';
const require=createRequire(import.meta.url);
const {validateReplay,replayView}=require('../miniprogram/utils/replay.js');
const {createTransport}=require('../miniprogram/utils/transport.js');
const start='2026-09-16T00:00:00.000Z',end='2026-09-17T00:00:00.000Z',runId='replay_'+'a'.repeat(24);
function record(at:string,id='1'):ReplayRecord{return {sourceId:'tibo-public',messageId:id,url:'https://x.com/thsottiaux/status/'+id,text:'Synthetic test only',publishedAt:at,collectedAt:'2026-10-16T00:00:00Z',provenance:'archive',contextComplete:true,textOrigin:'original'};}
function input(records:ReplayRecord[]):ReplayInput{return {version:REPLAY_VERSION,window:{start,end},capturedAt:'2026-10-16T00:00:00Z',coverage:{complete:false,notes:['合成测试']},records};}
function step(index:number,at:string):ReplayStep{return {id:'s'+index,recordType:'historical_replay_step',runId,signature:'s'+index,index,kind:'timer',phase:'evaluation',virtualAt:at,recordedAt:'2026-10-16T00:00:00Z',outlook:{status:'monitoring'},publications:[],inputFingerprint:'test',codeFingerprint:'test',prediction:{id:'p'+index,status:'ready',generatedAt:at,cutoffAt:at,validUntil:end,modelVersion:'synthetic',p24:.2,p48:.5,predictedAt:'2026-09-16T12:00:00Z',windowStart:start,windowEnd:end,sampleCount:8,trainingObservationIds:[],explanation:'合成预测'}};}
function detail(index=0){return {run:{runId,window:{start,end},recordedAt:'2026-10-16T00:00:00Z',messageCount:2,totalSteps:2,coverage:{complete:false,notes:['合成测试']}},step:step(index,'2026-09-16T01:00:00Z')};}
test('回放保持事实采集时间，模拟时钟只按消息/必要定时点推进；同批消息先于定时器',()=>{
 const rows=[record('2026-09-16T00:00:01Z','2'),record('2026-09-16T00:00:00Z','1')],before=structuredClone(rows);
 const timeline=replayTimeline(input(rows));assert.deepEqual(rows,before);
 assert.equal(timeline.at(-1)?.at,end);assert.equal(timeline.filter(t=>t.record).length,2);
 assert.equal(timeline.filter(t=>t.record)[0].record?.messageId,'1');
 assert.equal(timeline.filter(t=>t.record)[1].at,'2026-09-16T00:02:00.000Z');
 assert.equal(timeline[0].record?.messageId,'1');assert.equal(timeline[1].record,undefined);
});
test('未来消息、重复身份和非法网址阻止回放，晚于虚拟时间的真实采集时间不伪造',()=>{
 assert.throws(()=>replayTimeline(input([record('2026-09-18T00:00:00Z')])));
 assert.throws(()=>replayTimeline(input([record(start),record(start)])));
 assert.throws(()=>replayTimeline(input([{...record(start),url:'javascript:alert(1)'}])));
 assert.equal(replayTimeline(input([record(start)]))[0].record?.collectedAt,'2026-10-16T00:00:00Z');
});
test('独立轮次固定第一次可用预测，后续快照不能挑选成绩；无结果保留未知',()=>{
 const steps=[step(0,'2026-09-16T01:00:00Z'),step(1,'2026-09-16T11:00:00Z'),step(2,'2026-09-16T14:00:00Z')];
 steps[1].prediction!.predictedAt='2026-09-16T13:00:00Z';
 const result=scoreReplay(steps,[{at:'2026-09-16T13:00:00Z',url:'https://example.org/result'}],{start,end});
 assert.equal(result.length,2);assert.equal(result[0].snapshotId,'p0');assert.equal(result[0].absoluteErrorHours,1);assert.equal(result[1].outcome,'unknown');
 assert.equal(scoreReplay(steps,[{at:'2026-09-18T00:00:00Z',url:'https://example.org/future'}],{start,end})[0].outcome,'unknown');
});
test('小程序拒绝越界步骤、未来证据和提前返回的最终评分',()=>{
 const value=detail();assert.ok(validateReplay('/api/v1/replays/'+runId+'?step=0',value));
 for(const change of [(v:ReturnType<typeof detail>)=>v.step.index=2,(v:ReturnType<typeof detail>)=>v.step.prediction!.cutoffAt=end,(v:ReturnType<typeof detail>)=>Object.assign(v.run,{scores:[]})]){const v=detail();change(v);assert.equal(validateReplay('/api/v1/replays/'+runId+'?step=0',v),false);}
 assert.equal(validateReplay('/api/v1/replays/'+runId+'?step=1',value),false);
});
test('小程序回放路径白名单不允许私有请求、额外查询或路径穿越',async()=>{
 let calls=0;const transport=createTransport({request(options:any){calls++;options.success({statusCode:200,data:{data:detail()}});return {abort(){}};}},{mode:'https',baseUrl:'https://example.org'});
 await transport('/api/v1/replays/'+runId+'?step=0').promise;assert.equal(calls,1);
 for(const path of ['/api/v1/replays/../admin','/api/v1/replays/'+runId+'?step=0&admin=1','/api/v1/replays/'+runId+'?step=-1'])await assert.rejects(transport(path).promise);
 assert.equal(calls,1);
});
test('小程序离开回放页后，迟到响应不能更新页面，返回后可重试',async()=>{
 let definition:any,pendingResolve:(v:unknown)=>void=()=>{},aborted=0;
 const pending=new Promise(resolve=>pendingResolve=resolve);
 const code=readFileSync(new URL('../miniprogram/pages/replay/index.js',import.meta.url),'utf8');
 runInNewContext(code,{require:(name:string)=>require('../miniprogram/pages/replay/'+name),Page:(value:unknown)=>definition=value,getApp:()=>({publicApi:()=>({promise:pending,abort(){aborted++;}})})});
 const page={...definition,data:structuredClone(definition.data),setData(patch:unknown){Object.assign(this.data,patch);}};
 page.onLoad();page.onHide();pendingResolve({data:[detail().run]});await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(aborted,1);assert.equal(page.data.view,null);assert.equal(page.data.loading,false);
});
test('记录页共享导航实际允许进入回放，拒绝未登记路径',()=>{
 const calls:string[]=[],module={exports:{} as any};
 runInNewContext(readFileSync(new URL('../miniprogram/utils/page.js',import.meta.url),'utf8'),{module,require:(name:string)=>require('../miniprogram/utils/'+name),wx:{navigateTo:({url}:{url:string})=>calls.push(url)}});
 const page=module.exports.createPage(()=>({}));
 page.navigate({currentTarget:{dataset:{path:'/pages/replay/index'}}});
 page.navigate({currentTarget:{dataset:{path:'/pages/../admin/index'}}});
 assert.deepEqual(calls,['/pages/replay/index']);
});
test('回放以本轮公告时间跟踪，统计估计不替换预告；过期不能自行显示完成',()=>{
 const value=detail();
 Object.assign(value.step.outlook,{status:'overdue',active:{kind:'banked_reset',stage:'promised',statementAt:start,expectedAt:'2026-09-16T00:30:00Z',timeNote:'最晚截止'}});
 assert.ok(validateReplay('/api/v1/replays/'+runId+'?step=0',value));
 const view=replayView(value);
 assert.match(view.announced,/重置卡/);assert.match(view.announced,/08:30/);
 assert.match(view.predictedAt,/20:00/);assert.match(view.status,/等待确认/);assert.equal(view.resolved,'');
 Object.assign(value.step.outlook,{lastResolved:{kind:'banked_reset',stage:'claimed_complete',statementAt:end,resolvedAt:end}});
 assert.equal(validateReplay('/api/v1/replays/'+runId+'?step=0',value),false,'未来的完成声明不能出现在过去步骤');
});
