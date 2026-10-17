import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import bundle from '../src/server/data/history-backfill-20261017.json';
import {validateHistoryBundle,historicalDraft,type HistoryBundle} from '../src/server/history-backfill';
import {validateDraft} from '../src/server/domain';

const data=bundle as unknown as HistoryBundle;
const digest=(value:HistoryBundle)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('历史补录清单具有固定指纹、单一作者、有效时间和唯一消息身份',()=>{
  validateHistoryBundle(data);
  assert.ok(data.messages.length>=46);
  assert.equal(new Set(data.messages.map(row=>row.messageId)).size,data.messages.length);
  const tampered=structuredClone(data);tampered.evidence[0].text+=' changed';
  assert.throws(()=>validateHistoryBundle(tampered),/清单校验失败/);
});
test('补录不会把第三方类型、预告或不明消息改成完成声明',()=>{
  let factual=0,references=0;
  for(const message of data.messages){
    const primary=data.evidence.find(e=>e.messageId===message.messageId)!;
    const draft=historicalDraft(primary,data.evidence,message);
    assert.deepEqual(validateDraft(draft,data.evidence),[],message.messageId);
    if(message.referenceOnly){references++;assert.equal(draft.actions.length,0);assert.equal(draft.publicationMode,'news_only');assert.equal(draft.reviewStatus,'pending');}
    else {factual++;assert.deepEqual(draft.actions.map(a=>({kind:a.kind,stage:a.stage})),message.expectedActions);}
  }
  assert.ok(factual>25);assert.ok(references>0);
  const corrected=data.messages.find(m=>m.messageId==='2076735790567338203')!;
  assert.deepEqual(corrected.expectedActions,[{kind:'banked_reset',stage:'claimed_complete'}]);
  assert.equal(data.messages.some(m=>m.messageId==='2105120226027450685'),false,'无发放声明的闲聊不导入');
});
test('补录清单拒绝作者替换、未来消息、重复身份与非法范围',()=>{
  for(const mutate of [
    (v:HistoryBundle)=>{v.evidence[0].url=v.evidence[0].url.replace('thsottiaux','other');},
    (v:HistoryBundle)=>{v.messages[0].publishedAt='2100-01-01T00:00:00Z';},
    (v:HistoryBundle)=>{v.evidence.push(v.evidence[0]);},
    (v:HistoryBundle)=>{v.messages.push(v.messages[0]);},
    (v:HistoryBundle)=>{v.evidence[0].textOrigin='archive_excerpt';}
  ]){const value=structuredClone(data);mutate(value);assert.throws(()=>validateHistoryBundle(value,digest(value)));}
});
