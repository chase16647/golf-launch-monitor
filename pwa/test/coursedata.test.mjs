// coursedata.test.mjs — the parts of the OSM course pipeline that don't touch
// the network: grouping raw Overpass elements and finding the nearest hole.
// The fetch itself could not be verified from this sandbox (Overpass blocks
// datacenter IPs) — see the header comment in coursedata.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupFeatures, centroid, nearestHole } from '../js/course/coursedata.js';
import { distanceYards } from '../js/course/gps.js';

// A minimal but realistic Overpass response shape: a tee point, a green
// polygon, and a bunker polygon near it.
const SAMPLE_ELEMENTS = [
  { type: 'node', tags: { golf: 'tee', ref: '7', par: '4' }, lat: 40.0000, lon: -105.0000 },
  {
    type: 'way', tags: { golf: 'green' },
    geometry: [
      { lat: 40.0030, lon: -105.0000 }, { lat: 40.0031, lon: -104.9999 },
      { lat: 40.0029, lon: -104.9998 }, { lat: 40.0030, lon: -105.0000 },
    ],
  },
  {
    type: 'way', tags: { golf: 'bunker' },
    geometry: [
      { lat: 40.0015, lon: -105.0002 }, { lat: 40.0016, lon: -105.0001 },
      { lat: 40.0014, lon: -105.0001 },
    ],
  },
  // A tee far away that should not be picked as "nearest" to the position below.
  { type: 'node', tags: { golf: 'tee', ref: '12' }, lat: 41.0, lon: -106.0 },
];

test('groupFeatures sorts elements into the right buckets', () => {
  const out = groupFeatures(SAMPLE_ELEMENTS);
  assert.equal(out.tees.length, 2);
  assert.equal(out.greens.length, 1);
  assert.equal(out.bunkers.length, 1);
  assert.equal(out.hazards.length, 0);
});

test('groupFeatures drops elements with no usable geometry', () => {
  const out = groupFeatures([
    { tags: { golf: 'tee' } }, // no lat/lon and no geometry array
    { tags: { golf: 'green' }, geometry: [] },
  ]);
  assert.equal(out.tees.length, 0);
  assert.equal(out.greens.length, 0);
});

test('centroid averages a polygon\'s points', () => {
  const green = { tags: {}, points: [{ lat: 40, lon: -105 }, { lat: 40.002, lon: -105 }] };
  const c = centroid(green);
  assert.ok(Math.abs(c.lat - 40.001) < 1e-9);
  assert.ok(Math.abs(c.lon - (-105)) < 1e-9);
});

test('nearestHole finds the close tee and its nearest green, ignoring a far tee', () => {
  const features = groupFeatures(SAMPLE_ELEMENTS);
  // Standing 5 yards from the near tee.
  const position = { lat: 40.00003, lon: -105.0000 };
  const result = nearestHole(features, position, distanceYards, 60);

  assert.ok(result, 'should find a nearby hole');
  assert.equal(result.ref, '7');
  assert.equal(result.par, 4);
  assert.ok(result.greenPosition, 'should attach the nearest green');
  // The green centroid should read close to lat 40.003.
  assert.ok(Math.abs(result.greenPosition.lat - 40.0030) < 0.001);
});

test('nearestHole returns null when nothing is within range', () => {
  const features = groupFeatures(SAMPLE_ELEMENTS);
  const farAway = { lat: 10, lon: 10 };
  assert.equal(nearestHole(features, farAway, distanceYards, 60), null);
});

test('nearestHole returns null for a course with no tees at all', () => {
  const empty = { tees: [], greens: [], bunkers: [], hazards: [], fairways: [], other: [] };
  assert.equal(nearestHole(empty, { lat: 40, lon: -105 }, distanceYards), null);
});
