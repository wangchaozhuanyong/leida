import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {sourceStatus} from '../src/components/public/model';
import {publicSources} from '../src/server/public-read';
import {loadEntryCode,WechatEntryGuide} from '../src/components/public/WechatEntryGuide';
import type {PublicData,Source} from '../src/lib/types';
const mini=createRequire(import.meta.url)('../miniprogram/utils/model.js');
const now='2026-10-15T12:00:00Z';
test('采集表达区分暂停、未接入、失败与正常；人工来源不制造延迟警示，双端一致',()=>{
  const healthy={id:'official-status',name:'官方状态',status:'healthy' as const,lastSuccessAt:now};
  const cases:Array<[PublicData['sources'],string,boolean]>=[
    [[], '自动更新暂未启用',true],[[{...healthy,id:'manual',status:'paused'}],'自动更新暂未启用',true],
    [[{...healthy,status:'paused'}],'自动更新已暂停',true],
    [[{...healthy,status:'unconnected'}],'等待首次更新',true],
    [[healthy,{...healthy,id:'manual',status:'paused'}],'自动检查公开消息',false],
    [[healthy,{...healthy,id:'other',status:'failed'}],'部分消息更新延迟',true],
    [[{...healthy,lastSuccessAt:undefined}],'等待首次更新',true]
  ];
  for(const [sources,label,warning] of cases){assert.deepEqual(sourceStatus(sources),{label,warning});assert.deepEqual(mini.sourceStatus(sources),sourceStatus(sources));}
});
test('公开来源按已配置周期投影延迟；禁用或人工来源不能被健康旧状态冒充正在采集',()=>{
  const source:Source={id:'official-status',name:'官方',kind:'status',url:'https://example.org',enabled:true,validated:true,intervalMinutes:5,version:1,status:'healthy',lastSuccessAt:'2026-10-15T11:40:00Z'};
  assert.equal(publicSources([source],now)[0].status,'delayed');
  assert.equal(publicSources([{...source,enabled:false}],now)[0].status,'paused');
  assert.equal(publicSources([{...source,id:'manual',kind:'manual'}],now)[0].status,'paused');
});
test('网页真实小程序码只在主动请求后加载，同一版本复用，不接受错误版本或伪造类型',async()=>{
  let calls=0;const fetcher:typeof fetch=async()=>{calls++;return Response.json({data:{publicationId:'repair-entry',contentType:'image/png',imageBase64:'iVBORw0KGgo='}});};
  const html=renderToStaticMarkup(createElement(WechatEntryGuide,{publicationId:'repair-entry',codeAvailable:true}));
  assert.equal(calls,0);assert.match(html,/搜一搜/);assert.match(html,/查看我的提醒/);assert.match(html,/显示小程序码/);assert.doesNotMatch(html,/<img/);
  const signal=new AbortController().signal;
  assert.match(await loadEntryCode('repair-entry',signal,fetcher),/^data:image\/png;base64,/);
  await loadEntryCode('repair-entry',signal,fetcher);assert.equal(calls,1);
  for(const data of [{publicationId:'wrong',contentType:'image/png',imageBase64:'AAAA'},{publicationId:'bad-entry',contentType:'image/svg+xml',imageBase64:'AAAA'}])await assert.rejects(loadEntryCode('bad-entry',signal,async()=>Response.json({data})),/暂不可用/);
});
