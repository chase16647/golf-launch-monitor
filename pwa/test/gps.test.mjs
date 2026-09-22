// gps.test.mjs — distance math has to be right before anyone trusts a yardage
// number derived from it on a course.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceYards, bearingDegrees, project } from '../js/course/gps.js';

test('distance between two points 1 degree of latitude apart is ~121,600 yd', () => {
  // 1 degree of latitude is ~69.17 miles everywhere on Earth, a good
  // independent check on the haversine constant.
  const d = distanceYards({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
  assert.ok(Math.abs(d - 121700) < 200, `got ${d.toFixed(0)} yd`);
});

test('a typical par-4 tee-to-green distance comes out sane', () => {
  // ~0.0037 degrees of latitude at this longitude is roughly 400 yards.
  const tee = { lat: 40.0, lon: -105.0 };
  const green = { lat: 40.0037, lon: -105.0 };
  const d = distanceYards(tee, green);
  assert.ok(d > 350 && d < 450, `got ${d.toFixed(0)} yd`);
});

test('distance is symmetric', () => {
  const a = { lat: 40.001, lon: -105.002 };
  const b = { lat: 40.003, lon: -105.001 };
  assert.ok(Math.abs(distanceYards(a, b) - distanceYards(b, a)) < 0.01);
});

test('distance to yourself is zero', () => {
  const p = { lat: 40.001, lon: -105.002 };
  assert.ok(distanceYards(p, p) < 0.001);
});

test('bearing due north is 0, due east is 90', () => {
  const origin = { lat: 40, lon: -105 };
  const north = bearingDegrees(origin, { lat: 40.01, lon: -105 });
  const east = bearingDegrees(origin, { lat: 40, lon: -104.98 });
  assert.ok(Math.abs(north - 0) < 1, `north bearing ${north}`);
  assert.ok(Math.abs(east - 90) < 1, `east bearing ${east}`);
});

test('projecting a point forward and measuring back gives the same distance', () => {
  const origin = { lat: 40, lon: -105 };
  const target = project(origin, 45, 250);
  const back = distanceYards(origin, target);
  assert.ok(Math.abs(back - 250) < 1, `projected-then-measured ${back.toFixed(1)} yd`);
});

test('project then bearing recovers the original bearing', () => {
  const origin = { lat: 40, lon: -105 };
  const target = project(origin, 137, 300);
  const b = bearingDegrees(origin, target);
  assert.ok(Math.abs(b - 137) < 0.5, `got bearing ${b.toFixed(1)}`);
});
