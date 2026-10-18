import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import jsQR from 'jsqr';
import {statusTimelineModel} from '../src/lib/status-timeline';
import {currentStatusPosterSvg} from '../src/server/status-poster';
import type {PublicData} from '../src/lib/types';
const require=createRequire(import.meta.url);
const sharp=createRequire(require.resolve('next/package.json'))('sharp');
const native=require('../miniprogram/utils/status-timeline.js');
const now='2026-10-18T08:00:00Z';
const url='https://express-l98p-326351-12-1503749333.sh.run.tcloudbase.com/';
const active={actionId:'a',eventId:'e',publicationId:'p',kind:'automatic_reset' as const,stage:'promised' as const,statementAt:'2026-10-18T07:00:00Z',expectedAt:'2026-10-19T09:45:00Z'};

test('两类预告、进行、过点、完成与等待采用同一事件结果，展示标签不改变倒计时事实',()=>{
  for(const kind of ['automatic_reset','banked_reset'] as const){
    const cases=[
      {status:'monitoring' as const},
      {status:'cancelled' as const},
      {status:'scheduled' as const,active:{...active,kind}},
      {status:'announced' as const,active:{...active,kind,expectedAt:undefined}},
      {status:'in_progress' as const,active:{...active,kind,stage:'in_progress' as const,expectedAt:undefined}},
      {status:'overdue' as const,active:{...active,kind,expectedAt:now}},
      {status:'completed' as const,latestCompletion:{...active,kind,stage:'claimed_complete' as const}},
    ];
    for(const outlook of cases){
      const model=statusTimelineModel(outlook,now);
      assert.deepEqual(native.statusTimelineModel(outlook,now),model);
      assert.ok(model.presentation.heading);
      if(model.scheduled){assert.equal(model.title,'1天1小时45分钟');assert.match(model.presentation.heading,kind==='banked_reset'?/重置卡/:/额度重置/);}
      if(model.overdue){assert.equal(model.presentation.badge,'等待确认');assert.equal(model.completed,false);}
    }
  }
});

test('等待状态的两款分享海报默认网站码，在手机分享尺寸仍能解码，原生默认码目标一致',async()=>{
  const data:PublicData={serverTime:now,site:{name:'模钥重置雷达',description:'验收',autoPublish:false,version:1},events:[],articles:[],publications:[],evidence:[],notices:[],activities:[],sources:[]};
  for(const style of ['precision','editorial'] as const){
    const svg=currentStatusPosterSvg(data,now,'waiting',style,undefined,url);
    assert.match(svg,/data-poster-code="website"/);
    assert.doesNotMatch(svg,/公告称已/);
    for(const width of [1080,540,390,320]){
      const {data:pixels,info}=await sharp(Buffer.from(svg)).resize({width}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      assert.equal(jsQR(new Uint8ClampedArray(pixels),info.width,info.height)?.data,url,`${style} ${width}px`);
    }
  }
  const {data:pixels,info}=await sharp(readFileSync('miniprogram/assets/posters/website-qr.png')).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(jsQR(new Uint8ClampedArray(pixels),info.width,info.height)?.data,url);
});
