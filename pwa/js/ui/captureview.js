// captureview.js — live camera, arm, capture, frame-by-frame replay.
//
// The primary screen. You point the phone at the ball, arm it, hit, and get a
// scrubbable replay of the strike with a tracer.

import { SwingRecorder } from '../capture/recorder.js';

const q = (root, sel) => root.querySelector(sel);

export class CaptureView {
  constructor(root) {
    this.root = root;
    this.recorder = new SwingRecorder();
    this.playIndex = 0;
    this.isPlaying = false;
    this.playSpeed = 0.25;
    this.showTracer = true;
    this._tracerPoints = [];

    this.recorder.addEventListener('state', () => this._render());
    this.recorder.addEventListener('error', () => this._render());
    this.recorder.addEventListener('clip', () => {
      this.playIndex = Math.max(0, this.recorder.impactIndex - 2);
      this._tracerPoints = [];
      this._drawFrame();
    });
  }

  _q(sel) { return q(this.root, sel); }

  mount() {
    this.root.innerHTML = this._template();
    this._bind();
    this._render();
    this._loop();
  }

  unmount() {
    this._alive = false;
    this.recorder.stop();
  }

  _template() {
    return `
      <div id="cap-error"></div>

      <div class="card" style="padding:10px">
        <div style="position:relative;border-radius:14px;overflow:hidden;background:#000">
          <canvas id="cap-canvas" style="width:100%;display:block;aspect-ratio:16/9"></canvas>
          <div id="cap-badge" style="position:absolute;top:10px;left:10px"></div>
          <div id="cap-fps" style="position:absolute;top:10px;right:10px"></div>
        </div>

        <div id="cap-controls" style="margin-top:12px"></div>
      </div>

      <div id="cap-replay"></div>

      <div class="note" id="cap-note"></div>
    `;
  }

  _bind() { /* controls are rebuilt per state in _render */ }

  // ── Render ────────────────────────────────────────────────────────────────

  _render() {
    if (!this.root.querySelector('#cap-canvas')) return;
    const r = this.recorder;

    // Error banner
    const err = this._q('#cap-error');
    err.innerHTML = r.error
      ? `<div class="note bad"><strong>Camera unavailable.</strong><br>${r.error}</div>`
      : '';

    // Badge
    const badge = this._q('#cap-badge');
    const badges = {
      idle: ['', ''],
      live: ['pill', 'live'],
      armed: ['pill good', 'armed — swing away'],
      capturing: ['pill warn', 'capturing'],
      review: ['pill good', 'replay'],
    };
    const [cls, text] = badges[r.state] || ['', ''];
    badge.innerHTML = text ? `<span class="${cls}">${text}</span>` : '';

    const fps = this._q('#cap-fps');
    fps.innerHTML = r.measuredFPS
      ? `<span class="pill ${r.measuredFPS >= 55 ? 'warn' : 'bad'}">${Math.round(r.measuredFPS)} fps</span>`
      : '';

    this._renderControls();
    this._renderReplay();
    this._renderNote();
  }

  _renderControls() {
    const r = this.recorder;
    const host = this._q('#cap-controls');

    if (r.state === 'idle') {
      host.innerHTML = `<button class="btn" id="cap-start">Start camera</button>`;
      this._q('#cap-start').onclick = () => r.start();
      return;
    }

    if (r.state === 'review') {
      host.innerHTML = `
        <div class="btn-row" style="margin:0">
          <button class="btn" id="cap-again">Record another</button>
          <button class="btn secondary" id="cap-save" style="max-width:120px">Save frame</button>
        </div>`;
      this._q('#cap-again').onclick = () => { r.clearClip(); r.arm(); };
      this._q('#cap-save').onclick = () => this._saveFrame();
      return;
    }

    host.innerHTML = `
      <div class="btn-row" style="margin:0 0 10px">
        <button class="btn ${r.state === 'armed' ? 'secondary' : ''}" id="cap-arm">
          ${r.state === 'armed' ? 'Disarm' : 'Arm'}</button>
        <button class="btn secondary" id="cap-manual" style="max-width:130px">Capture now</button>
      </div>
      <div class="field" style="margin:0">
        <div class="field-head">
          <span class="field-label">Trigger sensitivity</span>
          <span class="field-value" id="cap-sens-out">${r.sensitivity.toFixed(0)}</span>
        </div>
        <input type="range" id="cap-sens" min="3" max="12" step="0.5" value="${r.sensitivity}">
      </div>`;

    this._q('#cap-arm').onclick = () =>
      r.state === 'armed' ? r.disarm() : r.arm();
    this._q('#cap-manual').onclick = () => r.triggerNow();
    this._q('#cap-sens').oninput = (e) => {
      r.sensitivity = Number(e.target.value);
      this._q('#cap-sens-out').textContent = r.sensitivity.toFixed(0);
    };
  }

  _renderReplay() {
    const r = this.recorder;
    const host = this._q('#cap-replay');

    if (r.state !== 'review' || !r.clip.length) { host.innerHTML = ''; return; }

    const ms = (this.playIndex - r.impactIndex) * r.frameIntervalMs;
    host.innerHTML = `
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <h3 class="card-title" style="margin:0">Strike replay</h3>
          <span class="pill" id="rp-offset">${this.playIndex === r.impactIndex ? 'impact'
            : `${ms > 0 ? '+' : ''}${ms.toFixed(0)} ms`}</span>
        </div>

        <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">
          <button class="chip" id="rp-play" style="flex:0 0 46px">${this.isPlaying ? '❚❚' : '▶'}</button>
          <input type="range" id="rp-scrub" min="0" max="${r.clip.length - 1}"
            step="1" value="${this.playIndex}" style="flex:1">
        </div>

        <div style="display:flex;gap:8px;align-items:center">
          <button class="chip" id="rp-prev" style="flex:1">◀ frame</button>
          <button class="chip" id="rp-next" style="flex:1">frame ▶</button>
        </div>

        <div class="seg" style="margin-top:10px">
          ${[0.1, 0.25, 0.5, 1].map((s) => `
            <button data-speed="${s}" class="${this.playSpeed === s ? 'active' : ''}">${s * 100}%</button>
          `).join('')}
        </div>

        <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;color:var(--text-2)">
          <input type="checkbox" id="rp-tracer" ${this.showTracer ? 'checked' : ''}>
          Draw a tracer where I tap the ball
        </label>
        ${this._tracerPoints.length ? `<button class="btn secondary" id="rp-clear-tracer"
          style="margin-top:8px;padding:9px;font-size:13px">Clear tracer</button>` : ''}
      </div>`;

    this._q('#rp-play').onclick = () => {
      this.isPlaying = !this.isPlaying;
      this._render();
    };
    this._q('#rp-scrub').oninput = (e) => {
      this.isPlaying = false;
      this.playIndex = Number(e.target.value);
      this._drawFrame();
      this._updateOffsetLabel();
    };
    this._q('#rp-prev').onclick = () => this._step(-1);
    this._q('#rp-next').onclick = () => this._step(1);
    this._q('#rp-tracer').onchange = (e) => { this.showTracer = e.target.checked; this._drawFrame(); };
    const clear = this._q('#rp-clear-tracer');
    if (clear) clear.onclick = () => { this._tracerPoints = []; this._drawFrame(); };

    host.querySelectorAll('[data-speed]').forEach((b) => {
      b.onclick = () => { this.playSpeed = Number(b.dataset.speed); this._render(); };
    });

    // Tap the ball across frames to build a tracer.
    const canvas = this._q('#cap-canvas');
    canvas.onclick = (e) => {
      if (this.recorder.state !== 'review' || !this.showTracer) return;
      const rect = canvas.getBoundingClientRect();
      this._tracerPoints.push({
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
        index: this.playIndex,
      });
      this._drawFrame();
      this._render();
    };
  }

  _renderNote() {
    const r = this.recorder;
    const note = this._q('#cap-note');
    if (r.state === 'idle') {
      note.className = 'note';
      note.innerHTML = '<strong>What this does.</strong> Captures and replays the strike ' +
        'frame by frame — strike location, low point, face at impact. ' +
        'It does <em>not</em> measure ball speed: see the Guide tab for why a browser cannot.';
      return;
    }
    const fps = r.measuredFPS;
    if (fps && fps < 55) {
      note.className = 'note warn';
      note.innerHTML = `<strong>${Math.round(fps)} fps.</strong> Enough to see the strike, ` +
        `not enough to measure the ball — at this rate a driver ball moves about ` +
        `${(150 * 1.46667 / fps).toFixed(1)} ft between frames. Good light raises the frame rate.`;
    } else {
      note.className = 'note';
      note.innerHTML = 'Point at the ball, tap <strong>Arm</strong>, and swing. ' +
        'It keeps the frames around impact automatically.';
    }
  }

  _updateOffsetLabel() {
    const el = this._q('#rp-offset');
    if (!el) return;
    const r = this.recorder;
    const ms = (this.playIndex - r.impactIndex) * r.frameIntervalMs;
    el.textContent = this.playIndex === r.impactIndex ? 'impact'
      : `${ms > 0 ? '+' : ''}${ms.toFixed(0)} ms`;
  }

  _step(dir) {
    const r = this.recorder;
    this.isPlaying = false;
    this.playIndex = Math.max(0, Math.min(r.clip.length - 1, this.playIndex + dir));
    const scrub = this._q('#rp-scrub');
    if (scrub) scrub.value = this.playIndex;
    this._drawFrame();
    this._updateOffsetLabel();
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  _loop() {
    this._alive = true;
    let lastAdvance = 0;

    const frame = (now) => {
      if (!this._alive) return;
      const r = this.recorder;

      if (r.state === 'review') {
        if (this.isPlaying && r.clip.length) {
          const interval = r.frameIntervalMs / this.playSpeed;
          if (now - lastAdvance >= interval) {
            lastAdvance = now;
            this.playIndex++;
            if (this.playIndex >= r.clip.length) this.playIndex = 0;
            const scrub = this._q('#rp-scrub');
            if (scrub) scrub.value = this.playIndex;
            this._updateOffsetLabel();
            this._drawFrame();
          }
        }
      } else if (r.state !== 'idle') {
        this._drawLive();
      }

      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  _canvasCtx() {
    const canvas = this._q('#cap-canvas');
    if (!canvas) return null;
    const r = this.recorder;
    const w = r._capW || 720;
    const h = r._capH || 405;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { canvas, ctx: canvas.getContext('2d'), w, h };
  }

  _drawLive() {
    const c = this._canvasCtx();
    if (!c || !this.recorder.video) return;
    const { ctx, w, h } = c;
    ctx.drawImage(this.recorder.video, 0, 0, w, h);

    // Tee-box guide: dim the surround so the eye goes where the trigger looks.
    const roi = this.recorder._roi;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.rect(roi.x * w, roi.y * h, roi.w * w, roi.h * h);
    ctx.fill('evenodd');
    ctx.restore();

    const armed = this.recorder.state === 'armed';
    ctx.strokeStyle = armed ? '#5cf285' : 'rgba(255,255,255,0.7)';
    ctx.lineWidth = armed ? 3 : 1.5;
    ctx.setLineDash(armed ? [] : [8, 7]);
    ctx.strokeRect(roi.x * w, roi.y * h, roi.w * w, roi.h * h);
    ctx.setLineDash([]);
  }

  _drawFrame() {
    const c = this._canvasCtx();
    const r = this.recorder;
    if (!c || !r.clip.length) return;
    const { ctx, w, h } = c;
    const f = r.clip[Math.min(this.playIndex, r.clip.length - 1)];
    if (!f) return;

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(f.bitmap, 0, 0, w, h);

    if (f.offset === 0) {
      ctx.fillStyle = '#ffb833';
      ctx.fillRect(0, 0, w, 4);
    }

    if (this.showTracer && this._tracerPoints.length > 1) {
      const pts = [...this._tracerPoints].sort((a, b) => a.index - b.index);
      ctx.beginPath();
      ctx.moveTo(pts[0].x * w, pts[0].y * h);
      for (const p of pts.slice(1)) ctx.lineTo(p.x * w, p.y * h);
      ctx.strokeStyle = '#5cf285';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 4, 0, Math.PI * 2);
        ctx.fillStyle = p.index === this.playIndex ? '#fff' : '#5cf285';
        ctx.fill();
      }
    }
  }

  _saveFrame() {
    const canvas = this._q('#cap-canvas');
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `strike-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }
}
