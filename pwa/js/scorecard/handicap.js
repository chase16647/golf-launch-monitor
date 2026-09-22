// handicap.js — USGA-style Handicap Index, and the round/stat math for a
// digital scorecard. Pure functions, no DOM, so they're directly testable.
//
// This implements the WHS (World Handicap System) simplified calculation:
// differential = (adjusted score - course rating) * 113 / slope rating,
// index = average of the best N differentials from the last 20 rounds,
// scaled by 0.96, using the official "how many of the last 20 count" table.
//
// This is NOT official — USGA/R&A also apply a small additional adjustment
// (a "Playing Conditions Calculation" and score-differential capping under
// exceptional scores) that requires their live data feed. What is implemented
// here is the core formula every golfer actually recognises as "my handicap",
// accurate for the overwhelming majority of rounds.

/** How many of your best differentials count, by how many rounds you have. */
const BEST_COUNT_TABLE = {
  3: 1, 4: 1, 5: 1, 6: 2, 7: 2, 8: 2, 9: 3, 10: 3,
  11: 4, 12: 4, 13: 5, 14: 5, 15: 6, 16: 6, 17: 7, 18: 7, 19: 8, 20: 8,
};

/**
 * One round's differential.
 * @param score  total adjusted gross score (see net-double-bogey capping below)
 * @param rating course rating (the "par for a scratch golfer" number on the card)
 * @param slope  course slope rating, 55-155, printed on the scorecard
 */
export function differential(score, rating, slope) {
  return ((score - rating) * 113) / slope;
}

/**
 * Handicap Index from a list of differentials, most recent last.
 * Uses only the most recent 20 (WHS looks at the last 20 rounds, however old).
 * Returns null if fewer than 3 rounds — USGA does not compute an index below
 * that, and neither do we.
 */
export function handicapIndex(differentials) {
  const recent = differentials.slice(-20);
  if (recent.length < 3) return null;
  const k = BEST_COUNT_TABLE[recent.length] ?? 8;
  const best = [...recent].sort((a, b) => a - b).slice(0, k);
  const avg = best.reduce((a, b) => a + b, 0) / best.length;
  return Math.round(avg * 0.96 * 10) / 10;
}

/**
 * Net Double Bogey cap: WHS caps any single hole score, for handicap purposes,
 * at par + 2 + any handicap strokes you'd receive on that hole. Without a cap,
 * one blow-up hole would wreck an index that is supposed to reflect your
 * *good* rounds. `strokesReceived` is how many handicap strokes you get on
 * that hole (0, 1, or 2 depending on your index and the hole's stroke index).
 */
export function cappedHoleScore(actualScore, par, strokesReceived = 0) {
  const cap = par + 2 + strokesReceived;
  return Math.min(actualScore, cap);
}

/** Course Handicap: what you actually play off at a given course today. */
export function courseHandicap(index, slope, rating, par) {
  return Math.round(index * (slope / 113) + (rating - par));
}

// ── Round stats ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} HoleEntry
 * @property {number} par
 * @property {number} strokes
 * @property {number} putts
 * @property {boolean|null} fairwayHit  null for par 3s, where it doesn't apply
 * @property {boolean} greenInRegulation
 */

export function roundStats(holes) {
  const played = holes.filter((h) => h.strokes > 0);
  if (!played.length) return null;

  const totalStrokes = played.reduce((s, h) => s + h.strokes, 0);
  const totalPar = played.reduce((s, h) => s + h.par, 0);
  const totalPutts = played.reduce((s, h) => s + (h.putts || 0), 0);

  const fairwayHoles = played.filter((h) => h.fairwayHit != null);
  const fairwaysHit = fairwayHoles.filter((h) => h.fairwayHit).length;

  const greensInReg = played.filter((h) => h.greenInRegulation).length;

  const scoreBuckets = { eagleOrBetter: 0, birdie: 0, par: 0, bogey: 0, doubleOrWorse: 0 };
  for (const h of played) {
    const toPar = h.strokes - h.par;
    if (toPar <= -2) scoreBuckets.eagleOrBetter++;
    else if (toPar === -1) scoreBuckets.birdie++;
    else if (toPar === 0) scoreBuckets.par++;
    else if (toPar === 1) scoreBuckets.bogey++;
    else scoreBuckets.doubleOrWorse++;
  }

  return {
    holesPlayed: played.length,
    totalStrokes,
    totalPar,
    toPar: totalStrokes - totalPar,
    totalPutts,
    puttsPerHole: totalPutts / played.length,
    fairwaysHit,
    fairwaysTotal: fairwayHoles.length,
    fairwayPct: fairwayHoles.length ? (fairwaysHit / fairwayHoles.length) * 100 : null,
    greensInReg,
    girPct: (greensInReg / played.length) * 100,
    scoreBuckets,
  };
}

// ── Side games: pure scoring, no server, one person enters everyone's scores ─

/**
 * Skins: each hole is worth one skin. Lowest score wins it outright; a tie
 * carries the skin(s) to the next hole. Standard "no gross ties on a hole"
 * carryover rule.
 */
export function scoreSkins(players, holesScores) {
  // holesScores: [{ hole: 1, scores: { playerId: strokes } }, ...]
  const winnings = Object.fromEntries(players.map((p) => [p.id, 0]));
  let carry = 0;

  for (const hole of holesScores) {
    const entries = Object.entries(hole.scores).filter(([, s]) => s > 0);
    if (!entries.length) continue;
    const min = Math.min(...entries.map(([, s]) => s));
    const winners = entries.filter(([, s]) => s === min);
    carry += 1;
    if (winners.length === 1) {
      winnings[winners[0][0]] += carry;
      carry = 0;
    }
    // else: tied, skin(s) carry to the next hole.
  }
  return { winnings, carriedOver: carry };
}

/**
 * Nassau: three separate bets — front 9, back 9, and total 18 — each scored
 * as simple match play (most holes won) or stroke play (lower total), your
 * choice. This does stroke play, the more common casual format.
 */
export function scoreNassau(players, holeScores) {
  const totals = (range) => {
    const sums = Object.fromEntries(players.map((p) => [p.id, 0]));
    for (const hole of holeScores.filter((h) => range.includes(h.hole))) {
      for (const [pid, s] of Object.entries(hole.scores)) sums[pid] += s || 0;
    }
    return sums;
  };
  const winner = (sums) => {
    const entries = Object.entries(sums).filter(([, v]) => v > 0);
    if (!entries.length) return null;
    const min = Math.min(...entries.map(([, v]) => v));
    const winners = entries.filter(([, v]) => v === min).map(([id]) => id);
    return winners.length === 1 ? winners[0] : null; // null = push
  };

  const front = Array.from({ length: 9 }, (_, i) => i + 1);
  const back = Array.from({ length: 9 }, (_, i) => i + 10);
  const all = [...front, ...back];

  const frontTotals = totals(front);
  const backTotals = totals(back);
  const allTotals = totals(all);

  return {
    front: { totals: frontTotals, winner: winner(frontTotals) },
    back: { totals: backTotals, winner: winner(backTotals) },
    overall: { totals: allTotals, winner: winner(allTotals) },
  };
}
