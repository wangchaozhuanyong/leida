import test from 'node:test';
import assert from 'node:assert/strict';
import {historyPostIdentity,historyTimestamp,prepareResetHistoryCandidates,publicHistoryEvidence} from '../src/lib/reset-history-candidates';

const cutoff='2026-10-16T12:00:00Z',at='2026-10-02T21:18:48.417Z',url='https://x.com/thsottiaux/status/2106131810921136451';
const event=(changes:Record<string,unknown>={})=>({event_id:'fixture-reset',reset_type:'global',record_status:'recorded',occurred_at:'2026-10-02T00:00:00Z',source:{url},...changes});
const snapshot=(events:unknown[])=>({schema_version:1,generated_at:'2026-10-15T00:00:00Z',events});

test('第三方清单仅产生待核候选，日期精度不冒充小时精度',()=>{
 const result=prepareResetHistoryCandidates(snapshot([event()]),cutoff);
 assert.equal(result.candidates.length,1);
 const candidate=result.candidates[0];assert.equal(candidate.reviewStatus,'pending');assert.equal(candidate.trainingEligible,false);assert.equal(candidate.listedKind,'automatic_reset');
 assert.equal(candidate.sourceClaims[0].timePrecision,'date');assert.equal(candidate.originalPublishedAt,at);
});

test('同原帖URL归一去重，来源类型冲突明确保留，未知标签不猜测',()=>{
 const result=prepareResetHistoryCandidates(snapshot([event(),event({event_id:'duplicate',reset_type:'banked',source:{url:url.replace('x.com','twitter.com')}}),event({event_id:'unknown',reset_type:'unknown'})]),cutoff);
 assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].duplicateCount,2);assert.equal(result.candidates[0].typeConflict,true);assert.equal(result.candidates[0].listedKind,'unspecified');assert.equal(result.candidates[0].sourceClaims.length,3);
});

test('仿冒作者、凭据URL、查询参数、未知主机和未来记录不得进入候选',()=>{
 const invalid=['https://x.com/other/status/2106131810921136451','https://token@x.com/thsottiaux/status/2106131810921136451',url+'?token=secret','http://x.com/thsottiaux/status/2106131810921136451','https://example.com/thsottiaux/status/2106131810921136451'];
 for(const bad of invalid)assert.equal(historyPostIdentity(bad),undefined);
 const result=prepareResetHistoryCandidates(snapshot([...invalid.map((bad,index)=>event({event_id:`invalid-${index}`,source:{url:bad}})),event({event_id:'future',occurred_at:'2027-01-01T00:00:00Z'})]),cutoff);
 assert.equal(result.candidates.length,0);assert.equal(result.rejected.length,6);
 assert.ok(!JSON.stringify(result).includes('secret'));
});

test('日期、时间边界和版本严格验证',()=>{
 assert.ok(Number.isNaN(historyTimestamp('2026-02-30T00:00:00Z')));assert.ok(Number.isNaN(historyTimestamp('2026-10-02T24:00:00Z')));assert.ok(Number.isNaN(historyTimestamp('2026-10-02T12:00:00')));
 assert.throws(()=>prepareResetHistoryCandidates({schema_version:2,generated_at:cutoff,events:[]},cutoff),/结构/);
 assert.throws(()=>prepareResetHistoryCandidates(snapshot([]),'invalid'),/截止/);
 assert.throws(()=>prepareResetHistoryCandidates({...snapshot([]),generated_at:'2027-01-01T00:00:00Z'},cutoff),/晚于/);
});

test('既有回放缓存只抽取公开证据字段，不携带其他业务资料或秘密',()=>{
 const record={id:'public-1',sourceId:'tibo-public',messageId:'2106131810921136451',url,text:'We have reset usage limits for all paid Codex users.',publishedAt:at,collectedAt:'2026-10-03T00:00:00Z',contextComplete:true,provenance:'archive',textOrigin:'original',metadata:{sourceGroup:'fxembed:thsottiaux',token:'SECRET_METADATA'},token:'SECRET_ROW'};
 const result=publicHistoryEvidence({records:[record],key:'SECRET_PACKAGE'},cutoff);
 assert.equal(result.length,1);assert.equal(result[0].sourceId,'tibo-public');assert.equal(result[0].historical,true);assert.equal(result[0].metadata?.sourceGroup,'fxembed:thsottiaux');assert.ok(!JSON.stringify(result).includes('SECRET'));
 assert.equal(publicHistoryEvidence({records:{evidence:[record]}},cutoff).length,1);
 for(const changes of [{provenance:'manual'},{publishedAt:'2026-10-02T00:00:00Z'},{collectedAt:'2027-01-01T00:00:00Z'},{messageId:'wrong'},{url:url.replace('thsottiaux','other')}])assert.equal(publicHistoryEvidence({records:[{...record,...changes}]},cutoff).length,0);
});

test('旧中文归档误标original降级为摘要，原文、身份、时钟及正文均不改造',()=>{
 const row={id:'translation',sourceId:'reset-archive',messageId:'2106131810921136451',url,text:'我们已重置所有付费用户的使用限制。',publishedAt:at,collectedAt:'2026-10-03T00:00:00Z',contextComplete:true,provenance:'archive',textOrigin:'original',metadata:{sourceGroup:'codex-resets'}};
 const corrections:unknown[]=[];
 const [result]=publicHistoryEvidence({records:[row]},cutoff,correction=>corrections.push(correction));
 assert.equal(result.textOrigin,'archive_excerpt');assert.equal(result.contextComplete,false);assert.equal(result.sourceId,row.sourceId);assert.equal(result.provenance,row.provenance);assert.equal(result.text,row.text);assert.equal(result.publishedAt,row.publishedAt);assert.equal(corrections.length,1);
 for(const changes of [{sourceId:'tibo-public',metadata:{sourceGroup:'fxembed:thsottiaux'}},{text:'We have reset usage limits for all paid users.'}])assert.equal(publicHistoryEvidence({records:[{...row,...changes}]},cutoff)[0].textOrigin,'original');
 for(const textOrigin of ['structured','archive_excerpt'])assert.equal(publicHistoryEvidence({records:[{...row,textOrigin}]},cutoff)[0].textOrigin,textOrigin);
});
