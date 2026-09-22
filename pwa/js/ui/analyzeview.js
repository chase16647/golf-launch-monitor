// analyzeview.js — the Analyze tab: a real frame-by-frame scrubber for ANY
// video, plus a GolfTec-style pose overlay on top of it.
//
// Two ways in, one scrubber:
//   1. A clip just captured by the in-app recorder (Capture tab).
//   2. Any video file picked from the photo library — including the iPhone
//      Camera app's own 120/240fps slo-mo, which is the actual fix for
//      "I hate scrolling in the Camera app and it never lands on the frame
//      I want": you get single-frame stepping, not a finger-drag scrub bar.
//
// The two sources are unified behind one tiny interface (frameCount, getFrame,
// currentTime) so the scrubber/pose code below doesn't care which one is live.

import { detectPose, drawSkeleton, deriveAngles, headSwayFromAddress, isPoseAvailable } from '../pose/poseOverlay.js';

const q = (root, sel) => root.querySelector(sel);

// ── Frame sources ────────────────────────────────────────────────────────────

/** Wraps a recorder clip: an array of already-decoded ImageBitmaps. */
class ClipSource {
  constructor(clip, impactIndex, frameIntervalMs) {
    this.clip = clip;
    this.impactIndex = impactIndex;
    this.frameIntervalMs = frameIntervalMs;
    this.index = Math.max(0, impactIndex - 2);
  }
  get count() { return this.clip.length; }
  get label() { return 'Recorded strike'; }
  offsetLabel(i) {
    const ms = (i - this.impactIndex) * this.frameIntervalMs;
    return i === this.impactIndex ? 'impact' : `${ms > 0 ? '+' : ''}${ms.toFixed(0)} ms`;
  }
  async drawInto(canvas, i) {
    const f = this.clip[Math.max(0, Math.min(i, this.clip.length - 1))];
    if (!f) return;
    const ctx = canvas.getContext('2d');
    canvas.width = f.bitmap.width;
    canvas.height = f.bitmap.height;
    ctx.drawImage(f.bitmap, 0, 0);
  }
  destroy() { /* recorder owns the bitmaps' lifetime */ }
}

/**
 * Wraps an imported video file. We cannot know its true per-frame timing
 * cross-browser without decoding it frame-accurately (which the web platform
 * does not expose), so the user tells us the step: this is exactly the
 * information iOS already showed them when they chose 120fps or 240fps slo-mo
 * at record time.
 */
class VideoFileSource {
  constructor(video, stepSeconds) {
    this.video = video;
    this.stepSeconds = stepSeconds;
    this.index = 0;
  }
  get count() { return Math.max(1, Math.round(this.video.duration / this.stepSeconds)); }
  get label() { return 'Imported video'; }
  offsetLabel(i) { return `${(i * this.stepSeconds).toFixed(3)} s`; }
  async drawInto(canvas, i) {
    const t = Math.min(i * this.stepSeconds, this.video.duration - 0.001);
    await seekTo(this.video, t);
    const ctx = canvas.getContext('2d');
    canvas.width = this.video.videoWidth;
    canvas.height = this.video.videoHeight;
    ctx.drawImage(this.video, 0, 0);
  }
  destroy() {
    URL.revokeObjectURL(this.video.src);
  }
}

function seekTo(video, t) {
  return new Promise((resolve) => {
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = t;
  });
}

// ── View ─────────────────────────────────────────────────────────────────────

export class AnalyzeView {
  constructor(root, { getLastClip } = {}) {
    this.root = root;
    this.getLastClip = getLastClip || (() => null);
    this.source = null;
    this.isPlaying = false;
    this.playSpeed = 0.25;

    this.poseEnabled = false;
    this.poseAvailable = null; // unknown until checked
    this.currentLandmarks = null;
    this.addressLandmarks = null;
    this.addressIndex = null;
    this._poseBusy = false;
    this._poseSeq = 0;
  }

  _q(sel) { return q(this.root, sel); }

  mount() {
    this.root.innerHTML = this._template();
    this._bind();
    this._renderEmpty();
    isPoseAvailable().then((ok) => {
      this.poseAvailable = ok;
      this._renderPoseAvailability();
    });
  }

  unmount() {
    this._alive = false;
    this.source?.destroy();
  }

  _template() {
    return `
      <div id="an-empty"></div>
      <div id="an-workspace" hidden>
        <div class="card" style="padding:10px">
          <div style="position:relative;border-radius:14px;overflow:hidden;background:#000">
            <canvas id="an-canvas" style="width:100%;display:block"></canvas>
            <div id="an-offset" style="position:absolute;top:10px;left:10px"></div>
            <div id="an-poselabel" style="position:absolute;top:10px;right:10px"></div>
          </div>

          <div style="display:flex;gap:10px;align-items:center;margin:12px 0 8px">
            <button class="chip" id="an-play" style="flex:0 0 46px">▶</button>
            <input type="range" id="an-scrub" min="0" max="1" step="1" value="0" style="flex:1">
          </div>
          <div style="display:flex;gap:8px">
            <button class="chip" id="an-prev" style="flex:1">◀ frame</button>
            <button class="chip" id="an-next" style="flex:1">frame ▶</button>
          </div>
          <div class="seg" style="margin-top:10px">
            ${[0.1, 0.25, 0.5, 1].map((s) => `<button data-speed="${s}" class="${this.playSpeed === s ? 'active' : ''}">${s * 100}%</button>`).join('')}
          </div>
        </div>

        <div class="card" id="an-pose-card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
            <h3 class="card-title" style="margin:0">Body position</h3>
            <label style="display:flex;align-items:center;gap:7px;font-size:13px;color:var(--text-2)">
              <input type="checkbox" id="an-pose-toggle">
              Show skeleton
            </label>
          </div>
          <div id="an-pose-body"></div>
        </div>

        <div class="btn-row">
          <button class="btn secondary" id="an-close">Close</button>
        </div>
      </div>
    `;
  }

  _bind() {
    const empty = this._q('#an-empty');
    empty.querySelector?.('#an-use-clip');

    this._q('#an-play').onclick = () => { this.isPlaying = !this.isPlaying; this._syncPlayButton(); };
    this._q('#an-scrub').oninput = (e) => { this.isPlaying = false; this._syncPlayButton(); this._goTo(Number(e.target.value)); };
    this._q('#an-prev').onclick = () => this._step(-1);
    this._q('#an-next').onclick = () => this._step(1);
    this._q('#an-close').onclick = () => { this.source?.destroy(); this.source = null; this._renderEmpty(); };

    this.root.querySelectorAll('[data-speed]').forEach((b) => {
      b.onclick = () => {
        this.playSpeed = Number(b.dataset.speed);
        this.root.querySelectorAll('[data-speed]').forEach((x) => x.classList.toggle('active', x === b));
      };
    });

    this._q('#an-pose-toggle').onchange = (e) => {
      this.poseEnabled = e.target.checked;
      this._runPoseForCurrentFrame();
    };

    this._loop();
  }

  _renderEmpty() {
    const host = this._q('#an-empty');
    const hasClip = !!this.getLastClip();
    this._q('#an-workspace').hidden = true;

    host.innerHTML = `
      <div class="note">
        <strong>Frame-by-frame, on any video.</strong> Import a slow-motion
        clip shot with the stock Camera app and step through it one frame at a
        time — no more dragging a scrub bar and overshooting the moment you
        wanted.
      </div>
      ${hasClip ? `<button class="btn" id="an-use-clip" style="margin-bottom:10px">Use last recorded strike</button>` : ''}
      <label class="btn secondary" style="display:block;text-align:center;cursor:pointer">
        Import video
        <input type="file" accept="video/*" id="an-file-input" style="display:none">
      </label>
      <div class="field" style="margin-top:16px">
        <div class="field-head"><span class="field-label">Imported video frame rate</span></div>
        <div class="chips" id="an-fps-chips">
          ${[240, 120, 60, 30].map((f) => `<button class="chip${f === 240 ? ' active' : ''}" data-fps="${f}">${f}<small>fps</small></button>`).join('')}
        </div>
        <div style="font-size:12px;color:var(--text-3);margin-top:8px">
          Match whatever you chose in the Camera app's slo-mo settings. Getting
          this wrong only affects the millisecond labels, not which frames you see.
        </div>
      </div>`;

    this._selectedFps = 240;
    host.querySelectorAll('[data-fps]').forEach((b) => {
      b.onclick = () => {
        this._selectedFps = Number(b.dataset.fps);
        host.querySelectorAll('[data-fps]').forEach((x) => x.classList.toggle('active', x === b));
      };
    });

    const useClipBtn = host.querySelector('#an-use-clip');
    if (useClipBtn) useClipBtn.onclick = () => this._loadClip();

    host.querySelector('#an-file-input').onchange = (e) => {
      const file = e.target.files?.[0];
      if (file) this._loadFile(file);
    };
  }

  _loadClip() {
    const clip = this.getLastClip();
    if (!clip?.recorder?.clip?.length) return;
    this.source?.destroy();
    this.source = new ClipSource(clip.recorder.clip, clip.recorder.impactIndex, clip.recorder.frameIntervalMs);
    this._openWorkspace();
  }

  async _loadFile(file) {
    const video = document.createElement('video');
    video.src = URL.createObjectURL(file);
    video.muted = true;
    video.playsInline = true;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('Could not read that video.'));
    }).catch((err) => {
      this._q('#an-empty').insertAdjacentHTML('afterbegin',
        `<div class="note bad">${err.message}</div>`);
    });
    if (!video.duration) return;

    this.source?.destroy();
    this.source = new VideoFileSource(video, 1 / this._selectedFps);
    this._openWorkspace();
  }

  _openWorkspace() {
    this.addressLandmarks = null;
    this.addressIndex = null;
    this.currentLandmarks = null;
    this._q('#an-empty').hidden = true;
    this._q('#an-workspace').hidden = false;

    const scrub = this._q('#an-scrub');
    scrub.max = String(this.source.count - 1);
    scrub.value = String(this.source.index);
    this._renderPoseAvailability();
    this._goTo(this.source.index);
  }

  _syncPlayButton() {
    this._q('#an-play').textContent = this.isPlaying ? '❚❚' : '▶';
  }

  _step(dir) {
    if (!this.source) return;
    this.isPlaying = false;
    this._syncPlayButton();
    this._goTo(Math.max(0, Math.min(this.source.count - 1, this.source.index + dir)));
  }

  async _goTo(i) {
    if (!this.source) return;
    this.source.index = i;
    this._q('#an-scrub').value = String(i);
    const canvas = this._q('#an-canvas');
    await this.source.drawInto(canvas, i);
    this._q('#an-offset').innerHTML = `<span class="pill">${this.source.offsetLabel(i)}</span>`;
    this._runPoseForCurrentFrame();
  }

  _loop() {
    this._alive = true;
    let last = 0;
    const frame = (now) => {
      if (!this._alive) return;
      if (this.isPlaying && this.source) {
        // Frame interval for playback: recorded clips know their own rate;
        // imported video uses the chosen step.
        const intervalMs = this.source instanceof ClipSource
          ? this.source.frameIntervalMs
          : this.source.stepSeconds * 1000;
        const interval = intervalMs / this.playSpeed;
        if (now - last >= interval) {
          last = now;
          const next = this.source.index + 1;
          this._goTo(next >= this.source.count ? 0 : next);
        }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // ── Pose ────────────────────────────────────────────────────────────────

  _renderPoseAvailability() {
    const card = this._q('#an-pose-card');
    if (!card) return;
    if (this.poseAvailable === false) {
      card.querySelector('#an-pose-body').innerHTML =
        '<div class="note warn">Body-position overlay could not load (no network on first use, or this browser lacks WebGL). Everything else still works.</div>';
      this._q('#an-pose-toggle').disabled = true;
    }
  }

  async _runPoseForCurrentFrame() {
    const canvas = this._q('#an-canvas');
    if (!canvas || !canvas.width) return;

    if (!this.poseEnabled) {
      this._redrawPlain();
      this._renderPoseBody();
      return;
    }
    if (this.poseAvailable === false) return;

    const mySeq = ++this._poseSeq;
    this._q('#an-poselabel').innerHTML = '<span class="pill">reading pose…</span>';
    const landmarks = await detectPose(canvas).catch(() => null);
    if (mySeq !== this._poseSeq) return; // a newer frame was requested meanwhile

    this.currentLandmarks = landmarks;
    this._q('#an-poselabel').innerHTML = landmarks
      ? ''
      : '<span class="pill warn">no pose found</span>';

    this._redrawWithSkeleton();
    this._renderPoseBody();
  }

  _redrawPlain() {
    // Re-blit the current frame without a skeleton (used when toggled off).
    this.source?.drawInto(this._q('#an-canvas'), this.source.index);
  }

  async _redrawWithSkeleton() {
    const canvas = this._q('#an-canvas');
    const ctx = canvas.getContext('2d');
    await this.source.drawInto(canvas, this.source.index);
    const w = canvas.width, h = canvas.height;

    if (this.addressLandmarks) {
      drawSkeleton(ctx, this.addressLandmarks, { w, h, color: '#9e9ea3', alpha: 0.55, dashed: true });
    }
    if (this.currentLandmarks) {
      drawSkeleton(ctx, this.currentLandmarks, { w, h, color: '#5cf285', alpha: 1 });
    }
  }

  _renderPoseBody() {
    const host = this._q('#an-pose-body');
    if (!host) return;

    if (!this.poseEnabled) {
      host.innerHTML = `<div style="font-size:13px;color:var(--text-2);line-height:1.55">
        Turn on the skeleton to see live spine, shoulder and hip angles, and to
        mark your address position for comparison through the swing.
      </div>`;
      return;
    }

    const angles = deriveAngles(this.currentLandmarks);
    const addressAngles = deriveAngles(this.addressLandmarks);
    const sway = headSwayFromAddress(addressAngles, angles);

    const row = (label, value, suffix = '°') =>
      `<div class="row"><span class="row-key">${label}</span><span class="row-val">${value == null ? '—' : value.toFixed(1) + suffix}</span></div>`;

    host.innerHTML = `
      ${row('Spine tilt (approx.)', angles?.spineTiltDeg)}
      ${row('Shoulder tilt', angles?.shoulderTiltDeg)}
      ${row('Hip tilt', angles?.hipTiltDeg)}
      ${sway != null ? row('Head sway vs address', sway * 100, '% of frame width') : ''}
      <div class="btn-row" style="margin-top:12px">
        <button class="btn secondary" id="an-mark-address">
          ${this.addressLandmarks ? 'Re-mark address' : 'Mark this frame as address'}
        </button>
      </div>
      <div class="note" style="margin-top:4px">
        One camera cannot see every angle correctly at once — a face-on camera
        reads spine tilt and sway well but foreshortens shoulder turn; down-the-
        line does the opposite. These numbers are real measurements of THIS
        video, most useful compared against your own address position, not as
        absolute "correct" numbers.
      </div>`;

    const markBtn = host.querySelector('#an-mark-address');
    if (markBtn) {
      markBtn.onclick = () => {
        this.addressLandmarks = this.currentLandmarks;
        this.addressIndex = this.source.index;
        this._redrawWithSkeleton();
        this._renderPoseBody();
        try { navigator.vibrate?.(15); } catch { /* optional */ }
      };
    }
  }
}
