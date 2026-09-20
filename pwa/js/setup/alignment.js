// alignment.js — the setup engine.
//
// ── The core idea ───────────────────────────────────────────────────────────
// A launch monitor does not need a PERFECT phone position. It needs a KNOWN
// one. Every way a phone can be misplaced is a measurable degree of freedom,
// and most of them can be corrected in software once measured. That is why
// "lean it against a headcover" is a real answer rather than a compromise.
//
// Measured sensitivities (see tools/dof-analysis.mjs), driver at 150 mph:
//
//   axis      misplaced by   uncorrected cost      measured & corrected
//   --------  -------------  --------------------  --------------------
//   roll      10 deg         10 deg launch error   ~0.3 deg (sensor noise)
//   pitch     20 deg         0.9 deg launch error  exact
//   yaw       20 deg         6.4% speed (~18 yd)   1.3%
//   distance  5%             5% speed (~14 yd)     NOT correctable
//
// Conclusions that drive the whole design:
//   * PITCH is nearly free. Lean the phone back as much as you like.
//   * ROLL corrects completely. It only matters for keeping the ball framed.
//   * YAW is the dangerous one, and gravity CANNOT measure it — an
//     accelerometer is blind to rotation about the vertical axis. It needs a
//     separate reference, which is what the target-line capture provides.
//   * DISTANCE goes 1:1 into ball speed and cannot be recovered after the
//     fact. Measure it properly or the whole reading is wrong.

const d2r = (d) => (d * Math.PI) / 180;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Signed deviation of roll from the nearest quarter turn.
 *
 * The phone is USED IN LANDSCAPE — the ball flies across the frame, so a roll
 * of +/-90 degrees is the correct, intended orientation, not an error. Judging
 * raw roll against a tolerance around zero would tell every correctly-placed
 * user to "straighten up", which is exactly the bug this function exists to
 * prevent. Portrait (0) and upside-down landscape (180) are equally valid, so
 * we measure the deviation from whichever quarter turn is nearest.
 */
export function rollDeviation(rollDeg) {
  const r = rollDeg ?? 0;
  const nearest = Math.round(r / 90) * 90;
  return r - nearest;
}

// Carry sensitivity, yards per unit error. Derived from the flight model at
// driver conditions (150 mph / 12 deg / 2700 rpm) by tools/dof-analysis.mjs.
// Re-run that tool and update these if the flight model changes.
//
// Caveat worth knowing: launch sensitivity is NOT constant. It is steep below
// the optimum and vanishes above it —
//     driver at  8 deg launch: 4.16 yd per degree
//     driver at 12 deg launch: 2.28 yd per degree
//     driver at 20 deg launch: ~0 yd per degree
//     7-iron at 16 deg launch: ~0 yd per degree (already past optimum)
// So a launch-angle error costs a low-launch driver real distance and costs a
// mid-iron almost nothing. We use the driver-at-12 figure as a single honest
// middle value rather than pretending the relationship is linear.
export const SENSITIVITY = {
  yardsPerSpeedPercent: 3.01,
  yardsPerLaunchDegree: 2.28,
};

/** Accelerometer/gyro noise floor after fusion, degrees. */
const ORIENTATION_NOISE_DEG = 0.3;

export const IDEAL = {
  distanceM: 1.524,       // 5 ft
  distanceRangeM: [1.2, 2.15],
  heightToleranceM: 0.25,
  // Correctable limits. Beyond these it is framing, not maths, that fails.
  maxRollDeg: 25,
  maxPitchDeg: 20,
  maxYawDeg: 20,
  // Without a captured target line we are ASSUMING square, so the tolerance
  // becomes how accurately a person can eyeball a right angle.
  maxYawUncapturedDeg: 5,
};

/**
 * @typedef {object} SetupReading
 * @property {number} pitchDeg      camera tilt up(+)/down(-) from horizontal
 * @property {number} rollDeg       rotation about the lens axis
 * @property {number|null} yawFromSquareDeg  0 = perfectly square; null = unknown
 * @property {number} yawUncertaintyDeg      how well we know yaw
 * @property {number|null} distanceM
 * @property {number} distanceUncertaintyPct
 * @property {number|null} heightDeltaM      camera height minus ball height
 * @property {boolean} stable
 */

/**
 * Score a setup and say exactly what to change.
 * Returns axes in priority order — worst first, so the UI can show the single
 * most useful instruction rather than a wall of them.
 */
export function evaluateSetup(r) {
  const axes = [];

  // ── Distance ──────────────────────────────────────────────────────────────
  if (r.distanceM == null) {
    axes.push({
      id: 'distance',
      label: 'Distance to ball',
      value: null,
      display: 'not measured',
      status: 'blocked',
      message: 'Measure the distance first — it goes straight into ball speed.',
      speedErrPct: 0,
      launchErrDeg: 0,
    });
  } else {
    const ft = r.distanceM * 3.28084;
    const [lo, hi] = IDEAL.distanceRangeM;
    const inRange = r.distanceM >= lo && r.distanceM <= hi;
    // Distance ERROR (not distance itself) is what costs accuracy.
    const speedErr = r.distanceUncertaintyPct ?? 3;
    axes.push({
      id: 'distance',
      label: 'Distance to ball',
      value: r.distanceM,
      display: `${ft.toFixed(1)} ft`,
      status: inRange ? (speedErr <= 4 ? 'ok' : 'warn') : 'blocked',
      message: inRange
        ? (speedErr <= 4 ? 'Good.' : `Scale is only known to ±${speedErr.toFixed(0)}% — re-measure.`)
        : r.distanceM < lo
          ? `Too close — the ball leaves the frame too fast. Move back to ~5 ft.`
          : `Too far — the ball is too small to centroid. Move in to ~5 ft.`,
      speedErrPct: speedErr,
      launchErrDeg: 0,
    });
  }

  // ── Yaw: the one that matters and the one gravity cannot see ──────────────
  if (r.yawFromSquareDeg == null) {
    // No target line captured. We must assume square, so the error is however
    // wrong that assumption is — and we have no way to know.
    const assumed = IDEAL.maxYawUncapturedDeg;
    const worstCase = (1 / Math.cos(d2r(assumed)) - 1) * 100;
    axes.push({
      id: 'yaw',
      label: 'Square to target',
      value: null,
      display: 'assumed',
      status: 'warn',
      message: 'Target line not set. Speed could be a few % low and nothing can detect it. Set the target line.',
      speedErrPct: worstCase,
      launchErrDeg: 0,
    });
  } else {
    const yaw = Math.abs(r.yawFromSquareDeg);
    const unc = r.yawUncertaintyDeg ?? 3;
    // Corrected residual: d/dyaw of (1/cos) times how well we know yaw.
    const residual = Math.abs(Math.tan(d2r(yaw))) * d2r(unc) * 100;
    const overLimit = yaw > IDEAL.maxYawDeg;
    axes.push({
      id: 'yaw',
      label: 'Square to target',
      value: r.yawFromSquareDeg,
      display: `${yaw < 1 ? 'square' : `${yaw.toFixed(0)}° ${r.yawFromSquareDeg > 0 ? 'open' : 'closed'}`}`,
      status: overLimit ? 'blocked' : yaw > 10 ? 'warn' : 'ok',
      message: overLimit
        ? `More than ${IDEAL.maxYawDeg}° off square — rotate the phone ${r.yawFromSquareDeg > 0 ? 'left' : 'right'}.`
        : yaw > 10
          ? `${yaw.toFixed(0)}° off square, corrected in software. Squaring up would tighten it further.`
          : 'Square enough.',
      speedErrPct: residual,
      launchErrDeg: 0,
    });
  }

  // ── Roll: fully correctable, matters only for framing ─────────────────────
  {
    // Deviation from the nearest quarter turn, NOT raw roll — see rollDeviation.
    const deviation = rollDeviation(r.rollDeg);
    const roll = Math.abs(deviation);
    const over = roll > IDEAL.maxRollDeg;
    axes.push({
      id: 'roll',
      label: 'Tilt (roll)',
      value: deviation,
      display: `${roll.toFixed(1)}°`,
      status: over ? 'blocked' : roll > 12 ? 'warn' : 'ok',
      message: over
        ? `Past ${IDEAL.maxRollDeg}° the ball tracks diagonally out of frame. Straighten up.`
        : roll > 12
          ? 'Corrected in software, but the ball may clip the frame edge.'
          : roll > 3
            ? 'Measured and corrected — no accuracy cost.'
            : 'Level.',
      speedErrPct: 0,
      launchErrDeg: ORIENTATION_NOISE_DEG,
    });
  }

  // ── Pitch: nearly free ────────────────────────────────────────────────────
  {
    const pitch = Math.abs(r.pitchDeg ?? 0);
    const over = pitch > IDEAL.maxPitchDeg;
    // Residual after exact correction is second-order; scale it with how far
    // out we are, since the correction depends on a depth term we know poorly.
    const residual = over ? 2.0 : (pitch / IDEAL.maxPitchDeg) * 0.35;
    axes.push({
      id: 'pitch',
      label: 'Lean (pitch)',
      value: r.pitchDeg,
      display: `${pitch.toFixed(1)}° ${(r.pitchDeg ?? 0) > 0 ? 'up' : 'down'}`,
      status: over ? 'warn' : 'ok',
      message: over
        ? `Steep lean. Still corrected, but keep it under ${IDEAL.maxPitchDeg}° for best launch angle.`
        : pitch > 5
          ? 'Leaning is fine — this is measured and corrected exactly.'
          : 'Upright.',
      speedErrPct: 0,
      launchErrDeg: residual,
    });
  }

  // ── Height ────────────────────────────────────────────────────────────────
  if (r.heightDeltaM != null) {
    const dh = Math.abs(r.heightDeltaM);
    axes.push({
      id: 'height',
      label: 'Camera height',
      value: r.heightDeltaM,
      display: `${(r.heightDeltaM * 39.37).toFixed(0)} in vs ball`,
      status: dh > 0.5 ? 'blocked' : dh > IDEAL.heightToleranceM ? 'warn' : 'ok',
      message: dh > 0.5
        ? 'Too far off ball height — the ball climbs out of frame. Get the lens near ball level.'
        : dh > IDEAL.heightToleranceM
          ? 'A little high or low. Closer to ball height gives more usable frames.'
          : 'At ball height.',
      speedErrPct: 0,
      launchErrDeg: 0,
    });
  }

  // ── Stability ─────────────────────────────────────────────────────────────
  axes.push({
    id: 'stability',
    label: 'Steady',
    value: r.stable ? 1 : 0,
    display: r.stable ? 'holding' : 'moving',
    status: r.stable ? 'ok' : 'blocked',
    message: r.stable
      ? 'Not moving.'
      : 'Phone is moving. Anything measured now is void the moment it settles somewhere else.',
    speedErrPct: 0,
    launchErrDeg: 0,
  });

  // ── Roll up ───────────────────────────────────────────────────────────────
  // Errors in different axes are independent, so they add in quadrature
  // rather than linearly — summing them would overstate the total.
  const speedErrPct = Math.hypot(...axes.map((a) => a.speedErrPct));
  const launchErrDeg = Math.hypot(...axes.map((a) => a.launchErrDeg));

  const carryErrorYards =
    speedErrPct * SENSITIVITY.yardsPerSpeedPercent +
    launchErrDeg * SENSITIVITY.yardsPerLaunchDegree;

  const blocked = axes.filter((a) => a.status === 'blocked');
  const warn = axes.filter((a) => a.status === 'warn');

  const order = { blocked: 0, warn: 1, ok: 2 };
  axes.sort((a, b) => order[a.status] - order[b.status]);

  return {
    overall: blocked.length ? 'blocked' : warn.length ? 'adjust' : 'ready',
    headline: blocked.length
      ? blocked[0].message
      : warn.length
        ? warn[0].message
        : 'Setup is good. Numbers will be as accurate as this rig gets.',
    axes,
    speedErrPct,
    launchErrDeg,
    carryErrorYards,
  };
}

// ── Saved profiles: the repeatability half ──────────────────────────────────

const PROFILE_KEY = 'launchmonitor.setupProfiles';

export function loadProfiles() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY) || '[]');
  } catch {
    return [];
  }
}

export function saveProfile(name, reading) {
  const profiles = loadProfiles().filter((p) => p.name !== name);
  profiles.push({
    name,
    savedAt: Date.now(),
    pitchDeg: reading.pitchDeg,
    rollDeg: reading.rollDeg,
    yawFromSquareDeg: reading.yawFromSquareDeg,
    distanceM: reading.distanceM,
    heightDeltaM: reading.heightDeltaM,
    headingDeg: reading.headingDeg ?? null,
  });
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles));
  } catch { /* private mode */ }
  return profiles;
}

export function deleteProfile(name) {
  const profiles = loadProfiles().filter((p) => p.name !== name);
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles));
  } catch { /* private mode */ }
  return profiles;
}

/**
 * Live deltas against a saved profile — "move 4 inches back, tilt 3 forward".
 * This is what makes a setup repeatable rather than merely valid: two rigs can
 * both be within tolerance and still give you different numbers.
 */
export function compareToProfile(profile, reading) {
  const deltas = [];

  const push = (id, label, delta, unit, fmt, instruction) => {
    if (delta == null || !isFinite(delta)) return;
    deltas.push({ id, label, delta, unit, display: fmt(delta), instruction: instruction(delta) });
  };

  if (profile.distanceM != null && reading.distanceM != null) {
    const d = reading.distanceM - profile.distanceM;
    push('distance', 'Distance', d, 'in',
      (v) => `${v > 0 ? '+' : ''}${(v * 39.37).toFixed(1)} in`,
      (v) => Math.abs(v) < 0.03 ? 'matched' : v > 0 ? `move ${(v * 39.37).toFixed(0)} in closer` : `move ${(-v * 39.37).toFixed(0)} in back`);
  }
  if (profile.rollDeg != null && reading.rollDeg != null) {
    // Compare deviations, so a profile saved in one landscape orientation
    // still matches when the phone is flipped the other way up.
    const d = rollDeviation(reading.rollDeg) - rollDeviation(profile.rollDeg);
    push('roll', 'Roll', d, '°',
      (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}°`,
      (v) => Math.abs(v) < 1 ? 'matched' : `rotate ${Math.abs(v).toFixed(0)}° ${v > 0 ? 'left' : 'right'}`);
  }
  if (profile.pitchDeg != null && reading.pitchDeg != null) {
    const d = reading.pitchDeg - profile.pitchDeg;
    push('pitch', 'Lean', d, '°',
      (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}°`,
      (v) => Math.abs(v) < 1 ? 'matched' : `tilt ${Math.abs(v).toFixed(0)}° ${v > 0 ? 'forward' : 'back'}`);
  }
  if (profile.yawFromSquareDeg != null && reading.yawFromSquareDeg != null) {
    const d = reading.yawFromSquareDeg - profile.yawFromSquareDeg;
    push('yaw', 'Square', d, '°',
      (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}°`,
      (v) => Math.abs(v) < 2 ? 'matched' : `swing the phone ${Math.abs(v).toFixed(0)}° ${v > 0 ? 'left' : 'right'}`);
  }

  const matched = deltas.every((d) => d.instruction === 'matched');
  return { deltas, matched };
}

// ── Distance from the ball's own size ───────────────────────────────────────

/**
 * A golf ball is 42.67 mm by rule, so its size on screen IS a distance
 * measurement — no LiDAR required. This is what lets the browser version, and
 * any non-LiDAR phone, still get scale.
 *
 * @param ballPixels  measured ball DIAMETER in pixels
 * @param imageWidth  frame width in pixels
 * @param fovDegrees  horizontal field of view
 */
export function distanceFromBallSize(ballPixels, imageWidth, fovDegrees = 68) {
  if (!(ballPixels > 1) || !(imageWidth > 0)) return null;
  const focalPx = imageWidth / (2 * Math.tan(d2r(fovDegrees / 2)));
  return (focalPx * 0.04267) / ballPixels;
}

/** Inverse: how many pixels the ball should be at a given distance. */
export function ballPixelsAtDistance(distanceM, imageWidth, fovDegrees = 68) {
  const focalPx = imageWidth / (2 * Math.tan(d2r(fovDegrees / 2)));
  return (focalPx * 0.04267) / distanceM;
}

/**
 * Distance uncertainty implied by how precisely the ball's edge can be found.
 * Because distance is inversely proportional to size, the percentage error in
 * distance equals the percentage error in the measured pixel diameter.
 *
 * A SINGLE frame is not good enough. At 5 ft the ball is ~40 px across, so a
 * 1.5 px edge error is 3.8% of distance — which is 3.8% of ball speed, or
 * about 11 yards of driver carry. That would be the largest error in the whole
 * system.
 *
 * The fix is free: the ball sits still while we are armed, so we measure it
 * hundreds of times and average. Random edge noise falls as sqrt(n), turning
 * 3.8% into 0.5% after 60 samples. This is why the app insists on a settling
 * period before it will arm, rather than locking on to the first frame that
 * looks like a ball.
 */
export function distanceUncertaintyPct(ballPixels, sampleCount = 1, edgeNoisePx = 1.5) {
  if (!(ballPixels > 1)) return 100;
  const single = (edgeNoisePx / ballPixels) * 100;
  const averaged = single / Math.sqrt(Math.max(sampleCount, 1));
  // Floor it: averaging kills random noise but not systematic bias (lighting
  // bleeding the ball's edge, a slightly wrong field-of-view figure).
  return clamp(Math.max(averaged, 0.6), 0.6, 100);
}
