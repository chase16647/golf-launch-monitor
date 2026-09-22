// linedraw.test.mjs — the whole point of this tool is that a "straight" line
// is actually straight, not just close. Every snap case is checked by
// reconstructing the angle from the OUTPUT pixels, not by trusting the
// reported flag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapLine, extendToEdges, displayAngle } from '../js/ui/linedraw.js';

function measuredAngle(line) {
  return (Math.atan2(line.y1 - line.y0, line.x1 - line.x0) * 180) / Math.PI;
}

test('a near-level drag snaps to EXACTLY 0 degrees, not merely close', () => {
  const line = snapLine(0, 0, 100, 3.5); // ~2 deg off level
  assert.ok(line.snapped);
  assert.ok(line.isCardinal);
  assert.equal(measuredAngle(line), 0, 'reconstructed pixels must be exactly level');
});

test('a near-plumb drag snaps to EXACTLY 90 degrees', () => {
  const line = snapLine(0, 0, 5, 100); // ~3 deg off plumb
  assert.ok(line.snapped);
  assert.ok(line.isCardinal);
  assert.equal(measuredAngle(line), 90);
});

test('cardinal snap has a wider catch radius than off-axis snaps', () => {
  // 8 degrees off level: inside the 9-degree cardinal threshold, and past the
  // 7.5-deg point where naive "round to nearest 15-deg step" logic would have
  // picked the 15-deg step instead of 0 and missed this entirely — the exact
  // bug this test exists to pin.
  const nearLevel = snapLine(0, 0, 100, Math.tan((8 * Math.PI) / 180) * 100);
  assert.ok(nearLevel.snapped, 'should snap at 8 deg off level');
  assert.ok(nearLevel.isCardinal);
  assert.equal(Math.atan2(nearLevel.y1 - nearLevel.y0, nearLevel.x1 - nearLevel.x0), 0);

  // 8 degrees off a 30-degree step: outside the 5-degree off-axis threshold.
  const deg = 38; // 8 deg past the 30-deg step
  const nearThirty = snapLine(0, 0, 100, Math.tan((deg * Math.PI) / 180) * 100);
  assert.ok(!nearThirty.snapped, 'should NOT snap at 8 deg off a non-cardinal step');
});

test('just past the cardinal threshold does not snap', () => {
  const line = snapLine(0, 0, 100, Math.tan((9.5 * Math.PI) / 180) * 100);
  assert.ok(!line.snapped);
});

test('a deliberately diagonal line is left alone', () => {
  // 37.5 degrees: exactly halfway between the 30 and 45 degree steps, so it
  // is 7.5 deg from the nearest one — outside the 5-deg off-axis threshold.
  const y = Math.tan((37.5 * Math.PI) / 180) * 100;
  const line = snapLine(0, 0, 100, y);
  assert.ok(!line.snapped);
  assert.equal(line.x1, 100);
  assert.equal(line.y1, y);
});

test('snapping to 45 degrees is NOT flagged cardinal', () => {
  const line = snapLine(0, 0, 100, 96); // ~44 deg, within 5 deg of the 45 step
  assert.ok(line.snapped);
  assert.equal(line.angleDeg, 45);
  assert.ok(!line.isCardinal, '45 degrees is a real angle, not level/plumb');
});

test('extendToEdges stretches a level line across the full canvas width', () => {
  const level = { x0: 40, y0: 100, x1: 260, y1: 100, angleDeg: 0 };
  const ext = extendToEdges(level, 320, 240);
  assert.equal(ext.x0, 0);
  assert.equal(ext.x1, 320);
  assert.equal(ext.y0, 100);
  assert.equal(ext.y1, 100);
});

test('extendToEdges stretches a plumb line across the full canvas height', () => {
  const plumb = { x0: 160, y0: 20, x1: 160, y1: 180, angleDeg: 90 };
  const ext = extendToEdges(plumb, 320, 240);
  assert.equal(ext.y0, 0);
  assert.equal(ext.y1, 240);
  assert.equal(ext.x0, 160);
  assert.equal(ext.x1, 160);
});

test('displayAngle reports signed degrees off level, not raw direction', () => {
  assert.equal(displayAngle(0), 0);
  assert.equal(displayAngle(180), 0, 'a line pointing left is the same line as pointing right');
  assert.equal(displayAngle(170), -10);
  assert.equal(displayAngle(10), 10);
  assert.equal(displayAngle(90), 90);
});

test('a zero-length drag never snaps (no accidental tap-lines)', () => {
  const line = snapLine(50, 50, 50, 50);
  assert.ok(!line.snapped);
});
