import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordChangeError, passwordChangeValidation } from '../src/lib/account-maintenance';

test('修改密码在调用前拒绝缺当前密码、长度越界和不一致输入',()=>{
  assert.ok(passwordChangeValidation('', 'x'.repeat(12), 'x'.repeat(12)));
  assert.ok(passwordChangeValidation('old', 'x'.repeat(11), 'x'.repeat(11)));
  assert.ok(passwordChangeValidation('old', 'x'.repeat(129), 'x'.repeat(129)));
  assert.ok(passwordChangeValidation('old', 'x'.repeat(12), 'y'.repeat(12)));
  assert.ok(passwordChangeValidation('x'.repeat(12), 'x'.repeat(12), 'x'.repeat(12)));
  assert.equal(passwordChangeValidation('old', 'x'.repeat(12), 'x'.repeat(12)), '');
  assert.equal(passwordChangeValidation('old', 'x'.repeat(128), 'x'.repeat(128)), '');
});

test('失效会话、错误当前密码和限流分别显示安全中文，不回显未知错误',()=>{
  assert.match(passwordChangeError(401), /重新登录/);
  assert.match(passwordChangeError(400,'INVALID_PASSWORD'), /当前密码不正确/);
  assert.match(passwordChangeError(429), /稍后/);
  assert.match(passwordChangeError(403), /刷新/);
  assert.equal(passwordChangeError(400,'raw-sensitive-response'), '密码未能修改，请检查输入或稍后重试。');
  assert.match(passwordChangeError(500), /未能确认修改结果/);
});
