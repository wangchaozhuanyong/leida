import type { Publication } from '@/lib/types';
import { fullTime, actionLabels, stageLabels } from '@/lib/labels';
import { isLocalShareUrl } from '@/lib/share';
import { qrSvg } from './share-qr';
const esc = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
/** Split by display width, preserving every character and deliberate newlines. */
function wrap(value: string, columns: number): string[] {
  const output: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    let line = '', width = 0;
    for (const character of Array.from(paragraph)) {
      const nextWidth = /[\u0000-\u00ff]/.test(character) ? 0.58 : 1;
      if (width + nextWidth > columns && line) { output.push(line); line = ''; width = 0; }
      line += character; width += nextWidth;
    }
    output.push(line);
  }
  return output;
}
export function posterSvg(publication: Publication, name: string, shareUrl?: string) {
  const newsOnly=publication.mode==='news_only'||publication.article.publicationMode==='news_only';
  const actions=newsOnly?[]:publication.event.actions;
  const content: string[] = [];
  let y = 84;
  const text = (value: string, size = 26, color = '#c4c9c8', weight = 400, x = 60, available = 780) => {
    const rows = wrap(value, available / size);
    for (const row of rows) { content.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}">${esc(row)}</text>`); y += Math.ceil(size * 1.65); }
  };
  content.push('<circle cx="86" cy="76" r="25" stroke="#f8cf7b" stroke-width="3" fill="none"/><circle cx="86" cy="76" r="14" stroke="#f8cf7b" fill="none"/><path d="m86 76 23-23" stroke="#f8cf7b" stroke-width="3"/>');
  text(name, 32, '#eceeea', 600, 132, 708);
  y += 45;
  text(`${publication.article.historical?'历史收录':'公开资料'} · 第${newsOnly?publication.article.version:publication.event.version}版`, 23, '#adb4b7');
  if(publication.article.sourcePublishedAt)text(`来源发布：${fullTime(publication.article.sourcePublishedAt)} 北京时间`,23,'#adb4b7');
  y += 12;
  text(publication.article.title, 44, '#eceeea', 650);
  y += 15;
  text(publication.article.summary, 27);
  for (const action of actions) {
    y += 28;
    content.push(`<path d="M60 ${y - 13}H840" stroke="#3f494a"/>`);
    y += 24;
    const kind = actionLabels[action.kind];
    const stage = action.stage === 'promised' && action.expectedAt && Date.parse(action.expectedAt) < Date.parse(publication.cutoffAt) ? '已过预计时间 · 等待确认' : stageLabels[action.stage];
    text(`${kind} · ${stage}`, 28, action.kind === 'banked_reset' ? '#c9bfea' : '#f4c15c', 600);
    text(`适用范围：${action.eligibility}`, 25);
    text(`发放类型：${{ public: '公开发放', targeted: '定向补偿', private: '个人记录' }[action.scope]}`, 24, '#adb4b7');
    text(`声明时间：${fullTime(action.statementAt)} 北京时间`, 24, '#adb4b7');
    if (action.expectedAt) text(`预计时间：${fullTime(action.expectedAt)} 北京时间`, 24, '#adb4b7');
    if (action.timeNote) text(action.timeNote, 24, '#e7ba72');
  }
  const footerTop = Math.max(shareUrl ? 870 : 1000, y + 38);
  y = footerTop + 48;
  content.push(`<path d="M60 ${footerTop}H840" stroke="#3d4749"/>`);
  text('资料截至', 23, '#adb4b7', 400, 60, shareUrl ? 390 : 780);
  text(`${fullTime(publication.cutoffAt)} 北京时间`, 25, '#e8cf92', 500, 60, shareUrl ? 390 : 780);
  text(actions.length ? '公开声明不代表个人到账' : '仅新闻更新，福利状态以已确认记录为准', 22, '#adb4b7', 400, 60, shareUrl ? 390 : 780);
  if (shareUrl) {
    const local = isLocalShareUrl(shareUrl);
    const qr = qrSvg(shareUrl).replace('<svg ', `<svg x="480" y="${footerTop + 30}" `).replace('width="320" height="320"', 'width="360" height="360"');
    content.push(qr);
    content.push(`<text x="660" y="${footerTop + 420}" text-anchor="middle" font-size="22" fill="#e8cf92">${local ? '本机预览码' : '扫码查看此版本'}</text>`);
    text(local ? '手机访问需使用正式网站地址' : '扫码可查看原文与版本记录', 22, '#adb4b7', 400, 60, 390);
  } else text('打开模钥重置雷达查看最新进展', 22, '#adb4b7');
  const height = Math.max(1200, y + 32, shareUrl ? footerTop + 465 : 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#11191c"/><stop offset="1" stop-color="#090f11"/></linearGradient></defs><rect width="900" height="${height}" fill="url(#bg)"/><g stroke="#e5be67" fill="none" opacity=".12"><circle cx="870" cy="340" r="270"/><circle cx="870" cy="340" r="190"/><circle cx="870" cy="340" r="110"/></g><g font-family="PingFang SC,Microsoft YaHei,sans-serif" fill="#eceeea">${content.join('')}</g></svg>`;
}
