import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';

// Run the real component effect with deterministic browser lifecycle signals.
// No network, database, or React renderer is needed for this decorative canvas.
function webMotion(contextAvailable = true) {
  const eventTarget = () => {
    const handlers = new Map<string, Set<() => void>>();
    return {
      addEventListener(name: string, fn: () => void) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(fn); },
      removeEventListener(name: string, fn: () => void) { handlers.get(name)?.delete(fn); },
      emit(name: string) { handlers.get(name)?.forEach(fn => fn()); },
      count() { return [...handlers.values()].reduce((sum, set) => sum + set.size, 0); },
    };
  };
  const document = { ...eventTarget(), hidden: false };
  const media = { ...eventTarget(), matches: false };
  const window = { ...eventTarget(), devicePixelRatio: 3, matchMedia: () => media };
  const frames = new Map<number, (time: number) => void>();
  let frameId = 0, draws = 0;
  const context = new Proxy({
    clearRect() { draws++; },
    createRadialGradient() { return { addColorStop() {} }; },
  } as Record<string, any>, { get(target, key: string) { return target[key] ?? (() => {}); } });
  const canvas = { width: 0, height: 0, getContext: () => contextAvailable ? context : null, getBoundingClientRect: () => ({ width: 160, height: 80 }) };
  const attributes = new Set<string>();
  const art = { hasAttribute: (key: string) => attributes.has(key), setAttribute: (key: string) => attributes.add(key), removeAttribute: (key: string) => attributes.delete(key) };
  const refs = [canvas, art];
  let effect: (() => undefined | (() => void)) | undefined;
  class Observer {
    static all: Observer[] = [];
    disconnected = false;
    constructor(public callback: (entries: any[]) => void) { Observer.all.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const module = { exports: {} as any };
  const output = ts.transpileModule(readFileSync(new URL('../src/components/public/NeuralNetworkArt.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Script(output).runInNewContext({
    module, exports: module.exports,
    require(name: string) {
      if (name === 'react') return { memo: (fn: unknown) => fn, useRef: () => ({ current: refs.shift() }), useEffect: (fn: typeof effect) => { effect = fn; } };
      if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null };
      throw new Error(`Unexpected import: ${name}`);
    },
    window, document, ResizeObserver: Observer, IntersectionObserver: Observer,
    requestAnimationFrame(fn: (time: number) => void) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  });
  module.exports.NeuralNetworkArt();
  const cleanup = effect?.();
  return { document, window, media, canvas, frames, attributes, observers: Observer.all, cleanup,
    get draws() { return draws; },
    intersect(visible: boolean) { Observer.all[1].callback([{ isIntersecting: visible }]); },
    tick(time: number) { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(time)); },
  };
}

test('neural decoration draws at bounded cadence and pauses outside the viewport or in the background', () => {
  const h = webMotion();
  assert.equal(h.frames.size, 0, 'initially unobserved content must stay static');
  assert.equal(h.canvas.width, 256, 'pixel density is capped on high resolution phones');
  h.intersect(true);
  assert.equal(h.frames.size, 1);
  const initial = h.draws;
  h.tick(16); h.tick(32); h.tick(48);
  assert.equal(h.draws, initial + 1);
  h.tick(64); assert.equal(h.draws, initial + 2);
  h.document.hidden = true; h.document.emit('visibilitychange');
  assert.equal(h.frames.size, 0);
  h.document.hidden = false; h.document.emit('visibilitychange');
  assert.equal(h.frames.size, 1);
  h.intersect(false); assert.equal(h.frames.size, 0);
  h.cleanup?.();
});

test('reduced motion and page lifecycle stop work; unmount removes observers, callbacks and listeners', () => {
  const h = webMotion(); h.intersect(true);
  h.media.matches = true; h.media.emit('change');
  assert.equal(h.frames.size, 0); assert.equal(h.attributes.has('data-ready'), true, 'static frame remains');
  h.media.matches = false; h.media.emit('change'); assert.equal(h.frames.size, 1);
  h.window.emit('pagehide'); assert.equal(h.frames.size, 0);
  h.window.emit('pageshow'); assert.equal(h.frames.size, 1);
  h.cleanup?.();
  assert.equal(h.frames.size, 0);
  assert.equal(h.document.count() + h.window.count() + h.media.count(), 0);
  assert.ok(h.observers.every(observer => observer.disconnected));
  const before = h.draws;
  h.observers[0].callback([]); h.intersect(true); h.tick(1000);
  assert.equal(h.frames.size, 0); assert.equal(h.draws, before, 'late observer callbacks cannot restart a detached canvas');
});

test('missing Canvas support leaves the static fallback without starting any animation work', () => {
  const h = webMotion(false);
  assert.equal(h.draws, 0); assert.equal(h.frames.size, 0); assert.equal(h.observers.length, 0);
  assert.equal(h.attributes.has('data-ready'), false);
});
