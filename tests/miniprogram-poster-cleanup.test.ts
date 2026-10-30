import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {Script,createContext} from 'node:vm';

// Actual native page/model/rendering modules; only WeChat I/O and time are simulated.
function harness(kind:'detail'|'status',cleanup:'missing'|'fail'|'throw'|'late',firstExportFails=false,codeDelay=0,codeFailure=0) {
  const root=resolve('miniprogram'),start=Date.parse('2026-10-24T00:00:00Z');
  let now=0,serial=0,definition:any,page:any,exports=0,codeRequests=0;
  const timers=new Map<number,{at:number;fn:()=>void}>(),removed:string[]=[],codeImages:string[]=[],saved:string[]=[];let channel='trial',failure=codeFailure,privacyDelay=0;
  const setTimeout=(fn:()=>void,ms=0)=>{const id=++serial;timers.set(id,{at:now+Number(ms),fn});return id;};
  const clearTimeout=(id:number)=>{timers.delete(id);};
  const flush=async()=>{for(let n=0;n<40;n++)await Promise.resolve();};
  async function advance(ms:number){const end=now+ms;await flush();for(;;){const next=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].fn();await flush();}now=end;await flush();}
  const article={id:'article',eventId:'event',title:'隔离清理回归',summary:'不写真实数据。',translation:'',category:'reset',version:1,status:'published',publicationId:'publication',evidenceIds:[],publishedAt:'2026-10-23T12:00:00Z',updatedAt:'2026-10-23T12:00:00Z'};
  const event={id:'event',title:article.title,version:1,status:'published',publicationId:'publication',updatedAt:article.updatedAt,evidenceIds:[],actions:[{id:'cleanup-action',eligibility:'公开用户',kind:'automatic_reset',scope:'public',stage:'promised',statementAt:article.publishedAt,expectedAt:'2026-10-24T04:00:00Z',evidenceIds:[]}]};
  const data={publications:[{id:'publication',eventId:event.id,articleId:article.id,publishedAt:article.publishedAt,cutoffAt:article.publishedAt,reason:'隔离测试',mode:'state_change',article,event}],events:[event],articles:[article],evidence:[],activities:[],notices:[],sources:[],site:{name:'测试',description:'',version:1,autoPublish:true},serverTime:new Date(start).toISOString()};
  const state={data,receivedAt:start,loading:false,error:'',unconfigured:false};
  const ctx={font:'',fillStyle:'',strokeStyle:'',lineWidth:1,textBaseline:'',textAlign:'',globalAlpha:1,beginPath(){},arc(){},fill(){},stroke(){},moveTo(){},lineTo(){},measureText(text:string){return{width:Array.from(text).length*(Number(this.font.match(/ (\d+(?:\.\d+)?)px/)?.[1])||20)};},fillText(){},fillRect(){},drawImage(){},createLinearGradient(){return{addColorStop(){}};}};
  const canvas={width:0,height:0,getContext(){return ctx;},createImage(){const image:any={width:430,height:430,onload:null,onerror:null};Object.defineProperty(image,'src',{set(){setTimeout(()=>image.onload?.(),0);}});return image;},requestAnimationFrame(fn:()=>void){setTimeout(fn,0);}};
  const wx={env:{USER_DATA_PATH:'wxfile://isolated'},showShareMenu(){},hideShareMenu(){},setBackgroundColor(){},showToast(){},getPrivacySetting(o:any){if(privacyDelay)setTimeout(()=>o.success({needAuthorization:false}),privacyDelay);else o.success({needAuthorization:false});},saveImageToPhotosAlbum(o:any){saved.push(o.filePath);o.success();},getFileSystemManager(){return{writeFile(o:any){codeImages.push(o.data);setTimeout(()=>o.success(),0);},unlink(o:any){removed.push(o.filePath);if(!o.filePath.includes('/moyao-code-')){o.success();return;}if(cleanup==='throw')throw new Error('isolated unlink failure');if(cleanup==='fail')o.fail({});if(cleanup==='late')setTimeout(()=>o.success(),30000);}};},createSelectorQuery(){let callback:(value:any)=>void;const query={in(){return query;},select(){return query;},fields(_:any,fn:(value:any)=>void){callback=fn;return query;},exec(){setTimeout(()=>callback({node:canvas}),0);}};return query;},canvasToTempFilePath(o:any){const nth=++exports;setTimeout(()=>{if(firstExportFails&&nth===1)o.fail({errMsg:'isolated export failure'});else o.success({tempFilePath:`wxfile://isolated-poster-${nth}.png`});},0);}};
  const app={client:{setView(){return Promise.resolve();},subscribe(fn:(value:any)=>void){fn(state);return()=>{};},getState(){return state;}},publicApi(){codeRequests++;const response={data:{publicationId:'publication',scene:'a'.repeat(32),contentType:'image/png',imageBase64:Buffer.from([137,80,78,71,13,10,26,10,channel==='trial'?1:2]).toString('base64')}};const reply=(resolve:(value:any)=>void,reject:(error:any)=>void)=>failure?reject(Object.assign(new Error('这条记录暂不可用'),{status:failure})):resolve(response);return{promise:codeDelay?new Promise((resolve,reject)=>setTimeout(()=>reply(resolve,reject),codeDelay)):failure?Promise.reject(Object.assign(new Error('这条记录暂不可用'),{status:failure})):Promise.resolve(response),abort(){}};}};
  class ClockDate extends Date {constructor(value?:string|number){super(value===undefined?start+now:value);}static now(){return start+now;}}
  const sandbox=createContext({Promise,Date:ClockDate,setTimeout,clearTimeout,setInterval:setTimeout,clearInterval:clearTimeout,queueMicrotask,wx,getApp:()=>app,Page:(value:any)=>{definition=value;}}),cache=new Map<string,{exports:any}>();
  function load(path:string):any {if(cache.has(path))return cache.get(path)!.exports;const module={exports:{}};cache.set(path,module);const run=new Script('(function(require,module,exports){'+readFileSync(path,'utf8')+'\n})',{filename:path}).runInContext(sandbox);run((name:string)=>{assert.ok(name.startsWith('.'));const target=resolve(dirname(path),name.endsWith('.js')?name:name+'.js');assert.ok(target.startsWith(root+'/'));return load(target);},module,module.exports);return module.exports;}
  load(resolve(root,kind==='detail'?'pages/detail/index.js':'packages/poster/index.js'));
  page={...definition,data:structuredClone(definition.data),setData(patch:any,callback?:()=>void){Object.assign(this.data,patch);callback?.();}};
  page.onLoad(kind==='detail'?{publicationId:'publication'}:{});page.onShow();
  if(kind==='detail')void page.generatePoster();
  return {get page(){return page;},advance,removed,saved,codeImages,setChannel(value:string){channel=value;},setPrivacyDelay(value:number){privacyDelay=value;},setCodeFailure(value:number){failure=value;},get exports(){return exports;},get codeRequests(){return codeRequests;},preview:()=>kind==='detail'?page.data.posterPreview:page.data.preview,retry(){if(kind==='detail')void page.generatePoster();else void page.generate();},switchTheme(){const e={currentTarget:{dataset:{theme:'editorial'}}};if(kind==='detail')page.selectPosterTheme(e);else page.selectTheme(e);},reenter(){page.onUnload();page={...definition,data:structuredClone(definition.data),setData(patch:any,callback?:()=>void){Object.assign(this.data,patch);callback?.();}};page.onLoad(kind==='detail'?{publicationId:'publication'}:{});page.onShow();},stop(){page.onUnload();timers.clear();}};
}

test('慢圆码先显示事实海报，未完成版本不能保存；同记录重进复用圆码，五分钟过期重新获取',async()=>{
  const h=harness('status','fail',false,6000);
  try{
    await h.advance(1);assert.ok(h.preview());assert.equal(h.exports,1);assert.equal(h.page.data.posterBusy,true);assert.equal(h.page.data.posterReady,false);assert.equal(h.page._artifact,null);
    await h.page.save();assert.equal(h.page.data.posterSaving,false);
    await h.advance(6000);assert.equal(h.exports,2);assert.equal(h.page.data.posterReady,true);assert.equal(h.page.data.posterBusy,false);
    h.reenter();await h.advance(1);assert.equal(h.codeRequests,1);assert.equal(h.exports,3);assert.equal(h.page.data.posterReady,true);
    await h.advance(300001);h.reenter();await h.advance(1);assert.equal(h.codeRequests,2);assert.equal(h.page.data.posterReady,false);assert.equal(h.page.data.posterBusy,true);
  }finally{h.stop();}
});
test('迟到圆码遇到记录冲突不开放草稿保存，离开后响应不能导出或覆盖页面',async()=>{
  const h=harness('status','fail',false,6000,409);
  try{await h.advance(1);assert.ok(h.preview());await h.advance(6000);assert.equal(h.page.data.posterReady,false);assert.equal(h.page._artifact,null);assert.match(h.page.data.posterError,/记录暂不可用/);assert.equal(h.exports,1);}finally{h.stop();}
  const hidden=harness('status','fail',false,6000);
  try{await hidden.advance(1);hidden.page.onHide();await hidden.advance(6000);assert.equal(hidden.exports,1);assert.equal(hidden.page.data.posterReady,false);}finally{hidden.stop();}
});

for(const kind of ['status'] as ('detail'|'status')[])for(const cleanup of ['missing','fail','throw','late'] as const){
  test(`${kind} 成品不等待 ${cleanup} 清理回调，跨20秒和切换样式仍可用`,async()=>{
    const h=harness(kind,cleanup);
    try{
      await h.advance(1);
      assert.equal(h.exports,1);assert.equal(h.page.data.posterBusy,false);assert.equal(h.page.data.posterError,'');assert.ok(h.preview());
      if(kind==='detail')assert.equal(h.page.data.posterReady,true);
      await h.advance(20000);assert.equal(h.page.data.posterError,'');assert.equal(h.page.data.posterBusy,false);
      h.switchTheme();await h.advance(1);assert.equal(h.exports,2);assert.equal(h.codeRequests,kind==='detail'?0:1);assert.equal(h.preview(),'wxfile://isolated-poster-2.png');assert.equal(h.page.data.posterBusy,false);
      await h.advance(40000);assert.equal(h.page.data.posterError,'');assert.equal(h.preview(),'wxfile://isolated-poster-2.png');
      assert.equal(h.removed.filter(path=>path.includes('/moyao-code-')).length,kind==='detail'?0:2);
    }finally{h.stop();}
  });
}

for(const kind of ['detail','status'] as const)for(const cleanup of ['missing','throw'] as const){
  test(`${kind} 导出失败遇到 ${cleanup} 清理故障仍保留原错误并允许重试`,async()=>{
    const h=harness(kind,cleanup,true);
    try{
      await h.advance(1);
      assert.equal(h.exports,1);assert.equal(h.page.data.posterBusy,false);assert.equal(h.page.data.posterError,'海报导出失败，请重试。');assert.equal(h.preview(),'');
      if(kind==='detail')assert.equal(h.page.data.posterReady,false);
      await h.advance(20000);assert.equal(h.page.data.posterError,'海报导出失败，请重试。');assert.equal(h.page.data.posterBusy,false);
      h.retry();await h.advance(1);assert.equal(h.exports,2);assert.equal(h.codeRequests,kind==='detail'?0:1);assert.equal(h.preview(),'wxfile://isolated-poster-2.png');assert.equal(h.page.data.posterBusy,false);assert.equal(h.page.data.posterError,'');
      await h.advance(20000);assert.equal(h.page.data.posterError,'');assert.equal(h.preview(),'wxfile://isolated-poster-2.png');
      assert.equal(h.removed.filter(path=>path.includes('/moyao-code-')).length,kind==='detail'?0:2);
    }finally{h.stop();}
  });
}

// Keep the actual page alive while the public QR channel changes. No server,
// database, WeChat generation or phone save is used by this isolated harness.
for(const kind of ['status'] as ('detail'|'status')[])for(const trigger of ['resume','theme','save'] as const){
  test(`${kind} 超过五分钟后 ${trigger} 重新获取圆码并清除旧成品`,async()=>{
    const h=harness(kind,'fail');
    try{
      await h.advance(1);const old=h.preview(),oldCode=h.codeImages.at(-1);assert.equal(h.codeRequests,1);
      h.setChannel('release');
      if(trigger==='resume')h.page.onHide();
      await h.advance(300000);
      if(trigger==='resume')h.page.onShow();
      else if(trigger==='theme')h.switchTheme();
      else void (kind==='detail'?h.page.savePoster():h.page.save());
      await h.advance(1);
      assert.equal(h.codeRequests,2);assert.ok(h.preview());assert.notEqual(h.preview(),old);
      assert.notEqual(h.codeImages.at(-1),oldCode);assert.ok(h.removed.includes(old));
      assert.equal(h.page.data.posterReady,true);assert.equal(h.saved.length,0,'过期保存先生成供用户确认，不能保存旧图');
      if(trigger==='save'){await (kind==='detail'?h.page.savePoster():h.page.save());assert.deepEqual(h.saved,[h.preview()]);}
    }finally{h.stop();}
  });
}
for(const kind of ['status'] as ('detail'|'status')[]){
  test(`${kind} 切换主题不会延长圆码期限，过期核对失败不能再保存旧图`,async()=>{
    const h=harness(kind,'fail');
    try{
      await h.advance(1);await h.advance(290000);h.switchTheme();await h.advance(1);
      assert.equal(h.codeRequests,1);h.setCodeFailure(410);await h.advance(10000);
      void (kind==='detail'?h.page.savePoster():h.page.save());await h.advance(1);
      assert.equal(h.codeRequests,2);assert.equal(h.page.data.posterReady,false);assert.equal(h.preview(),'');assert.equal(h.saved.length,0);
    }finally{h.stop();}
  });
}
test('共享短时圆码缓存不因第二次进入或切换模板续期',async()=>{
  const h=harness('status','fail');
  try{
    await h.advance(1);await h.advance(290000);h.reenter();await h.advance(1);h.switchTheme();await h.advance(1);assert.equal(h.codeRequests,1);
    h.setChannel('release');await h.advance(10000);h.reenter();await h.advance(1);assert.equal(h.codeRequests,2);
  }finally{h.stop();}
});

for(const kind of ['detail','status'] as const){
  test(`${kind} 保存等隐私状态期间跨过有效期，不把旧海报写入相册`,async()=>{
    const h=harness(kind,'fail');
    try{
      await h.advance(1);await h.advance(299000);h.setChannel('release');h.setPrivacyDelay(2000);
      void (kind==='detail'?h.page.savePoster():h.page.save());await h.advance(2001);
      assert.equal(h.saved.length,0);assert.equal(h.page.data.posterSaving,false);
      assert.match(h.page.data.posterError,/重新生成|海报已更新/);
    }finally{h.stop();}
  });
}
for(const kind of ['detail','status'] as const){
  test(`${kind} 过期保存重新生成期间离开，迟到结果不覆盖隐藏页`,async()=>{
    const h=harness(kind,'fail',false,6000);
    try{
      await h.advance(6001);await h.advance(300000);
      void (kind==='detail'?h.page.savePoster():h.page.save());await h.advance(1);
      h.page.onHide();const before={preview:h.preview(),error:h.page.data.posterError,exports:h.exports};
      await h.advance(6000);
      assert.equal(h.preview(),before.preview);assert.equal(h.page.data.posterError,before.error);assert.equal(h.exports,before.exports);assert.equal(h.saved.length,0);
    }finally{h.stop();}
  });
}

for(const trigger of ['resume','theme','save'] as const){
  test(`公告长图 ${trigger} 超期重新绘制，切换主题不续期且始终不请求圆码`,async()=>{
    const h=harness('detail','fail',false,6000,410);
    try{
      await h.advance(1);const old=h.preview();assert.ok(old);assert.equal(h.page.data.posterReady,true);assert.equal(h.codeRequests,0);assert.equal(h.codeImages.length,0);
      await h.advance(290000);h.switchTheme();await h.advance(1);const themed=h.preview();assert.notEqual(themed,old);
      if(trigger==='resume')h.page.onHide();await h.advance(10000);
      if(trigger==='resume')h.page.onShow();else if(trigger==='theme')h.page.selectPosterTheme({currentTarget:{dataset:{theme:'precision'}}});else void h.page.savePoster();
      await h.advance(1);assert.notEqual(h.preview(),themed);assert.ok(h.preview());assert.equal(h.page.data.posterReady,true);assert.equal(h.codeRequests,0);assert.equal(h.saved.length,0);assert.ok(h.removed.includes(old));assert.ok(h.removed.includes(themed));
      if(trigger==='save'){await h.page.savePoster();assert.deepEqual(h.saved,[h.preview()]);}
    }finally{h.stop();}
  });
}
test('公告长图离开后未完成的画布结果不能更新页面',async()=>{
  const h=harness('detail','fail');
  try{h.page.onHide();await h.advance(1);assert.equal(h.exports,0);assert.equal(h.preview(),'');assert.equal(h.codeRequests,0);}finally{h.stop();}
});
