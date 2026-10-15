import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';
import type { BenefitAction, PublicData, Publication } from '../src/lib/types';
import { currentStatusPosterSvg, assertStatusPosterRound } from '../src/server/status-poster';
const require=createRequire(import.meta.url);
const native=require('../miniprogram/utils/status-poster.js');
const generic=require('../miniprogram/utils/poster.js');
const now='2026-10-15T00:00:00Z';
function fixture(stage?:BenefitAction['stage'],expectedAt?:string):PublicData {
  const data:PublicData={serverTime:now,site:{name:'模钥重置雷达',description:'隔离测试',autoPublish:false,version:1},events:[],articles:[],publications:[],evidence:[],notices:[],activities:[],sources:[]};
  if(stage){const p:Publication={id:'fixed-publication',eventId:'fixed-event',articleId:'fixed-article',publishedAt:'2026-10-14T20:00:00Z',cutoffAt:'2026-10-14T20:00:00Z',reason:'隔离测试',mode:'state_change',event:{id:'fixed-event',title:'测试公告',version:1,status:'published',publicationId:'fixed-publication',evidenceIds:[],updatedAt:now,actions:[{id:'fixed-action',kind:'automatic_reset',scope:'public',stage,expectedAt,statementAt:'2026-10-14T20:00:00Z',eligibility:'公开用户',evidenceIds:[]}]},article:{id:'fixed-article',eventId:'fixed-event',publicationId:'fixed-publication',title:'测试公告',summary:'测试公开事实',translation:'',category:'reset',version:1,status:'published',evidenceIds:[],publishedAt:'2026-10-14T20:00:00Z',sourcePublishedAt:'2026-10-14T20:00:00Z',updatedAt:now}};
    data.publications=[p];data.events=[structuredClone(p.event)];data.articles=[structuredClone(p.article)];}
  return data;
}
const measure=(text:string,size:number)=>Array.from(text).reduce((n,c)=>n+(c.charCodeAt(0)<128?.56:1)*size,0);
test('两款固定海报在无公告、预告、进行中和逾期时均可用，不捏造完成或经过天数',()=>{
  for(const [stage,time,value]of [[undefined,undefined,'等待预告'],['promised','2026-10-15T03:00:00Z','03:00'],['in_progress',undefined,'重置进行中'],['promised','2026-10-14T23:00:00Z','等待确认']] as const){
    const data=fixture(stage,time),input=native.statusPosterInput(data);
    assert.equal(input.value,value);assert.notEqual(input.label,'距该公告');assert.ok(native.statusPosterAvailable(input,data));
    for(const theme of ['precision','editorial']){const layout=native.createStatusPosterLayout(input,measure,theme);assert.equal(layout.width,1080);assert.equal(layout.height,1920);assert.match(layout.background,new RegExp(theme+'\\.jpg$'));assert.ok(layout.commands.some((c:any)=>c.value===value));assert.equal(layout.commands.some((c:any)=>c.asset==='code'),false);}
  }
});
test('完成海报冻结声明和生成时间；布局切换不改事实，撤回后不能保存',()=>{
  const data=fixture('claimed_complete'),input=native.statusPosterInput(data);
  assert.equal(input.value,'4');assert.equal(input.unit,'小时');assert.equal(input.label,'距该公告');
  const dark=native.createStatusPosterLayout(input,measure,'precision',true),light=native.createStatusPosterLayout(input,measure,'editorial',true);
  assert.notDeepEqual(dark.commands,light.commands);assert.equal(input.generatedAt,now);
  for(const layout of [dark,light]){const circle=layout.commands.find((c:any)=>c.type==='circle'),code=layout.commands.find((c:any)=>c.asset==='code');for(const x of [code.x,code.x+code.width])for(const y of [code.y,code.y+code.height])assert.ok(Math.hypot(x-circle.x,y-circle.y)<circle.r);assert.ok(layout.commands.filter((c:any)=>c.type==='text').map((c:any)=>c.value).join('').includes(input.title));}
  data.articles[0].status='withdrawn';assert.equal(native.statusPosterAvailable(input,data),false);
});
test('黑金海报的数字与单位保留独立安全区，覆盖分钟、小时、天及三位数',()=>{
  const input=native.statusPosterInput(fixture('claimed_complete'));
  for(const value of ['1','3','28','365'])for(const unit of ['分钟','小时','天']){
    const layout=native.createStatusPosterLayout({...input,value,unit},measure,'precision');
    const number=layout.commands.find((c:any)=>c.value===value),label=layout.commands.find((c:any)=>c.value===unit);
    assert.ok(number.y+number.size*.25<label.y-label.size,'含数字下沿和文字顶端仍有间隔');
    assert.ok(measure(value,number.size)<=640);assert.equal(label.align,'center');
  }
});
test('网站两款海报也支持等待状态；公开轮次变化时拒绝旧预览而非替换事实',()=>{
  const waiting=fixture();for(const theme of ['precision','editorial'] as const){const svg=currentStatusPosterSvg(waiting,now,'waiting',theme);assert.match(svg,/1080.*1920/);assert.match(svg,/等待预告/);assert.match(svg,/暂无公开公告/);assert.doesNotMatch(svg,/公告称已|data-poster-code/);}
  const announced=fixture('promised','2026-10-15T03:00:00Z');assert.match(currentStatusPosterSvg(announced,now,'fixed-publication'),/03:00/);
  assert.throws(()=>currentStatusPosterSvg(announced,now,'waiting'),/已变化/);assert.throws(()=>currentStatusPosterSvg(fixture('claimed_complete'),now,'fixed-publication'),/已变化/);
});
test('完成海报打开后出现新的预告也会拒绝旧轮次，切换风格不能悄悄改下一次安排',()=>{
  const completed=fixture('claimed_complete');assert.doesNotThrow(()=>assertStatusPosterRound(completed,'waiting'));
  const next=fixture('promised','2026-10-15T04:00:00Z');assert.throws(()=>assertStatusPosterRound(next,'waiting'),error=>error instanceof Error&&'status'in error&&error.status===409);
  assert.doesNotThrow(()=>assertStatusPosterRound(next,'fixed-publication'));
});
test('原生艺术海报实际画原背景和品牌后导出1080×1920 PNG，保存相册仍须主动操作',async()=>{
  const calls:any[]=[];
  const ctx={font:'',fillStyle:'',globalAlpha:1,measureText:(s:string)=>({width:measure(s,30)}),drawImage:(...args:any[])=>calls.push(['image',...args]),fillText:(...args:any[])=>calls.push(['text',...args]),fillRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){},fill(){},createLinearGradient(){return{addColorStop(){}};}};
  const canvas={width:0,height:0,getContext:()=>ctx,requestAnimationFrame(fn:()=>void){queueMicrotask(fn);},createImage(){const image:any={width:1080,height:1920};Object.defineProperty(image,'src',{set(value){calls.push(['load',value]);queueMicrotask(()=>image.onload());}});return image;}};
  let saves=0;const wx={canvasToTempFilePath(o:any){assert.equal(o.destWidth,1080);assert.equal(o.destHeight,1920);assert.equal(o.fileType,'png');o.success({tempFilePath:'wxfile://art.png'});},saveImageToPhotosAlbum(o:any){saves++;o.success();}};
  const artifact=await native.renderStatusPoster({wxApi:wx,canvas,input:native.statusPosterInput(fixture()),theme:'editorial'});
  assert.ok(calls.some(c=>c[0]==='load'&&c[1]==='/assets/posters/editorial.jpg'));assert.ok(calls.some(c=>c[0]==='load'&&c[1]==='/assets/posters/brand.png'));assert.equal(saves,0);
  await assert.rejects(generic.savePoster(wx,artifact),/点击/);await generic.savePoster(wx,artifact,{userInitiated:true});assert.equal(saves,1);
  await assert.rejects(native.renderStatusPoster({wxApi:wx,canvas,input:native.statusPosterInput(fixture()),isCurrent:()=>false}),/取消/);
});
test('原生海报样式快速切换和离开页面时，旧生成结果不能覆盖新预览',async()=>{
  const filename=resolve('miniprogram/pages/poster/index.js');let definition:any;
  const renders:Array<{options:any;resolve:(v:any)=>void}>=[];
  const wx={createSelectorQuery(){return{in(){return this;},select(){return this;},fields(_o:any,fn:(v:any)=>void){fn({node:{}});return this;},exec(){}};}};
  const app={client:{getState:()=>({data:fixture()})}};
  new Script(readFileSync(filename,'utf8'),{filename}).runInNewContext({Page(d:any){definition=d;},wx,getApp:()=>app,setTimeout,clearTimeout,require(path:string){if(path.endsWith('/page'))return{createPage:(_build:any,extra:any)=>({...extra,...extra.methods})};if(path.endsWith('/status-poster'))return{...native,renderStatusPoster:(options:any)=>new Promise(resolve=>renders.push({options,resolve}))};if(path.endsWith('/poster'))return generic;return{privacyRequired:async()=>false};}});
  const page={...definition,data:{...definition.data},_snapshot:native.statusPosterInput(fixture()),setData(p:any){Object.assign(this.data,p);}};
  page.show();await new Promise(r=>setImmediate(r));assert.equal(renders.length,1);
  page.selectTheme({currentTarget:{dataset:{theme:'editorial'}}});renders[0].resolve({tempFilePath:'old'});await new Promise(r=>setImmediate(r));assert.equal(renders.length,2);assert.equal(page.data.preview,'');
  renders[1].resolve({tempFilePath:'new'});await new Promise(r=>setImmediate(r));assert.equal(page.data.preview,'new');assert.equal(page.data.posterBusy,false);
  page.selectTheme({currentTarget:{dataset:{theme:'precision'}}});await new Promise(r=>setImmediate(r));page.hide();renders[2].resolve({tempFilePath:'late'});await new Promise(r=>setImmediate(r));assert.notEqual(page.data.preview,'late');
});
