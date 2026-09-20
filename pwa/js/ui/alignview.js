// alignview.js — the Align tab.
//
// Three jobs, in order of how much they affect accuracy:
//   1. Measure distance to the ball   (goes 1:1 into ball speed)
//   2. Capture the target line        (yaw is invisible to gravity)
//   3. Show live attitude             (so any lean is known, not guessed)
// Then: save it as a profile so the next session reproduces it exactly.

import { OrientationTracker, yawFromSquare, headingUncertainty } from '../setup/orientation.js';
import {
  evaluateSetup, IDEAL, loadProfiles, saveProfile, deleteProfile,
  compareToProfile, distanceUncertaintyPct, ballPixelsAtDistance, rollDeviation,
} from '../setup/alignment.js';
import { drawLevel } from './level.js';

// Scoped to the view's own root, never document-wide. The IDs in this
// template are generic enough ("#in-distance") that a document-level lookup
// would silently bind to another view's element if one ever matched.
const q = (root, sel) => root.querySelector(sel);

export class AlignView {
  constructor(root) {
    this.root = root;
    this.tracker = new OrientationTracker();
    this.targetHeading = null;
    this.distanceM = IDEAL.distanceM;
    this.distanceSamples = 0;       // how many ball measurements were averaged
    this.heightDeltaM = 0;
    this.activeProfile = null;
    this._raf = null;

    this.tracker.addEventListener('change', () => this._scheduleRender());
  }

  _q(sel) {
    return q(this.root, sel);
  }

  mount() {
    this.root.innerHTML = this._template();
    this._bind();
    this._render();
    if (this.tracker.permission === 'granted') this.tracker.start();
  }

  unmount() {
    this.tracker.stop();
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  // ── Template ──────────────────────────────────────────────────────────────

  _template() {
    return `
      <div id="align-permission"></div>

      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <h3 class="card-title" style="margin:0">Live position</h3>
          <span class="pill" id="align-verdict">—</span>
        </div>
        <canvas id="align-level"></canvas>
        <div class="metrics three" style="margin:12px 0 0">
          <div class="tile compact"><div class="tile-label">Lean</div><div class="tile-value" id="v-pitch">—<span class="tile-unit">°</span></div></div>
          <div class="tile compact"><div class="tile-label">Tilt</div><div class="tile-value" id="v-roll">—<span class="tile-unit">°</span></div></div>
          <div class="tile compact"><div class="tile-label">Square</div><div class="tile-value" id="v-yaw">—<span class="tile-unit">°</span></div></div>
        </div>
        <div class="note" id="align-headline" style="margin:12px 0 0">Grant motion access to begin.</div>
      </div>

      <div class="card">
        <h3 class="card-title">1 · Distance to ball</h3>
        <div class="field">
          <div class="field-head">
            <span class="field-label">Lens to ball</span>
            <span class="field-value" id="out-distance"></span>
          </div>
          <input type="range" id="in-distance" min="1.0" max="2.4" step="0.025">
        </div>
        <div class="note" id="distance-note"></div>
        <div style="font-size:12px;color:var(--text-3);line-height:1.5">
          No tape measure? A standard driver is about 45 in and a 7-iron about
          37 in. Lay one down from the ball — 5 ft is a driver plus a hand span.
        </div>
      </div>

      <div class="card">
        <h3 class="card-title">2 · Target line</h3>
        <div class="note" id="target-status"></div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:12px">
          Gravity cannot tell which way you are aiming, so this is the one thing
          the phone cannot work out on its own — and being 20° off square reads
          your ball speed <strong>6% low</strong>.
          <br><br>
          Stand behind the ball, point the <strong>back of the phone</strong> straight
          down your target line, and tap. Then set the phone beside the ball.
        </div>
        <div class="btn-row">
          <button class="btn" id="btn-set-target">Set target line</button>
          <button class="btn secondary" id="btn-clear-target" style="max-width:110px">Clear</button>
        </div>
      </div>

      <div class="card">
        <h3 class="card-title">3 · Save this setup</h3>
        <div id="profile-compare"></div>
        <div class="btn-row" style="margin-bottom:10px">
          <input type="text" id="profile-name" placeholder="e.g. Home mat"
            style="flex:1;padding:13px;border-radius:12px;background:var(--surface-2);color:var(--text);border:0.5px solid var(--separator);font-size:15px;font-family:var(--font-round)">
          <button class="btn" id="btn-save-profile" style="max-width:110px">Save</button>
        </div>
        <div id="profile-list"></div>
        <div style="font-size:12px;color:var(--text-3);line-height:1.5;margin-top:10px">
          Two setups can both be within tolerance and still give different
          numbers. Saving one and matching it is what makes sessions comparable.
        </div>
      </div>

      <details>
        <summary>No tripod? Read this.</summary>
        <div class="details-body" style="font-size:13px;color:var(--text-2);line-height:1.6">
          <p><strong style="color:var(--text)">Leaning the phone works.</strong> Not as a
          compromise — because every way a phone can lean is measurable, and
          measured error is correctable error.</p>

          <table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:12px">
            <tr style="color:var(--text-3)">
              <td style="padding:4px 0">axis</td>
              <td>if ignored</td>
              <td>if measured</td>
            </tr>
            <tr><td style="padding:4px 0">Lean 20°</td><td>0.9° launch</td>
                <td style="color:var(--primary)">exact</td></tr>
            <tr><td style="padding:4px 0">Tilt 10°</td><td>10° launch</td>
                <td style="color:var(--primary)">0.3°</td></tr>
            <tr><td style="padding:4px 0">Square 20°</td><td>6% speed (19 yd)</td>
                <td style="color:var(--primary)">1.3%</td></tr>
            <tr><td style="padding:4px 0">Distance 5%</td><td>5% speed (14 yd)</td>
                <td style="color:var(--danger)">not correctable</td></tr>
          </table>

          <p>So <strong style="color:var(--text)">lean however you need to</strong>. What you
          must get right is the distance, and what you must capture is the
          target line.</p>

          <p><strong style="color:var(--text)">What to prop it against</strong><br>
          A headcover works. So does a shoe, a water bottle, a range bucket, or the
          bag itself. Best of all: lay a club on the ground pointing at the target
          and stand the phone against the shaft — the shaft is a straight edge, so
          it makes you square for free.</p>

          <p><strong style="color:var(--text)">The one real risk is slipping.</strong> A
          headcover is soft and a phone can settle minutes after you set it down,
          which silently invalidates the distance. Put something solid in front of
          the bottom edge so it cannot slide forward. The <em>Steady</em> check above
          watches for movement and will tell you if it shifts.</p>

          <p><strong style="color:var(--text)">Height matters more than you would
          think.</strong> Get the lens near ball height. A phone flat on the ground
          pointing up loses the ball out of frame within a couple of frames.</p>
        </div>
      </details>
    `;
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  _bind() {
    this._q('#in-distance').value = this.distanceM;
    this._q('#in-distance').addEventListener('input', (e) => {
      this.distanceM = Number(e.target.value);
      // A slider is a stated distance, not a measured one. Treat it as good to
      // about 2% — roughly how well a person eyeballs 5 feet — rather than
      // pretending a typed number is exact.
      this.distanceSamples = 0;
      this._render();
    });

    this._q('#btn-set-target').onclick = async () => {
      if (this.tracker.permission !== 'granted') {
        await this._requestPermission();
        if (this.tracker.permission !== 'granted') return;
      }
      if (this.tracker.heading == null) {
        this._toast('No compass reading yet — wait a moment and try again.');
        return;
      }
      this.targetHeading = this.tracker.heading;
      try { navigator.vibrate?.(20); } catch { /* optional */ }
      this._render();
    };

    this._q('#btn-clear-target').onclick = () => {
      this.targetHeading = null;
      this._render();
    };

    this._q('#btn-save-profile').onclick = () => {
      const name = (this._q('#profile-name').value || '').trim() || `Setup ${loadProfiles().length + 1}`;
      saveProfile(name, this._reading());
      this._q('#profile-name').value = '';
      this.activeProfile = name;
      this._render();
    };
  }

  async _requestPermission() {
    const res = await this.tracker.requestPermission();
    this._render();
    return res;
  }

  // ── State ─────────────────────────────────────────────────────────────────

  /**
   * True when the phone is nowhere near square — which right after capturing
   * the target line means the user is still standing behind the ball holding
   * it, not that their rig is 90 degrees wrong. Treating those two states the
   * same produces an alarming and useless "off by 90 degrees" error at exactly
   * the moment the user is doing the right thing.
   */
  _isBeingCarried(yaw) {
    return yaw != null && Math.abs(yaw) > 45;
  }

  _reading() {
    const o = this.tracker.reading();
    const yaw = this.targetHeading != null
      ? yawFromSquare(this.targetHeading, o.headingDeg)
      : null;

    // Distance uncertainty: from averaged ball measurements when we have them,
    // otherwise from a human eyeballing a slider.
    const distUnc = this.distanceSamples > 0
      ? distanceUncertaintyPct(
          ballPixelsAtDistance(this.distanceM, 1920), this.distanceSamples)
      : 2.5;

    return {
      pitchDeg: o.pitchDeg,
      rollDeg: o.rollDeg,
      headingDeg: o.headingDeg,
      yawFromSquareDeg: yaw,
      yawUncertaintyDeg: headingUncertainty(this.tracker),
      distanceM: this.distanceM,
      distanceUncertaintyPct: distUnc,
      heightDeltaM: this.heightDeltaM,
      stable: o.stable,
    };
  }

  _scheduleRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._render();
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  _render() {
    if (!this.root.querySelector('#align-level')) return;

    const reading = this._reading();
    const evalResult = evaluateSetup(reading);
    const live = this.tracker.permission === 'granted' && this.tracker.hasReading;

    this._renderPermission();

    drawLevel(this._q('#align-level'), {
      // Deviation, so a correctly-held landscape phone shows a level horizon
      // rather than a vertical one.
      rollDeg: live ? rollDeviation(reading.rollDeg) : 0,
      pitchDeg: live ? reading.pitchDeg : 0,
      yawDeg: reading.yawFromSquareDeg,
      status: live ? evalResult.overall === 'ready' ? 'ok'
        : evalResult.overall === 'adjust' ? 'warn' : 'blocked' : 'warn',
    });

    this._q('#v-pitch').innerHTML = live
      ? `${reading.pitchDeg.toFixed(0)}<span class="tile-unit">°</span>` : '—';
    this._q('#v-roll').innerHTML = live
      ? `${rollDeviation(reading.rollDeg).toFixed(0)}<span class="tile-unit">°</span>` : '—';
    this._q('#v-yaw').innerHTML = reading.yawFromSquareDeg != null
      ? `${reading.yawFromSquareDeg.toFixed(0)}<span class="tile-unit">°</span>` : '—';

    const carriedNow = this._isBeingCarried(reading.yawFromSquareDeg);
    const verdict = this._q('#align-verdict');
    verdict.textContent = !live ? 'no sensor'
      : carriedNow ? 'in hand'
      : evalResult.overall === 'ready' ? 'ready'
      : evalResult.overall === 'adjust' ? 'adjust' : 'not ready';
    verdict.className = 'pill ' + (!live || carriedNow ? ''
      : evalResult.overall === 'ready' ? 'good'
      : evalResult.overall === 'adjust' ? 'warn' : 'bad');

    const headline = this._q('#align-headline');
    const carried = this._isBeingCarried(reading.yawFromSquareDeg);

    if (!live) {
      headline.className = 'note';
      headline.innerHTML = 'Grant motion access to read the phone position.';
    } else if (carried) {
      // Don't quote an error figure for a phone that is still in someone's hand.
      headline.className = 'note';
      headline.innerHTML = 'Target line saved. <strong>Now set the phone down beside ' +
        'the ball</strong>, lens pointing at it, and this will square you up.';
    } else {
      headline.className = 'note ' + (evalResult.overall === 'ready' ? 'good'
        : evalResult.overall === 'adjust' ? 'warn' : 'bad');
      headline.innerHTML = `${evalResult.headline}<br><span style="font-size:12px;color:var(--text-3)">` +
        `Setup error contributes about ±${evalResult.carryErrorYards.toFixed(0)} yd of carry ` +
        `(${evalResult.speedErrPct.toFixed(1)}% speed, ${evalResult.launchErrDeg.toFixed(1)}° launch).</span>`;
    }

    // Distance
    const ft = this.distanceM * 3.28084;
    this._q('#out-distance').textContent = `${ft.toFixed(1)} ft`;
    const distAxis = evalResult.axes.find((a) => a.id === 'distance');
    const dNote = this._q('#distance-note');
    dNote.className = 'note ' + (distAxis.status === 'ok' ? 'good'
      : distAxis.status === 'warn' ? 'warn' : 'bad');
    dNote.innerHTML = `${distAxis.message}<br><span style="font-size:12px;color:var(--text-3)">` +
      `Known to ±${reading.distanceUncertaintyPct.toFixed(1)}%, which is ` +
      `±${(reading.distanceUncertaintyPct * 3.01).toFixed(0)} yd of driver carry.</span>`;

    // Target line
    const tNote = this._q('#target-status');
    if (this.targetHeading == null) {
      tNote.className = 'note warn';
      tNote.textContent = 'Target line not set — squareness is being assumed, not measured.';
    } else {
      const yaw = reading.yawFromSquareDeg;
      if (this._isBeingCarried(yaw)) {
        tNote.className = 'note good';
        tNote.innerHTML = 'Target line locked. Now place the phone beside the ball — ' +
          'it will tell you when you are square.';
        this._renderProfiles(reading);
        return;
      }
      const ok = Math.abs(yaw) < 10;
      tNote.className = 'note ' + (ok ? 'good' : 'warn');
      tNote.innerHTML = `Target line locked.` +
        ` Currently <strong>${Math.abs(yaw) < 1 ? 'square' : `${Math.abs(yaw).toFixed(0)}° off`}</strong>` +
        `${Math.abs(yaw) >= 1 ? ` — rotate the phone ${yaw > 0 ? 'left' : 'right'}.` : '.'}` +
        `<br><span style="font-size:12px;color:var(--text-3)">Compass good to ` +
        `±${reading.yawUncertaintyDeg.toFixed(0)}°` +
        `${this.tracker.usingCompass ? '' : ' (no magnetic compass — relative only)'}.</span>`;
    }

    this._renderProfiles(reading);
  }

  _renderPermission() {
    const host = this._q('#align-permission');
    if (!host) return;
    if (this.tracker.permission === 'granted') { host.innerHTML = ''; return; }

    if (this.tracker.permission === 'insecure') {
      const url = location.host.replace(/:\d+$/, ':8443');
      host.innerHTML = `<div class="note bad">
        <strong>Motion sensors are blocked by the connection, not by your phone.</strong><br>
        iOS only exposes tilt and camera over <strong>https</strong>. You are on
        <code>${location.protocol}//${location.host}</code>, which Safari treats as
        insecure, so it hides the sensors entirely.
        <br><br>
        Open <strong>https://${url}</strong> instead. You will get a certificate
        warning once — tap <em>Advanced → Visit Website</em>, and everything works
        from then on.
      </div>`;
      return;
    }
    if (!this.tracker.supported) {
      host.innerHTML = '<div class="note bad"><strong>No motion sensors.</strong> ' +
        'This device cannot report its orientation, so lean and tilt cannot be measured.</div>';
      return;
    }
    if (this.tracker.permission === 'denied') {
      host.innerHTML = '<div class="note bad"><strong>Motion access denied.</strong> ' +
        'Safari → Settings → Motion &amp; Orientation Access, then reload.</div>';
      return;
    }
    host.innerHTML = `
      <div class="note"><strong>Motion access needed.</strong>
      iOS only allows this from a tap, so it cannot be requested automatically.</div>
      <button class="btn" id="btn-motion-permission" style="margin-bottom:14px">
        Enable tilt sensing</button>`;
    this._q('#btn-motion-permission').onclick = () => this._requestPermission();
  }

  _renderProfiles(reading) {
    const profiles = loadProfiles();
    const list = this._q('#profile-list');
    const compare = this._q('#profile-compare');

    if (!profiles.length) {
      list.innerHTML = '<div style="font-size:13px;color:var(--text-3)">No saved setups yet.</div>';
      compare.innerHTML = '';
      return;
    }

    list.innerHTML = profiles.map((p) => `
      <div class="shot-item" style="padding:10px 12px">
        <div style="flex:1">
          <div style="font-weight:600;font-size:14px">${escapeHtml(p.name)}</div>
          <div style="font-size:11px;color:var(--text-3)">
            ${(p.distanceM * 3.28084).toFixed(1)} ft ·
            lean ${p.pitchDeg?.toFixed(0) ?? '–'}° ·
            tilt ${p.rollDeg?.toFixed(0) ?? '–'}°
            ${p.yawFromSquareDeg != null ? ` · square ${p.yawFromSquareDeg.toFixed(0)}°` : ''}
          </div>
        </div>
        <button class="chip" data-recall="${escapeHtml(p.name)}" style="flex:0 0 auto;min-width:64px;padding:8px 10px;font-size:12px">
          ${this.activeProfile === p.name ? 'Matching' : 'Match'}</button>
        <button class="chip" data-delete="${escapeHtml(p.name)}" style="flex:0 0 auto;min-width:36px;padding:8px;font-size:12px">✕</button>
      </div>`).join('');

    list.querySelectorAll('[data-recall]').forEach((b) => {
      b.onclick = () => {
        this.activeProfile = this.activeProfile === b.dataset.recall ? null : b.dataset.recall;
        this._render();
      };
    });
    list.querySelectorAll('[data-delete]').forEach((b) => {
      b.onclick = () => {
        deleteProfile(b.dataset.delete);
        if (this.activeProfile === b.dataset.delete) this.activeProfile = null;
        this._render();
      };
    });

    const active = profiles.find((p) => p.name === this.activeProfile);
    if (!active) { compare.innerHTML = ''; return; }

    const { deltas, matched } = compareToProfile(active, reading);
    compare.innerHTML = `
      <div class="note ${matched ? 'good' : 'warn'}" style="margin-bottom:12px">
        ${matched
          ? `Matching <strong>${escapeHtml(active.name)}</strong> — this session is comparable to the last one.`
          : `To reproduce <strong>${escapeHtml(active.name)}</strong>:`}
        ${matched ? '' : `<div style="margin-top:8px">${deltas
          .filter((d) => d.instruction !== 'matched')
          .map((d) => `<div style="display:flex;justify-content:space-between;padding:3px 0">
              <span>${d.label}</span>
              <strong style="color:var(--text)">${d.instruction}</strong></div>`).join('')}</div>`}
      </div>`;
  }

  _toast(msg) {
    const h = this._q('#align-headline');
    if (!h) return;
    const prev = h.innerHTML;
    h.innerHTML = msg;
    setTimeout(() => { h.innerHTML = prev; }, 2200);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
