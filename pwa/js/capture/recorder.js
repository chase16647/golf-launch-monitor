// recorder.js — live camera, rolling frame buffer, impact trigger, replay.
//
// This is the part of a launch monitor a browser CAN do. It will not measure
// ball speed (see camera.js for why 30 fps makes that impossible), but it
// captures and replays the strike frame by frame, which is what you actually
// want to look at: strike location, face angle at impact, low point, path.
//
// ── Memory ──────────────────────────────────────────────────────────────────
// Frames are held as ImageBitmaps, which live on the GPU and are far cheaper
// than ImageData. They must be close()d explicitly or Safari will happily run
// the tab out of memory in about twenty seconds. Every eviction path here
// closes what it drops.
//
// Capture resolution is deliberately downscaled: the replay only needs to be
// legible, and a 1080p ring of 90 frames is roughly 350 MB.

const DEFAULT_CAPTURE_WIDTH = 720;

export class SwingRecorder extends EventTarget {
  /**
   * @param {object} opts
   * @param {number} opts.bufferFrames  how many frames of history to hold
   * @param {number} opts.postTrigger   frames to keep after impact
   */
  constructor({ bufferFrames = 90, postTrigger = 25 } = {}) {
    super();
    this.bufferFrames = bufferFrames;
    this.postTrigger = postTrigger;

    this.stream = null;
    this.video = null;
    this.state = 'idle'; // idle | live | armed | capturing | review
    this.error = null;

    this.measuredFPS = 0;
    this.width = 0;
    this.height = 0;

    /** @type {{bitmap: ImageBitmap, t: number}[]} */
    this.frames = [];
    /** @type {{bitmap: ImageBitmap, t: number, offset: number}[]} */
    this.clip = [];

    this._work = document.createElement('canvas');
    this._workCtx = this._work.getContext('2d', { willReadFrequently: true });

    // Trigger state: Welford running stats on ROI brightness.
    this._roi = { x: 0.35, y: 0.45, w: 0.3, h: 0.3 };
    this._n = 0;
    this._mean = 0;
    this._m2 = 0;
    this._armedFrames = 0;
    this._postCount = 0;

    // Frames carry a monotonic sequence number and the trigger is recorded by
    // SEQUENCE, never by array index.
    //
    // The ring evicts from the front while we are still capturing, so every
    // array index shifts down by one per new frame. Storing the trigger as an
    // index made the impact marker land ~12 frames late — the replay claimed
    // impact was the final frame, with the actual strike already scrolled past.
    this._seq = 0;
    this._triggerSeq = -1;

    this.sensitivity = 6; // sigma
    this._frameTimes = [];
    this._running = false;
  }

  get isSecure() {
    return typeof window !== 'undefined' ? window.isSecureContext !== false : true;
  }

  // ── Camera ────────────────────────────────────────────────────────────────

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.error = this.isSecure
        ? 'This browser has no camera API.'
        : 'The camera needs https. Open the https:// address instead of http://.';
      this._emit('error');
      return false;
    }

    try {
      // Ask for the highest frame rate available. What we get back is the
      // point — see the Guide tab's camera test.
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          frameRate: { ideal: 240 },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
    } catch (err) {
      this.error = err.name === 'NotAllowedError'
        ? 'Camera access denied. Allow it in Safari settings and reload.'
        : `${err.name}: ${err.message}`;
      this._emit('error');
      return false;
    }

    const video = document.createElement('video');
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    await video.play().catch(() => {});
    this.video = video;

    const track = this.stream.getVideoTracks()[0];
    const s = track.getSettings?.() || {};
    this.width = s.width || video.videoWidth || 1280;
    this.height = s.height || video.videoHeight || 720;

    // Downscale for the ring buffer.
    const scale = Math.min(1, DEFAULT_CAPTURE_WIDTH / this.width);
    this._capW = Math.round(this.width * scale);
    this._capH = Math.round(this.height * scale);
    this._work.width = this._capW;
    this._work.height = this._capH;

    this.state = 'live';
    this._running = true;
    this._emit('state');
    this._pump();
    return true;
  }

  stop() {
    this._running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video = null;
    this._clearFrames();
    this.state = 'idle';
    this._emit('state');
  }

  // ── Frame pump ────────────────────────────────────────────────────────────

  _pump() {
    const video = this.video;
    if (!video) return;

    const useRVFC = typeof video.requestVideoFrameCallback === 'function';
    const tick = async (now) => {
      if (!this._running || !this.video) return;
      const t = now ?? performance.now();

      try {
        await this._onFrame(t);
      } catch {
        // A dropped frame is survivable; a thrown loop is not.
      }

      if (!this._running) return;
      if (useRVFC) video.requestVideoFrameCallback((n) => tick(n));
      else requestAnimationFrame(tick);
    };

    if (useRVFC) video.requestVideoFrameCallback((n) => tick(n));
    else requestAnimationFrame(tick);
  }

  async _onFrame(t) {
    if (this.state === 'review' || this.state === 'idle') return;

    // Measure the REAL frame rate rather than trusting what the browser claims.
    if (this._lastT) {
      const dt = t - this._lastT;
      if (dt > 0.5 && dt < 500) {
        this._frameTimes.push(dt);
        if (this._frameTimes.length > 60) this._frameTimes.shift();
        const sorted = [...this._frameTimes].sort((a, b) => a - b);
        this.measuredFPS = 1000 / sorted[Math.floor(sorted.length / 2)];
      }
    }
    this._lastT = t;

    this._workCtx.drawImage(this.video, 0, 0, this._capW, this._capH);

    // createImageBitmap from the canvas gives a cheap, GPU-side snapshot.
    const bitmap = await createImageBitmap(this._work);

    this.frames.push({ bitmap, t, seq: this._seq++ });
    while (this.frames.length > this.bufferFrames) {
      // MUST close, or Safari leaks until the tab dies.
      this.frames.shift().bitmap.close();
    }

    if (this.state === 'armed') this._checkTrigger();
    else if (this.state === 'capturing') {
      this._postCount++;
      if (this._postCount >= this.postTrigger) this._finishCapture();
    }
  }

  // ── Trigger ───────────────────────────────────────────────────────────────

  arm() {
    if (this.state !== 'live' && this.state !== 'review') return;
    this._resetTrigger();
    this.state = 'armed';
    this._emit('state');
  }

  disarm() {
    if (this.state === 'armed') {
      this.state = 'live';
      this._emit('state');
    }
  }

  /** Manual trigger, for when auto-detect is being unhelpful. */
  triggerNow() {
    if (this.state !== 'armed' && this.state !== 'live') return;
    this._triggerSeq = this.frames.at(-1)?.seq ?? this._seq - 1;
    this.state = 'capturing';
    this._postCount = 0;
    this._emit('state');
  }

  _resetTrigger() {
    this._n = 0;
    this._mean = 0;
    this._m2 = 0;
    this._armedFrames = 0;
    this._postCount = 0;
    this._triggerSeq = -1;
  }

  setROI(roi) {
    this._roi = roi;
    this._resetTrigger();
  }

  /**
   * Detect the swing by watching the brightness of a small region for a sudden
   * departure from its running statistics. The club sweeping through and the
   * ball leaving both produce a large single-frame change, which is far more
   * robust at 30 fps than trying to actually SEE the ball go.
   */
  _checkTrigger() {
    const value = this._roiBrightness();
    if (value == null) return;

    this._armedFrames++;
    this._n++;
    const delta = value - this._mean;
    this._mean += delta / this._n;
    this._m2 += delta * (value - this._mean);

    // Need a baseline, plus a grace period so we don't fire on the user's hand
    // withdrawing after they place the ball.
    if (this._n < 12 || this._armedFrames < 20) return;

    const variance = this._m2 / (this._n - 1);
    const sigma = Math.max(Math.sqrt(Math.max(variance, 0)), 0.6);
    const deviation = Math.abs(value - this._mean);

    if (deviation > sigma * this.sensitivity && deviation > 4) {
      this._triggerSeq = this.frames.at(-1)?.seq ?? this._seq - 1;
      this.state = 'capturing';
      this._postCount = 0;
      this._emit('state');
      try { navigator.vibrate?.(30); } catch { /* optional */ }
    }
  }

  _roiBrightness() {
    const { x, y, w, h } = this._roi;
    const px = Math.round(x * this._capW);
    const py = Math.round(y * this._capH);
    const pw = Math.max(2, Math.round(w * this._capW));
    const ph = Math.max(2, Math.round(h * this._capH));
    let data;
    try {
      data = this._workCtx.getImageData(px, py, pw, ph).data;
    } catch {
      return null;
    }
    let sum = 0;
    let count = 0;
    // Step 8 pixels: a mean this coarse is statistically identical and ~8x cheaper.
    for (let i = 0; i < data.length; i += 32) {
      sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      count++;
    }
    return count ? sum / count : null;
  }

  // ── Clip ──────────────────────────────────────────────────────────────────

  _finishCapture() {
    const pre = 18;

    // Resolve the trigger by sequence, because indices have shifted under us.
    const triggerIdx = this.frames.findIndex((f) => f.seq === this._triggerSeq);
    if (triggerIdx < 0) {
      // The impact frame aged out of the ring entirely — the buffer is too
      // small for the configured pre-roll plus post-roll. Better to say so
      // than to hand back a clip with the impact marked in the wrong place.
      this.error = 'Buffer too small to hold the whole strike. Lower post-trigger frames.';
      this.state = 'live';
      this._emit('error');
      this._emit('state');
      return;
    }

    const start = Math.max(0, triggerIdx - pre);
    const end = Math.min(this.frames.length - 1, triggerIdx + this.postTrigger);

    // Transfer ownership of the slice to the clip so the ring can keep
    // recycling without closing bitmaps we still need.
    const kept = this.frames.splice(start, end - start + 1);
    this.clip.forEach((f) => f.bitmap.close());
    this.clip = kept.map((f) => ({
      bitmap: f.bitmap,
      t: f.t,
      offset: f.seq - this._triggerSeq,
    }));

    this.impactIndex = this.clip.findIndex((f) => f.offset === 0);
    if (this.impactIndex < 0) this.impactIndex = Math.min(pre, this.clip.length - 1);

    this.state = 'review';
    this._emit('state');
    this._emit('clip');
  }

  clearClip() {
    this.clip.forEach((f) => f.bitmap.close());
    this.clip = [];
    if (this.state === 'review') {
      this.state = 'live';
      this._emit('state');
    }
  }

  _clearFrames() {
    this.frames.forEach((f) => f.bitmap.close());
    this.frames = [];
    this.clip.forEach((f) => f.bitmap.close());
    this.clip = [];
  }

  /** Milliseconds per frame, from the measured rate. */
  get frameIntervalMs() {
    return this.measuredFPS > 0 ? 1000 / this.measuredFPS : 33.3;
  }

  _emit(name) {
    this.dispatchEvent(new Event(name));
  }
}
