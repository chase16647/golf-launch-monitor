// linedraw.js — draw straight reference lines on a paused video frame, with
// magnetic snapping so "roughly level" becomes "exactly level" without
// needing a steady finger.
//
// This is the classic golf-coaching overlay: a plumb line down the spine, a
// level line at ball height, a shaft-plane line at address. The entire point
// of the tool is that the lines are TRUSTWORTHY straight — a "straight line"
// feature that is actually 2° off is worse than no feature, because it looks
// authoritative while being wrong. So snapping recomputes the endpoint from
// the snapped angle and the drag length, rather than just relabelling the
// angle while leaving the pixels slightly crooked. Verified: a near-level
// drag reconstructs to a line whose measured angle is exactly 0.000000°, not
// "close to zero" (see tools/verify-snap.mjs).
//
// ── An honest caveat carried over from the pose overlay ─────────────────────
// An angle measured on screen is relative to the IMAGE FRAME, not necessarily
// to true horizontal/vertical in the real world — that depends on whether the
// camera itself was level when the video was shot. When a clip was recorded
// in-app (not imported) we know the phone's roll from the motion sensors at
// capture time and correct for it automatically; label the corrected number
// "true", not the raw one. For imported video we have no such reading, so the
// angle is labelled "on screen" and left uncorrected — inventing a
// correction with no data behind it would be worse than admitting we don't
// have one.

const PALETTE = ['#5cf285', '#38a1ff', '#ffb833', '#ff5252', '#e879f9'];

// ── Pure geometry — no canvas, no DOM, directly testable ────────────────────

/**
 * Build a line from two points, snapping the angle to the nearest 15° step
 * when close enough — with a wider catch radius (9°) specifically at
 * level/plumb (multiples of 90°), since those are the two references golf
 * analysis actually needs dead-straight, and a narrower one (5°) elsewhere
 * so a genuine 30° swing-plane line doesn't get accidentally dragged onto an
 * unrelated 15° or 45° step.
 *
 * On a snap, the endpoint is RECOMPUTED from the snapped angle and the drag
 * length — not just relabelled — so the drawn pixels are exactly straight,
 * not merely close. (Verified: a near-level drag reconstructs to a line
 * whose measured angle is exactly 0, not "close to 0".)
 */
export function snapLine(x0, y0, x1, y1, { step = 15, cardinalThreshold = 9, threshold = 5 } = {}) {
  const dx = x1 - x0, dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  const rawDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

  const norm = (a) => ((a % 360) + 360) % 360;
  const angularDistance = (a, b) => {
    const d = Math.abs(norm(a) - norm(b));
    return Math.min(d, 360 - d);
  };

  // Check the four cardinal directions FIRST, independently, with their own
  // wider catch radius — rather than rounding to the nearest 15° step and
  // only then asking whether that step happened to be cardinal.
  //
  // That ordering was a real bug caught by this file's own tests: rounding
  // to the nearest 15° step picks 15° (not 0°) for any raw angle past 7.5°,
  // which is LESS than the 9° cardinal threshold — so an 8° off-level drag
  // rounded to the 15° step, got checked against the narrow 5° threshold
  // relative to 15°, and silently failed to snap at all. The wider "easy to
  // get level/plumb" catch radius was unreachable past 7.5° in practice.
  let best = null;
  for (const cardinal of [0, 90, 180, 270]) {
    const d = angularDistance(rawDeg, cardinal);
    if (d <= cardinalThreshold && (!best || d < best.diff)) {
      best = { angle: cardinal, diff: d, isCardinal: true };
    }
  }
  // No cardinal caught it — fall through to the general 15° grid, narrower
  // threshold, for off-axis references like a shaft-plane line.
  if (!best) {
    const nearestStep = Math.round(rawDeg / step) * step;
    const d = angularDistance(rawDeg, nearestStep);
    if (d <= threshold) best = { angle: nearestStep, diff: d, isCardinal: false };
  }

  const snapped = length > 0 && best !== null;
  let ex = x1, ey = y1, angleDeg = rawDeg;
  if (snapped) {
    const rad = (best.angle * Math.PI) / 180;
    ex = x0 + length * Math.cos(rad);
    ey = y0 + length * Math.sin(rad);
    angleDeg = best.angle;
  }

  return { x0, y0, x1: ex, y1: ey, angleDeg, snapped, isCardinal: snapped && best.isCardinal };
}

/** Stretch a cardinal (level/plumb) line to the full canvas width/height. */
export function extendToEdges(line, canvasWidth, canvasHeight) {
  const isHorizontal = Math.abs(Math.sin((line.angleDeg * Math.PI) / 180)) < 0.01;
  if (isHorizontal) {
    const y = (line.y0 + line.y1) / 2;
    return { ...line, x0: 0, y0: y, x1: canvasWidth, y1: y };
  }
  const x = (line.x0 + line.x1) / 2;
  return { ...line, x0: x, y0: 0, x1: x, y1: canvasHeight };
}

/** Angle for display: report -90..90, "degrees off level", since a drawn
 *  line has no inherent direction (a 170° line and a -10° line are the same
 *  line). */
export function displayAngle(angleDeg) {
  let a = ((angleDeg % 180) + 180) % 180;
  if (a > 90) a -= 180;
  return a;
}

/**
 * @typedef {object} DrawnLine
 * @property {number} x0
 * @property {number} y0
 * @property {number} x1
 * @property {number} y1
 * @property {number} angleDeg    signed angle from horizontal, screen space
 * @property {boolean} snapped
 * @property {boolean} isCardinal true when snapped to level/plumb (0/90/180/270)
 * @property {string} color
 */

export class LineTool {
  /**
   * @param {HTMLCanvasElement} canvas  the same canvas the video frame is
   *   drawn into — pointer coordinates are read in the canvas's own pixel
   *   space, which the caller must keep in sync with the displayed frame.
   * @param {() => void} onChange  called after every add/delete/clear so the
   *   caller can redraw and refresh any line-list UI.
   */
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.onChange = onChange;
    /** @type {DrawnLine[]} */
    this.lines = [];
    this.enabled = false;
    this.colorIndex = 0;
    this._drag = null; // {x0,y0} while a drag is in progress

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);

    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerup', this._onUp);
    canvas.addEventListener('pointercancel', this._onUp);
  }

  destroy() {
    this.canvas.removeEventListener('pointerdown', this._onDown);
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerup', this._onUp);
    this.canvas.removeEventListener('pointercancel', this._onUp);
  }

  get currentColor() { return PALETTE[this.colorIndex % PALETTE.length]; }
  cycleColor() { this.colorIndex = (this.colorIndex + 1) % PALETTE.length; }

  clear() { this.lines = []; this.onChange?.(); }
  removeAt(i) { this.lines.splice(i, 1); this.onChange?.(); }
  undo() { this.lines.pop(); this.onChange?.(); }

  // ── Pointer handling ─────────────────────────────────────────────────────

  _canvasPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  _onDown(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this.canvas.setPointerCapture?.(e.pointerId);
    const p = this._canvasPoint(e);
    this._drag = { x0: p.x, y0: p.y };
    this._live = null;
  }

  _onMove(e) {
    if (!this.enabled || !this._drag) return;
    e.preventDefault();
    const p = this._canvasPoint(e);
    this._live = this._buildLine(this._drag.x0, this._drag.y0, p.x, p.y);
    this.onChange?.(); // repaint with the live preview
  }

  _onUp(e) {
    if (!this.enabled || !this._drag) return;
    const p = this._canvasPoint(e);
    const line = this._buildLine(this._drag.x0, this._drag.y0, p.x, p.y);
    this._drag = null;
    this._live = null;

    // Ignore accidental taps — a line needs a deliberate drag.
    const length = Math.hypot(line.x1 - line.x0, line.y1 - line.y0);
    if (length >= 8) {
      this.lines.push(line);
      this.cycleColor();
    }
    this.onChange?.();
  }

  /** The in-progress line, for drawing a live preview while dragging. */
  get liveLine() { return this._live; }

  // ── Geometry ─────────────────────────────────────────────────────────────

  _buildLine(x0, y0, x1, y1) {
    const line = snapLine(x0, y0, x1, y1);
    const out = { ...line, color: this.currentColor };
    // Cardinal snaps (level/plumb) extend to the canvas edges — that is how
    // a ground or plumb reference is actually used: as a full-width/height
    // guide to compare body position against, not a short drawn segment.
    return out.isCardinal ? extendToEdges(out, this.canvas.width, this.canvas.height) : out;
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  /** Draw every saved line plus the live in-progress one, if any. */
  draw(ctx) {
    for (const line of this.lines) this._drawOne(ctx, line);
    if (this._live) this._drawOne(ctx, this._live, true);
  }

  _drawOne(ctx, line, isLive = false) {
    ctx.save();
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.globalAlpha = isLive ? 0.75 : 1;
    if (isLive && !line.snapped) ctx.setLineDash([6, 5]);

    ctx.beginPath();
    ctx.moveTo(line.x0, line.y0);
    ctx.lineTo(line.x1, line.y1);
    ctx.stroke();

    // A filled dot at the snapped/near-90 catch, so snapping has a visible
    // "it just locked in" moment rather than being purely invisible.
    if (line.snapped) {
      ctx.setLineDash([]);
      ctx.fillStyle = line.color;
      const mx = (line.x0 + line.x1) / 2, my = (line.y0 + line.y1) / 2;
      ctx.beginPath();
      ctx.arc(mx, my, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

export { PALETTE as LINE_COLORS };
