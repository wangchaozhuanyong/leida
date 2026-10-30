import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {Evidence} from '../src/lib/types';
import {buildAutomaticTemplate,evidenceFingerprint,originalProductSummary} from '../src/server/automatic-content';
import {validateDraft} from '../src/server/domain';
const original:Evidence=JSON.parse(readFileSync(new URL('./fixtures/original-usage-limits-product.json',import.meta.url),'utf8'));

test('真实限额消息无需AI或中文归档即可生成完整、可校验的产品动态',()=>{
  const content=buildAutomaticTemplate([original]);assert.ok(content);
  assert.equal(content.publicationMode,'news_only');assert.deepEqual(content.actions,[]);
  assert.equal(content.title,'Codex 使用限额调整');
  assert.match(content.summary,/Pro 100\/200\/500/);assert.match(content.summary,/Business Premium/);
  assert.match(content.summary,/Pro 200 不执行原定降低/);assert.match(content.summary,/dot 用量继续独立/);
  assert.doesNotMatch(content.summary,/Plus|50%|全部付费|已经重置|已重置/);
  assert.equal(content.translation,original.text);assert.deepEqual(validateDraft(content,[original],true),[]);
  assert.match(evidenceFingerprint([original]),/-original-product-1:/);
});
test('只给完整可信原文提供兜底，不采纳副本标签、缺失父帖或人工记录',()=>{
  for(const change of [
    {provenance:'manual'}, {sourceId:'activity-archive'}, {textOrigin:'archive_excerpt'},
    {metadata:{...original.metadata,sourceGroup:'untrusted'}}, {metadata:{...original.metadata,category:'reset'}},
    {url:'https://x.com/another/status/'+original.messageId},
    {text:'As mentioned above, Codex now supports it.',parentId:'missing',contextComplete:false},
    {text:original.text+'...'}, {text:original.text+'x'.repeat(12001)},
  ]){
    const item={...original,...change} as Evidence;assert.equal(originalProductSummary(item,[item]),undefined,JSON.stringify(change).slice(0,100));
  }
});
test('真实重置声明、传言和明确更正不经过产品兜底路径',()=>{
  for(const text of [
    'Codex usage limits have been reset for all paid users. We have also shipped improvements.',
    'Maybe Codex will support doubled usage limits.',
    'Correction: Codex usage limits have changed instead.',
    'Codex now has improvements. Banked resets are rolling out.',
  ]){const item={...original,text};assert.equal(originalProductSummary(item,[item]),undefined);}
});
test('未知英文产品内容仍走原有核对路径，不冒充已翻译内容',()=>{
  const item={...original,text:'We have shipped faster Codex code search. It supports larger repositories.'};
  assert.equal(buildAutomaticTemplate([item]),undefined);
});
