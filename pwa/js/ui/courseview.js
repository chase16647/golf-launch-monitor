// courseview.js — GPS round tracking on a real satellite map, with free
// course geometry from OpenStreetMap where it exists.
//
// Three ways a hole's tee/green get filled in, tried in this order:
//   1. OpenStreetMap has this course tagged -> auto-detected from your GPS
//      position, real surveyed tee/green/bunker/hazard shapes. Zero taps.
//   2. You've played this exact hole before in this app -> remembered from
//      last time (js/course/gps.js), even if OSM has nothing.
//   3. Neither -> mark the tee, walk to the pin, mark that. One-time cost;
//      remembered forever after via (2).
//
// This is deliberately not trying to be a full 18Birdies clone: no social
// feed, no leaderboard, no licensed hazard data for every course on Earth.
// It is the free, honest version of "GPS yardages on a satellite map".

import { loadLeaflet } from './maploader.js';
import {
  fetchNearbyCourseFeatures, nearestHole, centroid,
  SATELLITE_TILE_URL, SATELLITE_ATTRIBUTION,
} from '../course/coursedata.js';
import {
  getPosition, watchPosition, distanceYards,
  findRememberedHole, rememberHole,
} from '../course/gps.js';
import { addRound } from '../scorecard/store.js';
import { differential, handicapIndex, roundStats } from '../scorecard/handicap.js';
import { differentialInputs } from '../scorecard/store.js';

const q = (root, sel) => root.querySelector(sel);

export class CourseView {
  constructor(root) {
    this.root = root;
    this.map = null;
    this.layers = { tee: null, green: null, bunkers: [], hazards: [], shots: [], shotLine: null, me: null };
    this.stopWatch = null;

    this.round = null; // { courseName, holes: [...], currentHole: {...} }
    this.osmStatus = 'idle'; // idle | loading | ok | empty | failed
  }

  _q(sel) { return q(this.root, sel); }

  mount() {
    this.root.innerHTML = this._template();
    this._bind();
    this._renderState();
  }

  unmount() {
    this.stopWatch?.();
    this.map?.remove();
    this.map = null;
  }

  _template() {
    return `<div id="cv-content"></div>`;
  }

  _bind() { /* rebuilt per state */ }

  // ── State machine ────────────────────────────────────────────────────────

  _renderState() {
    if (!this.round) this._renderStart();
    else if (this.round.finished) this._renderSummary();
    else this._renderPlaying();
  }

  _renderStart() {
    const host = this._q('#cv-content');
    host.innerHTML = `
      <div class="card">
        <h3 class="card-title">Start a round</h3>
        <div class="field">
          <div class="field-head"><span class="field-label">Course name</span></div>
          <input type="text" id="cv-course-name" placeholder="e.g. Riverside Municipal"
            style="width:100%;padding:12px;border-radius:12px;background:var(--surface-2);color:var(--text);border:0.5px solid var(--separator);font-size:15px">
        </div>
        <div class="field">
          <div class="field-head"><span class="field-label">Holes</span></div>
          <div class="chips">
            <button class="chip active" data-holes="18">18</button>
            <button class="chip" data-holes="9">9</button>
          </div>
        </div>
        <button class="btn" id="cv-start">Start round at my location</button>
      </div>
      <div class="note">
        <strong>How the tee and pin get filled in.</strong> If this course is
        mapped on OpenStreetMap, real tee and green positions load automatically.
        If not, you mark your tee and walk to the pin once — after that, this
        app remembers the hole forever.
      </div>`;

    this._holes = 18;
    host.querySelectorAll('[data-holes]').forEach((b) => {
      b.onclick = () => {
        this._holes = Number(b.dataset.holes);
        host.querySelectorAll('[data-holes]').forEach((x) => x.classList.toggle('active', x === b));
      };
    });

    this._q('#cv-start').onclick = async () => {
      const btn = this._q('#cv-start');
      btn.disabled = true;
      btn.textContent = 'Finding you…';
      try {
        const pos = await getPosition();
        this.round = {
          courseName: (this._q('#cv-course-name').value || '').trim() || 'Unnamed course',
          totalHoles: this._holes,
          holeIndex: 0,
          holes: [],
          finished: false,
        };
        this._renderState();
        await this._beginHole(pos);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Start round at my location';
        host.insertAdjacentHTML('afterbegin', `<div class="note bad">${err.message}</div>`);
      }
    };
  }

  async _beginHole(currentPos) {
    const holeNum = this.round.holeIndex + 1;
    // `tee` starts as "wherever we're standing right now" rather than null.
    // _renderPlaying() renders and centres the map immediately, during the
    // 'loading' phase below, before OSM/remembered lookup has had a chance to
    // resolve a real tee position — a null centre there crashed the map init.
    // This also just gives the map something sensible to show while it loads.
    this.currentHoleState = {
      number: holeNum,
      tee: { lat: currentPos.lat, lon: currentPos.lon },
      green: null, par: null, source: null, shots: [],
    };

    // 1. Try OpenStreetMap.
    this.osmStatus = 'loading';
    this._renderPlaying();
    const features = await fetchNearbyCourseFeatures(currentPos.lat, currentPos.lon).catch(() => null);

    if (features === null) {
      this.osmStatus = 'failed';
    } else if (!features.tees.length) {
      this.osmStatus = 'empty';
    } else {
      const hole = nearestHole(features, currentPos, distanceYards, 80);
      if (hole) {
        this.osmStatus = 'ok';
        this.currentHoleState.tee = hole.teePosition;
        this.currentHoleState.green = hole.greenPosition;
        this.currentHoleState.par = hole.par;
        this.currentHoleState.source = 'osm';
        this._osmFeatures = features;
      } else {
        this.osmStatus = 'empty';
      }
    }

    // 2. Fall back to a remembered hole, keyed off wherever the tee would be
    // (approximate by current position when OSM found nothing).
    //
    // Gated on `source`, NOT `tee` — tee is pre-seeded above with a placeholder
    // so the map always has somewhere valid to centre on, which means it is
    // truthy from the very start and can never be used as the "have we
    // resolved a real source yet" signal. `source` starts null and is only
    // ever set by one of these three branches, which is what makes it safe
    // to gate on. (Using `tee` here silently skipped both fallbacks entirely
    // and left `source` null forever whenever OSM found nothing.)
    if (!this.currentHoleState.source) {
      const remembered = findRememberedHole(currentPos);
      if (remembered) {
        this.currentHoleState.tee = remembered.teePos;
        this.currentHoleState.green = remembered.pinPos;
        this.currentHoleState.par = remembered.par;
        this.currentHoleState.source = 'remembered';
      }
    }

    // 3. Otherwise: manual marking. The tee placeholder (current position) is
    // already correct for this case, so there's nothing to overwrite.
    if (!this.currentHoleState.source) {
      this.currentHoleState.source = 'manual';
    }

    this._renderPlaying();
    this._startLiveWatch();
  }

  _startLiveWatch() {
    this.stopWatch?.();
    this.stopWatch = watchPosition(
      (pos) => { this._mePos = pos; this._updateMapPositions(); this._updateDistanceReadout(); },
      (err) => { this._gpsError = err.message; this._renderPlaying(); }
    );
  }

  // ── Playing a hole ──────────────────────────────────────────────────────

  _renderPlaying() {
    const host = this._q('#cv-content');
    const h = this.currentHoleState;
    if (!h) return;

    const teeToGreen = h.green ? distanceYards(h.tee, h.green) : null;

    host.innerHTML = `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <span style="font-family:var(--font-round);font-size:18px;font-weight:700">
            Hole ${h.number}${h.par ? ` · Par ${h.par}` : ''}
          </span>
          <span class="pill ${h.source === 'osm' ? 'good' : h.source === 'remembered' ? 'good' : 'warn'}">
            ${h.source === 'osm' ? 'mapped' : h.source === 'remembered' ? 'remembered' : 'manual'}
          </span>
        </div>
        ${this._osmBanner()}
        <div id="cv-map" style="height:260px;border-radius:14px;overflow:hidden;background:var(--surface-2)"></div>
      </div>

      <div class="metrics">
        <div class="tile hero">
          <div class="tile-label">To pin</div>
          <div class="tile-value primary" id="cv-dist-pin">${teeToGreen ? Math.round(teeToGreen) : '—'}<span class="tile-unit">yd</span></div>
        </div>
        <div class="tile hero">
          <div class="tile-label">This hole</div>
          <div class="tile-value" id="cv-dist-hole">${teeToGreen ? Math.round(teeToGreen) : '—'}<span class="tile-unit">yd</span></div>
        </div>
      </div>

      ${h.source === 'manual' && !h.green ? `
        <div class="note">Standing on the tee. Walk to the pin, then tap below.</div>
        <button class="btn" id="cv-mark-pin">Mark pin from here</button>
      ` : `
        <button class="btn secondary" id="cv-mark-shot">Mark shot from here</button>
      `}

      <div id="cv-shots"></div>

      <button class="btn" id="cv-hole-out" style="margin-top:6px">Hole out</button>
    `;

    this._renderShotList();
    this._initMap();

    const markPin = this._q('#cv-mark-pin');
    if (markPin) markPin.onclick = () => this._markPin();
    const markShot = this._q('#cv-mark-shot');
    if (markShot) markShot.onclick = () => this._markShot();
    this._q('#cv-hole-out').onclick = () => this._openHoleOut();
  }

  _osmBanner() {
    if (this.osmStatus === 'loading') return '<div class="note">Checking OpenStreetMap for this course…</div>';
    if (this.osmStatus === 'failed') return '<div class="note warn">Could not reach OpenStreetMap (offline, or the free API is busy). Using manual marking for this hole.</div>';
    if (this.osmStatus === 'empty') return '<div class="note">This course isn\'t mapped on OpenStreetMap. Marking manually — it\'s remembered after today.</div>';
    return '';
  }

  _renderShotList() {
    const host = this._q('#cv-shots');
    if (!host) return;
    const h = this.currentHoleState;
    if (!h.shots.length) { host.innerHTML = ''; return; }
    host.innerHTML = h.shots.map((s, i) => `
      <div class="row">
        <span class="row-key">Shot ${i + 1}</span>
        <span class="row-val">${Math.round(s.distanceFromPrev)} yd${s.distanceToPin != null ? ` · ${Math.round(s.distanceToPin)} yd to pin` : ''}</span>
      </div>`).join('');
  }

  async _markPin() {
    const btn = this._q('#cv-mark-pin');
    btn.disabled = true; btn.textContent = 'Finding you…';
    try {
      const pos = await getPosition();
      this.currentHoleState.green = { lat: pos.lat, lon: pos.lon };
      rememberHole(this.currentHoleState.tee, {
        pinPos: this.currentHoleState.green,
        yards: distanceYards(this.currentHoleState.tee, this.currentHoleState.green),
        par: this.currentHoleState.par,
      });
      this._renderPlaying();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Mark pin from here';
      this._q('#cv-content').insertAdjacentHTML('afterbegin', `<div class="note bad">${err.message}</div>`);
    }
  }

  async _markShot() {
    const btn = this._q('#cv-mark-shot');
    btn.disabled = true; btn.textContent = 'Marking…';
    try {
      const pos = await getPosition();
      const h = this.currentHoleState;
      const prev = h.shots.length ? h.shots[h.shots.length - 1].pos : h.tee;
      const distanceFromPrev = distanceYards(prev, pos);
      const distanceToPin = h.green ? distanceYards(pos, h.green) : null;
      h.shots.push({ pos: { lat: pos.lat, lon: pos.lon }, distanceFromPrev, distanceToPin });
      btn.disabled = false; btn.textContent = 'Mark shot from here';
      this._renderShotList();
      this._updateMapPositions();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Mark shot from here';
      this._q('#cv-content').insertAdjacentHTML('afterbegin', `<div class="note bad">${err.message}</div>`);
    }
  }

  _updateDistanceReadout() {
    if (!this._mePos || !this.currentHoleState?.green) return;
    const toPin = distanceYards(this._mePos, this.currentHoleState.green);
    const el = this._q('#cv-dist-pin');
    if (el) el.innerHTML = `${Math.round(toPin)}<span class="tile-unit">yd</span>`;
  }

  // ── Map ───────────────────────────────────────────────────────────────────

  async _initMap() {
    const el = this._q('#cv-map');
    if (!el) return;
    let L;
    try {
      L = await loadLeaflet();
    } catch (err) {
      el.innerHTML = `<div class="note bad" style="margin:0">${err.message}</div>`;
      return;
    }
    if (!this._q('#cv-map')) return; // view moved on while the map library loaded

    const h = this.currentHoleState;
    const centre = h?.green || h?.tee;
    if (!centre) return; // nothing to centre on yet — the view moved on or state reset
    this.map?.remove();
    this.map = L.map(el, { zoomControl: false, attributionControl: true })
      .setView([centre.lat, centre.lon], 18);
    L.tileLayer(SATELLITE_TILE_URL, { attribution: SATELLITE_ATTRIBUTION, maxZoom: 19 }).addTo(this.map);

    this._L = L;
    this._drawHoleLayers();
  }

  _drawHoleLayers() {
    if (!this.map || !this._L) return;
    const L = this._L;
    const h = this.currentHoleState;

    // Clear previous layers.
    [this.layers.tee, this.layers.green, this.layers.me, this.layers.shotLine,
     ...this.layers.bunkers, ...this.layers.hazards, ...this.layers.shots]
      .forEach((l) => l && this.map.removeLayer(l));
    this.layers.bunkers = []; this.layers.hazards = []; this.layers.shots = [];

    if (h.tee) {
      this.layers.tee = L.circleMarker([h.tee.lat, h.tee.lon], {
        radius: 7, color: '#5cf285', fillColor: '#5cf285', fillOpacity: 1,
      }).addTo(this.map).bindTooltip('Tee');
    }
    if (h.green) {
      this.layers.green = L.circleMarker([h.green.lat, h.green.lon], {
        radius: 7, color: '#ff5252', fillColor: '#ff5252', fillOpacity: 1,
      }).addTo(this.map).bindTooltip('Pin');
    }

    if (this._osmFeatures) {
      for (const b of this._osmFeatures.bunkers) {
        this.layers.bunkers.push(
          L.polygon(b.points.map((p) => [p.lat, p.lon]), { color: '#e8d38c', fillOpacity: 0.5, weight: 1 }).addTo(this.map)
        );
      }
      for (const hz of this._osmFeatures.hazards) {
        this.layers.hazards.push(
          L.polygon(hz.points.map((p) => [p.lat, p.lon]), { color: '#38a1ff', fillOpacity: 0.4, weight: 1 }).addTo(this.map)
        );
      }
    }

    h.shots.forEach((s, i) => {
      this.layers.shots.push(
        L.circleMarker([s.pos.lat, s.pos.lon], { radius: 5, color: '#fff', fillColor: '#fff', fillOpacity: 1 })
          .addTo(this.map).bindTooltip(`Shot ${i + 1}`)
      );
    });

    const line = [h.tee, ...h.shots.map((s) => s.pos), h.green].filter(Boolean).map((p) => [p.lat, p.lon]);
    if (line.length > 1) {
      this.layers.shotLine = L.polyline(line, { color: '#fff', weight: 2, opacity: 0.5, dashArray: '4,6' }).addTo(this.map);
    }
  }

  _updateMapPositions() {
    if (!this.map || !this._L) return;
    if (this._mePos) {
      if (!this.layers.me) {
        this.layers.me = this._L.circleMarker([this._mePos.lat, this._mePos.lon], {
          radius: 6, color: '#38a1ff', fillColor: '#38a1ff', fillOpacity: 1,
        }).addTo(this.map);
      } else {
        this.layers.me.setLatLng([this._mePos.lat, this._mePos.lon]);
      }
    }
    this._drawHoleLayers();
  }

  // ── Holing out ──────────────────────────────────────────────────────────

  _openHoleOut() {
    const h = this.currentHoleState;
    const host = this._q('#cv-content');
    const existing = this._q('#cv-holeout-sheet');
    if (existing) { existing.remove(); return; }

    const yards = h.green ? Math.round(distanceYards(h.tee, h.green)) : null;

    const sheet = document.createElement('div');
    sheet.id = 'cv-holeout-sheet';
    sheet.className = 'card';
    sheet.innerHTML = `
      <h3 class="card-title">Hole ${h.number} score</h3>
      <div class="field">
        <div class="field-head"><span class="field-label">Par</span></div>
        <div class="chips">${[3,4,5].map((p) => `<button class="chip${p === (h.par||4) ? ' active' : ''}" data-par="${p}">${p}</button>`).join('')}</div>
      </div>
      <div class="field">
        <div class="field-head"><span class="field-label">Strokes</span></div>
        <div class="chips" id="cv-strokes-chips">${[2,3,4,5,6,7,8,9].map((s) => `<button class="chip${s === (h.par||4) ? ' active' : ''}" data-strokes="${s}">${s}</button>`).join('')}</div>
      </div>
      <div class="field">
        <div class="field-head"><span class="field-label">Putts</span></div>
        <div class="chips" id="cv-putts-chips">${[0,1,2,3,4].map((p) => `<button class="chip${p === 2 ? ' active' : ''}" data-putts="${p}">${p}</button>`).join('')}</div>
      </div>
      <div class="field" id="cv-fairway-field">
        <div class="field-head"><span class="field-label">Fairway</span></div>
        <div class="chips">
          <button class="chip active" data-fairway="hit">Hit</button>
          <button class="chip" data-fairway="miss">Missed</button>
        </div>
      </div>
      <div class="field">
        <div class="field-head"><span class="field-label">Green in regulation</span></div>
        <div class="chips">
          <button class="chip active" data-gir="yes">Yes</button>
          <button class="chip" data-gir="no">No</button>
        </div>
      </div>
      <button class="btn" id="cv-save-hole">Save & next hole</button>
    `;
    host.appendChild(sheet);

    let par = h.par || 4, strokes = par, putts = 2, fairwayHit = true, gir = true;
    sheet.querySelectorAll('[data-par]').forEach((b) => b.onclick = () => { par = Number(b.dataset.par); sync(); });
    sheet.querySelectorAll('[data-strokes]').forEach((b) => b.onclick = () => { strokes = Number(b.dataset.strokes); sel(sheet, '[data-strokes]', b); });
    sheet.querySelectorAll('[data-putts]').forEach((b) => b.onclick = () => { putts = Number(b.dataset.putts); sel(sheet, '[data-putts]', b); });
    sheet.querySelectorAll('[data-fairway]').forEach((b) => b.onclick = () => { fairwayHit = b.dataset.fairway === 'hit'; sel(sheet, '[data-fairway]', b); });
    sheet.querySelectorAll('[data-gir]').forEach((b) => b.onclick = () => { gir = b.dataset.gir === 'yes'; sel(sheet, '[data-gir]', b); });

    const sync = () => {
      sheet.querySelectorAll('[data-par]').forEach((x) => x.classList.toggle('active', Number(x.dataset.par) === par));
      this._q('#cv-fairway-field').style.display = par === 3 ? 'none' : '';
    };
    sync();

    this._q('#cv-save-hole').onclick = () => {
      this.round.holes.push({
        number: h.number, par, strokes, putts,
        fairwayHit: par === 3 ? null : fairwayHit,
        greenInRegulation: gir,
        yards,
        source: h.source,
      });
      this._advanceHole();
    };
  }

  async _advanceHole() {
    this.stopWatch?.();
    this.round.holeIndex++;
    if (this.round.holeIndex >= this.round.totalHoles) {
      this.round.finished = true;
      this._renderState();
      return;
    }
    try {
      const pos = await getPosition();
      await this._beginHole(pos);
    } catch (err) {
      this._q('#cv-content').insertAdjacentHTML('afterbegin', `<div class="note bad">${err.message}</div>`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  _renderSummary() {
    const host = this._q('#cv-content');
    const stats = roundStats(this.round.holes);
    if (!stats) { host.innerHTML = '<div class="empty">No holes recorded.</div>'; return; }

    host.innerHTML = `
      <div class="card" style="text-align:center">
        <div style="font-family:var(--font-round);font-size:44px;font-weight:700;color:var(--primary)">
          ${stats.toPar > 0 ? '+' : ''}${stats.toPar === 0 ? 'E' : stats.toPar}
        </div>
        <div style="color:var(--text-2)">${stats.totalStrokes} strokes · ${this.round.courseName}</div>
      </div>

      <div class="metrics three">
        <div class="tile compact"><div class="tile-label">Fairways</div><div class="tile-value">${stats.fairwayPct != null ? Math.round(stats.fairwayPct) + '%' : '—'}</div></div>
        <div class="tile compact"><div class="tile-label">GIR</div><div class="tile-value">${Math.round(stats.girPct)}%</div></div>
        <div class="tile compact"><div class="tile-label">Putts/hole</div><div class="tile-value">${stats.puttsPerHole.toFixed(1)}</div></div>
      </div>

      <div class="card">
        <h3 class="card-title">Attach a handicap differential (optional)</h3>
        <div style="font-size:13px;color:var(--text-2);margin-bottom:10px">
          Enter the course rating and slope from the scorecard to fold this round
          into your Handicap Index. Skip it and the round still saves, just
          without contributing to your index.
        </div>
        <div class="field">
          <div class="field-head"><span class="field-label">Course rating</span></div>
          <input type="number" step="0.1" id="cv-rating" placeholder="e.g. 71.5"
            style="width:100%;padding:12px;border-radius:12px;background:var(--surface-2);color:var(--text);border:0.5px solid var(--separator);font-size:15px">
        </div>
        <div class="field">
          <div class="field-head"><span class="field-label">Slope rating</span></div>
          <input type="number" id="cv-slope" placeholder="e.g. 125"
            style="width:100%;padding:12px;border-radius:12px;background:var(--surface-2);color:var(--text);border:0.5px solid var(--separator);font-size:15px">
        </div>
      </div>

      <button class="btn" id="cv-save-round">Save round</button>
      <button class="btn secondary" id="cv-discard-round">Discard</button>
    `;

    this._q('#cv-save-round').onclick = () => {
      const rating = parseFloat(this._q('#cv-rating').value) || null;
      const slope = parseInt(this._q('#cv-slope').value, 10) || null;
      addRound({
        courseName: this.round.courseName,
        holes: this.round.holes,
        totalStrokes: stats.totalStrokes,
        totalPar: stats.totalPar,
        rating, slope,
      });
      this.round = null;
      this._renderState();
    };
    this._q('#cv-discard-round').onclick = () => {
      this.round = null;
      this._renderState();
    };
  }
}

function sel(scope, selector, active) {
  scope.querySelectorAll(selector).forEach((x) => x.classList.toggle('active', x === active));
}

/** Current handicap index, for display elsewhere (e.g. the Bag tab). */
export function currentHandicapIndex() {
  const diffs = differentialInputs().map((r) => differential(r.score, r.rating, r.slope));
  return handicapIndex(diffs);
}
