import type { PublicData } from '@/lib/types';
import { actionLabels, fullTime, stageLabels } from '@/lib/labels';
import { isNewsOnly } from '@/lib/public-facts';
import { isLocalShareUrl } from '@/lib/share';
import { activityPublicationUrl, ActivityShareError, resolveActivityShare, type ActivityDayShare, type ActivityShareReady } from '@/lib/activity-share';
import { qrSvg } from './share-qr';

export type ResolvedActivityPoster = ActivityShareReady;
export function resolveActivityPoster(data:PublicData,manifest:ActivityDayShare):ResolvedActivityPoster {
  const result=resolveActivityShare(data,manifest);
  if(!result.available)throw new ActivityShareError(result.blockedReason,result.status);
  return result;
}
const esc=(value:string)=>value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!));
function wrap(value:string,columns:number):string[] {
  const rows:string[]=[];
  for(const paragraph of value.split(/\r?\n/)){
    let row='',width=0;
    for(const character of Array.from(paragraph)){
      const next=/[\u0000-\u00ff]/.test(character)?0.58:1;
      if(row&&width+next>columns){rows.push(row);row='';width=0;}
      row+=character;width+=next;
    }
    rows.push(row);
  }
  return rows;
}
function clipped(value:string,columns:number,maxRows:number):{rows:string[];truncated:boolean} {
  const all=wrap(value,columns),rows=all.slice(0,maxRows),truncated=all.length>maxRows;
  if(truncated)rows[rows.length-1]=Array.from(rows[rows.length-1]).slice(0,-1).join('')+'…';
  return {rows,truncated};
}

/** The entire SVG and its QR refer to the same explicit, already-published snapshot set. */
export function activityPosterSvg(model:ResolvedActivityPoster,name:string,shareUrl:string):string {
  let canonical:string;
  try{canonical=activityPublicationUrl(new URL(shareUrl).origin,model.manifest);}catch{throw new ActivityShareError('每日整合海报的分享地址无效。');}
  if(shareUrl!==canonical)throw new ActivityShareError('分享地址与所选活动发布版本不一致。');
  if(!model.publications.length||model.publications.length!==model.items.length)throw new ActivityShareError('没有可整合的指定发布内容。');
  const content:string[]=[];let y=84;
  const text=(value:string,size=26,color='#c4c9c8',weight=400,maxRows=5,x=60,width=780)=>{
    const result=clipped(value,width/size,maxRows);
    for(const row of result.rows){content.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}">${esc(row)}</text>`);y+=Math.ceil(size*1.55);}
    return result.truncated;
  };
  content.push('<circle cx="86" cy="76" r="25" stroke="#f8cf7b" stroke-width="3" fill="none"/><circle cx="86" cy="76" r="14" stroke="#f8cf7b" fill="none"/><path d="m86 76 23-23" stroke="#f8cf7b" stroke-width="3"/>');
  text(name,32,'#eceeea',600,2,132,708);y+=36;
  text('活动每日整合海报',27,'#f4c15c',600,1);
  const titleClipped=text(model.activity.title,40,'#eceeea',650,4);
  text(`第${model.manifest.day}天 · 活动当前日期：${model.date}`,25,'#e8cf92',500,2);
  const zone=model.timezone==='Asia/Shanghai'?'北京时间':model.timezone==='America/Los_Angeles'?'美国西部时间':'活动指定时区';
  text(`活动日期按${zone}划分，来源时间显示为北京时间。`,22,'#adb4b7',400,2);
  text(`共${model.items.length}条指定发布记录 · 按来源时间顺序整合`,23,'#adb4b7',400,2);
  text(model.rulesNotice,22,'#e7ba72',400,2);
  if(titleClipped)text('活动长标题已截短，扫码查看当前公开名称。',21,'#adb4b7',400,2);
  y+=18;
  for(const [index,item]of model.items.entries()){
    const publication=item.publication,newsOnly=isNewsOnly(publication);
    content.push(`<path d="M60 ${y-10}H840" stroke="#3f494a"/>`);y+=26;
    text(`第${index+1}条 · 来源发布 ${fullTime(item.sourceTime)} 北京时间`,22,'#adb4b7',500,2);
    text(`${publication.article.historical?'历史收录 · ':''}${newsOnly?'来源消息':'公开公告'} · 第${newsOnly?publication.article.version:publication.event.version}版`,22,newsOnly?'#adb4b7':'#f4c15c',500,2);
    let truncated=text(publication.article.title,31,'#eceeea',600,4);
    truncated=text(publication.article.summary,25,'#c4c9c8',400,4)||truncated;
    if(newsOnly)text('仅新闻更新，不改变福利状态和发放次数。',22,'#adb4b7',400,2);
    else if(publication.event.actions.length){
      const actions=publication.event.actions.map(action=>{
        const stage=action.stage==='promised'&&action.expectedAt&&Date.parse(action.expectedAt)<Date.parse(publication.cutoffAt)?'已过预计时间 · 等待确认':stageLabels[action.stage];
        return `${actionLabels[action.kind]}：${stage}（${{public:'公开发放',targeted:'定向补偿',private:'个人记录'}[action.scope]}）`;
      }).join('；');
      truncated=text(actions,23,'#c9bfea',500,3)||truncated;
    }
    const names=[...new Set(item.sources.map(source=>source.name===source.label?source.label:`${source.label} · ${source.name}`))].join('、');
    truncated=text(`来源：${names}`,22,'#adb4b7',400,2)||truncated;
    if(truncated)text('长标题、摘要或来源已截短，扫码查看所选版本全文。',21,'#e7ba72',400,2);
    y+=28;
  }
  const footer=Math.max(940,y+20),expandedCode=shareUrl.length>700,footerWidth=expandedCode?780:465;y=footer+48;
  content.push(`<path d="M60 ${footer}H840" stroke="#3d4749"/>`);
  text('所选条目资料截至',23,'#adb4b7',400,2,60,footerWidth);
  text(`${fullTime(model.cutoffAt)} 北京时间`,25,'#e8cf92',500,3,60,footerWidth);
  text('公开声明不代表个人到账。',22,'#adb4b7',400,2,60,footerWidth);
  text('网页二维码，非微信小程序码。',22,'#adb4b7',400,2,60,footerWidth);
  const local=isLocalShareUrl(shareUrl);
  text(local?'本机预览，手机访问需正式网站地址。':'扫码查看这些发布版本及原始来源。',22,'#adb4b7',400,3,60,footerWidth);
  // A multi-version link can be much denser than a single publication URL.
  // Keep the same round skin and enlarge its actual modules instead of truncating the manifest.
  const codeSize=expandedCode?900:274,codeX=expandedCode?0:566,codeY=expandedCode?y+12:footer+30,labelY=codeY+codeSize+28;
  const qr=qrSvg(shareUrl).replace('<svg ',`<svg x="${codeX}" y="${codeY}" `).replace('width="320" height="320"',`width="${codeSize}" height="${codeSize}"`);
  content.push(qr,`<text x="${codeX+codeSize/2}" y="${labelY}" text-anchor="middle" font-size="22" fill="#e8cf92">${local?'本机预览码':'扫码查看所选版本'}</text>`);
  const height=Math.max(1200,y+32,labelY+48);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}"><title>${esc(model.activity.title)}：第${model.manifest.day}天，${model.items.length}条指定发布版本</title><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#11191c"/><stop offset="1" stop-color="#090f11"/></linearGradient></defs><rect width="900" height="${height}" fill="url(#bg)"/><g stroke="#e5be67" fill="none" opacity=".12"><circle cx="870" cy="340" r="270"/><circle cx="870" cy="340" r="190"/><circle cx="870" cy="340" r="110"/></g><g font-family="PingFang SC,Microsoft YaHei,sans-serif">${content.join('')}</g></svg>`;
}
