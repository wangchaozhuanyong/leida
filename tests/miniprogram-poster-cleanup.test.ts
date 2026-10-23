import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {Script,createContext} from 'node:vm';

// Actual native page/model/rendering modules; only WeChat I/O and time are simulated.
function harness(kind:'detail'|'status',cleanup:'missing'|'fail'|'throw'|'late',firstExportFails=false) {
  const root=resolve('miniprogram'),start=Date.parse('2026-10-24T00:00:00Z');
  let now=0,serial=0,definition:any,page:any,exports=0,codeRequests=0;
  const timers=new Map<number,{at:number;fn:()=>void}>(),removed:string[]=[];
  const setTimeout=(fn:()=>void,ms=0)=>{const id=++serial;timers.set(id,{at:now+Number(ms),fn});return id;};
  const clearTimeout=(id:number)=>{timers.delete(id);};
  const flush=async()=>{for(let n=0;n<40;n++)await Promise.resolve();};
  async function advance(ms:number){const end=now+ms;await flush();for(;;){const next=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].fn();await flush();}now=end;await flush();}
  const article={id:'article',eventId:'event',title:'隔离清理回归',summary:'不写真实数据。',translation:'',category:'reset',version:1,status:'published',publicationId:'publication',evidenceIds:[],publishedAt:'2026-10-23T12:00:00Z',updatedAt:'2026-10-23T12:00:00Z'};
  const event={id:'event',title:article.title,version:1,status:'published',publicationId:'publication',updatedAt:article.updatedAt,evidenceIds:[],actions:[]};
  const data={publications:[{id:'publication',eventId:event.id,articleId:article.id,publishedAt:article.publishedAt,cutoffAt:article.publishedAt,reason:'隔离测试',mode:'state_change',article,event}],events:[event],articles:[article],evidence:[],activities:[],notices:[],sources:[],site:{name:'测试',description:'',version:1,autoPublish:true},serverTime:new Date(start).toISOString()};
  const state={data,receivedAt:start,loading:false,error:'',unconfigured:false};
  const ctx={font:'',fillStyle:'',strokeStyle:'',lineWidth:1,textBaseline:'',textAlign:'',globalAlpha:1,beginPath(){},arc(){},fill(){},stroke(){},moveTo(){},lineTo(){},measureText(text:string){return{width:Array.from(text).length*(Number(this.font.match(/ (\d+(?:\.\d+)?)px/)?.[1])||20)};},fillText(){},fillRect(){},drawImage(){},createLinearGradient(){return{addColorStop(){}};}};
  const canvas={width:0,height:0,getContext(){return ctx;},createImage(){const image:any={width:430,height:430,onload:null,onerror:null};Object.defineProperty(image,'src',{set(){setTimeout(()=>image.onload?.(),0);}});return image;},requestAnimationFrame(fn:()=>void){setTimeout(fn,0);}};
  const wx={env:{USER_DATA_PATH:'wxfile://isolated'},showShareMenu(){},hideShareMenu(){},setBackgroundColor(){},showToast(){},getFileSystemManager(){return{writeFile(o:any){setTimeout(()=>o.success(),0);},unlink(o:any){removed.push(o.filePath);if(!o.filePath.includes('/moyao-code-')){o.success();return;}if(cleanup==='throw')throw new Error('isolated unlink failure');if(cleanup==='fail')o.fail({});if(cleanup==='late')setTimeout(()=>o.success(),30000);}};},createSelectorQuery(){let callback:(value:any)=>void;const query={in(){return query;},select(){return query;},fields(_:any,fn:(value:any)=>void){callback=fn;return query;},exec(){setTimeout(()=>callback({node:canvas}),0);}};return query;},canvasToTempFilePath(o:any){const nth=++exports;setTimeout(()=>{if(firstExportFails&&nth===1)o.fail({errMsg:'isolated export failure'});else o.success({tempFilePath:`wxfile://isolated-poster-${nth}.png`});},0);}};
  const app={client:{setView(){return Promise.resolve();},subscribe(fn:(value:any)=>void){fn(state);return()=>{};},getState(){return state;}},publicApi(){codeRequests++;return{promise:Promise.resolve({data:{publicationId:'publication',scene:'a'.repeat(32),contentType:'image/png',imageBase64:'iVBORw0KGgo='}}),abort(){}};}};
  class ClockDate extends Date {constructor(value?:string|number){super(value===undefined?start+now:value);}static now(){return start+now;}}
  const sandbox=createContext({Promise,Date:ClockDate,setTimeout,clearTimeout,setInterval:setTimeout,clearInterval:clearTimeout,queueMicrotask,wx,getApp:()=>app,Page:(value:any)=>{definition=value;}}),cache=new Map<string,{exports:any}>();
  function load(path:string):any {if(cache.has(path))return cache.get(path)!.exports;const module={exports:{}};cache.set(path,module);const run=new Script('(function(require,module,exports){'+readFileSync(path,'utf8')+'\n})',{filename:path}).runInContext(sandbox);run((name:string)=>{assert.ok(name.startsWith('.'));const target=resolve(dirname(path),name.endsWith('.js')?name:name+'.js');assert.ok(target.startsWith(root+'/'));return load(target);},module,module.exports);return module.exports;}
  load(resolve(root,kind==='detail'?'pages/detail/index.js':'packages/poster/index.js'));
  page={...definition,data:structuredClone(definition.data),setData(patch:any,callback?:()=>void){Object.assign(this.data,patch);callback?.();}};
  page.onLoad(kind==='detail'?{publicationId:'publication'}:{});page.onShow();
  if(kind==='detail')void page.generatePoster();
  return {page,advance,removed,get exports(){return exports;},get codeRequests(){return codeRequests;},preview:()=>kind==='detail'?page.data.posterPreview:page.data.preview,retry(){if(kind==='detail')void page.generatePoster();else void page.generate();},switchTheme(){const e={currentTarget:{dataset:{theme:'editorial'}}};if(kind==='detail')page.selectPosterTheme(e);else page.selectTheme(e);},stop(){page.onUnload();timers.clear();}};
}

for(const kind of ['detail','status'] as const)for(const cleanup of ['missing','fail','throw','late'] as const){
  test(`${kind} 成品不等待 ${cleanup} 清理回调，跨20秒和切换样式仍可用`,async()=>{
    const h=harness(kind,cleanup);
    try{
      await h.advance(1);
      assert.equal(h.exports,1);assert.equal(h.page.data.posterBusy,false);assert.equal(h.page.data.posterError,'');assert.ok(h.preview());
      if(kind==='detail')assert.equal(h.page.data.posterReady,true);
      await h.advance(20000);assert.equal(h.page.data.posterError,'');assert.equal(h.page.data.posterBusy,false);
      h.switchTheme();await h.advance(1);assert.equal(h.exports,2);assert.equal(h.codeRequests,1);assert.equal(h.preview(),'wxfile://isolated-poster-2.png');assert.equal(h.page.data.posterBusy,false);
      await h.advance(40000);assert.equal(h.page.data.posterError,'');assert.equal(h.preview(),'wxfile://isolated-poster-2.png');
      assert.equal(h.removed.filter(path=>path.includes('/moyao-code-')).length,2);
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
      h.retry();await h.advance(1);assert.equal(h.exports,2);assert.equal(h.codeRequests,1);assert.equal(h.preview(),'wxfile://isolated-poster-2.png');assert.equal(h.page.data.posterBusy,false);assert.equal(h.page.data.posterError,'');
      await h.advance(20000);assert.equal(h.page.data.posterError,'');assert.equal(h.preview(),'wxfile://isolated-poster-2.png');
      assert.equal(h.removed.filter(path=>path.includes('/moyao-code-')).length,2);
    }finally{h.stop();}
  });
}
