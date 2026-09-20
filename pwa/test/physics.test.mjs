// physics.test.mjs — pins the flight model to published Trackman tour averages.
// If someone "optimises" the aero coefficients and these go red, the
// optimisation was wrong.
//
//   node --test test/
// or
//   node test/physics.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, airDensity, STANDARD_ATMOSPHERE, Aero } from '../js/physics/flight.js';
import { estimateTotalSpin, CLUBS } from '../js/physics/clubs.js';
import { classify, unwrapRotation, nyquistSpinRPM } from '../js/physics/shape.js';

const shot = (o) => simulate({ azimuthDeg: 0, spinAxisDeg: 0, ...o });

// Tolerances are the documented fit residuals, rounded up slightly.
const TOUR = [
  { name: 'Driver', speed: 167, launch: 10.9, spin: 2686, carry: 275, apex: 102, tol: 14 },
  { name: '3-wood', speed: 158, launch: 9.2, spin: 3655, carry: 243, apex: 90, tol: 12 },
  { name: '5-iron', speed: 132, launch: 14.3, spin: 5280, carry: 195, apex: 105, tol: 13 },
  { name: '7-iron', speed: 120, launch: 16.3, spin: 7097, carry: 172, apex: 103, tol: 11 },
  { name: 'PW', speed: 102, launch: 24.2, spin: 9316, carry: 136, apex: 96, tol: 10 },
];

test('flight model matches tour averages', () => {
  let total = 0;
  for (const r of TOUR) {
    const res = shot({ ballSpeedMPH: r.speed, launchAngleDeg: r.launch, totalSpinRPM: r.spin });
    const err = Math.abs(res.carryYards - r.carry);
    total += err;
    assert.ok(err < r.tol, `${r.name}: carry ${res.carryYards.toFixed(1)} vs ${r.carry}`);
    assert.ok(Math.abs(res.apexFeet - r.apex) < 13, `${r.name}: apex ${res.apexFeet.toFixed(1)} vs ${r.apex}`);
  }
  const mean = total / TOUR.length;
  assert.ok(mean < 8, `mean carry error ${mean.toFixed(2)} yd should stay under 8`);
});

// ── Sign conventions ────────────────────────────────────────────────────────
// These exist because an inverted Magnus cross product is a silent, plausible-
// looking bug that flips every draw and fade. It WAS present in the first
// draft and produced 68-yard drives.

test('positive spin axis curves right, negative left, symmetrically', () => {
  const right = shot({ ballSpeedMPH: 150, launchAngleDeg: 12, totalSpinRPM: 2700, spinAxisDeg: 20 });
  const left = shot({ ballSpeedMPH: 150, launchAngleDeg: 12, totalSpinRPM: 2700, spinAxisDeg: -20 });
  assert.ok(right.sideYards > 20, `expected a real slice, got ${right.sideYards.toFixed(1)}`);
  assert.ok(left.sideYards < -20);
  assert.ok(Math.abs(right.sideYards + left.sideYards) < 0.5, 'should be symmetric');
});

test('backspin generates lift, not downforce', () => {
  const spinning = shot({ ballSpeedMPH: 150, launchAngleDeg: 12, totalSpinRPM: 2700 });
  const dead = shot({ ballSpeedMPH: 150, launchAngleDeg: 12, totalSpinRPM: 0 });
  assert.ok(spinning.carryYards > dead.carryYards + 40,
    `backspin should add serious carry: ${spinning.carryYards.toFixed(0)} vs ${dead.carryYards.toFixed(0)}`);
  assert.ok(spinning.apexFeet > dead.apexFeet);
});

test('spin decays rather than growing', () => {
  // Guards the exact bug an unconstrained coefficient fit introduced.
  assert.ok(Aero.spinDecayPerSecond > 0,
    'negative decay means the ball gains spin in flight — unphysical');
});

// ── Spin model ──────────────────────────────────────────────────────────────

test('spin model is not pinned to its range ceiling', () => {
  // The original quadratic-in-loft form gave a PW 19,834 rpm, so every lofted
  // club clamped to its maximum and the model carried no information.
  for (const key of ['fiveIron', 'sevenIron', 'pitchingWedge', 'sandWedge']) {
    const c = CLUBS[key];
    const spin = estimateTotalSpin(key, c.refSpeed, c.refLaunch, 'tour');
    assert.ok(spin > c.spin[0] && spin < c.spin[1],
      `${c.short} spin ${Math.round(spin)} should sit inside [${c.spin}], not clamp`);
  }
});

test('spin model reproduces tour spin within 500 rpm', () => {
  const expected = { driver: 2686, fiveIron: 5280, sevenIron: 7097, pitchingWedge: 9316 };
  for (const [key, real] of Object.entries(expected)) {
    const c = CLUBS[key];
    const spin = estimateTotalSpin(key, c.refSpeed, c.refLaunch, 'tour');
    assert.ok(Math.abs(spin - real) < 500,
      `${c.short}: modelled ${Math.round(spin)} vs real ${real}`);
  }
});

// ── Atmosphere ──────────────────────────────────────────────────────────────

test('thin air carries further', () => {
  const sea = shot({ ballSpeedMPH: 167, launchAngleDeg: 10.9, totalSpinRPM: 2686 });
  const denver = shot({
    ballSpeedMPH: 167, launchAngleDeg: 10.9, totalSpinRPM: 2686,
    atmosphere: { temperatureC: 20, altitudeM: 1600, humidity: 0.5, pressureHPa: 1013.25 },
  });
  const gain = (denver.carryYards / sea.carryYards - 1) * 100;
  assert.ok(gain > 4 && gain < 13, `Denver gain was ${gain.toFixed(1)}%`);
});

test('moist air is less dense than dry air', () => {
  const dry = airDensity({ ...STANDARD_ATMOSPHERE, humidity: 0 });
  const wet = airDensity({ ...STANDARD_ATMOSPHERE, humidity: 1 });
  assert.ok(wet < dry, 'water vapour is lighter than N2/O2');
});

// ── Shape classification ────────────────────────────────────────────────────

test('shape classification matches golfer intuition', () => {
  assert.equal(classify(0, 2), 'straight');
  assert.equal(classify(0, 14), 'fade');
  assert.equal(classify(0, -14), 'draw');
  assert.equal(classify(0, 35), 'slice');
  assert.equal(classify(0, -35), 'hook');
  assert.equal(classify(6, 1), 'pushStraight');
  assert.equal(classify(-6, 12), 'pullFade');
});

// ── Spin aliasing ───────────────────────────────────────────────────────────

test('marker rotation un-aliases against the club prior', () => {
  // A wedge at 9500 rpm turns 237.5 deg/frame at 240 fps, wrapping to -122.5.
  // The solver must recover ~9500, not report a ball spinning backwards.
  const recovered = unwrapRotation(237.5 - 360, 240, CLUBS.sandWedge.spin);
  assert.ok(recovered !== null);
  assert.ok(Math.abs(recovered - 9500) < 400, `recovered ${recovered}`);
});

test('unaliased spin passes through unchanged', () => {
  // Driver at 2700 rpm = 67.5 deg/frame, comfortably under Nyquist.
  const recovered = unwrapRotation(67.5, 240, CLUBS.driver.spin);
  assert.ok(Math.abs(recovered - 2700) < 100, `recovered ${recovered}`);
});

test('Nyquist limit is where we think it is', () => {
  assert.equal(nyquistSpinRPM(240), 7200);
  assert.equal(nyquistSpinRPM(120), 3600);
});
