// verify-snap.mjs — reproduces the line-snap verification referenced in
// js/ui/linedraw.js's header comment. Run it any time the snap thresholds
// change to eyeball the numbers, same as tools/dof-analysis.mjs does for the
// setup-alignment tolerances.
//
//   node tools/verify-snap.mjs

import { snapLine, extendToEdges, displayAngle } from '../js/ui/linedraw.js';

function measuredAngle(line) {
  return (Math.atan2(line.y1 - line.y0, line.x1 - line.x0) * 180) / Math.PI;
}

console.log('=== Snap exactness: reconstructed pixels, not just a relabelled angle ===\n');
for (const [label, dx, dy] of [
  ['2 deg off level', 100, 3.5],
  ['3 deg off plumb', 5, 100],
  ['8 deg off level (past the naive 7.5deg rounding boundary)', 100, Math.tan((8 * Math.PI) / 180) * 100],
]) {
  const line = snapLine(0, 0, dx, dy);
  console.log(
    `${label.padEnd(58)} snapped=${line.snapped}  cardinal=${line.isCardinal}  ` +
    `measured angle = ${measuredAngle(line).toFixed(6)}°`
  );
}

console.log('\n=== Catch radius: cardinal (9deg) vs off-axis (5deg) ===');
console.log('Past ~11.5deg, "snapped" starts meaning "caught by the 15deg grid at');
console.log('a DIFFERENT step", not "still pulled to level" — angleDeg shows which.\n');
for (const deg of [4, 7, 8, 9, 9.5, 10, 11]) {
  const line = snapLine(0, 0, 100, Math.tan((deg * Math.PI) / 180) * 100);
  console.log(
    `${String(deg).padStart(4)}° off level -> snapped=${line.snapped}  ` +
    `cardinal=${line.isCardinal}  landed at ${line.angleDeg}°`
  );
}
for (const stepOffset of [3, 5, 6, 7]) {
  const deg = 30 + stepOffset; // off the 30-degree step, non-cardinal
  const line = snapLine(0, 0, 100, Math.tan((deg * Math.PI) / 180) * 100);
  console.log(`${stepOffset}° off a 30° step -> snapped=${line.snapped}`);
}

console.log('\n=== Cardinal lines extend to the canvas edges ===\n');
const level = extendToEdges({ x0: 40, y0: 100, x1: 260, y1: 100, angleDeg: 0 }, 320, 240);
console.log('level line, canvas 320x240:', level);
const plumb = extendToEdges({ x0: 160, y0: 20, x1: 160, y1: 180, angleDeg: 90 }, 320, 240);
console.log('plumb line, canvas 320x240:', plumb);

console.log('\n=== displayAngle: signed degrees off level ===\n');
for (const a of [0, 10, 45, 90, 170, 180, 260, 350]) {
  console.log(`raw ${String(a).padStart(3)}° -> displayed ${displayAngle(a).toFixed(1)}°`);
}
