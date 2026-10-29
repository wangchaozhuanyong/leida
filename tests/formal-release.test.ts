import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyFormalRelease,type FormalReceipts} from '../scripts/verify-formal-release';
const now=Date.parse('2026-10-29T09:00:00Z');
const target={version:'1.0.69',sourceDigest:'a'.repeat(64),main:'b'.repeat(40),appId:'wx11eb1eaa9b83fa2b'};
function evidence():FormalReceipts{return {
  server:{version:target.version,sourceDigest:target.sourceDigest,main:target.main,checkedAt:'2026-10-29T08:00:00Z'},
  wechat:{appId:target.appId,envVersion:'release',qrEnabled:true,subscriptionsEnabled:true,checkedAt:'2026-10-29T08:00:00Z'},
  platform:{appId:target.appId,onlineVersion:target.version,checkedAt:'2026-10-29T08:01:00Z'},
  phone:{appId:target.appId,version:target.version,envVersion:'release',qr:true,share:true,reminder:true,customerService:true,checkedAt:'2026-10-29T08:05:00Z'},
};}
// Only synthetic safe receipts: no live credentials, phone sends or publication.
const valid=evidence;
test('正式核验需要确定部署、release渠道、平台线上包与之后的真机回执全部一致',()=>{
  assert.equal(verifyFormalRelease(target,valid(),now).status,'passed');
});
test('trial即使二维码和提醒都可用也不能通过正式发布核验',()=>{
  const data=valid();data.wechat!.envVersion='trial';const result=verifyFormalRelease(target,data,now);
  assert.equal(result.status,'failed');assert.equal(result.checks.find(c=>c.id==='wechat')?.status,'failed');
});
test('旧正式包、错提交或源码指纹、错误AppID都拒绝通过',()=>{
  for(const mutate of [(d:FormalReceipts)=>{d.platform!.onlineVersion='1.0.60';},(d:FormalReceipts)=>{d.server!.main='c'.repeat(40);},(d:FormalReceipts)=>{d.server!.sourceDigest='d'.repeat(64);},(d:FormalReceipts)=>{d.wechat!.appId='wx0000000000000000';},(d:FormalReceipts)=>{d.phone!.envVersion='trial';}]){
    const data=valid();mutate(data);assert.equal(verifyFormalRelease(target,data,now).status,'failed');
  }
});
test('缺少平台或真实手机回执、未验证提醒不冒充正式完成',()=>{
  for(const mutate of [(d:FormalReceipts)=>{delete d.platform;},(d:FormalReceipts)=>{delete d.phone;},(d:FormalReceipts)=>{d.phone!.reminder=false;}]){
    const data=valid();mutate(data);assert.equal(verifyFormalRelease(target,data,now).status,'pending');
  }
  assert.equal(verifyFormalRelease(target,{},now).status,'pending');
});
test('旧回执、未来时间和渠道切换前手机回执保持待验收',()=>{
  for(const checkedAt of ['2026-10-28T09:00:00Z','2026-10-29T09:00:01Z','2026-10-29T07:59:00Z']){
    const data=valid();data.phone!.checkedAt=checkedAt;assert.equal(verifyFormalRelease(target,data,now).status,'pending');
  }
});
test('拒绝availability代替安全回执，未知或敏感字段不输出报告',()=>{
  for(const input of [{available:true,codeAvailable:true},{...valid(),token:'never-echo-this-value'},{...valid(),wechat:{...valid().wechat,secret:'never-echo-this-value'}}]){
    const report=verifyFormalRelease(target,input,now);assert.equal(report.status,'failed');assert.ok(!JSON.stringify(report).includes('never-echo-this-value'));
  }
});
