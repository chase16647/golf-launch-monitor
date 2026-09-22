// maploader.js — lazy-loads Leaflet from a CDN on first use.
//
// Not bundled into the app shell: most sessions on the range never open the
// Course tab, so paying Leaflet's ~150KB there would be waste. Loaded once,
// then cached by the service worker like everything else.

const LEAFLET_VERSION = '1.9.4';
const CSS_URL = `https://cdn.jsdelivr.net/npm/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
const JS_URL = `https://cdn.jsdelivr.net/npm/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;

let loadPromise = null;

export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${CSS_URL}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = CSS_URL;
      document.head.appendChild(link);
    }
    const script = document.createElement('script');
    script.src = JS_URL;
    script.onload = () => resolve(window.L);
    script.onerror = () => reject(new Error('Could not load the map library. Check your connection.'));
    document.head.appendChild(script);
  });

  return loadPromise;
}
