const m=require('./model');
const {statusTimelineModel}=require('./status-timeline');
const {PosterError,loadCanvasImage,exportCanvas}=require('./poster');
const assets={precision:'/assets/posters/precision.jpg',editorial:'/assets/posters/editorial.jpg',brand:'/assets/posters/brand.png'};
function dateTime(value){
  if(!Number.isFinite(Date.parse(value)))return{date:'暂无公开公告',time:''};
  const d=new Date(Date.parse(value)+8*3600000),pad=n=>String(n).padStart(2,'0');
  return{date:`${d.getUTCFullYear()}.${pad(d.getUTCMonth()+1)}.${pad(d.getUTCDate())}`,time:`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`};
}
/** Freeze factual content once; the two layouts never change its time or publication. */
function statusPosterInput(data){
  if(!data||!Number.isFinite(Date.parse(data.serverTime)))throw new PosterError('missing','请先加载公开状态。');
  const latest=m.latestCompletedBenefits(data)[0],outlook=m.resetOutlookModel(data),timeline=statusTimelineModel(outlook,data.serverTime,latest&&latest.action);
  const active=outlook.active,pending=active&&m.announcementCountdown(active,data.serverTime);
  const publication=latest?latest.publication:active?data.publications.find(p=>p.id===active.publicationId):m.sortedArticles(data.articles).map(a=>data.publications.find(p=>p.id===a.publicationId)).find(p=>p&&m.resolveDetail(data,{publicationId:p.id}).canShare);
  let title=timeline.title,label='当前公开状态',value=timeline.title,unit='',statementAt=active&&active.statementAt;
  if(latest){
    const minutes=Math.max(0,Math.floor((Date.parse(data.serverTime)-Date.parse(latest.action.statementAt))/60000));
    title=latest.action.kind==='banked_reset'?'公告称已发放重置卡':'公告称已重置用量';label='距该公告';
    value=minutes<1?'刚刚':String(minutes<60?minutes:minutes<1440?Math.floor(minutes/60):Math.floor(minutes/1440));
    unit=minutes<1?'':minutes<60?'分钟':minutes<1440?'小时':'天';statementAt=latest.action.statementAt;
  }else if(timeline.scheduled){title=active.kind==='banked_reset'?'重置卡发放预告':'用量重置预告';label=timeline.lead;value=timeline.title;unit='小时 : 分钟';}
  const date=dateTime(statementAt),generated=dateTime(data.serverTime);
  const nextNote=active?pending.status==='upcoming'?`下次${active.kind==='banked_reset'?'发卡':'重置'}预告：${m.displayTime(active.expectedAt)}`:pending.status==='expired'?'已过预计时间，等待公开确认':'已有公开安排，具体时间待确认':'下一次时间待公开确认';
  const sources=latest?data.evidence.filter(e=>latest.action.evidenceIds.includes(e.id)):[];
  const tibo=sources.some(e=>/^https:\/\/(?:x\.com|twitter\.com)\/thsottiaux\/status\/\d+\/?$/.test(e.url));
  return{name:data.site.name||'模钥重置雷达',publicationId:publication&&publication.id||'',generatedAt:data.serverTime,title,label,value,unit,date:date.date,time:date.time,generated:`${generated.date} ${generated.time}`,nextNote,sourceLabel:tibo?'依据：Tibo 公开动态':latest?'依据：所选公开公告':'依据：当前公开状态'};
}
function statusPosterAvailable(input,data){return !input.publicationId||!!data&&m.resolveDetail(data,{publicationId:input.publicationId}).canShare;}
function createStatusPosterLayout(input,measure,theme='precision',includeCode=false){
  if(!['precision','editorial'].includes(theme))throw new PosterError('layout','海报风格无效。');
  const dark=theme==='precision',ink=dark?'#f3e5c8':'#101719',muted=dark?'#c4b79d':'#435056',commands=[];
  const text=(value,x,y,size,color=ink,weight=400,align='left',maxWidth)=>{
    if(maxWidth)size=Math.min(size,size*maxWidth/Math.max(1,measure(value,size,weight)));
    commands.push({type:'text',value,x,y,size,color,weight,align});
  };
  const line=(x1,y1,x2,y2)=>commands.push({type:'line',x1,y1,x2,y2,color:dark?'#8c7650':'#3e4647'});
  const rect=(x,y,width,height,color,alpha=1)=>commands.push({type:'rect',x,y,width,height,color,alpha});
  const brand=(x,y)=>commands.push({type:'image',asset:'brand',x,y,width:100,height:75,sx:110,sy:520,sw:1850,sh:1010});
  const code=(x,y,r)=>{if(!includeCode)return;commands.push({type:'circle',x,y,r,color:'#fff'});commands.push({type:'image',asset:'code',x:x-r*.7,y:y-r*.7,width:r*1.4,height:r*1.4});text('原文与记录',x,y+r+36,27,muted,400,'center');};
  const nextLines=[];let row='';for(const c of input.nextNote.replace(' · 北京时间','')){if(measure(row+c,38,500)>(dark?425:415)){nextLines.push(row);row='';}row+=c;}if(row)nextLines.push(row);
  const nextSize=nextLines.length>2?30:38;
  if(dark){
    brand(64,72);text(input.name,183,118,44,ink,400,'left',510);line(710,111,766,111);text('Codex 用量动态',1016,121,33,ink,400,'right');
    text(input.title,540,311,111,ink,700,'center',948);text(input.label,540,610,52,ink,400,'center');
    if(/^\d+$/.test(input.value)){text(input.value,540,1000,440,'gold',700,'center',640);text(input.unit,540,1195,60,ink,400,'center');}
    else{text(input.value,540,942,input.value.includes(':')?180:150,'gold',700,'center',730);if(input.unit)text(input.unit,540,1050,42,ink,400,'center');}
    code(890,1248,158);text('公告时间',72,1495,34,muted);text(input.date,72,1556,59,ink,600,'left',445);text(input.time?`${input.time} · 北京时间`:'时间待公开确认',72,1612,35,muted);
    line(543,1472,543,1650);nextLines.forEach((s,i)=>text(s,590,1526+i*47,nextSize,ink,500,'left',425));
    line(72,1694,1016,1694);text(input.sourceLabel,72,1751,31,muted,400,'left',930);text('仅整理公开公告，个人状态以账户显示为准',72,1800,28,muted,400,'left',930);text(`生成于 ${input.generated} · 北京时间`,72,1870,25,muted);
  }else{
    brand(57,105);text(input.name,186,181,61,ink,700,'left',includeCode?490:815);text('Codex 用量动态',64,260,43);code(893,186,134);line(64,320,includeCode?692:1015,320);text('关注公开公告，追踪用量动态',64,371,28,muted);
    const completed=input.title.startsWith('公告称');text(completed?'公告称':'公开状态',64,578,146,ink,700);text(input.title.replace(/^公告称/,''),64,769,157,ink,700,'left',948);
    line(64,831,1016,831);text(input.label,64,916,48,ink,600);
    if(/^\d+$/.test(input.value)){text(input.value,380,1320,460,'#b72f28',700,'right',316);text(input.unit,505,1310,input.unit.length>1?58:89,ink,700,'right');}
    else{text(input.value,64,1190,input.value.includes(':')?130:110,'#b72f28',700,'left',455);if(input.unit)text(input.unit,64,1285,35);}
    line(563,886,563,1349);text('公告时间',600,923,35);text(input.date,600,1000,62,ink,600,'left',416);text(input.time||'待公开确认',600,1076,73,ink,600,'left',416);if(input.time)text('北京时间',600,1126,32,muted);
    line(600,1170,1016,1170);nextLines.forEach((s,i)=>text(s,600,1234+i*47,nextSize,ink,600,'left',416));
    rect(48,1403,978,174,'#faf5e9',.72);line(64,1404,1016,1404);text(input.sourceLabel,64,1462,37,ink,600,'left',944);text('仅整理公开公告，个人状态以账户显示为准',64,1516,29,muted,400,'left',944);
    rect(48,1784,835,82,'#faf5e9',.85);text(`生成于 ${input.generated} · 北京时间`,64,1838,27,muted);
  }
  return{width:1080,height:1920,theme,background:assets[theme],commands};
}
async function renderStatusPoster({wxApi,canvas,page,input,theme='precision',code,isCurrent=()=>true}){
  const ctx=canvas.getContext('2d');if(!ctx)throw new PosterError('canvas','海报画布暂不可用。');
  if(code&&(code.publicationId!==input.publicationId||!code.filePath))throw new PosterError('code_version','小程序码与当前海报不匹配。');
  const layout=createStatusPosterLayout(input,(value,size,weight)=>{ctx.font=`${weight} ${size}px Songti SC,STSong,serif`;return ctx.measureText(value).width;},theme,!!code);
  const images={background:await loadCanvasImage(canvas,layout.background),brand:await loadCanvasImage(canvas,assets.brand)};
  if(code){images.code=await loadCanvasImage(canvas,code.filePath);if(!images.code.width||images.code.width!==images.code.height)throw new PosterError('image','小程序码格式不正确。');}
  if(!isCurrent())throw new PosterError('cancelled','已取消旧海报生成。');
  canvas.width=1080;canvas.height=1920;ctx.drawImage(images.background,0,0,1080,1920);ctx.textBaseline='alphabetic';
  const gold=ctx.createLinearGradient(420,540,730,1100);[[0,'#fff1cc'],[.45,'#e3bb71'],[.74,'#f5d99b'],[1,'#ad7835']].forEach(([stop,color])=>gold.addColorStop(stop,color));
  for(const c of layout.commands){
    if(c.type==='text'){ctx.fillStyle=c.color==='gold'?gold:c.color;ctx.font=`${c.weight} ${c.size}px ${c.color==='gold'||c.color==='#b72f28'?'Georgia,':''}Songti SC,STSong,serif`;ctx.textAlign=c.align;ctx.fillText(c.value,c.x,c.y);}
    else if(c.type==='line'){ctx.beginPath();ctx.moveTo(c.x1,c.y1);ctx.lineTo(c.x2,c.y2);ctx.strokeStyle=c.color;ctx.lineWidth=1.5;ctx.stroke();}
    else if(c.type==='rect'){ctx.globalAlpha=c.alpha;ctx.fillStyle=c.color;ctx.fillRect(c.x,c.y,c.width,c.height);ctx.globalAlpha=1;}
    else if(c.type==='circle'){ctx.beginPath();ctx.arc(c.x,c.y,c.r,0,Math.PI*2);ctx.fillStyle=c.color;ctx.fill();}
    else if(c.asset==='brand')ctx.drawImage(images.brand,c.sx,c.sy,c.sw,c.sh,c.x,c.y,c.width,c.height);
    else ctx.drawImage(images.code,c.x,c.y,c.width,c.height);
  }
  return exportCanvas(wxApi,canvas,page,{publicationId:input.publicationId,width:1080,height:1920,codeStatus:code?'ready':'not_configured',theme},isCurrent);
}
module.exports={statusPosterInput,statusPosterAvailable,createStatusPosterLayout,renderStatusPoster};
