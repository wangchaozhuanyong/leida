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

// Decorative sphere only. Content, clock values and actions belong to the unchanged page model.
const neuralGeometry=(()=>{
 const nodes=[];
 for(let i=0;i<144;i++){
  const y=1-2*(i+.5)/144,r=Math.sqrt(1-y*y),a=i*2.3999632297;
  nodes.push({id:i,x:Math.cos(a)*r,y,z:Math.sin(a)*r});
 }
 const edges=[];
 for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
  const a=nodes[i],b=nodes[j];
  if(Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<.35)edges.push([i,j]);
 }
 return {nodes,edges};
})();
function dot(ctx,x,y,r,color){ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
function drawNeuralSphere(ctx,w,h,t=1.4){if(!ctx||!w||!h)return;
 ctx.clearRect(0,0,w,h);
 const radius=Math.min(w*.405,112),cx=w/2,cy=h/2;
 const aura=ctx.createRadialGradient(cx,cy,radius*.55,cx,cy,radius*1.17);
 aura.addColorStop(0,'#dcecff00');aura.addColorStop(.62,'#c5dfff30');aura.addColorStop(1,'#dcecff00');
 ctx.fillStyle=aura;ctx.fillRect(0,0,w,h);
 const angle=t*.105,co=Math.cos(angle),si=Math.sin(angle);
 const pts=neuralGeometry.nodes.map(p=>{
  const xx=p.x*co+p.z*si,zz=-p.x*si+p.z*co;
  // Gentle fixed tilt makes the front/back relationship legible without an orbiting frame.
  const yy=p.y*.978-zz*.208,z=p.y*.208+zz*.978,k=5/(5+z);
  return {id:p.id,x:cx+xx*k*radius,y:cy+yy*k*radius,z,k};
 });
 function readableAlpha(x,y){
  const d=Math.hypot((x-cx)/(radius*.88),(y-cy)/(radius*.80));
  return Math.max(.025,Math.min(1,(d-.63)/.48));
 }
 for(const [ia,ib] of neuralGeometry.edges){
  const a=pts[ia],b=pts[ib],depth=(a.z+b.z)/2;
  const alpha=(depth>0?.04:.13)*readableAlpha((a.x+b.x)/2,(a.y+b.y)/2);
  ctx.strokeStyle=`rgba(62,121,208,${alpha})`;ctx.lineWidth=depth>0?.55:.7;
  ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
 }
 const sorted=pts.slice().sort((a,b)=>b.z-a.z);
 for(const p of sorted){
  const focus=readableAlpha(p.x,p.y),front=Math.max(0,-p.z),alpha=(.15+front*.42)*focus;
  dot(ctx,p.x,p.y,(p.z>0?.85:1.35),`rgba(55,113,206,${alpha})`);
  if(p.id%23===0&&p.z<.15&&focus>.45){
   const pulse=.5+.5*Math.sin(t*.75+p.id*.37);
   dot(ctx,p.x,p.y,3.2+pulse*1.8,`rgba(75,146,247,${(.035+pulse*.045)*focus})`);
   dot(ctx,p.x,p.y,1.7,`rgba(66,134,232,${(.45+pulse*.3)*focus})`);
  }
 }
 ctx.save();ctx.translate(cx,cy+radius+9);ctx.scale(1,.1);
 const shadow=ctx.createRadialGradient(0,0,0,0,0,radius*.62);
 shadow.addColorStop(0,'#5484ca1a');shadow.addColorStop(1,'#5484ca00');
 ctx.fillStyle=shadow;ctx.beginPath();ctx.arc(0,0,radius*.62,0,Math.PI*2);ctx.fill();ctx.restore();
}

module.exports = { drawNeuralArt, drawNeuralSphere };
