// store.js — shots, sessions and the yardage book. localStorage backed.

import { CLUBS, BAG_ORDER } from './physics/clubs.js';

const KEY = 'launchmonitor.v1';

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { shots: [], settings: {} };
    const parsed = JSON.parse(raw);
    return { shots: parsed.shots || [], settings: parsed.settings || {} };
  } catch {
    // Private browsing, or corrupted data. Start clean rather than crash.
    return { shots: [], settings: {} };
  }
}

let state = load();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* Quota or private mode — the session still works in memory. */
  }
}

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  listeners.forEach((fn) => fn(state));
}

// ── Shots ───────────────────────────────────────────────────────────────────

export function addShot(shot) {
  const record = { id: crypto.randomUUID(), date: Date.now(), ...shot };
  state.shots.unshift(record);
  persist();
  emit();
  return record;
}

export function deleteShot(id) {
  state.shots = state.shots.filter((s) => s.id !== id);
  persist();
  emit();
}

export function clearAll() {
  state.shots = [];
  persist();
  emit();
}

export function allShots() {
  return state.shots;
}

export function shotsForClub(clubKey) {
  return state.shots.filter((s) => s.club === clubKey);
}

// ── Settings ────────────────────────────────────────────────────────────────

export function getSetting(key, fallback) {
  return state.settings[key] ?? fallback;
}
export function setSetting(key, value) {
  state.settings[key] = value;
  persist();
  emit();
}

// ── Yardage book ────────────────────────────────────────────────────────────

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function stdDev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

function modeOf(values) {
  const counts = {};
  values.forEach((v) => (counts[v] = (counts[v] || 0) + 1));
  let best = null;
  for (const [k, v] of Object.entries(counts)) {
    if (!best || v > best[1]) best = [k, v];
  }
  return best ? best[0] : 'straight';
}

export function clubAverage(clubKey) {
  const shots = shotsForClub(clubKey);
  if (!shots.length) return null;

  const carries = shots.map((s) => s.carryYards).sort((a, b) => a - b);
  const sides = shots.map((s) => s.sideYards);

  return {
    club: clubKey,
    name: CLUBS[clubKey].name,
    short: CLUBS[clubKey].short,
    count: shots.length,
    carryYards: mean(carries),
    // Median is the number to trust for gapping — one thinned 7-iron should
    // not move your yardage book.
    medianCarryYards: carries[Math.floor(carries.length / 2)],
    totalYards: mean(shots.map((s) => s.totalYards)),
    ballSpeedMPH: mean(shots.map((s) => s.ballSpeedMPH)),
    launchAngleDeg: mean(shots.map((s) => s.launchAngleDeg)),
    spinRPM: mean(shots.map((s) => s.totalSpinRPM)),
    apexFeet: mean(shots.map((s) => s.apexFeet)),
    carrySpread: carries[carries.length - 1] - carries[0],
    lateralStdDev: stdDev(sides),
    dominantShape: modeOf(shots.map((s) => s.shape)),
  };
}

/** Full bag, longest first. */
export function yardageBook() {
  return BAG_ORDER.map(clubAverage)
    .filter(Boolean)
    .sort((a, b) => b.carryYards - a.carryYards);
}

/** The number to play for a club. */
export function playingYardage(clubKey) {
  const avg = clubAverage(clubKey);
  return avg ? avg.medianCarryYards : null;
}

/**
 * Gaps between consecutive clubs. Over ~18 yd leaves yardages you cannot
 * cover; under ~6 yd means two clubs doing one job.
 */
export function gapping() {
  const book = yardageBook();
  const out = [];
  for (let i = 0; i < book.length - 1; i++) {
    out.push({ from: book[i], to: book[i + 1], gap: book[i].carryYards - book[i + 1].carryYards });
  }
  return out;
}

/** Best club for a target distance, from the player's own measured numbers. */
export function suggestClub(targetYards) {
  const book = yardageBook();
  if (!book.length) return null;
  return book.reduce((best, a) =>
    Math.abs(a.medianCarryYards - targetYards) < Math.abs(best.medianCarryYards - targetYards) ? a : best
  );
}
