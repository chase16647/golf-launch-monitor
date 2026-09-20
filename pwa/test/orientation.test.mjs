// orientation.test.mjs — pins the attitude maths to physically known poses.
//
// These matter because a level indicator that is right in portrait and 90
// degrees wrong in landscape looks plausible on a desk and is useless at a
// driving range.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraAttitude, yawFromSquare, norm180 } from '../js/setup/orientation.js';

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) < tol,
    `${msg}: got ${actual.toFixed(2)}, expected ~${expected} (±${tol})`);

test('phone flat on its back — rear camera points straight down', () => {
  // beta=0, gamma=0 is screen-up on a table.
  const a = cameraAttitude(0, 0, 0);
  near(a.pitch, -90, 1, 'pitch');
});

test('phone face down — rear camera points straight up', () => {
  const a = cameraAttitude(0, 180, 0);
  near(a.pitch, 90, 1, 'pitch');
});

test('phone upright in portrait — lens is horizontal and unrolled', () => {
  const a = cameraAttitude(0, 90, 0);
  near(a.pitch, 0, 1, 'pitch');
  near(a.roll, 0, 1, 'roll');
});

test('leaning back 20 degrees reads as 20 degrees of pitch', () => {
  // Tipping the top of the phone back raises the rear lens.
  const a = cameraAttitude(0, 70, 0);
  near(a.pitch, -20, 1.5, 'pitch');
  // Crucially, leaning must NOT leak into roll — they are independent axes and
  // conflating them is the classic bug here.
  near(a.roll, 0, 1.5, 'roll stays zero');
});

test('landscape is read as roll, not as pitch', () => {
  // Landscape with the lens horizontal is beta=0, gamma=+/-90.
  //
  // NOT beta=90: that is the gimbal-lock singularity of the ZXY Euler
  // sequence, where gamma rotates HEADING rather than roll. Reading beta and
  // gamma as pitch and roll directly would be wrong here, which is exactly why
  // cameraAttitude goes through a rotation matrix instead.
  const left = cameraAttitude(0, 0, -90);
  near(left.roll, -90, 2, 'roll');
  near(left.pitch, 0, 2, 'pitch stays zero');

  const right = cameraAttitude(0, 0, 90);
  near(right.roll, 90, 2, 'roll the other way');
  near(right.pitch, 0, 2, 'pitch stays zero');
});

test('gimbal lock at beta=90 moves heading, not roll', () => {
  // Documents the singularity so nobody "fixes" it later. At beta=90 the lens
  // is horizontal and gamma spins the phone about the vertical axis.
  const a = cameraAttitude(0, 90, 0);
  const b = cameraAttitude(0, 90, -45);
  near(a.roll, 0, 1, 'roll unchanged');
  near(b.roll, 0, 1, 'roll still unchanged');
  near(Math.abs(norm180(b.heading - a.heading)), 45, 2, 'heading moved instead');
});

test('pitch and roll are independent', () => {
  // Landscape AND lens pitched down 15 degrees: both must register cleanly,
  // neither may contaminate the other.
  const a = cameraAttitude(0, 0, -75);
  near(a.pitch, -15, 1.5, 'pitch');
  near(a.roll, -90, 2, 'roll');
});

test('never returns NaN or out-of-range angles', () => {
  // A level indicator that goes NaN at some pose is worse than none at all.
  let checked = 0;
  for (let alpha = 0; alpha < 360; alpha += 17) {
    for (let beta = -180; beta <= 180; beta += 13) {
      for (let gamma = -90; gamma <= 90; gamma += 11) {
        const r = cameraAttitude(alpha, beta, gamma);
        assert.ok(Number.isFinite(r.pitch) && Number.isFinite(r.roll) && Number.isFinite(r.heading),
          `NaN at ${alpha}/${beta}/${gamma}`);
        assert.ok(Math.abs(r.pitch) <= 90.01, `pitch out of range at ${alpha}/${beta}/${gamma}`);
        assert.ok(Math.abs(r.roll) <= 180.01, `roll out of range at ${alpha}/${beta}/${gamma}`);
        assert.ok(r.heading >= 0 && r.heading <= 360, `heading out of range`);
        checked++;
      }
    }
  }
  assert.ok(checked > 8000, `expected a broad sweep, only checked ${checked}`);
});

test('heading rotates with the phone', () => {
  const base = cameraAttitude(0, 90, 0).heading;
  const turned = cameraAttitude(40, 90, 0).heading;
  const delta = Math.abs(norm180(turned - base));
  near(delta, 40, 3, 'heading delta');
});

// ── Squareness ──────────────────────────────────────────────────────────────

test('square setup reads zero from either side of the ball', () => {
  // Target line points north (0). Phone to one side looks east (90).
  near(yawFromSquare(0, 90), 0, 0.01, 'east side');
  // Phone on the other side looks west (270).
  near(yawFromSquare(0, 270), 0, 0.01, 'west side');
});

test('off-square is reported with the right magnitude and sign', () => {
  near(yawFromSquare(0, 100), 10, 0.01, '10 deg one way');
  near(yawFromSquare(0, 80), -10, 0.01, '10 deg the other way');
});

test('squareness survives compass wraparound', () => {
  // Target line pointing just west of north; the naive subtraction wraps here.
  near(yawFromSquare(350, 80), 0, 0.01, 'wrapped');
  // Target 10 means square is 100. A lens at 95 is 5 degrees SHORT of square,
  // so the sign is negative — positive means past square.
  near(yawFromSquare(10, 95), -5, 0.01, 'wrapped, off square');
});

test('norm180 keeps angles in range', () => {
  assert.equal(norm180(370), 10);
  assert.equal(norm180(-370), -10);
  assert.equal(norm180(180), 180);
  assert.equal(norm180(-180), 180);
});

// ── Roll is judged against the orientation you are actually using ───────────

import { rollDeviation, evaluateSetup } from '../js/setup/alignment.js';

test('landscape is level, not 90 degrees off', () => {
  // The phone is USED in landscape. Judging raw roll against a tolerance
  // around zero told every correctly-placed user to "straighten up".
  assert.equal(rollDeviation(-90), 0);
  assert.equal(rollDeviation(90), 0);
  assert.equal(rollDeviation(0), 0);
  assert.equal(rollDeviation(180), 0);
  assert.equal(rollDeviation(-180), 0);
});

test('tilt within landscape is still detected', () => {
  near(rollDeviation(-80), 10, 0.01, 'landscape tilted 10');
  near(rollDeviation(-100), -10, 0.01, 'landscape tilted the other way');
  near(rollDeviation(7), 7, 0.01, 'portrait tilted 7');
});

test('a correctly placed landscape phone reports ready', () => {
  const result = evaluateSetup({
    pitchDeg: -3,
    rollDeg: -90,            // landscape: correct, not an error
    yawFromSquareDeg: 2,
    yawUncertaintyDeg: 3,
    distanceM: 1.52,
    distanceUncertaintyPct: 1.0,
    heightDeltaM: 0.05,
    stable: true,
  });
  assert.equal(result.overall, 'ready', `got "${result.overall}": ${result.headline}`);
  assert.ok(result.carryErrorYards < 6,
    `a good rig should be worth a few yards, got ${result.carryErrorYards.toFixed(1)}`);
});

test('a genuinely tilted landscape phone is flagged', () => {
  const result = evaluateSetup({
    pitchDeg: -3,
    rollDeg: -60,            // 30 degrees off landscape
    yawFromSquareDeg: 2,
    yawUncertaintyDeg: 3,
    distanceM: 1.52,
    distanceUncertaintyPct: 1.0,
    heightDeltaM: 0.05,
    stable: true,
  });
  assert.notEqual(result.overall, 'ready');
});
