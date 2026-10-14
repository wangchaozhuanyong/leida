import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseArchive,sourceDefinitions,SourceStructureError} from '../src/server/ingestion';

const source=sourceDefinitions.find(item=>item.id==='reset-archive')!;
const messageId='2109045392684032299';
const url=`https://x.com/thsottiaux/status/${messageId}`;
const expectedAt='2026-10-11T07:00:00.000Z';
const collectedAt='2026-10-11T03:00:00.000Z';
const postedAt=new Date(Number((BigInt(messageId)>>22n)+1288834974657n)).toISOString();
const htmlAttribute=(value:string)=>value.replaceAll('&','&amp;').replaceAll('"','&quot;');
function scheduled(key:unknown=[messageId,expectedAt,'regular',url],deadline=expectedAt,link=url){
 return `<section data-role="scheduled-reset" data-scheduled-key="${htmlAttribute(JSON.stringify(key))}" data-scheduled-for="${deadline}"><h2>已安排重置</h2><a href="${link}">查看公告</a></section>`;
}
function log(id='2108040921044639779',text='已确认在所有账户落地。',time='2026-10-08T03:44:55.000Z'){
 return `<li class="log-item" data-tweet-id="${id}"><p class="log-item-text">${text}</p><time data-datetime="${time}"></time><a class="log-item-link" href="https://x.com/thsottiaux/status/${id}">原文</a></li>`;
}

test('独立安排卡片与历史公告一并采集，保留关联原帖及辅助截止来源',()=>{
 const rows=parseArchive(scheduled()+log(),source,collectedAt);
 assert.equal(rows.length,2);
 assert.equal(rows[0].messageId,messageId);assert.equal(rows[0].url,url);assert.equal(rows[0].publishedAt,postedAt);
 assert.deepEqual(rows[0].metadata?.scheduledReset,{expectedAt,kind:'automatic_reset',sourceUrl:source.url});
 assert.equal(rows[0].contextComplete,false);assert.equal(rows[0].textOrigin,'archive_excerpt');
 assert.match(rows[0].text,/原帖内容待核对/);assert.equal(rows[1].messageId,'2108040921044639779');
});
test('仅有安排卡片也能发现预告，无安排时保持原历史采集行为',()=>{
 assert.equal(parseArchive(scheduled(),source,collectedAt).length,1);
 const row=parseArchive(log(),source,collectedAt)[0];assert.equal(row.metadata?.scheduledReset,undefined);
 assert.throws(()=>parseArchive('<h1>空页面</h1>',source,collectedAt),SourceStructureError);
});
test('同一原帖出现在安排和公告列表中仅保存一条，保留正文与截止',()=>{
 const rows=parseArchive(scheduled()+log(messageId,'Global reset by EOD.',postedAt),source,collectedAt);
 assert.equal(rows.length,1);assert.equal(rows[0].text,'Global reset by EOD.');assert.equal(rows[0].metadata?.scheduledReset?.expectedAt,expectedAt);
});
test('原帖身份、源地址、类型和两个截止字段必须一致',()=>{
 for(const bad of [scheduled([messageId,expectedAt,'unknown',url]),scheduled([messageId,expectedAt,'regular',url.replace('thsottiaux','other')]),scheduled([messageId,expectedAt,'regular',url],'2026-10-11T08:00:00.000Z'),scheduled(undefined,expectedAt,url+'?other=1'),scheduled(['not-an-id',expectedAt,'regular',url]),scheduled([messageId,expectedAt,'regular'])]){
  assert.throws(()=>parseArchive(bad+log(),source,collectedAt),SourceStructureError);
 }
 assert.throws(()=>parseArchive(scheduled(),{...source,id:'other'},collectedAt),SourceStructureError);
 assert.throws(()=>parseArchive(scheduled(),{...source,url:'https://codex-resets.com.evil.invalid/zh-CN'},collectedAt),SourceStructureError);
});
test('无效日期、早于原帖或不合理远期安排拒绝，过了截止不改成完成',()=>{
 for(const date of ['2026-10-10T20:00:00.000Z','2026-10-13T07:00:00.000Z','2026-02-30T07:00:00.000Z','invalid']){
  assert.throws(()=>parseArchive(scheduled([messageId,date,'regular',url],date),source,collectedAt),SourceStructureError);
 }
 const expired=parseArchive(scheduled(),source,'2026-10-11T08:00:00.000Z')[0];assert.equal(expired.contextComplete,false);assert.equal(expired.metadata?.scheduledReset?.expectedAt,expectedAt);
});
test('多个安排卡片拒绝且重置卡安排不误记为用量重置',()=>{
 assert.throws(()=>parseArchive(scheduled()+scheduled(),source,collectedAt),SourceStructureError);
 assert.equal(parseArchive(scheduled([messageId,expectedAt,'banked',url]),source,collectedAt)[0].metadata?.scheduledReset?.kind,'banked_reset');
});
