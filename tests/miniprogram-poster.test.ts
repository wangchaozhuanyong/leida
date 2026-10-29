import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import type {PublicData,Publication} from '../src/lib/types';
const require=createRequire(import.meta.url);
const p=require('../miniprogram/utils/poster.js');
function data():PublicData{
  const publication:Publication={id:'fixture-publication',eventId:'fixture-event',articleId:'fixture-article',publishedAt:'2026-10-10T04:00:00Z',cutoffAt:'2026-10-10T01:00:00Z',reason:'隔离测试',mode:'state_change',
    article:{id:'fixture-article',eventId:'fixture-event',title:'测试固定版本中文公告',summary:'测试中文摘要，保持来源与福利状态分开。',translation:'',category:'reset',version:2,status:'published',publicationId:'fixture-publication',evidenceIds:[],publishedAt:'2026-10-10T04:00:00Z',updatedAt:'2026-10-10T04:00:00Z'},
    event:{id:'fixture-event',title:'测试事件',version:7,status:'published',publicationId:'fixture-publication',updatedAt:'2026-10-10T04:00:00Z',evidenceIds:[],actions:[{id:'test-action',kind:'banked_reset',stage:'promised',eligibility:'所有账户',scope:'public',evidenceIds:[],statementAt:'2026-10-10T00:00:00Z',expectedAt:'2026-10-10T02:00:00Z'}]}};
  return{publications:[publication],events:[structuredClone(publication.event)],articles:[structuredClone(publication.article)],evidence:[],activities:[],notices:[],sources:[],site:{name:'模钥重置雷达',description:'',version:1,autoPublish:true},serverTime:'2026-10-10T08:00:00Z'};
}
const measure=(value:string,size=20)=>Array.from(value).reduce((sum,ch)=>sum+(/[\u0000-\u007f]/.test(ch)?size*.5:size),0);
function canvasMock(){
  const calls:Record<string,unknown>[]=[];
  const context={font:'',fillStyle:'',strokeStyle:'',lineWidth:1,textBaseline:'',textAlign:'',beginPath(){},arc(x:number,y:number,r:number){calls.push({type:'circle',x,y,r});},fill(){},stroke(){},measureText(value:string){return{width:measure(value,Number(this.font.match(/ (\d+(?:\.\d+)?)px/)?.[1])||20)};},fillText(text:string,x:number,y:number){calls.push({type:'text',text,x,y});},fillRect(x:number,y:number,width:number,height:number){calls.push({type:'rect',x,y,width,height});},drawImage(image:unknown,x:number,y:number,width:number,height:number){calls.push({type:'image',image,x,y,width,height});}};
  const canvas={width:0,height:0,getContext(kind:string){assert.equal(kind,'2d');return context;},createImage(){const image:Record<string,any>={width:430,height:430};Object.defineProperty(image,'src',{set(value){calls.push({type:'load',value});queueMicrotask(()=>image.onload?.());}});return image;},requestAnimationFrame(fn:()=>void){queueMicrotask(()=>{calls.push({type:'frame'});fn();});}};
  return{canvas,calls};
}
const scene='a'.repeat(32);
// Signature-only fixture for a mocked filesystem/image decoder; never a generated or simulated scannable code.
const imageBase64=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13]).toString('base64');

test('换行遵守实测像素宽度并保留中文、英文、Unicode代码点和显式空行',()=>{
  const input='中文公告ABC🙂\n\n另起一行';
  const lines=p.wrapText(input,(value:string)=>measure(value),80);
  assert.equal(lines.filter((line:string)=>line!=='').join(''),input.replace(/\n/g,''));
  assert.ok(lines.includes(''));
  for(const line of lines)assert.ok(measure(line)<=80);
  assert.ok(lines.some((line:string)=>line.includes('🙂')));
  assert.throws(()=>p.wrapText('测试',()=>NaN,20),/测量/);
});

test('海报由指定快照生成：事件版本、截止时间和当时预告，不使用当前记录或当前时间',()=>{
  const original=data();original.articles[0].title='未发布的其他标题';original.events[0].actions[0].stage='claimed_complete';
  const input=p.posterInput(original,'fixture-publication');
  assert.equal(input.title,'测试固定版本中文公告');assert.equal(input.version,7);
  assert.equal(input.actions[0].title,'重置卡 · 发放预告');
  original.publications[0].mode='news_only';assert.equal(p.posterInput(original,'fixture-publication').actions.length,0);
  assert.equal(p.posterInput(original,'fixture-publication').version,2);
});

test('撤回、合并、缺失以及错版本真码阻止海报；无配置不画装饰码',()=>{
  for(const kind of ['withdrawn','merged','missing']){const original=data();if(kind==='withdrawn')original.articles[0].status='withdrawn';if(kind==='merged')original.events[0].status='merged';if(kind==='missing')original.events=[];assert.throws(()=>p.posterInput(original,'fixture-publication'),(error:unknown)=>error instanceof Error && (error as Error & {code:string}).code===kind);}
  const input=p.posterInput(data(),'fixture-publication'),layout=p.createPosterLayout(input,measure);
  assert.equal(layout.codeRect,undefined);assert.equal(layout.commands.some((item:{type:string})=>item.type==='image'),false);
  assert.ok(layout.commands.some((item:{text?:string})=>item.text==='本张海报未附小程序码'));
  assert.throws(()=>p.createPosterLayout(input,measure,{status:'ready',publicationId:'other-version',filePath:'fixture-file'}),/不一致/);
});

test('长中文摘要全部进入布局，过长明确报错，不静默删去福利事实',()=>{
  const input=p.posterInput(data(),'fixture-publication');input.summary='很长的测试摘要'.repeat(100);
  const layout=p.createPosterLayout(input,measure);
  assert.ok(layout.height>1200);
  const texts=layout.commands.filter((item:{type:string})=>item.type==='text').map((item:{text:string})=>item.text).join('');
  assert.ok(texts.includes(input.summary));assert.ok(texts.includes('所有账户'));
  assert.throws(()=>p.createPosterLayout(input,measure,{status:'not_configured'},{maxHeight:1200}),/较长/);
});

test('原生Canvas画完并等待重绘后导出PNG；默认不保存相册，只有用户主动按钮可保存',async()=>{
  const canvas=canvasMock(),calls:unknown[]=[];let saves=0;
  const wx={canvasToTempFilePath(options:Record<string,any>,page:unknown){calls.push({options,page});assert.equal(canvas.calls.at(-1)?.type,'frame');options.success({tempFilePath:'wxfile://fixture-poster.png'});},saveImageToPhotosAlbum(options:Record<string,any>){saves++;assert.equal(options.filePath,'wxfile://fixture-poster.png');options.success();}};
  const artifact=await p.renderPoster({wxApi:wx,canvas:canvas.canvas,data:data(),publicationId:'fixture-publication',page:'fixture-page'});
  assert.equal(artifact.publicationId,'fixture-publication');assert.equal(artifact.codeStatus,'not_configured');assert.equal(saves,0);
  const exported=calls[0] as {options:Record<string,unknown>;page:string};assert.equal(exported.options.canvas,canvas.canvas);assert.equal(exported.options.fileType,'png');assert.equal(exported.page,'fixture-page');
  await assert.rejects(p.savePoster(wx,artifact),/点击/);assert.equal(saves,0);
  await p.savePoster(wx,artifact,{userInitiated:true});assert.equal(saves,1);
  await assert.rejects(p.savePoster(wx,{tempFilePath:'https://example.org/image.png'},{userInitiated:true}),/先生成/);
});

test('完整真码置于圆形白底内，保留所有像素，不裁剪或生成替代图案',async()=>{
  const canvas=canvasMock();const wx={canvasToTempFilePath(options:Record<string,any>){options.success({tempFilePath:'wxfile://fixture-poster.png'});}};
  const artifact=await p.renderPoster({wxApi:wx,canvas:canvas.canvas,data:data(),publicationId:'fixture-publication',code:{status:'ready',publicationId:'fixture-publication',filePath:'wxfile://fixture-server-code.png'}});
  assert.equal(artifact.codeStatus,'ready');assert.equal(canvas.calls.filter(item=>item.type==='image').length,1);
  assert.equal(canvas.calls.find(item=>item.type==='load')?.value,'wxfile://fixture-server-code.png');
  const circle=canvas.calls.find(item=>item.type==='circle') as {x:number;y:number;r:number};
  const image=canvas.calls.find(item=>item.type==='image') as {x:number;y:number;width:number;height:number};
  for(const x of [image.x,image.x+image.width])for(const y of [image.y,image.y+image.height])assert.ok(Math.hypot(x-circle.x,y-circle.y)<circle.r);
  const layout=p.createPosterLayout(p.posterInput(data(),'fixture-publication'),measure,{status:'ready',publicationId:'fixture-publication',filePath:'wxfile://fixture-server-code.png'});
  const caption=layout.commands.find((item:{text?:string})=>item.text==='扫码查看这条消息');assert.ok(caption.y>circle.y+circle.r);
});

test('海报黑金与水墨切换只改样式，指定版本、完整事实及真码位置保持一致',()=>{
  const input=p.posterInput(data(),'fixture-publication'),code={status:'ready',publicationId:'fixture-publication',filePath:'wxfile://fixture-server-code.png'};
  const dark=p.createPosterLayout(input,measure,code,{theme:'precision'}),light=p.createPosterLayout(input,measure,code,{theme:'editorial'});
  assert.equal(dark.background,'#0b1113');assert.equal(light.background,'#f6f0e5');
  assert.equal(dark.publicationId,light.publicationId);assert.deepEqual(dark.codeRect,light.codeRect);
  assert.deepEqual(dark.commands.filter((c:{type:string})=>c.type==='text').map((c:{text:string})=>c.text),light.commands.filter((c:{type:string})=>c.type==='text').map((c:{text:string})=>c.text));
});

test('长标题、多动作和完整摘要在各导出宽度下互不覆盖，事实区与底部真码保持留白',()=>{
  const input=p.posterInput(data(),'fixture-publication');
  input.title='重置发放进展及不同账户的适用范围说明'.repeat(3);
  input.summary=('公开公告包含多个独立动作，具体账户是否适用须核对原始声明。'.repeat(6))+'\n\n补充说明保留显式分段与全部限定条件。';
  input.sourceTime='2026-10-10 08:00';
  input.actions=[0,1,2].map(index=>({...input.actions[0],
    title:`动作${index+1} · ${'本轮用量重置及发放预告的完整说明'.repeat(2)}`,
    eligibility:`第${index+1}类账户，${'满足公告列出的有效订阅及地区条件，'.repeat(4)}以原始说明为准。`,
    scope:index===1?'定向补偿':'公开发放',
    timeNote:`动作${index+1}备注：预计时间可能调整，${'发放完成前请等待公开确认，'.repeat(3)}不要将预告视为个人到账。`}));
  const code={status:'ready',publicationId:input.publicationId,filePath:'wxfile://fixture-server-code.png'};
  for(const width of [600,900,1200]){
    const dark=p.createPosterLayout(input,measure,code,{width,theme:'precision'});
    const light=p.createPosterLayout(input,measure,code,{width,theme:'editorial'});
    const textCommands=dark.commands.filter((c:{type:string})=>c.type==='text');
    const texts=textCommands.map((c:{text:string})=>c.text).join('');
    for(const fact of [input.title,input.summary,...input.actions.flatMap((a:Record<string,string>)=>[a.title,a.eligibility,a.scope,a.statementAt,a.expectedAt,a.timeNote])])assert.ok(texts.includes(fact.replace(/\n/g,'')),`full fact preserved at ${width}`);
    const boxes=textCommands.map((c:{text:string;x:number;y:number;size:number})=>({x:c.x,y:c.y,width:measure(c.text,c.size),height:c.size,text:c.text}));
    const margin=72*width/900;
    for(const box of boxes){
      assert.ok(box.x>=margin-.01&&box.x+box.width<=width-margin+.01,`horizontal gutter: ${box.text}`);
      assert.ok(box.y>=margin&&box.y+box.height<=dark.height-margin+.01,`vertical gutter: ${box.text}`);
    }
    for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
      const a=boxes[i],b=boxes[j];
      const overlaps=a.x<b.x+b.width-.01&&a.x+a.width>b.x+.01&&a.y<b.y+b.height-.01&&a.y+a.height>b.y+.01;
      assert.equal(overlaps,false,`overlapping text at ${width}: ${a.text} / ${b.text}`);
    }
    const circle=dark.commands.find((c:{type:string})=>c.type==='circle');
    assert.ok(circle.x-circle.r>=margin&&circle.x+circle.r<=width-margin+.01);
    for(const box of boxes){
      const nearestX=Math.max(box.x,Math.min(circle.x,box.x+box.width));
      const nearestY=Math.max(box.y,Math.min(circle.y,box.y+box.height));
      assert.ok(Math.hypot(nearestX-circle.x,nearestY-circle.y)>circle.r,`code plate overlaps text: ${box.text}`);
    }
    assert.deepEqual(dark.codeRect,light.codeRect);
    assert.deepEqual(textCommands.map(({color,...c}:Record<string,unknown>)=>c),light.commands.filter((c:{type:string})=>c.type==='text').map(({color,...c}:Record<string,unknown>)=>c));
    assert.equal(p.createPosterLayout(input,measure,code,{width,maxHeight:dark.height}).height,dark.height);
    assert.throws(()=>p.createPosterLayout(input,measure,code,{width,maxHeight:dark.height-1}),/较长/);
  }
});

test('简短新闻模板随实际内容收尾，无动作不留空动作框或人为拉长空白',()=>{
  const input=p.posterInput(data(),'fixture-publication');input.newsOnly=true;input.actions=[];
  const layout=p.createPosterLayout(input,measure,{status:'unavailable'});
  assert.ok(layout.height<1200);
  assert.equal(layout.commands.some((c:{type:string;color?:string})=>c.type==='rect'&&c.color==='#141b1d'),false);
  assert.ok(layout.commands.some((c:{text?:string})=>c.text==='小程序码暂不可用'));
  const texts=layout.commands.filter((c:{type:string})=>c.type==='text').map((c:{text:string})=>c.text).join('');
  assert.ok(texts.includes('具体安排请查看最新重置消息'));
  assert.ok(texts.includes('新闻更新'));
});

test('真实码文件只写微信沙盒，限定体积/类型/版本/scene，绘制后清理且重复清理无重复操作',async()=>{
  const written:Record<string,any>[]=[],removed:string[]=[];
  const wx={env:{USER_DATA_PATH:'wxfile://fixture-user'},getFileSystemManager(){return{writeFile(options:Record<string,any>){written.push(options);options.success();},unlink(options:Record<string,any>){removed.push(options.filePath);options.success();}};}};
  const value={publicationId:'fixture-publication',scene,imageBase64,contentType:'image/png'};
  const asset=await p.writeCodeAsset(wx,value,'fixture-publication');
  assert.ok(asset.filePath.startsWith(wx.env.USER_DATA_PATH+'/'));assert.equal(written[0].encoding,'base64');assert.equal(written[0].data,imageBase64);
  await asset.dispose();await asset.dispose();assert.equal(removed.length,1);
  for(const broken of [{...value,publicationId:'other'},{...value,scene:'../path'},{...value,contentType:'image/svg+xml'},{...value,imageBase64:'not-a-real-image'},{...value,imageBase64:'A'.repeat(3000004)}])await assert.rejects(p.writeCodeAsset(wx,broken,'fixture-publication'),/不一致|格式/);
  assert.equal(written.length,1);
});

test('JPEG真码合同按jpg写入沙盒，画布最终仍导出PNG',async()=>{
  let path='';const wx={env:{USER_DATA_PATH:'wxfile://fixture-user'},getFileSystemManager(){return{writeFile(options:Record<string,any>){path=options.filePath;options.success();},unlink(options:Record<string,any>){options.success();}};}};
  const asset=await p.writeCodeAsset(wx,{publicationId:'fixture-publication',scene,contentType:'image/jpeg',imageBase64:'/9j/2Q=='},'fixture-publication');
  assert.ok(path.endsWith('.jpg'));await asset.dispose();
});

test('码文件清理回调丢失、失败或同步抛错都不阻塞成品，重复清理只尝试一次',async()=>{
  for(const behavior of ['missing','fail','throw']){
    let calls=0,settled=false;const removed:string[]=[];
    const wx={env:{USER_DATA_PATH:'wxfile://fixture-user'},getFileSystemManager(){return{writeFile(options:Record<string,any>){options.success();},unlink(options:Record<string,any>){calls++;removed.push(options.filePath);if(behavior==='throw')throw new Error('isolated cleanup failure');if(behavior==='fail')options.fail({});}};}};
    const asset=await p.writeCodeAsset(wx,{publicationId:'fixture-publication',scene,imageBase64,contentType:'image/png'},'fixture-publication');
    const finished=asset.dispose().then(()=>{settled=true;});await Promise.resolve();
    assert.equal(settled,true,behavior);await finished;await asset.dispose();
    assert.equal(calls,1);assert.deepEqual(removed,[asset.filePath]);
  }
});

test('导出失败与用户取消、相册拒绝、隐私未同意分别提示，不回显底层信息',async()=>{
  const canvas=canvasMock();await assert.rejects(p.renderPoster({wxApi:{canvasToTempFilePath(options:Record<string,any>){options.fail({errMsg:'private-details'});}},canvas:canvas.canvas,data:data(),publicationId:'fixture-publication'}),/导出失败/);
  const artifact=await p.renderPoster({wxApi:{canvasToTempFilePath(options:Record<string,any>){options.success({tempFilePath:'wxfile://fixture-poster.png'});}},canvas:canvas.canvas,data:data(),publicationId:'fixture-publication'});
  for(const [reason,message]of [['cancel','取消'],['auth deny','权限'],['privacy permission','隐私'],['internal-private-details','保存失败']])await assert.rejects(p.savePoster({saveImageToPhotosAlbum(options:Record<string,any>){options.fail({errMsg:reason});}},artifact,{userInitiated:true}),new RegExp(message));
});


test('圆码与海报缓存严格五分钟有效，时间回退和无时间戳不能复用',()=>{
  const at=Date.parse('2026-10-29T08:00:00Z');
  assert.equal(p.posterCacheFresh(at,at+299999),true);
  assert.equal(p.posterCacheFresh(at,at+300000),false);
  assert.equal(p.posterCacheFresh(at,at-1),false);
  assert.equal(p.posterCacheFresh(undefined,at),false);
});
