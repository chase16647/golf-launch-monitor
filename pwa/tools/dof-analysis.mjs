// dof-analysis.mjs — derives the setup tolerances in js/setup/alignment.js.
//
// Run it whenever the flight model changes, and update SENSITIVITY to match:
//   node tools/dof-analysis.mjs

import { simulate } from '../js/physics/flight.js';

const d2r = (d) => (d * Math.PI) / 180;
const base = { ballSpeedMPH: 150, launchAngleDeg: 12, azimuthDeg: 0, totalSpinRPM: 2700, spinAxisDeg: 0 };
const ref = simulate(base);

console.log(`Reference shot: ${base.ballSpeedMPH} mph / ${base.launchAngleDeg}° / ${base.totalSpinRPM} rpm`);
console.log(`  carry ${ref.carryYards.toFixed(1)} yd, apex ${ref.apexFeet.toFixed(0)} ft\n`);

// ── Carry sensitivity to the two things setup error corrupts ────────────────

console.log('=== Carry sensitivity ===');
const sp1 = simulate({ ...base, ballSpeedMPH: base.ballSpeedMPH * 1.01 });
const yardsPerSpeedPct = sp1.carryYards - ref.carryYards;
console.log(`  1% ball speed      -> ${yardsPerSpeedPct.toFixed(2)} yd`);

const la1 = simulate({ ...base, launchAngleDeg: base.launchAngleDeg + 1 });
const yardsPerLaunchDeg = la1.carryYards - ref.carryYards;
console.log(`  1 deg launch angle -> ${yardsPerLaunchDeg.toFixed(2)} yd`);

// Launch sensitivity is not constant — it is near zero at the optimum and
// large when far from it. Report the range across realistic launches.
console.log('\n  launch sensitivity vs launch angle (driver):');
for (const L of [8, 10, 12, 14, 16, 20]) {
  const a = simulate({ ...base, launchAngleDeg: L });
  const b = simulate({ ...base, launchAngleDeg: L + 1 });
  console.log(`    ${String(L).padStart(2)}° -> ${(b.carryYards - a.carryYards).toFixed(2)} yd per degree`);
}
console.log('\n  and for a 7-iron (120 mph / 7100 rpm):');
const iron = { ballSpeedMPH: 120, launchAngleDeg: 16, azimuthDeg: 0, totalSpinRPM: 7100, spinAxisDeg: 0 };
const i0 = simulate(iron);
const i1 = simulate({ ...iron, launchAngleDeg: 17 });
const i2 = simulate({ ...iron, ballSpeedMPH: 121.2 });
console.log(`    1 deg launch -> ${(i1.carryYards - i0.carryYards).toFixed(2)} yd`);
console.log(`    1% speed     -> ${(i2.carryYards - i0.carryYards).toFixed(2)} yd`);

// ── Per-axis misplacement cost ──────────────────────────────────────────────

console.log('\n=== Yaw (not square) -> speed error ===');
for (const y of [5, 10, 15, 20, 30]) {
  const uncorr = (1 / Math.cos(d2r(y)) - 1) * 100;
  const corrected = Math.abs(Math.tan(d2r(y))) * d2r(2) * 100;
  console.log(`  ${String(y).padStart(2)}° off: uncorrected ${uncorr.toFixed(1)}% (${(uncorr * yardsPerSpeedPct).toFixed(0)} yd)` +
    `  |  measured to ±2°: ${corrected.toFixed(2)}% (${(corrected * yardsPerSpeedPct).toFixed(1)} yd)`);
}

console.log('\n=== Pitch -> launch error (exactly correctable) ===');
for (const p of [5, 10, 15, 20, 30]) {
  const meas = (Math.atan(Math.tan(d2r(16)) * Math.cos(d2r(p))) * 180) / Math.PI;
  console.log(`  ${String(p).padStart(2)}° lean: 16° launch reads ${meas.toFixed(2)}° (${(meas - 16).toFixed(2)}°)`);
}

console.log('\n=== Framing vs distance (1080p, 68° FOV) ===');
for (const ft of [3, 4, 5, 6, 7, 9]) {
  const m = ft * 0.3048;
  const widthM = 2 * m * Math.tan(d2r(34));
  const ballPx = (1920 / widthM) * 0.04267;
  const frames = (widthM / (150 * 0.44704)) * 240;
  const distUncPct = (1.5 / ballPx) * 100;
  console.log(`  ${ft} ft: ball ${ballPx.toFixed(1)} px, ${frames.toFixed(1)} frames @150mph, ` +
    `ball-size scale good to ±${distUncPct.toFixed(1)}% (${(distUncPct * yardsPerSpeedPct).toFixed(1)} yd)`);
}

console.log('\n=== Constants for alignment.js ===');
console.log(`  yardsPerSpeedPercent: ${yardsPerSpeedPct.toFixed(2)}`);
console.log(`  yardsPerLaunchDegree: ${yardsPerLaunchDeg.toFixed(2)}`);
