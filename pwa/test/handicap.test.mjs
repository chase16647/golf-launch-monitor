// handicap.test.mjs — pins the handicap formula and game scoring to worked
// examples, since a wrong handicap is the kind of error nobody double-checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  differential, handicapIndex, courseHandicap, cappedHoleScore,
  roundStats, scoreSkins, scoreNassau,
} from '../js/scorecard/handicap.js';

test('differential matches the published worked example', () => {
  // Score 90, rating 71.5, slope 125 is a commonly cited USGA example.
  const d = differential(90, 71.5, 125);
  assert.ok(Math.abs(d - 16.7) < 0.2, `got ${d.toFixed(1)}`);
});

test('fewer than 3 rounds gives no index', () => {
  assert.equal(handicapIndex([10, 12]), null);
});

test('handicap index uses the correct best-N count', () => {
  // 5 rounds -> best 1 counts, scaled by 0.96.
  assert.equal(handicapIndex([10, 12, 14, 16, 18]), 9.6);
  // 20 rounds -> best 8 count.
  const diffs = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
  const idx = handicapIndex(diffs);
  // best 8 are 1..8, mean 4.5, * 0.96 = 4.32 -> rounds to 4.3
  assert.equal(idx, 4.3);
});

test('index only looks at the most recent 20 rounds', () => {
  const old = Array(30).fill(30); // terrible old rounds
  const recent = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  const idx = handicapIndex([...old, ...recent]);
  assert.equal(idx, 4.3, 'should ignore the 30 old blow-up rounds');
});

test('net double bogey cap limits a blow-up hole', () => {
  assert.equal(cappedHoleScore(9, 4, 0), 6); // par 4 + 2 = 6 max, scored a 9
  assert.equal(cappedHoleScore(5, 4, 0), 5); // under the cap, unaffected
  assert.equal(cappedHoleScore(9, 4, 1), 7); // one handicap stroke raises the cap
});

test('course handicap scales index by slope and adjusts for rating vs par', () => {
  // Index 10, slope 113 (average), rating == par -> course handicap == index.
  assert.equal(courseHandicap(10, 113, 72, 72), 10);
  // Higher slope raises the course handicap.
  assert.ok(courseHandicap(10, 140, 72, 72) > 10);
});

test('round stats compute GIR, fairways, and scoring buckets correctly', () => {
  const holes = [
    { par: 4, strokes: 4, putts: 2, fairwayHit: true, greenInRegulation: true }, // par
    { par: 4, strokes: 5, putts: 2, fairwayHit: false, greenInRegulation: false }, // bogey
    { par: 3, strokes: 2, putts: 1, fairwayHit: null, greenInRegulation: true }, // birdie, par 3
    { par: 5, strokes: 7, putts: 2, fairwayHit: true, greenInRegulation: false }, // double
  ];
  const stats = roundStats(holes);
  assert.equal(stats.holesPlayed, 4);
  assert.equal(stats.totalStrokes, 18);
  assert.equal(stats.totalPar, 16);
  assert.equal(stats.toPar, 2);
  assert.equal(stats.fairwaysTotal, 3); // par 3 excluded
  assert.equal(stats.fairwaysHit, 2);
  assert.equal(stats.greensInReg, 2);
  assert.equal(stats.scoreBuckets.par, 1);
  assert.equal(stats.scoreBuckets.bogey, 1);
  assert.equal(stats.scoreBuckets.birdie, 1);
  assert.equal(stats.scoreBuckets.doubleOrWorse, 1);
});

test('skins: outright low score wins, ties carry over', () => {
  const players = [{ id: 'a' }, { id: 'b' }];
  const holes = [
    { hole: 1, scores: { a: 4, b: 5 } },       // a wins 1 skin
    { hole: 2, scores: { a: 4, b: 4 } },       // tie, carries
    { hole: 3, scores: { a: 5, b: 3 } },       // b wins 2 skins (carried + this one)
  ];
  const { winnings, carriedOver } = scoreSkins(players, holes);
  assert.equal(winnings.a, 1);
  assert.equal(winnings.b, 2);
  assert.equal(carriedOver, 0);
});

test('nassau: front, back, and overall are scored independently', () => {
  const players = [{ id: 'a' }, { id: 'b' }];
  const holes = [];
  for (let h = 1; h <= 18; h++) {
    // a wins the front by being 1 shot better each hole, b wins the back.
    const aScore = h <= 9 ? 4 : 5;
    const bScore = h <= 9 ? 5 : 4;
    holes.push({ hole: h, scores: { a: aScore, b: bScore } });
  }
  const result = scoreNassau(players, holes);
  assert.equal(result.front.winner, 'a');
  assert.equal(result.back.winner, 'b');
  assert.equal(result.overall.winner, null, 'should push overall since totals are equal');
});
