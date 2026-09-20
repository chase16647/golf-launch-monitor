// orientation.js — live phone attitude from the motion sensors.
//
// Gives the three angles the setup engine needs, for the REAR CAMERA rather
// than for the phone body (they are not the same thing, and conflating them is
// how you end up with a level indicator that is 90 degrees wrong in landscape).
//
//   cameraPitch   optical axis above(+)/below(-) horizontal
//   cameraRoll    rotation about the optical axis
//   cameraHeading compass bearing the lens points
//
// Method: build the device->world rotation matrix from the W3C alpha/beta/gamma
// Euler angles, then read the rear camera's axis out of it. Deriving pitch and
// roll directly from beta/gamma instead would only be correct in portrait, and
// this app is used in landscape.
//
// iOS notes:
//   * iOS 13+ requires DeviceOrientationEvent.requestPermission() called from
//     inside a real user gesture. It cannot be requested on page load.
//   * Safari supplies webkitCompassHeading (magnetic north). Where it exists it
//     beats integrating alpha, which drifts.
//   * The target-line feature only needs RELATIVE heading between two moments,
//     which is far more reliable than absolute north — so a compass that is
//     10 degrees off north still gives a correct squareness reading.

const d2r = (d) => (d * Math.PI) / 180;
const r2d = (r) => (r * 180) / Math.PI;

/** Normalise to (-180, 180]. */
export function norm180(deg) {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/**
 * W3C device orientation -> rotation matrix (device coords to world coords).
 * World: x east, y north, z up.  Device: x right, y top, z out of the screen.
 * R = Rz(alpha) . Rx(beta) . Ry(gamma)
 */
function rotationMatrix(alphaDeg, betaDeg, gammaDeg) {
  const a = d2r(alphaDeg), b = d2r(betaDeg), g = d2r(gammaDeg);
  const cA = Math.cos(a), sA = Math.sin(a);
  const cB = Math.cos(b), sB = Math.sin(b);
  const cG = Math.cos(g), sG = Math.sin(g);

  return [
    [cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG],
    [sA * cG + cA * sB * sG,  cA * cB, sA * sG - cA * sB * cG],
    [-cB * sG,                sB,      cB * cG],
  ];
}

const apply = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function normalize(v) {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/**
 * Attitude of the REAR camera from raw Euler angles.
 * @returns {{pitch:number, roll:number, heading:number}}
 */
export function cameraAttitude(alpha, beta, gamma) {
  const R = rotationMatrix(alpha, beta, gamma);

  // Rear camera looks along the device's -z axis.
  const axis = normalize(apply(R, [0, 0, -1]));
  // Device "up the screen" is +y.
  const screenUp = apply(R, [0, 1, 0]);

  // Elevation of the optical axis above the horizon.
  const pitch = r2d(Math.asin(Math.max(-1, Math.min(1, axis[2]))));

  // Compass bearing: clockwise from north, with north = +y and east = +x.
  let heading = r2d(Math.atan2(axis[0], axis[1]));
  if (heading < 0) heading += 360;

  // Roll: angle between the device's screen-up and true up, measured in the
  // plane perpendicular to the optical axis.
  //
  // Project world-up into that plane. When the camera points near straight up
  // or down this projection collapses and roll becomes undefined — that is a
  // real singularity, not a bug, and the caller sees it via a large |pitch|.
  const worldUp = [0, 0, 1];
  const upInPlane = normalize([
    worldUp[0] - axis[0] * dot(worldUp, axis),
    worldUp[1] - axis[1] * dot(worldUp, axis),
    worldUp[2] - axis[2] * dot(worldUp, axis),
  ]);
  const screenUpInPlane = normalize([
    screenUp[0] - axis[0] * dot(screenUp, axis),
    screenUp[1] - axis[1] * dot(screenUp, axis),
    screenUp[2] - axis[2] * dot(screenUp, axis),
  ]);
  const c = Math.max(-1, Math.min(1, dot(upInPlane, screenUpInPlane)));
  const sign = Math.sign(dot(cross(upInPlane, screenUpInPlane), axis)) || 1;
  const roll = r2d(Math.acos(c)) * sign;

  return { pitch, roll, heading };
}

// ── Live tracker ────────────────────────────────────────────────────────────

export class OrientationTracker extends EventTarget {
  constructor() {
    super();

    // iOS gates motion sensors behind a SECURE CONTEXT. Over plain http on a
    // LAN address Safari does not merely deny them — it hides the API, so
    // naive feature detection reports "this device has no motion sensors" on
    // a phone that obviously has them. Distinguishing the two matters: one is
    // a hardware limit, the other is a one-line fix (use https).
    this.isSecure = typeof window !== 'undefined' ? window.isSecureContext !== false : true;
    this.hasAPI = typeof DeviceOrientationEvent !== 'undefined';
    this.supported = this.hasAPI;

    this.needsPermission =
      this.hasAPI && typeof DeviceOrientationEvent.requestPermission === 'function';

    if (!this.isSecure && !this.hasAPI) {
      this.permission = 'insecure';
    } else if (!this.hasAPI) {
      this.permission = 'unavailable';
    } else if (this.needsPermission) {
      this.permission = 'prompt';
    } else {
      this.permission = 'granted';
    }

    this.pitch = 0;
    this.roll = 0;
    this.heading = null;
    this.usingCompass = false;
    this.headingAccuracy = null;
    this.hasReading = false;

    // Stability: variance of recent acceleration. A phone propped against a
    // headcover can settle or slip minutes after you set it down, which would
    // silently invalidate the calibration.
    this.stable = false;
    this._accelWindow = [];
    this._lastMotion = 0;

    this._onOrientation = this._onOrientation.bind(this);
    this._onMotion = this._onMotion.bind(this);
  }

  /** Must be called from inside a user gesture on iOS. */
  async requestPermission() {
    if (!this.isSecure && !this.hasAPI) {
      this.permission = 'insecure';
      return 'insecure';
    }
    if (!this.supported) return 'unavailable';
    if (!this.needsPermission) {
      this.permission = 'granted';
      this.start();
      return 'granted';
    }
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      this.permission = res;
      if (res === 'granted') {
        // Motion is a separate permission on iOS even though the prompt is shared.
        if (typeof DeviceMotionEvent?.requestPermission === 'function') {
          try { await DeviceMotionEvent.requestPermission(); } catch { /* optional */ }
        }
        this.start();
      }
      return res;
    } catch (err) {
      // A SecurityError here is almost always the non-secure-context case
      // rather than a genuine refusal, so report it as such.
      const insecure = !this.isSecure || /secure|https/i.test(err.message || '');
      this.permission = insecure ? 'insecure' : 'denied';
      this.error = err.message;
      return this.permission;
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    window.addEventListener('deviceorientation', this._onOrientation, true);
    window.addEventListener('devicemotion', this._onMotion, true);
  }

  stop() {
    this._running = false;
    window.removeEventListener('deviceorientation', this._onOrientation, true);
    window.removeEventListener('devicemotion', this._onMotion, true);
  }

  _onOrientation(e) {
    if (e.alpha == null && e.beta == null && e.gamma == null) return;

    const att = cameraAttitude(e.alpha ?? 0, e.beta ?? 0, e.gamma ?? 0);
    this.pitch = att.pitch;
    this.roll = att.roll;

    // Prefer Safari's magnetic compass over integrating alpha, which drifts.
    // webkitCompassHeading is the bearing of the device's TOP edge, so the rear
    // camera (pointing out the back) is 180 degrees from it.
    if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
      this.heading = (e.webkitCompassHeading + 180) % 360;
      this.usingCompass = true;
      this.headingAccuracy = e.webkitCompassAccuracy ?? null;
    } else {
      this.heading = att.heading;
      this.usingCompass = false;
    }

    this.hasReading = true;
    this.dispatchEvent(new Event('change'));
  }

  _onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    const mag = Math.hypot(a.x, a.y, a.z);
    this._accelWindow.push(mag);
    if (this._accelWindow.length > 40) this._accelWindow.shift();

    if (this._accelWindow.length >= 12) {
      const m = this._accelWindow.reduce((x, y) => x + y, 0) / this._accelWindow.length;
      const variance =
        this._accelWindow.reduce((s, v) => s + (v - m) ** 2, 0) / this._accelWindow.length;
      // 0.08 m/s^2 std dev: tight enough to catch a nudge, loose enough not to
      // trip on someone walking past on a range mat.
      this.stable = Math.sqrt(variance) < 0.08;
    }
  }

  /** Current reading, in the shape evaluateSetup expects. */
  reading() {
    return {
      pitchDeg: this.pitch,
      rollDeg: this.roll,
      headingDeg: this.heading,
      stable: this.stable,
      hasReading: this.hasReading,
      usingCompass: this.usingCompass,
    };
  }
}

// ── Target line ─────────────────────────────────────────────────────────────

/**
 * Squareness from two heading samples.
 *
 * The phone sits to the SIDE of the ball, so a correct setup has the lens
 * pointing 90 degrees away from the target line — either +90 or -90 depending
 * on which side you stand. We take whichever is closer so it works from both,
 * and the sign of the result tells the user which way to rotate.
 *
 * @param targetHeading  bearing recorded while aiming down the target line
 * @param currentHeading bearing of the lens right now
 * @returns degrees off square; positive means rotate the phone left to correct
 */
export function yawFromSquare(targetHeading, currentHeading) {
  if (targetHeading == null || currentHeading == null) return null;
  const diff = norm180(currentHeading - targetHeading);
  const offPlus = norm180(diff - 90);
  const offMinus = norm180(diff + 90);
  return Math.abs(offPlus) <= Math.abs(offMinus) ? offPlus : offMinus;
}

/**
 * How much to trust a heading. Safari reports compass accuracy in degrees;
 * a negative value means the compass is uncalibrated and should not be used.
 */
export function headingUncertainty(tracker) {
  if (!tracker.usingCompass) return 6; // integrated alpha: stable short-term, drifts
  const acc = tracker.headingAccuracy;
  if (acc == null) return 4;
  if (acc < 0) return 25;               // uncalibrated — figure-of-eight needed
  return Math.max(2, Math.min(acc, 25));
}
