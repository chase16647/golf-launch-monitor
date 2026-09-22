// verify-green.mjs — reproduces the green-reader physics verification
// referenced in js/putting/greenread.js's header. Run it any time the putt
// model changes.
//
//   node tools/verify-green.mjs

import {
  decelFromStimp, simulatePutt, solveAim, effectiveFlatDistanceFeet, makeSlopeField,
} from '../js/putting/greenread.js';

const g = 9.80665;
const ftToM = 0.3048;

console.log('=== Green speed -> deceleration ===\n');
for (const s of [8, 10, 11, 12, 13]) {
  console.log(`stimp ${s} ft -> ${decelFromStimp(s).toFixed(3)} m/s^2`);
}

console.log('\n=== Flat green: zero break, zero aim offset ===\n');
{
  const decel = decelFromStimp(10);
  const res = solveAim(10 * ftToM, { x: 0, y: 0 }, decel);
  console.log(`10ft flat -> aim ${((res.aimAngleRad * 180) / Math.PI).toFixed(4)} deg (expect 0), finalX ${res.finalX.toFixed(5)} m`);
}

console.log('\n=== Left/right mirror symmetry ===\n');
{
  const decel = decelFromStimp(10);
  const D = 10 * ftToM;
  const right = solveAim(D, { x: g * 0.02, y: 0 }, decel);
  const left = solveAim(D, { x: -g * 0.02, y: 0 }, decel);
  console.log(`+2% -> ${((right.aimAngleRad * 180) / Math.PI).toFixed(4)} deg`);
  console.log(`-2% -> ${((left.aimAngleRad * 180) / Math.PI).toFixed(4)} deg`);
  console.log(`sum (should be ~0): ${(right.aimAngleRad + left.aimAngleRad).toFixed(6)}`);
}

console.log('\n=== Uphill needs more speed, downhill needs less ===\n');
{
  const decel = decelFromStimp(10);
  const D = 10 * ftToM;
  const flat = solveAim(D, { x: 0, y: 0 }, decel);
  const uphill = solveAim(D, { x: 0, y: -g * 0.02 }, decel);
  const downhill = solveAim(D, { x: 0, y: g * 0.02 }, decel);
  console.log(`flat:     ${flat.speed.toFixed(3)} m/s`);
  console.log(`uphill:   ${uphill.speed.toFixed(3)} m/s (> flat)`);
  console.log(`downhill: ${downhill.speed.toFixed(3)} m/s (< flat)`);
}

console.log('\n=== Solved aim, re-simulated forward independently, hits the target ===\n');
{
  const decel = decelFromStimp(10);
  const D = 30 * ftToM;
  const slopeAccel = { x: g * 0.025, y: 0 };
  const sol = solveAim(D, slopeAccel, decel);
  const check = simulatePutt(sol.aimAngleRad, sol.speed, slopeAccel, decel);
  const missIn = Math.hypot(check.x, check.y - D) * 39.3701;
  console.log(`miss distance: ${missIn.toFixed(3)} in (hole radius is 2.13 in)`);
}

console.log('\n=== "Play it like a flat N-footer" ===\n');
{
  const decel = decelFromStimp(10.5);
  for (const [label, feet, slope] of [
    ['flat', 10, { x: 0, y: 0 }],
    ['2% uphill', 10, { x: 0, y: -g * 0.02 }],
    ['2% downhill', 10, { x: 0, y: g * 0.02 }],
    ['3% downhill, 20ft', 20, { x: 0, y: g * 0.03 }],
  ]) {
    const D = feet * ftToM;
    const sol = solveAim(D, slope, decel);
    const eff = effectiveFlatDistanceFeet(sol.speed, decel);
    console.log(`${label.padEnd(20)} actual ${feet}ft -> play like a flat ${eff.toFixed(1)}-footer`);
  }
}

console.log('\n=== Break by distance and slope (reference table) ===\n');
{
  const decel = decelFromStimp(10.5);
  for (const feet of [5, 10, 15, 20, 30]) {
    for (const pct of [1, 2, 3]) {
      const D = feet * ftToM;
      const sol = solveAim(D, { x: g * (pct / 100), y: 0 }, decel);
      const aimIn = Math.tan(sol.aimAngleRad) * D * 39.3701;
      console.log(`${String(feet).padStart(2)} ft, ${pct}% -> aim ${aimIn.toFixed(1)} in`);
    }
  }
}

console.log('\n=== Multi-point reading: why the ball alone is not enough ===\n');
{
  const decel = decelFromStimp(10.5);
  const D = 20 * ftToM;

  console.log('A uniform field (every point reads the same) matches the old');
  console.log('constant-slope path exactly — no regression from adding this:');
  const uniform = { x: g * 0.02, y: 0 };
  const asConstant = solveAim(D, uniform, decel);
  const asField = solveAim(D, makeSlopeField([{ yFeet: 0, accel: uniform }, { yFeet: 20, accel: uniform }]), decel);
  console.log(`  constant: ${((asConstant.aimAngleRad * 180) / Math.PI).toFixed(6)} deg`);
  console.log(`  field:    ${((asField.aimAngleRad * 180) / Math.PI).toFixed(6)} deg`);

  console.log('\nA double-breaker: breaks right near the ball, left near the hole.');
  console.log('Naively averaging the two readings gives exactly zero — "no break" —');
  console.log('for a green that genuinely breaks twice. The field-based read does not:');
  const field = makeSlopeField([
    { yFeet: 0, accel: { x: g * 0.025, y: 0 } },
    { yFeet: 10, accel: { x: 0, y: 0 } },
    { yFeet: 20, accel: { x: -g * 0.025, y: 0 } },
  ]);
  const fieldResult = solveAim(D, field, decel);
  const naiveAverage = solveAim(D, { x: 0, y: 0 }, decel);
  console.log(`  naive average of the two readings: ${((naiveAverage.aimAngleRad * 180) / Math.PI).toFixed(4)} deg (wrong)`);
  console.log(`  ball+mid+hole field:                ${((fieldResult.aimAngleRad * 180) / Math.PI).toFixed(4)} deg`);
}
