// gps.js — course/yardage tracking without a paid course database.
//
// The honest trade-off: real course-map products (18Birdies, Golfshot) license
// surveyed hole geometry — green contours, bunker edges, hazard lines — from a
// paid data provider. We are not paying for that, so this does the free thing
// that is still genuinely useful: GPS breadcrumbs.
//
//   * Mark the tee, mark the pin. Distance between them is the hole yardage.
//   * Mark your ball after every shot. Distance to the previous mark is that
//     shot's distance; distance to the pin is what is left.
//   * Save the hole once, keyed by its rounded GPS position, and it is
//     recognised next time you play it — so playing a course repeatedly
//     slowly builds your own accurate yardage book for it, for free.
//
// No satellite hole map, no hazard overlay, no green contour. What you get
// instead is real, GPS-measured distance, which is the number that actually
// matters over the false confidence of a hazard drawn from someone else's
// survey of a green that may have been rebuilt since.

const YARD = 0.9144;
const EARTH_RADIUS_M = 6371000;

/** Great-circle distance between two lat/lon points, in yards. */
export function distanceYards(a, b) {
  if (!a || !b) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  return (EARTH_RADIUS_M * c) / YARD;
}

/** Compass bearing from a to b, degrees, 0 = north. Used to draw the hole line. */
export function bearingDegrees(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  let deg = (Math.atan2(y, x) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

/**
 * Project a point `distYards` along the bearing from a to b, for drawing a
 * simple straight fairway line on the map even before every shot is marked.
 */
export function project(origin, bearingDeg, distYards) {
  const d = (distYards * YARD) / EARTH_RADIUS_M;
  const brng = (bearingDeg * Math.PI) / 180;
  const lat1 = (origin.lat * Math.PI) / 180;
  const lon1 = (origin.lon * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: (lat2 * 180) / Math.PI, lon: (((lon2 * 180) / Math.PI + 540) % 360) - 180 };
}

// ── Geolocation wrapper ──────────────────────────────────────────────────────

export function isGeolocationAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.geolocation;
}

/** One position fix. Rejects rather than hanging if GPS can't get a lock. */
export function getPosition({ timeoutMs = 12000, highAccuracy = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!isGeolocationAvailable()) {
      reject(new Error('Geolocation is not available on this device/browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracyM: pos.coords.accuracy,
        t: pos.timestamp,
      }),
      (err) => reject(new Error(mapGeoError(err))),
      { enableHighAccuracy: highAccuracy, timeout: timeoutMs, maximumAge: 0 }
    );
  });
}

function mapGeoError(err) {
  switch (err.code) {
    case err.PERMISSION_DENIED: return 'Location access denied. Enable it in Settings for this to work.';
    case err.POSITION_UNAVAILABLE: return 'No GPS fix. Move to open sky and try again.';
    case err.TIMEOUT: return 'GPS took too long to respond. Try again.';
    default: return `Location error: ${err.message}`;
  }
}

/**
 * Continuous watch, for showing live distance-to-pin as you walk. Returns an
 * unsubscribe function.
 */
export function watchPosition(onUpdate, onError) {
  if (!isGeolocationAvailable()) {
    onError?.(new Error('Geolocation is not available on this device/browser.'));
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => onUpdate({
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      accuracyM: pos.coords.accuracy,
      t: pos.timestamp,
    }),
    (err) => onError?.(new Error(mapGeoError(err))),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
  return () => navigator.geolocation.clearWatch(id);
}

// ── Persisted course book ───────────────────────────────────────────────────
//
// A "course" here is just a bag of holes the user has walked before, keyed by
// a rounded tee position so the same course is recognised across rounds
// without any name matching or database lookup.

const KEY = 'launchmonitor.courses.v1';

function loadBook() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); }
  catch { return {}; }
}
function saveBook(book) {
  try { localStorage.setItem(KEY, JSON.stringify(book)); } catch { /* private mode */ }
}

/** Rounds a coordinate to ~11m precision, coarse enough to survive GPS jitter
 *  between visits, fine enough that two different holes never collide. */
function holeKey(teePos) {
  return `${teePos.lat.toFixed(4)},${teePos.lon.toFixed(4)}`;
}

/** Look up a remembered hole from its tee position, if we've played it before. */
export function findRememberedHole(teePos) {
  const book = loadBook();
  return book[holeKey(teePos)] || null;
}

/** Remember a completed hole for next time. */
export function rememberHole(teePos, hole) {
  const book = loadBook();
  book[holeKey(teePos)] = {
    teePos,
    pinPos: hole.pinPos,
    yards: hole.yards,
    par: hole.par,
    lastPlayed: Date.now(),
    timesPlayed: (book[holeKey(teePos)]?.timesPlayed || 0) + 1,
  };
  saveBook(book);
}

export function allRememberedHoles() {
  return Object.values(loadBook()).sort((a, b) => b.lastPlayed - a.lastPlayed);
}

export function forgetHole(teePos) {
  const book = loadBook();
  delete book[holeKey(teePos)];
  saveBook(book);
}
