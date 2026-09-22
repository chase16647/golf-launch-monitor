// coursedata.js — free, real course geometry from OpenStreetMap, to overlay
// on free satellite imagery. No API key, no cost, for either piece.
//
// ── Coverage, stated plainly ─────────────────────────────────────────────────
// OSM's golf tagging (golf=tee, golf=green, golf=bunker, golf=hole, etc.) is
// contributed by volunteers. Well-known and public courses are often mapped
// in real detail. Plenty of smaller or private courses have nothing at all.
// When a course has nothing tagged, `fetchNearbyCourseFeatures` returns empty
// arrays (not an error), and the caller should fall back to GPS breadcrumb
// tracking (see js/course/gps.js), which always works because it needs no
// pre-existing data.
//
// ── A verification gap worth knowing about ──────────────────────────────────
// The public Overpass mirrors (the free API OSM data is queried through)
// block requests from datacenter/cloud IP ranges as anti-scraping protection.
// That is exactly what this code looked like when it was developed, so the
// query below returned 406 Not Acceptable in dev and could not be tested
// end-to-end. It is standard Overpass QL and should work normally from a
// phone's browser, which is ordinary residential/mobile traffic — but treat
// this specific piece as UNVERIFIED until tested on a real device. The Esri
// satellite tile request below was verified directly (plain HTTPS GET
// returned a real image).

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

/** Esri World Imagery — free satellite tiles, no key, standard REST tile URL. */
export const SATELLITE_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const SATELLITE_ATTRIBUTION =
  'Imagery &copy; Esri, Maxar, Earthstar Geographics | Course data &copy; OpenStreetMap contributors';

const CACHE_KEY = 'launchmonitor.osmcourses.v1';
// Course geometry essentially never changes; a long TTL just means one fetch
// per lifetime of visiting a course rather than one fetch per round.
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
  catch { return {}; }
}
function saveCache(c) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); }
  catch { /* private mode, or quota — the fetch still works, just re-fetches next time */ }
}
/** ~1.1 km grid cell, so nearby fetches during one round reuse the same entry. */
function cacheKeyFor(lat, lon) {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

/**
 * Fetch OSM golf features within `radiusM` of a point.
 *
 * @returns {Promise<CourseFeatures|null>} null means every Overpass mirror
 *   failed (network/API problem — retry later). An object with empty arrays
 *   means the mirrors answered fine and this course simply isn't mapped.
 */
export async function fetchNearbyCourseFeatures(lat, lon, { radiusM = 1200, forceRefresh = false } = {}) {
  const key = cacheKeyFor(lat, lon);
  const cache = loadCache();
  const hit = cache[key];
  if (!forceRefresh && hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return hit.data;
  }

  // Degrees-per-metre: ~111.32 km per degree of latitude everywhere, and per
  // degree of longitude scaled by cos(latitude) since meridians converge
  // toward the poles.
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  const bbox = `${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon}`;

  const query = `[out:json][timeout:25];(
    way["golf"](${bbox});
    node["golf"](${bbox});
  );out geom;`;

  let json = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) continue;
      const candidate = await res.json();
      if (candidate?.elements) { json = candidate; break; }
    } catch {
      // Try the next mirror — any one public instance can be down or busy.
    }
  }
  if (!json) return null;

  const data = groupFeatures(json.elements || []);
  cache[key] = { fetchedAt: Date.now(), data };
  saveCache(cache);
  return data;
}

/**
 * @typedef {{tags: object, points: {lat:number, lon:number}[]}} Feature
 * @typedef {{holes:Feature[], tees:Feature[], greens:Feature[], bunkers:Feature[], hazards:Feature[], fairways:Feature[], other:Feature[]}} CourseFeatures
 */

export function groupFeatures(elements) {
  const out = { holes: [], tees: [], greens: [], bunkers: [], hazards: [], fairways: [], other: [] };
  for (const el of elements) {
    const golf = el.tags?.golf;
    const points = el.geometry
      ? el.geometry.filter((p) => p && p.lat != null).map((p) => ({ lat: p.lat, lon: p.lon }))
      : (el.lat != null ? [{ lat: el.lat, lon: el.lon }] : []);
    if (!points.length) continue;

    const feature = { tags: el.tags || {}, points };
    switch (golf) {
      case 'hole': out.holes.push(feature); break;
      case 'tee': out.tees.push(feature); break;
      case 'green': case 'pin': out.greens.push(feature); break;
      case 'bunker': out.bunkers.push(feature); break;
      case 'water_hazard': case 'lateral_water_hazard': out.hazards.push(feature); break;
      case 'fairway': out.fairways.push(feature); break;
      default: out.other.push(feature);
    }
  }
  return out;
}

/** Centroid of a feature's points — good enough for a green/tee's centre. */
export function centroid(feature) {
  const pts = feature.points;
  const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
  return { lat, lon };
}

/**
 * Find the tee/green pair nearest a given position, for "which hole am I
 * standing on" auto-detection. Returns null if there is nothing within
 * `maxM` of the position.
 */
export function nearestHole(features, position, distanceYardsFn, maxM = 60) {
  if (!features?.tees?.length) return null;
  const maxYd = maxM / 0.9144;

  let best = null;
  for (const tee of features.tees) {
    const teeCentre = centroid(tee);
    const d = distanceYardsFn(position, teeCentre);
    if (d > maxYd) continue;
    if (!best || d < best.distanceYards) best = { tee, distanceYards: d };
  }
  if (!best) return null;

  // Nearest green to that tee, by centroid distance — a reasonable proxy for
  // "the green this tee plays to" without needing hole-relation data, which
  // many OSM courses don't have even when tees and greens are both mapped.
  let nearestGreen = null;
  const teeCentre = centroid(best.tee);
  for (const green of features.greens || []) {
    const d = distanceYardsFn(teeCentre, centroid(green));
    if (!nearestGreen || d < nearestGreen.d) nearestGreen = { green, d };
  }

  return {
    tee: best.tee,
    teePosition: teeCentre,
    green: nearestGreen?.green || null,
    greenPosition: nearestGreen ? centroid(nearestGreen.green) : null,
    par: best.tee.tags?.par ? Number(best.tee.tags.par) : null,
    ref: best.tee.tags?.ref || best.tee.tags?.name || null,
  };
}

export function clearCourseCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* private mode */ }
}
