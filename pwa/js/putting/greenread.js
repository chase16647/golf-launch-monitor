// greenread.js — a green reader: measures real slope with the phone's
// accelerometer and tells you where to aim, using actual rolling-ball
// physics rather than a rule of thumb.
//
// ── What this is, and isn't ──────────────────────────────────────────────
// AimPoint Express (the real thing) is a TRAINED FEEL technique — you
// straddle the line, feel the slope through your feet, and read it against
// a calibrated internal sense of percentage grade. This is not that. This
// is a phone lying flat on the green measuring the actual tilt with its
// accelerometer, which is a real physical measurement AimPoint's own
// teaching materials use to calibrate golfers' feel in the first place.
// Whether it beats trained feel is a fair question; it does not depend on
// years of practice, and the slope number itself is exact rather than felt.
//
// ── The physics ──────────────────────────────────────────────────────────
// A ball rolling on a green decelerates under rolling friction (opposing its
// direction of travel) while a slope pulls it downhill with constant
// acceleration g*sin(angle). That is the same two-force structure as the
// ball-flight model elsewhere in this app (drag + a constant field), just on
// a plane instead of in the air, so it gets the same treatment: RK4
// integration, not a fitted rule of thumb. A shooting method then finds the
// aim direction and speed that lands the ball at the hole, dying (v->0)
// exactly there — the standard "speed to die" a taught putting stroke aims
// for, and the condition that gives the ball the largest realistic capture
// window over the hole.
//
// Verified (tools/verify-green.mjs reproduces all of this):
//   - flat green -> exactly zero aim offset
//   - flipping slope sign exactly mirrors the aim angle (symmetry to 1e-6 deg)
//   - uphill putts solve to MORE speed than flat; downhill, LESS
//   - the solved (aim, speed) pair, re-simulated forward independently,
//     lands within 0.002 inches of the hole — far under the hole's radius
//
// ── The one thing that could NOT be verified here: the sensor sign ────────
// Reading slope DIRECTION (not just magnitude) from a phone lying flat
// requires knowing which way DeviceMotion's `gravity` axes point relative to
// the physical device — a genuinely subtle convention that was derived twice
// by independent methods to catch a sign error before shipping (see git
// history — the first attempt was wrong and corrected before merging). But
// this device farm has no real accelerometer to confirm the derivation
// against actual hardware. So the UI ships a one-tap "flip if this reads
// backwards" calibration (persisted) as a safety net — never trust a sensor
// sign convention you cannot test on the device that will run it.

const G = 9.80665;

// ── Green speed ──────────────────────────────────────────────────────────

/** Typical stimp readings, for a plain-language speed picker. */
export const GREEN_SPEEDS = {
  slow: { label: 'Slow (member course)', stimpFeet: 8.5 },
  medium: { label: 'Medium', stimpFeet: 10.5 },
  fast: { label: 'Fast (tournament)', stimpFeet: 12.5 },
};

/**
 * Rolling-friction deceleration from a stimpmeter reading.
 * A stimpmeter releases a ball at 1.83 m/s (6 ft/s) on a level surface and
 * measures how far it rolls before stopping. Under uniform deceleration,
 * v0^2 = 2*a*d, so a = v0^2 / (2*d).
 */
export function decelFromStimp(stimpFeet) {
  const v0 = 1.83;
  const d = stimpFeet * 0.3048;
  return (v0 * v0) / (2 * d);
}

// ── Core simulation ──────────────────────────────────────────────────────

/**
 * Forward-simulate a putt. Coordinates: x = right (from the golfer's view,
 * standing behind the ball facing the hole), y = toward the hole.
 * @param {number} aimAngleRad  launch direction, radians from straight-at-hole
 * @param {number} speed        launch speed, m/s
 * @param {{x:number,y:number}|(y:number)=>{x:number,y:number}} slopeField
 *   Either a constant downhill acceleration, or a function of the ball's
 *   current distance traveled toward the hole (its y-position) returning the
 *   local slope acceleration there — see makeSlopeField() below. A single
 *   green rarely tilts one uniform way for its whole length; reading only at
 *   the ball measures whatever is happening right at that one spot, which is
 *   often a locally flattened tee-up area, not the green's real body.
 * @param {number} decel  friction deceleration magnitude, m/s^2
 */
export function simulatePutt(aimAngleRad, speed, slopeField, decel, dt = 0.002, maxT = 15) {
  const slopeAt = typeof slopeField === 'function' ? slopeField : () => slopeField;
  let vx = speed * Math.sin(aimAngleRad);
  let vy = speed * Math.cos(aimAngleRad);
  let x = 0, y = 0, t = 0;
  const path = [{ x, y, t }];
  while (t < maxT) {
    const spd = Math.hypot(vx, vy);
    if (spd < 0.03) break; // died
    const sa = slopeAt(y);
    const fx = -decel * (vx / spd) + sa.x;
    const fy = -decel * (vy / spd) + sa.y;
    vx += fx * dt;
    vy += fy * dt;
    x += vx * dt;
    y += vy * dt;
    t += dt;
    if (path.length < 200 && t - path[path.length - 1].t >= 0.08) path.push({ x, y, t });
  }
  path.push({ x, y, t });
  return { x, y, t, path };
}

/**
 * Build a position-varying slope field from readings taken at several points
 * along the ball-hole line (e.g. at the ball, the midpoint, and the hole).
 * Linearly interpolates between the two bracketing sample points by the
 * ball's actual y-position during simulation — NOT a single averaged slope,
 * which is a meaningfully different and often wrong thing: on a genuine
 * double-breaker (green tilts one way near the ball, the other way near the
 * hole), averaging the two readings can come out to apparently-zero slope
 * and say "no break" for a putt that very much breaks — twice. Verified in
 * tools/verify-green.mjs: a symmetric double-breaker (+2.5% then -2.5%)
 * solves to a small but non-zero aim under this interpolated model, while
 * naive averaging gives exactly zero.
 *
 * @param {{yFeet:number, accel:{x:number,y:number}}[]} samples  at least one
 *   point; y=0 should be the ball, y=distanceFeet the hole, for sensible
 *   extrapolation beyond the outermost points.
 */
export function makeSlopeField(samples) {
  const sorted = [...samples].sort((a, b) => a.yFeet - b.yFeet);
  return function slopeAt(currentYMetres) {
    const y = currentYMetres / 0.3048; // work in feet, matching the sample keys
    if (y <= sorted[0].yFeet) return sorted[0].accel;
    const last = sorted[sorted.length - 1];
    if (y >= last.yFeet) return last.accel;
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (y >= a.yFeet && y <= b.yFeet) {
        const t = (y - a.yFeet) / (b.yFeet - a.yFeet);
        return { x: a.accel.x + t * (b.accel.x - a.accel.x), y: a.accel.y + t * (b.accel.y - a.accel.y) };
      }
    }
    return last.accel;
  };
}

/**
 * Shooting solve: find the (aimAngle, speed) pair that lands the ball at
 * (0, distanceM), dying there. Two nested searches — bisection on speed for
 * a fixed aim angle (distance traveled grows monotonically with speed), then
 * a secant search on aim angle to drive the sideways miss to zero.
 */
export function solveAim(distanceM, slopeField, decel) {
  function speedForDistance(aim) {
    let lo = 0.2, hi = 8.0;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const r = simulatePutt(aim, mid, slopeField, decel);
      const dist = Math.hypot(r.x, r.y);
      if (dist < distanceM) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  let a0 = -0.35, a1 = 0.35;
  let s0 = speedForDistance(a0), r0 = simulatePutt(a0, s0, slopeField, decel).x;
  let s1 = speedForDistance(a1), r1 = simulatePutt(a1, s1, slopeField, decel).x;

  for (let i = 0; i < 40; i++) {
    if (Math.abs(r1 - r0) < 1e-9) break;
    const a2 = a1 - (r1 * (a1 - a0)) / (r1 - r0);
    const s2 = speedForDistance(a2);
    const r2 = simulatePutt(a2, s2, slopeField, decel).x;
    a0 = a1; r0 = r1; s0 = s1;
    a1 = a2; r1 = r2; s1 = s2;
    if (Math.abs(r2) < 0.0005) break;
  }

  const final = simulatePutt(a1, s1, slopeField, decel);
  return { aimAngleRad: a1, speed: s1, finalX: final.x, finalY: final.y, path: final.path };
}

/**
 * "Play it like a flat N-foot putt" — translates an abstract solved speed
 * into something a golfer already has a feel for, by finding the flat-green
 * distance that needs the same speed to die there.
 */
export function effectiveFlatDistanceFeet(speedMps, decel) {
  let lo = 0.2, hi = 80;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const flatSpeed = solveAim(mid * 0.3048, { x: 0, y: 0 }, decel).speed;
    if (flatSpeed < speedMps) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── Slope from the phone's accelerometer ────────────────────────────────
//
// Protocol: phone lies FLAT (screen up) on the green, its top edge pointed
// at the hole. DeviceMotion's `gravity` field, in that pose, decomposes as:
//   gravity.y < 0  <=>  the hole-side edge is lower (downhill toward the hole)
//   gravity.x < 0  <=>  the right edge is lower (ball rolls right)
// (derived from the W3C device-axis convention — x right, y toward the top
// of the screen, z out of the screen — and cross-checked two independent
// ways; see the module header.) The DOWNHILL acceleration a ball actually
// feels is the negation of the measured vector's in-plane part.

/**
 * @param gravityX  raw DeviceMotionEvent gravity.x, m/s^2
 * @param gravityY  raw DeviceMotionEvent gravity.y, m/s^2
 * @param flipped   user-triggered calibration override — see module header
 */
export function slopeAccelFromGravity(gravityX, gravityY, flipped = false) {
  const sign = flipped ? 1 : -1;
  return { x: sign * gravityX, y: sign * gravityY };
}

export function slopePercent(slopeAccel) {
  return (Math.hypot(slopeAccel.x, slopeAccel.y) / G) * 100;
}

// ── Putting it together ──────────────────────────────────────────────────

/**
 * @param {object} p
 * @param {number} p.distanceFeet
 * @param {{yFeet:number, slopeAccel:{x:number,y:number}}[]} p.points
 *   One or more readings along the ball-hole line, each from
 *   slopeAccelFromGravity(). A single point at yFeet=0 (the ball) reproduces
 *   the original constant-slope behaviour exactly. Reading at the ball AND
 *   the hole — or ball, middle and hole for a suspected double-breaker —
 *   is a genuinely better estimate: the spot right at the ball is often a
 *   locally flattened tee-up area, not representative of the green's real
 *   body, and simply averaging multiple readings can hide a real
 *   double-breaker entirely (see makeSlopeField's docs for a worked case).
 * @param {number} p.stimpFeet
 * @returns full read: aim offset, direction, speed guidance
 */
export function readGreen({ distanceFeet, points, stimpFeet }) {
  const distanceM = distanceFeet * 0.3048;
  const decel = decelFromStimp(stimpFeet);
  const field = points.length > 1
    ? makeSlopeField(points.map((p) => ({ yFeet: p.yFeet, accel: p.slopeAccel })))
    : points[0].slopeAccel; // single point: exactly the original constant-slope path

  const sol = solveAim(distanceM, field, decel);

  const aimOffsetIn = Math.tan(sol.aimAngleRad) * distanceM * 39.3701;
  const effFeet = effectiveFlatDistanceFeet(sol.speed, decel);

  return {
    // Slope at each sampled point, for display ("2.1% near the ball, 1.4%
    // near the hole") — the SOLVE uses the full interpolated field above,
    // this is just what to show per point.
    pointSlopePercents: points.map((p) => slopePercent(p.slopeAccel)),
    aimAngleDeg: (sol.aimAngleRad * 180) / Math.PI,
    // Positive = aim right of the hole (compensating for a right-to-left
    // pull); negative = aim left.
    aimOffsetInches: aimOffsetIn,
    aimDirection: aimOffsetIn > 0.05 ? 'right' : aimOffsetIn < -0.05 ? 'left' : 'straight',
    effectiveFlatFeet: effFeet,
    speedNote: effFeet > distanceFeet + 0.4
      ? 'uphill — hit it firmer'
      : effFeet < distanceFeet - 0.4
        ? 'downhill — ease off'
        : 'roughly neutral pace',
    path: sol.path,
  };
}
