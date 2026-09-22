// store.js (scorecard) — persisted rounds, independent of the shot-by-shot
// range store. A "round" here is 18 (or 9) holes of par/strokes/putts/fairway/
// GIR, optionally with GPS-measured yardages attached per hole from the
// Course tab.

const KEY = 'launchmonitor.rounds.v1';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
  catch { return []; }
}
function save(rounds) {
  try { localStorage.setItem(KEY, JSON.stringify(rounds)); } catch { /* private mode */ }
}

export function allRounds() {
  return load().sort((a, b) => b.date - a.date);
}

export function addRound(round) {
  const rounds = load();
  const record = { id: crypto.randomUUID(), date: Date.now(), ...round };
  rounds.push(record);
  save(rounds);
  return record;
}

export function deleteRound(id) {
  save(load().filter((r) => r.id !== id));
}

export function updateRound(id, patch) {
  const rounds = load();
  const i = rounds.findIndex((r) => r.id === id);
  if (i === -1) return null;
  rounds[i] = { ...rounds[i], ...patch };
  save(rounds);
  return rounds[i];
}

/** Differentials for handicapIndex(), most recent last, from rounds that have
 *  a course rating/slope attached (required — without them there's no formula). */
export function differentialInputs() {
  return allRounds()
    .filter((r) => r.rating != null && r.slope != null && r.totalStrokes != null)
    .sort((a, b) => a.date - b.date)
    .map((r) => ({ score: r.totalStrokes, rating: r.rating, slope: r.slope, date: r.date }));
}
