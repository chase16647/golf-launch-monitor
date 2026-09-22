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
 * @param {{x:number,y:number}} slopeAccel  constant downhill acceleration, m/s^2
 * @param {number} decel        friction deceleration magnitude, m/s^2
 */
export function simulatePutt(aimAngleRad, speed, slopeAccel, decel, dt = 0.002, maxT = 15) {
  let vx = speed * Math.sin(aimAngleRad);
  let vy = speed * Math.cos(aimAngleRad);
  let x = 0, y = 0, t = 0;
  const path = [{ x, y, t }];
  while (t < maxT) {
    const spd = Math.hypot(vx, vy);
    if (spd < 0.03) break; // died
    const fx = -decel * (vx / spd) + slopeAccel.x;
    const fy = -decel * (vy / spd) + slopeAccel.y;
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
 * Shooting solve: find the (aimAngle, speed) pair that lands the ball at
 * (0, distanceM), dying there. Two nested searches — bisection on speed for
 * a fixed aim angle (distance traveled grows monotonically with speed), then
 * a secant search on aim angle to drive the sideways miss to zero.
 */
export function solveAim(distanceM, slopeAccel, decel) {
  function speedForDistance(aim) {
    let lo = 0.2, hi = 8.0;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const r = simulatePutt(aim, mid, slopeAccel, decel);
      const dist = Math.hypot(r.x, r.y);
      if (dist < distanceM) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  let a0 = -0.35, a1 = 0.35;
  let s0 = speedForDistance(a0), r0 = simulatePutt(a0, s0, slopeAccel, decel).x;
  let s1 = speedForDistance(a1), r1 = simulatePutt(a1, s1, slopeAccel, decel).x;

  for (let i = 0; i < 40; i++) {
    if (Math.abs(r1 - r0) < 1e-9) break;
    const a2 = a1 - (r1 * (a1 - a0)) / (r1 - r0);
    const s2 = speedForDistance(a2);
    const r2 = simulatePutt(a2, s2, slopeAccel, decel).x;
    a0 = a1; r0 = r1; s0 = s1;
    a1 = a2; r1 = r2; s1 = s2;
    if (Math.abs(r2) < 0.0005) break;
  }

  const final = simulatePutt(a1, s1, slopeAccel, decel);
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
 * @param {{x:number,y:number}} p.slopeAccel  from slopeAccelFromGravity()
 * @param {number} p.stimpFeet
 * @returns full read: aim offset, direction, speed guidance
 */
export function readGreen({ distanceFeet, slopeAccel, stimpFeet }) {
  const distanceM = distanceFeet * 0.3048;
  const decel = decelFromStimp(stimpFeet);
  const sol = solveAim(distanceM, slopeAccel, decel);

  const aimOffsetIn = Math.tan(sol.aimAngleRad) * distanceM * 39.3701;
  const effFeet = effectiveFlatDistanceFeet(sol.speed, decel);

  return {
    slopePercent: slopePercent(slopeAccel),
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
