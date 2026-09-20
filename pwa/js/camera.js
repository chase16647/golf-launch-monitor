// camera.js — what can a browser ACTUALLY do with the camera?
//
// This module exists because the honest answer to "can a PWA be a real launch
// monitor?" is no, and the respectful way to say that is to measure it on the
// user's own device rather than assert it.
//
// What the native app needs and what the web gives you:
//
//   need                          native iOS        web (iOS Safari)
//   ----------------------------  ----------------  --------------------------
//   240 fps capture               yes               no  (30, sometimes 60)
//   manual shutter (1/2000 s)     yes               no  (no ImageCapture API)
//   manual ISO lock               yes               no
//   LiDAR depth for scale         yes               no  (no web depth API)
//   raw YUV frame access          zero-copy         canvas readback, slow
//
// The arithmetic that kills it: at 30 fps a 150 mph ball travels 7.3 FEET
// between consecutive frames. The frame is about 7 feet wide at a 5 ft camera
// distance. The ball is therefore present in roughly one frame, and you cannot
// fit a velocity, let alone a curvature, to one point.

const MPH_TO_FPS = 1.46667;

export const CAPABILITY_NOTES = {
  frameRate: 'Ball tracking needs 120+ fps. Browsers cap at 30-60.',
  exposure: 'Freezing a 150 mph ball needs 1/2000 s. The web has no shutter control.',
  depth: 'Pixel-to-inch scale needs LiDAR. No browser exposes depth sensors.',
};

/**
 * Probe the camera and measure what this device really delivers.
 * Returns a report object; never throws for permission denial (reports it).
 */
export async function probeCamera({ requestedFPS = 240, durationMs = 2500, onProgress } = {}) {
  const report = {
    supported: false,
    permission: 'unknown',
    error: null,
    requestedFPS,
    measuredFPS: 0,
    width: 0,
    height: 0,
    settings: {},
    capabilities: {},
    hasExposureControl: false,
    hasFocusControl: false,
    frameTimings: [],
    verdict: null,
  };

  if (!navigator.mediaDevices?.getUserMedia) {
    report.error = 'getUserMedia is unavailable. Serve the page over HTTPS or localhost.';
    report.verdict = buildVerdict(report);
    return report;
  }

  let stream;
  try {
    // Ask for the moon. What comes back is the point of the exercise.
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        frameRate: { ideal: requestedFPS },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    report.permission = 'granted';
    report.supported = true;
  } catch (err) {
    report.permission = err.name === 'NotAllowedError' ? 'denied' : 'error';
    report.error = `${err.name}: ${err.message}`;
    report.verdict = buildVerdict(report);
    return report;
  }

  const track = stream.getVideoTracks()[0];
  report.settings = track.getSettings?.() || {};
  report.width = report.settings.width || 0;
  report.height = report.settings.height || 0;

  if (track.getCapabilities) {
    try {
      const caps = track.getCapabilities();
      report.capabilities = caps;
      report.hasExposureControl = 'exposureTime' in caps || 'exposureMode' in caps;
      report.hasFocusControl = 'focusDistance' in caps || 'focusMode' in caps;
    } catch {
      /* Safari throws here on some versions; absence is itself the answer. */
    }
  }

  // ── Measure the REAL frame rate ──
  // track.getSettings().frameRate is what the browser claims. We time actual
  // frame delivery instead, because the claim and the delivery differ.
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => {});

  const timings = [];
  await new Promise((resolve) => {
    const start = performance.now();
    let last = start;

    // requestVideoFrameCallback fires once per DECODED frame — the honest
    // measurement. requestAnimationFrame would just measure the display's
    // refresh rate and flatter the result.
    const useRVFC = typeof video.requestVideoFrameCallback === 'function';

    const onFrame = (now) => {
      const t = now ?? performance.now();
      if (timings.length > 0 || t > start + 200) {
        const dt = t - last;
        if (dt > 0.5 && dt < 500) timings.push(dt);
      }
      last = t;
      const elapsed = t - start;
      onProgress?.(Math.min(elapsed / durationMs, 1));
      if (elapsed < durationMs) {
        if (useRVFC) video.requestVideoFrameCallback(() => onFrame());
        else requestAnimationFrame(onFrame);
      } else {
        resolve();
      }
    };

    if (useRVFC) video.requestVideoFrameCallback(() => onFrame());
    else requestAnimationFrame(onFrame);
  });

  stream.getTracks().forEach((t) => t.stop());

  report.frameTimings = timings;
  if (timings.length > 4) {
    const sorted = [...timings].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    report.measuredFPS = median > 0 ? 1000 / median : 0;
  }

  report.verdict = buildVerdict(report);
  return report;
}

/**
 * Turn the measurements into the concrete consequence, in golf terms.
 */
function buildVerdict(report) {
  const fps = report.measuredFPS || 0;

  if (!report.supported) {
    return {
      level: 'blocked',
      headline: report.permission === 'denied' ? 'Camera access denied' : 'Camera unavailable',
      detail: report.error || 'No camera stream could be opened.',
      gapPerFrameFeet: null,
    };
  }

  // How far a driver-speed ball moves between frames at this rate.
  const ballFPS = 150 * MPH_TO_FPS; // ~220 ft/s
  const gap = fps > 0 ? ballFPS / fps : Infinity;
  // Frame is roughly 7 ft wide at 5 ft with a typical phone FOV.
  const framesInView = 7 / gap;

  let level, headline;
  if (fps >= 120) {
    level = 'good';
    headline = `${Math.round(fps)} fps — high-speed capture available`;
  } else if (fps >= 55) {
    level = 'marginal';
    headline = `${Math.round(fps)} fps — too slow for driver, may work for chips`;
  } else {
    level = 'blocked';
    headline = `${Math.round(fps)} fps — cannot track ball flight`;
  }

  return {
    level,
    headline,
    gapPerFrameFeet: gap,
    framesInView,
    detail:
      `At ${Math.round(fps)} fps a 150 mph ball travels ${gap.toFixed(1)} ft between frames. ` +
      `The camera sees about 7 ft of width from 5 ft away, so the ball appears in roughly ` +
      `${framesInView < 1 ? 'a single frame' : framesInView.toFixed(1) + ' frames'}. ` +
      `Measuring speed needs 4+ points; measuring curve needs 5+.`,
  };
}

/** Human-readable summary rows for the diagnostics table. */
export function capabilityRows(report) {
  const caps = report.capabilities || {};
  const s = report.settings || {};
  return [
    ['Resolution', report.width ? `${report.width} x ${report.height}` : 'unknown'],
    ['Browser claims', s.frameRate ? `${Math.round(s.frameRate)} fps` : 'not reported'],
    ['Actually measured', report.measuredFPS ? `${report.measuredFPS.toFixed(1)} fps` : 'not measured'],
    ['Requested', `${report.requestedFPS} fps`],
    ['Shutter control', report.hasExposureControl ? 'exposed' : 'not available'],
    ['Focus control', report.hasFocusControl ? 'exposed' : 'not available'],
    ['Depth / LiDAR', 'no web API exists'],
    ['Torch', caps.torch ? 'available' : 'not available'],
  ];
}
