import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
const component = new URL('../miniprogram/components/neural-orb/index.js', import.meta.url);
let definition: any;
new Script(readFileSync(component, 'utf8')).runInNewContext({
  Component(value: any) { definition = value; },
  wx: { getWindowInfo: () => ({pixelRatio: 3}) },
  require: createRequire(component),
});

function fixture(options: {offscreen?: boolean; noCanvas?: boolean; static?: boolean; lateQuery?: boolean; sphere?: boolean; active?: boolean; width?: number; height?: number} = {}) {
  let frameId = 0;
  const frames = new Map<number, (time: number) => void>();
  const calls = { draws: 0, patches: [] as Record<string, unknown>[], disconnected: 0, scales: [] as number[][], cancelled: 0 };
  const ctx = { clearRect() { calls.draws++; }, save() {}, restore() {}, translate() {}, scale(...args: number[]) { calls.scales.push(args); }, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {}, fillRect() {}, createRadialGradient(){return {addColorStop(){}};} };
  const canvas = { width: 300, height: 150, getContext: () => ctx, requestAnimationFrame(callback: (time: number) => void) { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame(id: number) { calls.cancelled++; frames.delete(id); } };
  const instance: any = { data: { ready: false }, properties:{variant:options.sphere?'sphere':'radar',active:options.active!==false}, ...definition.methods };
  instance.setData = (patch: Record<string, unknown>) => { Object.assign(instance.data, patch); calls.patches.push(patch); };
  let intersection: (entry: {intersectionRatio: number}) => void;
  instance.createIntersectionObserver = () => ({ relativeToViewport() { return this; }, observe(selector: string, callback: typeof intersection) { intersection = callback; callback({ intersectionRatio: options.offscreen ? 0 : 1 }); }, disconnect() { calls.disconnected++; } });
  const queries: Array<() => void> = [];
  instance.createSelectorQuery = () => ({ select() { return this; }, fields() { return this; }, boundingClientRect() { return this; }, exec(callback: (result: any[]) => void) {
    const result = [{ node: options.noCanvas ? null : canvas, width: options.width||160, height: options.height||80 }, { width: options.static ? 0 : 1 }];
    if (options.lateQuery) queries.push(() => callback(result)); else callback(result);
  } });
  definition.lifetimes.attached.call(instance);
  definition.lifetimes.ready.call(instance);
  return { instance, calls, canvas, frames, queries,
    show: () => definition.pageLifetimes.show.call(instance),
    hide: () => definition.pageLifetimes.hide.call(instance),
    detach: () => definition.lifetimes.detached.call(instance),
    visible: (value: boolean) => intersection({ intersectionRatio: value ? 1 : 0 }),
    tick(time: number) { const entries = [...frames]; frames.clear(); entries.forEach(([, callback]) => callback(time)); }
  };
}

const check = test;
check('Frames stay within 24 fps, cap DPR, and do not submit per-frame setData', () => {
  const f = fixture();
  assert.equal(f.canvas.width, 256); assert.equal(f.canvas.height, 128);
  assert.deepEqual(f.calls.scales[0], [1.6, 1.6]);
  const start = f.calls.draws;
  for (let step = 0; step <= 60; step++) f.tick(step * 1000 / 60);
  assert.ok(f.calls.draws - start <= 25);
  assert.ok(f.calls.draws - start >= 19);
  assert.equal(f.calls.patches.length, 1);
  f.detach();
});
check('Page hide cancels RAF; show resumes without another data patch', () => {
  const f = fixture(); f.tick(50); f.hide();
  assert.equal(f.frames.size, 0);
  const stopped = f.calls.draws; f.tick(100); assert.equal(f.calls.draws, stopped);
  f.show(); assert.equal(f.frames.size, 1); assert.equal(f.calls.patches.length, 1);
  f.detach();
});
check('An old queued RAF cannot create a second loop after a hide/show cycle', () => {
  const f = fixture(); const oldFrame = [...f.frames.values()][0]!;
  f.hide(); f.show(); const currentFrame = f.instance._frame;
  const draws = f.calls.draws; oldFrame(100);
  assert.equal(f.frames.size, 1); assert.equal(f.instance._frame, currentFrame);
  assert.equal(f.calls.draws, draws); f.detach();
});
check('Offscreen artwork is static and resumes only in viewport', () => {
  const f = fixture({ offscreen: true }); assert.equal(f.frames.size, 0);
  f.visible(true); assert.equal(f.frames.size, 1);
  f.visible(false); assert.equal(f.frames.size, 0); f.detach();
});
check('Reduced-motion or unsupported media-query preference remains static', () => {
  const f = fixture({ static: true }); assert.equal(f.frames.size, 0);
  assert.equal(f.calls.draws, 1); f.hide(); f.show(); assert.equal(f.frames.size, 0); f.detach();
});
check('Missing Canvas node retains fallback without failure or data churn', () => {
  const f = fixture({ noCanvas: true }); assert.equal(f.frames.size, 0);
  assert.equal(f.instance.data.ready, false); assert.equal(f.calls.patches.length, 0); f.detach();
});
check('Canvas error returns to static fallback and prevents restart', () => {
  const f = fixture(); f.instance.onCanvasError(); assert.equal(f.frames.size, 0);
  assert.equal(f.instance.data.ready, false); f.show(); assert.equal(f.frames.size, 0); f.detach();
});
check('Detach disconnects observers and ignores already queued callback', () => {
  const f = fixture(); const callback = [...f.frames.values()][0]!; f.detach();
  const draws = f.calls.draws; callback(100);
  assert.equal(f.frames.size, 0); assert.equal(f.calls.draws, draws);
  assert.equal(f.calls.disconnected, 1); assert.equal(f.instance._canvas, null);
});
check('A late selector response after detach cannot draw or setData', () => {
  const f = fixture({ lateQuery: true }); f.detach(); f.queries.forEach(run => run());
  assert.equal(f.calls.draws, 0); assert.equal(f.calls.patches.length, 0); assert.equal(f.frames.size, 0);
});
check('A late ready callback after detach does not recreate observers', () => {
  const f = fixture(); f.detach(); definition.lifetimes.ready.call(f.instance);
  assert.equal(f.calls.disconnected, 1); assert.equal(f.frames.size, 0);
});


check('Home sphere measures the full stage, caps DPR and retains one 24fps loop',()=>{
  const f=fixture({sphere:true,width:358,height:288});
  assert.equal(f.canvas.width,Math.round(358*1.6));assert.equal(f.canvas.height,Math.round(288*1.6));
  const before=f.calls.draws;for(let step=0;step<=60;step++)f.tick(step*1000/60);
  assert.ok(f.calls.draws-before>=19&&f.calls.draws-before<=25);assert.equal(f.calls.patches.length,1);
  f.hide();assert.equal(f.frames.size,0);f.show();assert.equal(f.frames.size,1);f.detach();assert.equal(f.frames.size,0);
});
check('Home sphere active flag cancels motion and stale queued frames cannot resume it',()=>{
  const f=fixture({sphere:true,width:320,height:224});const queued=[...f.frames.values()][0]!;
  f.instance.properties.active=false;definition.properties.active.observer.call(f.instance);
  assert.equal(f.frames.size,0);const before=f.calls.draws;queued(100);assert.equal(f.calls.draws,before);assert.equal(f.frames.size,0);
  f.instance.properties.active=true;definition.properties.active.observer.call(f.instance);assert.equal(f.frames.size,1);f.detach();
});
check('Home sphere reduced motion and missing canvas keep readable native content and static decoration',()=>{
  for(const options of [{static:true},{noCanvas:true},{active:false}]){
    const f=fixture({sphere:true,width:290,height:224,...options});assert.equal(f.frames.size,0);f.hide();f.show();assert.equal(f.frames.size,0);f.detach();
  }
});
check('Sphere drawing is deterministic, finite at narrow widths and changes continuously with time',()=>{
  const require=createRequire(component),{drawNeuralSphere}=require('../../utils/neural-art.js');
  function render(t:number,width=288){
    const points:number[][]=[];let arcs=0,lines=0;
    const record=(...args:number[])=>{assert.ok(args.every(Number.isFinite));points.push(args);};
    const ctx={clearRect:record,save(){},restore(){},translate:record,scale:record,createRadialGradient(...args:number[]){record(...args);return{addColorStop(){}};},fillRect:record,beginPath(){},arc(...args:number[]){arcs++;record(...args);},fill(){},moveTo:record,lineTo(...args:number[]){lines++;record(...args);},stroke(){}};
    drawNeuralSphere(ctx,width,224,t);return{points,arcs,lines};
  }
  const first=render(1.4);assert.ok(first.arcs>=145);assert.ok(first.lines>144);assert.deepEqual(first,render(1.4));assert.notDeepEqual(first.points,render(1.45).points);
  for(const width of [250,288,358,448])assert.ok(render(1.4,width).arcs>=145);
});
