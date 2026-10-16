// Decorative geometry only. It does not represent source activity or AI processing.
const TAU = Math.PI * 2;
const nodes = Array.from({ length: 142 }, (_, index) => {
  const y = 1 - index / 141 * 2;
  const radius = Math.sqrt(1 - y * y);
  const angle = index * 2.399963;
  return [radius * Math.cos(angle), y, radius * Math.sin(angle)];
});
const links = [];
nodes.forEach((point, index) => {
  let count = 0;
  for (let next = index + 1; next < nodes.length && count < 4; next++) {
    const distance = point.reduce((sum, value, axis) => sum + (value - nodes[next][axis]) ** 2, 0);
    if (distance < .16) { links.push([index, next]); count++; }
  }
});

function project(point, rotation) {
  const [x, y, z] = point;
  const xx = x * Math.cos(rotation) + z * Math.sin(rotation);
  const zz = -x * Math.sin(rotation) + z * Math.cos(rotation);
  const yy = y * Math.cos(.18) - zz * Math.sin(.18);
  const depth = y * Math.sin(.18) + zz * Math.cos(.18);
  const perspective = 3.6 / (3.6 - depth * .2);
  return [xx * perspective, yy * perspective, depth];
}

function drawNeuralArt(ctx, width, height, time = 1.4) {
  if (!ctx || !width || !height) return;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  const scale = Math.min(width / 2.7, height / 2.55);
  ctx.scale(scale, scale);
  ctx.lineCap = 'round';
  const points = nodes.map(point => project(point, time * .12));
  const dot = (x, y, radius, color) => {
    ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU);
    ctx.fillStyle = color; ctx.fill();
  };
  links.forEach(([from, to], index) => {
    const a = points[from], b = points[to];
    const depth = (a[2] + b[2] + 2) / 4;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    ctx.strokeStyle = `rgba(54,91,210,${.08 + depth * .34})`;
    ctx.lineWidth = .0055; ctx.stroke();
    if (index % 17 === 0) {
      const position = (time * .24 + index * .135) % 1;
      dot(a[0] * (1 - position) + b[0] * position, a[1] * (1 - position) + b[1] * position, .014, 'rgba(72,169,198,.8)');
    }
  });
  points.sort((a, b) => a[2] - b[2]).forEach((point, index) => {
    dot(point[0], point[1], .009 + (point[2] + 1) * .006, `rgba(${index % 5 ? '54,91,210' : '72,169,198'},${.2 + (point[2] + 1) * .35})`);
  });
  ctx.beginPath(); ctx.arc(0, 0, 1.2, 0, TAU);
  ctx.strokeStyle = 'rgba(54,91,210,.12)'; ctx.lineWidth = .004; ctx.stroke();
  for (let index = 0; index < 4; index++) {
    const angle = time * .09 + index * Math.PI / 2;
    dot(Math.cos(angle) * 1.2, Math.sin(angle) * 1.2, .015, '#365bd2');
  }
  ctx.restore();
}

module.exports = { drawNeuralArt };
