'use client';

import { memo, useEffect, useRef } from 'react';

const TAU = Math.PI * 2;
const FRAME_INTERVAL = 1000 / 24;
const INITIAL_TIME = 1.4;
const SWEEP_DURATION = 6;
const SWEEP_WIDTH = Math.PI * .4;
// Fixed decorative echoes, never derived from users or the collection service.
const echoes = [[-1.05, .57], [.65, .78], [2.55, .45]] as const;
const ticks = Array.from({length: 32}, (_, index) => {
  const angle = index * TAU / 32;
  const inner = index % 4 === 0 ? 1.02 : 1.055;
  return `M${Math.cos(angle) * inner},${Math.sin(angle) * inner}L${Math.cos(angle) * 1.1},${Math.sin(angle) * 1.1}`;
}).join('');
const initialAngle = INITIAL_TIME * TAU / SWEEP_DURATION - Math.PI / 2;
const staticSector = `M0,0L${Math.cos(initialAngle - SWEEP_WIDTH)},${Math.sin(initialAngle - SWEEP_WIDTH)}A1,1 0 0,1 ${Math.cos(initialAngle)},${Math.sin(initialAngle)}Z`;

/** Local decoration only. It never reads network or subscription state. */
export const NeuralNetworkArt = memo(function NeuralNetworkArt() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const artRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const art = artRef.current;
    if (!canvas || !art) return;
    const context = canvas.getContext('2d');
    if (!context) return; // The server-rendered SVG remains visible.

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let width = 0;
    let height = 0;
    let elapsed = INITIAL_TIME;
    let lastDraw = 0;
    let animationFrame = 0;
    let inViewport = false;
    let pageVisible = true;
    let disposed = false;

    function dot(x: number, y: number, radius: number, color: string) {
      context!.beginPath();
      context!.arc(x, y, radius, 0, TAU);
      context!.fillStyle = color;
      context!.fill();
    }

    function draw() {
      if (!width || !height || disposed) return;
      const ctx = context!;
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.translate(width / 2, height / 2);
      const scale = Math.min(width, height) / 2.36;
      ctx.scale(scale, scale);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      gradient.addColorStop(0, 'rgba(255,255,255,.8)');
      gradient.addColorStop(1, 'rgba(73,137,220,.06)');
      ctx.fillStyle = gradient;
      ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
      ctx.lineWidth = .012;
      ctx.strokeStyle = 'rgba(54,91,170,.2)';
      for (const radius of [1, .66, .33]) {
        ctx.beginPath(); ctx.arc(0, 0, radius, 0, TAU); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(54,91,170,.12)';
      ctx.beginPath();
      ctx.moveTo(-1, 0); ctx.lineTo(1, 0);
      ctx.moveTo(0, -1); ctx.lineTo(0, 1); ctx.stroke();
      for (let index = 0; index < 32; index++) {
        const angle = index * TAU / 32;
        const inner = index % 4 === 0 ? 1.02 : 1.055;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
        ctx.lineTo(Math.cos(angle) * 1.1, Math.sin(angle) * 1.1);
        ctx.strokeStyle = index % 4 === 0 ? 'rgba(54,91,170,.42)' : 'rgba(54,91,170,.2)';
        ctx.stroke();
      }
      const beam = elapsed * TAU / SWEEP_DURATION - Math.PI / 2;
      for (let index = 0; index < 36; index++) {
        const start = beam - SWEEP_WIDTH + index * SWEEP_WIDTH / 36;
        ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.arc(0, 0, 1, start, start + SWEEP_WIDTH / 36 + .001);
        ctx.closePath(); ctx.fillStyle = `rgba(48,135,214,${.02 + index / 35 * .19})`; ctx.fill();
      }
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(beam), Math.sin(beam));
      ctx.lineWidth = .018; ctx.strokeStyle = 'rgba(36,88,206,.7)'; ctx.stroke();
      for (const [angle, radius] of echoes) {
        const distance = ((beam - angle) % TAU + TAU) % TAU;
        const intensity = Math.exp(-distance * 2.2);
        const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
        dot(x, y, .09, `rgba(45,153,203,${.05 + intensity * .14})`);
        dot(x, y, .032, `rgba(36,111,187,${.4 + intensity * .55})`);
      }
      dot(0, 0, .045, '#2458ce');
      dot(0, 0, .018, '#ffffff');
      ctx.restore();
      if (!art!.hasAttribute('data-ready')) art!.setAttribute('data-ready', '');
    }

    const canAnimate = () => !disposed && pageVisible && !document.hidden && inViewport && !reducedMotion.matches && width > 0 && height > 0;
    function stop() {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      lastDraw = 0;
    }
    function frame(timestamp: number) {
      animationFrame = 0;
      if (!canAnimate()) return;
      if (!lastDraw || timestamp - lastDraw >= FRAME_INTERVAL) {
        if (lastDraw) elapsed += Math.min((timestamp - lastDraw) / 1000, .1);
        lastDraw = timestamp;
        draw();
      }
      animationFrame = requestAnimationFrame(frame);
    }
    function sync() {
      stop();
      if (canAnimate()) animationFrame = requestAnimationFrame(frame);
    }
    function resize() {
      if (disposed) return;
      const bounds = canvas!.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.6);
      canvas!.width = Math.round(width * pixelRatio);
      canvas!.height = Math.round(height * pixelRatio);
      context!.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      draw();
      sync();
    }
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : undefined;
    const intersectionObserver = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
      inViewport = entries[0]?.isIntersecting ?? false;
      sync();
    }) : undefined;
    // Without viewport observation keep a static rendering rather than animate offscreen.
    resizeObserver?.observe(canvas);
    intersectionObserver?.observe(canvas);
    if (!resizeObserver) window.addEventListener('resize', resize);
    function hide() { pageVisible = false; stop(); }
    function show() { pageVisible = true; sync(); }
    document.addEventListener('visibilitychange', sync);
    reducedMotion.addEventListener('change', sync);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    resize();

    return () => {
      disposed = true;
      stop();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', sync);
      reducedMotion.removeEventListener('change', sync);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
      art.removeAttribute('data-ready');
    };
  }, []);

  return <div className="pub-neural-art" data-art="radar" ref={artRef} aria-hidden="true">
    <svg viewBox="-1.18 -1.18 2.36 2.36" focusable="false">
      <circle r="1" fill="#f0f6ff" fillOpacity=".6"/>
      {[1, .66, .33].map(radius => <circle key={radius} r={radius} fill="none" stroke="#365baa" strokeOpacity=".2" strokeWidth=".012"/>)}
      <path d="M-1 0H1M0-1V1" fill="none" stroke="#365baa" strokeOpacity=".12" strokeWidth=".012"/>
      <path d={ticks} fill="none" stroke="#365baa" strokeOpacity=".3" strokeWidth=".012"/>
      <path d={staticSector} fill="#3087d6" fillOpacity=".13"/>
      <path d={`M0,0L${Math.cos(initialAngle)},${Math.sin(initialAngle)}`} stroke="#2458ce" strokeOpacity=".7" strokeWidth=".018"/>
      {echoes.map(([angle, radius]) => <circle key={angle} cx={Math.cos(angle) * radius} cy={Math.sin(angle) * radius} r=".032" fill="#246fbb" fillOpacity=".7"/>)}
      <circle r=".045" fill="#2458ce"/><circle r=".018" fill="#fff"/>
    </svg>
    <canvas ref={canvasRef}/>
  </div>;
});
