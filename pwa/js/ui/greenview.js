// greenview.js — the Green tab: lay the phone flat on the green, read the
// real slope, get told where to aim and how hard to hit it.
//
// Chase's note driving the UX here: "people won't want directions every
// time" — so the how-to-use-it explanation is collapsed automatically after
// the first visit (a stored flag), and the tool itself is always immediately
// usable without stepping through it. See js/putting/greenread.js for the
// physics and the honesty about what this is and isn't.

import {
  GREEN_SPEEDS, readGreen, slopeAccelFromGravity, slopePercent,
} from '../putting/greenread.js';

const q = (root, sel) => root.querySelector(sel);
const SEEN_KEY = 'launchmonitor.green.seenIntro';
const FLIP_KEY = 'launchmonitor.green.flipped';

// ── Raw gravity reader ───────────────────────────────────────────────────
//
// Deliberately separate from setup/orientation.js's OrientationTracker: that
// class derives the REAR CAMERA's pitch/roll for the landscape alignment use
// case. This needs the raw gravity.x/y components for a phone lying flat
// screen-up, a different geometry entirely — see greenread.js's header for
// the derivation.

class GravityReader extends EventTarget {
  constructor() {
    super();
    this.supported = typeof DeviceMotionEvent !== 'undefined';
    this.needsPermission = this.supported && typeof DeviceMotionEvent.requestPermission === 'function';
    this.permission = this.needsPermission ? 'prompt' : (this.supported ? 'granted' : 'unavailable');
    this.gx = 0; this.gy = 0; this.gz = 0;
    this.hasReading = false;
    this._onMotion = this._onMotion.bind(this);
  }

  async requestPermission() {
    if (!this.supported) return 'unavailable';
    if (!this.needsPermission) { this.permission = 'granted'; this.start(); return 'granted'; }
    try {
      const res = await DeviceMotionEvent.requestPermission();
      this.permission = res;
      if (res === 'granted') this.start();
      return res;
    } catch (err) {
      const insecure = window.isSecureContext === false || /secure|https/i.test(err.message || '');
      this.permission = insecure ? 'insecure' : 'denied';
      return this.permission;
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    window.addEventListener('devicemotion', this._onMotion, true);
  }
  stop() {
    this._running = false;
    window.removeEventListener('devicemotion', this._onMotion, true);
  }

  _onMotion(e) {
    const g = e.gravity || e.accelerationIncludingGravity;
    if (!g || g.x == null) return;
    this.gx = g.x; this.gy = g.y; this.gz = g.z ?? this.gz;
    this.hasReading = true;
    this.dispatchEvent(new Event('change'));
  }

  /** Average readings over `ms` milliseconds — a single instantaneous sample
   *  is noisy; a still phone over ~1.5s gives a clean number, same idea as
   *  the ball-radius averaging used for distance calibration elsewhere. */
  average(ms = 1500) {
    return new Promise((resolve) => {
      const samples = [];
      const onChange = () => samples.push({ x: this.gx, y: this.gy });
      this.addEventListener('change', onChange);
      setTimeout(() => {
        this.removeEventListener('change', onChange);
        if (!samples.length) { resolve(null); return; }
        const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
        resolve({ x: mean(samples.map((s) => s.x)), y: mean(samples.map((s) => s.y)), n: samples.length });
      }, ms);
    });
  }
}

// ── View ─────────────────────────────────────────────────────────────────

export class GreenView {
  constructor(root) {
    this.root = root;
    this.reader = new GravityReader();
    this.distanceFeet = 10;
    this.speedKey = 'medium';
    this.flipped = localStorage.getItem(FLIP_KEY) === '1';
    this.reading = null; // {x,y} averaged gravity
    this.result = null;
    this.isReading = false;
  }

  _q(sel) { return q(this.root, sel); }

  mount() {
    this.root.innerHTML = this._template();
    this._bind();
    this._syncInputs();
    if (this.reader.permission === 'granted') this.reader.start();
  }

  unmount() {
    this.reader.stop();
  }

  _template() {
    const seenIntro = localStorage.getItem(SEEN_KEY) === '1';
    return `
      <details id="gr-intro" ${seenIntro ? '' : 'open'}>
        <summary>How to read a green</summary>
        <div class="details-body" style="font-size:13px;color:var(--text-2);line-height:1.6">
          <p><strong style="color:var(--text)">1.</strong> Stand behind the ball,
          set the distance and green speed below.</p>
          <p><strong style="color:var(--text)">2.</strong> Lay the phone FLAT on
          the green at the ball, screen up, top edge pointed at the hole.</p>
          <p><strong style="color:var(--text)">3.</strong> Tap <strong>Read
          slope</strong> and hold still for a second.</p>
          <p>This measures the ACTUAL tilt with the accelerometer — it is not
          AimPoint's trained-feel technique, it is a direct physical
          measurement, run through the same rolling-ball physics as the rest
          of this app rather than a rule of thumb.</p>
        </div>
      </details>

      <div id="gr-permission"></div>

      <div class="card">
        <h3 class="card-title">This putt</h3>
        <div class="field">
          <div class="field-head">
            <span class="field-label">Distance</span>
            <span class="field-value" id="gr-dist-out"></span>
          </div>
          <input type="range" id="gr-dist" min="2" max="50" step="1">
        </div>
        <div class="field" style="margin-bottom:0">
          <div class="field-head"><span class="field-label">Green speed</span></div>
          <div class="chips" id="gr-speed-chips">
            ${Object.entries(GREEN_SPEEDS).map(([k, v]) =>
              `<button class="chip${k === this.speedKey ? ' active' : ''}" data-speed="${k}">${v.label.split(' ')[0]}<small>${v.stimpFeet}ft stimp</small></button>`
            ).join('')}
          </div>
        </div>
      </div>

      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <h3 class="card-title" style="margin:0">Slope</h3>
          <span class="pill" id="gr-status">not read</span>
        </div>
        <canvas id="gr-bubble" style="width:100%"></canvas>
        <button class="btn" id="gr-read" style="margin-top:12px">Read slope</button>
        <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:12px;color:var(--text-3)">
          <input type="checkbox" id="gr-flip" ${this.flipped ? 'checked' : ''}>
          Reads backwards on my phone — flip it
        </label>
      </div>

      <div id="gr-result"></div>
    `;
  }

  _bind() {
    this._q('#gr-intro').addEventListener('toggle', () => {
      localStorage.setItem(SEEN_KEY, '1');
    });

    const distSlider = this._q('#gr-dist');
    distSlider.value = this.distanceFeet;
    distSlider.oninput = (e) => {
      this.distanceFeet = Number(e.target.value);
      this._syncInputs();
      if (this.reading) this._computeAndRenderResult();
    };

    this.root.querySelectorAll('[data-speed]').forEach((b) => {
      b.onclick = () => {
        this.speedKey = b.dataset.speed;
        this.root.querySelectorAll('[data-speed]').forEach((x) => x.classList.toggle('active', x === b));
        if (this.reading) this._computeAndRenderResult();
      };
    });

    this._q('#gr-flip').onchange = (e) => {
      this.flipped = e.target.checked;
      localStorage.setItem(FLIP_KEY, this.flipped ? '1' : '0');
      if (this.reading) this._computeAndRenderResult();
    };

    this._q('#gr-read').onclick = () => this._takeReading();
    this._renderPermission();
  }

  _syncInputs() {
    this._q('#gr-dist-out').textContent = `${this.distanceFeet} ft`;
  }

  _renderPermission() {
    const host = this._q('#gr-permission');
    if (this.reader.permission === 'granted') { host.innerHTML = ''; return; }
    if (!this.reader.supported) {
      host.innerHTML = '<div class="note bad">This device has no motion sensors — the slope reading needs one.</div>';
      return;
    }
    if (this.reader.permission === 'insecure') {
      host.innerHTML = '<div class="note bad">Motion sensors need https. Reopen this page at the https:// address.</div>';
      return;
    }
    if (this.reader.permission === 'denied') {
      host.innerHTML = '<div class="note bad">Motion access denied. Safari → Settings → Motion &amp; Orientation Access, then reload.</div>';
      return;
    }
    host.innerHTML = `
      <div class="note">iOS only allows this from a tap.</div>
      <button class="btn" id="gr-enable-motion" style="margin-bottom:14px">Enable motion sensing</button>`;
    this._q('#gr-enable-motion').onclick = async () => {
      await this.reader.requestPermission();
      this._renderPermission();
    };
  }

  async _takeReading() {
    if (this.reader.permission !== 'granted') {
      await this.reader.requestPermission();
      this._renderPermission();
      if (this.reader.permission !== 'granted') return;
    }

    const btn = this._q('#gr-read');
    const status = this._q('#gr-status');
    btn.disabled = true;
    for (let i = 3; i > 0; i--) {
      btn.textContent = `Hold still… ${i}`;
      status.textContent = 'reading';
      status.className = 'pill warn';
      await new Promise((r) => setTimeout(r, 500));
    }
    const avg = await this.reader.average(1000);
    btn.disabled = false;
    btn.textContent = 'Read slope';

    if (!avg || avg.n < 5) {
      status.textContent = 'no reading';
      status.className = 'pill bad';
      return;
    }

    this.reading = avg;
    status.textContent = 'read';
    status.className = 'pill good';
    try { navigator.vibrate?.(20); } catch { /* optional */ }
    this._computeAndRenderResult();
  }

  _computeAndRenderResult() {
    const slopeAccel = slopeAccelFromGravity(this.reading.x, this.reading.y, this.flipped);
    this.result = readGreen({
      distanceFeet: this.distanceFeet,
      slopeAccel,
      stimpFeet: GREEN_SPEEDS[this.speedKey].stimpFeet,
    });
    this._drawBubble(slopeAccel);
    this._renderResult();
  }

  // ── Bubble-level visual ────────────────────────────────────────────────

  _drawBubble(slopeAccel) {
    const canvas = this._q('#gr-bubble');
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = canvas.clientWidth || 300;
    const h = 160;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 14;

    // Rings, like a real bubble level.
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    for (const r of [R * 0.33, R * 0.66, R]) {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    }
    // Crosshair.
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();
    ctx.font = '600 10px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.textAlign = 'center';
    ctx.fillText('HOLE', cx, cy - R - 4);
    ctx.fillText('YOU', cx, cy + R + 14);

    // Bubble position: displaced toward the DOWNHILL direction (where a free
    // ball would roll), scaled so a 5% slope reaches the outer ring.
    const G = 9.80665;
    const scale = R / (G * 0.05);
    const bx = cx + Math.max(-R, Math.min(R, slopeAccel.x * scale));
    const by = cy - Math.max(-R, Math.min(R, slopeAccel.y * scale)); // screen y flips

    const pct = slopePercent(slopeAccel);
    const color = pct < 1 ? '#5cf285' : pct < 3 ? '#ffb833' : '#ff5252';

    ctx.beginPath();
    ctx.arc(bx, by, 12, 0, Math.PI * 2);
    ctx.fillStyle = color + 'cc';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();

    ctx.font = '700 13px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(`${pct.toFixed(1)}%`, cx, cy + 4);
  }

  // ── Result ───────────────────────────────────────────────────────────

  _renderResult() {
    const host = this._q('#gr-result');
    const r = this.result;
    if (!r) { host.innerHTML = ''; return; }

    const dirWord = r.aimDirection === 'straight' ? 'No break — aim straight'
      : `Aim ${Math.abs(r.aimOffsetInches).toFixed(0)} in ${r.aimDirection} of the hole`;

    host.innerHTML = `
      <div class="card">
        <div style="text-align:center;padding:8px 0 4px">
          <div style="font-family:var(--font-round);font-size:26px;font-weight:700;color:var(--primary)">
            ${dirWord}
          </div>
          <div style="font-size:13px;color:var(--text-2);margin-top:4px">
            ${r.speedNote} — play it like a flat ${r.effectiveFlatFeet.toFixed(0)}-footer
          </div>
        </div>
        <canvas id="gr-path" style="width:100%;margin-top:10px"></canvas>
        <div class="note" style="margin-top:10px">
          ${r.slopePercent.toFixed(1)}% slope, ${this.distanceFeet} ft, ${GREEN_SPEEDS[this.speedKey].label.toLowerCase()} green.
          This is a physics simulation of a dying putt on this slope, not a felt estimate —
          real greens have grain, moisture and contour a flat-plane model cannot see, so
          treat it as a strong starting read, not gospel.
        </div>
      </div>`;

    this._drawPath(r);
  }

  _drawPath(result) {
    const canvas = this._q('#gr-path');
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = canvas.clientWidth || 300;
    const h = 220;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const path = result.path;
    if (!path?.length) return;

    const maxY = Math.max(...path.map((p) => p.y), 1);
    const maxX = Math.max(...path.map((p) => Math.abs(p.x)), maxY * 0.15);
    const padB = 30, padT = 20;

    const px = (x) => w / 2 + (x / maxX) * (w / 2 - 20);
    const py = (y) => h - padB - (y / maxY) * (h - padB - padT);

    // Straight reference line.
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px(0), py(0)); ctx.lineTo(px(0), py(maxY));
    ctx.stroke();
    ctx.setLineDash([]);

    // Curved path.
    ctx.beginPath();
    ctx.moveTo(px(path[0].x), py(path[0].y));
    for (const p of path.slice(1)) ctx.lineTo(px(p.x), py(p.y));
    ctx.strokeStyle = '#5cf285';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Ball start.
    ctx.beginPath();
    ctx.arc(px(0), py(0), 5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();

    // Hole.
    const holeY = path[path.length - 1].y;
    ctx.beginPath();
    ctx.arc(px(0), py(holeY), 7, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = '600 10px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'center';
    ctx.fillText('ball', px(0), py(0) + 18);
    ctx.fillText('hole', px(0), py(holeY) - 12);
  }
}
