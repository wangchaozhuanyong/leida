'use client';

import { memo, useEffect, useRef } from 'react';

type Point = readonly [number, number, number];
const TAU = Math.PI * 2;
const FRAME_INTERVAL = 1000 / 24;
const INITIAL_TIME = 1.4;
const sphere: Point[] = Array.from({ length: 142 }, (_, index) => {
  const y = 1 - index / 141 * 2;
  const radius = Math.sqrt(1 - y * y);
  const angle = index * 2.399963;
  return [radius * Math.cos(angle), y, radius * Math.sin(angle)];
});
const links: readonly [number, number][] = sphere.flatMap((point, index) => sphere
  .map((other, next) => ({ next, distance: point.reduce((sum, value, axis) => sum + (value - other[axis]) ** 2, 0) }))
  .filter(({ next, distance }) => next > index && distance < .16)
  .slice(0, 4).map(({ next }): [number, number] => [index, next]));

function project([x, y, z]: Point, rotation: number): Point {
  const xx = x * Math.cos(rotation) + z * Math.sin(rotation);
  const zz = -x * Math.sin(rotation) + z * Math.cos(rotation);
  const yy = y * Math.cos(.18) - zz * Math.sin(.18);
  const depth = y * Math.sin(.18) + zz * Math.cos(.18);
  const perspective = 3.6 / (3.6 - depth * .2);
  return [xx * perspective, yy * perspective, depth];
}

const initialPoints = sphere.map(point => project(point, INITIAL_TIME * .12));
const staticLinks = links.map(([a, b]) => `M${initialPoints[a][0].toFixed(3)},${initialPoints[a][1].toFixed(3)}L${initialPoints[b][0].toFixed(3)},${initialPoints[b][1].toFixed(3)}`).join('');
const staticNodes = initialPoints.map(([x, y]) => `M${(x - .012).toFixed(3)},${y.toFixed(3)}a.012,.012 0 1,0 .024,0a.012,.012 0 1,0 -.024,0`).join('');

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
      const scale = Math.min(width / 2.7, height / 2.55);
      ctx.scale(scale, scale);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1.4);
      gradient.addColorStop(0, 'rgba(72,169,198,.12)');
      gradient.addColorStop(1, 'rgba(54,91,210,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(-2, -2, 4, 4);
      const points = sphere.map(point => project(point, elapsed * .12));
      links.forEach(([a, b], index) => {
        const depth = (points[a][2] + points[b][2] + 2) / 4;
        ctx.beginPath();
        ctx.moveTo(points[a][0], points[a][1]);
        ctx.lineTo(points[b][0], points[b][1]);
        ctx.strokeStyle = `rgba(54,91,210,${.08 + depth * .34})`;
        ctx.lineWidth = .0055;
        ctx.stroke();
        if (index % 17 === 0) {
          const progress = (elapsed * .24 + index * .135) % 1;
          dot(points[a][0] * (1 - progress) + points[b][0] * progress, points[a][1] * (1 - progress) + points[b][1] * progress, .014, 'rgba(72,169,198,.8)');
        }
      });
      points.sort((a, b) => a[2] - b[2]).forEach(([x, y, z], index) => {
        dot(x, y, .009 + (z + 1) * .006, `rgba(${index % 5 ? '54,91,210' : '72,169,198'},${.2 + (z + 1) * .35})`);
      });
      ctx.strokeStyle = 'rgba(54,91,210,.12)';
      ctx.lineWidth = .004;
      ctx.beginPath();
      ctx.arc(0, 0, 1.2, 0, TAU);
      ctx.stroke();
      for (let index = 0; index < 4; index++) {
        const angle = elapsed * .09 + index * Math.PI / 2;
        dot(Math.cos(angle) * 1.2, Math.sin(angle) * 1.2, .015, '#365bd2');
      }
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

  return <div className="pub-neural-art" ref={artRef} aria-hidden="true">
    <svg viewBox="-2.7 -1.275 5.4 2.55" focusable="false"><circle r="1.2" fill="none" stroke="#365bd2" strokeOpacity=".12" strokeWidth=".004"/><path d={staticLinks} fill="none" stroke="#365bd2" strokeOpacity=".24" strokeWidth=".0055"/><path d={staticNodes} fill="#365bd2" fillOpacity=".5"/></svg>
    <canvas ref={canvasRef}/>
  </div>;
});
