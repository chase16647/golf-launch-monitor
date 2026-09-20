// level.js — the live alignment visual.
//
// One glance has to answer "am I good?", so the design is a single ring that
// closes and turns green, like a camera focus confirm. Numbers are secondary,
// underneath, for when the answer is no.

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function setup(canvas, cssHeight) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 320;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.height = cssHeight + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, cssHeight);
  return { ctx, w, h: cssHeight };
}

const STATUS_COLOR = {
  ok: () => css('--primary') || '#5cf285',
  warn: () => css('--warning') || '#ffb833',
  blocked: () => css('--danger') || '#ff5252',
};

/**
 * Artificial-horizon style level.
 *
 * Roll rotates the horizon line. Pitch slides it up and down. That mapping is
 * the one pilots and photographers already know, so it needs no explaining —
 * and unlike a bubble it shows both axes at once without ambiguity.
 *
 * @param state {{rollDeg, pitchDeg, yawDeg|null, status}}
 */
export function drawLevel(canvas, state) {
  const { ctx, w, h } = setup(canvas, 210);
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 14;

  const color = STATUS_COLOR[state.status]?.() || '#9e9ea3';

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();

  // Background disc.
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(0, 0, w, h);

  // Horizon: rotate by roll, offset by pitch.
  // 3 px per degree keeps a 20 deg lean visible without leaving the disc.
  const pitchPx = Math.max(-R, Math.min(R, (state.pitchDeg || 0) * 3));
  ctx.translate(cx, cy);
  ctx.rotate((-(state.rollDeg || 0) * Math.PI) / 180);
  ctx.translate(0, pitchPx);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-R * 1.6, 0);
  ctx.lineTo(R * 1.6, 0);
  ctx.stroke();

  // Ladder marks every 5 degrees so drift is visible, not just extremes.
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1;
  for (let d = -30; d <= 30; d += 5) {
    if (d === 0) continue;
    const y = d * 3;
    const len = d % 10 === 0 ? 22 : 12;
    ctx.beginPath();
    ctx.moveTo(-len, y);
    ctx.lineTo(len, y);
    ctx.stroke();
  }
  ctx.restore();

  // Fixed reticle: the target the horizon must line up with.
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 30, cy);
  ctx.lineTo(cx - 10, cy);
  ctx.moveTo(cx + 10, cy);
  ctx.lineTo(cx + 30, cy);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fill();

  // Outer ring, thickening as things come good.
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = state.status === 'ok' ? 3.5 : 1.5;
  ctx.globalAlpha = state.status === 'ok' ? 1 : 0.55;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Squareness arc outside the ring — only when we actually know it.
  if (state.yawDeg != null) {
    const yaw = Math.max(-45, Math.min(45, state.yawDeg));
    const start = -Math.PI / 2;
    const sweep = (yaw * Math.PI) / 180;
    ctx.beginPath();
    ctx.arc(cx, cy, R + 8, start, start + sweep, sweep < 0);
    ctx.strokeStyle = Math.abs(yaw) < 5 ? STATUS_COLOR.ok() : STATUS_COLOR.warn();
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}

/**
 * Distance guide: a ring at the size the ball should appear, so you can walk
 * the phone in or out until the real ball fills it.
 *
 * This works because a golf ball is 42.67 mm by rule — its apparent size IS a
 * distance measurement, with no LiDAR and no tape measure.
 */
export function drawDistanceRing(canvas, { targetPx, actualPx, status }) {
  const { ctx, w, h } = setup(canvas, 150);
  const cx = w / 2;
  const cy = h / 2;

  // Scale so the target ring is a comfortable size on screen regardless of
  // the real pixel figure.
  const displayR = 42;
  const scale = displayR / Math.max(targetPx / 2, 1);

  // Target ring.
  ctx.beginPath();
  ctx.arc(cx, cy, displayR, 0, Math.PI * 2);
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);

  if (actualPx > 0) {
    const r = Math.max(3, Math.min((actualPx / 2) * scale, displayR * 2.4));
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = (STATUS_COLOR[status]?.() || '#9e9ea3') + '44';
    ctx.fill();
    ctx.strokeStyle = STATUS_COLOR[status]?.() || '#9e9ea3';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.font = '600 11px -apple-system, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.textAlign = 'center';
  ctx.fillText('ball should fill the dashed ring', cx, h - 8);
}
