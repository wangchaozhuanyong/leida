const m = require('./model');
/** @typedef {import('../../src/lib/types').PublicData} PublicData */
/** @typedef {{status:'ready'|'not_configured'|'unavailable',publicationId?:string,filePath?:string}} CodeAsset */
const exported = new WeakSet();
class PosterError extends Error {
  constructor(code, message) { super(message); this.name = 'PosterError'; this.code = code; }
}
const clean = value => String(value == null ? '' : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\t/g,' ');
/** Preserve Unicode code points and deliberate line breaks. Never silently omit facts. */
function wrapText(value, measure, width) {
  if (!Number.isFinite(width) || width <= 0 || typeof measure !== 'function') throw new PosterError('layout', '海报排版参数不完整。');
  const lines = [];
  for (const paragraph of clean(value).split(/\r?\n/)) {
    let line = '';
    for (const character of Array.from(paragraph)) {
      const next = line + character, measured = measure(next);
      if (!Number.isFinite(measured) || measured < 0) throw new PosterError('canvas', '此设备暂时无法测量海报文字。');
      if (line && measured > width) { lines.push(line); line = character; } else line = next;
    }
    lines.push(line);
  }
  return lines;
}
/** @param {PublicData} data @param {string} publicationId */
function posterInput(data, publicationId) {
  const publication = data.publications.find(item => item.id === publicationId);
  if (!publication) throw new PosterError('missing', '未找到指定发布版本。');
  if(!data.events.some(item=>item.id===publication.eventId)||!data.articles.some(item=>item.id===publication.articleId))throw new PosterError('missing','关联公开记录暂时缺失，请稍后重试。');
  if (m.publicationWithdrawn(data,publication)) throw new PosterError('withdrawn', '此内容已撤回，不能生成分享海报。');
  if (data.events.some(item => item.id === publication.eventId && item.status === 'merged')) throw new PosterError('merged', '事件已合并，请查看合并后的公开记录。');
  const newsOnly = m.isNewsOnly(publication);
  return { publicationId, name:data.site.name || '模钥重置雷达', title:publication.article.title, summary:m.publicArticleSummary(publication.article),
    version:newsOnly ? publication.article.version : publication.event.version, historical:m.isHistoricalArticle(publication.article,data.evidence), newsOnly,
    sourceTime:publication.article.sourcePublishedAt ? m.displayTime(publication.article.sourcePublishedAt) : '', cutoff:m.displayTime(publication.cutoffAt),
    actions:newsOnly ? [] : publication.event.actions.map(action => ({ title:`${m.actionLabels[action.kind]} · ${m.stageText(action,publication.cutoffAt)}`, eligibility:action.eligibility,
      scope:{public:'公开发放',targeted:'定向补偿',private:'个人记录'}[action.scope], statementAt:m.displayTime(action.statementAt), expectedAt:action.expectedAt ? m.displayTime(action.expectedAt) : '', timeNote:action.timeNote || '', tone:action.kind === 'banked_reset' ? 'purple' : 'cyan' })) };
}
function createPosterLayout(input, measure, code = {status:'not_configured'}, options = {}) {
  if (!input || !input.publicationId || !Array.isArray(input.actions) || !Number.isInteger(input.version)) throw new PosterError('layout','指定海报版本资料不完整。');
  if (code.status === 'ready' && (code.publicationId !== input.publicationId || !code.filePath)) throw new PosterError('code_version','小程序码与这条发布版本不匹配。');
  const width = Math.max(600,Math.min(1200,Number(options.width) || 900)), scale = width/900, margin = 72*scale;
  const theme=options.theme==='editorial'?'editorial':'precision';
  const palette=theme==='editorial'
    ? {background:'#f6f0e5',surface:'#ede7da',text:'#202925',body:'#414b44',muted:'#677167',accent:'#9c4234',line:'#cfcabb'}
    : {background:'#0b1113',surface:'#141b1d',text:'#eee6d0',body:'#c6ccc4',muted:'#9aa79e',accent:'#e8bf6f',line:'#34403d'};
  const commands = [], available = width-margin*2;
  let y = margin;
  const rect = (x,top,w,h,color) => commands.push({type:'rect',x,y:top,width:w,height:h,color});
  const rule = top => rect(margin,top,available,scale,palette.line);
  // Both palettes use the same type metrics, so changing a style cannot reflow facts or the code.
  const textAt = (value,x,top,maxWidth,size,color=palette.body,weight=400,leading=1.55) => {
    size *= scale;
    const lineHeight=Math.ceil(size*leading);
    for (const row of wrapText(value,value=>measure(value,size,weight,'sans-serif'),maxWidth)) {
      commands.push({type:'text',text:row,x,y:top,size,color,weight,font:'sans-serif'});
      top+=lineHeight;
    }
    return top;
  };
  const text = (value,size,color=palette.body,weight=400,leading=1.55) => {
    y=textAt(value,margin,y,available,size,color,weight,leading);
  };

  // A restrained masthead anchors the fixed template without competing with the announcement.
  rect(margin,y,48*scale,4*scale,palette.accent);y+=24*scale;
  text(input.name,27,palette.text,600);y+=22*scale;rule(y);y+=30*scale;
  text(`${input.historical?'历史收录':input.newsOnly?'新闻更新':'公开公告'} · 第${input.version}版`,21,palette.accent,600);
  if (input.sourceTime) { y+=6*scale;text(`来源发布：${input.sourceTime} 北京时间`,20,palette.muted); }
  y+=24*scale;text(input.title,48,palette.text,700,1.32);y+=28*scale;
  text('公告摘要',21,palette.muted,600);y+=12*scale;text(input.summary,27,palette.body,400,1.7);

  // Each action is an independent fact group. Long values wrap inside a generous inner gutter.
  for (const [index,action] of input.actions.entries()) {
    y+=30*scale;
    const top=y,inside=30*scale,innerX=margin+inside,innerWidth=available-inside*2;
    const surface={type:'rect',x:margin,y:top,width:available,height:0,color:palette.surface};commands.push(surface);
    y+=inside;
    const number=String(index+1).padStart(2,'0'),numberWidth=Math.max(44*scale,measure(number,19*scale,600,'sans-serif'));
    const titleX=innerX+numberWidth+18*scale;
    textAt(number,innerX,y+6*scale,numberWidth,19,palette.accent,600);
    y=textAt(action.title,titleX,y,innerWidth-numberWidth-18*scale,28,palette.text,600,1.45);y+=24*scale;
    rect(innerX,y,innerWidth,scale,palette.line);y+=22*scale;
    const labelWidth=114*scale,valueX=innerX+labelWidth+16*scale,valueWidth=innerWidth-labelWidth-16*scale;
    const fact=(label,value)=>{
      const start=y;
      const labelEnd=textAt(label,innerX,start+2*scale,labelWidth,21,palette.muted);
      const valueEnd=textAt(value,valueX,start,valueWidth,24,palette.body,400,1.55);
      y=Math.max(labelEnd,valueEnd)+12*scale;
    };
    fact('适用范围',action.eligibility);
    fact('发放类型',action.scope);
    fact('声明时间',`${action.statementAt} 北京时间`);
    if(action.expectedAt)fact('预计时间',`${action.expectedAt} 北京时间`);
    if(action.timeNote){y+=4*scale;y=textAt(action.timeNote,innerX,y,innerWidth,22,palette.accent,400,1.6);y+=12*scale;}
    y+=18*scale;surface.height=y-top;
  }

  y+=42*scale;rule(y);y+=32*scale;
  let codeRect;
  if (code.status === 'ready') {
    // The entire genuine square bitmap fits inside a white circular plate, including its corners.
    const size=220*scale,r=size/Math.sqrt(2)+8*scale,plateTop=y,cx=width-margin-r,cy=plateTop+r;
    const copyWidth=available-r*2-38*scale;
    let copyY=textAt('资料截至',margin,y,copyWidth,20,palette.muted,600);
    copyY+=10*scale;copyY=textAt(`${input.cutoff} 北京时间`,margin,copyY,copyWidth,25,palette.text,500,1.5);
    copyY+=24*scale;copyY=textAt(input.newsOnly?'仅新闻更新，福利状态以已确认记录为准':'公开声明不代表个人到账',margin,copyY,copyWidth,23,palette.body,400,1.6);
    copyY+=18*scale;copyY=textAt('原文与更新记录，见此发布版本',margin,copyY,copyWidth,20,palette.muted);
    // Store the image rectangle itself, never the surrounding decorative plate.
    codeRect={x:cx-size/2,y:cy-size/2,width:size,height:size};
    commands.push({type:'circle',x:cx,y:cy,r,color:'#ffffff',stroke:palette.line});
    commands.push({type:'image',...codeRect});
    const caption='扫码查看此发布版本',captionWidth=measure(caption,20*scale,500,'sans-serif');
    const captionEnd=textAt(caption,cx-captionWidth/2,plateTop+r*2+18*scale,r*2,20,palette.muted,500);
    y=Math.max(copyY,captionEnd);
  } else {
    text('资料截至',20,palette.muted,600);y+=8*scale;text(`${input.cutoff} 北京时间`,25,palette.text,500);
    y+=18*scale;text(input.newsOnly?'仅新闻更新，福利状态以已确认记录为准':'公开声明不代表个人到账',23,palette.body);
    y+=16*scale;text(code.status === 'not_configured'?'小程序码尚未配置':'小程序码暂不可用',20,palette.muted);
  }
  const height=Math.ceil(y+margin);
  // This is an application memory limit, not a claim about a universal WeChat canvas limit.
  if (height > (Number(options.maxHeight) || 8192)) throw new PosterError('too_long','这条公告内容较长，请直接分享详情。');
  return {publicationId:input.publicationId,width:Math.ceil(width),height,commands,codeRect,codeStatus:code.status,theme,background:palette.background};
}
function loadCanvasImage(canvas, path, timers = {setTimeout,clearTimeout}) {
  return new Promise((resolve,reject) => {
    if (!canvas || typeof canvas.createImage !== 'function') { reject(new PosterError('unsupported','当前微信不支持海报图片，请更新微信。')); return; }
    let image, timeout;
    const finish=(error)=>{timers.clearTimeout(timeout);if(image){image.onload=null;image.onerror=null;}error?reject(error):resolve(image);};
    try { image=canvas.createImage(); timeout=timers.setTimeout(()=>finish(new PosterError('image','小程序码图片加载超时，请重试。')),10000);
      image.onload=()=>finish(); image.onerror=()=>finish(new PosterError('image','小程序码图片无法读取，请重试。')); image.src=path;
    } catch (_) { finish(new PosterError('image','小程序码图片无法读取，请重试。')); }
  });
}
function nextPaint(canvas, timers = {setTimeout,clearTimeout}) {
  return new Promise((resolve,reject) => {
    if (typeof canvas.requestAnimationFrame !== 'function') { reject(new PosterError('unsupported','当前微信不支持海报画布，请更新微信。')); return; }
    const timeout=timers.setTimeout(()=>reject(new PosterError('canvas','海报绘制尚未完成，请重试。')),10000);
    try { canvas.requestAnimationFrame(()=>{timers.clearTimeout(timeout);resolve();}); }
    catch (_) { timers.clearTimeout(timeout);reject(new PosterError('canvas','海报绘制失败，请重试。')); }
  });
}
/** Caller supplies a real <canvas type="2d"> node, never a browser/legacy canvas. */
async function renderPoster({wxApi,canvas,data,publicationId,code={status:'not_configured'},page,options,isCurrent=()=>true}) {
  if (!canvas || typeof canvas.getContext !== 'function' || !wxApi || typeof wxApi.canvasToTempFilePath !== 'function') throw new PosterError('unsupported','当前微信不支持生成海报，请更新微信。');
  const input=posterInput(data,publicationId), ctx=canvas.getContext('2d');
  if (!ctx || typeof ctx.measureText !== 'function') throw new PosterError('unsupported','当前微信不支持海报画布，请更新微信。');
  const layout=createPosterLayout(input,(text,size,weight,font)=>{ctx.font=`${weight} ${size}px ${font}`;return ctx.measureText(text).width;},code,options);
  canvas.width=layout.width;canvas.height=layout.height;
  let image;
  if (code.status === 'ready') {
    image=await loadCanvasImage(canvas,code.filePath);
    if (!image.width || !image.height || image.width !== image.height) throw new PosterError('image','小程序码图片格式不正确，请重新生成。');
  }
  ctx.fillStyle=layout.background;ctx.fillRect(0,0,layout.width,layout.height);ctx.textBaseline='top';ctx.textAlign='left';
  for(const command of layout.commands) {
    if(command.type==='text'){ctx.fillStyle=command.color;ctx.font=`${command.weight} ${command.size}px ${command.font || 'sans-serif'}`;ctx.fillText(command.text,command.x,command.y);}
    else if(command.type==='rect'){ctx.fillStyle=command.color;ctx.fillRect(command.x,command.y,command.width,command.height);}
    else if(command.type==='circle'){ctx.beginPath();ctx.arc(command.x,command.y,command.r,0,Math.PI*2);ctx.fillStyle=command.color;ctx.fill();ctx.strokeStyle=command.stroke;ctx.lineWidth=2;ctx.stroke();}
    else ctx.drawImage(image,command.x,command.y,command.width,command.height);
  }
  return exportCanvas(wxApi,canvas,page,{publicationId,width:layout.width,height:layout.height,codeStatus:code.status},isCurrent);
}
async function exportCanvas(wxApi,canvas,page,metadata,isCurrent=()=>true) {
  await nextPaint(canvas);
  if(!isCurrent())throw new PosterError('cancelled','已取消旧海报生成。');
  const layout=metadata;
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error,artifact)=>{if(settled)return;settled=true;clearTimeout(timeout);error?reject(error):resolve(artifact);};
    const timeout=setTimeout(()=>finish(new PosterError('export','海报导出超时，请重新生成。')),15000);
    try{wxApi.canvasToTempFilePath({canvas,x:0,y:0,width:layout.width,height:layout.height,destWidth:layout.width,destHeight:layout.height,fileType:'png',
      success(result){if(settled)return;if(!isCurrent()){finish(new PosterError('cancelled','已取消旧海报生成。'));return;}if(!result || typeof result.tempFilePath!=='string' || !result.tempFilePath){finish(new PosterError('export','海报导出失败，请重试。'));return;}
        const artifact={...metadata,tempFilePath:result.tempFilePath};exported.add(artifact);finish(null,artifact);},
      fail(){finish(new PosterError('export','海报导出失败，请重试。'));}},page);}catch(_){finish(new PosterError('export','海报导出失败，请重试。'));}
  });
}
/** Only an explicit save-button handler may pass userInitiated:true. No automatic permission prompts. */
function savePoster(wxApi,artifact,{userInitiated=false}={}) {
  if(!userInitiated) return Promise.reject(new PosterError('gesture','请点击保存按钮后再保存海报。'));
  if(!artifact || !exported.has(artifact)) return Promise.reject(new PosterError('missing','请先生成本次海报。'));
  if(typeof wxApi.saveImageToPhotosAlbum!=='function') return Promise.reject(new PosterError('unsupported','当前微信不支持保存图片，请更新微信。'));
  return new Promise((resolve,reject)=>{
    wxApi.saveImageToPhotosAlbum({filePath:artifact.tempFilePath,success(){resolve({saved:true});},fail(error){
      const reason=String(error && error.errMsg || '').toLowerCase();
      reject(reason.includes('privacy')?new PosterError('privacy','请先阅读并同意隐私指引，再保存海报。'):reason.includes('cancel')?new PosterError('cancelled','已取消保存。'):/deny|denied|authorize/.test(reason)?new PosterError('permission','请在微信权限设置中允许保存到相册后重试。'):new PosterError('save','保存失败，请重试。'));
    }});
  });
}
/** Write only the genuine server response into the WeChat sandbox; remove after drawing. */
function writeCodeAsset(wxApi,value,publicationId){
  if(!value||value.publicationId!==publicationId||!['image/png','image/jpeg'].includes(value.contentType)||!/^[a-f0-9]{32}$/.test(value.scene))return Promise.reject(new PosterError('code_version','小程序码与指定发布版本不匹配。'));
  const encoded=value.imageBase64;
  if(typeof encoded!=='string'||encoded.length>3000000||encoded.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)||encoded.length*3/4-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0)>2097152||!(value.contentType==='image/png'?encoded.startsWith('iVBORw0KGgo'):encoded.startsWith('/9j/')))return Promise.reject(new PosterError('image','小程序码图片格式不正确，请重新生成。'));
  if(typeof wxApi.getFileSystemManager!=='function'||!wxApi.env||!wxApi.env.USER_DATA_PATH)return Promise.reject(new PosterError('unsupported','当前微信不能读取小程序码，请更新微信。'));
  const fs=wxApi.getFileSystemManager(),path=`${wxApi.env.USER_DATA_PATH}/moyao-code-${value.scene}-${Date.now()}-${++assetCounter}.${value.contentType==='image/png'?'png':'jpg'}`;
  return new Promise((resolve,reject)=>fs.writeFile({filePath:path,data:encoded,encoding:'base64',success(){let disposed=false;resolve({status:'ready',publicationId,filePath:path,dispose(){
    if(disposed)return Promise.resolve();disposed=true;
    // Cleanup must not delay completion or error handling: a missing unlink
    // callback must not keep either poster page busy or replace its result.
    try{fs.unlink({filePath:path,success(){},fail(){}});}catch(_){/* Cleanup is best effort and must preserve the generation result. */}
    return Promise.resolve();
  }});},fail(){reject(new PosterError('image','小程序码图片未能读取，请重试。'));}}));
}
let assetCounter=0;
// Official APIs: canvasToTempFilePath, Canvas.createImage, Canvas.requestAnimationFrame,
// saveImageToPhotosAlbum. Real native compile/image export/permissions remain unverified.
module.exports={PosterError,wrapText,posterInput,createPosterLayout,loadCanvasImage,renderPoster,exportCanvas,savePoster,writeCodeAsset};
