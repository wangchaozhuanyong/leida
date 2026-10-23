import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenefitAction, Evidence, Publication, PublicData } from '@/lib/types';
import {statusPosterSnapshot} from '@/lib/status-timeline';
import { publicResetOutlook } from '@/lib/reset-outlook';
import { latestCompletedBenefits } from '@/components/public/model';
import type { StatusPosterStyle } from '@/lib/status-poster-style';
import { designedStatusPoster } from './status-poster-designs';
import { isNewsOnly } from '@/lib/public-facts';
import { isLocalShareUrl } from '@/lib/share';
import { qrSvg } from './share-qr';
import { validateWechatImage } from './wechat-image';
import { announcementCountdown } from '@/components/public/model';

export interface StatusPosterCode { publicationId: string; image: Buffer; contentType: string; }
export interface StatusPosterInput {
  publication: Publication;
  actionId: string;
  name: string;
  generatedAt: string;
  shareUrl: string;
  nextAction?: BenefitAction;
  code?: StatusPosterCode;
  style?: StatusPosterStyle;
  evidence?: Evidence[];
}

const escape = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const fittedSize = (value: string, preferred: number, width: number) => Math.min(preferred, width / Array.from(value).reduce((size, char) => size + (/[\u0000-\u00ff]/.test(char) ? .58 : 1), 0));
const beijingTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
let brandImage: string | undefined;
function brandMarkup(x = 66, y = 62, width = 78, height = 70) {
  brandImage ??= readFileSync(join(process.cwd(), 'public/brand/MOYAO_AI_Icon_Transparent.svg'), 'utf8').match(/href="(data:image\/png;base64,[A-Za-z0-9+/=]+)"/)?.[1];
  if (!brandImage) throw new Error('海报品牌图标不可用');
  return `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="110 520 1850 1010"><image width="2048" height="2048" href="${brandImage}"/></svg>`;
}

export function assertStatusPosterRound(data:PublicData, roundId:string):void {
  if(roundId.startsWith('state:')){if(statusPosterSnapshot(data).round!==roundId)throw Object.assign(new Error('公开状态已变化，请关闭后重新生成海报'),{status:409});return;}
  if((publicResetOutlook(data).active?.publicationId??'waiting')!==roundId)throw Object.assign(new Error('公开状态已变化，请关闭后重新生成海报'),{status:409});
}

/** A waiting/announced poster has no manufactured completion or elapsed time. */
export function currentStatusPosterSvg(data:PublicData, generatedAt:string, roundId:string, style:StatusPosterStyle='precision', code?:StatusPosterCode, shareUrl?:string):string {
  if(roundId.startsWith('state:')) {
    assertStatusPosterRound(data,roundId);
    const input=statusPosterSnapshot(data,generatedAt);
    if(input.round!==roundId)throw Object.assign(new Error('公开状态已变化，请关闭后重新生成海报'),{status:409});
    if(code&&(code.publicationId!==input.codePublicationId||validateWechatImage(code.image)!==code.contentType))throw new Error('小程序码与海报版本不匹配');
    return designedStatusPoster({style,shareUrl,name:data.site.name,title:input.title,interval:input.value+(/^\d+$/.test(input.value)&&input.unit?' '+input.unit:''),intervalLabel:input.label,intervalUnit:input.unit==='小时 : 分钟'?input.unit:undefined,statementAt:input.statementAt,statementLabel:input.statementLabel,generatedAt,nextNote:input.nextNote,nextIsForecast:false,sourceLabel:input.sourceLabel,brand:brandMarkup(0,0,100,75),code});
  }
  const outlook=data.forecasts?.outlook??publicResetOutlook({...data,serverTime:generatedAt});
  const active=outlook.active;
  if(latestCompletedBenefits(data).length || (active?.publicationId??'waiting')!==roundId)throw Object.assign(new Error('公开状态已变化，请关闭后重新生成海报'),{status:409});
  const countdown=active?announcementCountdown(active,generatedAt):undefined;
  const upcoming=countdown?.status==='upcoming';
  const minutes=upcoming?Math.ceil((Date.parse(active!.expectedAt!)-Date.parse(generatedAt))/60000):0;
  const interval=upcoming?`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`:countdown?.status==='expired'?'等待确认':active?.stage==='in_progress'?'进行中':active?'时间待明确':'等待下一次 Reset';
  const title=upcoming?active!.kind==='banked_reset'?'重置卡发放预告':'用量重置预告':countdown?.status==='expired'?'等待公开确认':active?.stage==='in_progress'?active.kind==='banked_reset'?'发卡进行中':'重置进行中':active?'已有公开安排':'等待下一次 Reset';
  if(code&&(code.publicationId!==(active?.publicationId||statusPosterSnapshot(data,generatedAt).codePublicationId)||validateWechatImage(code.image)!==code.contentType))throw new Error('小程序码与海报版本不匹配');
  const nextNote=upcoming?`预计 ${beijingTime(active!.expectedAt!)} · 北京时间`:countdown?.status==='expired'?'已过预计时间，等待公开确认':active?'具体时间待公开确认':'下一次时间待公开确认';
  return designedStatusPoster({style,shareUrl,name:data.site.name,title,interval,intervalLabel:upcoming?'预计剩余 · 小时 : 分钟':'当前公开状态',statementAt:active?.statementAt??'',generatedAt,nextNote,nextIsForecast:!!upcoming,sourceLabel:'依据：当前公开状态',brand:brandMarkup(0,0,100,75),code});
}

/** The homepage poster summarizes one public completion; its scan target remains that publication. */
export function statusPosterSvg(input: StatusPosterInput): string {
  if (input.style !== undefined && input.style !== 'precision' && input.style !== 'editorial') throw new Error('海报样式无效');
  const { publication, generatedAt, shareUrl, code } = input;
  const action = publication.event.actions.find(item => item.id === input.actionId && item.scope === 'public' && item.stage === 'claimed_complete');
  const now = Date.parse(generatedAt), statement = Date.parse(action?.statementAt ?? '');
  if (!action || isNewsOnly(publication) || publication.event.status !== 'published' || publication.article.status !== 'published' || !Number.isFinite(now) || !Number.isFinite(statement) || statement > now) throw new Error('没有可分享的公开完成声明');
  // Validate the fallback URL even when the real mini-program image is available.
  const webCode = qrSvg(shareUrl);
  if (code && (code.publicationId !== publication.id || validateWechatImage(code.image) !== code.contentType)) throw new Error('小程序码与海报版本不匹配');
  const minutes = Math.floor((now - statement) / 60000);
  const interval = minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时` : `${Math.floor(minutes / 1440)} 天`;
  const title = action.kind === 'banked_reset' ? '公告称已发放重置卡' : '公告称已重置用量';
  const next = input.nextAction;
  const pending = next && next.scope === 'public' && ['promised', 'in_progress'].includes(next.stage);
  const countdown = next ? announcementCountdown(next, generatedAt) : undefined;
  const future = pending && countdown?.status === 'upcoming';
  const expectedTime = future ? `${countdown.label.startsWith('约') ? '约' : ''}${beijingTime(next!.expectedAt!)}${countdown.label.endsWith('内') ? '前' : ''}` : '';
  const nextNote = future ? `下次${next!.kind === 'banked_reset' ? '发卡' : '重置'}预告：${expectedTime} · 北京时间` : pending ? countdown?.status === 'expired' ? '已过预计时间，等待公开确认' : '已有发放预告，具体时间等待公开确认' : '暂无可靠的下次重置日期';
  if (input.style) {
    const sources = input.evidence?.filter(item => action.evidenceIds.includes(item.id)) ?? [];
    const tibo = sources.some(item => /^https:\/\/(?:x\.com|twitter\.com)\/thsottiaux\/status\/\d+\/?$/.test(item.url));
    return designedStatusPoster({ style: input.style, shareUrl, name: input.name, title, interval, statementAt: action.statementAt, generatedAt, nextNote, nextIsForecast: !!future, sourceLabel: tibo ? '依据：Tibo 公开动态' : '依据：所选公开公告', brand: brandMarkup(0, 0, 100, 75), code });
  }
  const local = isLocalShareUrl(shareUrl);
  const scanTitle = code ? '微信扫码，查看重置记录' : '扫码查看重置记录';
  const scanNote = code ? '进入小程序，查看依据并订阅提醒' : '查看最新状态与原文依据';
  const scan = code
    ? `<image x="94" y="834" width="168" height="168" preserveAspectRatio="xMidYMid meet" href="data:${code.contentType};base64,${code.image.toString('base64')}"/>`
    : webCode.replace('<svg ', '<svg x="82" y="822" ').replace('width="320" height="320"', 'width="192" height="192"');
  const generatedNote = `生成于 ${beijingTime(generatedAt)} · 北京时间`;
  const footerNote = local && !code ? '本机预览码，手机扫码需正式网站地址' : '海报为生成时的记录，扫码查看发放依据';
  const text = (value: string, x: number, y: number, size: number, color = '#eceeea', weight = 400, anchor = 'middle') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${escape(value)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200" role="img" aria-label="${escape(input.name)}公开重置状态海报">
    <defs>
      <linearGradient id="status-background" x2="1" y2="1"><stop stop-color="#11191c"/><stop offset="1" stop-color="#090f11"/></linearGradient>
      <linearGradient id="status-card" x2="1" y2="1"><stop stop-color="#141d20"/><stop offset="1" stop-color="#141d20"/></linearGradient>
      <linearGradient id="status-accent" x2="1" y2=".4"><stop stop-color="#f4c15c"/><stop offset=".6" stop-color="#f8cf7b"/><stop offset="1" stop-color="#d9a743"/></linearGradient>
      <linearGradient id="status-scan" x2="1" y2="1"><stop stop-color="#211f18"/><stop offset="1" stop-color="#2c281b"/></linearGradient>
      <clipPath id="status-card-clip"><rect x="48" y="180" width="800" height="574" rx="42"/></clipPath>
    </defs>
    <rect width="900" height="1200" fill="url(#status-background)"/>
    ${brandMarkup()}
    <g font-family="PingFang SC,Microsoft YaHei,sans-serif">
      ${text(input.name, 166, 94, fittedSize(input.name, 39, 530), '#eceeea', 700, 'start')}
      ${text('重置动态与发放记录', 166, 128, 23, '#adb4b7', 400, 'start')}
      ${text('重置提醒', 850, 101, 21, '#f4c15c', 500, 'end')}
      <rect x="48" y="180" width="800" height="574" rx="42" fill="url(#status-card)" stroke="#4c5455" stroke-width="2"/>
      <g clip-path="url(#status-card-clip)" fill="none" stroke="#f0c25f" stroke-width="1.5" opacity=".07"><circle cx="898" cy="453" r="340"/><circle cx="898" cy="453" r="252"/><circle cx="898" cy="453" r="164"/></g>
      <rect x="352" y="208" width="196" height="46" rx="23" fill="#302a1b" stroke="#6e5d33"/>
      ${text('公开完成声明', 450, 239, 24, '#f4c15c', 650)}
      ${text(title, 450, 317, fittedSize(title, 48, 738), '#eceeea', 700)}
      ${text('距最近一次公开完成声明', 450, 391, 33, '#adb4b7', 500)}
      ${text(interval, 450, 542, fittedSize(interval, 162, 708), 'url(#status-accent)', 750)}
      ${text(`${beijingTime(action.statementAt)} · 北京时间`, 450, 599, 27, '#adb4b7', 500)}
      <path d="M90 650H806" stroke="#404a4c" stroke-width="1.5"/>
      ${text(nextNote, 450, future ? 694 : 712, fittedSize(nextNote, 25, 730), '#b8b4a8', 500)}
      ${future ? text('公开预告，实际重置待确认', 450, 731, 21, '#adb4b7') : ''}
      <rect x="48" y="805" width="800" height="226" rx="34" fill="url(#status-scan)" stroke="#665631" stroke-width="2"/>
      ${code ? '<circle cx="178" cy="918" r="102" fill="#fff"/>' : '<rect x="76" y="816" width="204" height="204" rx="20" fill="#fff"/>'}
      ${scan}
      ${text(scanTitle, 322, 907, fittedSize(scanTitle, 34, 480), '#eceeea', 700, 'start')}
      ${text(scanNote, 322, 959, fittedSize(scanNote, 26, 480), '#b8b4a8', 400, 'start')}
      ${text(generatedNote, 450, 1124, 23, '#adb4b7', 400)}
      ${text(footerNote, 450, 1167, 22, '#adb4b7', 400)}
    </g>
  </svg>`;
}
