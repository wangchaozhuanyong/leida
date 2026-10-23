import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {openPublicDialog} from '../src/components/public/dialog-lifecycle';

function browser(t: TestContext) {
  const previous = {document:globalThis.document, location:globalThis.location, HTMLElement:globalThis.HTMLElement};
  const dialogs: ElementFixture[] = [];
  class ElementFixture {
    isConnected = true;
    open = false;
    style = {overflow: ''};
    children: ElementFixture[] = [];
    focusCalls = 0;
    focus() { this.focusCalls++; doc.activeElement = this; }
    contains(element: unknown): boolean { return element === this || this.children.some(child => child.contains(element)); }
    showModal() { this.open = true; this.children[0]?.focus(); }
    remove() { this.isConnected = false; this.open = false; if (this.contains(doc.activeElement)) doc.activeElement = doc.body; }
  }
  const doc = {body:new ElementFixture(), documentElement:new ElementFixture(), activeElement:null as ElementFixture|null,
    querySelectorAll:() => dialogs.filter(dialog => dialog.isConnected && dialog.open)};
  const location = {href:'https://example.test/events/1?version=fixed'};
  Object.assign(globalThis, {document:doc, location, HTMLElement:ElementFixture});
  t.after(() => Object.assign(globalThis, previous));
  const opener = new ElementFixture(); opener.focus();
  function modal() { const element = new ElementFixture(); element.children.push(new ElementFixture()); dialogs.push(element); return element; }
  return {doc, location, opener, modal, ElementFixture, open:(element: ElementFixture) => openPublicDialog(element as unknown as HTMLDialogElement)};
}

test('关闭并卸载后恢复打开者，不改变滚动位置', async t => {
  const f=browser(t), dialog=f.modal(); f.doc.body.style.overflow='auto';
  const dispose=f.open(dialog); assert.equal(f.doc.body.style.overflow,'hidden');
  dialog.remove(); dispose(); await Promise.resolve();
  assert.equal(f.doc.activeElement,f.opener); assert.equal(f.doc.body.style.overflow,'auto');
});
test('原按钮已移除、路由改变或其他控件已经获得焦点时不抢焦点', async t => {
  const f=browser(t);
  for(const reason of ['removed','navigation','focused']) {
    f.opener.isConnected=true; f.opener.focus(); f.location.href='https://example.test/start';
    const dialog=f.modal(),dispose=f.open(dialog);dialog.remove();
    if(reason==='removed')f.opener.isConnected=false;
    if(reason==='navigation')f.location.href='https://example.test/next';
    if(reason==='focused')new f.ElementFixture().focus();
    const expected=f.doc.activeElement;dispose();await Promise.resolve();assert.equal(f.doc.activeElement,expected);
  }
});
test('分享弹窗接续不会被旧海报抢焦点，最后关闭才解除滚动锁', async t => {
  const f=browser(t),poster=f.modal(),closePoster=f.open(poster),share=f.modal(),closeShare=f.open(share);
  poster.remove();closePoster();await Promise.resolve();
  assert.equal(f.doc.activeElement,share.children[0]);assert.equal(f.doc.body.style.overflow,'hidden');
  share.remove();closeShare();await Promise.resolve();assert.equal(f.doc.body.style.overflow,'');
});
test('分享窗口关闭后可回到仍打开的海报内部按钮', async t => {
  const f=browser(t),poster=f.modal(),closePoster=f.open(poster),share=f.modal(),closeShare=f.open(share);
  share.remove();closeShare();await Promise.resolve();assert.equal(f.doc.activeElement,poster.children[0]);
  poster.remove();closePoster();await Promise.resolve();assert.equal(f.doc.activeElement,f.opener);
});
test('严格模式重复 effect 不丢失原始打开者，也不重复释放滚动锁', async t => {
  const f=browser(t),dialog=f.modal(),first=f.open(dialog);first();
  const second=f.open(dialog);await Promise.resolve();assert.equal(f.doc.activeElement,dialog.children[0]);
  dialog.remove();second();second();await Promise.resolve();assert.equal(f.doc.activeElement,f.opener);assert.equal(f.doc.body.style.overflow,'');
});
