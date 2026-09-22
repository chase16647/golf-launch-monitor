// app.js — views and wiring.

import { simulate, carryFactor } from './physics/flight.js';
import { CLUBS, BAG_ORDER, SWING_PROFILES, estimateTotalSpin, defaultLaunch, defaultBallSpeed } from './physics/clubs.js';
import { classify, SHAPES, dPlaneAxis } from './physics/shape.js';
import * as store from './store.js';
import { probeCamera, capabilityRows } from './camera.js';
import { drawSideProfile, drawTopDown, drawDispersion, drawCurveSketch, shapeColor } from './ui/charts.js';
import { AlignView } from './ui/alignview.js';
import { CaptureView } from './ui/captureview.js';
import { AnalyzeView } from './ui/analyzeview.js';
import { CourseView, currentHandicapIndex } from './ui/courseview.js';
import { allRounds, deleteRound } from './scorecard/store.js';
import { roundStats } from './scorecard/handicap.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  club: store.getSetting('club', 'sevenIron'),
  profile: store.getSetting('profile', 'mid'),
  ballSpeed: null,
  launch: null,
  axis: 0,
  azimuth: 0,
  altitude: store.getSetting('altitude', 0),
  temperature: store.getSetting('temperature', 20),
  spinOverride: null,
  lastResult: null,
  trajectoryMode: 'side',
  rangeTarget: 150,
};

// Seed speed/launch from the selected club the first time.
state.ballSpeed = store.getSetting('ballSpeed', defaultBallSpeed(state.club));
state.launch = store.getSetting('launch', defaultLaunch(state.club));

// ── Navigation ───────────────────────────────────────────────────────────────
//
// Two levels, not one flat list of tabs. The bottom bar picks a GROUP (Home,
// Play, Course, Stats, Setup — five things a golfer actually thinks in terms
// of); a group with more than one real screen inside it shows a segmented
// control at its top to switch between them. This exists because the app grew
// past seven flat tabs and finding anything meant reading every icon — grouping
// by "what this is for" fixes that without touching any of the underlying view
// classes, which are unchanged.

const GROUPS = {
  home: ['home'],
  play: ['capture', 'analyze'],
  'course-group': ['course'],
  stats: ['bag', 'range', 'rounds'],
  'setup-group': ['align', 'setup'],
};

/** Which group a subview lives in, the inverse of GROUPS — built once. */
const GROUP_OF = {};
for (const [group, subs] of Object.entries(GROUPS)) {
  for (const s of subs) GROUP_OF[s] = group;
}

const SUBTITLES = {
  home: 'Everything, from one place',
  capture: 'Record and replay the strike',
  analyze: 'Frame-by-frame, any video',
  course: 'GPS yardages on a satellite map',
  align: 'Get the same rig every time',
  range: 'Dispersion & targets',
  bag: 'Your yardage book',
  rounds: 'Scorecards & handicap',
  setup: 'Rig, limits & calculator',
};

/** Last subview shown in each group, so returning to a group (via the tab bar
 *  or a Home shortcut) restores what you were looking at rather than always
 *  resetting to the first screen. */
const lastSub = { play: 'capture', stats: 'bag', 'setup-group': 'align' };

function showGroup(group, preferredSub) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${group}`));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.group === group));

  const subs = GROUPS[group];
  const sub = preferredSub && subs.includes(preferredSub) ? preferredSub : (lastSub[group] || subs[0]);
  showSub(sub);
}

function showSub(name) {
  const group = GROUP_OF[name];
  lastSub[group] = name;

  const groupEl = $(`#view-${group}`);
  groupEl.querySelectorAll('.subview').forEach((el) => el.classList.toggle('active', el.id === `view-${name}`));
  groupEl.querySelectorAll('.group-seg button[data-sub]').forEach((b) => b.classList.toggle('active', b.dataset.sub === name));

  $('#app-subtitle').textContent = SUBTITLES[name] || '';
  mountSubview(name);

  // Release the camera whenever you leave Capture — otherwise the indicator
  // light stays on and the battery drains through a whole range session.
  if (name !== 'capture') captureView.recorder.stop();
  if (name !== 'course') courseView.unmount();

  window.scrollTo({ top: 0, behavior: 'instant' });
}

function mountSubview(name) {
  if (name === 'home') renderHome();
  if (name === 'bag') renderBag();
  if (name === 'range') renderRange();
  if (name === 'rounds') renderRounds();
  if (name === 'align') alignView.mount();
  if (name === 'capture') captureView.mount();
  if (name === 'analyze') analyzeView.mount();
  if (name === 'course') courseView.mount();
}

const alignView = new AlignView(document.getElementById('view-align'));
const captureView = new CaptureView(document.getElementById('view-capture'));
const analyzeView = new AnalyzeView(document.getElementById('view-analyze'), {
  getLastClip: () => (captureView.recorder.clip.length ? { recorder: captureView.recorder } : null),
});
const courseView = new CourseView(document.getElementById('view-course'));

// ── Home ─────────────────────────────────────────────────────────────────────
//
// One screen that surfaces the important bit of every section, so "where do I
// go to do X" stops being a question. Read-only summaries only — every number
// here is computed from data the other screens already own, nothing new is
// stored from Home itself.

function renderHome() {
  const host = $('#home-content');
  const shots = store.allShots();
  const lastShot = shots[0];
  const book = store.yardageBook();
  const rounds = allRounds();
  const handicap = currentHandicapIndex();

  const actions = `
    <div class="btn-row">
      <button class="btn" id="home-capture">Start swing capture</button>
    </div>
    <div class="btn-row">
      <button class="btn secondary" id="home-round">Start a round</button>
      <button class="btn secondary" id="home-import" style="max-width:150px">Import video</button>
    </div>`;

  const lastShotCard = lastShot ? `
    <div class="card">
      <h3 class="card-title">Last shot</h3>
      <div class="shot-item" style="margin:0">
        <div class="club-badge">${CLUBS[lastShot.club].short}</div>
        <div>
          <div style="font-weight:600;font-size:15px">${SHAPES[lastShot.shape].name}</div>
          <div style="font-size:11px;color:var(--text-3)">${Math.round(lastShot.ballSpeedMPH)} mph · ${lastShot.launchAngleDeg.toFixed(1)}°</div>
        </div>
        <div class="shot-carry" style="color:${shapeColor(lastShot.shape)}">${Math.round(lastShot.carryYards)}<span style="font-size:12px;color:var(--text-3)"> yd</span></div>
      </div>
    </div>` : '';

  const lastRound = rounds[0];
  const lastRoundStats = lastRound ? roundStats(lastRound.holes) : null;

  const summaryTiles = `
    <div class="metrics three">
      <div class="tile compact">
        <div class="tile-label">Handicap</div>
        <div class="tile-value">${handicap != null ? handicap.toFixed(1) : '—'}</div>
      </div>
      <div class="tile compact">
        <div class="tile-label">Shots logged</div>
        <div class="tile-value">${shots.length}</div>
      </div>
      <div class="tile compact">
        <div class="tile-label">Rounds</div>
        <div class="tile-value">${rounds.length}</div>
      </div>
    </div>`;

  const lastRoundCard = lastRound && lastRoundStats ? `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <h3 class="card-title" style="margin-bottom:2px">Last round</h3>
          <div style="font-size:13px;color:var(--text-2)">${escapeHtmlHome(lastRound.courseName)}</div>
        </div>
        <div style="font-family:var(--font-round);font-size:26px;font-weight:700;color:var(--primary)">
          ${lastRoundStats.toPar > 0 ? '+' : ''}${lastRoundStats.toPar === 0 ? 'E' : lastRoundStats.toPar}
        </div>
      </div>
    </div>` : '';

  const topClubsCard = book.length ? `
    <div class="card">
      <h3 class="card-title">Your bag</h3>
      ${book.slice(0, 3).map((a) => `
        <div class="row">
          <span class="row-key">${a.name}</span>
          <span class="row-val">${Math.round(a.medianCarryYards)} yd</span>
        </div>`).join('')}
      <button class="btn secondary" id="home-see-bag" style="margin-top:10px;padding:10px;font-size:13px">See full yardage book</button>
    </div>` : '';

  const emptyState = !shots.length && !rounds.length ? `
    <div class="note">
      <strong>Nothing logged yet.</strong> Start a swing capture, or open Play →
      Analyze to import a video you already shot. Everything you save shows up
      here.
    </div>` : '';

  host.innerHTML = `
    ${actions}
    ${emptyState}
    ${summaryTiles}
    ${lastShotCard}
    ${lastRoundCard}
    ${topClubsCard}
  `;

  $('#home-capture').onclick = () => showGroup('play', 'capture');
  $('#home-import').onclick = () => showGroup('play', 'analyze');
  $('#home-round').onclick = () => showGroup('course-group', 'course');
  $('#home-see-bag')?.addEventListener('click', () => showGroup('stats', 'bag'));
}

function escapeHtmlHome(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Rounds (Stats > Rounds) ──────────────────────────────────────────────────

function renderRounds() {
  const host = $('#rounds-content');
  const rounds = allRounds();

  if (!rounds.length) {
    host.innerHTML = '<div class="empty"><div class="empty-title">No rounds yet</div>Play a round from the Course tab and it shows up here.</div>';
    return;
  }

  host.innerHTML = rounds.map((r) => {
    const stats = roundStats(r.holes);
    if (!stats) return '';
    const date = new Date(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    return `
      <div class="shot-item" data-round="${r.id}">
        <div>
          <div style="font-weight:600;font-size:15px">${escapeHtmlHome(r.courseName)}</div>
          <div style="font-size:11px;color:var(--text-3)">${date} · ${stats.holesPlayed} holes · GIR ${Math.round(stats.girPct)}%</div>
        </div>
        <div class="shot-carry" style="color:${stats.toPar <= 0 ? 'var(--primary)' : 'var(--text)'}">
          ${stats.totalStrokes}<span style="font-size:12px;color:var(--text-3)"> (${stats.toPar > 0 ? '+' : ''}${stats.toPar === 0 ? 'E' : stats.toPar})</span>
        </div>
      </div>`;
  }).join('') + `
    <button class="btn danger" id="btn-clear-rounds" style="margin-top:10px">Delete all rounds</button>`;

  $('#btn-clear-rounds').onclick = () => {
    if (confirm('Delete every saved round? This cannot be undone.')) {
      rounds.forEach((r) => deleteRound(r.id));
      renderRounds();
    }
  };
}

// ── Shot view ───────────────────────────────────────────────────────────────

function renderClubChips() {
  const host = $('#club-chips');
  host.innerHTML = '';
  BAG_ORDER.forEach((key) => {
    const c = CLUBS[key];
    const b = document.createElement('button');
    b.className = 'chip' + (key === state.club ? ' active' : '');
    b.innerHTML = `${c.short}<small>${c.loft}°</small>`;
    b.onclick = () => {
      state.club = key;
      store.setSetting('club', key);
      // Re-seed the inputs to this club's typical numbers — otherwise you pick
      // a wedge and it is still showing 167 mph.
      state.ballSpeed = defaultBallSpeed(key);
      state.launch = defaultLaunch(key);
      state.spinOverride = null;
      renderClubChips();
      syncInputs();
      run();
    };
    host.appendChild(b);
  });
}

function currentSpin() {
  if (state.spinOverride != null) return state.spinOverride;
  return estimateTotalSpin(state.club, state.ballSpeed, state.launch, state.profile);
}

function atmosphere() {
  return { temperatureC: state.temperature, altitudeM: state.altitude, humidity: 0.5, pressureHPa: 1013.25 };
}

function syncInputs() {
  $('#in-speed').value = state.ballSpeed;
  $('#out-speed').textContent = `${Math.round(state.ballSpeed)} mph`;
  $('#in-launch').value = state.launch;
  $('#out-launch').textContent = `${state.launch.toFixed(1)}°`;
  $('#in-axis').value = state.axis;
  $('#out-axis').textContent = axisLabel(state.axis);
  $('#in-azimuth').value = state.azimuth;
  $('#out-azimuth').textContent = `${state.azimuth > 0 ? '+' : ''}${state.azimuth.toFixed(1)}°`;
  $('#in-spin').value = currentSpin();
  $('#out-spin').textContent = `${Math.round(currentSpin())} rpm${state.spinOverride == null ? ' (modelled)' : ''}`;
  $('#in-alt').value = state.altitude;
  $('#out-alt').textContent = `${Math.round(state.altitude)} m`;
  $('#in-temp').value = state.temperature;
  $('#out-temp').textContent = `${Math.round(state.temperature)}°C`;
  const cf = carryFactor(atmosphere());
  $('#out-carryfactor').textContent = `${cf >= 1 ? '+' : ''}${((cf - 1) * 100).toFixed(1)}%`;
}

function axisLabel(axis) {
  if (Math.abs(axis) < 1) return '0° (pure backspin)';
  return `${axis > 0 ? '+' : ''}${axis.toFixed(0)}° ${axis > 0 ? 'right' : 'left'}`;
}

function run() {
  const spin = currentSpin();
  const result = simulate({
    ballSpeedMPH: state.ballSpeed,
    launchAngleDeg: state.launch,
    azimuthDeg: state.azimuth,
    totalSpinRPM: spin,
    spinAxisDeg: state.axis,
    atmosphere: atmosphere(),
  });
  if (!result) return;

  const shape = classify(state.azimuth, result.curveYards);
  state.lastResult = { result, shape, spin };
  renderResult();
}

function renderResult() {
  const { result, shape, spin } = state.lastResult;
  const s = SHAPES[shape];
  const axisRad = (state.axis * Math.PI) / 180;

  $('#result').hidden = false;
  $('#m-carry').textContent = Math.round(result.carryYards);
  $('#m-total').textContent = Math.round(result.totalYards);
  $('#m-apex').textContent = Math.round(result.apexFeet);
  $('#m-hang').textContent = result.hangTimeSeconds.toFixed(1);
  $('#m-descent').textContent = Math.round(result.descentAngleDeg);
  $('#m-offline').textContent = `${result.sideYards >= 0 ? '+' : ''}${Math.round(result.sideYards)}`;
  $('#m-club-speed').textContent = Math.round(state.ballSpeed / CLUBS[state.club].smash);
  $('#m-roll').textContent = Math.round(result.rollYards);

  $('#shape-arrow').textContent = s.arrow;
  $('#shape-arrow').style.color = shapeColor(shape);
  $('#shape-name').textContent = s.name;
  // Below half a yard there is no meaningful direction, so don't draw an
  // arrow that implies one.
  const curveAbs = Math.abs(result.curveYards);
  $('#shape-curve').textContent = curveAbs < 0.5
    ? 'on line'
    : `${result.curveYards > 0 ? '→ ' : '← '}${curveAbs.toFixed(0)} yd`;
  $('#shape-curve').style.color = shapeColor(shape);

  $('#spin-detail').innerHTML =
    `<span class="pill">Back ${Math.round(spin * Math.cos(axisRad))} rpm</span> ` +
    `<span class="pill">Side ${Math.abs(Math.round(spin * Math.sin(axisRad)))} rpm ${state.axis > 0 ? 'R' : state.axis < 0 ? 'L' : ''}</span> ` +
    `<span class="pill">Axis ${state.axis > 0 ? '+' : ''}${state.axis.toFixed(0)}°</span>`;

  drawCurveSketch($('#c-curve'), result.curveYards, state.azimuth, shape);
  drawTrajectory();
}

function drawTrajectory() {
  if (!state.lastResult) return;
  const { result, shape } = state.lastResult;
  if (state.trajectoryMode === 'side') drawSideProfile($('#c-traj'), result);
  else drawTopDown($('#c-traj'), result, shape);
}

function saveShot() {
  if (!state.lastResult) return;
  const { result, shape, spin } = state.lastResult;
  const axisRad = (state.axis * Math.PI) / 180;
  store.addShot({
    club: state.club,
    ballSpeedMPH: state.ballSpeed,
    launchAngleDeg: state.launch,
    azimuthDeg: state.azimuth,
    totalSpinRPM: spin,
    spinAxisDeg: state.axis,
    sideSpinRPM: spin * Math.sin(axisRad),
    backSpinRPM: spin * Math.cos(axisRad),
    carryYards: result.carryYards,
    totalYards: result.totalYards,
    sideYards: result.sideYards,
    curveYards: result.curveYards,
    apexFeet: result.apexFeet,
    hangTimeSeconds: result.hangTimeSeconds,
    descentAngleDeg: result.descentAngleDeg,
    shape,
    source: 'manual',
  });
  const btn = $('#btn-save');
  btn.textContent = 'Saved to bag ✓';
  // Guarded: vibrate throws or warns when the call is not tied to a real tap
  // (and iOS Safari has no Vibration API at all). Haptics are a nicety.
  try { navigator.vibrate?.(12); } catch { /* no haptics available */ }
  setTimeout(() => (btn.textContent = 'Save to bag'), 1400);
}

// ── Camera view ─────────────────────────────────────────────────────────────

async function runCameraProbe() {
  const btn = $('#btn-probe');
  const out = $('#camera-output');
  btn.disabled = true;
  btn.textContent = 'Measuring…';
  out.innerHTML = '<div class="note">Hold still. Timing actual frame delivery for 2.5 seconds…</div>';

  const report = await probeCamera({
    requestedFPS: 240,
    onProgress: (p) => { btn.textContent = `Measuring… ${Math.round(p * 100)}%`; },
  });

  btn.disabled = false;
  btn.textContent = 'Run camera test again';

  const v = report.verdict;
  const cls = v.level === 'good' ? 'good' : v.level === 'marginal' ? 'warn' : 'bad';

  const rows = capabilityRows(report)
    .map(([k, val]) => `<div class="row"><span class="row-key">${k}</span><span class="row-val">${val}</span></div>`)
    .join('');

  out.innerHTML = `
    <div class="note ${cls}"><strong>${v.headline}</strong><br>${v.detail}</div>
    <div class="card">
      <h3 class="card-title">What this device reported</h3>
      ${rows}
    </div>
    <div class="note">
      <strong>Why this matters.</strong> Ball tracking needs 4+ points to fit a speed and
      5+ to fit a curve. The native iOS app uses 240&nbsp;fps with a locked 1/2000&nbsp;s
      shutter and LiDAR for scale — none of which the web exposes. That is a browser
      limitation, not a bug in this app.
    </div>`;
}

// ── Range view ──────────────────────────────────────────────────────────────

function renderRange() {
  const shots = store.allShots();
  drawDispersion($('#c-dispersion'), shots);

  const stats = $('#range-stats');
  if (!shots.length) {
    stats.innerHTML = '<div class="empty"><div class="empty-title">No shots yet</div>Simulate a shot and save it to see your pattern.</div>';
    $('#range-recent').innerHTML = '';
    return;
  }

  const sides = shots.map((s) => s.sideYards);
  const ms = sides.reduce((a, b) => a + b, 0) / sides.length;
  const ss = sides.length > 1
    ? Math.sqrt(sides.reduce((a, v) => a + (v - ms) ** 2, 0) / (sides.length - 1))
    : 0;
  const carries = shots.map((s) => s.carryYards);
  const mc = carries.reduce((a, b) => a + b, 0) / carries.length;

  stats.innerHTML = `
    <div class="metrics three">
      <div class="tile compact"><div class="tile-label">Shots</div><div class="tile-value">${shots.length}</div></div>
      <div class="tile compact"><div class="tile-label">Avg carry</div><div class="tile-value">${Math.round(mc)}<span class="tile-unit">yd</span></div></div>
      <div class="tile compact"><div class="tile-label">Lateral 1σ</div><div class="tile-value">±${Math.round(ss)}<span class="tile-unit">yd</span></div></div>
    </div>
    <div class="note">68% of your shots land within <strong>±${ss.toFixed(0)} yd</strong> laterally,
    averaging <strong>${ms >= 0 ? ms.toFixed(0) + ' yd right' : Math.abs(ms).toFixed(0) + ' yd left'}</strong> of the target line.</div>`;

  $('#range-recent').innerHTML = shots.slice(0, 12).map((s) => `
    <div class="shot-item">
      <div class="club-badge">${CLUBS[s.club].short}</div>
      <div>
        <div style="font-weight:600;font-size:14px">${SHAPES[s.shape].name}</div>
        <div style="font-size:11px;color:var(--text-3)">${Math.round(s.ballSpeedMPH)} mph · ${s.launchAngleDeg.toFixed(1)}° · ${Math.round(s.totalSpinRPM)} rpm</div>
      </div>
      <div class="shot-carry" style="color:${shapeColor(s.shape)}">${Math.round(s.carryYards)}<span style="font-size:12px;color:var(--text-3)"> yd</span></div>
    </div>`).join('');
}

// ── Bag view ────────────────────────────────────────────────────────────────

function renderHandicapCard() {
  const rounds = allRounds();
  if (!rounds.length) return '';
  const index = currentHandicapIndex();
  const withRating = rounds.filter((r) => r.rating != null && r.slope != null).length;

  return `
    <div class="card">
      <h3 class="card-title">Handicap</h3>
      <div class="metrics three">
        <div class="tile compact"><div class="tile-label">Index</div><div class="tile-value primary">${index != null ? index.toFixed(1) : '—'}</div></div>
        <div class="tile compact"><div class="tile-label">Rounds</div><div class="tile-value">${rounds.length}</div></div>
        <div class="tile compact"><div class="tile-label">Last</div><div class="tile-value" style="font-size:18px">${rounds[0].totalStrokes ?? '—'}</div></div>
      </div>
      ${index == null ? `<div class="note" style="margin-top:12px">Needs at least 3 rounds with a course rating and slope entered (${withRating} so far) to compute an index.</div>` : ''}
    </div>`;
}

function renderBag() {
  const book = store.yardageBook();
  const host = $('#bag-content');
  const handicapCard = renderHandicapCard();

  if (!book.length) {
    host.innerHTML = handicapCard || '<div class="empty"><div class="empty-title">Your bag is empty</div>Save a few shots and your yardages will build here.</div>';
    return;
  }

  const maxCarry = Math.max(...book.map((b) => b.carryYards));

  const chart = book.map((a) => `
    <div class="row" style="border:none;padding:5px 0">
      <div class="club-badge" style="width:34px;font-size:13px">${a.short}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(a.carryYards / maxCarry) * 100}%"></div></div>
      <span style="font-family:var(--mono);font-size:12px;color:var(--text-2);width:34px;text-align:right">${Math.round(a.carryYards)}</span>
    </div>`).join('');

  const rows = book.map((a) => `
    <div class="shot-item">
      <div class="club-badge">${a.short}<small>${a.count}</small></div>
      <div>
        <div style="font-weight:600;font-size:16px">${Math.round(a.medianCarryYards)} yd
          <span style="font-size:13px;color:${shapeColor(a.dominantShape)}">${SHAPES[a.dominantShape].arrow}</span>
        </div>
        <div style="font-size:11px;color:var(--text-3)">
          ${Math.round(a.ballSpeedMPH)} mph · ${a.launchAngleDeg.toFixed(1)}° · ${Math.round(a.spinRPM)} rpm · ±${a.lateralStdDev.toFixed(0)} yd
        </div>
      </div>
    </div>`).join('');

  const gaps = store.gapping().filter((g) => g.gap > 18 || g.gap < 6);
  const gapHtml = gaps.length ? `
    <div class="card">
      <h3 class="card-title">Gaps worth a look</h3>
      ${gaps.map((g) => `
        <div class="row">
          <span style="font-weight:600;font-size:14px">${g.from.short} → ${g.to.short}</span>
          <span class="row-val" style="color:${g.gap > 18 ? 'var(--warning)' : 'var(--accent)'}">${Math.round(g.gap)} yd</span>
        </div>`).join('')}
      <div style="font-size:12px;color:var(--text-3);margin-top:10px">
        Over 18 yd leaves yardages you cannot cover. Under 6 yd means two clubs doing one job.
      </div>
    </div>` : '';

  host.innerHTML = `
    ${handicapCard}
    <div class="card"><h3 class="card-title">Carry gapping</h3>${chart}</div>
    ${rows}
    ${gapHtml}
    <button class="btn danger" id="btn-clear">Clear all shots</button>`;

  $('#btn-clear').onclick = () => {
    if (confirm('Delete every saved shot? This cannot be undone.')) {
      store.clearAll();
      renderBag();
    }
  };
}

// ── Boot ────────────────────────────────────────────────────────────────────

function bindInputs() {
  const bind = (id, key, fmt, transform = Number) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', (e) => {
      state[key] = transform(e.target.value);
      if (key === 'ballSpeed' || key === 'launch') store.setSetting(key, state[key]);
      if (key === 'altitude' || key === 'temperature') store.setSetting(key, state[key]);
      syncInputs();
      run();
    });
  };

  bind('#in-speed', 'ballSpeed');
  bind('#in-launch', 'launch');
  bind('#in-axis', 'axis');
  bind('#in-azimuth', 'azimuth');
  bind('#in-alt', 'altitude');
  bind('#in-temp', 'temperature');

  $('#in-spin').addEventListener('input', (e) => {
    state.spinOverride = Number(e.target.value);
    syncInputs();
    run();
  });
  $('#btn-spin-auto').onclick = () => {
    state.spinOverride = null;
    syncInputs();
    run();
  };

  $('#in-profile').addEventListener('change', (e) => {
    state.profile = e.target.value;
    store.setSetting('profile', state.profile);
    state.spinOverride = null;
    syncInputs();
    run();
  });

  $$('#seg-traj button').forEach((b) => {
    b.onclick = () => {
      state.trajectoryMode = b.dataset.mode;
      $$('#seg-traj button').forEach((x) => x.classList.toggle('active', x === b));
      drawTrajectory();
    };
  });

  $('#btn-save').onclick = saveShot;
  $('#btn-probe').onclick = runCameraProbe;

  $$('.tab').forEach((t) => (t.onclick = () => showGroup(t.dataset.group)));

  // The seg control at the top of each multi-screen group (Play/Stats/Setup).
  $$('.group-seg button[data-sub]').forEach((b) => (b.onclick = () => showSub(b.dataset.sub)));
}

function init() {
  // Profile dropdown.
  $('#in-profile').innerHTML = Object.entries(SWING_PROFILES)
    .map(([k, v]) => `<option value="${k}"${k === state.profile ? ' selected' : ''}>${v.name}</option>`)
    .join('');

  renderClubChips();
  bindInputs();
  syncInputs();
  run();
  showGroup('home');

  window.addEventListener('resize', () => {
    drawTrajectory();
    if ($('#view-range').classList.contains('active')) renderRange();
  });

  if ('serviceWorker' in navigator) {
    // Offline support is a bonus, not a requirement — but log the reason
    // rather than swallowing it, so a real failure is diagnosable.
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.info('Service worker not registered (offline mode unavailable):', err.message);
    });
  }
}

init();
