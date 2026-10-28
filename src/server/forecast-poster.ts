import type {ForecastSnapshot} from '../lib/forecast';
import {fullTime} from '../lib/labels';
import {forecastBasisText,forecastValueText,forecastExplanationText,intervalText} from '../lib/forecast-display';
import {isLocalShareUrl} from '../lib/share';
import {qrSvg} from './share-qr';

const escape=(text:string)=>text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** Only immutable snapshot fields enter this poster; no current publications are read. */
export function forecastPosterSvg(snapshot:ForecastSnapshot,name:string,shareUrl:string):string {
 const rows:string[]=[];let y=80;
 const line=(value:string,size=27,color='#c4c9c8')=>{
  let row='',width=0;const max=780/size;
  for(const char of Array.from(value)){const next=/[\u0000-\u00ff]/.test(char)?.58:1;if(char==='\n'||width+next>max){rows.push(`<text x="60" y="${y}" font-size="${size}" fill="${color}">${escape(row)}</text>`);y+=Math.ceil(size*1.7);row='';width=0;if(char==='\n')continue;}row+=char;width+=next;}
  rows.push(`<text x="60" y="${y}" font-size="${size}" fill="${color}">${escape(row)}</text>`);y+=Math.ceil(size*1.7);
 };
 line(name,32,'#eceeea');y+=25;line('历史实验预测',42,'#f4c15c');line(snapshot.target==='banked_reset'?'重置卡公开公告':'用量重置公开公告',32);line(forecastBasisText(snapshot.basis),25,'#c9bfea');y+=20;
 line(`24小时：${forecastValueText(snapshot,24)}`,35,'#f4c15c');line(`截至 ${fullTime(snapshot.windows[24])} 北京时间`,23);
 line(`48小时：${forecastValueText(snapshot,48)}`,35,'#f4c15c');line(`截至 ${fullTime(snapshot.windows[48])} 北京时间`,23);y+=16;
 line(`样本 ${snapshot.sampleCount} 例 · 来源连续覆盖${snapshot.coverage.status==='verified'?'已核验':'未核验'}`,25);
 line(`48小时95%可信区间：${intervalText(snapshot.interval48)}`,25);
 line(forecastExplanationText(snapshot),25);line('预测公开重置消息，实际到账以账户显示为准。',24);line('这是当时的预测，不是当前发放状态或已验证准确率。',24);y+=16;
 line(`首次信号：${fullTime(snapshot.signalAt)} 北京时间`,23);line(`生成时间：${fullTime(snapshot.generatedAt)} 北京时间`,23);line(`证据截至：${fullTime(snapshot.evidenceCutoffAt)} 北京时间`,23);
 const qrTop=y+25;rows.push(qrSvg(shareUrl).replace('<svg ',`<svg x="310" y="${qrTop}" `).replace('width="320" height="320"','width="280" height="280"'));
 rows.push(`<text x="450" y="${qrTop+320}" text-anchor="middle" font-size="24" fill="#e8cf92">${isLocalShareUrl(shareUrl)?'本机预览码':'扫码查看这条预测记录'}</text>`);
 const height=qrTop+370;
 return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}" data-snapshot-id="${escape(snapshot.id)}"><defs><linearGradient id="forecast-bg" x2="1" y2="1"><stop stop-color="#11191c"/><stop offset="1" stop-color="#090f11"/></linearGradient></defs><rect width="900" height="${height}" fill="url(#forecast-bg)"/><g font-family="PingFang SC,Microsoft YaHei,sans-serif">${rows.join('')}</g></svg>`;
}
