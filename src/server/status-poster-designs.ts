import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StatusPosterStyle } from '@/lib/status-poster-style';
import type { StatusPosterCode } from './status-poster';

interface DesignedPoster {
  style: StatusPosterStyle; name: string; title: string; interval: string;
  statementAt: string; generatedAt: string; nextNote: string; nextIsForecast: boolean;
  sourceLabel: string; brand: string; shareUrl?: string; code?: StatusPosterCode; intervalLabel?: string; statementLabel?:string; intervalUnit?:string;
}
const backgrounds = new Map<StatusPosterStyle, string>();
const escape = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const widthUnits = (value: string) => Array.from(value).reduce((sum, c) => sum + (/^[\x00-\x7f]$/.test(c) ? .56 : 1), 0);
const fit = (value: string, size: number, width: number) => Math.min(size, width / Math.max(1, widthUnits(value)));
function dateTime(value: string) {
  if(!Number.isFinite(Date.parse(value)))return {date:'暂无公开公告',time:'待公开确认'};
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(value)).map(p => [p.type, p.value]));
  return { date: `${parts.year}.${parts.month}.${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
function wrap(value: string, width: number): string[] {
  const lines: string[] = []; let line = '';
  for (const c of value) { if(c==='\n'){if(line)lines.push(line);line='';continue;} if (widthUnits(line + c) > width) { lines.push(line); line = ''; } line += c; }
  if (line) lines.push(line);
  if(lines.length>3){lines.length=3;lines[2]=lines[2].slice(0,-1)+'…';}
  return lines;
}

/** Backgrounds contain no text or codes. Every factual field is drawn from the selected record. */
export function designedStatusPoster(input: DesignedPoster): string {
  const dark = input.style === 'precision';
  const asset = dark ? 'precision-background.png' : 'editorial-background.png';
  if (!backgrounds.has(input.style)) backgrounds.set(input.style, readFileSync(join(process.cwd(), 'public/posters', asset)).toString('base64'));
  const ink = dark ? '#f3e5c8' : '#101719', muted = dark ? '#c4b79d' : '#435056';
  const text = (value: string, x: number, y: number, size: number, color = ink, weight = 400, anchor = 'start', extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}" ${extra}>${escape(value)}</text>`;
  const line = (x1: number, y1: number, x2: number, y2: number) => `<path d="M${x1} ${y1}L${x2} ${y2}" fill="none" stroke="${dark ? '#8c7650' : '#3e4647'}" stroke-width="1.5"/>`;
  const mark = (x: number, y: number, scale = 1) => `<g transform="translate(${x} ${y}) scale(${scale})">${input.brand}</g>`;
  // Only the original image returned by WeChat is a mini-program code.
  // Keep all image bytes and its quiet area; never fabricate or crop its pattern.
  if(input.shareUrl){
    const url=new URL(input.shareUrl);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('无效的扫码地址');
  }
  const scan = input.code ? `<g data-poster-code="mini"><circle cx="875" cy="1705" r="135" fill="#fff"/><image x="780.5" y="1610.5" width="189" height="189" preserveAspectRatio="xMidYMid meet" href="data:${input.code.contentType};base64,${input.code.image.toString('base64')}"/></g>` : '';
  const scanHeading=input.code?'微信扫码进入小程序':input.name;
  const footer=`<rect x="0" y="1530" width="1080" height="390" fill="${dark?'#0b0d10':'#faf6ec'}" opacity="1"/>${text(scanHeading,82,1653,fit(scanHeading,40,input.code?610:930))}${text(input.sourceLabel,82,1711,fit(input.sourceLabel,28,input.code?610:930),muted)}${text(input.code?'海报内容可能更新，最新进展请查看小程序':'小程序码暂不可用，可分享公告链接查看进展',82,1772,24,muted)}${scan}${input.code?text('微信小程序码',875,1876,25,muted,400,'middle'):''}${text('仅整理公开公告，个人状态以账户显示为准',82,1833,24,muted)}${text(`生成于 ${dateTime(input.generatedAt).date} ${dateTime(input.generatedAt).time} · 北京时间`,82,1880,22,muted)}`;
  const date = dateTime(input.statementAt), generated = dateTime(input.generatedAt);
  const elapsed = input.interval.match(/^(\d+) (.+)$/);
  const next = input.nextNote === '暂无可靠的下次重置日期' ? '下一次时间待公开确认' : input.nextNote;
  const nextLines = wrap(next.replace(' · 北京时间', ''), dark ? 11 : 10.5);
  const nextSize = nextLines.length > 2 ? 30 : 38;
  const qualifier = '仅整理公开公告，个人状态以账户显示为准';
  const interval = dark
    ? elapsed ? text(elapsed[1], 540, 948, fit(elapsed[1], 286, 520), 'url(#elapsed-gold)', 700, 'middle', 'font-family="Georgia,Times New Roman,serif"') + text(elapsed[2], 540, 1070, 43, ink, 400, 'middle') : text(input.interval, 540, 920, fit(input.interval,100,510), 'url(#elapsed-gold)', 700, 'middle')
    : elapsed ? text(elapsed[1], 380, 1320, fit(elapsed[1], 460, 316), '#b72f28', 700, 'end', 'font-family="Georgia,Times New Roman,serif"') + text(elapsed[2], 505, 1310, elapsed[2].length > 1 ? 58 : 89, ink, 700, 'end') : text(input.interval, 64, 1190, fit(input.interval,138,455), '#b72f28', 700);
  const content = dark ? `
    ${mark(64, 72)}${text(input.name, 183, 118, fit(input.name, 44, 510))}
    ${line(710, 111, 766, 111)}${text('Codex 用量动态', 1016, 121, 33, ink, 400, 'end')}
    ${text(input.title, 540, 311, fit(input.title, 111, 948), ink, 700, 'middle')}
    ${text(input.intervalLabel ?? '距该公告', 540, 683, fit(input.intervalLabel??'距该公告',38,420), ink, 400, 'middle')}${interval}${input.intervalUnit?text(input.intervalUnit,540,1050,42,ink,400,'middle'):''}

    ${text(input.statementLabel??'公告时间', 72, 1355, 30, muted)}
    ${text(date.date, 72, 1410, 48, ink, 600)}${text(`${date.time} · 北京时间`, 72, 1465, 30, muted)}
    ${line(543, 1330, 543, 1500)}
    ${nextLines.map((value, i) => text(value, 590, 1375 + i * 42, nextSize, ink, 500)).join('')}
    ${input.nextIsForecast ? text('北京时间 · 实际完成待确认', 590, 1515, 24, muted) : ''}

  ` : `
    ${mark(57, 105)}${text(input.name, 186, 181, fit(input.name, 61, input.code ? 490 : 815), ink, 700)}
    ${text('Codex 用量动态', 64, 260, 43, ink, 400, 'start', 'letter-spacing="7"')}
    ${line(64, 320, input.code ? 692 : 1015, 320)}
    ${text('关注公开公告，追踪用量动态', 64, 371, 28, muted, 400, 'start', 'letter-spacing="6"')}
    ${text(input.title.startsWith('公告称') ? '公告称' : '公开状态', 64, 578, 146, ink, 700)}
    ${text(input.title.replace(/^公告称/, ''), 64, 769, fit(input.title.replace(/^公告称/, ''), 157, 948), ink, 700)}
    ${line(64, 831, 1016, 831)}${text(input.intervalLabel ?? '距该公告', 64, 916, 48, ink, 600)}${interval}${input.intervalUnit?text(input.intervalUnit,64,1285,35):''}
    ${line(563, 886, 563, 1349)}
    ${text(input.statementLabel??'公告时间', 600, 923, 35)}${text(date.date, 600, 1000, 62, ink, 600)}
    ${text(date.time, 600, 1076, 73, ink, 600)}${text('北京时间', 600, 1126, 32, muted)}
    ${line(600, 1170, 1016, 1170)}
    ${nextLines.map((value, i) => text(value, 600, 1234 + i * 47, nextSize, ink, 600)).join('')}
    ${input.nextIsForecast ? text('北京时间 · 实际完成待确认', 600, 1390, 25, muted) : ''}
    <rect x="48" y="1403" width="978" height="174" rx="0" fill="#faf5e9" opacity=".72"/>
    ${line(64, 1404, 1016, 1404)}${text(input.sourceLabel, 64, 1462, fit(input.sourceLabel, 37, 944), ink, 600)}
    ${text(qualifier, 64, 1516, 29, muted)}

  `;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920" role="img" aria-label="${escape(`${input.name}：${input.title}，距该公告 ${input.interval}`)}" data-poster-style="${input.style}"><defs><linearGradient id="elapsed-gold" x1="0" y1="0" x2=".8" y2="1"><stop stop-color="#fff1cc"/><stop offset=".45" stop-color="#e3bb71"/><stop offset=".74" stop-color="#f5d99b"/><stop offset="1" stop-color="#ad7835"/></linearGradient></defs><image width="1080" height="1920" preserveAspectRatio="none" href="data:image/png;base64,${backgrounds.get(input.style)}"/><g font-family="Songti SC,STSong,SimSun,serif">${content}${footer}</g></svg>`;
}
