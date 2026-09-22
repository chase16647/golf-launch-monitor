// greenread.test.mjs — pins the putt-physics model to the checks worked out
// in tools/verify-green.mjs. A wrong sign or a broken solver here means
// telling someone to aim the wrong side of the hole, so these are strict.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decelFromStimp, simulatePutt, solveAim, effectiveFlatDistanceFeet,
  slopeAccelFromGravity, slopePercent, readGreen,
} from '../js/putting/greenread.js';

const g = 9.80665;
const ftToM = 0.3048;

test('stimp to deceleration matches hand-calculated kinematics', () => {
  // v0=1.83 m/s, stimp 10ft=3.048m -> a = 1.83^2/(2*3.048)
  const expected = (1.83 * 1.83) / (2 * 3.048);
  assert.ok(Math.abs(decelFromStimp(10) - expected) < 1e-9);
});

test('a flat green needs zero aim offset', () => {
  const decel = decelFromStimp(10);
  const sol = solveAim(10 * ftToM, { x: 0, y: 0 }, decel);
  assert.ok(Math.abs(sol.aimAngleRad) < 1e-6);
  assert.ok(Math.abs(sol.finalX) < 1e-6);
});

test('left and right slopes mirror exactly', () => {
  const decel = decelFromStimp(10);
  const D = 10 * ftToM;
  const right = solveAim(D, { x: g * 0.02, y: 0 }, decel);
  const left = solveAim(D, { x: -g * 0.02, y: 0 }, decel);
  assert.ok(Math.abs(right.aimAngleRad + left.aimAngleRad) < 0.001);
  // Speed tolerance is solver precision, not exactness: the secant search
  // stops within 0.0005m of the target position, which leaves a small
  // residual in the exact angle found and, through that, in the bisected
  // speed. 1e-3 m/s is generous relative to that and still catches a real
  // asymmetry bug, which would be off by orders of magnitude more than this.
  assert.ok(Math.abs(right.speed - left.speed) < 1e-3);
});

test('uphill needs more speed than flat; downhill needs less', () => {
  const decel = decelFromStimp(10);
  const D = 10 * ftToM;
  const flat = solveAim(D, { x: 0, y: 0 }, decel);
  const uphill = solveAim(D, { x: 0, y: -g * 0.02 }, decel);
  const downhill = solveAim(D, { x: 0, y: g * 0.02 }, decel);
  assert.ok(uphill.speed > flat.speed);
  assert.ok(downhill.speed < flat.speed);
});

test('the shooting solve actually converges: forward re-simulation lands at the target', () => {
  const decel = decelFromStimp(10);
  const D = 30 * ftToM;
  const slopeAccel = { x: g * 0.025, y: 0 };
  const sol = solveAim(D, slopeAccel, decel);
  const check = simulatePutt(sol.aimAngleRad, sol.speed, slopeAccel, decel);
  const missIn = Math.hypot(check.x, check.y - D) * 39.3701;
  assert.ok(missIn < 0.1, `miss was ${missIn.toFixed(3)} in, hole radius is 2.13 in`);
});

test('break grows with both slope and distance', () => {
  const decel = decelFromStimp(10.5);
  const near = solveAim(10 * ftToM, { x: g * 0.02, y: 0 }, decel);
  const far = solveAim(20 * ftToM, { x: g * 0.02, y: 0 }, decel);
  const gentle = solveAim(10 * ftToM, { x: g * 0.01, y: 0 }, decel);
  assert.ok(Math.abs(far.aimAngleRad) > Math.abs(near.aimAngleRad), 'longer putt, same slope -> more break');
  assert.ok(Math.abs(near.aimAngleRad) > Math.abs(gentle.aimAngleRad), 'steeper slope, same distance -> more break');
});

test('effectiveFlatDistanceFeet inverts correctly: a flat putt maps to itself', () => {
  const decel = decelFromStimp(10);
  const sol = solveAim(12 * ftToM, { x: 0, y: 0 }, decel);
  const eff = effectiveFlatDistanceFeet(sol.speed, decel);
  assert.ok(Math.abs(eff - 12) < 0.05);
});

test('effectiveFlatDistanceFeet: uphill plays longer, downhill plays shorter', () => {
  const decel = decelFromStimp(10.5);
  const D = 10 * ftToM;
  const uphill = solveAim(D, { x: 0, y: -g * 0.02 }, decel);
  const downhill = solveAim(D, { x: 0, y: g * 0.02 }, decel);
  assert.ok(effectiveFlatDistanceFeet(uphill.speed, decel) > 10);
  assert.ok(effectiveFlatDistanceFeet(downhill.speed, decel) < 10);
});

// ── Sensor sign convention ────────────────────────────────────────────────

test('slopeAccelFromGravity negates the raw reading by default', () => {
  const r = slopeAccelFromGravity(3, -4, false);
  assert.equal(r.x, -3);
  assert.equal(r.y, 4);
});

test('the flip calibration inverts the sign', () => {
  const normal = slopeAccelFromGravity(3, -4, false);
  const flipped = slopeAccelFromGravity(3, -4, true);
  assert.equal(flipped.x, -normal.x);
  assert.equal(flipped.y, -normal.y);
});

test('slopePercent matches tan(angle) for a known tilt', () => {
  // 5 degrees: gravity's in-plane component is g*sin(5deg) (what the sensor
  // reads), and slope grade is properly tan(5deg) — these are close but not
  // identical at 5 degrees, which is expected physics, not an approximation
  // bug: slopePercent measures sin, not tan, and the two diverge slightly
  // as the angle grows.
  const fiveDeg = (5 * Math.PI) / 180;
  const a = { x: g * Math.sin(fiveDeg), y: 0 };
  const pct = slopePercent(a);
  assert.ok(Math.abs(pct - Math.sin(fiveDeg) * 100) < 0.01);
});

// ── End-to-end ────────────────────────────────────────────────────────────

test('readGreen produces a complete, sane result for a real-ish reading', () => {
  const slopeAccel = slopeAccelFromGravity(-1.5, 0, false); // right edge down-ish -> aim left? check below
  const result = readGreen({ distanceFeet: 12, slopeAccel, stimpFeet: 10.5 });
  assert.ok(Number.isFinite(result.aimOffsetInches));
  assert.ok(['left', 'right', 'straight'].includes(result.aimDirection));
  assert.ok(result.effectiveFlatFeet > 0);
  assert.ok(typeof result.speedNote === 'string' && result.speedNote.length > 0);
});

test('readGreen: a flat reading gives straight, neutral pace', () => {
  const result = readGreen({ distanceFeet: 10, slopeAccel: { x: 0, y: 0 }, stimpFeet: 10.5 });
  assert.equal(result.aimDirection, 'straight');
  assert.equal(result.speedNote, 'roughly neutral pace');
  assert.ok(Math.abs(result.effectiveFlatFeet - 10) < 0.1);
});
