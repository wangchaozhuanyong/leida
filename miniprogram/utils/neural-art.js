// Decorative radar only. Its fixed signals are unrelated to source or account activity.
const TAU = Math.PI * 2;
const SIGNALS = [[-1.05, .57], [.65, .78], [2.55, .45]];

function drawNeuralArt(ctx, width, height, time = 1.4) {
  if (!ctx || !width || !height) return;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  const scale = Math.min(width, height) / 2.36;
  ctx.scale(scale, scale);
  ctx.lineCap = 'round';
  const dot = (x, y, radius, color) => {
    ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU);
    ctx.fillStyle = color; ctx.fill();
  };
  const line = (ax, ay, bx, by, color, size) => {
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    ctx.strokeStyle = color; ctx.lineWidth = size; ctx.stroke();
  };
  dot(0, 0, 1, 'rgba(238,246,255,.7)');
  for (const radius of [1, .66, .33]) {
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, TAU);
    ctx.strokeStyle = radius === 1 ? 'rgba(67,110,184,.38)' : 'rgba(67,110,184,.2)';
    ctx.lineWidth = .014; ctx.stroke();
  }
  line(-.94, 0, .94, 0, 'rgba(67,110,184,.16)', .012);
  line(0, -.94, 0, .94, 'rgba(67,110,184,.16)', .012);
  for (let index = 0; index < 32; index++) {
    const angle = index / 32 * TAU;
    const inner = index % 4 === 0 ? 1.025 : 1.06;
    line(Math.cos(angle) * inner, Math.sin(angle) * inner,
      Math.cos(angle) * 1.105, Math.sin(angle) * 1.105,
      index % 4 === 0 ? 'rgba(67,110,184,.52)' : 'rgba(67,110,184,.24)', .014);
  }
  const sweep = time / 6 * TAU - Math.PI / 2;
  const tail = Math.PI * .4;
  // Small translucent slices avoid an animated image or a per-frame data bridge.
  for (let index = 0; index < 36; index++) {
    const start = sweep - tail + tail * index / 36;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, .985, start, start + tail / 36 + .002); ctx.lineTo(0, 0);
    ctx.fillStyle = `rgba(61,121,215,${.015 + (index / 35) ** 1.5 * .17})`; ctx.fill();
  }
  for (const [angle, radius] of SIGNALS) {
    const age = ((sweep - angle) % TAU + TAU) % TAU;
    const glow = Math.exp(-age * 2.2);
    const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
    dot(x, y, .065 + glow * .035, `rgba(66,145,215,${.04 + glow * .15})`);
    dot(x, y, .032, `rgba(49,113,190,${.48 + glow * .45})`);
    dot(x - .006, y - .006, .01, 'rgba(255,255,255,.85)');
  }
  line(0, 0, Math.cos(sweep) * .985, Math.sin(sweep) * .985, 'rgba(44,116,209,.75)', .018);
  dot(0, 0, .055, '#ffffff');
  dot(0, 0, .025, '#3c76be');
  ctx.restore();
}

module.exports = { drawNeuralArt };
