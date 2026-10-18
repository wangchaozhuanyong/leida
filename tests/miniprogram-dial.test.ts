import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const require=createRequire(import.meta.url);
const {dialModel,drawDial}=require('../miniprogram/utils/dial.js');
const now='2026-10-12T04:00:00Z';
const active={stage:'promised',expectedAt:'2026-10-12T07:20:00Z',timeNote:'原文预计时刻'};
test('表盘与明确公告同钟，按北京时间标注24小时位置和小时分钟',()=>{
  const dial=dialModel({active,status:'scheduled'},now);
  assert.equal(dial.digits,'03:20');assert.equal(dial.time,'15:20');assert.equal(dial.startAngle,180);assert.equal(dial.endAngle,230);
  assert.equal(dial.lead,'预计剩余');assert.equal(dial.sweep,50);
  assert.equal(dialModel({active:{...active,timeNote:'原文近似时间'},status:'scheduled'},now).lead,'预计约');
});
test('缺时刻、过期、完成和取消都不生成虚假倒计时；超过24小时不被折算成当日',()=>{
  for(const status of ['monitoring','completed','cancelled']){const d=dialModel({status,active:null},now);assert.equal(d.scheduled,false);assert.equal(d.digits,'');}
  assert.equal(dialModel({active:{stage:'promised'},status:'announced'},now).state,'时间待明确');
  assert.equal(dialModel({active,status:'scheduled'},active.expectedAt).state,'等待确认');
  const long=dialModel({active:{...active,expectedAt:'2026-10-14T06:00:00Z'},status:'scheduled'},now);assert.equal(long.digits,'50:00');assert.equal(long.sweep,359.9);
});
test('表盘绘制使用公开预计时刻，过期时不画完成标记',()=>{
  const calls:{type:string;values:unknown[]}[]=[];
  const ctx=new Proxy({}, {get(_,key){return (...values:unknown[])=>calls.push({type:String(key),values});},set(){return true;}});
  drawDial(ctx,320,dialModel({active,status:'scheduled'},now));
  assert.deepEqual(calls.filter(c=>c.type==='fillText').map(c=>c.values[0]),['00','06','12','18']);
  assert.equal(calls.filter(c=>c.type==='arc').length,6);
  calls.length=0;drawDial(ctx,320,dialModel({active,status:'overdue'},active.expectedAt));assert.equal(calls.filter(c=>c.type==='arc').length,4);
});
test('完成结果持续显示秒计时，非法时间不展示；新预告独立显示',()=>{
  const completion={kind:'automatic_reset',stage:'claimed_complete',statementAt:'2026-10-12T01:45:00Z'};
  const dial=dialModel({status:'completed',latestCompletion:completion},now);
  assert.equal(dial.completed,true);assert.equal(dial.elapsedLabel,'2小时15分钟0秒');assert.equal(dial.lead,'距最近一次确认重置');assert.equal(dial.scheduled,false);
  const card=dialModel({status:'completed',latestCompletion:{...completion,kind:'banked_reset',statementAt:'2026-10-12T03:25:00Z'}},now);
  assert.equal(card.elapsedLabel,'0小时35分钟0秒');assert.equal(card.bankedCompleted,true);
  for(const statementAt of ['2026-10-12T04:00:01Z','invalid']){
    const expired=dialModel({status:'completed',latestCompletion:{...completion,statementAt}},now);
    assert.equal(expired.completed,false);assert.equal(expired.state,'等待预告');
  }
  for(const expectedAt of [active.expectedAt,now,undefined]){
    const announced=dialModel({status:'scheduled',active:{...active,expectedAt},latestCompletion:completion},now);
    assert.equal(announced.completed,false);assert.equal(announced.elapsedLabel,'');
    if(expectedAt===now)assert.equal(announced.state,'等待确认');
    else if(expectedAt===undefined)assert.equal(announced.state,'时间待明确');
    else assert.equal(announced.digits,'03:20');
  }
});


test('原生表盘秒数字变化不重绘静态画布，安排变化后才重新绘制刻度和时间标记',()=>{
 let definition:any,queries=0;
 const ctx=new Proxy({}, {get(){return()=>{};},set(){return true;}}),canvas={width:0,height:0,getContext:()=>ctx};
 const wx={getWindowInfo:()=>({pixelRatio:1}),createSelectorQuery(){queries++;return {in(){return this;},select(){return this;},fields(_options:unknown,done:(value:unknown)=>void){done({node:canvas,width:320});return this;},exec(){}};}};
 runInNewContext(readFileSync('miniprogram/components/instrument-dial/index.js','utf8'),{Component:(value:any)=>{definition=value;},wx,require:()=>({drawDial})});
 const completion={kind:'automatic_reset',stage:'claimed_complete',statementAt:'2026-10-12T01:45:00Z'};
 const instance={...definition.methods,data:{model:dialModel({latestCompletion:completion},now)},_alive:true,_drawing:false,_drawKey:undefined};
 instance.draw();assert.equal(queries,1);
 instance.data.model=dialModel({latestCompletion:completion},'2026-10-12T04:00:01Z');instance.draw();assert.equal(queries,1);
 instance.data.model=dialModel({active,status:'scheduled'},now);instance.draw();assert.equal(queries,2);
 // WeChat may discard the canvas bitmap while its cached page is hidden.
 // Returning to the page must repaint even when only the elapsed text changed.
 definition.pageLifetimes.show.call(instance);assert.equal(queries,3);
 instance.draw();assert.equal(queries,3);
 definition.pageLifetimes.resize.call(instance);assert.equal(queries,4);
});
