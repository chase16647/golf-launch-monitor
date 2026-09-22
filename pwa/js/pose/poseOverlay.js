// poseOverlay.js — GolfTec-style skeleton overlay using on-device pose
// detection (MediaPipe Tasks Vision, runs client-side via WASM, no server).
//
// ── What this genuinely gives you ──────────────────────────────────────────
// A skeleton drawn over the video, and a handful of angles computed from it:
// spine tilt, shoulder-line tilt, hip-line tilt, and head lateral sway across
// the swing. That is real, live, per-frame measurement of your own video —
// the same category of thing a GolfTec camera setup shows you.
//
// ── What this is NOT ────────────────────────────────────────────────────────
// GolfTec uses either multiple synchronised cameras or 3D motion capture.
// This is ONE camera, so every angle is a 2D projection of a 3D motion, and it
// is only as good as your camera angle:
//   * Face-on cameras read spine tilt and hip sway well, but face rotation and
//     shoulder turn foreshorten and become unreliable.
//   * Down-the-line cameras read shoulder/hip turn well, but spine tilt reads
//     wrong because you're viewing the tilt nearly end-on.
// There is no camera position that reads everything correctly, because that
// needs a second camera. The app labels every angle "approx." for this reason
// and never claims a specific position is "correct" in isolation — only
// relative to your own address position, which is what actually helps.
//
// Model confidence also drops hard during the downswing: motion blur at
// swing speed degrades keypoint detection exactly when you most want it.
// Expect the overlay to be excellent at address and the top of the backswing,
// and rougher through impact.

let visionModulePromise = null;
let landmarkerPromise = null;

const CDN_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';

/** Lazily load the WASM runtime + model. Cached by the service worker after
 *  first use, so this is a one-time cost per device, not per session. */
async function getLandmarker() {
  if (landmarkerPromise) return landmarkerPromise;

  landmarkerPromise = (async () => {
    if (!visionModulePromise) {
      visionModulePromise = import(/* webpackIgnore: true */ `${CDN_BASE}/vision_bundle.mjs`);
    }
    const { FilesetResolver, PoseLandmarker } = await visionModulePromise;
    const filesetResolver = await FilesetResolver.forVisionTasks(`${CDN_BASE}/wasm`);
    return PoseLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
        delegate: 'GPU',
      },
      runningMode: 'IMAGE',
      numPoses: 1,
    });
  })();

  return landmarkerPromise;
}

export async function isPoseAvailable() {
  try {
    await getLandmarker();
    return true;
  } catch {
    return false;
  }
}

// MediaPipe's 33-point BlazePose topology. Only naming the ones we draw/use.
const LM = {
  NOSE: 0,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
};

// Bone connections for drawing, as pairs of landmark indices.
const BONES = [
  [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER],
  [LM.LEFT_SHOULDER, LM.LEFT_ELBOW], [LM.LEFT_ELBOW, LM.LEFT_WRIST],
  [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW], [LM.RIGHT_ELBOW, LM.RIGHT_WRIST],
  [LM.LEFT_SHOULDER, LM.LEFT_HIP], [LM.RIGHT_SHOULDER, LM.RIGHT_HIP],
  [LM.LEFT_HIP, LM.RIGHT_HIP],
  [LM.LEFT_HIP, LM.LEFT_KNEE], [LM.LEFT_KNEE, LM.LEFT_ANKLE],
  [LM.RIGHT_HIP, LM.RIGHT_KNEE], [LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
];

/**
 * Detect pose in a single image source (canvas/video/ImageBitmap).
 * Deliberately IMAGE mode, not VIDEO/live streaming: swings are captured
 * first and scrubbed after, so we detect once per frame on demand rather than
 * trying to keep up with live playback. A few hundred ms of latency when you
 * pause on a frame is a fine trade for not needing a beefy device to keep 240
 * fps of pose detection running live.
 */
export async function detectPose(imageSource) {
  const landmarker = await getLandmarker();
  const result = landmarker.detect(imageSource);
  if (!result.landmarks?.length) return null;
  return result.landmarks[0]; // normalized [0,1] x/y per point, one pose
}

/** Draw the skeleton onto a canvas context, in the canvas's own pixel space. */
export function drawSkeleton(ctx, landmarks, { w, h, color = '#5cf285', alpha = 1, dashed = false } = {}) {
  if (!landmarks) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  if (dashed) ctx.setLineDash([6, 5]);

  for (const [a, b] of BONES) {
    const pa = landmarks[a], pb = landmarks[b];
    if (!pa || !pb || pa.visibility < 0.3 || pb.visibility < 0.3) continue;
    ctx.beginPath();
    ctx.moveTo(pa.x * w, pa.y * h);
    ctx.lineTo(pb.x * w, pb.y * h);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const idx of Object.values(LM)) {
    const p = landmarks[idx];
    if (!p || p.visibility < 0.3) continue;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ── Derived angles ───────────────────────────────────────────────────────────

const rad2deg = (r) => (r * 180) / Math.PI;
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Angle of a line vs vertical (image up), in degrees, sign = tilt direction.
 * Used for spine angle: the line from hip-midpoint to shoulder-midpoint,
 * measured from straight up. A neutral athletic posture reads roughly 25-40
 * degrees forward for most full-swing setups shot face-on.
 */
function tiltFromVertical(bottom, top) {
  const dx = top.x - bottom.x;
  const dy = top.y - bottom.y; // image y grows downward
  return rad2deg(Math.atan2(dx, -dy));
}

/** Angle of a line vs horizontal, degrees. Used for shoulder/hip line tilt. */
function tiltFromHorizontal(left, right) {
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  return rad2deg(Math.atan2(dy, dx));
}

/**
 * Derive the handful of angles we actually show. Returns null fields rather
 * than guessing when a landmark's visibility is too low to trust — showing a
 * confident-looking wrong number is worse than showing nothing.
 */
export function deriveAngles(landmarks) {
  if (!landmarks) return null;
  const vis = (i) => (landmarks[i]?.visibility ?? 0) >= 0.4;

  const out = { spineTiltDeg: null, shoulderTiltDeg: null, hipTiltDeg: null, headX: null };

  if (vis(LM.LEFT_SHOULDER) && vis(LM.RIGHT_SHOULDER) && vis(LM.LEFT_HIP) && vis(LM.RIGHT_HIP)) {
    const shoulderMid = mid(landmarks[LM.LEFT_SHOULDER], landmarks[LM.RIGHT_SHOULDER]);
    const hipMid = mid(landmarks[LM.LEFT_HIP], landmarks[LM.RIGHT_HIP]);
    out.spineTiltDeg = tiltFromVertical(hipMid, shoulderMid);
  }
  if (vis(LM.LEFT_SHOULDER) && vis(LM.RIGHT_SHOULDER)) {
    out.shoulderTiltDeg = tiltFromHorizontal(landmarks[LM.LEFT_SHOULDER], landmarks[LM.RIGHT_SHOULDER]);
  }
  if (vis(LM.LEFT_HIP) && vis(LM.RIGHT_HIP)) {
    out.hipTiltDeg = tiltFromHorizontal(landmarks[LM.LEFT_HIP], landmarks[LM.RIGHT_HIP]);
  }
  if (vis(LM.NOSE)) {
    out.headX = landmarks[LM.NOSE].x; // normalized 0..1, for lateral-sway tracking
  }
  return out;
}

/**
 * Lateral head sway from an address reference, in fractional frame-widths.
 * Multiply by your actual field-of-view width to get real distance — we don't
 * know that here, so this stays a relative number, which is the honest thing:
 * "your head moved about 8% of the frame width" is verifiable from the video
 * itself, a converted inches figure would not be.
 */
export function headSwayFromAddress(addressAngles, currentAngles) {
  if (addressAngles?.headX == null || currentAngles?.headX == null) return null;
  return currentAngles.headX - addressAngles.headX;
}

export { LM as PoseLandmarkIndex };
