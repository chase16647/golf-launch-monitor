// charts.js — canvas drawing. No chart library: these are four bespoke plots
// and a dependency would cost more than it saves.

const DPR = () => Math.min(window.devicePixelRatio || 1, 3);

function setup(canvas, cssHeight) {
  const dpr = DPR();
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 320;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.height = cssHeight + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, cssHeight);
  return { ctx, w, h: cssHeight };
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function shapeColor(shape) {
  switch (shape) {
    case 'draw': case 'pullDraw': case 'pushDraw': return '#5cc8ff';
    case 'hook': return '#6b85ff';
    case 'fade': case 'pullFade': case 'pushFade': return '#ffc75c';
    case 'slice': return '#ff7a52';
    default: return css('--primary') || '#5cf285';
  }
}

/** Side-on flight profile with apex marker. */
export function drawSideProfile(canvas, result) {
  const { ctx, w, h } = setup(canvas, 180);
  const pts = result.trajectory;
  if (!pts || pts.length < 2) return;

  const maxX = Math.max(...pts.map((p) => p.x), 1);
  const maxY = Math.max(...pts.map((p) => p.y), 1);
  const padL = 10, padR = 10, padB = 20, padT = 16;

  const px = (p) => padL + (p.x / maxX) * (w - padL - padR);
  const py = (p) => h - padB - (p.y / maxY) * (h - padB - padT);

  // Ground.
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - padB);
  ctx.lineTo(w, h - padB);
  ctx.stroke();

  // Fill under the curve.
  const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
  grad.addColorStop(0, 'rgba(92,242,133,0.25)');
  grad.addColorStop(1, 'rgba(92,242,133,0)');
  ctx.beginPath();
  ctx.moveTo(px(pts[0]), h - padB);
  pts.forEach((p) => ctx.lineTo(px(p), py(p)));
  ctx.lineTo(px(pts[pts.length - 1]), h - padB);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Flight line.
  ctx.beginPath();
  ctx.moveTo(px(pts[0]), py(pts[0]));
  pts.forEach((p) => ctx.lineTo(px(p), py(p)));
  ctx.strokeStyle = css('--primary') || '#5cf285';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Apex.
  const apex = pts.reduce((a, b) => (b.y > a.y ? b : a));
  ctx.beginPath();
  ctx.arc(px(apex), py(apex), 3.5, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();

  ctx.font = '600 11px -apple-system, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.textAlign = 'center';
  ctx.fillText(`${Math.round(result.apexFeet)} ft`, px(apex), py(apex) - 9);

  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(result.carryYards)} yd carry`, w - padR, h - 6);
}

/** Top-down view showing the curve off the target line. */
export function drawTopDown(canvas, result, shape) {
  const { ctx, w, h } = setup(canvas, 180);
  const pts = result.trajectory;
  if (!pts || pts.length < 2) return;

  const maxX = Math.max(...pts.map((p) => p.x), 1);
  const maxZ = Math.max(...pts.map((p) => Math.abs(p.z)), 6);
  const padB = 14, padT = 14;

  const px = (p) => w / 2 + (p.z / maxZ) * (w / 2 - 26);
  const py = (p) => h - padB - (p.x / maxX) * (h - padB - padT);

  // Target line.
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w / 2, h - padB);
  ctx.lineTo(w / 2, padT);
  ctx.stroke();
  ctx.setLineDash([]);

  const color = shapeColor(shape);
  ctx.beginPath();
  ctx.moveTo(px(pts[0]), py(pts[0]));
  pts.forEach((p) => ctx.lineTo(px(p), py(p)));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  const last = pts[pts.length - 1];
  ctx.beginPath();
  ctx.arc(px(last), py(last), 4.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.font = '600 11px -apple-system, system-ui, sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  const sign = result.curveYards >= 0 ? '+' : '';
  ctx.fillText(`${sign}${result.curveYards.toFixed(0)} yd`, px(last), py(last) - 10);
}

/** Landing pattern with a one-sigma ellipse. */
export function drawDispersion(canvas, shots) {
  const { ctx, w, h } = setup(canvas, 240);
  if (!shots.length) {
    ctx.font = '500 13px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = css('--text-3') || '#66666b';
    ctx.textAlign = 'center';
    ctx.fillText('No shots yet', w / 2, h / 2);
    return;
  }

  const maxD = Math.max(...shots.map((s) => s.carryYards), 50);
  const maxS = Math.max(...shots.map((s) => Math.abs(s.sideYards)), 20);
  const padB = 16, padT = 14;

  const px = (side) => w / 2 + (side / maxS) * (w / 2 - 24);
  const py = (carry) => h - padB - (carry / maxD) * (h - padB - padT);

  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath();
  ctx.moveTo(w / 2, h - padB);
  ctx.lineTo(w / 2, padT);
  ctx.stroke();
  ctx.setLineDash([]);

  // One-sigma ellipse first, so dots sit on top.
  if (shots.length > 2) {
    const carries = shots.map((s) => s.carryYards);
    const sides = shots.map((s) => s.sideYards);
    const mc = carries.reduce((a, b) => a + b, 0) / carries.length;
    const ms = sides.reduce((a, b) => a + b, 0) / sides.length;
    const sc = Math.sqrt(carries.reduce((a, v) => a + (v - mc) ** 2, 0) / (carries.length - 1));
    const ss = Math.sqrt(sides.reduce((a, v) => a + (v - ms) ** 2, 0) / (sides.length - 1));

    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(
      px(ms), py(mc),
      Math.abs(px(ms + ss) - px(ms)),
      Math.abs(py(mc) - py(mc + sc)),
      0, 0, Math.PI * 2
    );
    ctx.stroke();
    ctx.restore();
  }

  shots.forEach((s) => {
    ctx.beginPath();
    ctx.arc(px(s.sideYards), py(s.carryYards), 4, 0, Math.PI * 2);
    ctx.fillStyle = shapeColor(s.shape);
    ctx.fill();
  });
}

/** Small top-down curve sketch for the result card. */
export function drawCurveSketch(canvas, curveYards, azimuthDeg, shape) {
  const { ctx, w, h } = setup(canvas, 84);
  const bottomX = w / 2;
  const bottomY = h - 5;
  const scale = (w / 2 - 14) / 45; // a 45 yd slice fills the width
  const drift = azimuthDeg * 1.2 * scale;
  const endX = bottomX + drift + curveYards * scale;

  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(bottomX, bottomY);
  ctx.lineTo(bottomX, 5);
  ctx.stroke();
  ctx.setLineDash([]);

  const color = shapeColor(shape);
  ctx.beginPath();
  ctx.moveTo(bottomX, bottomY);
  ctx.quadraticCurveTo(bottomX + drift, h * 0.3, endX, 7);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(endX, 7, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}
