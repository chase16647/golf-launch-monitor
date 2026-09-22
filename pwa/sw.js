// sw.js — offline shell. The whole app is static, so a cache-first strategy
// with a network fallback is all it needs. Bump CACHE when you ship changes.

const CACHE = 'launchmonitor-v3';

const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/camera.js',
  './js/ui/charts.js',
  './js/ui/level.js',
  './js/ui/alignview.js',
  './js/ui/captureview.js',
  './js/ui/analyzeview.js',
  './js/ui/courseview.js',
  './js/ui/maploader.js',
  './js/capture/recorder.js',
  './js/setup/orientation.js',
  './js/setup/alignment.js',
  './js/physics/flight.js',
  './js/physics/clubs.js',
  './js/physics/shape.js',
  './js/pose/poseOverlay.js',
  './js/course/gps.js',
  './js/course/coursedata.js',
  './js/scorecard/handicap.js',
  './js/scorecard/store.js',
  './manifest.webmanifest',
  './icons/icon.svg',
];
// Leaflet (map) and MediaPipe (pose) are intentionally NOT pre-cached here —
// they are large, third-party, and only needed by two tabs (Course, Analyze).
// They cache themselves on first use instead, via the runtime fetch handler
// below, so a first app load stays small.

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll rejects the whole batch if any single file 404s, which would
      // leave the app with no cache at all. Add individually and tolerate gaps.
      .then((c) => Promise.allSettled(ASSETS.map((a) => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// CDN hosts whose responses are worth caching indefinitely: fixed library/
// model files, fetched once and reused forever. Deliberately NOT allowlisted:
// satellite map tiles (unbounded — a user panning the map would fill storage)
// and the Overpass API (course data has its own long-TTL cache in
// localStorage, done by coursedata.js at the app level instead).
const CACHEABLE_CROSS_ORIGIN = [
  'cdn.jsdelivr.net',
  'storage.googleapis.com',
];

function isCacheable(url) {
  if (url.startsWith(self.location.origin)) return true;
  try {
    return CACHEABLE_CROSS_ORIGIN.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) {
        // Refresh in the background so the next load is current.
        fetch(e.request).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(e.request).then((res) => {
        if (res && res.ok && isCacheable(e.request.url)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
